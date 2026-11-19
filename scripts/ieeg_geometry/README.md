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
| `spm.py` | SPM `y_` deformation field to `space-IXI549Space` (card B2), depth contacts only. Per-contact Newton inversion of the field (residual under 0.05 mm); pairing (ruling 21): the electrodes file whose `IntendedFor` (dataset- or subject-relative, a list is searched) names the T1 the field was computed from, never a file naming a different existing T1, else a clear winner of template verification (inside fraction at least 0.05 above every other candidate), the subject-surface fit being reported only; a field check on the subject's own pial vertices (median and 10th percentile from the shell, centroid, extent; the shell cut to z of at least -40 mm); verification against `MNI152NLin2009cAsym` with the inside rule; a plan object and `write(plans, dataset_dir)` that keeps hand-edited pairs. Files with cortical (ECoG) contacts are refused: the cortical contacts belong to the FreeSurfer surface method. The field check excludes a reversed or grossly wrong field (errors of roughly 10 mm or more) and does not prove position beyond that (a 5 mm or 10 mm shift in y passes; 10 mm in z or 8 mm in x fails). A field on SPM12's template grid is accepted, and so is a crop of it on the same 1.5 mm lattice inside the 121 x 145 x 121 grid (ruling 23); any other grid is `needs-human`. |
| `freesurfer.py` | Track B1: for subjects with a FreeSurfer subject directory, decides tkr RAS versus scanner RAS (c_ras) against the subject's pial surfaces using the cortical contacts, maps ECoG, grid, strip and surface contacts within 3.0 mm of the pial surface to fsaverage6 through `sphere.reg`, verifies the set against fsaverage and writes only `space-fsaverage` files, merging into `.nemar/ieeg-geometry.json`. Depth and unknown-type contacts are not written (affine `talairach.xfm` positions are too inaccurate to commit); every contact left out is counted with its reason in the report, the sidecar and the ownership record. Report: `python -m ieeg_geometry.freesurfer <dataset-dir>` (also appended to `inspect`). |
| `meshwrite.py` | `brain-mesh v1` encoder (byte-identical to the website's), quadric edge collapse (`fast-simplification`) to at most 65,535 vertices per hemisphere, edge statistics, point-to-surface deviation, signed volume for the winding test. |
| `surfaces_out.py` | Subject surfaces to `geometry/index.json` plus content-addressed `geometry/meshes/<sha256>.mesh.bin`, in the contacts' frame (`c_ras` added to the vertices when the offset frame fits). The written mesh is judged by what decimation changed (ruling 15), not re-graded. Run `python -m ieeg_geometry.surfaces_out <dataset-dir> --out <dir> [--source-commit <sha>]` (the commit defaults to the dataset checkout's HEAD). The index schema is `schema/geometry-index.v1.json` (frozen for the website). |
| `labels.py` | Label inference for electrodes files whose frame is missing, wrong or non-standard: candidates from the sidecar (including an inherited one), the description and README, then blind trials of `fsaverage` and `MNI152NLin2009cAsym`; accepted only on the evidence rules in the module docstring (lead rulings 16 to 18). `plan_dataset` builds a plan, `write(plan, dir)` writes a missing sidecar or a `space-<label>` pair and records it in the ownership file (with the SHA-256 of what was written; hand-edited files are kept, and so is a legacy owned file with no `output_sha256` whose bytes differ). `inspect` prints each proposal and what suppressed blind trials. |
| `ownership.py` | `.nemar/ieeg-geometry.json` writer and reader, deterministic bytes, git blob ids of inputs, optional `output_sha256` of the written bytes. |

## Evidence grades

`verify.fit` grades contacts against a reference surface (lead rulings in the plan, 2026-11-19):
`specific` (ECoG contacts with a median nearest-vertex distance of at most 2.0 mm, or contacts on template vertices at most 1.0 mm whose 10 mm shift fails), `plausible` (depth contacts with a median of at most 6.0 mm and at least 90 percent inside or within 5.0 mm of the surface), or `fail`.
Depth contacts in the right frame measure only 82 to 89 percent strictly inside the pial surface, so `plausible` is a plausibility check, not proof of a frame.
FreeSurfer surfaces are in tkr RAS and scanner RAS = tkr RAS + c_ras, so contacts declared in scanner RAS are brought into the surface frame by subtracting c_ras (checked on on003848 sub-RESP0699: 33.3 mm as declared, 1.37 mm subtracted).
A caller can pass `depth_rule=INSIDE_RULE` to `fit` (the SPM track does, against the MNI shell): at least 95 percent inside and none more than 10.0 mm outside, the median reported, not judged (ruling 8). The default is the median rule; no reference changes any caller's verdict (ruling 22).
Open references: the MNI shell uses the implicit cap at x = 0; any other open surface fails closed with `inside-unevaluable` for depth contacts.

Nearest-vertex distances are biased upward for points that lie on the surface itself: a point on the surface but between vertices reads about 0.50 mm on fsaverage6 and 0.74 mm on the MNI shell.
A median near 0 therefore means the contacts sit on template vertices, not merely on the surface.

## Tests

`uv run pytest -q` runs the offline suite (CI).
`uv run pytest -q -m network` downloads full public surfaces into `~/.cache/ieeg_geometry_tests` (or `$IEEG_GEOMETRY_CACHE`) and checks the real-data numbers quoted in the tests.

## Vendored data (`ieeg_geometry/data/`)

- `fsaverage/`: fsaverage6 pial and `sphere.reg` surfaces (both hemispheres; `sphere.reg` rebuilt with `tools/build_fsaverage6_sphere.py` from fsaverage's `sphere.reg` in on004194 v1.0.0) derived from fsaverage, a modified version marked as such in `LICENSE` (FreeSurfer Software License, which allows redistribution with its terms). Rebuild with `tools/build_fsaverage6.py`.
  Provenance and known limit: the source is the copy of FreeSurfer's fsaverage pial surfaces shipped by public dataset on004370 (`derivatives/freesurfer/{lh,rh}.pial`, header "created by greve on Thu Apr 11 2013", sha256 `9cb004f6...0f29` for lh and `4f752701...1212` for rh), not a download from FreeSurfer's distribution.
  The fsaverage6 vertices and triangles were derived from it; a comparison against FreeSurfer's own fsaverage6 files was not possible offline.
- `mni152nlin2009casym/`: the website's `brain-mesh v1` MNI152NLin2009cAsym tissue shell, copied with its license and provenance. It is a gray-plus-white-matter isosurface cut at x = 0, not a cortical pial surface and not closed; its inside test uses the implicit cap.

Every vendored file is under 3 MB.
