# Fixture provenance

All data are cut from public CC0 datasets (NEMAR mirrors of OpenNeuro datasets).
`tools/make_fixtures.py` rebuilds `mini_dataset/` from the downloads listed here.

| Fixture | Source | Cut |
| --- | --- | --- |
| `sub-1/ieeg/*space-ACPC*`, `*space-ScanRAS*` | `on004473` v1.0.0, `sub-1/ieeg/` (`raw.githubusercontent.com/nemarDatasets/on004473/HEAD/...`), units in meters | none |
| `derivatives/freesurfer-7.3.2/sub-1/surf/{lh,rh}.pial` | `on004473` v1.0.0, `data.nemar.org/on004473/v1.0.0/derivatives/freesurfer-7.3.2/sub-1/surf/`, with the `volume info` footer (c_ras) | vertices within (nearest-vertex distance + 2 mm) of any contact |
| `sub-2/ses-ieeg01/ieeg/*` | `on004457` v1.0.0, `sub-2/ses-ieeg01/ieeg/` (native and `space-ACPC` electrodes, coordsystem, `task-ccep_run-01_channels.tsv`) | none |
| `derivatives/freesurfer/sub-2/pial.R.surf.gii` | `on004457` v1.0.0, `data.nemar.org/on004457/v1.0.0/derivatives/freesurfer/sub-2/pial.R.surf.gii` (Base64Binary, ColumnMajorOrder) | same cut; rewritten column-major |

Because the cut keeps each contact's true nearest vertex, nearest-vertex fits on the fixtures equal the fits on the full surfaces (on004457 sub-2: native 2.68 mm, `space-ACPC` 9.89 mm median).
The cut surfaces are open meshes, so the inside-the-brain criterion is not evaluated on them.
