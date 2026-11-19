# Label-inference fixtures

Whole electrodes, coordsystem and channels files of one subject (or session) each, copied unchanged from public NEMAR mirrors of OpenNeuro datasets whose `dataset_description.json` declares `"License": "CC0"`.
Fetched 2026-11-19 from `https://raw.githubusercontent.com/nemarDatasets/<id>/HEAD/<path>`.
Each `README.md` here is one sentence of the dataset's own README, which is what the label inference reads.

| Directory | Source file path | What it exercises | Measured against vendored fsaverage6 |
| --- | --- | --- | --- |
| `on006107/` | `sub-01/ses-01/ieeg/` (electrodes, channels); no coordsystem exists; the dataset README does not name a template | missing sidecar, blind trial | median 0.73 mm, 116 contacts, 10 mm shifts fail |
| `on006910/` | `sub-001/ses-1/ieeg/` (electrodes, coordsystem, channels); the sidecar says `Other`, "patient-native RAS"; README says "MNI-305" with U+2011 hyphens | wrong sidecar, `space-fsaverage` pair, prose with a non-breaking hyphen | median 0.75 mm, 94 ECoG contacts |
| `on004551/` | `sub-001/ses-01/ieeg/` (electrodes, channels); no coordsystem; README says "MNI305" | missing sidecar, template named in the README | median 0.75 mm, 94 ECoG contacts |
| `on005007/` | `sub-01/ses-01/ieeg/` (electrodes, channels); no coordsystem; the README does not name a template | missing sidecar; ECoG grid that stays within 2 mm of fsaverage6 when slid (ruling 16); the reviewer's README-names-MNI152 probe | median 0.7 mm, 64 ECoG contacts |

A scan of the first subjects of the nine verified track-C datasets (on006107, on006910, on004551, on006914, on006233, on005545, on005007, on005931, on004370; 39 electrodes files) gave a fsaverage6 median of 0.60 to 0.81 mm and grade `specific` for every file, so the 1.0 mm blind rule holds for all of them.
The tests that need other frames (MNI152 variants, meters, interior depth contacts) build their points in the test from the vendored MNI152NLin2009cAsym vertices.

`tests/test_labels_network.py` (marker `network`) downloads every electrodes file of on005007 (42) and on004370 (7) into the cache and checks that each is accepted as `fsaverage`.
