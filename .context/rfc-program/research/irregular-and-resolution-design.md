# biosig-zarr: irregular and sparse sampling, and sample resolution (design for RFC-0001)

Written 2026-11-20 by the specification advisor.
Design only: nothing was written to GitHub or to any checkout.

This document proposes how `biosig-zarr`, and its single-file form `.bzx`, carry
(A) signals that are not one continuous uniform series, and
(B) the resolution of a sample, on the source side and on the store side.
It follows the owner direction of 2026-11-20:
the format is not final, so nothing is deferred to a later version to protect today's readers;
every biosignal gets a home;
a reader must never silently misread;
and what was measured versus what was derived must be visible in the store.

Abbreviations, defined once:
European Data Format (EDF), EDF Plus (EDF+), its continuous and discontinuous variants (EDF+C, EDF+D), time-stamped annotation list (TAL),
BioSemi Data Format (BDF), General Data Format for biomedical signals (GDF), Waveform Database (WFDB),
Extensible Data Format (XDF), Lab Streaming Layer (LSL), Multiscale Electrophysiology Format version 3 (MEF3),
Functional Image File Format (FIF), Neurodata Without Borders (NWB), Shared Near Infrared Spectroscopy Format (SNIRF),
Climate and Forecast conventions (CF), Brain Imaging Data Structure (BIDS), BIDS Extension Proposal (BEP),
analog-to-digital converter (ADC), least significant bit (LSB), not-a-number (NaN),
coordinate format (COO), Architecture Decision Record (ADR), Model Context Protocol (MCP),
Coordinated Universal Time (UTC), electroencephalography (EEG), electromyography (EMG), electrocardiography (ECG).

Inputs:
the prior research (`rfc-program/research/irregular-sampling-and-resolution.md`),
the pre-beta draft (https://docs.nemar.org/formats/biosig-zarr.md, fetched 2026-11-20, `format_version` 2),
ADR 0128, the RFC program plan, nemar-cli `origin/dev`, and biosigIO at tag `v1.2.13`.

---

## 1. Summary of the proposal

1. **`format_version` 3.**
   Version 3 is the version RFC-0001 puts up for comment.
   biosigIO 1.2.13 and earlier refuse it, which is the point.
2. **Two group kinds, named by a required `kind` attribute:**
   `uniform` (one sample grid, `i / rate`) and `timestamped` (one explicit time per sample).
3. **Gaps stay on the grid.**
   A `uniform` group carries a required `valid_intervals` list;
   samples outside it were never acquired.
   A continuous recording has exactly one interval, so continuity becomes an explicit claim, not an absence.
4. **A declared missing value per array** (`missing_value`):
   NaN for floating point, the most negative code for integers, or `null` when every code is data.
5. **A required `start_time` per group**, on one recording timeline shared with `events/onset`.
6. **Jittered streams have two honest homes:**
   kept as measured in a `timestamped` group, or placed on a grid in a `uniform` group that records `time_regularization` and its timing error.
7. **Resolution:**
   root `dtype`, `scale` and `offset` keep their meaning and are stated as the store-side resolution;
   new source-side fields (`source_sample_type`, `source_adc_bits`, `source_step`, `source_offset`, `source_digital_range`) follow a root-default, channel-override rule.
8. **Every lossy step is recorded** in a required per-channel `derivation` list from a closed vocabulary;
   an empty list means the stored codes are the source's codes.

---

## 2. What exists, and what a change touches

Verified in the sources named.

- **Draft, version 2.**
  "Level 0 is uniformly sampled. Sample `i` of a group lies `i / rate` seconds after the start of the recording."
  Open questions 5 (non-integer rates), 6 (replaced samples not located), 9 (no discontinuity), 10 (no start time), 16 (no onset-to-sample rule) are all in scope here.
  The root "MUST NOT contain child nodes other than the channel groups named in `channel_groups` and the `events` group."
- **biosigIO 1.2.13 reader** (`biosigio/importers/zarr.py`):
  refuses a store whose `format` is not `biosigio-zarr`;
  refuses `format_version` greater than 2 (`int(version) <= FORMAT_VERSION`, else `ValueError`);
  takes every root child except `events` as a channel group;
  reads array `0` and `rate` and assumes `i / rate`.
  So a version 3 store is refused outright by every deployed biosigIO release.
- **biosigIO 1.2.13 writers** (`exporters/zarr.py`, `exporters/zarr_stream.py`):
  resample each channel whole with `resample_poly`, with the ratio formed from rounded rates;
  quantize to the full `int16` range `[-32768, 32767]` over the channel's finite samples;
  write non-finite samples as the code nearest physical zero;
  drop the EDF physical and digital ranges that the importer holds in memory.
  The XDF importer interpolates streams onto a common time base (`importers/xdf.py`, `np.interp`), so its output is already a derived grid.
- **nemar-cli readers do not check the store's `format` or `format_version`.**
  No file under `backend/src`, `src` or `shared/contract` reads `channel_groups` or the format tag;
  the MCP read core navigates by the dataset `index.json` (index `format_version` 3, a closed JSON Schema), then reads `<zarr>/<group>/0`.
  **A version bump alone does not protect these readers.**
  They are protected only if a non-uniform group is not listed where they look, and is shaped so that a uniform read fails loudly (section 3.7).
- **`get_events` fallback** computes `sample_index = floor(onset * rate + 0.5)` (`backend/src/mcp/tools/get-events.ts:658`).
  The onset-to-sample rule below matches it when `start_time` is 0.
- **`read_window` already reports absent chunks** as `filled_ranges` with the array's fill value (`backend/src/mcp/taste.ts`).
  Gaps as never-written chunks fit that model.
- **ADR 0123 store content digest** (`nemar.store-content.v1`) hashes `C x S` physical values of level 0 and has no digest for a non-finite value.
  It has no notion of a missing sample, a valid interval or a time array.
- **ADR 0128:** "Embedded metadata is written in the same pass as the samples and never patched afterward; changing what is embedded bumps the engine version, which re-queues the archive."
  Issue nemar-cli#2217 plans an in-place patch of the format name; the two need reconciling (decision D2).

---

## 3. Part A: the time model

### 3.1 One timeline per store

- A store has one **recording timeline**, in seconds, as 64-bit floating point.
  Time 0 is the origin of the source recording: the instant the source file's own clock calls its start
  (the EDF start date and time, the first sample of a BrainVision or FIF file, and for XDF the earliest first-sample timestamp among the streams written, after clock correction).
- `events/onset` values are on this timeline.
  Gaps count: an event after a 30-second gap has an onset 30 seconds later than its position in the concatenated samples.
- Root attribute `origin_source_time` (number or `null`, OPTIONAL):
  the value of the source's own clock at time 0, in seconds, for sources that have one (the LSL clock in XDF).
  It lets a reader restore source timestamps exactly.
- The absolute date and time of the origin stays draft open question 10.
  Nothing in this design needs it, and it is a privacy question, not a timing one.

### 3.2 Root attributes

| Attribute | Type | Presence | Meaning |
| --- | --- | --- | --- |
| `format_version` | integer | REQUIRED | `3`. |
| `channel_groups` | array of strings | REQUIRED | The names of the groups whose `kind` is `uniform`, and only those. It MAY be empty. |
| `timestamped_groups` | array of strings | REQUIRED | The names of the groups whose `kind` is `timestamped`. It MAY be empty. |
| `origin_source_time` | number or `null` | OPTIONAL | See 3.1. |

A store MUST hold at least one group.
The root holds exactly the groups in the two lists, and `events`.
`channel_groups` keeps its name and its version 2 meaning, so a reader that navigates by it never lands on a group it cannot read.

### 3.3 Group kind `uniform`

A `uniform` group is the version 2 channel group with these additions.

| Attribute | Type | Presence | Meaning |
| --- | --- | --- | --- |
| `kind` | string | REQUIRED | `"uniform"`. |
| `start_time` | number | REQUIRED | The time of sample 0 on the recording timeline, in seconds. It MAY be negative. |
| `valid_intervals` | array of objects | REQUIRED | Where acquired samples exist; see below. Never empty. |
| `time_regularization` | object or `null` | REQUIRED | `null` when the source declared uniform sampling; otherwise how per-sample timestamps were placed on the grid (3.5). |
| `rate` | number | REQUIRED | The exact served rate. A writer MUST NOT round it; group names stay opaque. |

Sample `i` lies at `start_time + i / rate`.

**`valid_intervals`.**
Each entry is an object:

| Member | Type | Meaning |
| --- | --- | --- |
| `start` | integer | First sample index of the interval. |
| `stop` | integer | One past the last sample index (half-open). |
| `source_time` | number or `null` | The time of the interval's first sample as the source states it, on the recording timeline; `null` when the source does not say. |

- Intervals MUST be sorted, non-empty, non-overlapping, and inside `[0, n_samples)`.
- The first `start` MUST be 0 and the last `stop` MUST be `n_samples`:
  time before the first sample is expressed by `start_time`, not by a leading gap.
- A continuous recording has the single entry `{ "start": 0, "stop": n_samples, "source_time": start_time }`.
- A sample outside every interval was not acquired.
  Its stored value has no meaning; a reader MUST NOT return it as data.
- When `source_time` is a number, the writer places the interval at `start = round((source_time - start_time) * rate)`.
  The placement error, `source_time - (start_time + start / rate)`, is at most half a sample period and is visible from the two numbers.
- When `source_time` is `null`, the elapsed time before this interval is **unknown**
  (a BrainVision "New Segment" marker with no date, an EEGLAB `boundary` event, concatenated runs, epochs).
  The writer places the interval directly after the previous one (`start` equals the previous `stop`).
  Grid times from that interval on are a convention, not a measurement:
  a reader MUST NOT report them as recording times without saying so, and `events` onsets in such a store follow the same convention.
- A reader MUST NOT filter, resample, epoch or interpolate across an interval boundary, whether a gap separates the intervals or not.
- A writer MUST resample each interval independently.
  A filter that reads across a boundary mixes samples that were never adjacent.
- Segments that overlap in time, or a clock that runs backward, cannot be placed on one grid.
  A writer MUST refuse them, or write them with `source_time: null` (order kept, timing declared unknown).
- A writer SHOULD NOT write more than 65,536 intervals in a group;
  a signal more fragmented than that is a `timestamped` signal.

**Storage.**
A chunk or shard that lies wholly outside the valid intervals MUST NOT be written.
Zarr reads an absent chunk as the fill value, and the sharding codec marks an absent inner chunk in its index, so a gap of any length costs no storage.
Only the partial chunks at interval edges hold filler.

**View pyramid.**
A view column takes the minimum and maximum over its valid, non-missing samples.
A column with none holds the missing value in both rows (or the fill value when the array declares no missing value; a reader masks views with `valid_intervals` scaled by the level's `downsample_factor`).

### 3.4 Missing values

Every signal array (level 0, view arrays, and `values` in a timestamped group) carries:

| Attribute | Type | Presence | Meaning |
| --- | --- | --- | --- |
| `missing_value` | scalar or `null` | REQUIRED | The stored value that means "no sample here", encoded as Zarr v3 encodes `fill_value` for the array's data type; `null` when every stored value is data. |

| Data type | `missing_value` when declared | Effect on quantization |
| --- | --- | --- |
| `int16` | `-32768` | Data codes span `[-32767, 32767]` (65,534 steps instead of 65,535). |
| `int32` | `-2147483648` | Data codes span `[-2147483647, 2147483647]`. |
| `float32`, `float64` | `"NaN"` | None. |

- When `missing_value` is not `null`, the array's `fill_value` MUST equal it,
  so an absent chunk decodes to missing, in a gap and anywhere else.
- A reader MUST return a missing sample as missing (NaN, a mask, or an explicit range list), never as `missing_value * scale + offset`.
- `missing_value` is `null` only when the writer copies source integer codes unchanged and the source uses the whole code range (the exact-copy case of section 4.4).
  Such an array cannot mark a single missing sample; gaps are still expressed by `valid_intervals`.
- Non-finite source samples (NaN, infinity) in an integer store become the missing value.
  This replaces the version 2 behavior (the code nearest physical zero) and closes open question 6: replaced samples are now located.
  `nonfinite_samples` keeps the count.
  A `float32` store keeps infinities as they are, and flags the channel `usable_for_inference: false` like an integer store does.
- The two mechanisms have separate jobs.
  `valid_intervals` is about the whole group and the acquisition (the recorder was off).
  `missing_value` is about one channel at one sample (a sensor off, a dropped packet, a non-finite value).
  A reader applies both.

### 3.5 Jittered streams: two homes, both declared

A stream with a nominal rate and per-sample timestamps (LSL in XDF, motion capture with a BIDS `LATENCY` channel, SNIRF with a full time vector) can be stored either way:

1. **As measured**, in a `timestamped` group (3.6) with `nominal_rate` set.
   Nothing about timing is lost.
2. **Regularized**, in a `uniform` group whose `time_regularization` is an object:

| Member | Type | Meaning |
| --- | --- | --- |
| `method` | string | `"index_order"` (samples kept as measured and assigned to consecutive grid points) or `"interpolated"` (values computed at grid times; the member `interpolation` names the kind, such as `"linear"`). |
| `nominal_rate` | number or `null` | The rate the source declared. |
| `effective_rate` | number | `(n - 1) / (t_last - t_first)` over the source timestamps. |
| `max_abs_time_error` | number | The largest distance, in seconds, between a source timestamp and the grid time its sample was given (`index_order`), or the largest spacing between the source samples used for one output (`interpolated`). |
| `rms_time_error` | number | The root mean square of the same quantity. |
| `timestamp_derivation` | array of strings | What had already been done to the source timestamps (see the token list in 3.6). |

With `interpolated`, every channel's `derivation` gains `time_interpolated` (section 4.5), because the amplitudes are no longer measured values.
The format permits both homes; which one a publisher uses is a profile choice (decision D5).

### 3.6 Group kind `timestamped`

For truly irregular signals, sparse event-like signals with a value (a cuff blood pressure, a temperature probe, a GDF sparse channel, an XDF stream with `nominal_srate` 0), and jittered streams kept as measured.

```
<name>/                 group, kind "timestamped"
  zarr.json             group attributes, including channels[]
  time/                 float64, shape [n_samples]
  values/               shape [n_channels, n_samples]
  time_index/           float64, shape [n_chunks]
```

It has no array named `0`, no `rate` attribute and no `view` group.

| Group attribute | Type | Presence | Meaning |
| --- | --- | --- | --- |
| `kind` | string | REQUIRED | `"timestamped"`. |
| `modality` | string | REQUIRED | As in a uniform group. |
| `n_channels`, `n_samples` | integer | REQUIRED | `n_samples` is at least 1. |
| `channels` | array of objects | REQUIRED | As in a uniform group, without `original_rate`, `target_rate` and `anti_aliased`. |
| `nominal_rate` | number or `null` | REQUIRED | The rate the source declared; `null` for a signal with none. |
| `effective_rate` | number or `null` | REQUIRED | `(n_samples - 1) / (t_last - t_first)`, or `null` when `n_samples` is 1. Informative: a reader MUST NOT compute sample times from it. |
| `time_range` | array of two numbers | REQUIRED | The first and last value of `time`. |
| `continuity` | string | REQUIRED | `"continuous"` (samples of a continuous process; interpolation is meaningful), `"step"` (a value holds until the next sample), `"instantaneous"` (a value describes only its instant), or `"unknown"`. The names follow NWB. |
| `chunk_samples` | integer | REQUIRED | The inner chunk length along time, shared by `time` and `values`. |

- **`time`**: seconds on the recording timeline, finite, non-decreasing.
  Sample `i` of every channel in the group was taken at `time[i]`.
  Channels that do not share timestamps go in separate groups.
  Its array attribute `derivation` is a list of tokens, empty when the values are the source's own timestamps shifted to the origin:
  `clock_synchronized` (a clock offset or drift correction was applied, such as XDF `ClockOffset` chunks),
  `dejittered` (timestamps were smoothed or regressed),
  `deduced` (some samples carried no timestamp and were given one from the nominal rate),
  `sorted` (the source order was not time order).
- **`values`**: data type from the closed list (section 4.1); attributes `scale`, `offset`, `missing_value` and `physical_formula` exactly as on level 0.
- **`time_index`**: element `k` is `time[k * chunk_samples]`, the first time of inner chunk `k`.
  It is one small array (8 bytes per chunk), written as a single chunk.
- **Chunking**: `time` is chunked `[chunk_samples]` and `values` `[n_channels, chunk_samples]`, both with the sharding codec and the same shard length, so chunk `k` of one matches chunk `k` of the other.
- **Window read** for `[t0, t1)`: fetch `time_index` (one request), binary-search it for the chunk range, fetch those `time` and `values` chunks, and trim by `time`.
  A sparse signal is one chunk, so the read is three small requests.
- A reader MUST NOT interpolate or resample a group whose `continuity` is not `"continuous"` without saying so.
- **Cost**: 8 bytes per sample before compression for `time`.
  For a 64-channel `int16` stream that is about 6% on top of the values; for a 4-channel stream, 100%.
  That cost is the reason the regularized home exists.

A point process with no value (a spike time, a marker) is an event, not a signal: it goes in the `events` group.

### 3.7 The reader-safety rule

Four layers, so no single omission lets a reader misread.

1. **Version.**
   A writer that implements this design writes `format_version` 3, always, including for a plain continuous recording.
   A reader MUST refuse a version above the highest it implements (already in the draft).
   Verified: biosigIO 1.2.13 refuses 3.
2. **Kind.**
   Every group carries `kind`.
   A reader MUST read it before any array of the group, MUST refuse a group whose kind it does not implement, and MUST NOT infer a kind from a name or from which children exist.
   A new kind requires a new `format_version`.
3. **Structure, for readers that skip both checks.**
   A `timestamped` group is not in `channel_groups`, has no `0` array and no `rate`.
   A reader that assumes a uniform group gets a missing-node or missing-attribute error, not wrong times.
   This is what protects the nemar-cli read core, which checks neither the tag nor the version today;
   NEMAR's `index.json` MUST NOT list a `timestamped` group among `groups` until its schema carries `kind`.
4. **Within a uniform group.**
   A conforming signal reader MUST apply `start_time`, `valid_intervals` and `missing_value`.
   A reader that does not implement one of them MUST refuse a group where it is in effect
   (`start_time` not 0, more than one interval or any `source_time` of `null`, `missing_value` not `null`), with an error that names it.
   The conformance suite tests each refusal.

**Version 2 stores stay readable, as version 2.**
A reader treats a version 2 group as `uniform`, `start_time` 0, one interval, no declared missing value.
What a version 2 store cannot say is whether that is true:
it has no field that claims continuity, so a version 2 store converted from a discontinuous source may hold mis-timed samples and cannot show it.
(Whether it does is being tested separately; this design does not depend on the result.)
A reader SHOULD surface "continuity not recorded" for version 2 stores.

### 3.8 Events and the onset-to-sample rule

- For a `uniform` group, the sample nearest an onset is `i = floor((onset - start_time) * rate + 0.5)`.
  If `i` is outside `[0, n_samples)` or outside every valid interval, the event has no sample in that group, and a reader MUST say so instead of clamping.
- For a `timestamped` group, the sample at or after an onset is the first `i` with `time[i] >= onset`; an event has no exact sample.
- The `events` group gains a REQUIRED attribute `onset_source_basis`:
  `"timeline"` (the source gave onsets on the recording timeline, as EDF+ TALs do),
  `"concatenated"` (the source gave onsets as positions in gap-free samples and the writer mapped them through `valid_intervals`),
  or `"unknown"`.
  It matters only when a group has more than one interval, and there it is the difference between right and wrong:
  a BIDS `events.tsv` written by a tool that drops gaps counts in concatenated time.

### 3.9 How source formats map

| Source feature | Store |
| --- | --- |
| Uniform continuous file | One `uniform` group per (modality, rate); one interval. |
| EDF+D, BDF+D | Record start times from the time-keeping TALs; consecutive records merge into one interval while `onset[k+1] = onset[k] + record duration`; `source_time` set. |
| EDF+C cut from a longer session (first TAL onset late) | `start_time` equals the first onset; one interval. |
| BrainVision "New Segment" markers | One interval per segment; `source_time` from the marker's date when present, else `null`. |
| FIF data skips, MEF3 table-of-contents gaps | Intervals from the skip or block table; the reader library's zero fill is not stored as data. |
| WFDB null segments, GDF event `0x7ffe` | Interval boundaries; `source_time` when the format gives one. |
| EEGLAB `boundary` events, concatenated runs, epoched data | Adjacent intervals with `source_time: null`. |
| Signals at different rates (EDF samples per record, BIDS `channels.tsv` `sampling_frequency`, WFDB samples per frame) | One `uniform` group per rate. |
| Streams that start at different times (XDF, BIDS physio `StartTime`) | `start_time` per group. |
| XDF stream, `nominal_srate` above 0 | `timestamped` with `nominal_rate`, or `uniform` with `time_regularization`. |
| XDF stream, `nominal_srate` 0, numeric | `timestamped`, `nominal_rate: null`. |
| XDF string marker stream | `events`. |
| GDF sparse channel (samples per record 0, event type `0x7fff`) | `timestamped`, one channel. |
| SNIRF full `time` vector, BIDS motion `LATENCY` channel, BIDS physio `timestamp` column | The group's `time` array; the latency channel is not also stored as a channel. |
| Sensor-off values (GDF codes outside `[DigMin, DigMax]`, WFDB invalid sample, BIDS motion `MissingValues`) | `missing_value`. |

### 3.10 BIDS sidecar fields

These apply where a tool rewrites sidecars around a store, as `nemar dataset download --zarr` does for a `.bzx` snapshot.

| BIDS field | From the store |
| --- | --- |
| `SamplingFrequency` | `uniform`: `rate`. `timestamped`: `nominal_rate` (BIDS motion already reads it as nominal). |
| `SamplingFrequencyEffective` | `timestamped`: `effective_rate`. Regularized `uniform`: `time_regularization.effective_rate`. Otherwise omitted. |
| `RecordingType` | `"continuous"` for one interval; `"discontinuous"` for more than one. `"epoched"` only when the source was epoched (all `source_time` `null` and equal interval lengths is not enough to infer it; the writer records it in `recording_metadata`). |
| `RecordingDuration` | `n_samples / rate`, the span on the timeline including gaps. The acquired duration is the sum of interval lengths over `rate`; BIDS does not say which it means for a discontinuous file (community question 9). |
| `StartTime` (physio) | `start_time`. |
| `channels.tsv` `sampling_frequency` | The `rate` or `nominal_rate` of the channel's group. |
| `events.tsv` `onset` | Unchanged: seconds on the recording timeline. With more than one interval, see `onset_source_basis`. |
| `MissingValues` (motion) | `"NaN"` after dequantization. |

### 3.11 The packaged form (`.bzx`)

- No packing rule changes.
  `time`, `values` and `time_index` are ordinary arrays, and every entry stays byte-identical to the directory form.
- A never-written chunk or shard has no entry.
  A packer MUST NOT create entries for absent chunks, and an unpacker MUST NOT treat their absence as damage.
- The ZIP archive comment already carries `format_version`, so a reader refuses a version 3 file without opening an entry.
- A snapshot of a BIDS dataset with `.bzx` files rewrites the fields of 3.10; a `timestamped` group has no single rate to write into a sidecar field that expects one, which is community question 9.

---

## 4. Part B: sample resolution

### 4.1 The store side: what exists, made explicit

No store-side field is added.
The specification text states:

- **Root `dtype` is the storage type**: its name gives both the width in bits and whether it is integer or floating point, which is what "8, 16, 24 or 32 bit, integer or float" asks for on the store side.
  It is the store default.
  A group MAY carry its own `dtype`, which overrides the root for that group;
  an array's Zarr `data_type` governs and MUST equal the resolved value.
- The closed list is `int16`, `int32`, `float32`, `float64` (decision D6; the draft has `int16` and `float32`).
  `int32` gives 24-bit sources a home without requantization; `float64` does the same for double-precision sources.
  Zarr v3 has no 24-bit integer type, so `int24` is not a storage type.
- **For an integer `dtype`, `scale[c]` is the store's quantization step**: one digital step in the channel's `unit`, with a maximum error of `scale[c] / 2` on a requantized sample.
  For a floating point `dtype`, `scale` is 1, `offset` is 0, and the resolution is that of the type.
- `physical = digital * scale + offset` is unchanged.

### 4.2 The source side: new fields

| Field | Where | Type | Presence | Meaning |
| --- | --- | --- | --- | --- |
| `source_sample_type` | root (default), `channels[]` (override) | string | root REQUIRED | The type of a decoded sample in the source: `int<N>` or `uint<N>` with N from 1 to 64, `float32`, `float64`, or `"n/a"` when unknown. `int24` is BDF; `int12` is WFDB format 212. |
| `source_adc_bits` | root (default), `channels[]` (override) | integer or `null` | root REQUIRED | The ADC bit depth, only when the source states it (WFDB does). Never inferred from the sample type. |
| `source_step` | `channels[]` | number or `null` | REQUIRED | One source digital step in the channel's `unit` (after any unit conversion the writer applied). Nonzero; negative when the source gain is negative. `null` for a floating point source or when unknown. |
| `source_offset` | `channels[]` | number or `null` | REQUIRED | The physical value of source digital code 0, in `unit`. |
| `source_digital_range` | `channels[]` | `[min, max]` or `null` | REQUIRED | The digital minimum and maximum the source declares (in GDF, the saturation values). |

**The default and override rule.**
For `source_sample_type` and `source_adc_bits`, a reader takes the channel's member when the channel object has one, and the root value otherwise.
It is an override, not a product: these are facts, not factors (NWB multiplies `conversion` by `channel_conversion`; that suits gains, not types).
A writer SHOULD write only the root value when every channel agrees, and SHOULD write `"n/a"` or `null` at the root when channels differ, with every channel stating its own.
There are two levels and no group level, to keep one rule.
`source_step`, `source_offset` and `source_digital_range` are per channel in every source format, so they have no default.

The source's physical range is not stored; it follows from the three per-channel members:
`physical_min = digital_min * source_step + source_offset`, and the same for the maximum.

### 4.3 Round-trip mapping

**Into a store.**

| Source | `source_sample_type` | `source_step` | `source_offset` | `source_digital_range` | `source_adc_bits` |
| --- | --- | --- | --- | --- | --- |
| EDF | `int16` | `(pmax - pmin) / (dmax - dmin)` | `pmin - dmin * step` | `[dmin, dmax]` | `null` |
| BDF | `int24` | as EDF | as EDF | `[dmin, dmax]` | `null` |
| BrainVision | `INT_16`: `int16`; `INT_32`: `int32`; `IEEE_FLOAT_32`: `float32` | channel resolution times the unit factor (integer formats); `null` for float | `0` (integer formats) | `null` | `null` |
| GDF | per channel from `GDFTYP` | as EDF | as EDF | `[DigMin, DigMax]` | `null` |
| WFDB | from the format code | `1 / gain` | `-baseline / gain` | `null` | the header's ADC resolution |

**Out of a store.**

| Target | Rule | Loss |
| --- | --- | --- |
| EDF | `int16` store: `digital_min` is `-32768`, or `-32767` when `missing_value` is `-32768`; `digital_max = 32767`; physical limits from `scale` and `offset`. More than one interval: EDF+D, one run of data records per interval. | Physical limits are printed into 8 characters. EDF has no missing value: a missing sample inside an interval needs an annotation, or a refusal. A record duration must divide every interval; in the worst case that is one sample per record, which EDF+ permits. |
| BDF | As EDF with 24-bit codes. An `int32` store whose codes fit 24 bits is copied; otherwise requantized. | As EDF. |
| BrainVision | No offset exists. Zero `offset`: `INT_16` or `INT_32` with resolution `scale`. Otherwise `IEEE_FLOAT_32`. Each interval starts with a "New Segment" marker carrying its `source_time` when known. | Samples are concatenated; missing samples inside an interval have no representation. |
| GDF | `GDFTYP` from `dtype`, per channel; `DigMin` and `DigMax` set to the data code range, so the missing value falls outside it, which is GDF's own convention for "no valid sample". A `timestamped` channel becomes a sparse channel (samples per record 0, events of type `0x7fff`). | None beyond the store's own. |

**Restoring the source header.**
`source_sample_type`, `source_step`, `source_offset` and `source_digital_range` let an exporter write the source's original ranges.
The samples are still the store's samples unless the channel's `derivation` is empty.

### 4.4 The exact-copy case

When a channel is not resampled, not unit-converted, and the store's integer type holds the source's codes, a writer MAY copy the codes unchanged:
`digital` equals the source code, `scale` equals `source_step`, `offset` equals `source_offset`, and `derivation` is `[]`.
An EDF file at or below the rate cap can then be reproduced bit for bit.
If the source uses the type's most negative code as data, the array declares `missing_value: null`.
Whether NEMAR's writer does this is a profile choice (decision D7); the format only has to make it expressible and visible.

### 4.5 Recording lossy steps

**Decision: yes, a writer MUST record every step that makes a stored sample differ from the source sample.**
The draft already records some as separate members (`anti_aliased`, `original_rate`, `target_rate`, `nonfinite_samples`, `bids_unit`).
They stay.
One required per-channel member is added that states the whole list:

`channels[].derivation`: array of strings, REQUIRED, in the order applied.

| Token | Meaning | Where the size of the change is recorded |
| --- | --- | --- |
| `resampled` | Rate changed through an anti-alias filter. | `original_rate`, `target_rate`, root `anti_alias_filter`. |
| `nearest_sample` | Rate changed by picking the nearest source sample (discrete channels). | `original_rate`, `target_rate`. |
| `time_interpolated` | Values computed at grid times from timestamped samples. | `time_regularization`. |
| `unit_converted` | Multiplied by a unit factor. | `unit`, `bids_unit`. |
| `requantized` | Stored integer codes are on a new lattice, not the source's codes. | `scale` against `source_step`. |
| `narrowed` | Stored at lower floating point precision than the source. | `dtype` against `source_sample_type`. |
| `nonfinite_to_missing` | Non-finite source samples stored as the missing value. | `nonfinite_samples`. |
| `nonfinite_zeroed` | Non-finite samples stored as physical zero. Version 2 stores only; a version 3 writer MUST NOT do it. | `nonfinite_samples`. |
| `gap_filled` | Samples at times the source did not record are stored as data. A version 3 writer MUST NOT do it when it can locate the gap; the token exists for sources whose reader fills silently. | none |

- An empty list means the stored codes are the source's codes.
- A profile MAY add tokens that contain a colon, such as `nemar:sss`; a reader treats an unknown token as "derived, in a way I do not know".
- The group attribute `valid_intervals`, the array attribute `missing_value`, and the `time` array's `derivation` complete the picture for timing.

Regularization of timestamps that leaves amplitudes untouched (`index_order`) changes no sample, so it is recorded on the group (`time_regularization`), not in a channel's `derivation`.

---

## 5. Examples

Attributes not relevant to this design are left out and marked by a comment line in the text, not in the JSON.

### 5.1 An EDF+D file

A 19-channel EEG recording at 250 Hz, with data records of 1 second.
The recorder ran from 0 to 60 seconds, paused, and ran again from 90 to 240 seconds.
The rate is at the cap, so the writer copies the codes.

Root attributes (others omitted):

```json
{
  "format": "biosig-zarr",
  "format_version": 3,
  "channel_groups": ["eeg_250hz"],
  "timestamped_groups": [],
  "dtype": "int16",
  "source_format": "EDF+D",
  "source_sample_type": "int16",
  "source_adc_bits": null
}
```

Group `eeg_250hz` (one channel shown, others omitted):

```json
{
  "kind": "uniform",
  "modality": "EEG",
  "rate": 250.0,
  "original_rate": 250.0,
  "n_channels": 19,
  "n_samples": 60000,
  "start_time": 0.0,
  "valid_intervals": [
    { "start": 0, "stop": 15000, "source_time": 0.0 },
    { "start": 22500, "stop": 60000, "source_time": 90.0 }
  ],
  "time_regularization": null,
  "channels": [
    {
      "label": "Fp1",
      "row_index": 0,
      "channel_type": "EEG",
      "modality": "EEG",
      "unit": "uV",
      "original_rate": 250.0,
      "target_rate": 250.0,
      "anti_aliased": false,
      "usable_for_inference": true,
      "scale": 0.1,
      "offset": 0.0,
      "source_step": 0.1,
      "source_offset": 0.0,
      "source_digital_range": [-32768, 32767],
      "derivation": []
    }
  ]
}
```

Level-0 array attributes (others omitted).
The source uses the whole code range, so no code is reserved, and the gap is carried by `valid_intervals` alone:

```json
{
  "level": 0,
  "kind": "signal",
  "rate": 250.0,
  "scale": [0.1],
  "offset": [0.0],
  "missing_value": null
}
```

Events group attributes:

```json
{ "n_events": 12, "label_map": { "0": "eyes closed" }, "onset_source_basis": "timeline" }
```

With 1,000-sample inner chunks, chunks 15 to 21 are never written; chunk 22 holds 500 filler samples and 500 valid ones.

### 5.2 A multi-rate file

A BDF file with 64 EEG channels at 1024 Hz and one respiration belt at 64 Hz.
EEG is capped to 250 Hz and requantized; the belt keeps its rate.

Root attributes (others omitted):

```json
{
  "format": "biosig-zarr",
  "format_version": 3,
  "channel_groups": ["eeg_250hz", "misc_64hz"],
  "timestamped_groups": [],
  "dtype": "int16",
  "modality_rates": { "EEG": 250, "MEG": 250, "IEEG": 1000, "EMG": 1000 },
  "source_format": "BDF",
  "source_sample_type": "int24",
  "source_adc_bits": null
}
```

Group `eeg_250hz` (one channel shown):

```json
{
  "kind": "uniform",
  "modality": "EEG",
  "rate": 250.0,
  "original_rate": 1024.0,
  "n_channels": 64,
  "n_samples": 450000,
  "start_time": 0.0,
  "valid_intervals": [{ "start": 0, "stop": 450000, "source_time": 0.0 }],
  "time_regularization": null,
  "channels": [
    {
      "label": "A1",
      "row_index": 0,
      "channel_type": "EEG",
      "modality": "EEG",
      "unit": "uV",
      "original_rate": 1024.0,
      "target_rate": 250.0,
      "anti_aliased": true,
      "usable_for_inference": true,
      "scale": 0.0048,
      "offset": -12.5,
      "source_step": 0.03125,
      "source_offset": 0.0,
      "source_digital_range": [-8388608, 8388607],
      "derivation": ["resampled", "requantized"]
    }
  ]
}
```

Its level-0 array carries `"missing_value": -32768`, and the array metadata carries `"fill_value": -32768`.

Group `misc_64hz` (one channel):

```json
{
  "kind": "uniform",
  "modality": "MISC",
  "rate": 64.0,
  "original_rate": 64.0,
  "n_channels": 1,
  "n_samples": 115200,
  "start_time": 0.0,
  "valid_intervals": [{ "start": 0, "stop": 115200, "source_time": 0.0 }],
  "time_regularization": null,
  "channels": [
    {
      "label": "Resp",
      "row_index": 0,
      "channel_type": "RESP",
      "modality": "MISC",
      "unit": "mV",
      "original_rate": 64.0,
      "target_rate": 64.0,
      "anti_aliased": false,
      "usable_for_inference": true,
      "scale": 0.0021,
      "offset": 3.4,
      "source_step": 0.00003125,
      "source_offset": 0.0,
      "source_digital_range": [-8388608, 8388607],
      "derivation": ["requantized"]
    }
  ]
}
```

The belt's `scale` is 67 times its `source_step`: the `int16` store is coarser than the 24-bit source, and the two numbers say so.

### 5.3 An XDF jittered stream

An LSL recording with an 8-channel EEG stream (`nominal_srate` 500, `channel_format` `float32`) and a string marker stream.
The EEG stream is kept as measured.

Root attributes (others omitted):

```json
{
  "format": "biosig-zarr",
  "format_version": 3,
  "channel_groups": [],
  "timestamped_groups": ["eeg_stream1"],
  "dtype": "float32",
  "source_format": "XDF",
  "source_sample_type": "float32",
  "source_adc_bits": null,
  "origin_source_time": 184223.5512
}
```

Group `eeg_stream1` (one channel shown):

```json
{
  "kind": "timestamped",
  "modality": "EEG",
  "n_channels": 8,
  "n_samples": 899310,
  "nominal_rate": 500.0,
  "effective_rate": 499.6172,
  "time_range": [0.0, 1799.996],
  "continuity": "continuous",
  "chunk_samples": 2000,
  "channels": [
    {
      "label": "Cz",
      "row_index": 0,
      "channel_type": "EEG",
      "modality": "EEG",
      "unit": "uV",
      "usable_for_inference": true,
      "scale": 1.0,
      "offset": 0.0,
      "source_step": null,
      "source_offset": null,
      "source_digital_range": null,
      "derivation": []
    }
  ]
}
```

`time` array attributes:

```json
{ "kind": "time", "unit": "s", "derivation": ["clock_synchronized"] }
```

`values` array attributes:

```json
{
  "kind": "values",
  "scale": [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
  "offset": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
  "missing_value": "NaN",
  "physical_formula": "physical = digital * scale + offset"
}
```

The marker stream is in `events`, with `"onset_source_basis": "timeline"`.

The same stream in its other home, a `uniform` group named `eeg_500hz` (the attributes that differ):

```json
{
  "kind": "uniform",
  "rate": 500.0,
  "n_samples": 899999,
  "start_time": 0.0,
  "valid_intervals": [{ "start": 0, "stop": 899999, "source_time": 0.0 }],
  "time_regularization": {
    "method": "interpolated",
    "interpolation": "linear",
    "nominal_rate": 500.0,
    "effective_rate": 499.6172,
    "max_abs_time_error": 0.0061,
    "rms_time_error": 0.0011,
    "timestamp_derivation": ["clock_synchronized"]
  }
}
```

with every channel's `derivation` equal to `["time_interpolated"]`.

### 5.4 A sparse signal

A cuff blood pressure taken about every five minutes during a four-hour EEG recording, beside the EEG group in the same store.

Group `bp_cuff`:

```json
{
  "kind": "timestamped",
  "modality": "MISC",
  "n_channels": 2,
  "n_samples": 47,
  "nominal_rate": null,
  "effective_rate": 0.0033,
  "time_range": [212.4, 14162.9],
  "continuity": "instantaneous",
  "chunk_samples": 1000,
  "channels": [
    {
      "label": "BP_systolic",
      "row_index": 0,
      "channel_type": "BP",
      "modality": "MISC",
      "unit": "mmHg",
      "usable_for_inference": false,
      "scale": 1.0,
      "offset": 0.0,
      "source_sample_type": "int16",
      "source_step": 1.0,
      "source_offset": 0.0,
      "source_digital_range": null,
      "derivation": []
    },
    {
      "label": "BP_diastolic",
      "row_index": 1,
      "channel_type": "BP",
      "modality": "MISC",
      "unit": "mmHg",
      "usable_for_inference": false,
      "scale": 1.0,
      "offset": 0.0,
      "source_sample_type": "int16",
      "source_step": 1.0,
      "source_offset": 0.0,
      "source_digital_range": null,
      "derivation": []
    }
  ]
}
```

`values` is `int16` with `"missing_value": -32768`, shape `[2, 47]`, in one chunk; `time` has 47 values; `time_index` has one.
The root lists `"timestamped_groups": ["bp_cuff"]` beside `"channel_groups": ["eeg_250hz"]`.

---

## 6. What the change costs

### 6.1 Writers

- **biosigIO exporters** (`exporters/zarr.py`, `exporters/zarr_stream.py`):
  the version constant; `kind`, `start_time`, `valid_intervals`, `time_regularization`, `missing_value`, `derivation` and the `source_*` members;
  per-interval resampling;
  a quantizer that leaves the missing code free and writes non-finite samples as missing;
  no write of gap chunks (the streaming path's third pass copies shard-aligned blocks, so it can skip blocks; its scratch arrays span the whole grid, which a sparse file handles: inferred, not measured);
  the view builder skipping missing samples;
  a new writer for `timestamped` groups.
- **biosigIO importers:** the intervals have to reach the exporter.
  The EDF importer already holds the four range values per channel and the exporters drop them.
  For EDF+D the route through MNE cannot supply record onsets, so the importer needs its own TAL walk.
  FIF and MEF3 gaps arrive as `BAD_ACQ_SKIP` annotations and can be turned into intervals.
  BrainVision "New Segment" dates and EEGLAB `boundary` events need parsing.
- **`scripts/zarr/generate_zarr.py`:** an engine version bump, which re-queues the archive under ADR 0128;
  `index.json` and `events.parquet` need `kind`, coverage and `start_time` to stay computable, and the index schema is closed, so that is an index schema change.

### 6.2 Readers

- **biosigIO reader:** accept version 3; mask by intervals and missing value; refuse or expose `timestamped` groups (its `Recording` model is one uniform table).
- **nemar-cli MCP read core** (`read-window.ts`, `taste.ts`, `render-overview.ts`, `get-events.ts`), **the local reader (#2144)**, **the website viewer and the browser runtime:**
  apply `start_time`, intervals and the missing value; today's `filled_ranges` report extends naturally to both.
  The contract text "every served level-0 array is int16-quantized and rate-capped" (`shared/contract/mcp.ts`) stays true for the NEMAR profile only if the profile keeps `int16`.
- **ADR 0123 store content digest:** `nemar.store-content.v1` cannot digest a group with a missing sample, an interval, or a time array.
  A `v2` definition is needed before any derivative is keyed on such a store.
  A continuous store with no missing sample keeps its `v1` digest only if its values do not change, and they do change when the quantizer frees the missing code.
- **eegprep-lean, EEGDash:** not read for this report; they need the same reader rule.

### 6.3 The back catalog and nemar-cli#2217

Every published store is `format_version` 2 under the legacy name.
The number of stores was not measured for this report.

| Route | What it does | Cost | What it cannot do |
| --- | --- | --- | --- |
| **A. Leave version 2 stores as they are; new and re-converted stores are version 3.** | Readers accept both, permanently. | None for the catalog; readers carry two code paths, of which the version 2 path is a special case of version 3. | Version 2 stores never state continuity or source resolution. |
| **B. Additive metadata patch to version 3**, in the same pass as the #2217 rename. | Rewrites the root, each group and each level-0 `zarr.json`; no chunk changes. Writes `kind`, `start_time: 0`, one interval, `missing_value: null`, `source_sample_type: "n/a"`. | Three or more object rewrites per store instead of one; a cache purge. | It would assert one valid interval without having checked the source, which is the opposite of the goal. It cannot supply `source_*` or a truthful per-channel `derivation`. It contradicts ADR 0128's "never patched afterward". |
| **C. Re-conversion** through an engine version bump. | Every store rewritten from its source as version 3. | The full conversion compute, over the queue's normal time. | Nothing; it is the only route that makes old stores say what version 3 asks. |

Recommendation: **A now, C as the queue allows, never B.**
Re-convert first the recordings whose sources can be discontinuous (EDF+ and BDF+ files whose header says discontinuous, BrainVision files with more than one "New Segment" marker, FIF and MEF3 files with skips, EEGLAB files with `boundary` events), found by a header scan that reads no samples.
Because C rewrites every root `zarr.json` anyway, the #2217 in-place rename is not needed for correctness; folding the rename into the version 3 writer avoids patching the live archive once (decision D2).

---

## 7. Alternatives rejected

1. **Defer truly irregular signals to a later version** (the prior research's recommendation).
   Rejected by the owner's direction; solved by the version bump, the required `kind`, and the structural guard.
2. **Add the features within version 2 as optional attributes.**
   A version 2 reader would ignore `valid_intervals` and `missing_value` and return filler as data: a silent misread.
   The draft's own rule requires a bump.
3. **Concatenated segments with a segment table** (samples stored gap-free, a table maps them to time).
   Any reader that skips the table misplaces every sample after the first gap, silently; that is the suspected converter defect made into a format feature.
   On the grid, a reader that skips `valid_intervals` still has correct times.
   The one thing concatenation does better, unknown gap lengths, is covered by `source_time: null`.
4. **One explicit time array for every group.**
   8 bytes per sample everywhere, a search before every window read, and no reader in the MNE family can represent it.
   Kept only where the data needs it.
5. **A boolean validity mask array per group.**
   Another array as large as a channel, for information that is an interval list in almost every case.
6. **NaN only, floating point stores for anything with gaps.**
   Doubles storage for the NEMAR profile and excludes thin `int16` readers.
7. **A reserved integer code always, with no `null`.**
   It makes bit-exact copies of full-range integer sources impossible.
8. **A sparse coordinate layout** (time, channel, value triples) for sparse signals.
   One time array per group with channel-major values covers the cases surveyed with the same array shapes as level 0.
9. **Sparse numeric signals inside the `events` group.**
   The draft keeps `events` deliberately light, and a value column with a unit, scale and missing value is a signal.
10. **`int64` ticks with a tick rate for `time`.**
    Exact, but every reader must get one more conversion right; `float64` seconds resolves about half a nanosecond after 30 days and matches `events/onset`, BIDS, XDF and NWB.
11. **A delta filter on `time`.**
    Not a Zarr v3 core codec; thin readers would not have it.
12. **`valid_intervals` as Zarr arrays** instead of an attribute.
    Scales further, but costs a request on every window read and hides the gaps from someone reading `zarr.json`.
    The 65,536 cap keeps the attribute bounded (community question 2).
13. **One list of all groups with a kind per entry**, replacing `channel_groups`.
    A reader that navigates by `channel_groups` and skips the version check would then land on a `timestamped` group.
14. **One store per continuous segment** (BEP047's working answer: separate files aligned through `scans.tsv`).
    A store stands in for one data file; splitting it breaks that, and `.bzx` snapshots would change the file list.
15. **A multiplicative two-level rule** for source fields, as NWB's `conversion` times `channel_conversion`.
    Sample types and bit depths are not factors.
16. **A `resolution` field for the store side.**
    It would always equal `scale`; NWB's `resolution` also carries a noise judgment.
17. **`BitDepth` names after BEP047.**
    "Bit depth" merges the storage width and the ADC depth, which differ (a 16-bit ADC in a 24-bit file).
18. **Storing the source physical range instead of `source_offset`.**
    Only EDF-family formats have one; step, offset and digital range are the same three facts in a form every source can fill.
19. **Free-text or full processing provenance** for lossy steps.
    Free text cannot be tested; a full processing record is a stated non-goal of the format.
    A closed token list is checkable and small.
20. **CF attribute names** (`scale_factor`, `add_offset`, `_FillValue`).
    Not rejected on merit; it renames deployed attributes for one consumer and is put to the community (question 11).

---

## 8. Questions for RFC-0001

1. Are gaps on the grid, with a required interval list, acceptable as the only expression of discontinuity for uniform signals?
   Who has recordings where it fails (overlapping segments, clocks that step backward)?
2. Should `valid_intervals` be an attribute with a cap, or arrays?
   What is the most fragmented recording you have?
3. Is `source_time: null` (order known, elapsed time unknown) the right home for BrainVision segments without dates, EEGLAB `boundary` events and concatenated runs?
   Should epoched data be accepted this way, or refused?
4. Should integer stores always reserve the most negative code, or is `missing_value: null` for bit-exact copies worth a second case in every reader?
5. For jittered streams, which should a public archive serve: timestamps as measured, or a regular grid with the error recorded?
   Is `max_abs_time_error` the statistic you would check?
6. Are `timestamped` groups, with a shared `time` array per group, enough for your irregular data?
   Does anyone need per-channel timestamps inside one group?
7. Is `continuity` (`continuous`, `step`, `instantaneous`) the right vocabulary, and should it also apply to uniform groups?
8. Are `float64` seconds precise enough for `time`, or do you need integer ticks?
9. For a discontinuous or timestamped recording in a BIDS snapshot, what should `RecordingDuration`, `SamplingFrequency` and `RecordingType` say, and do your `events.tsv` onsets count gap time?
10. Is the `derivation` vocabulary complete, and is an empty list a claim you would rely on?
11. Should the format adopt CF names and `dimension_names` so that xarray decodes a store without help?
12. Should `int32` and `float64` be core storage types, and must every signal reader support them or may it refuse?
13. Should `source_adc_bits` exist when almost no EEG format states it?
14. Is the pattern `int<N>` and `uint<N>` right for `source_sample_type`, or should the list be closed?
15. Should a writer be allowed to store a recording whose time base is unknown at all, or must it refuse?

---

## 9. Conformance test files

Small real recordings are preferred; each needs a license that allows redistribution under Apache 2.0 or a compatible data license.
"Candidate" means the file is believed to exist and was not opened for this report.

| Feature | File needed | Candidate source | What the test asserts |
| --- | --- | --- | --- |
| Uniform continuous, exact copy | A short EDF at or below the cap | Any PhysioNet EDF record | `derivation: []`; export reproduces the source samples bit for bit. |
| EDF+D gaps | A real EDF+D recording with at least two gaps | Not yet found; clinical exports are the usual origin. A header scan of the NEMAR catalog would find one. Fallback: an EDF+D cut from a real EDF+C by dropping records. | Interval starts equal TAL onsets; an event after a gap maps to the right sample. |
| EDF+C late first onset | A file cut at a record boundary | biosigIO's `test_edf_timekeeping_onset.py` fixture | `start_time` equals the first onset. |
| BrainVision segments, dated | A `.vhdr` set with two dated "New Segment" markers | MNE testing data (candidate) | Intervals with `source_time`. |
| BrainVision segments, undated | The same with zero dates | biosigIO test fixtures write such markers | Adjacent intervals, `source_time: null`. |
| FIF skips | A FIF with `FIFF_DATA_SKIP` | MNE testing data, the interval-recording file (candidate) | Zero fill is not stored as data. |
| MEF3 gaps | A small `.mefd` with a table-of-contents gap | biosigIO's MEF3 importer test data | As FIF. |
| WFDB null segment, ADC bits | A multi-segment record | PhysioNet variable-layout records (candidate) | Interval boundaries; `source_adc_bits` set. |
| Multi-rate | An EDF or BDF with two samples-per-record values | PhysioNet polysomnography records (candidate) | Two groups; events map to both. |
| 24-bit source | A short BDF | BioSemi's public example files (candidate) | `source_sample_type: "int24"`; `int32` exact copy; `int16` requantized with the right `derivation`. |
| Jittered stream | An XDF with a nominal-rate stream and markers | `sccn/xdf` example files (candidate) | Both homes; `time_regularization` statistics reproduce. |
| Irregular stream | An XDF stream with `nominal_srate` 0 and numeric values | To be recorded, or cut from a real session | `nominal_rate: null`; window read through `time_index`. |
| Sparse signal | A spot measurement series beside EEG | To be assembled from a public intensive-care or sleep record | One-chunk group; `continuity: "instantaneous"`. |
| GDF sparse channel and out-of-range codes | A GDF 2.x file with a samples-per-record 0 channel | None known; synthetic, written by BioSig | Round trip to and from a `timestamped` group. |
| Non-finite samples | A real recording with NaN in one auxiliary channel | A NEMAR mobile brain and body imaging recording (biosigIO issue 107 names the case) | Missing code at the right samples; count matches. |
| Unknown time base | An EEGLAB `.set` with `boundary` events | To be chosen from the catalog | Adjacent intervals with `source_time: null`. |
| Reader refusals | Each store above, read by a reader with a feature switched off | Generated | The reader refuses and names the feature; it never returns filler or wrong times. |
| `.bzx` with absent chunks | The EDF+D store, packed | Generated | No entry for gap chunks; unpacked store is byte-identical. |

---

## 10. Verified versus inferred

**Verified for this report (2026-11-20), by reading the source named:**

- The draft's rules and open questions quoted in section 2 (Markdown mirror, fetched today).
- biosigIO 1.2.13: the reader's format and version checks, root listing and `i / rate` assumption (`importers/zarr.py`);
  the writers' whole-channel resampling with rounded-rate ratios, full-range `int16` quantizer, non-finite handling and attribute sets (`exporters/zarr.py`, `exporters/zarr_stream.py`);
  the EDF+D route to MNE (`importers/_edf_tolerant.py`); the XDF importer's interpolation onto a common time base (`importers/xdf.py`).
- nemar-cli `origin/dev`: no reader under `backend/src`, `src` or `shared/contract` reads `channel_groups` or the store format tag;
  the `get_events` rounding rule; `read_window`'s `filled_ranges`; the closed index schema; the biosigIO pin `>=1.2.13,<1.2.14`.
- ADR 0123's digest definition and ADR 0128's "never patched afterward" sentence.
- Issue nemar-cli#2217's plan and its statement that every store carries `format_version` 2.

**Taken from the prior research, which records its own verification, and not re-checked:**
the format survey (EDF+, BDF, GDF, BrainVision, WFDB, XDF, MEF3, NWB, SNIRF, FIF, BIDS, CF, Zarr v3), including GDF's out-of-range convention and sparse channels, XDF's `nominal_srate` 0 rule, and NWB's `continuity` values.

**Inferred, or from memory:**

- That MNE drops the EDF+D marker and biosigIO then shifts samples after a gap (under separate test; nothing here depends on it).
- That a BIDS `events.tsv` written by a gap-dropping tool counts in concatenated time.
- That BrainVision "New Segment" dates carry microseconds, and that a zero date means "not recorded".
- That EEGLAB `boundary` events reach biosigIO only as ordinary events.
- GDF `GDFTYP` codes, WFDB `baseline` and `gain` algebra as written in 4.3, and that WFDB format 212 is 12-bit.
- That the streaming exporter can skip gap blocks without a memory cost.
- That zarr-python omits a chunk equal to the fill value by default, which is why `fill_value` must equal `missing_value`.
- Every candidate conformance file in section 9.
- The storage percentages for `time` (arithmetic, compression not measured).
- The numbers in the examples are illustrative, not from real files.

**Not done:** no store was written or read, no reader was run, the number of stores in the catalog was not counted, and eegprep-lean and EEGDash were not read.

---

## 11. Decisions for the owner

| ID | Decision | Recommendation |
| --- | --- | --- |
| D1 | How existing readers are kept from misreading. | `format_version` 3 for every store a new writer makes, a required `kind` on every group, and the structural guard of 3.7. All three, because the nemar-cli read core checks neither the tag nor the version. |
| D2 | The back catalog and nemar-cli#2217. | Route A then C of 6.3: leave version 2 stores as they are, re-convert through an engine bump, discontinuous-capable sources first; no metadata-only upgrade. Fold the rename into the version 3 writer and drop the in-place patch, or keep the patch as a name-only step; either way reconcile it with ADR 0128's "never patched afterward". |
| D3 | Gaps on the grid with `valid_intervals`, including `source_time: null` for unknown elapsed time. | Accept. It keeps window reads and `sample_index` arithmetic unchanged and gives undated segments a home. |
| D4 | The missing value: a reserved code by default, `null` allowed for bit-exact copies. | Accept both cases; NEMAR's profile always reserves the code. |
| D5 | Jittered streams in NEMAR's profile: as measured, or regularized. | Format allows both. Profile: keep as measured (`timestamped`) by default; regularize only on request, with the error recorded. |
| D6 | Storage types: add `int32` and `float64`, per group. | Add both to the core list; a signal reader may refuse a type it does not support, with a clear error. NEMAR's profile stays `int16` for uniform groups. |
| D7 | Exact copy when no resampling is needed. | Allow in the format. For NEMAR's profile, decide after measuring how many recordings qualify; it changes the quantizer's output for those stores. |
| D8 | Lossy steps: a required per-channel `derivation` list. | Accept, with the closed vocabulary of 4.5 and profile tokens marked by a colon. |
| D9 | Source fields: `source_sample_type` and `source_adc_bits` required at the root (`"n/a"` and `null` allowed), the other three required per channel (`null` allowed). | Accept. `source_offset` is an addition to the four fields the research proposed; without it the EDF physical range cannot be restored. |
| D10 | `onset_source_basis` on the `events` group. | Accept; without it a discontinuous store cannot say whether its onsets count gap time. |
| D11 | The ADR 0123 content digest. | Define `nemar.store-content.v2` (missing samples, intervals, time arrays) before any derivative is keyed on a version 3 store; this needs its own ADR amendment. |
| D12 | Epoched sources. | Refuse in NEMAR's profile for now; ask the community (question 3). |
