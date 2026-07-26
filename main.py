from __future__ import annotations

import json
import os
import shutil
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from converter import ConversionError, convert_bathymetry_files, safe_output_stem

BASE_DIR = Path(__file__).resolve().parent
WORK_ROOT = Path(os.getenv("WORK_ROOT", "/tmp/olex-converter"))
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "500"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
MAX_UNCOMPRESSED_GB = float(os.getenv("MAX_UNCOMPRESSED_GB", "0.48828125"))
MAX_UNCOMPRESSED_BYTES = MAX_UNCOMPRESSED_GB * 1024 * 1024 * 1024
JOB_TTL_SECONDS = int(os.getenv("JOB_TTL_SECONDS", "3600"))
COMMAND_TIMEOUT_SECONDS = int(os.getenv("COMMAND_TIMEOUT_SECONDS", "3600"))

app = FastAPI(
    title="The Lindblad Bathymetry Converter",
    version="2.0.0",
    docs_url="/api/docs",
    redoc_url=None,
)


def _cleanup_expired_jobs() -> None:
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    cutoff = time.time() - JOB_TTL_SECONDS
    for child in WORK_ROOT.iterdir():
        try:
            if child.is_dir() and child.stat().st_mtime < cutoff:
                shutil.rmtree(child, ignore_errors=True)
        except OSError:
            continue


def _job_dir_or_404(job_id: str) -> Path:
    if not job_id or any(character not in "0123456789abcdef-" for character in job_id):
        raise HTTPException(status_code=404, detail="Result not found.")
    job_dir = WORK_ROOT / job_id
    if not job_dir.is_dir():
        raise HTTPException(status_code=404, detail="Result not found or expired.")
    return job_dir


@app.on_event("startup")
def startup() -> None:
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    _cleanup_expired_jobs()


@app.get("/")
def index() -> FileResponse:
    return FileResponse(BASE_DIR / "index.html")


@app.get("/styles.css")
def styles() -> FileResponse:
    return FileResponse(BASE_DIR / "styles.css", media_type="text/css")


@app.get("/app.js")
def javascript() -> FileResponse:
    return FileResponse(BASE_DIR / "app.js", media_type="application/javascript")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": "2.0.0"}


@app.get("/api/capabilities")
def capabilities() -> dict[str, object]:
    return {
        "supported_input_types": [
            {"type": "Processed MB57", "extensions": [".mb57"]},
            {"type": "Compressed processed MB57", "extensions": [".mb57.gz"]},
            {"type": "Kongsberg raw ALL", "extensions": [".all", ".all.gz"]},
        ],
        "mixed_uploads_supported": True,
        "single_combined_olex_output": True,
        "output_extension": ".gz",
        "combined_decompressed_limit_mb": 500,
    }


@app.post("/api/convert")
async def convert(
    files: list[UploadFile] = File(...),
    output_mode: str = Form("grid15"),
    acknowledgement: bool = Form(False),
) -> dict[str, object]:
    _cleanup_expired_jobs()

    if not acknowledgement:
        raise HTTPException(
            status_code=400,
            detail="You must acknowledge the safety and validation requirements.",
        )
    if output_mode not in {"raw", "grid15", "grid20", "grid25"}:
        raise HTTPException(status_code=400, detail="Unsupported output mode.")
    if not files:
        raise HTTPException(status_code=400, detail="Select at least one .mb57, .mb57.gz or Kongsberg .all file.")
    if len(files) > 100:
        raise HTTPException(
            status_code=400,
            detail="A maximum of 100 files may be combined in one conversion.",
        )

    job_id = str(uuid.uuid4())
    job_dir = WORK_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=False)

    saved_files: list[tuple[Path, str]] = []
    total_upload_bytes = 0

    try:
        for index, upload in enumerate(files, start=1):
            original_filename = Path(upload.filename or f"survey_{index}.mb57.gz").name
            lower_name = original_filename.lower()
            if not lower_name.endswith((".mb57.gz", ".mb57", ".all.gz", ".all")):
                raise HTTPException(
                    status_code=400,
                    detail=f"Unsupported file: {original_filename}. "
                           "Every file must be .mb57, .mb57.gz or Kongsberg .all (.all.gz is also accepted).",
                )

            upload_path = job_dir / (
                f"{index:03d}_{safe_output_stem(original_filename)}.upload"
            )
            with upload_path.open("wb") as output:
                while chunk := await upload.read(1024 * 1024):
                    total_upload_bytes += len(chunk)
                    if total_upload_bytes > MAX_UPLOAD_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail=(
                                f"The combined upload exceeds the {MAX_UPLOAD_MB} MB "
                                "limit. Select fewer or smaller files."
                            ),
                        )
                    output.write(chunk)

            if upload_path.stat().st_size == 0:
                raise HTTPException(
                    status_code=400,
                    detail=f"The uploaded file is empty: {original_filename}",
                )
            saved_files.append((upload_path, original_filename))

        converted = convert_bathymetry_files(
            saved_files,
            job_dir,
            output_mode=output_mode,
            max_uncompressed_bytes=MAX_UNCOMPRESSED_BYTES,
            command_timeout_seconds=COMMAND_TIMEOUT_SECONDS,
        )

        report = converted["report"]
        public_result = {
            "job_id": job_id,
            "output_filename": converted["output_name"],
            "download_url": f"/api/jobs/{job_id}/download",
            "report_url": f"/api/jobs/{job_id}/report",
            "expires_in_seconds": JOB_TTL_SECONDS,
            "summary": {
                "source_file_count": report["source"]["file_count"],
                "combined_upload_size_bytes": report["source"]["combined_uploaded_size_bytes"],
                "combined_working_size_bytes": report["source"]["combined_decompressed_or_working_size_bytes"],
                "accepted_input_points": report["statistics"]["accepted_input_points"],
                "rejected_input_points": report["statistics"]["rejected_input_rows_or_points"],
                "output_grid_cells": report["statistics"]["output_grid_cells"],
                "output_depth_range_m": report["statistics"]["output_depth_range_m"],
                "bounds": report["statistics"]["combined_source_bounds_from_points"],
                "projection": report["processing"]["projection"]["name"],
                "output_mode": report["processing"]["output_mode"],
                "output_mode_label": report["processing"]["output_mode_label"],
                "depth_rule": report["processing"]["depth_rule"],
                "grid_size_m": report["processing"]["grid_size_m"],
                "output_sha256": report["output"]["sha256"],
            },
            "safety_notice": report["safety_notice"],
        }

        (job_dir / "public_result.json").write_text(
            json.dumps(public_result, indent=2),
            encoding="utf-8",
        )
        return public_result

    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    except ConversionError as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(
            status_code=500,
            detail=f"Unexpected conversion error: {type(exc).__name__}",
        ) from exc
    finally:
        for upload_path, _ in saved_files:
            upload_path.unlink(missing_ok=True)
        for upload in files:
            await upload.close()


@app.get("/api/jobs/{job_id}/download")
def download(job_id: str) -> FileResponse:
    job_dir = _job_dir_or_404(job_id)
    public_path = job_dir / "public_result.json"
    if not public_path.exists():
        raise HTTPException(status_code=404, detail="Result is incomplete.")
    metadata = json.loads(public_path.read_text(encoding="utf-8"))
    output_name = Path(metadata["output_filename"]).name
    output_path = job_dir / output_name
    if not output_path.exists():
        raise HTTPException(status_code=404, detail="Output file not found.")
    return FileResponse(
        output_path,
        media_type="application/gzip",
        filename=output_name,
    )


@app.get("/api/jobs/{job_id}/report")
def report(job_id: str) -> FileResponse:
    job_dir = _job_dir_or_404(job_id)
    report_path = job_dir / "conversion_report.json"
    if not report_path.exists():
        raise HTTPException(status_code=404, detail="Report not found.")
    return FileResponse(
        report_path,
        media_type="application/json",
        filename="conversion_report.json",
    )
