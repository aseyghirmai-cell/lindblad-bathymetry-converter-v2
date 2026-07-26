# The Lindblad Bathymetry Converter v1.7

## New in v1.7

- Replaces the 50 × 50 m option with 25 × 25 m.
- Adds an OpenStreetMap results map.
- The map plots sampled positions from the actual extracted multibeam soundings.
- Each uploaded MB57 or Kongsberg ALL file is displayed in a separate color.
- No combined bounding polygon and no filled rectangular survey area are shown.
- The map automatically zooms to all sounding tracks.
- Hovering a sounding displays filename, depth and WGS 84 coordinates.
- Adds a premium expedition-style dashboard and visible conversion stages.

## Supported input

- `.mb57`
- `.mb57.gz`
- `.all`
- `.all.gz`

Multiple files are combined into one Olex-compatible `.gz` output when the
combined working size remains within the configured 500 MB limit.

## Output options

- Raw sounding data
- 15 × 15 m grid
- 20 × 20 m grid
- 25 × 25 m grid

All gridded modes retain the shallowest positive depth in each populated cell.

## Map accuracy

The dashboard map uses a controlled sample of actual sounding positions to keep
the browser responsive. It represents the sonar swath/track pattern and does not
invent coverage between soundings. The full extracted dataset is still used for
the Olex conversion.
