# ieeg_geometry

Core library for the iEEG geometry program: it reads a Brain Imaging Data Structure (BIDS) intracranial EEG dataset checkout's electrode files and subject surfaces, measures how well contacts fit a reference surface, and records the files the pipeline owns.
Tracks that label frames, apply transforms or convert surfaces build on these readers and this verifier.
Plan: `.context/plans/ieeg-geometry/plan.md`.

## Use

```bash
uv run --project scripts/ieeg_geometry python -m ieeg_geometry inspect <dataset-dir>   # read-only report
cd scripts/ieeg_geometry && uv run pytest -q
```

## Modules

| Module | Does |
| --- | --- |
| `bids.py` | Finds every `electrodes.tsv` and `coordsystem.json` pair per subject, session and `space-` entity; `n/a` and `NaN` coordinates are kept and flagged; units `m`, `cm`, `mm` become millimeters, anything else is refused with a named reason; contact type from the `type` column, else `channels.tsv`, else `unknown`. |
| `surfaces.py` | FreeSurfer binary (with the c_ras footer), GIfTI (ASCII, Base64Binary, GZipBase64Binary, either array order) and MATLAB v5 `vert`/`tri` or `Vertices`/`Faces` into one `Surface`. MATLAB v7.3 is refused. |
| `reference.py` | The vendored references by name (`fsaverage`, `MNI152NLin2009cAsym`) and a strict `brain-mesh v1` reader. Checks `SHA256SUMS` on load. |
| `verify.py` | `fit` (median, 90th percentile, maximum nearest-vertex distance; ray-parity inside test) and `fit_with_offset` (as declared and with c_ras added). Thresholds and the degenerate-ray handling are in the module docstring. |
| `ownership.py` | `.nemar/ieeg-geometry.json` writer and reader, deterministic bytes, git blob ids of inputs. |

## Vendored data (`ieeg_geometry/data/`)

- `fsaverage/`: fsaverage6 pial surfaces (both hemispheres) derived from FreeSurfer's fsaverage, a modified version marked as such in `LICENSE` (FreeSurfer Software License, which allows redistribution with its terms). Rebuild with `tools/build_fsaverage6.py`.
- `mni152nlin2009casym/`: the website's `brain-mesh v1` MNI152NLin2009cAsym tissue shell, copied with its license and provenance. It is a gray-plus-white-matter isosurface cut at x = 0, not a cortical pial surface and not closed, so the inside criterion is not evaluated against it.

Every vendored file is under 3 MB.
