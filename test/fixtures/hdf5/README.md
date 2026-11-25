# HDF5 fixtures for the metadata walker

These files test `shared/hdf5-meta.ts` (`test/hdf5-meta.test.ts`).
Each has the entry list h5py printed for it beside it, `<file>.oracle.json`.
Regenerate an oracle file, or the synthetic files, with:

```sh
uv run --with 'h5py==3.16.0' python scripts/dev/hdf5-oracle.py test/fixtures/hdf5/<file> > test/fixtures/hdf5/<file>.oracle.json
uv run --with 'h5py==3.16.0' python scripts/dev/hdf5-oracle.py --generate test/fixtures/hdf5
```

The committed oracle files were printed by h5py 3.16.0.
CI does not run Python; the tests read the committed JSON.

The seven HDF5 files total 6,132,934 bytes (under 6 MiB).
They are committed as plain git blobs, not git-annex pointers (`git -c annex.largefiles=nothing add`).

## Real recordings

| File | Bytes | Source | License | Writer |
|---|---|---|---|---|
| `snirf-samples-simple-probe.snirf` | 149,362 | [fNIRS/snirf-samples](https://github.com/fNIRS/snirf-samples) `basic/Simple_Probe.snirf`, commit `4911dcfd77ab326df7b67a08a54fe164f8c510e1` | Public domain (the repository's `LICENSE.md`: "The sample data files are in the public domain") | EasyH5 and JSNIRFY (MATLAB), from the Homer "Simple_Probe" sample recording |
| `homer3-neuro-run02.snirf` | 1,681,626 | [BUNPC/Homer3](https://github.com/BUNPC/Homer3) `DataTree/Examples/Example4_twNI/s1/neuro_run02.snirf`, commit `67b7c9fdef1bc6a0fc19e7489d7214034a1b5244` | BSD 2-Clause (the repository's `LICENSE.txt`, copyright 2015 David Boas, Jay Dubb, Ted Huppert) | Homer3 export (MATLAB); its groups track link creation order, so `/nirs/data1` uses dense links |
| `eeglab-data-v73.set` | 4,246,081 | [sccn/eegprep](https://github.com/sccn/eegprep) `sample_data/eeglab_data_hdf5.set`, commit `2b080ee0d4c6ba21ea05b1e9ab588a59853e2b3a`, git blob `49c449e0381c78b4910467450a5a91b659e7bf61` | BSD 2-Clause (the repository's `LICENSE`, copyright 2025 Swartz Center for Computational Neuroscience) | MATLAB `save -v7.3` of the EEGLAB tutorial dataset: 512-byte user block, superblock 0, 1,548 datasets, object references, `MATLAB_fields` |

SHA-256:

- `snirf-samples-simple-probe.snirf`: `4673f295c2acba2f85beb80fcf9a1e5498a92c02b4c7d10b110c0331d30149db`
- `homer3-neuro-run02.snirf`: `39bdfee8b211e5282111e0aaae5ce36755d1090c76696d76f3cb8a5031de282e`
- `eeglab-data-v73.set`: `a90c84a89e6f40e2231b0f5f4c6ee99b671c513dccdaee5b06c8dd54f1de12c6`

## Written by h5py

The format of these files is real (h5py 3.16.0 and its libhdf5 wrote them); their content is not a recording.
`scripts/dev/hdf5-oracle.py --generate` writes them.

| File | Bytes | What it exercises |
|---|---|---|
| `dense-latest.h5` | 14,638 | `libver="latest"`: superblock 3, object header 2, a group of 12 members and an object with more than 8 attributes (dense links and dense attributes: fractal heap and version 2 B-tree), datatype version 5, compact layout, fixed and variable-length strings, an array of strings, big-endian integers, an enum, a soft link, a null dataspace |
| `chunked-strings.h5` | 29,248 | Default format bounds: chunked, deflate-compressed variable-length and fixed-length string datasets, a shuffled and deflated integer dataset, strings over the 64 KiB and 4,096-element rules, four numbers in one 1.6 MB chunk (over the 1 MiB chunk cap), an external link |
| `unsupported-type.h5` | 2,102 | A compound (complex) dataset: listed, not read, recorded as `unsupported-datatype` |
| `unsupported-filter.h5` | 5,816 | A Fletcher-32 filtered dataset: listed, not read, recorded as `unsupported-filter`; h5py reads its value, which is the one expected difference |

SHA-256:

- `dense-latest.h5`: `de8be52a3db52fdab70d3ae84cf6c4432e328137da7ad5d98e40415e6f69b485`
- `chunked-strings.h5`: `affe1620786f66c3199311428e21eaf808e00a6681bc0550e1cc1af209ce9e98`
- `unsupported-type.h5`: `36e7f23cf283c8c3c25540dff3659264b9d5c634bccac11fe3d39e6804adf1fc`
- `unsupported-filter.h5`: `d0a8b8b9a9f3e01d408f0367046179db80783fff38f9a286464792e98e468bd6`

Regenerating the synthetic files is not byte-stable (`dense-latest.h5` changed between two runs of the same h5py); regenerate their oracle files and the hashes above in the same change.
