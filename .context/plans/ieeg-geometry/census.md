# iEEG geometry census (2026-11-19)

Read-only census of the 167 public iEEG datasets, run from the website's coordinate-frame classification (`nemarOrg/website` `.context/research-ieeg-coordsystem-classification.json`).
The per-dataset table is `census.csv` beside this file: frames, units, subjects, subjects with electrodes, subjects with a surface (and with both hemispheres), GIfTI, FreeSurfer and MATLAB surface counts, `talairach.xfm` and SPM `y_` counts, and template electrode files under `derivatives/`.

## Method

- File trees from `gh api repos/nemarDatasets/<id>/git/trees/HEAD?recursive=1` (167 calls).
- Contents from `https://data.nemar.org/<id>/<version>/<path>` with HTTP Range requests (annexed content; raw GitHub returns only the annex pointer).
- Frame evidence: the median distance from each contact to the nearest surface vertex, as declared and with FreeSurfer's c_ras added.
  A correct frame gives about 1 mm for surface-projected ECoG and 2 to 3 mm for sEEG depth contacts.
- FreeSurfer c_ras is read from the `volume info` block at the end of `surf/?h.pial` (a suffix Range read of about 8 KB).
- fsaverage reference: `on004370`'s own `derivatives/freesurfer/{lh,rh}.pial` (header "created by greve 2013").

## Results

| Finding | Datasets | Subjects |
| --- | --- | --- |
| Contacts exactly on fsaverage (median 0.0 mm, 3 sampled subjects each), coordsystem missing or says native | on006107, on006910, on004551, on006914, on006233, on005545, on005007, on005931, on004370 | about 780, with patients repeated across datasets |
| `Other` frames whose prose names MNI (not yet verified) | 16 | 213 |
| Shipped template transforms: FreeSurfer `talairach.xfm` | on003848, on004194, on004473, on005415 | 41 |
| Shipped template transforms: SPM `y_` (MNI-to-native grid, needs inversion) | on004457 | 4 of 5 |
| Subject surfaces in the contacts' frame as declared | 8 | 47 |
| Subject surfaces needing the c_ras offset (verified / probable) | 3 / 2 | 9 / 21 |
| Template electrodes under `derivatives/` with no sidecar | on004696 (`space-MNI152NLin6Sym`) | 8 |

## Pitfalls seen

- GIfTI vertex arrays stored column-major, with `DataSpace` `NIFTI_XFORM_UNKNOWN` and an identity transform (on004457, on004696).
- One hemisphere per subject (on004457, on005953).
- Electrode units in meters (on004473, on005415).
- on004457's `space-ACPC` electrodes for sub-2 and sub-4 do not match the shipped surfaces (median 9.9 and 15.4 mm); the native files do.
- Surfaces outside `derivatives/` (nm000369, under `sourcedata/`).
- Five native datasets ship a T1 but no surface (on003688, on005169, on006519, on004977, nm000372); out of scope (would need FreeSurfer runs).
