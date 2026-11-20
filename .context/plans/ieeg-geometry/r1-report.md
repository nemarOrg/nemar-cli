# R1: dry run over every public iEEG dataset

Run on 2026-11-19 with pipeline `ieeg_geometry` at `origin/epic/ieeg-geometry` 7e735f8b (P1 merged), without `--apply`: nothing was written, pushed or uploaded.
Per-dataset reports are in `r1/reports.tgz` (167 files, 208 KB compressed, built with fixed owner and times; the raw JSON is about 7 MB, over the 5 MB limit, so only the archive is committed).
Every number in the tables below is recomputed from those reports by `scripts/ieeg_geometry/tools/r1_summary.py`; its full output is the appendix, unedited.
Recompute with `uv run --project scripts/ieeg_geometry python scripts/ieeg_geometry/tools/r1_summary.py .context/plans/ieeg-geometry/r1/reports.tgz .context/plans/ieeg-geometry/census.csv`.

## Headline

- All 167 census ids were run; all 167 produced a report (exit code 0 each); none failed.
  Two needed a second look: `nm000406` failed twice with a stale git `index.lock` while four runs were in flight and passed when re-run alone (a concurrency artifact of this run, not a data problem), and `on005691` refuses a default run ("no released version", the API lists none) so its report is a run with `--version v1.0.0`; it has no electrodes files (epidural spinal recordings).
  None of `nm000103` to `nm000107` or `nm099998` is in the census, so nothing was refused by design.
- 7,193 electrodes files in total.
  The pipeline would write geometry for 23 datasets: 13 get new dataset files (all mirrors, `on`), and 10 get subject surfaces only (display data on the data plane, nothing in the dataset).
  No `nm` dataset would receive a pull request: every `nm` dataset is either refused, skipped or needs a human.
- Labels track: 1,775 electrodes files written in 9 datasets (about 779 subjects), all `specific` evidence, all labeled `fsaverage`.
  These are exactly the 9 datasets the census verified (on004370, on004551, on005007, on005545, on005931, on006107, on006233, on006910, on006914); the label proposals came from README text for 6 datasets (1,551 files) and from blind trials for 3 (on005007, on005931, on006107).
  The blind trials wrote 224 files, always with specific evidence (largest median 0.875 mm against the 1.0 mm on-vertex limit).
- FreeSurfer track: 25 `space-fsaverage` files written for ECoG contacts in 3 datasets (on002799: 8, on003848: 2, on004194: 15 files for 10 subjects); 1,924 files refused, nearly all for `units: n/a` (741) or a missing `coordsystem.json` (1,111), neither of which is a geometry failure.
- SPM track: 4 `space-IXI549Space` files written, all in on004457 (subjects 1 to 4), all `plausible` evidence backed by the field check (ruling 9).
- Surfaces: 77 entries in 10 datasets, 70 distinct subjects (plan estimate: 77); 34 `specific`, 43 `plausible`; 8 entries are one hemisphere only (on004457 and on005953 and one on003848 file).
- Needs-human: 233 label files in 7 datasets (nm000352, nm000357, nm000358, nm000367, nm000368, nm000435, on004752), all for the same reason, "MNI variant unknown".

## Closest threshold calls

Margin is the slack as a fraction of the limit (for a lower bound such as the inside fraction, of the range from the limit to 1.0).
The tool lists every written value within 15 percent; below are those plus the centroid, extent and registration numbers, which the report JSON does not carry and which come from `python -m ieeg_geometry inspect` on a fresh dry-run checkout of the same commit (the reports re-created byte for byte).

- on004457 sub-3, SPM field check: centroid 8.7 mm against the 10.0 mm limit (13 percent margin); extent difference 9 percent against 10 percent (10 percent margin).
  The other subjects: sub-1 centroid 6.5 mm and extent 4 percent, sub-2 5.0 mm and 8 percent, sub-4 5.4 mm and 7 percent.
  sub-4's median is 5.33 mm against 6.0 mm (11 percent margin, in the tool's list) and its 10th percentile 1.49 mm against 2.0 mm.
- on004194 sub-p03, registration centroid 4.33 mm against 5.0 mm (13 percent margin).
  sub-p07 is closer: 4.75 mm (5 percent margin), for 2 sessions.
  The others are 1.99 to 3.80 mm; extents are within 2.5 to 5.3 percent against the 10 percent limit; affine residuals are 5.2 to 7.7 mm against 15.0 mm.
- on002799 sub-294, registration centroid 4.28 mm against 5.0 mm (14 percent), written.
  on002799 sub-331 has a centroid of 5.20 mm, which is why its registration check failed (17 cortical contacts left out, correctly).
- ECoG median against the 2.0 mm rule: on002799 sub-307 at 1.957 mm (2.1 percent; its surface fit 1.958 mm); on004194 sub-p08 at 1.826 mm (8.7 percent; surface 1.91 mm, 4.5 percent); on002799 sub-331 surface 1.897 mm (5.1 percent), sub-330 1.818 mm, sub-405 1.81 mm; on003848 RESP0699 surface 1.796 mm (10.2 percent); on004194 sub-p09 surface 1.703 mm (14.8 percent, 2 sessions).
- Label medians: both label kinds (README and blind) are written on the 1.0 mm on-vertex rule with the shift control (rulings 16 and 17); all 1,775 medians are at or below 0.875 mm (on006107 sub-145), a 12.5 percent margin, the only one within 15 percent; the tool now judges labels against 1.0 mm.
  The report does not record which rule applied, a patch note for the label track.
- Surface `plausible` fit: the lowest share of contacts inside or within 5.0 mm of the surface is 0.933 (on004473 sub-12) against 0.90; decimation shifts are at most 0.312 mm of 0.5 mm and 0.106 mm p99 of 1.0 mm.

## Needs-human items

233 files in 7 datasets, one reason: the README or the coordsystem description names MNI (or Talairach) without a variant, and the pipeline will not guess among variants (nm000352 also names Talairach).
Per dataset: nm000352 19, nm000357 29, nm000358 55, nm000367 13, nm000368 37, nm000435 12, on004752 68.
These are the `nm` candidates for an administrator review; all except on004752 are datasets pushed to NEMAR, so a human choice would produce a pull request.
A further 345 label files were refused ("no candidate verified"), 282 in on006890 and 60 in on005083; those are datasets whose prose names MNI but whose contacts fit neither fsaverage nor the MNI shell.

## Refusal reasons

See the appendix for counts.
In short: `units-unsupported` (iEEGCoordinateUnits is the string `n/a`) in 58 datasets, `coordsystem-missing` in 12 datasets, mostly the label track's own (those datasets have no coordsystem at all, and the label track adds the sidecar), `too-few-cortical-contacts` (34 files), `subject-dir-ambiguous` (16, nm000454 and on003848), `frame-not-found` (8), `frame-ambiguous` (6), `no-contacts-placed` (6), one `registration-check-failed` (on002799 sub-331), one unreadable coordsystem.
Subject surfaces that could not be drawn (no frame fits): nm000371 (10 files, `surface-unreadable`), on002799 (9), on004473 (9), on004194 (3), on005415 (3), on004457 (2), on005953 (1); on003848 has one file with no coordsystem.

## Risk rows in the plan

| Risk | What the run shows |
| --- | --- |
| sEEG depth contacts discriminate poorly | No file is written on `plausible` evidence alone. The 4 SPM files rest on `plausible` depth evidence plus the field check (ruling 3). Two kinds of number must not be confused. The depth-contact numbers in the reports are only `inside_fraction`, 0.966 to 0.988 against the 0.95 rule; the reports do not carry the depth-contact median against the shell (ruling 8 reports it, the report JSON does not). The 4.4 to 5.3 mm figures are `field_check_median_mm`: the subject's own pial vertices, inverted through the field, against the template shell, judged against 6.0 mm (ruling 9) and passed (sub-4 is the closest at 5.33 mm, 11 percent margin). The 43 `plausible` surface entries are display only (ruling 14). The run cannot show whether a wrong sEEG frame would pass (the review measured that it would for shifts of 10 to 20 mm); on004457's ACPC files for sub-2, sub-3 and sub-4 were correctly not paired (inside 50.3, 89.2 and 42.4 percent against 97.6, 98.0 and 98.8). Recommendation: keep ruling 3's two-signal requirement. |
| fsaverage license | 1,800 written files carry `space-fsaverage` (1,775 labels, 25 FreeSurfer), so the program depends on the vendored fsaverage6 surfaces and their license terms. The run used the vendored copy; it adds no new evidence about redistribution. The owner decision (vendor with license, 2026-11-19) stands; the note in the data README says the copy came from a public dataset, not FreeSurfer's distribution. |
| One-hemisphere surfaces make contralateral contacts float | 8 of 77 surface entries are one hemisphere (on004457 sub-1 to sub-5 including the ACPC file, on005953 sub-01, on003848 RESP0699). Their `n_left_out` is 0 for all except on005953 (19 of 117 contacts on the other side); on004457's contacts all sit on the supplied side. A2 should label them. |
| N.0.1 regeneration conflicts with ADR 0111 | Every dataset with new files is a mirror and none has an existing `.nemar/ieeg-geometry.json` (0 files `kept` or `unchanged`), so this run exercises only first writes, not regeneration. The 13 mirrors that would need a version are listed below. |
| Volume of version DOIs | 13 datasets would need one N.0.1 each (on002799, on003848, on004194, on004370, on004457, on004551, on005007, on005545, on005931, on006107, on006233, on006910, on006914), 2,583 paths in total (the largest: on006910 769, on006914 707, on005545 337, on006233 348). Subject surfaces (10 datasets) need no dataset version. Whether these 13 should be batched behind the re-pull caps is the owner's call. |

## Decisions and findings for the owner

Owner decisions of 2026-11-20, recorded at the end of `plan.md`, answer the three questions this report first raised:

- Minimum placed contacts: none; any verified file is written, however few contacts it places (on002799's 3 to 13 contact files included).
- Unreviewed labels: both kinds are committed, the 6 README-backed datasets (1,551 files) and the 3 blind-trial datasets (224 files), since both rest on specific on-vertex evidence with the shift control.
- The 13 mirror N.0.1 pull requests are opened all at once, not trickled behind the re-pull caps.

Findings:

- on002799's 8 `space-fsaverage` files sit beside the authors' own `space-MNI152NLin6Asym` files and each places 3 to 13 contacts.
  The authors' electrodes files list few contacts (3 to 20 per subject; the channel descriptions of sub-294 say they are used for stimulation only); for sub-294 and sub-303 every channel is typed `ECOG` in `channels.tsv`.
  For sub-294 (3 placed) and sub-303 (4 placed) `left_out` is empty because every listed contact was placed.
  For the other six subjects the contacts left out are ECoG contacts more than 3 mm from the pial surface (`cortical-beyond-3mm`), not depth contacts.
- Contact type of on002799 sub-294 and sub-303 (read-only investigation of a fresh dry-run checkout).
  Their `electrodes.tsv` has no `type` column; the type comes from the subject's `channels.tsv` files (4 and 10 channels, all `ECOG`), through `bids.py`'s fallback from channels files.
  The FreeSurfer track therefore treated them as cortical contacts (ruling 11), and no sEEG contact was snapped to cortex.
  The `contact_type: seeg` in their surface entries is a label for the rule applied, not the contacts' type: `surfaces_out._contacts_for_fit` uses the ECoG rule only when a file has at least 8 ECoG contacts (`MIN_ECOG_CONTACTS`), and falls back to the depth rule over all contacts otherwise, while the FreeSurfer track needs only 3 (`MIN_CONTACTS`).
  This is a product inconsistency, not an error in the written files: the two surface entries are graded `plausible` (display only) where an ECoG rule would apply.
  Suggested follow-up for the owner of A1: report the rule as `depth_rule` rather than `contact_type`, or align the minimum.
- The two centroids close to the 5.0 mm limit (on004194 sub-p07 at 4.75 mm, on002799 sub-294 at 4.28 mm) are not failures.
- 741 electrodes files in 58 datasets carry `iEEGCoordinateUnits: n/a`, which the readers refuse; that is outside the geometry program but caps what the FreeSurfer track can do for them.

## Follow-ups (patch notes)

- Add the registration and field-check numbers (centroid, extent difference, affine residual, side fraction) to the P1 report JSON, so a future summary needs no `inspect` run.
- Record in each label decision which rule applied (the 1.0 mm on-vertex rule or the 2.0 mm ECoG rule).
- Record the depth-contact median against the shell for SPM files, next to `inside_fraction`.
- Resolve the `contact_type` label versus the contact count minimum (above); resolved by #2232.

## Appendix: tool output

Census ids: 167; reports: 167; failed to run: 0

## Totals per track (electrodes files)

| track | written | unchanged | kept | needs-human | refused | skipped |
| --- | --- | --- | --- | --- | --- | --- |
| labels | 1775 | 0 | 0 | 233 | 345 | 4840 |
| freesurfer | 25 | 0 | 0 | 0 | 1924 | 5244 |
| spm | 4 | 0 | 0 | 0 | 0 | 7189 |
| surfaces | 77 | 0 | 0 | 0 | 0 | 7116 |

Electrodes files: 7193. Paths an apply would add (all datasets): 2583.
Subject-surface entries: 77 (distinct dataset and subject: 70).

## Evidence grades of written decisions

| track | specific | plausible | other |
| --- | --- | --- | --- |
| labels | 1775 | 0 | 0 |
| freesurfer | 25 | 0 | 0 |
| spm | 0 | 4 | 0 |
| surfaces | 34 | 43 | 0 |

## Datasets that would gain files (written or unchanged decisions)

| dataset | track | subjects | electrodes files |
| --- | --- | --- | --- |
| on002799 | freesurfer | 8 | 8 |
| on002799 | surfaces | 14 | 14 |
| on003848 | freesurfer | 2 | 2 |
| on003848 | surfaces | 5 | 5 |
| on004194 | freesurfer | 10 | 15 |
| on004194 | surfaces | 13 | 18 |
| on004370 | labels | 7 | 7 |
| on004457 | spm | 4 | 4 |
| on004457 | surfaces | 5 | 6 |
| on004473 | surfaces | 6 | 7 |
| on004551 | labels | 114 | 124 |
| on004696 | surfaces | 8 | 8 |
| on004774 | surfaces | 5 | 5 |
| on004993 | surfaces | 3 | 3 |
| on005007 | labels | 40 | 42 |
| on005415 | surfaces | 10 | 10 |
| on005545 | labels | 106 | 336 |
| on005931 | labels | 8 | 16 |
| on005953 | surfaces | 1 | 1 |
| on006107 | labels | 165 | 166 |
| on006233 | labels | 108 | 347 |
| on006910 | labels | 121 | 384 |
| on006914 | labels | 110 | 353 |
- labels: 9 datasets, 779 subjects
- freesurfer: 3 datasets, 20 subjects
- spm: 1 datasets, 4 subjects
- surfaces: 10 datasets, 70 subjects
- datasets gaining dataset files (labels, freesurfer or spm): 13: on002799, on003848, on004194, on004370, on004457, on004551, on005007, on005545, on005931, on006107, on006233, on006910, on006914

## Release path of the datasets gaining dataset files

- mirrors (`on`, one N.0.1 each): on002799, on003848, on004194, on004370, on004457, on004551, on005007, on005545, on005931, on006107, on006233, on006910, on006914
- pushed to NEMAR (`nm`, a pull request each): none

## Label medians (judged against the 1.0 mm on-vertex rule)

| dataset | files | median of medians (mm) | largest (mm) | above 0.85 | above 1.0 |
| --- | --- | --- | --- | --- | --- |
| on004370 | 7 | 0.655 | 0.765 | 0 | 0 |
| on004551 | 124 | 0.666 | 0.828 | 0 | 0 |
| on005007 | 42 | 0.677 | 0.840 | 0 | 0 |
| on005545 | 336 | 0.665 | 0.844 | 0 | 0 |
| on005931 | 16 | 0.664 | 0.738 | 0 | 0 |
| on006107 | 166 | 0.674 | 0.875 | 1 | 0 |
| on006233 | 347 | 0.669 | 0.844 | 0 | 0 |
| on006910 | 384 | 0.667 | 0.844 | 0 | 0 |
| on006914 | 353 | 0.669 | 0.844 | 0 | 0 |

## Needs-human files per dataset

| dataset | files |
| --- | --- |
| nm000352 | 19 |
| nm000357 | 29 |
| nm000358 | 55 |
| nm000367 | 13 |
| nm000368 | 37 |
| nm000435 | 12 |
| on004752 | 68 |

Total needs-human files: 233 in 7 datasets.

## Refusal and needs-human reasons (files, normalized)

### freesurfer, refused

| files | reason |
| --- | --- |
| 1041 | coordsystem-missing: no coordsystem.json beside sub-X_ses-Y_electrodes.tsv |
| 741 | units-unsupported: iEEGCoordinateUnits 'n/a' is not one of m, cm, mm |
| 68 | coordsystem-missing: no coordsystem.json beside sub-X_ses-Y_task-verbalWM_run-N_electrodes.tsv |
| 34 | too-few-cortical-contacts: N cortical contacts with x, y, z (need N) |
| 15 | subject-dir-ambiguous: derivatives/freesurferNT/sub-X, derivatives/freesurferNT/sub-X |
| 8 | frame-not-found: neither frame fits the subject surface: declared median N mm (fail), c_ras subtracted N mm (fail), pref |
| 5 | frame-ambiguous: declared median N mm (specific), c_ras subtracted N mm (specific), preferred ambiguous |
| 3 | no-contacts-placed: left out: N depth or unknown-type contacts (affine template positions are too inaccurate to commit); |
| 2 | no-contacts-placed: left out: N cortical contacts on a hemisphere without sphere.reg |
| 1 | coordsystem-unreadable: sub-X_ses-Y_space-postimplant_coordsystem.json: Expecting property name enclosed in double quote |
| 1 | frame-ambiguous: declared median N mm (fail), c_ras subtracted N mm (specific), preferred ambiguous |
| 1 | registration-check-failed: N subject pial vertices mapped through sphere.reg: N% on the correct hemisphere side, centroi |
| 1 | subject-dir-ambiguous: derivatives/freesurfer/sub-X/ses-Y/sub-X_ses-Y_TNw, derivatives/freesurfer/sub-X/ses-Y/sub-X_ses- |
| 1 | coordsystem-missing: no coordsystem.json beside sub-X_electrodes.tsv |
| 1 | no-contacts-placed: left out: N contacts without x, y, z; N depth or unknown-type contacts (affine template positions ar |
| 1 | coordsystem-missing: no coordsystem.json beside sub-X_space-mni_electrodes.tsv |

### labels, needs-human

| files | reason |
| --- | --- |
| 233 | MNI variant unknown, needs a human label |

### labels, refused

| files | reason |
| --- | --- |
| 344 | no candidate verified |
| 1 | no template named and fewer than N contacts for a blind trial |

## Threshold margins

- freesurfer frame_fit_median_mm: 25 values, limit 2.0, closest 1.957 (on002799 sub-307/ses-postop/ieeg/sub-307_ses-postop_space-MNI152NLin6Asym_electrodes.tsv, margin 2.1%)
- freesurfer registration_affine_residual_mm: 25 values, limit 15.0, closest 8.361 (on002799 sub-303/ses-postop/ieeg/sub-303_ses-postop_space-MNI152NLin6Asym_electrodes.tsv, margin 44.3%)
- labels median_mm: 1775 values, limit 1.0, closest 0.875 (on006107 sub-145/ses-01/ieeg/sub-145_ses-01_electrodes.tsv, margin 12.5%)
- spm field_check_median_mm: 4 values, limit 6.0, closest 5.332 (on004457 sub-4/ses-ieeg01/ieeg/sub-4_ses-ieeg01_electrodes.tsv, margin 11.1%)
- spm field_check_p10_mm: 4 values, limit 2.0, closest 1.489 (on004457 sub-4/ses-ieeg01/ieeg/sub-4_ses-ieeg01_electrodes.tsv, margin 25.5%)
- spm inside_fraction: 4 values, limit 0.95, closest 0.966 (on004457 sub-1/ses-ieeg01/ieeg/sub-1_ses-ieeg01_electrodes.tsv, margin 32.0%)
- surfaces median_mm: 77 values, limit 2.0, closest 1.958 (on002799 sub-307/ses-postop/ieeg/sub-307_ses-postop_space-MNI152NLin6Asym_electrodes.tsv, margin 2.1%)
- surfaces median_shift_mm: 77 values, limit 0.5, closest 0.312 (on002799 sub-413/ses-postop/ieeg/sub-413_ses-postop_space-MNI152NLin6Asym_electrodes.tsv, margin 37.6%)
- surfaces near_or_inside_fraction: 43 values, limit 0.9, closest 0.933 (on004473 sub-12/ieeg/sub-12_space-ACPC_electrodes.tsv, margin 33.0%)
- surfaces p99_deviation_mm: 77 values, limit 1.0, closest 0.106 (on003848 sub-RESP0699/ses-1/ieeg/sub-RESP0699_ses-1_electrodes.tsv, margin 89.4%)

Written values within 15% of a threshold: 14

| dataset | file | track | number | value | limit | margin |
| --- | --- | --- | --- | --- | --- | --- |
| on002799 | sub-307/ses-postop/ieeg/sub-307_ses-postop_space-MNI152NLin6Asym_electrodes.tsv | surfaces | median_mm | 1.958 | 2.0 | 2.1% |
| on002799 | sub-307/ses-postop/ieeg/sub-307_ses-postop_space-MNI152NLin6Asym_electrodes.tsv | freesurfer | frame_fit_median_mm | 1.957 | 2.0 | 2.1% |
| on004194 | sub-p08/ses-nyuecog01/ieeg/sub-p08_ses-nyuecog01_acq-clinical_electrodes.tsv | surfaces | median_mm | 1.91 | 2.0 | 4.5% |
| on002799 | sub-331/ses-postop/ieeg/sub-331_ses-postop_space-MNI152NLin6Asym_electrodes.tsv | surfaces | median_mm | 1.897 | 2.0 | 5.1% |
| on004194 | sub-p08/ses-nyuecog01/ieeg/sub-p08_ses-nyuecog01_acq-clinical_electrodes.tsv | freesurfer | frame_fit_median_mm | 1.826 | 2.0 | 8.7% |
| on002799 | sub-330/ses-postop/ieeg/sub-330_ses-postop_space-MNI152NLin6Asym_electrodes.tsv | freesurfer | frame_fit_median_mm | 1.818 | 2.0 | 9.1% |
| on002799 | sub-330/ses-postop/ieeg/sub-330_ses-postop_space-MNI152NLin6Asym_electrodes.tsv | surfaces | median_mm | 1.815 | 2.0 | 9.3% |
| on002799 | sub-405/ses-postop/ieeg/sub-405_ses-postop_space-MNI152NLin6Asym_electrodes.tsv | freesurfer | frame_fit_median_mm | 1.81 | 2.0 | 9.5% |
| on003848 | sub-RESP0699/ses-1/ieeg/sub-RESP0699_ses-1_electrodes.tsv | surfaces | median_mm | 1.796 | 2.0 | 10.2% |
| on002799 | sub-405/ses-postop/ieeg/sub-405_ses-postop_space-MNI152NLin6Asym_electrodes.tsv | surfaces | median_mm | 1.778 | 2.0 | 11.1% |
| on004457 | sub-4/ses-ieeg01/ieeg/sub-4_ses-ieeg01_electrodes.tsv | spm | field_check_median_mm | 5.332 | 6.0 | 11.1% |
| on006107 | sub-145/ses-01/ieeg/sub-145_ses-01_electrodes.tsv | labels | median_mm | 0.875 | 1.0 | 12.5% |
| on004194 | sub-p09/ses-nyuecog01/ieeg/sub-p09_ses-nyuecog01_acq-clinical_electrodes.tsv | surfaces | median_mm | 1.703 | 2.0 | 14.8% |
| on004194 | sub-p09/ses-nyuecog02/ieeg/sub-p09_ses-nyuecog02_acq-clinical_electrodes.tsv | surfaces | median_mm | 1.703 | 2.0 | 14.8% |
