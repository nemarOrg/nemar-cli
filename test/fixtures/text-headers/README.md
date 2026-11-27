# Text-header fixtures (BrainVision and NIRx)

Real header files for the BrainVision and NIRx readers
(`shared/readers/brainvision.ts`, `shared/readers/nirx.ts`; epic #2182, phase A2).
These are header files only, never signal data.
The bytes are kept unchanged (`-text` in `.gitattributes`): one `.inf` has CRLF line endings,
and one BrainVision header is Latin-1.

## BrainVision (`brainvision/`)

From MNE-Python, `mne/io/brainvision/tests/data/`, at commit `c128077643f9` (fetched 2026-11-25).
License: BSD-3-Clause (the MNE-Python license).

| File | What it is used for |
|---|---|
| `test.vhdr` | A clean Vision Recorder header with a full `[Comment]` amplifier setup: no finding |
| `test.vmrk` | A `New Segment` marker with a timestamp: `brainvision-segment-date` |
| `test_old_layout_latin1_software_filter.vhdr` | An older layout with no `Codepage` line (its bytes are ASCII): clean |
| `test_old_layout_latin1_software_filter.vmrk` | Two dated `New Segment` markers: one finding per file |
| `testv2.vhdr` | Names `DataFile=test.eeg`, not its own base name: the note `companion-name-mismatch` on a complete read |
| `testv2.vmrk` | A `New Segment` marker without a timestamp: no finding (it names `test.eeg` too) |

## NIRx (`nirx/`)

From the MNE testing data (`mne-tools/mne-testing-data`, directory `NIRx/`), at commit `20cc221d737a` (fetched 2026-11-25).
License: BSD-3-Clause, the license of the MNE project whose testing-data repository this is
(the lead's ruling of 2026-11-25 on the A2 pull request; the repository itself carries no separate license file).

| File | Source path | What it is used for |
|---|---|---|
| `NIRS-2019-10-02_003.hdr` | `nirscout/nirx_15_2_recording/` | NIRStar header: `nirx-header-date`; `FileName` matches its base name |
| `NIRS-2019-10-02_003.inf` | `nirscout/nirx_15_2_recording/` | An `Age=` that is filled in: no finding (an age alone is nothing); its `Name=` is a test label, not a name |
| `NIRS-2020-12-02_018.inf` | `nirsport_v1/nirx_15_3_recording_wo_saturation/` | A clean `.inf` (a test label, `Age=0`): no finding |
| `2025-10-29_002_config.hdr` | `nirsport_v2/aurora_2025_2/` | A NIRSport2 header: the date only (its experiment notes hold an age and an experiment name, neither a finding) |

## Analyze (`analyze/`)

`analyze.hdr` is `nibabel/tests/data/analyze.hdr` from NiBabel (`nipy/nibabel`) at commit `db81c605e9c5` (fetched 2026-11-25),
a 348-byte Analyze 7.5 image header.
License: MIT (NiBabel's `COPYING`; the file is not among the test files it lists under other licenses).
It is the `.hdr` that is not NIRx: the NIRx reader must call it `not-applicable`.

## Edited fixtures

Two files are edited copies, each changed in one field only, to hold a made-up name
(`Quintavius Hollberry`, invented for these tests; it names nobody):

- `brainvision/edited-comment-name.vhdr` is `test.vhdr` with one line,
  `Subject: Quintavius Hollberry`, and a blank line added at the top of `[Comment]`.
  It must give `brainvision-comment-name`.
- `nirx/edited-name.inf` is `NIRS-2020-12-02_018.inf` with `Name="No_saturation"`
  replaced by `Name="Quintavius Hollberry"`.
  It must give `nirx-subject-name`.

Other edits a test needs (an absolute `DataFile`, a missing companion) are made in memory, from these files, inside the test.

## SHA-256

```
e4f069fda1f7309160cc74ca76836c394723f152a62574ff8ef79c336539a331  analyze/analyze.hdr
b719d106612d78a913ebec53244845857df1e80cf135f16223ea739fb83b35c2  brainvision/edited-comment-name.vhdr
3543c87998599ffa49c4eb32bcfa1666904464ab756c023b9b168f87eda4b153  brainvision/test_old_layout_latin1_software_filter.vhdr
65e3a8eaf6c5efe041aa0b88534b17cd1c61498b21af5065cfd999cdf0888d0c  brainvision/test_old_layout_latin1_software_filter.vmrk
5ab4716f7a5894c789c627338dd2f01ed1e81a43d847eda3511438b4e2f02345  brainvision/test.vhdr
009d3c61d422f1c69677b7eca0d2856f2b9ee096a4e2c4fdabbfeb50571902c2  brainvision/test.vmrk
8a289ba050c6d45e09038d209c6838b277a032a9e440a824325c2c582f3e6f0b  brainvision/testv2.vhdr
11e342dd468b6f9e83933cdaf4360d992454d882075d951d2dfbdb08aaf33936  brainvision/testv2.vmrk
2b6ac487ca8d9d1c0c619a53592d6138c0f4e1a4908bf6c97be264953f8db9cb  nirx/2025-10-29_002_config.hdr
78fc8c30026d889f31087ab303cf83aea789998b5667353802394c47dd76c0a1  nirx/edited-name.inf
ed8e8e242d65e7c0555f441075d8137269df7e7bb4d2866f790fd75b39fa0aae  nirx/NIRS-2019-10-02_003.hdr
02032891f0a17ca275a417287737785c1b84e28c1fdeefd44e878eb9c6c62c4a  nirx/NIRS-2019-10-02_003.inf
8e74a436e8a73c77f65aa1458b1495143c38645ffa949983ce42c95e7dfd7359  nirx/NIRS-2020-12-02_018.inf
```
