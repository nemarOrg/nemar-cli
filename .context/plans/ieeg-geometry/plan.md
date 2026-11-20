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

### 2026-11-19, after B2's first report (PR #2226)

On real on004457 fields the inversion is exact (median residual 0.005 mm) but depth contacts measure 7.7 to 10.0 mm median from the MNI152NLin2009cAsym shell, which is a smooth gray-plus-white isosurface with no sulci; 97 to 99 percent are inside it.
A nearest-vertex median is the wrong plausibility measure against a smooth shell.

8. **Plausibility of depth contacts against the MNI shell** (and any other reference marked `smooth` in its vendored metadata): at least 95 percent inside (implicit cap) and no contact more than 10.0 mm outside; the median is reported, not judged.
   This catches the gross errors plausibility exists for (wrong file, sign or unit errors); it does not discriminate small frame errors, which is why ruling 3 also needs independent evidence.
9. **An SPM field is checked before its contacts are trusted:** at least 2,000 sampled vertices of the subject's own pial surface, inverted through the same field, must land with a median at most 6.0 mm and a 10th percentile at most 2.0 mm from the template shell. This verifies the field's direction and its pairing with the subject; with it, the field counts as ruling 3's independent evidence.
10. **Pairing ties:** when two electrode files of a subject both fit its surface, the file whose coordsystem `IntendedFor` names the T1 the field was computed from (the field's name without its `y_` prefix) is used; with no such match the subject is refused as "pairing ambiguous".

### 2026-11-19, after B1's first report (PR #2227)

On real FreeSurfer subjects the surface method gives specific evidence everywhere, while the affine (`talairach.xfm`) depth subsets are often refused by the median rule, and the affine and surface positions of the same ECoG contacts disagree by 10 to 15 mm median (the expected error of a 12-parameter affine to MNI305).

11. **The surface method is for cortical contacts only** (ECoG, grid, strip, surface types); depth contacts always take the affine method, never a snap to the pial surface.
12. **The affine is checked as a transform, then its contacts for plausibility.** At least 2,000 sampled vertices of the subject's pial surface, mapped through the same `talairach.xfm`, must land with a median at most 6.0 mm and a 10th percentile at most 2.0 mm from fsaverage's pial surface (ruling 9's check, for FreeSurfer); then the depth contacts pass ruling 8's rule against fsaverage (at least 95 percent inside, none more than 10.0 mm outside), with the median reported, not judged.
    The sidecar of every `space-MNI305` file says the positions come from an affine registration with a typical error of 5 to 15 mm, and gives the measured affine-to-surface agreement for that subject when ECoG contacts exist.
13. **Ruling 4, refined for two specific frames.** When both the declared frame and the offset frame give specific evidence and the offset is at least 3 mm, the frame whose median is at least 0.5 mm and 25 percent lower is used; otherwise the subject is refused as "frame ambiguous".

### 2026-11-19, after the A1 review (PR #2224)

14. **Subject surfaces are display data, so ruling 3 does not apply to them.** A surface and its electrodes come from the same subject's own dataset, and nothing is written into the dataset; a plausible fit is enough to draw the surface, and the index records the grade so the website can say "approximate alignment" for a plausible fit and nothing for a specific one.
15. **A written mesh is judged by what decimation changed, not re-graded.** Inside flags come from the original closed surface; the written mesh passes when its median contact distance moves by at most 0.5 mm and its 99th percentile surface deviation from the original is at most 1.0 mm. Decimation is quadric edge collapse (`fast-simplification`, MIT), not vertex clustering.

### 2026-11-19, after the C1 review (PR #2225)

16. **The blind shift control.** A shifted copy counts as failing when its median is above 1.0 mm and at least 1.5 times the unshifted median; all six shifts must fail. (The ECoG 2.0 mm rule rejected 14 of 42 verified on005007 files: a grid slid along the cortex stays 1.3 to 2.0 mm from fsaverage6.)
17. **Prose alone never writes a label until R1 is reviewed.** A candidate from README or description text with only plausible evidence returns needs-human; with specific evidence it may be written. A named template that fits far worse than fsaverage (fsaverage specific on-vertex, the named one plausible at best) returns needs-human, whatever the contact type. Two distinct passing labels from the text return needs-human.
18. **fsaverage-referenced data is written as `fsaverage`,** with the authors' own term (for example "MNI-305") carried in `iEEGCoordinateSystemDescription`.

### 2026-11-19, after B1's second report (PR #2227)

On every real FreeSurfer subject the `talairach.xfm` transform check passed (median 2.1 to 2.7 mm), but a 40 mm translation of the same transform passed too: a folded pial surface is near some fsaverage vertex from almost anywhere inside the brain.
After the affine, real depth contacts are only 62 to 75 percent inside fsaverage (2 percent for on003848 RESP0699), and the affine and surface positions of the same ECoG contacts disagree by 11 to 15 mm median.

19. **A transform check must also match shape and position**, not only nearest-vertex distance: the mapped subject vertices' centroid within 5.0 mm of the reference's, and each axis's 2nd-to-98th-percentile extent within 10 percent of the reference's, in addition to ruling 9's distances. This applies to rulings 9 (SPM) and 12 (FreeSurfer); a test shows a 40 mm translation and a 15 percent scale error both fail.
20. **Affine (`talairach.xfm`) depth positions are not written.** With a 10 to 15 mm typical error they are not worth committing as data; B1 writes only the surface-method `space-fsaverage` files for cortical contacts, and reports the depth contacts it left out. `space-MNI305` output is dropped until a nonlinear path exists (for example `sphere.reg` plus a volume warp), which would need its own card.

### 2026-11-19, after the B2 review (PR #2226)

The field check (ruling 9) proves a field's direction, not which subject or which electrodes file it belongs to: sub-1's field passes against sub-3's surface, and sub-3's native and ACPC files (15 mm apart) fit its own surface equally.

21. **Pairing an electrodes file with an SPM field needs one of:** the file's `IntendedFor` resolving to the T1 the field was computed from (same directory when one is given; a list is searched), or, when `IntendedFor` is absent or names a file that does not exist, template verification of every candidate file with a clear winner (the winner passes ruling 8, every other candidate's inside fraction is at least 0.05 lower). A file whose `IntendedFor` resolves to a different T1 is never paired. Ruling 10's tie-break is subsumed by this.
22. **Depth-contact rules are chosen by the caller, not by reference metadata.** One function in `verify.py` takes the rule explicitly (median rule or the ruling 8 inside rule); the `smooth` flag in `reference.json` is removed, so no other caller's verdict changes when a reference is added.
23. **`IXI549Space` is written only for a field on SPM12's template grid** (121 x 145 x 121, 1.5 mm, the template affine); any other grid is needs-human.

### 2026-11-19, after B1's registration check (PR #2227)

24. **A registration is also checked for coherence.** Centroid, extent and hemisphere side cannot see a scrambled `sphere.reg` (it still covers fsaverage6 evenly), so an affine fit from the sampled subject positions to their mapped fsaverage6 positions must leave a median residual of at most 15.0 mm (real on004194 subjects 5.6 to 7.7 mm; scrambled about 53 mm).

### 2026-11-19, after B2 applied ruling 19 (PR #2226)

25. **Ruling 19 against the MNI shell compares cerebrum with cerebrum.** The shell includes the cerebellum and brainstem, which a pial surface lacks, and SPM's IXI549 space sits a steady 4 to 6 mm from MNI152NLin2009cAsym. For an SPM field check the shell is cut to z at least -40 mm before the extent and centroid are computed; the extent limit stays 10 percent and the centroid limit is 10.0 mm (a 40 mm translation still fails). The FreeSurfer registration check (rulings 19 and 24, against fsaverage6 pial) is unchanged.

### Owner decisions, 2026-11-20, after the R1 dry run (PR #2229)

- No minimum number of placed contacts: any verified computed electrodes file is written, however few contacts it places (on002799's 3 to 13 contact files included).
- Both kinds of fsaverage labels are committed: README-backed (6 datasets, 1,551 files) and geometry-only blind trials (3 datasets, 224 files), since both rest on specific on-vertex evidence with the shift control.
- The 13 mirror N.0.1 pull requests are opened all at once for the owner to merge (not trickled behind the re-pull caps).

### 2026-11-20, after the code survey for P2, P3 and the docs page

The survey found: no command opens a dataset pull request for geometry yet; the published npm package carries no Python, so a workflow that runs the pipeline must check out nemar-cli; the automatic re-pull refuses any plan with corrections (`auto-not-clean-plan`), and pipeline files count as `nemar-added` corrections today; Zarr stores are written from the Hallu host and `generate_zarr.py --wipe` erases the whole `<id>/zarr/` prefix, `geometry/` included; `zarr.nemar.org` already serves any path under `<id>/zarr/`; the docs site has no `data/` section.

26. **The one-time geometry pull requests (P3a) are opened from the owner's machine** by a new `python -m ieeg_geometry pr <id>` that runs the pipeline with `--apply` on a fresh clone, commits only the pipeline's outputs on a branch `nemar/ieeg-geometry-<pipeline version>`, pushes, and opens the pull request with the owner's own `gh` login, with a body listing every file, its evidence and the method page; it never merges. A sibling `upload-surfaces <id>` writes the subject surfaces to `s3://nemar/<id>/zarr/geometry/` with the owner's own AWS profile, refusing to overwrite anything outside that prefix. Both refuse the protected ids.
27. **`generate_zarr.py --wipe` keeps `geometry/`**: the wipe excludes that prefix, with a test; Hallu itself gains no geometry work (edge-first hosting).
28. **Re-pull integration (P2)** follows the ADR 0111 amendment: paths listed in `.nemar/ieeg-geometry.json` at the base are classified `pipeline-owned`, never counted as corrections (so the automatic path is not refused for them), and the N.0.1 regenerates them by running the pipeline from a nemar-cli checkout pinned to the CLI release, deterministically, so resume can re-derive the commit; if the regenerated set is empty and nothing else needs N.0.1, no N.0.1 is made.
29. **Automation on future pushes (P3b) is a dark switch.** A central workflow `run-ieeg-geometry.yml` and a Worker dispatch on pushes touching electrodes, coordsystem or surface paths are built but stay off until the owner adds the switch, as for the re-pull and compute switches; for `nm` datasets it opens a pull request for the owner, for mirrors it only refreshes the surfaces (the re-pull handles their files).

### 2026-11-20, after P2's first report (PR #2234)

30. **The planner version moves with the plan's meaning.** Classifying pipeline-owned paths changes what a plan says, so `PLANNER_VERSION` is bumped to 3 together with the Worker's `CURRENT_PLANNER_VERSION`, with whatever the existing version-mismatch path already does for a record planned at 2 (re-plan, never silently reuse); the PR says what that path does.
31. **An automatic re-pull's N.0.1 waits for an administrator.** The existing machine-clean rule holds a plan with an N.0.1 for an administrator's merge; that stays, because each N.0.1 mints a version DOI (ADR 0111) and the re-pull switches and caps are the owner's.
