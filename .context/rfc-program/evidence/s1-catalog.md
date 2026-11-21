# S1: the back catalog that the version 3 rollout touches, measured read-only

Measured 2026-11-20 and 2026-11-21 against the public endpoints only (`api.nemar.org`, `data.nemar.org`, `zarr.nemar.org`, the public bucket `nemar.s3.us-east-2.amazonaws.com`, and GitHub tree listings through `gh api`).
All raw outputs are beside this file in `evidence/s1/`.
Every number below is copied from the named file or computed from it; "computed" marks an arithmetic result with its inputs shown.

**Method statements, not measurements.**
No write was made outside this worktree and `/Users/yahya/.cache/nemar-s1-scan/`; no `aws` call was made; no live dataset or re-pull switch was touched.
At most 8 requests were in flight at once (4 for the long BrainVision and FIF runs, 8 for the last BrainVision run); the User-Agent was `nemar-s1-scan/0.1`.
These are statements about how the scan was run, and nothing in the evidence files proves them.

Abbreviations, defined once.
European Data Format (EDF) and BioSemi Data Format (BDF) are two biosignal file formats; the EDF+ and BDF+ extensions add annotations and a flag in the header's reserved field: "EDF+C" and "BDF+C" mean continuous recording, "EDF+D" and "BDF+D" mean discontinuous (the records may start at irregular times).
A time-stamped annotation list (TAL) is the annotation record that EDF+ and BDF+ use for those start times.
FIF is the file format of Neuromag and Elekta magnetoencephalography (MEG) systems, which MNE-Python (a Python package for electroencephalography (EEG) and MEG analysis) reads and writes.
BrainVision is the EEG file set of Brain Products (`.vhdr` header, `.vmrk` markers, `.eeg` data); a `New Segment` marker starts a new recording segment.
GDF is the General Data Format for Biosignals; MEF3 is the Multiscale Electrophysiology Format, version 3; XDF is the Extensible Data Format of the Lab Streaming Layer; EEGLAB is a MATLAB toolbox whose `.set` files may carry `boundary` events.
Application Programming Interface (API); megabyte (MB); gigabyte (GB).

The scripts are in `evidence/s1/`: `scan.py` (the earlier scan, as run), `s1scan.py` (the new stages), `derive.py` and `union.py` (derived tables, no network).
The working cache (about 56 MB, plus the intermediate listing and the per-recording tables) stays in `/Users/yahya/.cache/nemar-s1-scan/` and is not committed.

**"Version 2 stores"** in this card means the serving stores of the public catalog, 231,259 in total (the sum of each dataset's `zarr_store_count`), taken to be written by the version 2 biosig-zarr writer as the program plan assumes.
No store's own `format_version` was read.
The `format_version 3` and `engine 3` that `zarrcheck-*.txt` print for every dataset are the version of the serving index document (`shared/contract/zarr-index.ts` line 249, `z.literal(3)`), not of the stores, so they do not contradict "version 2 stores".

## 0. Method, and what was resumed

The earlier scan (session remi:18769) had finished before this card started, so nothing it had measured was rerun.

Command: `ps -p 99119; pgrep -fl scan.py; stat cache.json; shasum -a 256 cache.json` (output transcribed by hand into `step0.txt`)
Raw output: .context/rfc-program/evidence/s1/step0.txt

The cache's SHA-256 at copy time is `c21c5ce0a46fe17572bc02cfd5621c8d122d5737b880028d58904068d3d9fd11` (56,371,069 bytes), identical to the original.
The original scan directory under `/private/tmp/...` was gone by 2026-11-21; the copy under `/Users/yahya/.cache/nemar-s1-scan/` remains.

Changes to `scan.py`, as the card requires: `scan.py.diff-vs-pack` is the diff between the pack's copy (`research/edfd-scan/scan.py`, method only) and the script as run.
They are four fixes made by remi:18769 during the deep pass: a TAL onset written `+-0.001` is read as `-0.001`; NUL padding is stripped from the header numbers; a file whose header claims more records than it holds is flagged `file_short`; and `size_matches` is false for such a file.
The new stages are in `s1scan.py`, which copies the request helper and the `Reader` class from `scan.py` and changes three things: the abort streak counts a request that failed after all its retries, not each retry (the earlier rule aborted a run on one bad object, section 3); a data-plane retry after a bucket 403 or 404 does not count toward the streak; and the direct bucket URL is also derived for `md5` annexed keys (`MD5E-...`, checked on `on001810`).
After review round 1, `s1scan.py` was edited again in two places that did not touch the committed data: the throughput stage now selects its window by calendar date, and the FIF code counts only positive skip values and records an unreadable one (`skip_read_none`) and `walk_capped` in its summary.
The committed FIF tables were produced before the second edit; `fif-coverage.json` shows no file had a non-positive or unreadable skip value, so rerunning would give the same numbers, and no network scan was rerun.

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
The checkpoint C1 relay said "141,671 headers attempted, 134,664 read, 7,007 failed".
That figure was relayed, not reproduced from the committed data, and the final cache holds 141,747 headers, 76 more; I did not find the cause of the difference of 76.
The header runs' logs are committed as `scan-logs/heads.log.txt` to `heads4.log.txt` (the first run read 110,011 files; later runs 31,736, 24,336 and 16,883 to read; the last prints `failed: 0`).
The 5xx responses in the fourth run were retried by the script and succeeded.

Raw output for the failures: .context/rfc-program/evidence/s1/heads-failures.json

The listing is of each dataset's latest version: 899 manifests came from `manifest.json` and 10 from GitHub trees (the 10 datasets whose manifest is too large).

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

Headline: 102 EDF+D files in 1 dataset have real gaps (`gap_count` above 0); they are 51 distinct recordings, because every file is stored twice.
The other 1,626 EDF+D files, in 10 datasets, are contiguous: recorders label continuous files `+D`.
No file has a negative gap (`files_with_negative_gap` 0).
The largest gapped files are the `sourcedata` copy `sourcedata/pennsieve/files/raw_data/edf/PennEPI02197/PennEPI02197_day02.edf` and its raw-tree twin `sub-PennEPI02197/eeg/sub-PennEPI02197_task-monitoring_run-02_eeg.edf`: 12 gaps, 18,803.449218 s each.

Command: `uv run --no-project python -I derive.py extras`
Raw output: .context/rfc-program/evidence/s1/extras.json

### Do the 17 stores of nm000456 include gapped recordings?

**Yes, two; the index duration suggests the gap was dropped (inferred, store bytes not read).**
The question was answered read-only from the public serving index `https://zarr.nemar.org/nm000456/zarr/index.json` joined with the deep results.

Command: `uv run --no-project --with httpx python -I s1scan.py zarrcheck on006910,...,nm000456,...,on005670` then `uv run --no-project python -I derive.py zarr`
Raw output: .context/rfc-program/evidence/s1/zarr-join.json
Raw output: .context/rfc-program/evidence/s1/zarrcheck-edfd.txt

Of the 51 gapped recordings in the raw tree, 2 have a store: `sub-PennEPI02152` run 07 (1 gap, 33.9 s) and `sub-PennEPI02201` run 05 (1 gap, 358.1 s).
49 failed conversion, and the 51 `sourcedata` copies are not converted.
The dataset's index records 52 failures, all `retry_exhausted`: 49 `MemoryError` and 3 `RuntimeError` (`zarr-join.json`, `failure_detail_kinds`); the 49 gapped recordings without a store and the 49 `MemoryError` failures are equal in number, and I did not check that they are the same files.
The 15 other stores are of ungapped recordings (`stores_without_gap` 15).
The index says the run 07 store lasts 9,884.0 s, which is exactly its 4,942 records times 2 s, while the file's last record starts at 9,916.4 s; for run 05 the store lasts 12,622.0 s against a last onset of 12,978.7 s.
That is why the gap looks dropped, but it is an inference from the index's `duration_s`: the store bytes were not read, and a Zarr read of the store would settle it.

## 3. BrainVision recordings with more than one `New Segment` marker

Every listed and readable `.vmrk` of every public dataset's latest version was Range-read (52,587 `.vhdr` recordings in 273 datasets) and its `New Segment` markers counted; for a recording with more than one, the segment start dates (when present) were compared with the sample spans to find real gaps.
A gap is counted when the wall-clock distance between two dated segment starts exceeds the sample span between them by more than one sampling interval (and at least 1 ms).
A recording's gap total is the signed sum of its gaps.

Command: `S1_CONC=8 uv run --no-project --with httpx python -I s1scan.py bv` (three runs, resumable; `bv-run1-killed.txt`, `bv-run2-restarted.txt`, `bv-run3-full.txt`, final retry `bv-run4-retry.txt`)
Raw output: .context/rfc-program/evidence/s1/brainvision-summary.json
Raw output (compact per-recording table, multi-segment and failed only): .context/rfc-program/evidence/s1/brainvision-recordings.json

| Class | Recordings | Datasets | Stores in the serving index | Meaning |
| --- | --- | --- | --- | --- |
| One `New Segment` marker | 21,816 | | | continuous |
| No `New Segment` marker | 29,049 | | | continuous |
| More than one marker, total | 1,527 | 50 | 1,413 | |
| dated, positive total gap | 873 | 28 | 777 | real gap by the date test |
| dated, negative total ("overlap or out of order") | 36 | 4 (`on005127` 19, `on004587` 15, `on005486` 1, `on006801` 1) | 19 | the dates run backward or overlap; not a verified gap, cause not investigated |
| dated, contiguous | 3 | 2 | 3 | segments abut |
| partly dated | 1 | 1 | 0 | cannot be tested |
| undated | 528 | 19 | 528 | markers carry no date; may or may not be discontinuous |
| `SegmentationType=MARKERBASED` | 86 | 1 (`on004000`) | 86 | epoched export, not a gap |
| `.vmrk` not in the listing | 148 | 5 | | see below |
| `.vmrk` unreadable (persistent) | 47 | 1 (`on006159`) | | HTTP 502 from the data plane after a bucket 403 |

The 909 "dated with a gap" recordings of the first round are 873 with a positive total plus 36 with a negative total (the stores column: 777 plus 19 is 796, computed).

Command: `uv run --no-project python -I derive.py bvstats`
Raw output: .context/rfc-program/evidence/s1/bv-gap-stats.json

Gap size, percentiles by linear interpolation between order statistics (the method of `pct()` in `s1scan.py`; the first round's 448.9 s used the index `int(0.9 n)` and is replaced by 446.8 s):

| Set | Recordings | Median | 90th percentile | Maximum | Over 1 s | Over 60 s |
| --- | --- | --- | --- | --- | --- | --- |
| Positive total | 873 | 99.0 s | 461.1 s | 2,594.5 s | 826 | 583 |
| All dated with a gap, signed totals | 909 | 89.6 s | 446.8 s | 2,594.5 s | 826 | 583 |

Small and signed totals: 42 recordings have a positive total of at most 0.1 s, and the 36 negative totals are at or below 0.1 s by definition, so 78 of the 909 have a total at or below 0.1 s; 61 have an absolute total under 0.1 s.
The net (signed) sum of all gap totals is 168,448.0 s.
The absolute sum of the individual gaps is 170,389.7 s, but it comes from the first 50 gaps of each recording, which is all of them except for 2 recordings with more than 50 gaps (a lower bound for those two); 48 recordings have at least one negative gap (tested on the same first 50).
Sub-second sanity check: 68 recordings have only gaps under 1 s.
For 59 of them a gap is not a multiple of the sampling interval, so their dates are finer than a second.
The other 9 (`on005286` and `on005291`, 1 ms sampling, gaps of 47 to 79 ms) cannot be told from millisecond dates: a date written to whole seconds would yield exactly such values when the sample span is fractional, so a gap of under 0.1 s there is weak evidence.

Of the 909 recordings 113 have no store: 91 are the `sourcedata` recordings of `nm000292`, `nm000309`, `nm000318` and `nm000319`, and 22 are in `on005127`, where 23 of 45 have stores (computed from `zarr-join.json`).
The 1,527 include 91 under `sourcedata` and 23 under `derivatives`.
The 47 recordings of `on006159` could not be read after one retry; the object answers 403 in the bucket (an absent object looks the same, see the memory note `s3-403-is-not-absence`) and the data plane then answers 502.
They are reported, not fetched by any other route.
The 148 `.vhdr` files with no `.vmrk` in the cached listing (`on003944` 82, `on003947` 61, `on005273` 3, `nm000201` 1, `on004067` 1) have no `.vmrk` of the same name in any letter case, and 1 has another `.vmrk` in its directory (`extras.json`); the `MarkerFile=` line of each `.vhdr` was not read, because that needs a network read, so a marker file kept elsewhere cannot be excluded.
Why 82 of the 148 are in `on003944` was not investigated.

## 4. FIF recordings with acquisition skips

FIF stores its tag directory at the end of the file, so a skip count needs one Range read of the directory (16 bytes per tag) plus one 4-byte read for each `FIFF_DATA_SKIP` tag (kind 301).
Files saved by MNE-Python carry no directory (the pointer is -1); for them the tag chain has to be walked from the start, one 16-byte read per tag, which costs a few hundred reads per file.
So the directory method measured every file that has a directory, and the tag-chain walk was run on a fixed-seed sample of 50 of the files without one, as the card allows (seed 20261120, `random.Random(seed).sample` of the sorted list of the 11,225).
**FIF is a lower bound.**
11,175 files were not measured and 37 could not be read.

Command: `S1_CONC=4 uv run --no-project --with httpx python -I s1scan.py fif` (`fif-run1-aborted.txt` hit the old abort rule; `fif-run2.txt`, `fif-run3-retry.txt`, `fif-run4-retry.txt` finished it)
Raw output: .context/rfc-program/evidence/s1/fif-summary.json
Raw output (compact, files with skips and failures only): .context/rfc-program/evidence/s1/fif-recordings.json
Command: `uv run --no-project python -I derive.py fifstats`
Raw output: .context/rfc-program/evidence/s1/fif-coverage.json

| Measure | Value |
| --- | --- |
| `.fif` files in the latest versions | 12,164 in 66 datasets |
| With a usable tag directory (measured) | 902 |
| of those, with a nonzero `FIFF_DATA_SKIP` | 254 files in 7 datasets (253 with one skip, 1 with two), 19,536 skipped buffers |
| Without a usable directory | 11,225 in 60 datasets: 11,224 with a -1 pointer, 1 (`on002885`) with a pointer beyond the end of the file |
| of those, tag-chain walk on a sample (measured) | 50 files from 17 datasets, 0 with a skip |
| of those, not measured | 11,175 (the 11,225 less the 50 walked) |
| `walk-capped` (walk stopped at its read limit) | 0 |
| Unreadable (persistent) | 37 (all `on006159`, HTTP 502 after a bucket 403) |
| Measured in total | 952 (902 plus 50) |
| `.fif.gz` | 1,136 files in 9 datasets, not measured |

The 254 files with skips are in `on003645` (116), `on002712` (50), `on003483` (41), `on004837` (31), `on004738` (13), `on002885` (2) and `on006334` (1); all are CC0.
Of them 199 have a store in the serving index and 55 failed conversion (`on002712` 32, `on004837` 20, `on003645` 2, `on003483` 1); the cause of those 55 failures was not examined.
A sample of 50 with zero skips bounds the unmeasured rate only loosely.
The rule of three (an upper 95 percent bound of about 3 in 50, or 6 percent, so up to about 670 of the 11,175) assumes an independent random sample, and it does not hold here: the files cluster in datasets, all 254 measured skips sit in 7 datasets, the 50 files came from only 17 of the 60 datasets that have files without a directory, and none came from the 7 datasets with a measured skip (54 files without a directory sit in two of those: `on004837` 53 and `on002885` 1).
The sample covers the no-directory population only, and a skip can be present in any unmeasured file of a dataset that has skips.
Not counted here: `.fif.gz` (1,136 files), EEGLAB `boundary` events (66,724 `.set` files), and MEF3 gaps (the catalog holds no `.mefd` file, `listing-census.json`).
GDF (2,066 files), Extensible Data Format (XDF, 366 files) and Neuroscan `.cnt` (840 files) sources were not scanned either.

## 5. Per class: recordings, stores and datasets affected, with licenses

"Real discontinuity" means a measured gap (EDF+D with `gap_count` above 0, BrainVision dated with a gap, FIF with a skip).
Every row is **measured only**: sources the scan could not read (the FIF and `.fif.gz` files above, 148 BrainVision recordings without a `.vmrk` and 47 unreadable ones) are in no row, so the FIF part is a lower bound.
A recording's store is counted when its path is in the dataset's serving index.

Command: `uv run --no-project python -I derive.py classes; uv run --no-project python -I union.py`
Raw output: .context/rfc-program/evidence/s1/union.json
Raw output (per dataset, with license): .context/rfc-program/evidence/s1/classes.json

| Scope | Recordings | Datasets | Stores in the serving index | All stores of those datasets | Licenses of the datasets |
| --- | --- | --- | --- | --- | --- |
| Real discontinuity, all | 1,265 | 37 | 997 | 4,286 | CC0 32, CC-BY-4.0 4, CC-BY-NC-SA-4.0 1 |
| Real discontinuity, without the 36 negative-total recordings | 1,229 | 36 | 978 | 4,244 | CC0 31, CC-BY-4.0 4, CC-BY-NC-SA-4.0 1 |
| Can be discontinuous, all (note 1) | 3,509 | 68 | 3,217 | 6,929 | CC0 48, CC0-1.0 6, CC-BY-4.0 11, CC-BY-NC-4.0 1, CC-BY-NC-SA-4.0 1, CC-BY-SA-4.0 1 |
| Can be discontinuous, without the known non-gaps (note 2) | 1,794 | 56 | 1,525 | 5,166 | CC0 37, CC0-1.0 6, CC-BY-4.0 10, CC-BY-NC-4.0 1, CC-BY-NC-SA-4.0 1, CC-BY-SA-4.0 1 |
| `.fif.gz` | 1,136 files | 9 | not measured | | |
| All version 2 stores | | 910 | 231,259 | | |

The "all" real-discontinuity row is 102 (EDF+D, `nm000456`) plus 909 (BrainVision) plus 254 (FIF) recordings (computed).
Its 997 stores are 2 EDF+D, 796 BrainVision and 199 FIF; without the 36 negative-total recordings the stores are 2, 777 and 199, which is 978.
So 997 of 231,259 stores (0.43 percent, computed), or 978 (0.42 percent), were converted from a source with a measured gap.
Which of those stores are wrong today depends on whether the store keeps the gap; that was not tested, except for the two `nm000456` stores (section 2).
The count of stores comes from `zarr_store_count` (231,259 over 910 datasets, `api.txt`); the API reports `zarr_status` ready 877, failed 27, pending 6.

1. The "can be discontinuous, all" row is the format-level upper bound, and it is mostly not gaps: it contains 1,626 EDF+D files measured gapless, 86 epoched (`MARKERBASED`) and 3 dated-contiguous BrainVision recordings, and the 528 undated BrainVision recordings.
   The 528 undated ones are included because their markers carry no date, so a gap cannot be tested for or excluded, and BrainVision allows one.
2. The "without the known non-gaps" row drops the 1,626 gapless EDF+D files and the 86 plus 3 BrainVision non-gaps, and keeps the 909 dated-with-gap, the 528 undated, the 1 partly dated and the 254 FIF recordings (102 plus 909 plus 528 plus 1 plus 254 is 1,794, computed).

Command: `uv run --no-project --with httpx python -I s1scan.py api`
Raw output: .context/rfc-program/evidence/s1/api.txt
Raw output (compact catalog projection): .context/rfc-program/evidence/s1/api-catalog.json

## 6. Conversion throughput

**Definition.**
"Stores per day" is the `zarr_store_count` of every dataset whose `zarr_converted_at` falls on that calendar day, summed; the timestamp is the dataset's last conversion, written without a zone and read as Coordinated Universal Time.
It is neither a floor nor a ceiling: crediting all of a dataset's stores to its last conversion day inflates bursts and hides earlier conversion days, and the series mixes first conversions with re-conversions.
Version 3 re-conversion throughput was not measured; a version 3 writer may be faster or slower.
`zarr_converted_at` is present on 883 of 910 datasets (the 27 without it hold no stores in `zarr_store_count`).

Command: `uv run --no-project --with httpx python -I s1scan.py throughput` (reads `api-catalog.json`, fetched 2026-11-21T00:47:48Z; no network)
Raw output: .context/rfc-program/evidence/s1/throughput.json
Raw output (printed): .context/rfc-program/evidence/s1/throughput.txt

The window is the 30 complete UTC days 2026-10-22 to 2026-11-20, selected by calendar date (the fetch happened at 00:47 UTC on 2026-11-21, a partial day that holds no conversions, so the first round's elapsed-time filter and this one give the same numbers).
126,288 stores of 231,259 were last converted in the window and 104,971 earlier.

| Measure | stores per day |
| --- | --- |
| Median over all 30 days | 0.5 |
| 90th percentile over all 30 days (linear) | 10,687.5 |
| Mean over all 30 days | 4,209.6 |
| Maximum (2026-10-25) | 62,337 |
| Days with any conversion | 15 of 30 |
| Median on the 15 days with conversions | 954 |
| 90th percentile on those 15 days (linear) | 19,770.6 |
| Mean from the earliest last-conversion day (2026-08-04) to 2026-11-20, 109 days inclusive | 2,121.6 |

The earliest day, 2026-08-04, is the earliest recorded last conversion, not a verified start of the queue, and its first day may be partial.
The median over all days is meaningless for a projection (conversion runs in bursts), so the projections use the mean, the busy-day figures and the maximum.
Projected days to re-convert all 231,259 stores (computed as 231,259 divided by the rate):

| Rate (stores per day) | Days |
| --- | --- |
| 62,337 (the best day seen) | 3.7 |
| 10,687.5 (90th percentile of all days) | 21.6 |
| 4,209.6 (30-day mean) | 54.9 |
| 2,121.6 (mean over 109 days) | 109 |
| 954 (median of days that convert) | 242.4 |

That is about 2 to 8 months at the 30-day mean and the busy-day median (54.9 to 242.4 days), 3.6 months at the 109-day mean, and 3 weeks at the 90th percentile.
Projected days for the affected subsets (computed, `union.json`), at the 30-day mean and at 954 per day:

| Subset | Stores | At 4,209.6 per day | At 954 per day |
| --- | --- | --- | --- |
| Real discontinuity, stores in the serving index | 997 | 0.24 | 1.05 |
| Real discontinuity, all stores of those 37 datasets | 4,286 | 1.02 | 4.49 |
| Can be discontinuous, stores in the serving index | 3,217 | 0.76 | 3.37 |
| Can be discontinuous, all stores of those 68 datasets | 6,929 | 1.65 | 7.26 |

So version 2 and version 3 stores would coexist for roughly 2 to 8 months for the whole catalog, depending on whether the queue sustains the recent mean or a busy-day median, while the affected stores alone are a few days to about a week of that.
The 49 gapped `nm000456` recordings and 55 gapped FIF recordings that failed conversion have no store, so they are not in the "stores in the serving index" rows; they will not re-convert until whatever failed them is fixed, and that cause is a separate question (for `nm000456` the index reports memory errors, section 2; for FIF it was not examined).

## 7. What was sampled, what was not measured

- FIF without a directory: 50 sampled (zero skips), 11,175 not measured, 37 unreadable; `.fif.gz` (1,136) not measured.
- BrainVision: every `.vmrk` was counted except 148 absent from the listing and 47 unreadable; undated multi-segment recordings (528) cannot be classified from the markers, and the 36 negative totals are not verified gaps.
- EDF+D gaps: counted for every file; store contents of the 17 `nm000456` stores were inferred from the index, not read.
- Not covered: `.fif.gz`, EEGLAB `boundary`, MEF3, GDF, XDF and Neuroscan `.cnt` sources.
- Only each dataset's latest version was scanned; earlier versions' stores were not.
- `nm000411` has no zarr index (HTTP 404), so its 14 EDF+D files (no gaps) have no store join.
