# MATLAB fixtures (card A5)

These files test the MAT-file Level 5 walker (`shared/mat-meta.ts`, `test/mat-meta.test.ts`) and the EEGLAB, Homer2 and generic MATLAB readers (`test/readers-eeglab.test.ts`, `test/readers-homer-nirs.test.ts`, `test/readers-mat-generic.test.ts`).
Each has beside it what scipy (Level 5) or h5py (v7.3) reads from it, `<file>.oracle.json`, printed by:

```sh
uv run --with 'scipy==1.18.1' --with 'h5py==3.16.0' python scripts/dev/mat-oracle.py test/fixtures/mat/<file> > test/fixtures/mat/<file>.oracle.json
```

CI does not run Python; the tests read the committed JSON.
The files are committed as plain git blobs, not git-annex pointers (`git -c annex.largefiles=nothing add`).
The v7.3 `.set` file the tests also read is A3's `test/fixtures/hdf5/eeglab-data-v73.set` (its README records it).

## Real files

| File | Bytes | Source | License | What it is |
|---|---|---|---|---|
| `eeglab-data.set` | 352,624 | [sccn/eegprep](https://github.com/sccn/eegprep) `sample_data/eeglab_data.set`, commit `2b080ee0d4c6ba21ea05b1e9ab588a59853e2b3a`, git blob `a97c0c599efb5d3537577ab3121b165cc97b60f0` | BSD 2-Clause (the repository's `LICENSE`, copyright 2025 Swartz Center for Computational Neuroscience) | The EEGLAB tutorial dataset, classic MAT-file (`-v6`, one `EEG` variable, uncompressed), its signal in `eeglab_data.fdt` (not committed: the reader never reads it, and the tests name it in the path list) |
| `sub-001_task-Rest_eeg.set` | 2,332,352 | OpenNeuro [ds003800](https://openneuro.org/datasets/ds003800) `sub-001/eeg/sub-001_task-Rest_eeg.set` (anonymous S3) | CC0 (the dataset's `dataset_description.json`) | Classic `.set` with its signal inside (19 x 15,000 doubles, 2.28 MB, uncompressed, one `EEG` variable) |
| `homer2-simple-probe.nirs` | 82,004 | [BUNPC/Homer3](https://github.com/BUNPC/Homer3) `DataTree/AcquiredData/Snirf/Examples/Simple_Probe.nirs`, commit `67b7c9fdef1bc6a0fc19e7489d7214034a1b5244`, git blob `0bd96b0d63c289a88d3d3c57e2634504caa4793a` | BSD 2-Clause (the repository's `LICENSE.txt`, copyright 2015 David Boas, Jay Dubb, Ted Huppert) | Homer2 `.nirs`: `SD`, `t`, `d`, `s` and `aux`, each a compressed variable (`-v7`) |
| `oddball-onoff.mat` | 386 | OpenNeuro [ds003490](https://openneuro.org/datasets/ds003490) `code/ONOFF_4Oddball.mat` (anonymous S3) | CC0 (the dataset's `dataset_description.json`) | A generic `.mat`: a 50 x 3 matrix and a cell of three column names, both compressed |

SHA-256:

- `eeglab-data.set`: `27594dc378685d25d5f5f762f4f8332e7a3d988b6d5d41832bb2252d93988718`
- `sub-001_task-Rest_eeg.set`: `bc2bc736a4590335147ac90d969bb7a3477049ac6be4f6fce5bfb858d634d945`
- `homer2-simple-probe.nirs`: `009b4529372243782d8b9c027449f80ffc1698564716f9c13e21db181b6c78ca`
- `oddball-onoff.mat`: `e21cd9fb8024d3867c901bddd9faa25875f6dd6741c2b17c29d0b6c7cbe666c0`

## Edited copies

`scripts/dev/mat-fixtures.py` writes these from the real files (the command is in its docstring).
Every value written is made up (`Quillfeather Marlow`, `/Users/qmarlow/studies/rest/`); no real person is named.

| File | Bytes | Edit |
|---|---|---|
| `eeglab-data-edited.set` | 346,040 | `eeglab-data.set` loaded by scipy 1.18.1, `EEG.subject` set to a made-up name and `EEG.filepath` to a made-up home-directory path, saved again by scipy (`format="5"`, uncompressed). scipy rewrites the file, so its layout differs from MATLAB's (one `EEG` variable still) |
| `eeglab-data-v73-edited.set` | 4,246,175 | A copy of `test/fixtures/hdf5/eeglab-data-v73.set` with `/EEG/subject` and `/EEG/filepath` replaced by h5py 3.16.0 with MATLAB character arrays (`uint16`, `MATLAB_class` `char`, `MATLAB_int_decode` 2) holding the same made-up values; the 512-byte user block is kept |

The subject fires `eeglab-subject-name` in both; the home-directory path in `filepath` fires nothing (lead ruling: location fields are not scanned).

SHA-256 (regenerating is not byte-stable across library versions; update these with the files):

- `eeglab-data-edited.set`: `33da27724d9883666defbaf76f9d5733c3c0c58772bd0729fe9ef641bc61f7e3`
- `eeglab-data-v73-edited.set`: `165f872f8a3a35d59e90210beac4faa11913e6b2fe4a9d6f16fcec4828fae5db`

## Oracle notes

- scipy reads with `mat_dtype=True`, so a class is MATLAB's (`double`), not its storage type (`uint8`).
- scipy reads an empty element (a struct field or cell member of zero bytes) as a 1 x 0 double, where the walker lists nothing; the tests compare numeric arrays only when they hold a value.
- The v7.3 oracle lists every MATLAB character array with its rows; the tests compare the ones under the 64 KiB string rule.

## Data before metadata

None of these files needs its signal inflated to reach the metadata after it.
The two classic `.set` files are uncompressed, so the signal is skipped by its declared size; the Homer2 file's signals are top-level compressed variables, left after their first bytes.
In the false-positive gate's sample (card A5 PR), no public `.set` file was compressed with its signal inside one variable.
