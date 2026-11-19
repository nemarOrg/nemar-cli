# iEEG geometry program

Owner: Seyed Yahya Shirazi. Lead and manager: the Claude Opus session that wrote this plan (owner's decision, 2026-11-19).
Status: approved by the owner 2026-11-19 (fsaverage vendored with its license; one N.0.1 now for each mirror that gains geometry).

## Goal

Give every public intracranial EEG (iEEG) dataset the most anatomy NEMAR can honestly show.
Where a dataset's contacts are already in a template space but unlabeled or mislabeled, label them.
Where it ships a transform to a template, apply it.
Where it ships the subject's own cortical surface in the contacts' frame, draw that surface.
Every computed result is verified geometrically before it is written, and says it was computed by NEMAR.

## Evidence (census, 2026-11-19)

Read-only census of all 167 public iEEG datasets; 57 have coordinates only in native or non-standard frames.
Per-dataset table and method: `census.md` beside this plan (copied from the census run).

| Track | Mechanism | Datasets | Subjects (per dataset; patients overlap across datasets) |
| --- | --- | --- | --- |
| C, label | contacts sit on fsaverage vertices (median 0.0 mm); coordsystem missing or says native | 9 verified, 16 more `Other`-with-MNI-in-prose unverified | about 780 verified |
| B, transform | FreeSurfer `talairach.xfm` (4 datasets), SPM `y_` warp (on004457) | 5 | 45 |
| A, surface | subject pial surfaces in the contacts' frame (47 as is, 30 need FreeSurfer's c_ras offset) | 11 | 77 |

## Settled design (the ADRs formalize it; step D1)

1. **Computed electrode positions are ordinary BIDS files committed to the dataset**, as a `space-<template>` pair beside the authors' own:
   `sub-X[_ses-Y]_space-<label>_electrodes.tsv` and `..._space-<label>_coordsystem.json`.
   There is no derivatives tree.
   For a dataset with no `coordsystem.json` at all, the missing sidecar is added for the existing `electrodes.tsv` when the label is verified (track C).
2. **Provenance lives in the sidecar and in `.nemar/`.**
   `iEEGCoordinateProcessingDescription` starts "Computed by NEMAR" and names the source file, method, pipeline version and the verification distance; `iEEGCoordinateProcessingReference` links the method page on docs.nemar.org.
   `.nemar/ieeg-geometry.json` lists every path the pipeline owns, with the input files' git blob ids, pipeline version and verification result.
3. **Mirrors (`on`):** pipeline files land in the mirror's N.0.1 (ADR 0111), and a mirror with no pending re-pull gets one N.0.1 now.
   Pipeline-owned paths (listed in `.nemar/ieeg-geometry.json`) are REGENERATED in each N.0.1 from the new mirror, never replayed as corrections (an ADR 0111 amendment).
   **Datasets pushed to NEMAR (`nm`):** the same files arrive as a pull request to the dataset for its owner to accept; never committed automatically.
4. **The authors' files always win.** If a subject already has electrodes in a template space, nothing is computed for that subject and that template.
   If upstream later adds a file at a pipeline-owned path, the pipeline drops ownership of it.
5. **Nothing is written unverified.** A candidate frame or transformed position set is accepted only when the contacts' median distance to the reference surface passes the threshold for their contact type (surface-projected ECoG: at most 2.0 mm; sEEG depth: contacts inside the template brain mask, median distance to the pial surface at most 6.0 mm).
   A candidate that fails is reported, never written.
6. **Subject surfaces are display data, not dataset content.** BIDS raw has no slot for meshes, so they are converted to the website's `brain-mesh v1` format and written beside the Zarr copy (`<id>/zarr/geometry/...` on the data plane, indexed by `<id>/zarr/geometry/index.json`), with the frame they were verified in and the c_ras offset applied when needed.
   The website's Brain panel offers them as a frame labeled "This subject's anatomy (from the dataset's FreeSurfer surfaces)".
7. **Labels inferred from prose are proposals.** A model may read `iEEGCoordinateSystemDescription` and the README to propose a template; the geometric verification in item 5 accepts or rejects it, and an administrator reviews the accepted ones before anything is written for an `nm` dataset.
   For mirrors the verification is the gate.
8. **Reference surfaces** are vendored with their licenses: fsaverage (FreeSurfer license) and the MNI152NLin2009cAsym surface the website already vendors.
9. **Code lives in nemar-cli** (`scripts/ieeg_geometry/`, Python, uv, PEP 723 scripts with lock files as `scripts/neurobagel/` does); `nemarDatasets/.github` gets one thin workflow, `run-ieeg-geometry.yml`, that installs a nemar-cli release and runs it, dispatched by the Worker.

## Tracks and steps

Tracks C, B and A run in parallel once L1 is merged.
D1 (the ADRs) runs alongside L1; no track PR merges into `dev` before D1 is accepted by the owner.

| ID | Goal | Depends | Repo, branch base | Tier |
| --- | --- | --- | --- | --- |
| D1 | ADR 0129 (computed iEEG geometry), ADR 0111 amendment (pipeline-owned paths regenerate), website ADR 0034 (subject anatomy and computed frames in the Brain panel; resolves ADR 0033's open item) | none | nemar-cli and website, docs PRs | lead (me) |
| L1 | Core library: readers (electrodes, coordsystem, units incl. meters), surface readers (FreeSurfer binary with c_ras footer, GIfTI column-major, MATLAB cortex struct), nearest-vertex verifier, vendored fsaverage and MNI surfaces, `.nemar/ieeg-geometry.json` writer | none | nemar-cli, epic/ieeg-geometry | worker |
| C1 | Label inference and verification: candidates from the sidecar, README and prose; verify against fsaverage and MNI; write the sidecar or the `space-` pair | L1 | nemar-cli | worker |
| B1 | FreeSurfer `talairach.xfm` path: scanner RAS (tkr plus c_ras) to MNI305, written as `space-fsaverage`, verified | L1 | nemar-cli | worker |
| B2 | SPM deformation path: invert `y_` (MNI to native) by lookup, written as `space-IXI549Space`, verified | L1 | nemar-cli | worker-hard |
| A1 | Subject surfaces to `brain-mesh v1` plus `geometry/index.json`, with frame verification and c_ras | L1 | nemar-cli | worker |
| A2 | Brain panel reads `geometry/index.json` and offers "This subject's anatomy" | A1 format frozen | website, staging | worker |
| P1 | CLI entry `nemar admin ieeg-geometry plan|run <id>`: dry run prints what would be written per subject with distances; run writes a branch and opens the dataset PR | C1, B1, B2, A1 | nemar-cli | worker |
| P2 | Re-pull integration: N.0.1 regenerates pipeline-owned paths | P1, D1 accepted | nemar-cli | worker-hard |
| P3 | `run-ieeg-geometry.yml` in `nemarDatasets/.github` plus Worker dispatch on electrodes, coordsystem or surface changes (raw paths and the surface paths only) | P1 | both | worker |
| R1 | Dry run over all 167 datasets on staging data; report per dataset; owner reviews before any dataset PR | P1 | none (report) | worker |

on004457 is a fixture throughout: one hemisphere per subject, the `space-ACPC` mismatch for sub-2 and sub-4, an inverse-direction SPM field.

## How the manager runs this (no board, owner's decision)

- The plan and cards are the specification; state is reported in the session, not on a board.
- Implementers are Sonnet agents in their own worktrees, one card, one PR into `epic/ieeg-geometry` (website: one PR into `staging`); one review per PR by Opus (owner's standing rule: Sonnet builds, Opus reviews once), plus a seam review before the epic goes to `dev`.
- **Merge authority.** The manager merges phase PRs into `epic/ieeg-geometry` with `--admin` once targeted tests pass and the review findings are resolved.
  The owner merges: the epic into `dev`, website PRs into `staging` and `main`, anything in `nemarDatasets/.github`, and every dataset pull request (each mints a version DOI).
- Tests: targeted tests per card; the full `bun test` only at epic to `dev`; no agent waits on long jobs.
- **Hard limits.** Never write to `nm000103`-`nm000107` or `nm099998`; end-to-end tests use `nm099999` and `xx0999NN` fixtures; no dataset PR is opened before R1 is reviewed by the owner.
- Questions go to the owner in the session, with a recommendation; nothing takes a default answer.

## Risks

| Risk | Read by | If bad | Decides |
| --- | --- | --- | --- |
| Distance thresholds accept a wrong frame (sEEG depth contacts discriminate poorly) | R1 report | tighten or require two independent signals for sEEG | owner |
| fsaverage license terms for redistribution | L1 | ship only a checksum and fetch at run time | owner |
| One-hemisphere surfaces make contralateral contacts float | A2 review | label "left hemisphere only" and draw the template for the other side | lead |
| N.0.1 regeneration conflicts with ADR 0111's refusal rules | D1 | amend ADR 0111 explicitly before P2 | owner |
| Volume of version DOIs from one-time N.0.1s | R1 | batch per dataset, one N.0.1 each, behind the re-pull caps | owner |

## Lead rulings

### 2026-11-19, after the L1 review (PR #2223)

The review measured, on full closed real surfaces, that sEEG contacts in their correct frame are only 82 to 89 percent inside the pial surface (outer shaft contacts sit in bone or cerebrospinal fluid), and that 10 to 20 mm frame errors change the median and the inside fraction too little to separate them.
So a pial-surface fit is a strong test for contacts on the cortex and only a plausibility check for depth contacts.

1. **Two kinds of evidence.** `fit` reports `specific` evidence (ECoG or surface contacts passing the ECoG rule, or contacts on template vertices at a median of at most 1.0 mm with the 10 mm shift control failing) or `plausible` evidence (the sEEG rule) or a fail.
2. **The sEEG plausibility rule** replaces "95 percent inside": median at most 6.0 mm and at least 90 percent of contacts inside or within 5.0 mm of the reference surface.
3. **A write needs specific evidence, or plausible evidence plus independent frame evidence.** Independent evidence is one of: ECoG contacts of the same subject that give specific evidence in the same frame; a declared frame or a transform shipped by the dataset that already names the target space (tracks B, and C's near-miss labels such as `MNI152NLin6ASym`); a template named in prose (C's candidate 2). A blind label (C's candidate 3) needs specific evidence.
4. **The c_ras choice.** Keep the declared frame whenever it is plausible; use c_ras only when the declared frame fails and the offset frame passes with a median at least 1.5 mm and 25 percent lower; if the offset is under 3 mm the choice is immaterial and the declared frame is kept; anything else is refused as "frame ambiguous".
5. **Open references.** The MNI152NLin2009cAsym shell is two halves cut exactly at x = 0: its inside test is ray parity with each point assigned to the half on its side of x = 0 and rays pointing away from the midline (the implicit cap). Any other open reference fails closed with the reason `inside-unevaluable`.
6. **One-hemisphere surfaces.** Only contacts on the supplied hemisphere's side (the `hemisphere` column, else the sign of x in the surface's frame) are evaluated, and the count left out is reported.
7. **Real-data tests** that need full surfaces are marked `network`, download into a cache, and are run by the manager at review; CI runs the rest.
