---
number: 1
title: "biosig-zarr: a Zarr format for biosignal recordings, with .bzx as its single-file form"
status: draft
scope: org
shepherd: Seyed Yahya Shirazi
window_days: 21
discussion: null
opened_at: null
decided_at: null
decision: null
spec_base: 2.0.0
spec_proposed: 3.0.0-draft.1
---

# NEMAR RFC 0001: biosig-zarr, with `.bzx` as its single-file form

> **Preview draft, 2026-11-20. Not open for comment yet.**
> This text is for the owner to read and react to before the Request for Comments (RFC) is opened.
> Statements that were not verified for this draft are marked **Unverified**, and section 16 lists them together.

## 1. Summary

The Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) serves every raw recording it holds a second time, as a Zarr version 3 store shaped for fast partial reads over a network.
We have served stores in this layout since mid 2026.
We are now writing the layout down as its own specification, `biosig-zarr`, for tools other than ours to read and write.

As of 2026-11-20, NEMAR serves 231,259 stores, 98.4% of the 235,038 recordings in its 910 public datasets (about 116,000 hours of recordings), and the count grows as datasets arrive.
The other 3,779 recordings have no source data available to convert.
Our data viewer reads these stores to show any recording in a browser without a download,
and our Model Context Protocol (MCP) server reads them to let research agents query and analyze signals directly.
With a written specification, other archives, viewers and analysis tools can use the same stores.
A store can also be packed into one file with the suffix `.bzx`, which can then stand in for a data file on a researcher's disk.

We ask for comments on the format before it is frozen,
from anyone who records, shares, analyzes or builds tools for electroencephalography (EEG), magnetoencephalography (MEG), intracranial EEG (iEEG), electromyography (EMG), electrocardiography (ECG), other physiological recordings, motion and wearable sensors, and any other biosignal,
and from the people who build Zarr tools.
The RFC also proposes `format_version` 3, to fix two things version 2 cannot express.
First, a version 2 store has one uniform time axis and cannot say that a recording paused, that a stream was sampled irregularly, or that a signal is sparse.
Second, a version 2 store records how samples are stored, but not the resolution of the source recording they came from.

Version 2, tagged `2.0.0`, is the format NEMAR serves today.
The text this RFC proposes is tagged `3.0.0-draft.1` when the RFC opens, and becomes `3.0.0` only if the RFC is accepted.

## 2. Who should read this

If you record, share or analyze biosignals of any kind (EEG, MEG, iEEG, EMG, ECG, physiology, motion, wearables and more), read sections 3, 5, 6 and 13.
Tell us whether the time model fits your recordings, and whether a store says enough about what was done to your samples.

If you build Zarr readers, writers or viewers, read sections 4, 7 and 8.
Tell us whether your tool can read the layout, and whether you can implement the packing rules.

If you maintain a neighboring standard, such as the Brain Imaging Data Structure (BIDS), Neurodata Without Borders (NWB) or OME-Zarr from the Open Microscopy Environment (OME),
sections 8 to 10 describe how this format relates to yours, and where it deliberately departs from it.

## 3. The problem

### 3.1 A store needs a contract that outlives one implementation

One library, [biosigIO](https://github.com/neuromechanist/biosigio), writes our stores, and until 2026-11-18 the layout was whatever that library wrote.
A format defined by its only implementation cannot be implemented a second time with confidence, and it changes whenever the library does.
The pre-beta specification at <https://docs.nemar.org/formats/biosig-zarr/> reverses that relation.
The specification defines the format, and biosigIO is one exemplar implementation.
This RFC is the first public review of that specification.

### 3.2 Version 2 cannot represent time that is not one uniform, continuous axis

The specification's "Time axis" paragraph, in the section "Level-0 array", is two sentences:

> Level 0 is uniformly sampled.
> Sample `i` of a group lies `i / rate` seconds after the start of the recording.

Its open question 9, in the section "Open questions", states the consequence:

> A recording that is not continuous has no representation.
> There is one uniform time axis per group, and no per-sample timestamps.

Three kinds of data run into this limit.

The first is a recording with gaps, where the recorder paused and resumed.
The European Data Format (EDF) in its original form cannot represent a gap, because its data records are contiguous.
Its successor EDF Plus (EDF+) has a discontinuous variant (EDF+D) in which each data record carries its own start time.
The BioSemi Data Format (BDF) has the same variant, BrainVision files mark each restart with a "New Segment" marker,
and the Functional Image File Format (FIF) used for MEG and the Multiscale Electrophysiology Format version 3 (MEF3) record skips between data blocks.

The second is a jittered stream, which has a nominal rate but carries a measured timestamp for each sample.
The Extensible Data Format (XDF) written by the Lab Streaming Layer (LSL) works this way, and so do motion capture systems.

The third is a sparse or irregular signal,
such as a cuff blood pressure every few minutes, a temperature probe, or a value that arrives when it arrives.
Neither EDF nor EDF+ has a real representation for these, and neither does the current draft.

Existing tools already get the gap case wrong.
For this RFC, on 2026-11-20, we wrote a small synthetic EDF+D file whose four one-second data records start at 0, 1, 10 and 11 seconds.
MNE-Python 1.12.1 and 1.13.2 both read it as 4 seconds of continuous signal.
Both versions place the sample recorded at 10.0 seconds at 2.0 seconds, an error of 8 seconds, and drop the annotation after the gap.
biosigIO 1.2.13 falls back to that reader for discontinuous files, so the store it writes carries the same shifted samples and no sign that anything was removed.
In a second file with a 1-second gap, the event that survives marks a sample recorded one second later than the event.
A BrainVision file with a second "New Segment" marker five seconds after the first segment ended shows the same shift.
The reports are [neuromechanist/biosigio#180](https://github.com/neuromechanist/biosigio/issues/180) (opened 2026-11-20)
and [mne-tools/mne-python#13429](https://github.com/mne-tools/mne-python/issues/13429) (opened 2025-09-25, still open on 2026-11-20).

The reproduction used synthetic files.
**Unverified:** we have not measured how many recordings NEMAR already holds are affected; a header scan that reads no samples will answer that.

A version 2 store cannot show the problem even when the writer knows about it, because it has no field that claims continuity.
BIDS contributors have raised the same limit (all links checked 2026-11-20):

- [bids-specification#1771](https://github.com/bids-standard/bids-specification/issues/1771), the origin issue of BIDS Extension Proposal (BEP) 047 for audio and video:
  on 2024-04-22 a commenter asked whether a recording that stopped and resumed is one file or several, quoting the EDF+ discontinuous mode.
  The working answer was separate runs aligned through `scans.tsv`.
- [bids-specification#1796](https://github.com/bids-standard/bids-specification/issues/1796), "allow timestamps for physio table" (2024-04-18):
  a timestamp column for irregularly sampled tables, and nominal against effective sampling frequency.
- [bids-specification#2313](https://github.com/bids-standard/bids-specification/issues/2313), "Storing sparse/non-continuous peripheral physiological data" (2026-01-19).
- [bids-specification#2463](https://github.com/bids-standard/bids-specification/issues/2463), "Plain-text TSV for motion/physio doesn't scale" (2026-07-08):
  Zarr is a candidate there, with the remark that it needs a fixed contract the way EDF has one.

### 3.3 Version 2 records storage, not the source's resolution

The "Root attributes" table defines `dtype` as "`"int16"` or `"float32"`: the data type of every level-0 and view array in the store."
The "Dequantization" section defines `physical = digital * scale + offset` with a `scale` and `offset` per channel.

Together they say how a stored sample becomes a physical value, but not what the source was.
A 24-bit amplifier recorded into a BDF file and requantized into a 16-bit store looks the same as a recording that was 16-bit to begin with.
A reader cannot tell how much precision was given up, and an exporter cannot restore the source's own digital and physical ranges.

The same section says that in a 16-bit store a non-finite sample is replaced by the code nearest physical zero, and that "A store does not record which samples were replaced."
So a not-a-number (NaN) value in the source becomes a plausible zero that no reader can tell from data.

### 3.4 What a fix has to guarantee

Four requirements shaped the proposal.

First, every biosignal gets a home.
Nothing is postponed to a later version to protect today's readers; the format is not final.

Second, a reader never silently misreads.
A reader that does not understand a feature refuses, with an error that names the feature.

Third, measured and derived values can be told apart.
A store says which samples and times are the source's own and which were computed.

Fourth, the common case stays cheap.
A continuous, uniformly sampled recording costs nothing extra to store and one small attribute to describe.

## 4. The format in one page

This section describes version 2, the format as it exists today.
The full text is at <https://docs.nemar.org/formats/biosig-zarr/> (Markdown mirror: <https://docs.nemar.org/formats/biosig-zarr.md>).

A store holds one recording as a Zarr version 3 hierarchy:

```
<name>.zarr/                  root group
  zarr.json                   root attributes
  <modality>_<rate>hz/        one channel group per modality and source rate
    zarr.json                 group attributes, including channels[]
    0/                        level 0: signal, shape [n_channels, n_samples], sharded
    view/
      1/, 2/, ...             minimum and maximum envelopes, for drawing only
  events/
    onset/, duration/, code/  present when the recording has events
```

A store is derived from a source recording, and the source stays the record of what was acquired.

A store is lossy by default.
Signals above a rate cap per modality are resampled down to the cap through an anti-alias filter, and never upsampled;
we use 250 Hz for EEG and MEG, and 1000 Hz for iEEG and EMG.
Samples are stored as 16-bit integers with a `scale` and `offset` per channel.

Level 0 is channels first.
It has shape `[n_channels, n_samples]`, and every chunk spans every channel, so one request returns a time window of the whole montage.

A reader can find every path from the attributes, without listing the store,
because a store served over the Hypertext Transfer Protocol (HTTP) usually cannot be listed.

The `events` group is light.
It holds onset, duration, a code and a label per code, like a data file's own annotations.
Full event tables, with Hierarchical Event Descriptors (HED), stay in the dataset.

A distributed store holds no subject information, meaning no identity or phenotype fields.

A publisher documents its own restrictions and additions as a profile.
NEMAR's is the only profile today, with 16-bit storage always, fixed rate caps and a `nemar` provenance block.

The whole version 2 text is open for comment, including its 33 open questions.
Section 13 points at the ones where outside experience would help most.

## 5. Proposal, part A: the time model (`format_version` 3)

Everything in sections 5 and 6 is proposed for comment.
The owner has ruled on each item, and the rulings (D1 to D12 of 2026-11-20, noted in brackets) are the position NEMAR brings to the RFC.
Comments can change any of them.

Version 3 is not only for future data.
Gaps (EDF+D, FIF skips, BrainVision segments) and source resolution affect data NEMAR already holds,
while the `timestamped` group kind gives a home to data that BIDS does not carry yet.

### 5.1 One timeline per store

- A store has one **recording timeline**, in seconds, as 64-bit floating point.
  Time 0 is the instant the source file's own clock calls its start.
- `events/onset` values are on this timeline, and gaps count.
  An event after a 30-second pause has an onset 30 seconds later than its position in the concatenated samples.
- An optional root attribute `origin_source_time` holds the value of the source's own clock at time 0, for sources that have one.
  With it, a reader can restore source timestamps exactly.
- The absolute date and time of the origin stays open (version 2 open question 10).
  It is a privacy question more than a timing one.

### 5.2 Two kinds of group [D1]

Every group carries a required attribute `kind`:

| `kind` | Meaning | Listed in root attribute |
| --- | --- | --- |
| `uniform` | One sample grid; sample `i` lies at `start_time + i / rate`. | `channel_groups` |
| `timestamped` | One explicit time per sample. | `timestamped_groups` |

`channel_groups` keeps its name and its version 2 meaning, so a reader that navigates by it never lands on a group it cannot read.

### 5.3 Gaps stay on the grid: `valid_intervals` [D3]

A `uniform` group is the version 2 channel group plus these required attributes:

| Attribute | Type | Meaning |
| --- | --- | --- |
| `kind` | string | `"uniform"`. |
| `start_time` | number | The time of sample 0 on the recording timeline, in seconds. |
| `valid_intervals` | array of objects | Where acquired samples exist. Never empty. |
| `time_regularization` | object or `null` | `null` when the source declared uniform sampling; otherwise how timestamps were placed on the grid (5.5). |
| `rate` | number | The exact served rate, never rounded. |

Each interval has `start` (first sample index), `stop` (one past the last), and `source_time` (the time of its first sample as the source states it, or `null`).

- A continuous recording has exactly one interval.
  A store therefore states continuity, instead of implying it by saying nothing.
- A sample outside every interval was never acquired, and a reader must not return it as data.
- Chunks that lie wholly inside a gap are never written.
  Zarr reads an absent chunk as the fill value, so a gap of any length costs no storage.
- `source_time: null` means the order is known and the elapsed time is not,
  as with a BrainVision "New Segment" marker with no date, an EEGLAB `boundary` event, or concatenated runs.
  The interval is placed directly after the previous one.
  Grid times from there on are a convention, and a reader that reports them must say so.
- A reader must not filter, resample, epoch or interpolate across an interval boundary.
  A writer resamples each interval on its own.
- A writer should not write more than 65,536 intervals in a group; a signal more fragmented than that is a `timestamped` signal.

An EDF+D recording like the one in section 3.2, with 19 channels at 250 Hz and a pause from 60 to 90 seconds, has these group attributes (illustrative numbers; attributes not shown are unchanged from version 2):

```json
{
  "kind": "uniform",
  "modality": "EEG",
  "rate": 250.0,
  "n_channels": 19,
  "n_samples": 60000,
  "start_time": 0.0,
  "valid_intervals": [
    { "start": 0, "stop": 15000, "source_time": 0.0 },
    { "start": 22500, "stop": 60000, "source_time": 90.0 }
  ],
  "time_regularization": null
}
```

With 1,000-sample chunks, chunks 15 to 21 do not exist, and chunk 22 holds 500 filler samples followed by 500 valid ones.

### 5.4 A declared missing value [D4]

Every signal array carries a required attribute `missing_value`: the stored value that means "no sample here".

| Data type | `missing_value` | Effect |
| --- | --- | --- |
| `int16` | `-32768` | Data codes span `[-32767, 32767]`. |
| `int32` | `-2147483648` | Data codes span `[-2147483647, 2147483647]`. |
| `float32`, `float64` | `"NaN"` | None. |
| any | `null` | Every stored value is data (allowed only for a bit-exact copy, 6.3). |

- When `missing_value` is not `null`, the array's Zarr `fill_value` must equal it, so an absent chunk decodes to missing.
- A reader returns a missing sample as missing (NaN, a mask, or a range list), never as `missing_value * scale + offset`.
- Non-finite source samples in an integer store become the missing value.
  This replaces the version 2 behavior and closes its open question 6, because the replaced samples can be located.
- `valid_intervals` describes the acquisition (the recorder was off),
  and `missing_value` describes one channel at one sample (a sensor off, a dropped packet).
- NEMAR's profile always reserves the code.

### 5.5 Jittered streams: kept as measured by default [D5]

The format permits two homes for a stream with a nominal rate and a timestamp per sample.
The first keeps the stream as measured, in a `timestamped` group with `nominal_rate` set, and loses nothing about timing.
The second regularizes it, in a `uniform` group whose `time_regularization` records the method (`index_order` or `interpolated`), the nominal and effective rates, and the largest and root mean square timing error in seconds.
When values were interpolated, every channel says so (6.4).

NEMAR's profile keeps such streams as measured by default, and regularizes only on request with the error recorded.

### 5.6 The `timestamped` kind

A `timestamped` group holds an irregular signal, a sparse signal with a value, or a jittered stream kept as measured.

```
<name>/                 group, kind "timestamped"
  zarr.json             group attributes, including channels[]
  time/                 float64, shape [n_samples], seconds on the recording timeline
  values/               shape [n_channels, n_samples]
  time_index/           float64, shape [n_chunks]: the first time of each chunk
```

- It has no array named `0`, no `rate` attribute and no `view` group.
- Sample `i` of every channel in the group was taken at `time[i]`; channels that do not share timestamps go in separate groups.
- `nominal_rate` is the rate the source declared, or `null`.
  `effective_rate` is informative; a reader must not compute sample times from it.
- `continuity` is `"continuous"`, `"step"`, `"instantaneous"` or `"unknown"` (the names follow NWB), and a reader must not interpolate a group that is not `"continuous"` without saying so.
- The `time` array carries its own `derivation` list: `clock_synchronized`, `dejittered`, `deduced`, `sorted`, or empty when the values are the source's own timestamps shifted to the origin.
- A window read fetches `time_index` (one request), searches it, and fetches the matching `time` and `values` chunks.
- The `time` array costs 8 bytes per sample before compression.
  For a 64-channel 16-bit stream that is about 6% on top of the values; for a 4-channel stream it is 100% (arithmetic; compression not measured).
- A point process with no value, such as a marker, is an event and goes in `events`.

A cuff blood pressure taken about every five minutes beside a four-hour EEG recording (illustrative; `channels[]` omitted):

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
  "chunk_samples": 1000
}
```

The root then lists `"channel_groups": ["eeg_250hz"]` and `"timestamped_groups": ["bp_cuff"]`.

### 5.7 Four layers of reader safety [D1]

No single omission should let a reader misread.

The first layer is the version.
A writer that implements this proposal writes `format_version` 3 for every store, including a plain continuous recording.
A reader must refuse a version above the highest it implements; biosigIO 1.2.13 and earlier refuse 3 (verified in its source by the design research, 2026-11-20).

The second layer is the kind.
A reader reads `kind` before any array, refuses a kind it does not implement, and never infers a kind from a name or from which children exist.
A new kind requires a new `format_version`.

The third layer is structure.
A `timestamped` group is not in `channel_groups` and has no `0` array and no `rate`,
so a reader that skips both checks above gets a missing-node error instead of wrong times.
This layer exists because some deployed readers check neither the format name nor the version; our own server-side read path is one.

The fourth layer is refusal inside a uniform group.
A reader that does not implement `start_time`, `valid_intervals` or `missing_value` must refuse a group where one is in effect
(a nonzero start, more than one interval or a `null` `source_time`, a declared missing value), with an error that names the feature.
The conformance suite tests each refusal.

### 5.8 Events and the onset-to-sample rule [D10]

- For a `uniform` group, the sample nearest an onset is `i = floor((onset - start_time) * rate + 0.5)`.
  If `i` falls outside the array or outside every valid interval, the event has no sample in that group, and a reader says so instead of clamping.
- For a `timestamped` group, it is the first `i` with `time[i] >= onset`.
- The `events` group gains a required attribute `onset_source_basis`:
  `"timeline"` (the source gave onsets on the recording timeline, as EDF+ annotations do),
  `"concatenated"` (the source counted onsets in gap-free samples and the writer mapped them through `valid_intervals`),
  or `"unknown"`.
  With more than one interval, a reader needs this attribute to align events correctly.

### 5.9 How source features map

| Source feature | In a version 3 store |
| --- | --- |
| Uniform continuous file | One `uniform` group per modality and rate; one interval. |
| EDF+D, BDF discontinuous | Intervals from the record start times; `source_time` set. |
| BrainVision "New Segment" markers | One interval per segment; `source_time` from the marker's date, else `null`. |
| FIF data skips, MEF3 gaps | Intervals from the skip or block table; a reader library's zero fill is not stored as data. |
| EEGLAB `boundary` events, concatenated runs | Adjacent intervals with `source_time: null`. |
| Signals at different rates | One `uniform` group per rate (as in version 2). |
| Streams that start at different times | `start_time` per group. |
| XDF stream with a nominal rate | `timestamped` with `nominal_rate`, or `uniform` with `time_regularization`. |
| XDF stream with nominal rate 0, numeric | `timestamped`, `nominal_rate: null`. |
| XDF string marker stream | `events`. |
| Per-sample time vectors (BIDS motion `LATENCY` channel, BIDS physio `timestamp` column) | The group's `time` array. |
| Sensor-off codes | `missing_value`. |

The design research also maps the General Data Format for biomedical signals (GDF), the Waveform Database format (WFDB) and the Shared Near Infrared Spectroscopy Format (SNIRF).
**Unverified:** those mappings were taken from format documentation and not tested against files.

### 5.10 Epoched sources [D12]

A source that holds only cut trials has no continuous timeline to restore.
The format can express it as adjacent intervals with `source_time: null`.
NEMAR's profile refuses epoched sources for now, and question 21 asks whether the format should accept them.

### 5.11 The back catalog [D2]

- Version 2 stores stay readable, as version 2.
  A reader treats a version 2 group as `uniform`, starting at 0, with one interval and no declared missing value, and should surface "continuity not recorded".
- We re-convert old stores from their sources through the normal conversion queue, starting with recordings whose source can be discontinuous.
- A version 2 store is never upgraded by editing its metadata, because that would assert one valid interval without checking the source.
- The planned rename of the format tag from `biosigio-zarr` to `biosig-zarr` (nemar-cli issue 2217) still has to be reconciled with the rule that embedded metadata is never patched after it is written.
  The candidate is to fold the rename into the version 3 writer.

## 6. Proposal, part B: sample resolution

### 6.1 The store side: what the existing fields mean [D6]

No new store-side field is needed; the text defines what the existing ones mean.

Root `dtype` is the storage type.
Its name gives the width in bits and whether the type is integer or floating point.
It is the store default; a group may carry its own `dtype`, and an array's Zarr `data_type` must equal the resolved value.

The closed list of storage types becomes `int16`, `int32`, `float32`, `float64`.
`int32` gives 24-bit sources a home without requantization, and `float64` does the same for double-precision sources.
Zarr version 3 has no 24-bit integer type.
A signal reader may refuse a type it does not support, with a clear error.
NEMAR's profile stays `int16`.

For an integer type, `scale[c]` is the store's quantization step for channel `c`,
one digital step in the channel's unit, with a maximum error of half a step on a requantized sample.
`physical = digital * scale + offset` is unchanged.

### 6.2 The source side: five new fields [D9]

| Field | Where | Type | Meaning |
| --- | --- | --- | --- |
| `source_sample_type` | root default, channel override | string | The type of a decoded sample in the source: `int<N>` or `uint<N>`, `float32`, `float64`, or `"n/a"`. A BDF file is `int24`. |
| `source_adc_bits` | root default, channel override | integer or `null` | The bit depth of the analog-to-digital converter (ADC), only when the source states it. Never inferred from the sample type. |
| `source_step` | each channel | number or `null` | One source digital step in the channel's unit. `null` for a floating point source. |
| `source_offset` | each channel | number or `null` | The physical value of source digital code 0. |
| `source_digital_range` | each channel | `[min, max]` or `null` | The digital minimum and maximum the source declares. |

- The first two are required at the root, where `"n/a"` and `null` are allowed.
  A channel's own value, when present, overrides the root's.
  The channel value replaces the root value instead of multiplying it, because these fields are facts, not gain factors.
- The other three are required per channel, where `null` is allowed.
- The source's physical range is not stored, because it follows from the three per-channel fields.
- The storage width and the converter depth are separate fields because a 16-bit converter can sit in a 24-bit file.

A BDF channel recorded at 1024 Hz, capped to 250 Hz and requantized into a 16-bit store (illustrative; unchanged members omitted):

```json
{
  "label": "A1",
  "unit": "uV",
  "original_rate": 1024.0,
  "target_rate": 250.0,
  "scale": 0.0048,
  "offset": -12.5,
  "source_step": 0.03125,
  "source_offset": 0.0,
  "source_digital_range": [-8388608, 8388607],
  "derivation": ["resampled", "requantized"]
}
```

with `"source_sample_type": "int24"` at the root.
A reader comparing `scale` with `source_step` sees at once which side is coarser.

### 6.3 Bit-exact copies [D7]

When a channel is not resampled, not unit-converted, and the store's integer type holds the source's codes, a writer may copy the codes unchanged:
`scale` equals `source_step`, `offset` equals `source_offset`, and `derivation` is empty.
An EDF file at or below the rate cap can then be reproduced bit for bit.
If the source uses the type's most negative code as data, the array declares `missing_value: null`.

The format allows this.
We will decide whether NEMAR's writer does it after measuring how many recordings qualify.

### 6.4 Every lossy step is recorded: `derivation` [D8]

Each channel carries a required list `derivation`, in the order the steps were applied, from a closed vocabulary:

| Token | Meaning |
| --- | --- |
| `resampled` | Rate changed through an anti-alias filter. |
| `nearest_sample` | Rate changed by picking the nearest source sample (discrete channels). |
| `time_interpolated` | Values computed at grid times from timestamped samples. |
| `unit_converted` | Multiplied by a unit factor. |
| `requantized` | Stored integer codes are on a new lattice, not the source's codes. |
| `narrowed` | Stored at lower floating point precision than the source. |
| `nonfinite_to_missing` | Non-finite source samples stored as the missing value. |
| `nonfinite_zeroed` | Non-finite samples stored as physical zero. Version 2 stores only. |
| `gap_filled` | Samples at times the source did not record are stored as data. Only for sources whose reader fills silently. |

- An empty list means the stored codes are the source's codes.
- A profile may add tokens that contain a colon, such as `nemar:sss`; a reader treats an unknown token as "derived, in a way I do not know".

### 6.5 The content digest [D11]

NEMAR keys derived results on a digest of a store's level-0 values (the proposed NEMAR Architecture Decision Record (ADR) on a keyed derivative store, digest `nemar.store-content.v1`).
That digest has no notion of a missing sample, an interval or a time array.
We will write a second definition before keying any derivative on a version 3 store.
The digest is NEMAR's own machinery and not part of the format, but readers need to know the dependency exists.

## 7. The single-file form, `.bzx`

A directory-form store is thousands of small objects.
The packaged form holds the same store in one file.

- A `.bzx` file is a ZIP archive that holds exactly one biosig-zarr store, with the store's root at the archive's root.
- The root `zarr.json` is the first entry.
- Every entry is stored without ZIP compression, because chunks are already compressed by their Zarr codecs.
- Every entry is byte-identical to the corresponding object of the directory form,
  so a byte range inside an entry maps to a byte range of the file, and packing changes no chunk and no metadata.
- The archive always uses the ZIP64 extension.
- The ZIP archive comment carries the format name and `format_version`, so a reader can identify the file, and refuse a version it does not implement, without opening an entry.
- A `.bzx` file holds no other `.bzx` file and no other zipped Zarr hierarchy.
- A `.bzx` file is written once; a changed store is packed again.

Version 3 changes no packing rule, because `time`, `values` and `time_index` are ordinary arrays.
A never-written chunk has no entry.
A packer must not create one, and an unpacker must not treat its absence as damage.

No tool writes or reads `.bzx` today.
We are publishing this RFC before the first implementation, while the rules are still cheap to change.

### 7.1 Why the format and the package have separate names

The store and its package are two layers that can change separately.
`biosig-zarr` names the store and defines what its groups, arrays and attributes mean,
whether the store is a directory, an object-storage prefix, or the inside of an archive.
`.bzx` names the packing of one store into one file (entry order, no compression, the archive comment), and says nothing about what a sample means.

The package-specific items are up for comment for four reasons.

First, the commenters differ.
People who record and use biosignals of any kind care what a store says about a recording,
and people who build Zarr tools care whether the archive can be read in place.
Separate names let each group find its part.

Second, the names themselves can mislead.
One file-extension listing ties `.bzx` to other software (**Unverified:** known from a search result; the listing was not opened).
BioSig is a long-standing biomedical signal library, so `biosig-zarr` could be read as its Zarr backend, which it is not.

Third, a `.bzx` snapshot of a BIDS dataset changes the files around the package.
NEMAR's planned download command writes a copy of the BIDS tree with each data file swapped for a `.bzx`,
and rewrites sidecar fields that depend on the rate mechanically to match the store.
NEMAR's dataset-level events table, `events.parquet`, is never packed.
The events group inside the package stays light, and the full events stay in `events.tsv`.
Question 17 asks what `SamplingFrequency`, `RecordingType` and `RecordingDuration` should then say for a discontinuous or timestamped recording.

Fourth, the two layers need a versioning rule.
Should a fix to the packing rules raise `format_version`?
We recommend that one `format_version` cover both, because the archive comment already carries it and a reader should have one number to check.

## 8. Relation to OME-Zarr RFC-9

[OME-Zarr RFC-9](https://ngff.openmicroscopy.org/rfc/9/) proposes a zipped form of OME-Zarr with the suffix `.ozx`.
We credit it as prior art for `.bzx`, not as a dependency.

Our packing rules are our own text, and they do not follow later changes to RFC-9.
We see that independence as an advantage.
RFC-9 was at stage R4 ("authors reply to reviews"), not accepted, when checked on 2026-11-20, and it phrases most of its rules as recommendations.
A format that people archive data in needs fixed rules on a known date, and requirements a validator can test.
If RFC-9 changes, a `.bzx` file written today stays valid.

| RFC-9 rule | RFC-9 strength | In `.bzx` |
| --- | --- | --- |
| Exactly one hierarchy per archive | Required | Adopted: exactly one biosig-zarr store. |
| Archive root is the hierarchy root | Required | Adopted. |
| Not embedded in a parent hierarchy | Required | Adopted, and widened: no `.bzx` and no other zipped Zarr hierarchy inside. |
| No archives split into parts | Required | Not adopted yet; question 9. |
| ZIP64 | Recommended | Strengthened to a requirement, at any size. |
| No ZIP compression | Recommended | Strengthened to a requirement. |
| Sharding | Recommended | Changed: level 0 must be sharded; view arrays are not. |
| Root `zarr.json` first | Recommended | Strengthened to a requirement. |
| Other `zarr.json` entries next, breadth first | Recommended | Not adopted yet; question 9. |
| Suffix `.ozx` | Recommended | Changed: `.bzx`. |
| Archive comment holding a version under an `ome` key | Recommended | Changed: the comment must carry the format name and `format_version`; its encoding is question 10. |
| Optional flag that metadata entries come first | Optional | Not adopted: the order is a rule, not a flag. |
| (none) | | Added: every entry byte-identical to the directory form. |
| (none) | | Added: written once, never modified in place. |

**Unverified for this draft:** the RFC-9 column is taken from the program's research notes of 2026-11-20, which read the RFC source; we did not re-read it line by line for this draft.

## 9. Why not NWB on Zarr

We are asked this about our stores more than anything else.

NWB has a Zarr backend, [`hdmf-zarr`](https://nwb.org/tools/core/hdmf-zarr/), built on the Hierarchical Data Modeling Framework (HDMF).
It is a great tool.
It puts the whole NWB data model, with typed objects, links and a schema, on cloud object storage.
A laboratory that keeps each session's full record in NWB should use it.

Our data has a different shape.
NEMAR serves human, low-frequency biosignals organized the way BIDS organizes them:
one data file per recording, with its metadata in sidecar files next to it.
An NWB file holds its metadata inside.
A biosig-zarr store stands in for the data file and leaves the sidecars where they are, as the record.

ADR 0128 ("The Zarr serving copy is not an NWB container", accepted 2026-11-18) gives three reasons.

First, the scope differs.
An NWB file is the archival record of a whole session.
A store holds one recording's normalized signal, and the BIDS dataset around it is the record.
To conform, a store would need session, subject and device fields that we leave out on purpose, and it would duplicate metadata that BIDS already holds.
Two copies of metadata that can change will drift apart.

Second, the layouts do not match.
NWB stores a time series time-first, with one conversion factor for the series (electrical series can add a per-channel `channel_conversion`).
Our stores are channels-first, with a scale per channel.
NWB also links typed objects by reference, caches its schema in the file, and uses compound types that need Zarr's extension data types.
Its consolidated metadata would go stale every time we rewrite a store in place.

Third, the NWB Zarr specification was still moving.
On 2026-11-18 the maintainers described the backend as under development,
a recent release had switched to a layout that older readers cannot open,
and validation of Zarr files was incomplete.
Those facts will change, so check them again before relying on them.

What we do instead is export.
NEMAR builds NWB output on request from the store and the BIDS dataset at a known commit, and never keeps it as a second stored copy.
To keep that export simple, the dequantization formula matches NWB's `conversion` and `offset`, given per channel,
and event columns follow BIDS and HED, which the `ndx-hed` extension maps onto NWB.
The `continuity` vocabulary proposed in section 5.6 is NWB's.

We will revisit the decision when any two of these hold:
a named user needs NWB and has a concrete tool that reads it;
the Distributed Archives for Neurophysiology Data Integration (DANDI) accepts Zarr NWB uploads and the NWB Inspector validates Zarr;
`hdmf-zarr` is no longer marked as under development;
MNE-Python can read and write NWB;
NWB gains core types for scalp EEG or MEG.
Revisiting means building the export, not changing the store.

The decision itself is settled (section 11).
We ask for comment on whether its reasoning is fair and current, and on what an export would need to be useful (questions 33 to 35).

## 10. Alternatives considered

The design research lists twenty rejected alternatives.
The table gives the ones a commenter is most likely to propose.

| Alternative | Why it was not chosen |
| --- | --- |
| Postpone irregular signals to a later version | The format is not final; postponing only moves the break. A version bump, a required `kind` and the structural guard protect today's readers. |
| Add the features to version 2 as optional attributes | A version 2 reader would ignore `valid_intervals` and return filler as data: a silent misread. |
| Store samples gap-free with a segment table | A reader that skips the table misplaces every sample after the first gap, silently. That is the defect of section 3.2 made into a feature. On the grid, a reader that skips `valid_intervals` still has correct times. |
| One explicit time array for every group | 8 bytes per sample everywhere, a search before every window read, and no reader in the MNE family can represent it. Kept only where the data needs it. |
| A validity mask array per group | An array as large as a channel, for information that is a short interval list in almost every case. |
| NaN only, with floating point stores for anything with gaps | Doubles storage for 16-bit stores and excludes thin integer-only readers. |
| Always reserve an integer code, with no `null` | Makes bit-exact copies of full-range integer sources impossible. |
| Sparse signals inside the `events` group | A value with a unit, a scale and a missing value is a signal; `events` stays light. |
| Integer ticks with a tick rate for `time` | Exact, but one more conversion every reader must get right. Seconds in 64-bit floating point match `events/onset`, BIDS, XDF and NWB. |
| `valid_intervals` as Zarr arrays | Scales further, but costs a request on every window read and hides the gaps from someone reading `zarr.json`. |
| One store per continuous segment (the BEP047 working answer) | A store stands in for one data file; splitting it changes the file list of a dataset. |
| A `resolution` field for the store side | It would always equal `scale`. |
| A single "bit depth" field | Merges storage width and converter depth, which differ. |
| Free-text processing provenance | Cannot be tested; a closed token list can. |
| Names from the Climate and Forecast (CF) conventions (`scale_factor`, `add_offset`, `_FillValue`) | Not rejected on merit; it renames deployed attributes, so it is question 20. |
| For the package: a plain `.zarr.zip`, reusing `.ozx`, or tar | A plain zip has no rules to validate against; `.ozx` promises an OME-Zarr data model the store does not have; tar has no index for reads in place. |
| NWB on Zarr as the store | Section 9. |

## 11. Decided, and out of scope for comment

Each item below is closed, and the table names the record that closed it.
Arguments that one of these was decided wrongly are still welcome as issues; they will not change the outcome of this RFC.

| Decided | Record |
| --- | --- |
| A store is not an NWB container and will not be made NWB-conformant; any NWB output is a stateless export. | ADR 0128, Decision. |
| One package holds one recording. It is an alternative to a data file, not to a dataset. | ADR 0128, Context and Consequences; the specification, "Scope and non-goals". |
| Package entries are stored without ZIP compression, each byte-identical to the directory-form object. | The specification, "The packaged form"; nemar-cli issue 2216. |
| A package is written once and never edited in place. | The same two records. |
| NEMAR builds packages on the researcher's machine and stores none on its servers; the sidecar rewrite belongs to NEMAR's download command, not to the format. | nemar-cli issue 2216. |
| The license model: specification text under the World Wide Web Consortium (W3C) Software and Document License; schemas, test vectors and code under the Apache License 2.0. | Owner decision of 2026-11-18, recorded in ADR 0128 and neuromechanist/biosigio issue 179. |

## 12. What NEMAR's profile will do

The format permits more than NEMAR will use, and the table separates the two.

| Choice | Format | NEMAR's profile |
| --- | --- | --- |
| Storage type | `int16`, `int32`, `float32`, `float64` | `int16` for uniform groups |
| Missing value | Reserved code, or `null` for bit-exact copies | Always reserved |
| Jittered streams | As measured, or regularized | As measured; regularized only on request |
| Bit-exact copy | Allowed | Undecided until measured |
| Epoched sources | Expressible | Refused for now |
| Rate caps | A writer parameter, recorded | 250 Hz for EEG and MEG; 1000 Hz for iEEG and EMG |

## 13. Questions for commenters

Answer any subset.
A short answer with a real file behind it is worth more than a long one without.

**The format as a whole**

1. Is anything in the version 2 text ambiguous enough that two careful implementers would write different stores?
2. Sampling rates that are not integers are rounded in group names and grouping keys today (open question 5). Do you have recordings where that matters?
3. Should the core allow codecs other than blosc with zstd for level 0, at the cost of thin readers (open question 14)?
4. `unit`, `channel_type` and `modality` are free-form strings (open question 11). Which vocabulary would you want them bound to?
5. Should the format be declared as a registered Zarr convention in root attributes, and what should the declaration look like (open question 4)?
6. Should the absolute start time of a recording have a defined attribute, given that it can identify a person (open question 10)?
7. What would stop you from writing a reader in your language or tool?

**The package (`.bzx`)**

8. This proposal requires what RFC-9 only recommends (ZIP64 always, root entry first). Does that lock out a tool you rely on?
9. Should split archives be forbidden, and should all `zarr.json` entries precede chunk entries in breadth-first order?
10. What should the archive comment's encoding and shape be?
11. Should entry order, timestamps and attributes be fixed, so that two tools packing one store produce identical bytes?
12. Is a whole-file checksum, a digest manifest or a signature needed before `.bzx` files circulate, and where should it live?
13. Should the packing rules share `format_version` with the store, as recommended, or have a version of their own?
14. Do you need to read a remote `.bzx` over HTTP range requests, or only local files?

**Names**

15. Does `.bzx` collide with anything you use?
16. Is `biosig-zarr` likely to be confused with the BioSig library, and does that matter?

**Irregular and sparse series**

17. For a discontinuous or timestamped recording in a BIDS snapshot, what should `RecordingDuration`, `SamplingFrequency` and `RecordingType` say, and do your `events.tsv` onsets count gap time?
18. Are gaps on the grid, with a required interval list, acceptable as the only expression of discontinuity for uniform signals? Who has recordings where it fails (overlapping segments, clocks that step backward)?
19. Should `valid_intervals` be an attribute with a cap of 65,536, or arrays? What is the most fragmented recording you have?
20. Should the format adopt CF attribute names and dimension names so that xarray decodes a store without help?
21. Is `source_time: null` (order known, elapsed time unknown) the right home for undated BrainVision segments, EEGLAB `boundary` events and concatenated runs? Should epoched data be accepted this way, or refused?
22. Should integer stores always reserve the most negative code, or is `missing_value: null` for bit-exact copies worth a second case in every reader?
23. For jittered streams, which should a public archive serve: timestamps as measured, or a regular grid with the error recorded? Is the largest absolute timing error the statistic you would check?
24. Are `timestamped` groups with one shared `time` array enough for your irregular data? Does anyone need a time per channel inside one group?
25. Is `continuity` (`continuous`, `step`, `instantaneous`, `unknown`) the right vocabulary, and should it also apply to uniform groups?
26. Are seconds in 64-bit floating point precise enough for `time`, or do you need integer ticks?
27. Should a writer be allowed to store a recording whose time base is unknown at all, or must it refuse?

**Resolution**

28. Is the `derivation` vocabulary complete, and is an empty list a claim you would rely on?
29. Should `int32` and `float64` be core storage types, and may a signal reader refuse them?
30. Should `source_adc_bits` exist when almost no EEG format states it?
31. Is the pattern `int<N>` and `uint<N>` right for `source_sample_type`, or should the list be closed?
32. Do `source_step`, `source_offset` and `source_digital_range` let you restore the source header of the formats you export to? Which format do they fail for?

**Why not NWB**

33. Is section 9 a fair description of `hdmf-zarr` and NWB on Zarr today? What is out of date?
34. Would a stateless NWB export from a store be useful to you, and which tool would read it?
35. Are the revisit conditions the right ones?

## 14. How the decision will be made

We write these criteria before comments open, so they cannot be fitted to the comments.

The shepherd, who is the owner of the NEMAR platform, decides, and records the decision and its reasons in the RFC.
The comment window is 21 calendar days from the day the RFC is opened.
One extension of at most 14 days is possible, granted before the close with a stated reason.
Every comment gets a written response before the decision: accepted, rejected with a reason, or moved to a named follow-up.
The RFC ends accepted (the text becomes `3.0.0`), accepted with listed changes, or withdrawn.

The proposal is accepted if all of these hold at the close:

1. No silent misread stands.
   Nobody has shown a class of real recording that a conforming version 3 reader would return with wrong times or wrong values without an error.
2. Every real recording offered has a home.
   Each recording a commenter brings is either expressible in version 3 or named in the text as refused, with the reason.
3. The refusals are testable.
   Each of the four reader-safety layers has a conformance case that fails when the check is removed.
4. The package can be implemented from the text alone.
   Someone who did not write the text has confirmed that, or the gaps they found are closed.
5. No decided item was reopened by accident.
   Changes stay within what section 11 leaves open.

**Draft note for the owner:** whether acceptance also needs a working implementation, or two that share no code, is not settled.
The criteria above assume the RFC may open and close on the text and its test vectors.

## 15. What happens after acceptance

- The `3.0.0-draft.1` text is revised from the comments and tagged `3.0.0`.
- biosigIO gains a version 3 writer and reader; NEMAR's readers gain the interval, start time and missing value rules.
- NEMAR re-converts its stores through the normal queue, recordings whose source can be discontinuous first.
- Version 2 stores stay readable throughout.

None of that work is part of this RFC, and none of it starts before the decision.

## History of the format

Version 3 builds on a format NEMAR has served for months, which is now becoming its own specification.
The dates come from the Git history of biosigIO and from NEMAR's decision records, not from estimates.

| `format_version` | Started | What it changed | Records |
| --- | --- | --- | --- |
| 1 | 2026-05-31 | The first Zarr serving format: channel groups per modality and rate, sharded 16-bit level 0 with a scale and offset per channel, a minimum and maximum view pyramid, a light events group. `recording_metadata` was a string holding JSON text. | biosigIO commit "Add Zarr serving-format exporter and reader" (`cfad838`), first released in 0.4.0, when the package was still named emgio. |
| 2 | 2026-05-31 | `recording_metadata` became a JSON object, so a browser reader needs no second parse; the reader began to check the version and refuse a newer one. | biosigIO commit "Consolidate serialization exports + add docs" (`be6f60d`), first released in 0.6.0. |
| 2, grown by addition | 2026-07-07 to 2026-10-05 | New attributes with no version change: the count of replaced non-finite samples (biosigIO 1.2.1, 2026-07-07); the declared view pyramid and chunk geometry (1.2.6, 2026-09-02); unit handling from BIDS `channels.tsv` (1.2.7, 2026-09-02); the subject-information exclusion mark (1.2.11, 2026-10-05). | The specification, "What changes the version"; biosigIO release tags. |
| 2, specified | 2026-11-18 | No change to stores. The layout was written down as a specification that implementations follow, named `biosig-zarr`, with `.bzx` proposed. | ADR 0128 (accepted 2026-11-18); the pre-beta specification on docs.nemar.org (nemarOrg/docs pull request 122); tag `2.0.0`. |
| 3 (proposed) | This RFC | The time model (group kinds, `valid_intervals`, `missing_value`, `start_time`) and source resolution (`source_*` fields, `derivation`). | This document; tag `3.0.0-draft.1` when it opens, `3.0.0` only if accepted. |

NEMAR decisions that shaped how stores are made, each an accepted ADR:
only raw recordings are converted (2026-08-20);
MEG recorded with internal active shielding is corrected before serving, or declined (2026-08-20);
bounded streaming is the default conversion path (2026-08-22);
the conversion queue stamps the engine version that made each dataset's stores (2026-09-01).

**Current scale, measured 2026-11-20 at 18:23 Coordinated Universal Time (UTC).**
NEMAR serves 231,259 stores across 836 datasets, out of 910 public datasets.
We measured this read-only, from the public catalog:

```
curl -A "<a named client>" "https://api.nemar.org/datasets?limit=100&offset=N"    # N = 0, 100, ..., 900
```

summing `zarr_store_count` over the 910 rows returned, and counting the rows where it is above zero.
The catalog field is the store count of each dataset's published index; we did not re-count the indexes themselves.

**Not measured:** how many stores are at each `format_version`.
The catalog does not carry the version, and reading it would mean opening each store.
We infer that every served store is version 2,
because biosigIO has written version 2 since release 0.6.0 on 2026-05-31, and the earliest conversion timestamp in the catalog today is 2026-06-12.
NEMAR's own repository history before 2026-09-10 was not available to this draft (a shallow checkout), so this draft does not state the date NEMAR first served a store.

## 16. Verified, and not

**Verified for this draft on 2026-11-20:**

- The quoted specification text, from the Markdown mirror fetched that day.
- ADR 0128, read in full.
- The EDF+D and BrainVision behavior of section 3.2, from the recorded outputs of the reproduction (MNE-Python 1.12.1 and 1.13.2, biosigIO 1.2.13); the reproduction was not re-run.
- That the two cited issues exist and are open.
- The `format_version` dates, from biosigIO's Git history and tags.
- The store and dataset counts.

**Taken from the program's research of the same day, and not re-checked:**

- RFC-9's rules and its R4 status (section 8).
- The behavior of biosigIO's and NEMAR's readers described in 5.7.
- The format survey behind 5.9, including GDF, WFDB and SNIRF.
- What each BIDS thread says (the six issues and pull requests were confirmed to exist with matching titles on 2026-11-20; their content is summarized from earlier research, not re-read).

**Unverified or illustrative:**

- How many recordings NEMAR holds are affected by the gap defect.
- The `.bzx` file-extension collision.
- Every number in the JSON examples.
- The storage overhead percentages for `time`.
- The count of stores per `format_version`.

## 17. References

- The specification, version 2: <https://docs.nemar.org/formats/biosig-zarr/>
- NEMAR's store contract and format stability policy: <https://docs.nemar.org/platform/zarr/store-contract/>, <https://docs.nemar.org/platform/zarr/format-stability/>
- biosigIO: <https://github.com/neuromechanist/biosigio>
- The gap defect: <https://github.com/neuromechanist/biosigio/issues/180>, <https://github.com/mne-tools/mne-python/issues/13429>
- OME-Zarr RFC-9: <https://ngff.openmicroscopy.org/rfc/9/>
- `hdmf-zarr`: <https://nwb.org/tools/core/hdmf-zarr/>, <https://github.com/hdmf-dev/hdmf-zarr>
- BIDS threads: issues [1771](https://github.com/bids-standard/bids-specification/issues/1771), [1796](https://github.com/bids-standard/bids-specification/issues/1796), [2313](https://github.com/bids-standard/bids-specification/issues/2313) and [2463](https://github.com/bids-standard/bids-specification/issues/2463); the BEP047 pull request [2231](https://github.com/bids-standard/bids-specification/pull/2231) and its community review [2568](https://github.com/bids-standard/bids-specification/issues/2568)
- Zarr version 3 core specification and the sharding codec: <https://zarr-specs.readthedocs.io/en/latest/v3/core/index.html>, <https://zarr-specs.readthedocs.io/en/latest/v3/codecs/sharding-indexed/index.html>
