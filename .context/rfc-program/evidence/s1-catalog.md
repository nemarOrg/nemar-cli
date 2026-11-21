# S1: the back catalog that the version 3 rollout touches, measured read-only

Measured 2026-11-20 and 2026-11-21 against the public endpoints only (`api.nemar.org`, `data.nemar.org`, `zarr.nemar.org`, the public bucket `nemar.s3.us-east-2.amazonaws.com`, and GitHub tree listings through `gh api`).
No write was made outside this worktree and `/Users/yahya/.cache/nemar-s1-scan/`; no `aws` call was made; no live dataset or re-pull switch was touched.
At most 8 requests were in flight at once (4 for the long BrainVision and Flexible Image Transport System-style (FIF) runs); the User-Agent was `nemar-s1-scan/0.1`.
Abbreviations, defined once: European Data Format (EDF); BioSemi Data Format (BDF); time-stamped annotation list (TAL); Application Programming Interface (API); megabyte (MB); gigabyte (GB).
FIF is the Neuromag and Elekta file format that MNE-Python reads and writes.

All raw outputs are beside this file in `evidence/s1/`.
Every number below is copied from the named file or computed from it; "computed" marks an arithmetic result with its inputs shown.
The Python scripts are in `evidence/s1/`: `scan.py` (the earlier scan, as run), `s1scan.py` (the new stages), `derive.py` and `union.py` (derived tables, no network).
The working cache (about 56 MB, plus the intermediate listing) stays in `/Users/yahya/.cache/nemar-s1-scan/` and is not committed.

## 0. Method, and what was resumed

The earlier scan (session remi:18769) had finished before this card started, so nothing was rerun that it had already measured.
`Command:` and `Raw output:` lines for step 0:

Command: `ps -p 99119; pgrep -fl scan.py; stat cache.json; shasum -a 256 cache.json` (output transcribed by hand into `step0.txt`)
Raw output: .context/rfc-program/evidence/s1/step0.txt

The cache's SHA-256 at copy time is `c21c5ce0a46fe17572bc02cfd5621c8d122d5737b880028d58904068d3d9fd11` (56,371,069 bytes), identical to the original.
The original scan directory under `/private/tmp/...` was gone by 2026-11-21; the copy under `/Users/yahya/.cache/nemar-s1-scan/` remains.

Changes to `scan.py`, stated as the card requires: `scan.py.diff-vs-pack` is the diff between the pack's copy (`research/edfd-scan/scan.py`, method only) and the script as run.
The changes are four fixes made by remi:18769 during the deep pass: a TAL onset written `+-0.001` is read as `-0.001`; NUL padding is stripped from the header numbers; a file whose header claims more records than it holds is flagged `file_short`; and `size_matches` is false for such a file.
The new stages are in `s1scan.py`, which copies the request helper and the `Reader` class from `scan.py` and changes three things: the abort streak counts a request that failed after all its retries, not each retry (the earlier rule aborted a run on one bad object, see section 3); a data-plane retry after a bucket 403 or 404 does not count toward the streak; and the direct bucket URL is also derived for `md5` annexed keys (`MD5E-...`, checked on `on001810`).

## 1. The header pass is finished: zero failures

The cache already held every header.
Retrying the entries whose record is not `ok` read nothing, because none remained.

Command: `cd SCAN_COPY; uv run --no-project --with httpx python -I scan.py heads; ... scan.py deep; ... scan.py tally` (run on a copy of the cache)
Raw output: .context/rfc-program/evidence/s1/scan-resume-noop.txt

| Measure | Value | Source |
| --- | --- | --- |
| Datasets in the public catalog | 910 | `heads-tally.json` |
| Datasets listed (`latest_version` present) | 909 (`on005691` has none) | `heads-tally.json` |
| Datasets that hold EDF or BDF | 359 | `heads-tally.json` |
| EDF and BDF files, headers read | 141,747 (75,407 `.edf`, 66,340 `.bdf`), 0 failed | `heads-tally.json` |
| EDF+C / BDF+C | 53,585 / 55,015 | `heads-tally.json` |
| EDF+D / BDF+D | 1,728 / 0 | `heads-tally.json` |
| EDF+ without C or D | 76 (all `on009081`) | `heads-tally.json` |
| Plain EDF / plain BDF | 20,017 / 11,325 | `heads-tally.json` |
| Too small to hold a header | 1 | `heads-tally.json` |

Command: `uv run --no-project python -I derive.py scan` (reads the cache copy)
Raw output: .context/rfc-program/evidence/s1/heads-tally.json

Persistent header failures: none (`heads-failures.json`: `headers_failed` 0; the only failed manifest is the dataset with no version, `on005691`).
The 7,007 failures relayed at checkpoint C1 were retried by remi:18769 in its fourth header run (`scan-logs/heads4.log`, last line `failed: 0`); the 5xx responses in that run were retried and succeeded.

Raw output for the failures: .context/rfc-program/evidence/s1/heads-failures.json

The data-plane listing is for the latest version of each dataset: 899 manifests came from `manifest.json` and 10 from GitHub trees (the 10 datasets whose manifest is too large).

## 2. The EDF+D deep pass: real gaps, and where they are

The deep pass was the one remi:18769 ran.
Whole-file reads (files up to 12 MB) fetched 0.414 GB (56 files, computed in `deep-summary.json`), far under the 20 GB stop limit; the other 1,672 files (456.3 GB of file size, never downloaded) were read by Range bisection.
All 1,728 files were analyzed; none has unparsed onsets; no bisection stopped at its read limit.

Command: `uv run --no-project python -I derive.py scan`
Raw output: .context/rfc-program/evidence/s1/deep-summary.json
Raw output (per file): .context/rfc-program/evidence/s1/deep-edfd-files.json

| Dataset | License | EDF+D files | Files with `gap_count` above 0 | Gaps | Gap seconds | Other findings |
| --- | --- | --- | --- | --- | --- | --- |
| nm000456 | CC-BY-NC-SA-4.0 | 102 | 102 | 390 | 118,929.5 | 51 recordings, each present twice (raw tree and `sourcedata`); 195 gaps and 59,464.75 s per recording |
| on006910 | CC0 | 384 | 0 | 0 | 0 | none |
| on006914 | CC0 | 353 | 0 | 0 | 0 | 171 files with a first onset of `-0.001` |
| on006233 | CC0 | 347 | 0 | 0 | 0 | 171 files with a first onset of `-0.001` |
| on005545 | CC0 | 336 | 0 | 0 | 0 | none |
| on004551 | CC0 | 125 | 0 | 0 | 0 | 3 files truncated (header claims more records than present), 4 with a negative first onset |
| on005007 | CC0 | 42 | 0 | 0 | 0 | none |
| on005931 | CC0 | 16 | 0 | 0 | 0 | none |
| nm000411 | CC-BY-4.0 | 14 | 0 | 0 | 0 | no zarr index (HTTP 404; `zarr_status` is `failed`) |
| on003876 | CC0 | 7 | 0 | 0 | 0 | none |
| on005670 | CC0 | 2 | 0 | 0 | 0 | none |
| Total | | 1,728 | 102 | 390 | 118,929.5 | |

Headline: 102 EDF+D files in 1 dataset have real gaps (`gap_count` above 0); 51 distinct recordings, because every file is stored twice.
The other 1,626 EDF+D files, in 10 datasets, are contiguous: recorders label continuous files `+D`.
No file has a negative gap (`files_with_negative_gap` 0).
The largest gapped recording is `sub-PennEPI02197` run 02 (12 gaps, 18,803 s).

### Do the 17 stores of nm000456 include gapped recordings?

Yes, two of them, and both are stored with the gap removed.
The question was answered read-only from the public serving index `https://zarr.nemar.org/nm000456/zarr/index.json` joined with the deep results.

Command: `uv run --no-project --with httpx python -I s1scan.py zarrcheck on006910,...,nm000456,...,on005670` then `uv run --no-project python -I derive.py zarr`
Raw output: .context/rfc-program/evidence/s1/zarr-join.json
Raw output: .context/rfc-program/evidence/s1/zarrcheck-edfd.txt

Of the 51 gapped recordings in the raw tree, 2 have a store: `sub-PennEPI02152` run 07 (1 gap, 33.9 s) and `sub-PennEPI02201` run 05 (1 gap, 358.1 s).
49 failed conversion, and the 51 `sourcedata` copies are not converted; the dataset's 52 recorded failures are all `retry_exhausted`, 49 of them `MemoryError` while allocating 2.5 to 8.4 GiB arrays and 3 download time-outs.
The 15 other stores are of ungapped recordings (`stores_without_gap` 15).
The two stores are time-compressed: the store for run 07 reports a duration of 9,884.0 s, which is exactly its 4,942 records times 2 s, while the file's last record starts at 9,916.4 s; for run 05, 12,622.0 s against a last onset of 12,978.7 s.
This is an inference from the index's `duration_s`, not a read of the store bytes; checking the bytes needs a Zarr read of `groups/.../0`, which is not done here.
The 52 recorded failures (`failure_count` 52, `zarr_verify_status` `failed`) are all in this dataset's index.

## 3. BrainVision recordings with more than one `New Segment` marker

Every `.vmrk` of every public dataset's latest version was Range-read (52,587 `.vhdr` recordings in 273 datasets) and its `New Segment` markers counted; for a recording with more than one, the segment start dates (when present) were compared with the sample spans to find real gaps.
A gap is counted when the wall-clock distance between two dated segment starts exceeds the sample span between them by more than one sampling interval (and at least 1 ms).

Command: `S1_CONC=8 uv run --no-project --with httpx python -I s1scan.py bv` (three runs, resumable; `bv-run1-killed.txt`, `bv-run2-restarted.txt`, `bv-run3-full.txt`, final retry `bv-run4-retry.txt`)
Raw output: .context/rfc-program/evidence/s1/brainvision-summary.json
Raw output (compact per-recording table, multi-segment and failed only): .context/rfc-program/evidence/s1/brainvision-recordings.json

| Class | Recordings | Datasets | Stores in the serving index | Meaning |
| --- | --- | --- | --- | --- |
| One `New Segment` marker | 21,816 | | | continuous |
| No `New Segment` marker | 29,049 | | | continuous |
| More than one marker, total | 1,527 | 50 | 1,413 | |
| dated, with a gap | 909 | 29 | 796 | real gap by the date test |
| dated, contiguous | 3 | 2 | 3 | segments abut |
| partly dated | 1 | 1 | 0 | cannot be tested |
| undated | 528 | 19 | 528 | markers carry no date; may or may not be discontinuous |
| `SegmentationType=MARKERBASED` | 86 | 1 (`on004000`) | 86 | epoched export, not a gap |
| `.vmrk` not in the listing | 148 | | | `on003944` 82, `on003947` 61, `on005273` 3, `nm000201` 1, `on004067` 1 |
| `.vmrk` unreadable (persistent) | 47 | 1 (`on006159`) | | HTTP 502 from the data plane after a bucket 403 |

Among the 909 dated recordings with a gap, the total gap per recording has a median of 89.6 s, a 90th percentile of 448.9 s and a maximum of 2,594.5 s; 826 exceed 1 s, 583 exceed 60 s, and 36 have a negative total (overlapping or out-of-order dates, which need a closer look).
The 909 are in 29 datasets, listed with licenses in `classes.json` (`bv_multi_dated-with-gap`).
Of those recordings 113 have no store: 91 are the `sourcedata` recordings of `nm000292`, `nm000309`, `nm000318` and `nm000319`, and 22 are in `on005127`, where 23 of 45 have stores (computed from `zarr-join.json`).
The 1,527 include 91 under `sourcedata` and 23 under `derivatives`.
The 47 recordings of `on006159` could not be read after one retry; the object answers 403 in the bucket (an absent object looks the same, see the memory note `s3-403-is-not-absence`) and the data plane then answers 502.
They are reported, not fetched by any other route.

## 4. FIF recordings with acquisition skips

FIF stores its tag directory at the end of the file, so a skip count needs one Range read of the directory (16 bytes per tag) plus one 4-byte read for each `FIFF_DATA_SKIP` tag (kind 301).
Files saved by MNE-Python carry no directory (the pointer is -1); for them the tag chain has to be walked from the start, one 16-byte read per tag, which costs a few hundred reads per file.
So the directory method measured every file that has a directory, and the tag-chain walk was run on a fixed-seed sample of 50 of the files without one, as the card allows (seed 20261120, `random.Random(seed).sample` of the sorted list).

Command: `S1_CONC=4 uv run --no-project --with httpx python -I s1scan.py fif` (`fif-run1-aborted.txt` hit the old abort rule; `fif-run2.txt`, `fif-run3-retry.txt`, `fif-run4-retry.txt` finished it)
Raw output: .context/rfc-program/evidence/s1/fif-summary.json
Raw output (compact, files with skips and failures only): .context/rfc-program/evidence/s1/fif-recordings.json

| Measure | Value |
| --- | --- |
| `.fif` files in the latest versions | 12,164 in 66 datasets (plus 1,136 `.fif.gz` in 9 datasets, not read) |
| With a usable tag directory | 902 |
| of those, with a nonzero `FIFF_DATA_SKIP` | 254 files in 7 datasets (253 with one skip, 1 with two), 19,536 skipped buffers |
| Without a directory | 11,225 |
| of those, tag-chain walk on a sample | 50 files, 0 with a skip |
| of those, not measured | 11,174 |
| Directory pointer beyond the end of file | 1 (`on002885`, unmeasured) |
| Unreadable (persistent) | 37 (all `on006159`, HTTP 502) |

The 254 files with skips are in `on003645` (116), `on002712` (50), `on003483` (41), `on004837` (31), `on004738` (13), `on002885` (2) and `on006334` (1); all are CC0.
Of them 199 have a store in the serving index and 55 failed conversion (`on002712` 32, `on004837` 20, `on003645` 2, `on003483` 1).
A sample of 50 with zero skips bounds the unmeasured rate only loosely: by the rule of three, the upper 95 percent bound is about 6 percent of 11,174 files, so up to roughly 670 further files with skips cannot be excluded.
Not counted here: `.fif.gz`, EEGLAB `boundary` events, and Multiscale Electrophysiology Format (MEF3) gaps (the catalog holds no `.mefd` file, `listing-census.json`).

## 5. Per class: recordings, stores and datasets affected, with licenses

"Real discontinuity" means a measured gap (EDF+D with `gap_count` above 0, BrainVision dated with a gap, FIF with a skip).
"Can be discontinuous" adds the sources whose format allows it but whose gaps are not confirmed (every EDF+D header, every multi-segment BrainVision recording, FIF skips).
A recording's store is counted when its path is in the dataset's serving index.

Command: `uv run --no-project python -I derive.py classes; uv run --no-project python -I union.py`
Raw output: .context/rfc-program/evidence/s1/union.json
Raw output (per dataset, with license): .context/rfc-program/evidence/s1/classes.json

| Scope | Recordings | Datasets | Stores in the serving index | All stores of those datasets | Licenses of the datasets |
| --- | --- | --- | --- | --- | --- |
| Real discontinuity | 1,265 | 37 | 997 | 4,286 | CC0 32, CC-BY-4.0 4, CC-BY-NC-SA-4.0 1 |
| Can be discontinuous | 3,509 | 68 | 3,217 | 6,929 | CC0 48, CC0-1.0 6, CC-BY-4.0 11, CC-BY-NC-4.0 1, CC-BY-NC-SA-4.0 1, CC-BY-SA-4.0 1 |
| All version 2 stores | | 910 | 231,259 | | |

The real-discontinuity row is 102 (EDF+D, `nm000456`) plus 909 (BrainVision) plus 254 (FIF) recordings (computed).
Of the 997 stores 2 are EDF+D, 796 BrainVision and 199 FIF.
So 997 of 231,259 stores (0.43 percent, computed) were converted from a source with a measured gap, and at most 3,217 (1.4 percent) from one that can have a gap.
Version 2 stores that are probably wrong today: those 997, less the ones whose store keeps the gap (not tested here, except the two `nm000456` stores shown above).
The count of stores comes from `zarr_store_count` (231,259 over 910 datasets, `api.txt`); the API reports `zarr_status` ready 877, failed 27, pending 6.

Command: `uv run --no-project --with httpx python -I s1scan.py api`
Raw output: .context/rfc-program/evidence/s1/api.txt
Raw output (compact catalog projection): .context/rfc-program/evidence/s1/api-catalog.json

## 6. Conversion throughput

`zarr_converted_at` is present on 883 of 910 datasets and holds the time of the dataset's last conversion, so every store of a dataset takes that dataset's date.
Earlier conversions of a dataset that was converted more than once are invisible; the measure is therefore a floor on the work done in a day, and is bursty because whole datasets land on one date.

Command: `uv run --no-project --with httpx python -I s1scan.py throughput` (reads `api-catalog.json`, fetched 2026-11-21T00:47:48Z)
Raw output: .context/rfc-program/evidence/s1/throughput.json
Raw output (printed): .context/rfc-program/evidence/s1/throughput.txt

Over the 30 complete days 2026-10-22 to 2026-11-20 (126,288 stores of 231,259 were last converted in that window; 104,971 earlier):

| Measure | stores per day |
| --- | --- |
| Median over all 30 days | 0.5 |
| 90th percentile over all 30 days | 10,687.5 |
| Mean over all 30 days | 4,209.6 |
| Maximum (2026-10-25) | 62,337 |
| Days with any conversion | 15 of 30 |
| Median on the 15 days with conversions | 954 |
| 90th percentile on those 15 days | 19,770.6 |

The median over all days is meaningless for a projection (conversion runs in bursts), so the projections use the mean, the busy-day figures and the maximum.
Projected days to re-convert all 231,259 stores (computed as 231,259 divided by the rate):

| Rate (stores per day) | Days |
| --- | --- |
| 62,337 (the best day seen) | 3.7 |
| 10,687.5 (90th percentile of all days) | 21.6 |
| 4,209.6 (30-day mean) | 54.9 |
| 2,141 (mean since the first conversion on 2026-08-04, 108 days, computed) | 108 |
| 954 (median of days that convert) | 242.4 |

The affected subset first: 997 stores (measured gap) take 0.24 days at the 30-day mean and 1.05 days at 954 per day; 3,217 stores (can be discontinuous) take 0.76 and 3.37 days (computed).
So version 2 and version 3 stores coexist for roughly two months to a year, depending on whether the queue sustains the recent mean or a busy-day median; the affected subset is a day or two of that.
The 49 gapped `nm000456` recordings and 55 gapped FIF recordings that failed conversion with memory errors or time-outs do not re-convert at these rates; they need the writer's memory fix first (not measured here).

## 7. What was sampled, what was not measured

- FIF without a directory: 50 sampled (zero skips), 11,174 not measured.
- BrainVision: every `.vmrk` was counted except 148 absent from the listing and 47 unreadable; undated multi-segment recordings (528) cannot be classified from the markers.
- EDF+D gaps: counted for every file; store contents of the 17 `nm000456` stores were inferred from the index, not read.
- Not covered: `.fif.gz`, EEGLAB `boundary` events, MEF3, GDF (2,066 files) and Extensible Data Format (XDF, 366 files) sources (`listing-census.json` counts them).
- Only each dataset's latest version was scanned; earlier versions' stores were not.
- `nm000411` has no zarr index (HTTP 404), so its 14 EDF+D files (no gaps) have no store join.
