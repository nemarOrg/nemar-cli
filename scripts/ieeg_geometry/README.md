# ieeg_geometry

Core library for the iEEG geometry program: it reads a Brain Imaging Data Structure (BIDS) intracranial EEG dataset checkout's electrode files and subject surfaces, measures how well contacts fit a reference surface, and records the files the pipeline owns.
Tracks that label frames, apply transforms or convert surfaces build on these readers and this verifier.
Plan: `.context/plans/ieeg-geometry/plan.md`.

## Use

```bash
uv run --project scripts/ieeg_geometry python -m ieeg_geometry inspect <dataset-dir>   # read-only report
uv run --project scripts/ieeg_geometry python -m ieeg_geometry run <dataset-id> --workdir DIR [--version V] [--apply] [--surfaces-out DIR]
uv run --project scripts/ieeg_geometry python -m ieeg_geometry pr <dataset-id> --workdir DIR [--version V] [--surfaces-out DIR] [--dry-run]
uv run --project scripts/ieeg_geometry python -m ieeg_geometry upload-surfaces <dataset-id> --surfaces DIR [--bucket B] [--profile P] [--dry-run]
cd scripts/ieeg_geometry && uv run pytest -q
```

`pr` and `upload-surfaces` are run by the owner, from their own machine, with their own `gh` login, git identity and AWS profile.
`pr` clones the dataset's `main` into a fresh `DIR/<id>`, runs the pipeline with `--apply`, refuses when a track errored, when nothing changed, or when the work tree differs from `main` in anything but the report's `changes`, commits those paths once on `nemar/ieeg-geometry-<pipeline version>` with the title "Add NEMAR-computed iEEG geometry (pipeline <version>)", pushes only that branch and opens the pull request against `main` with `gh pr create`; it never merges and never force-pushes, and it refuses a branch that already exists on the remote.
The body lists every file with its method and evidence grade (shortened in steps only when it would pass GitHub's size limit).
`git add` and `git commit` run with the git-annex filter neutralized, and every staged file must be a regular file whose blob is the work-tree bytes (never an annex pointer), with the staged set exactly the report's `changes`.
A real run also refuses a remote that is not `nemarDatasets/<id>`, a missing release tag, and an input that changed after the release and could not be fetched: small files are read from the fresh clone of `main`, annexed files are downloaded from the data plane at the release version.
Inputs that could not be fetched for another reason are listed in the body under "Not fetched".
A `main` ahead of the release is not refused: the outputs are computed from the fresh clone of `main`, which the mirror's patch release will publish, so the body's "Source:" section states that `main` is ahead, lists every path changed since the release (sorted; at most 50 and 8,000 characters, then a count) and says the files were computed from `main`.

`--from-ref BRANCH` builds an integration pull request: the fresh clone is of that existing branch (a collaborator's branch merged with NEMAR's BIDS fixes) instead of `main`, the pipeline runs on its tree, the geometry is one commit on top, pushed to the same branch (fast-forward only; refused when the branch moved since the clone), and the pull request into `main` is opened or, when one from that branch is open, its title and body are updated.
The body lists the commits on the branch that are not on `main`, and the unexpected-change checks apply only to the pipeline's own diff on top of the branch.

`--bump-version` also makes the Version right for the release: the central release workflow tags `v<Version>` from `main` when a pull request merges and the central `version-check` needs the Version to differ from `main`'s, so merging cuts the release and `nemar dataset release` is not run afterwards.
A branch Version that differs from `main`'s, is `X.Y.Z` and is above every tag is kept (said in the body); otherwise `Version` in `dataset_description.json` is set to the next patch above `main`'s Version and the newest tag, a byte-preserving edit of that one value in the same commit.
It refuses a Version that is not `X.Y.Z` or a target that is already a tag; a `CHANGES` entry above the Version (normal for a mirror) is reported in the body.
`CHANGES` is the authors' and is never edited.

`--dry-run` does everything but the push and the pull request, prints the body, and warns when a real run would refuse because the release tag is missing.
`upload-surfaces` uses the `aws` command line tool (as `scripts/zarr/generate_zarr.py` does, no boto3): it lists `s3://<bucket>/<id>/zarr/geometry/` (bucket `nemar` by default), uploads the meshes the new index references (a content-addressed mesh already there is skipped), then `index.json`, then removes keys under that prefix the index no longer references; no other key is listed, written or removed.
Both refuse `nm000103` to `nm000107` and `nm099998`.
`generate_zarr.py --wipe` leaves the `geometry/` prefix in place.

`run` fetches exactly the files a dataset's geometry needs, runs the four tracks in order (labels, FreeSurfer, SPM, subject surfaces) and prints one JSON report (`schema/geometry-report.v1.json`).
It writes nothing unless `--apply` is given; `--apply` writes into the git work tree `DIR/<dataset-id>` and the surfaces into `--surfaces-out`, and never commits, pushes, opens a pull request or uploads.
Exit codes: 0 report printed, 1 the run cannot proceed (a protected id, a tree or version failure, a dataset-level file that cannot be fetched), 2 a track failed unexpectedly (the report is still printed, with the track's decisions `skipped`; `--apply` then writes nothing, neither the work tree nor `--surfaces-out`).
`--surfaces-out DIR/geometry/` ends up exactly the new index and the meshes it references (the directory is replaced, so meshes an earlier run wrote and the new index no longer names are gone).
The repository, data plane and API URL templates are module constants of `fetch.py`; `run_dataset` and `main(argv, urls=...)` accept replacements (the tests point them at local files).

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
| `version.py` | The one strict `pipeline_version()` (the installed package version; a missing package raises). Every module and every output uses it; there is no `unknown` fallback. |
| `fetch.py` | A blobless `git clone --no-checkout` of `nemarDatasets/<id>`, a checkout of only the paths the tracks read (electrodes, coordsystem and channels files, README, `dataset_description.json`, `.nemar/ieeg-geometry.json`, subject `lh/rh.pial`, `sphere.reg`, GIfTI pial, MATLAB cortex files and SPM `y_` fields; never recordings), and urllib downloads of annexed content from `data.nemar.org/<id>/<version>/<path>` into the clone's own annex object path (size and hash checked against the annex key), so links resolve and blob ids are git's. The version comes from `api.nemar.org/datasets/<id>`. A file that cannot be fetched is reported and its subject's electrodes files are removed from the work tree (decision `skipped`); a failed README, description or ownership file, the tree, the version, or more than 2 GB fails the run. |
| `pipeline.py` | `analyze` plans every track against one snapshot and builds the report; `apply` writes the plans. Cross-track rule (ruling 4 across tracks): the label track's written files and its owned paths cover a subject-and-space (and a sidecar it writes covers the file's own label); FreeSurfer then SPM never write a covered one, and each kept FreeSurfer output covers its space for SPM. The tracks' own plan and write functions decide everything else. Ids `nm000103` to `nm000107` and `nm099998` are refused. |
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
