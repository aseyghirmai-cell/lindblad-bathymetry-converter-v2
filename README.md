# Lindblad Bathymetry Converter v2.0 — No Map Maritime UI

This version removes the interactive map and keeps the proven conversion engine.
It is designed to load faster while retaining all supported input and output
functionality.

## Supported inputs

- `.mb57`
- `.mb57.gz`
- Kongsberg `.all`
- `.all.gz`

The formats may be mixed in one upload. All valid soundings are combined into
one Olex-compatible `.gz` output.

## Output options

- Raw sounding data
- 15 × 15 m grid
- 20 × 20 m grid
- 25 × 25 m grid

The gridded modes retain the shallowest positive depth in each populated cell.

## Performance changes

- Removed Leaflet and OpenStreetMap dependencies.
- Removed map tiles and browser map rendering.
- Removed sounding-preview sampling and map JSON from the backend.
- The full dataset is still used for conversion.

## Deployment

Upload the ten files in this package to the GitHub repository connected to your
Render service, replace the previous files, commit, and deploy the latest commit.
Use **Clear build cache & deploy** when updating from a map-enabled version.
