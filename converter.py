from __future__ import annotations

import gzip
import hashlib
import io
import json
import math
import os
import re
import shutil
import statistics
import subprocess
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator, Literal, Sequence

from pyproj import CRS, Transformer


AggregationMethod = Literal["shallowest"]


class ConversionError(RuntimeError):
    """Raised when an input file cannot be safely converted."""


@dataclass(frozen=True)
class Bounds:
    west: float
    east: float
    south: float
    north: float

    def to_dict(self) -> dict[str, float]:
        return asdict(self)


@dataclass(frozen=True)
class DepthRange:
    minimum: float
    maximum: float

    def to_dict(self) -> dict[str, float]:
        return asdict(self)


@dataclass(frozen=True)
class ProjectionChoice:
    name: str
    definition: str
    crs: CRS


@dataclass
class PointScan:
    valid_points: int
    rejected_lines: int
    positive_depths: int
    negative_depths: int
    zero_depths: int
    bounds: Bounds
    raw_depth_range: DepthRange
    depth_multiplier: float


@dataclass
class GridResult:
    cell_count: int
    input_point_count: int
    rejected_point_count: int
    output_depth_range: DepthRange
    bounds: Bounds
    projection_name: str
    projection_definition: str
    origin_x: float
    origin_y: float
    output_path: Path


_MBINFO_BOUNDS_RE = re.compile(
    r"Minimum Longitude:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+"
    r"Maximum Longitude:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)).*?"
    r"Minimum Latitude:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+"
    r"Maximum Latitude:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))",
    re.IGNORECASE | re.DOTALL,
)

_MBINFO_DEPTH_RE = re.compile(
    r"Minimum Depth:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+"
    r"Maximum Depth:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))",
    re.IGNORECASE,
)


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_command_exists(command: str) -> None:
    if shutil.which(command) is None:
        raise ConversionError(
            f"Required command '{command}' was not found. Run the application "
            "inside the supplied MB-System Docker image."
        )


def safe_output_stem(value: str, fallback: str = "converted_bathymetry") -> str:
    value = Path(value).name
    value = re.sub(r"(?i)\.(?:mb57|all)(?:\.gz)?$", "", value)
    value = re.sub(r"(?i)\.gz$", "", value)
    value = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._-")
    return (value[:100] or fallback)


def decompress_gzip_input(
    source_gz: Path,
    destination_path: Path,
    max_uncompressed_bytes: int,
) -> int:
    total = 0
    try:
        with gzip.open(source_gz, "rb") as source, destination_path.open("wb") as target:
            while chunk := source.read(1024 * 1024):
                total += len(chunk)
                if total > max_uncompressed_bytes:
                    raise ConversionError(
                        "The uncompressed input exceeds the configured safety limit."
                    )
                target.write(chunk)
    except (gzip.BadGzipFile, EOFError, OSError) as exc:
        destination_path.unlink(missing_ok=True)
        raise ConversionError(f"The uploaded file is not a valid gzip stream: {exc}") from exc

    if total == 0:
        destination_path.unlink(missing_ok=True)
        raise ConversionError("The uploaded gzip file is empty.")
    return total


def kongsberg_all_model(path: Path) -> int | None:
    """Read the sonar model number from the first Kongsberg ALL datagram."""
    try:
        with path.open("rb") as stream:
            header = stream.read(8)
    except OSError:
        return None
    if len(header) < 8 or header[4] != 0x02:
        return None
    length = int.from_bytes(header[0:4], byteorder="big", signed=False)
    if length < 8 or length > 128 * 1024 * 1024:
        return None
    return int.from_bytes(header[6:8], byteorder="big", signed=False)


def candidate_mb_formats(original_filename: str, input_path: Path) -> tuple[list[int], int | None]:
    lower_name = original_filename.lower()
    if lower_name.endswith(".mb57") or lower_name.endswith(".mb57.gz"):
        return [57], None
    if lower_name.endswith(".all") or lower_name.endswith(".all.gz"):
        model = kongsberg_all_model(input_path)
        # This uploaded example reports model 120 (EM120), which MB-System reads
        # as raw Kongsberg/Simrad format 56. Newer Kongsberg ALL files may use 58.
        older_models = {12, 121, 120, 300, 1000, 1002, 2000, 3000, 3002}
        if model in older_models:
            return [56, 58], model
        return [58, 56], model
    raise ConversionError("Unsupported input type. Use .mb57, .mb57.gz, .all or .all.gz.")


def run_mbinfo(
    input_path: Path,
    *,
    format_id: int,
    mbinfo_bin: str = "mbinfo",
    timeout_seconds: int = 900,
) -> str:
    ensure_command_exists(mbinfo_bin)
    command = [mbinfo_bin, "-I", str(input_path), "-F", str(format_id)]
    try:
        completed = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            timeout=timeout_seconds,
            env={**os.environ, "LC_ALL": "C"},
        )
    except subprocess.TimeoutExpired as exc:
        raise ConversionError("MB-System inspection timed out.") from exc

    combined = "\n".join(part for part in (completed.stdout, completed.stderr) if part)
    if completed.returncode != 0:
        raise ConversionError(
            f"MB-System could not read the input as format {format_id}.\n" + combined[-4000:]
        )
    return combined


def inspect_mb_input(
    input_path: Path,
    *,
    candidate_formats: list[int],
    mbinfo_bin: str = "mbinfo",
    timeout_seconds: int = 900,
) -> tuple[int, str]:
    errors: list[str] = []
    for format_id in candidate_formats:
        try:
            return format_id, run_mbinfo(
                input_path,
                format_id=format_id,
                mbinfo_bin=mbinfo_bin,
                timeout_seconds=timeout_seconds,
            )
        except ConversionError as exc:
            errors.append(str(exc))
    raise ConversionError(
        "MB-System could not identify or read the uploaded multibeam file. "
        f"Formats attempted: {', '.join(map(str, candidate_formats))}.\n" +
        "\n\n".join(errors)[-6000:]
    )


def parse_mbinfo(text: str) -> tuple[Bounds | None, DepthRange | None]:
    bounds_match = _MBINFO_BOUNDS_RE.search(text)
    depth_match = _MBINFO_DEPTH_RE.search(text)

    bounds = None
    if bounds_match:
        west, east, south, north = map(float, bounds_match.groups())
        bounds = Bounds(west=west, east=east, south=south, north=north)

    depth_range = None
    if depth_match:
        minimum, maximum = map(float, depth_match.groups())
        depth_range = DepthRange(minimum=minimum, maximum=maximum)

    return bounds, depth_range


def extract_xyz_with_mblist(
    input_path: Path,
    xyz_path: Path,
    *,
    format_id: int,
    mblist_bin: str = "mblist",
    timeout_seconds: int = 3600,
) -> str:
    """Extract unflagged bathymetry as longitude, latitude, positive depth.

    MB-System dump mode 2 configures the output list as XYz, where X is
    longitude, Y is latitude and z is bathymetric depth.
    """
    ensure_command_exists(mblist_bin)
    command = [
        mblist_bin,
        "-I",
        str(input_path),
        "-F",
        str(format_id),
        "-D",
        "2",
    ]
    try:
        with xyz_path.open("wb") as output:
            completed = subprocess.run(
                command,
                stdout=output,
                stderr=subprocess.PIPE,
                check=False,
                timeout=timeout_seconds,
                env={**os.environ, "LC_ALL": "C"},
            )
    except subprocess.TimeoutExpired as exc:
        xyz_path.unlink(missing_ok=True)
        raise ConversionError("MB-System sounding extraction timed out.") from exc

    stderr = completed.stderr.decode("utf-8", errors="replace")
    if completed.returncode != 0:
        xyz_path.unlink(missing_ok=True)
        raise ConversionError(
            "mblist could not extract bathymetry from the input file.\n" + stderr[-4000:]
        )
    if not xyz_path.exists() or xyz_path.stat().st_size == 0:
        raise ConversionError("No valid bathymetry was extracted from the input file.")
    return stderr


def _parse_xyz_line(line: str) -> tuple[float, float, float] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    parts = stripped.replace(",", " ").split()
    if len(parts) < 3:
        return None
    try:
        longitude, latitude, depth = map(float, parts[:3])
    except ValueError:
        return None
    if not all(math.isfinite(value) for value in (longitude, latitude, depth)):
        return None
    if not (-180.0 <= longitude <= 180.0 and -90.0 <= latitude <= 90.0):
        return None
    return longitude, latitude, depth


def scan_xyz(xyz_path: Path) -> PointScan:
    valid_points = rejected_lines = 0
    positive_depths = negative_depths = zero_depths = 0
    west = south = math.inf
    east = north = -math.inf
    minimum_depth = math.inf
    maximum_depth = -math.inf

    with xyz_path.open("rt", encoding="utf-8", errors="replace") as stream:
        for line in stream:
            parsed = _parse_xyz_line(line)
            if parsed is None:
                if line.strip() and not line.lstrip().startswith("#"):
                    rejected_lines += 1
                continue

            longitude, latitude, depth = parsed
            valid_points += 1
            west = min(west, longitude)
            east = max(east, longitude)
            south = min(south, latitude)
            north = max(north, latitude)
            minimum_depth = min(minimum_depth, depth)
            maximum_depth = max(maximum_depth, depth)

            if depth > 0:
                positive_depths += 1
            elif depth < 0:
                negative_depths += 1
            else:
                zero_depths += 1

    if valid_points == 0:
        raise ConversionError("The extracted file contains no valid longitude/latitude/depth points.")

    nonzero = positive_depths + negative_depths
    if nonzero == 0:
        raise ConversionError("All extracted depths are zero.")

    minority = min(positive_depths, negative_depths)
    if minority / nonzero > 0.01:
        raise ConversionError(
            "The extracted data contains a significant mixture of positive and negative "
            "depths. The vertical convention must be reviewed before conversion."
        )

    depth_multiplier = -1.0 if negative_depths > positive_depths else 1.0
    return PointScan(
        valid_points=valid_points,
        rejected_lines=rejected_lines,
        positive_depths=positive_depths,
        negative_depths=negative_depths,
        zero_depths=zero_depths,
        bounds=Bounds(west=west, east=east, south=south, north=north),
        raw_depth_range=DepthRange(minimum=minimum_depth, maximum=maximum_depth),
        depth_multiplier=depth_multiplier,
    )


def choose_projection(bounds: Bounds) -> ProjectionChoice:
    longitude_span = bounds.east - bounds.west
    latitude_span = bounds.north - bounds.south
    if longitude_span > 180:
        raise ConversionError(
            "Antimeridian-crossing datasets are not supported by this first release."
        )

    center_lon = (bounds.west + bounds.east) / 2.0
    center_lat = (bounds.south + bounds.north) / 2.0

    west_zone = int(math.floor((bounds.west + 180.0) / 6.0)) + 1
    east_zone = int(math.floor((bounds.east + 180.0) / 6.0)) + 1
    center_zone = int(math.floor((center_lon + 180.0) / 6.0)) + 1
    center_zone = max(1, min(60, center_zone))

    if (
        -80.0 <= center_lat <= 84.0
        and west_zone == east_zone
        and longitude_span <= 6.0
        and latitude_span <= 8.0
    ):
        epsg = (32600 if center_lat >= 0 else 32700) + center_zone
        crs = CRS.from_epsg(epsg)
        hemisphere = "N" if center_lat >= 0 else "S"
        return ProjectionChoice(
            name=f"WGS 84 / UTM zone {center_zone}{hemisphere}",
            definition=f"EPSG:{epsg}",
            crs=crs,
        )

    definition = (
        f"+proj=aeqd +lat_0={center_lat:.10f} +lon_0={center_lon:.10f} "
        "+datum=WGS84 +units=m +no_defs"
    )
    return ProjectionChoice(
        name="Local WGS 84 azimuthal equidistant",
        definition=definition,
        crs=CRS.from_proj4(definition),
    )


def _grid_origin(bounds: Bounds, transformer: Transformer, grid_size_m: float) -> tuple[float, float]:
    corners_lon = [bounds.west, bounds.west, bounds.east, bounds.east]
    corners_lat = [bounds.south, bounds.north, bounds.south, bounds.north]
    xs, ys = transformer.transform(corners_lon, corners_lat)
    origin_x = math.floor(min(xs) / grid_size_m) * grid_size_m
    origin_y = math.floor(min(ys) / grid_size_m) * grid_size_m
    return origin_x, origin_y


def _iter_xyz_batches(
    xyz_path: Path,
    *,
    batch_size: int = 20_000,
) -> Iterator[tuple[list[float], list[float], list[float], int]]:
    longitudes: list[float] = []
    latitudes: list[float] = []
    depths: list[float] = []
    rejected = 0

    with xyz_path.open("rt", encoding="utf-8", errors="replace") as stream:
        for line in stream:
            parsed = _parse_xyz_line(line)
            if parsed is None:
                if line.strip() and not line.lstrip().startswith("#"):
                    rejected += 1
                continue

            longitude, latitude, depth = parsed
            longitudes.append(longitude)
            latitudes.append(latitude)
            depths.append(depth)

            if len(longitudes) >= batch_size:
                yield longitudes, latitudes, depths, rejected
                longitudes, latitudes, depths, rejected = [], [], [], 0

    if longitudes or rejected:
        yield longitudes, latitudes, depths, rejected



def raw_xyz_to_olex(
    xyz_path: Path,
    output_gz_path: Path,
    *,
    minimum_depth_m: float = 0.01,
    maximum_depth_m: float = 12_000.0,
) -> GridResult:
    """Write every valid sounding without gridding.

    The output keeps all valid source soundings from all uploaded files. Depths
    are written as positive metres. Duplicate positions are not removed because
    this mode is intended to preserve the raw extracted sounding set.
    """
    scan = scan_xyz(xyz_path)
    output_gz_path.parent.mkdir(parents=True, exist_ok=True)

    accepted_points = 0
    rejected_points = scan.rejected_lines
    output_depth_min = math.inf
    output_depth_max = -math.inf

    with output_gz_path.open("wb") as raw_stream:
        with gzip.GzipFile(
            filename="",
            mode="wb",
            fileobj=raw_stream,
            compresslevel=9,
            mtime=0,
        ) as gzip_stream:
            with io.TextIOWrapper(gzip_stream, encoding="utf-8", newline="\n") as text_stream:
                with xyz_path.open("rt", encoding="utf-8", errors="replace") as stream:
                    for line in stream:
                        parsed = _parse_xyz_line(line)
                        if parsed is None:
                            if line.strip() and not line.lstrip().startswith("#"):
                                rejected_points += 1
                            continue

                        longitude, latitude, raw_depth = parsed
                        depth = raw_depth * scan.depth_multiplier
                        if not math.isfinite(depth) or not (
                            minimum_depth_m <= depth <= maximum_depth_m
                        ):
                            rejected_points += 1
                            continue

                        accepted_points += 1
                        output_depth_min = min(output_depth_min, depth)
                        output_depth_max = max(output_depth_max, depth)
                        text_stream.write(
                            f"{latitude:.7f} {longitude:.7f} {depth:.1f}\n"
                        )

    if accepted_points == 0:
        output_gz_path.unlink(missing_ok=True)
        raise ConversionError("No valid raw soundings remained after validation.")

    return GridResult(
        cell_count=accepted_points,
        input_point_count=accepted_points,
        rejected_point_count=rejected_points,
        output_depth_range=DepthRange(output_depth_min, output_depth_max),
        bounds=scan.bounds,
        projection_name="Not applicable — raw WGS 84 soundings",
        projection_definition="EPSG:4326",
        origin_x=0.0,
        origin_y=0.0,
        output_path=output_gz_path,
    )


def grid_xyz_to_olex(
    xyz_path: Path,
    output_gz_path: Path,
    *,
    grid_size_m: float = 15.0,
    method: AggregationMethod = "shallowest",
    minimum_depth_m: float = 0.01,
    maximum_depth_m: float = 12_000.0,
) -> GridResult:
    if grid_size_m <= 0:
        raise ConversionError("Grid size must be greater than zero.")
    if method != "shallowest":
        raise ConversionError("Only the shallowest-depth rule is supported.")

    scan = scan_xyz(xyz_path)
    projection = choose_projection(scan.bounds)
    to_metric = Transformer.from_crs("EPSG:4326", projection.crs, always_xy=True)
    to_wgs84 = Transformer.from_crs(projection.crs, "EPSG:4326", always_xy=True)
    origin_x, origin_y = _grid_origin(scan.bounds, to_metric, grid_size_m)

    cells: dict[tuple[int, int], object] = {}
    accepted_points = 0
    rejected_points = scan.rejected_lines

    for longitudes, latitudes, depths, batch_rejected in _iter_xyz_batches(xyz_path):
        rejected_points += batch_rejected
        if not longitudes:
            continue
        xs, ys = to_metric.transform(longitudes, latitudes)

        for x, y, raw_depth in zip(xs, ys, depths):
            depth = raw_depth * scan.depth_multiplier
            if not math.isfinite(depth) or not (minimum_depth_m <= depth <= maximum_depth_m):
                rejected_points += 1
                continue

            ix = math.floor((x - origin_x) / grid_size_m)
            iy = math.floor((y - origin_y) / grid_size_m)
            key = (ix, iy)
            accepted_points += 1

            previous = cells.get(key)
            if previous is None or depth < float(previous):
                cells[key] = depth

    if not cells:
        raise ConversionError("No grid cells remained after validation and depth filtering.")

    output_depth_min = math.inf
    output_depth_max = -math.inf

    output_gz_path.parent.mkdir(parents=True, exist_ok=True)
    with output_gz_path.open("wb") as raw_stream:
        with gzip.GzipFile(
            filename="",
            mode="wb",
            fileobj=raw_stream,
            compresslevel=9,
            mtime=0,
        ) as gzip_stream:
            with io.TextIOWrapper(gzip_stream, encoding="utf-8", newline="\n") as text_stream:
                for ix, iy in sorted(cells, key=lambda item: (item[1], item[0])):
                    depth = float(cells[(ix, iy)])

                    center_x = origin_x + (ix + 0.5) * grid_size_m
                    center_y = origin_y + (iy + 0.5) * grid_size_m
                    longitude, latitude = to_wgs84.transform(center_x, center_y)

                    if not (
                        math.isfinite(longitude)
                        and math.isfinite(latitude)
                        and math.isfinite(depth)
                    ):
                        continue

                    output_depth_min = min(output_depth_min, depth)
                    output_depth_max = max(output_depth_max, depth)
                    text_stream.write(f"{latitude:.7f} {longitude:.7f} {depth:.1f}\n")

    if not output_gz_path.exists() or output_gz_path.stat().st_size == 0:
        raise ConversionError("The Olex output file could not be created.")

    return GridResult(
        cell_count=len(cells),
        input_point_count=accepted_points,
        rejected_point_count=rejected_points,
        output_depth_range=DepthRange(output_depth_min, output_depth_max),
        bounds=scan.bounds,
        projection_name=projection.name,
        projection_definition=projection.definition,
        origin_x=origin_x,
        origin_y=origin_y,
        output_path=output_gz_path,
    )


def validate_olex_gz(path: Path, sample_limit: int | None = None) -> dict[str, object]:
    count = 0
    invalid = 0
    minimum_depth = math.inf
    maximum_depth = -math.inf
    west = south = math.inf
    east = north = -math.inf

    try:
        with gzip.open(path, "rt", encoding="utf-8", errors="strict") as stream:
            for line in stream:
                if sample_limit is not None and count >= sample_limit:
                    break
                parts = line.split()
                if len(parts) != 3:
                    invalid += 1
                    continue
                try:
                    latitude, longitude, depth = map(float, parts)
                except ValueError:
                    invalid += 1
                    continue

                if not (
                    math.isfinite(latitude)
                    and math.isfinite(longitude)
                    and math.isfinite(depth)
                    and -90 <= latitude <= 90
                    and -180 <= longitude <= 180
                    and depth > 0
                ):
                    invalid += 1
                    continue

                count += 1
                west = min(west, longitude)
                east = max(east, longitude)
                south = min(south, latitude)
                north = max(north, latitude)
                minimum_depth = min(minimum_depth, depth)
                maximum_depth = max(maximum_depth, depth)
    except (gzip.BadGzipFile, UnicodeError, OSError) as exc:
        raise ConversionError(f"Invalid Olex gzip output: {exc}") from exc

    if count == 0:
        raise ConversionError("The Olex output contains no valid points.")
    if invalid:
        raise ConversionError(f"The Olex output contains {invalid} invalid rows.")

    return {
        "valid_rows": count,
        "invalid_rows": invalid,
        "bounds": {
            "west": west,
            "east": east,
            "south": south,
            "north": north,
        },
        "depth_range_m": {
            "minimum": minimum_depth,
            "maximum": maximum_depth,
        },
    }



def build_sounding_preview(
    xyz_path: Path,
    *,
    maximum_points: int = 2200,
) -> dict[str, object]:
    """Build a lightweight map preview from actual extracted soundings.

    The preview contains sampled sounding positions rather than a bounding
    rectangle or filled survey polygon. This preserves the visible multibeam
    swath/track pattern while keeping the browser payload manageable.
    """
    scan = scan_xyz(xyz_path)
    stride = max(1, math.ceil(scan.valid_points / maximum_points))
    points: list[list[float]] = []
    accepted = 0
    rejected = scan.rejected_lines
    minimum_depth = math.inf
    maximum_depth = -math.inf

    with xyz_path.open("rt", encoding="utf-8", errors="replace") as stream:
        valid_index = 0
        for line in stream:
            parsed = _parse_xyz_line(line)
            if parsed is None:
                continue

            longitude, latitude, raw_depth = parsed
            depth = raw_depth * scan.depth_multiplier
            if not math.isfinite(depth) or not (0.01 <= depth <= 12_000.0):
                rejected += 1
                continue

            accepted += 1
            minimum_depth = min(minimum_depth, depth)
            maximum_depth = max(maximum_depth, depth)

            if valid_index % stride == 0 and len(points) < maximum_points:
                points.append([
                    round(latitude, 7),
                    round(longitude, 7),
                    round(depth, 1),
                ])
            valid_index += 1

    if accepted == 0:
        raise ConversionError("No valid soundings were available for the map preview.")

    return {
        "sounding_count": accepted,
        "rejected_rows_or_soundings": rejected,
        "sampled_point_count": len(points),
        "depth_range_m": {
            "minimum": minimum_depth,
            "maximum": maximum_depth,
        },
        "bounds": scan.bounds.to_dict(),
        "points": points,
        "preview_note": (
            "The map displays a controlled sample of actual sounding positions. "
            "It does not fill the survey bounding box or invent coverage."
        ),
    }


def convert_bathymetry_files(
    source_files: list[tuple[Path, str]],
    job_dir: Path,
    *,
    output_mode: str = "grid15",
    mbinfo_bin: str = "mbinfo",
    mblist_bin: str = "mblist",
    max_uncompressed_bytes: int = 500 * 1024 * 1024,
    command_timeout_seconds: int = 3600,
) -> dict[str, object]:
    """Convert and combine MB57 and Kongsberg ALL files into one Olex gzip."""
    if not source_files:
        raise ConversionError("No multibeam files were provided.")

    job_dir.mkdir(parents=True, exist_ok=True)
    combined_xyz_path = job_dir / "combined_extracted_lon_lat_depth.tsv"
    total_uncompressed_size = 0
    source_reports: list[dict[str, object]] = []
    mbinfo_excerpts: list[str] = []
    mblist_excerpts: list[str] = []

    with combined_xyz_path.open("wb") as combined_xyz:
        for index, (source_path, original_filename) in enumerate(source_files, start=1):
            stem = safe_output_stem(original_filename, fallback=f"survey_{index}")
            lower_name = original_filename.lower()
            underlying_suffix = ".all" if lower_name.endswith((".all", ".all.gz")) else ".mb57"
            input_path = job_dir / f"{index:03d}_{stem}{underlying_suffix}"

            remaining_limit = int(max_uncompressed_bytes - total_uncompressed_size)
            if remaining_limit <= 0:
                raise ConversionError(
                    "The combined decompressed inputs exceed the configured 500 MB limit."
                )

            if lower_name.endswith(".gz"):
                uncompressed_size = decompress_gzip_input(
                    source_path,
                    input_path,
                    max_uncompressed_bytes=remaining_limit,
                )
            else:
                shutil.copy2(source_path, input_path)
                uncompressed_size = input_path.stat().st_size
                if uncompressed_size > remaining_limit:
                    input_path.unlink(missing_ok=True)
                    raise ConversionError(
                        "The combined decompressed inputs exceed the configured 500 MB limit."
                    )

            total_uncompressed_size += uncompressed_size
            format_candidates, sonar_model = candidate_mb_formats(original_filename, input_path)
            format_id, mbinfo_text = inspect_mb_input(
                input_path,
                candidate_formats=format_candidates,
                mbinfo_bin=mbinfo_bin,
                timeout_seconds=min(command_timeout_seconds, 900),
            )
            mbinfo_bounds, mbinfo_depths = parse_mbinfo(mbinfo_text)

            xyz_path = job_dir / f"{index:03d}_{stem}_xyz.tsv"
            mblist_messages = extract_xyz_with_mblist(
                input_path,
                xyz_path,
                format_id=format_id,
                mblist_bin=mblist_bin,
                timeout_seconds=command_timeout_seconds,
            )

            with xyz_path.open("rb") as extracted:
                shutil.copyfileobj(extracted, combined_xyz)
                if xyz_path.stat().st_size:
                    combined_xyz.write(b"\n")

            sounding_preview = build_sounding_preview(xyz_path)

            source_reports.append({
                "original_filename": original_filename,
                "input_type": "Kongsberg ALL raw" if underlying_suffix == ".all" else "MB-System processed MB57",
                "compressed_or_uploaded_size_bytes": source_path.stat().st_size,
                "decompressed_or_working_size_bytes": uncompressed_size,
                "sha256": sha256_file(source_path),
                "mb_system_format": format_id,
                "kongsberg_sonar_model": sonar_model,
                "bounds_from_mbinfo": mbinfo_bounds.to_dict() if mbinfo_bounds else None,
                "depth_range_from_mbinfo_m": mbinfo_depths.to_dict() if mbinfo_depths else None,
                "sounding_preview": sounding_preview,
            })
            mbinfo_excerpts.append(
                f"===== {original_filename} | MB-System format {format_id} =====\n{mbinfo_text[-3500:]}"
            )
            mblist_excerpts.append(
                f"===== {original_filename} | MB-System format {format_id} =====\n{mblist_messages[-1500:]}"
            )
            xyz_path.unlink(missing_ok=True)
            input_path.unlink(missing_ok=True)

    if output_mode == "raw":
        output_name = f"combined_{len(source_files)}_files_olex_raw_soundings.gz"
        output_path = job_dir / output_name
        result = raw_xyz_to_olex(combined_xyz_path, output_path)
        grid_size_m = None
        mode_label = "Raw sounding data"
        depth_rule = "All valid positive soundings retained"
    elif output_mode in {"grid15", "grid20", "grid25"}:
        grid_size_m = {"grid15": 15.0, "grid20": 20.0, "grid25": 25.0}[output_mode]
        output_name = (
            f"combined_{len(source_files)}_files_olex_"
            f"{int(grid_size_m)}m_shallowest.gz"
        )
        output_path = job_dir / output_name
        result = grid_xyz_to_olex(
            combined_xyz_path,
            output_path,
            grid_size_m=grid_size_m,
            method="shallowest",
        )
        mode_label = f"{int(grid_size_m)} m × {int(grid_size_m)} m grid"
        depth_rule = "Shallowest positive depth retained in each populated cell"
    else:
        raise ConversionError("Unsupported output mode.")

    validation = validate_olex_gz(output_path)
    report: dict[str, object] = {
        "application": "The Lindblad Bathymetry Converter",
        "application_version": "1.7.0",
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "source": {
            "file_count": len(source_files),
            "combined_uploaded_size_bytes": sum(path.stat().st_size for path, _ in source_files),
            "combined_decompressed_or_working_size_bytes": total_uncompressed_size,
            "files": source_reports,
        },
        "processing": {
            "supported_inputs": ["MB57", "MB57.GZ", "Kongsberg ALL", "Kongsberg ALL.GZ"],
            "output_mode": output_mode,
            "output_mode_label": mode_label,
            "grid_size_m": grid_size_m,
            "depth_rule": depth_rule,
            "overlap_rule": (
                "For gridded output, soundings from every uploaded file share one grid and "
                "the shallowest positive depth is retained in overlapping cells."
            ),
            "depth_output_convention": "positive metres",
            "coordinate_output": "WGS 84 decimal degrees",
            "column_order": "latitude longitude depth",
            "projection": {
                "name": result.projection_name,
                "definition": result.projection_definition,
                "grid_origin_x_m": result.origin_x,
                "grid_origin_y_m": result.origin_y,
            },
        },
        "statistics": {
            "accepted_input_points": result.input_point_count,
            "rejected_input_rows_or_points": result.rejected_point_count,
            "output_grid_cells": result.cell_count,
            "combined_source_bounds_from_points": result.bounds.to_dict(),
            "output_depth_range_m": result.output_depth_range.to_dict(),
        },
        "output": {
            "filename": output_name,
            "size_bytes": output_path.stat().st_size,
            "sha256": sha256_file(output_path),
            "validation": validation,
        },
        "mb_system_messages": {
            "mbinfo_excerpts": "\n\n".join(mbinfo_excerpts)[-16000:],
            "mblist_excerpts": "\n\n".join(mblist_excerpts)[-8000:],
        },
        "safety_notice": (
            "This is supplementary user-supplied bathymetry, not an official ENC or "
            "hydrographic product. Import into a separate Olex test database and verify "
            "position, depth sign, vertical datum, tide corrections, survey dates, "
            "overlap handling, coverage, shoals and authoritative charts before use."
        ),
    }

    report_path = job_dir / "conversion_report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    combined_xyz_path.unlink(missing_ok=True)
    return {
        "report": report,
        "report_path": report_path,
        "output_path": output_path,
        "output_name": output_name,
    }
