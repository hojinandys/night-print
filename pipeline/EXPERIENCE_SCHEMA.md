# NIGHT PRINT interaction metadata · schema 1

`export_experience.py` exports map geometry and comparison context from the same processed observation arrays and administrative boundaries used by the relief. It never changes observation values, relief geometry, rendered images, or existing manifest statistics.

## Build and publication validation

```sh
python pipeline/export_experience.py --project ../night-print-regions --out dist
python pipeline/export_experience.py --project .runtime/staging/RECENT_EDITION --out dist/recent
python -S pipeline/export_experience.py --validate --out dist
python -S pipeline/export_experience.py --validate --out dist/recent
```

The build uses NumPy, Rasterio, PyProj and Shapely already required by the observation pipeline. `build(project, out)` is called after the edition manifest exists. `validate(out)` needs only the Python standard library and can run before publication. A failure must prevent publication of the candidate edition.

The exporter adds only `regions[].interaction_url` and `experience` to the existing manifest. It writes one JSON file per region to `assets/interaction/{region}.json`, plus `assets/interaction/validation.json`. Resolve each URL relative to its edition root, including archived editions. `experience.files[]` records the region, URL, byte size and SHA-256 digest.

## Geometry contract

Each region file contains:

| Key | Meaning |
| --- | --- |
| `schema`, `region`, `name`, `years`, `units` | Edition identity; years are integers, radiance units are `nW/cm²/sr`. |
| `bounds` | `[minX, minY, maxX, maxY]`, in the original relief's world XY. |
| `polygons` | The full administrative region boundary. |
| `observed` | The union of valid common observation cells, clipped to the full boundary. |
| `missing` | Full boundary minus `observed`. An empty array is valid. |
| `districts[]` | `id`, `name`, `polygons`, interior `anchor: [x,y]`, coverage/area and comparison records. |
| `coverage_pct`, `observed_area_km2`, `missing_area_km2`, `boundary_area_km2` | Exact source geometry areas, rounded to eight decimals for JSON. |
| `coordinates` | Source CRS, UTM origin, UTM-to-world scale, north direction, rounding and simplification settings. |
| `source` | SHA-256 hashes of facts, boundaries and regional observation arrays. |

Every polygon is an object, **not a tuple**:

```json
{"outer": [[0,0],[1,0],[1,1],[0,0]], "holes": []}
```

Outer and hole rings are closed. MultiPolygon islands remain separate objects. No simplification is applied. Original boundary vertices are retained and transformed to world XY rounded to eight decimals. **North is +Y**; a north-up SVG must invert Y when mapping to its downward screen axis. Do not flip Y for the 3D renderer.

The transform is identical to the existing relief exporter:

```text
scale = 10 / max(grid_columns × cell_m, grid_rows × cell_m)
origin_x = affine_x_offset + grid_columns × cell_m / 2
origin_y = affine_y_offset - grid_rows × cell_m / 2
world_x = (utm_x - origin_x) × scale
world_y = (utm_y - origin_y) × scale
```

Use the full `polygons` bounds for the map so missing areas stay visible. A valid observation of radiance zero remains in `observed`; it must not receive a missing-data hatch. `missing` means exclusion by data availability, quality conditions or the edition-wide common mask. It does not establish the cause of exclusion for each individual point.

## Comparison contract

The region and each district have `comparisons[]`, containing every ordered observed-year pair, including reverse and identical pairs. `from` and `to` are integer years. Select the pair matching the two actual observations; no interpolation or invented year is included.

| Key | Meaning |
| --- | --- |
| `from_mean`, `to_mean`, `mean_change` | Area-weighted means and `to_mean − from_mean`. |
| `percent_change` | Relative mean change; `null` when the starting mean is zero. |
| `lower_area_pct`, `higher_area_pct`, `unchanged_area_pct` | Shares of common area with strictly negative, strictly positive or exactly zero observed difference. These sum to 100. |
| `from_zero_area_pct`, `to_zero_area_pct` | Shares of common area whose valid observed radiance is exactly zero. |
| `small_change_area_pct` | Object keyed by `"0.1"`, `"0.5"`, `"1"`: share with `abs(to − from) <= threshold`. |
| `decrease_beyond_pct` | Same keys: share with `to − from < -threshold`. |
| `increase_beyond_pct` | Same keys: share with `to − from > threshold`. |

For each threshold, the last three shares partition the same common observed area and sum to 100. Thresholds are **absolute observed radiance differences in nW/cm²/sr**. They are an adjustable reading aid, not an uncertainty estimate, noise model, confidence interval or statistical significance test. The default UI choice is 0.5. Use language such as “선택한 크기 이하의 차이”, not “유의미하지 않음”.

Every comparison within an edition uses its fixed whole-edition common mask. Annual 2015–2023 pairs therefore all use the intersection of those nine observations. The monthly pair uses its two observations. The denominator is common observed area within the selected region or district; it excludes `missing` and includes real zeros. Do not compare annual and monthly mean levels as if they were one calibrated time series.

## Validation guarantees

During build, the common-cell footprint area is independently calculated from polygons and checked against exact area weights. District weights are checked against the existing manifest's named district statistics, preventing row/order mistakes. Existing means and baseline-decrease shares must agree before export.

Publication validation checks file hashes, safe paths, edition/year identity, all expected district IDs, ring closure and finite coordinates, north/scale conventions, footprint areas, complete observed pairs, original means and baseline-decrease shares, and percentage partitions. Source areas are checked before coordinate rounding; the standard-library polygon-area check permits 20 m² of accumulated rounding difference. The annual and monthly editions currently both contain 43 districts; pair totals are respectively 3,726 and 184 across three regions plus their districts.

If an interaction file is missing or invalid, retain the existing artwork and honestly indicate that linked boundary/comparison context is unavailable. Do not derive a replacement polygon or comparison from rendered pixels.
