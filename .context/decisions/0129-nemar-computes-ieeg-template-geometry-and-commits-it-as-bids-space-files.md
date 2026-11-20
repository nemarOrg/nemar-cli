# ADR 0129: NEMAR computes iEEG template geometry, verifies it, and commits it as BIDS `space-` files

**Status:** proposed
**Date:** 2026-11-19
**Owner:** Seyed Yahya Shirazi

## Context

The website's Brain panel draws intracranial EEG (iEEG) contacts on a template brain only when a dataset declares a standard template frame (website ADR 0033).
A census of the 167 public iEEG datasets on 2026-11-19 (`.context/plans/ieeg-geometry/census.md`) found 57 with coordinates only in native or non-standard frames, and that much of that gap is recoverable from what the datasets already ship:
nine datasets (about 780 subjects, with patients repeated across datasets) have contacts exactly on fsaverage vertices but no or a wrong coordinate-system label;
five ship a transform to a template (FreeSurfer `talairach.xfm` and `sphere.reg`, or an SPM deformation field);
eleven ship the subject's own cortical surface in the contacts' frame.
NEMAR datasets have no derivatives tree: a mirror (`on`) is a pure copy of its OpenNeuro snapshot at N.0.0 with NEMAR's corrections at N.0.1 (ADR 0111), and a dataset pushed to NEMAR (`nm`) belongs to its owner.

## Decision

**NEMAR computes template-space electrode positions from a dataset's own files, writes them only when a geometric check passes, and commits them to the dataset as ordinary BIDS `space-<label>` electrode and coordinate-system files that say they were computed by NEMAR; subject surfaces are converted into display data beside the Zarr copy and are never committed.**

1. **Form.** A computed result is a `sub-X[_ses-Y]_space-<label>_electrodes.tsv` and `..._space-<label>_coordsystem.json` pair beside the authors' files, in millimeters.
   An electrodes file with no coordinate-system sidecar at all gets the missing `..._coordsystem.json` when its label is verified.
   An existing author file is never edited.
2. **Verification gates every write.** Each result is fitted to the reference surface of the claimed space and graded.
   Specific evidence: electrocorticography (ECoG) or surface contacts with a median nearest-vertex distance of at most 2.0 mm, or contacts on template vertices (median at most 1.0 mm against the vendored fsaverage6, while the same contacts shifted by 10 mm along each axis fail).
   Plausible evidence: depth (sEEG) contacts with a median of at most 6.0 mm and at least 90 percent inside or within 5.0 mm of the surface; a pial-surface fit cannot tell a depth implant's correct frame from one 10 to 20 mm off, so this is a plausibility check only.
   A write needs specific evidence, or plausible evidence plus independent frame evidence: ECoG contacts of the same subject that give specific evidence, a near-miss label in the dataset's own sidecar that already names the target space, or a transform the dataset ships whose own check passed (an SPM field passing its field check).
   A template named only in a README or description needs specific evidence; with plausible evidence alone it is left for a human.
   A label found without any textual evidence needs specific evidence.
   A reference surface whose inside cannot be evaluated fails closed.
   A frame declared `ACPC` or `ScanRAS`, or tied by `IntendedFor` to the subject's own scan, is never relabeled; it can only be transformed.
   `MNI` without a variant and `Talairach` are never written as labels.
3. **Provenance.** `iEEGCoordinateProcessingDescription` starts "Computed by NEMAR" and names the source files, the method, the pipeline version and the verification distances; `iEEGCoordinateProcessingReference` links the method page on docs.nemar.org.
   `.nemar/ieeg-geometry.json` lists every path the pipeline owns, with its inputs' git blob ids, the method and the verification result, written deterministically.
4. **The authors' files win.** Nothing is computed for a subject and space the authors already cover.
   A pipeline-owned path that upstream later adds becomes upstream's, and the pipeline drops it from its ownership list.
5. **Mirrors.** The files land in the mirror's N.0.1.
   A mirror with no pending re-pull gets one N.0.1 for its geometry, after the owner has reviewed the dry-run report for it.
   A path listed in `.nemar/ieeg-geometry.json` is regenerated from the new snapshot in each later N.0.1, not replayed (the ADR 0111 amendment of 2026-11-19).
6. **Datasets pushed to NEMAR.** The same files are offered as a pull request to the dataset; nothing is committed without its owner's merge.
7. **Subject surfaces are display data.** A subject surface that fits its contacts (decision 2's rule, as declared or with FreeSurfer's c_ras offset) is converted to the website's `brain-mesh v1` format in the contacts' frame and written beside the Zarr copy under `<id>/zarr/geometry/`, indexed by `geometry/index.json`; it is never committed to the dataset.
8. **Where it runs.** The code is `scripts/ieeg_geometry/` in this repository (Python, uv); `nemarDatasets/.github` runs it through one thin workflow, dispatched by the Worker, that installs a released nemar-cli as the re-pull workflow does.
   Reference surfaces (fsaverage6, MNI152NLin2009cAsym) are vendored with their licenses.

## Consequences

- The largest share of the gap (the nine fsaverage datasets) closes with labels alone, with no numeric transformation of anyone's data.
- Every computed file is checkable: its sidecar says how it was made and how well it fit, and the ownership file says which inputs it came from.
- A one-time N.0.1 per mirror that gains geometry mints one version DOI each; re-pulls regenerate the files instead of conflicting with them.
- Positions from an affine transform (`talairach.xfm`) and SPM spaces are approximate by a few millimeters; their sidecars say so, and the website labels them approximate as ADR 0033 already does for template variants.
- sEEG depth contacts discriminate frames poorly; the thresholds are read against the dry-run report over all 167 datasets before any dataset pull request is opened.
- The pipeline now owns paths inside datasets. Each owned file's hash is recorded, so a hand edit is detected: the edited file (with its pair) is kept and reported, never overwritten or deleted, and it is no longer regenerated; the method page says so.

## Alternatives considered

- **Keep computed positions only on the data plane, beside the Zarr copy.** It avoided version churn, but the positions would exist only on nemar.org; committing them makes them travel with the dataset, and N.0.1 already exists for each re-pull.
- **A `derivatives/` tree.** NEMAR datasets have none, and the Zarr dispatch excludes it (ADR 0027).
- **Ask authors to fix their datasets and wait.** Still done for every finding, but most mirrors' authors are not reachable on a schedule, and the census shows the fix is mechanical and checkable.
- **Commit subject surfaces.** BIDS raw has no place for meshes; they are display data for one viewer.
- **Trust declared labels or prose without a geometric check.** The census found mislabeled frames in both directions (template data declared native, an `ACPC` file that does not match its own subject's surface).

## Receipts

- Census and plan: `.context/plans/ieeg-geometry/census.md`, `.context/plans/ieeg-geometry/plan.md`.
- ADR 0111 (re-pull as N.0.0 and N.0.1), ADR 0027 (raw-only Zarr dispatch), website ADR 0033 (the Brain panel and its template table).
