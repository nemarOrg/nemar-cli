# Irregular sampling and sample resolution for biosig-zarr (RFC-0001 input)

Checked on 2026-11-20.
Read-only research; nothing was written to any repository or to GitHub.

Inputs read first:
the pre-beta draft at https://docs.nemar.org/formats/biosig-zarr.md (fetched 2026-11-20, `format_version` 2, written against biosigIO 1.2.13),
and ADR 0128 (`.context/decisions/0128-the-zarr-serving-copy-is-not-an-nwb-container.md`).

Abbreviations, defined once:
European Data Format (EDF), EDF Plus (EDF+), BioSemi Data Format (BDF), General Data Format for biomedical signals (GDF),
Waveform Database (WFDB), Extensible Data Format (XDF), Multiscale Electrophysiology Format version 3 (MEF3),
Neurodata Without Borders (NWB), Shared Near Infrared Spectroscopy Format (SNIRF), Functional Image File Format (FIF, the Neuromag/MEGIN format),
Climate and Forecast conventions (CF), Brain Imaging Data Structure (BIDS), BIDS Extension Proposal (BEP),
analog-to-digital converter (ADC), least significant bit (LSB), not-a-number (NaN), Lab Streaming Layer (LSL).

---

## 0. What the draft already does, lacks, and would conflict with

**Does.**

- One uniform time axis per channel group: "Level 0 is uniformly sampled. Sample `i` of a group lies `i / rate` seconds after the start of the recording" (draft, Time axis).
- Multiple rates already coexist as multiple channel groups, one per (modality, rounded source rate), named `<modality>_<rate>hz`.
- An `events` group (onset, duration, code, `label_map`), deliberately light.
- Storage type at store level (`dtype`, `int16` or `float32`), per-channel `scale` and `offset`.

**Lacks** (the draft's own open questions):
#5 non-integer rates are rounded in group keys;
#6 replaced non-finite samples are counted, not located;
#9 "A recording that is not continuous has no representation";
#10 no absolute start time attribute;
#13 no `dimension_names`;
#16 no onset-to-sample rule.

**Would conflict with.**

- "The root group MUST NOT contain child nodes other than the channel groups named in `channel_groups` and the `events` group."
  biosigIO 1.2.13's reader takes every root child except `events` as a channel group (`biosigio/importers/zarr.py:75`),
  and reads `0` assuming `i / rate` timing (`biosigio/importers/zarr.py:84-104`).
  So a new root node breaks deployed readers, and any change to what a level-0 column means needs a `format_version` bump under the draft's own rule
  ("A change that makes a reader conforming to this page return wrong data ... MUST increase `format_version`").
- New attributes and new children *inside* a channel group are ignored by that reader, which is the safe place to add things.
- ADR 0123's store content digest covers level-0 values (C x S binary64 values, channel-major); a design that changes level 0 or adds a time array needs that digest definition extended.
- ADR 0128: no participant/session fields, no verbatim sidecar JSON. Neither design below needs them.

**A live defect found while checking (inferred from code reading, not reproduced):**
MNE 1.12.1 reads and discards the 44-byte EDF reserved field where `EDF+D` is declared (`mne/io/edf/edf.py:1157-1162`), and has no discontinuity handling anywhere in `mne/io/edf/`.
biosigIO routes a pyedflib "discontinuous" refusal to that MNE fallback (`biosigio/importers/_edf_tolerant.py:19-20, 110, 149-150`).
An EDF+D file therefore becomes a store whose samples after each gap are placed too early, while EDF+ annotation onsets (absolute, from the time-stamped annotation lists) are not; events after a gap would be misaligned.
BrainVision "New Segment" markers after the first are kept as annotations (`mne/io/brainvision/brainvision.py:354-355, 1016`) and the data is concatenated, so the same shift applies there.
By contrast, FIF skips and MEF3 table-of-contents gaps are already placed on the time grid by MNE, zero-filled, and annotated `BAD_ACQ_SKIP` (`mne/io/fiff/raw.py:154-166, 287-320`; `mne/io/mef/_utils.py:289-340`), and biosigIO's MEF3 importer copies those annotations into events (`biosigio/importers/mef3.py:21-24, 90-106`).
Recommend a test with a synthetic EDF+D file before RFC-0001 cites this.

---

## A. Irregular and sparse time series

### A.1 How existing formats handle it

| Format | Discontinuity (gaps) | Per-signal rates | Truly irregular / sparse samples |
| --- | --- | --- | --- |
| EDF | None; data records are contiguous. | Yes: samples per data record per signal. | No. |
| EDF+ | `EDF+D` in the reserved field: "subsequent data records need not form a continuous recording"; every record's first annotation (time-keeping TAL) gives its start in seconds after file start. Samples are equally spaced within a record only. | As EDF. | Record duration 0 is allowed only for annotation-only files, and for EDF+D files with one sample per signal per record, which gives one timestamp per sample (a de facto irregular mode). |
| BDF / BDF+ | Same structure as EDF/EDF+ with 24-bit samples (BDF+ per the EDFbrowser description). | As EDF. | As EDF+. |
| GDF 2.x | Event type `0x7ffe` "start of a new segment (after a break)" (biosig `eventcodes.txt`). | Yes: "Samples Per Record" per channel. | Yes: a channel with samples per record = 0 is "sparse (non-equidistant) sampling"; its samples live in the event table (mode 3, `{TYP,POS,DUR,CHN}`) as type `0x7fff`, with the value in the `DUR` field, scaled by that channel's physical/digital min/max. Intermittent sensors can instead write values outside `[DigMin, DigMax]` while off. |
| GDF 3 | Not separately verified; believed to keep the 2.x sample and event model and extend header 3. | | |
| BrainVision | "New Segment" markers carry a wall-clock date; data on disk is concatenated. `SegmentationType=MARKERBASED` marks epoched exports. | One `SamplingInterval` (microseconds) per file. | No. |
| WFDB | Multi-segment records; variable-layout records may contain null segments named `~` whose samples read as `WFDB_INVALID_DATA`. | Yes: "samples per frame" gives integer multiples of the frame rate ("non-integer multiples ... are not supported"). Counter frequency and base counter give a secondary clock. | No. |
| XDF | Each sample may carry its own timestamp. | One `nominal_srate` per stream; streams are independent. | `nominal_srate` "must be 0" for irregular streams; each sample has an optional 8-byte double timestamp (leading byte 0 or 8). `ClockOffset` chunks map stream clocks to a common clock. Inferring missing timestamps from the previous one plus 1/`nominal_srate` is reader practice (pyxdf), not spec text. |
| MEF3 | Data blocks carry start times in microseconds of Coordinated Universal Time (uUTC) and a discontinuity flag; the table of contents records each block's start sample and time (MNE turns gaps into `BAD_ACQ_SKIP`). | Per channel. | No (but blocks can be arbitrarily sparse in time). |
| FIF | `FIFF_DATA_SKIP` entries between buffers; MNE reads them as zeros on the sample grid and annotates `BAD_ACQ_SKIP`. | One `sfreq`. | No. |
| NWB | Separate `TimeSeries`, or `timestamps`. `continuity` attribute: "continuous", "instantaneous", "step". | Per `TimeSeries`. | `TimeSeries` has optional `starting_time` (float64, with `rate` as float32) or optional `timestamps` (float64 seconds, one per sample). The schema text implies but does not state exclusivity. For instantaneous events the schema recommends an `EventsTable`. |
| hdmf-zarr | Inherits NWB. | | `timestamps` becomes an ordinary one-dimensional Zarr array; `starting_time` a zero-dimensional array. The storage docs give only the general mapping (datasets to arrays, scalars to shape `()`, attributes as JSON), not TimeSeries specifics: inferred. |
| SNIRF | Not modeled. | Per `data(j)` / `aux(j)` block. | `time` is either the full vector ("does not need to be equal spacing") or `[start, spacing]`. MNE estimates a rate and warns that it "does not currently support SNIRF files with non-uniformly-sampled data" (`mne/io/snirf/_snirf.py:574-595`). |
| Neo | `Segment` objects partition a `Block` in time. | Per signal. | `AnalogSignal` (regular: `sampling_rate`, `t_start`) versus `IrregularlySampledSignal` (explicit `times`); `Event`, `Epoch`, `SpikeTrain` for point data. From documentation knowledge, not re-fetched. |
| BIDS EEG/iEEG/MEG | `RecordingType`: "continuous", "epoched", "discontinuous" ("multiple segments of different length, for example due to a pause in the acquisition"). EDF+ and BDF+ files are permitted. | `channels.tsv` optional `sampling_frequency` column; sidecar `SamplingFrequency` is "of all the data in the recording". | No. |
| BIDS physio | Separate files per rate: "Recordings with different key metadata MUST be split into separate files" with `recording-<label>`. `StartTime` per file. | One `SamplingFrequency` per file. | A `timestamp` column is allowed, and `physioevents.tsv` `OnsetSource` can name it, or be `"n/a"` meaning row indices. |
| BIDS motion | `acq_time` in `scans.tsv` with fractional seconds. | Per tracking system. | "If a system has uneven sampling rate behavior, the `LATENCY` channel can be used"; `SamplingFrequencyEffective` "can be determined if timestamps per sample are provided"; `MissingValues` ("NaN", "0"). |
| CF / xarray | Coordinates are explicit arrays, so non-uniform time is native. Discrete sampling geometries (CF chapter 9) store collections of time series as orthogonal, incomplete multidimensional, contiguous ragged, or indexed ragged arrays. | | Ragged arrays are the CF answer to sparse time series. Zarr v3 has no core sparse array type; absent chunks read as the fill value, and the sharding codec marks an empty inner chunk with offset and size `2^64 - 1`. |

### A.2 BEP047

- **What it is:** BEP047, "Audio/video recordings for behavioral experiments" (`_audio` and `_video` suffixes in `beh/`).
  Leads: Benjamin Dichter; BIDS maintainer: Seyed Yahya Shirazi.
  Source: `bids-standard/bids-website` `data/beps/beps.yml`, entry `number: '047'` (checked 2026-11-20).
- **Document:** pull request https://github.com/bids-standard/bids-specification/pull/2231 ("[ENH] BEP047 - Add audio/video recordings to behavioral experiments"), open, created 2025-10-25, last updated 2026-11-19;
  preview https://bids-specification--2231.org.readthedocs.build/en/2231/modality-specific-files/behavioral-experiments.html;
  origin issue https://github.com/bids-standard/bids-specification/issues/1771;
  examples pull request https://github.com/bids-standard/bids-examples/pull/523.
- **What it says or debates about irregular timing:**
  - Issue #1771, 2024-04-22: a commenter asked whether non-contiguous recordings (video stopped and resumed) go in one file or several, quoting the EDF+ discontinuous mode.
    The lead answered: separate runs, each start time in `scans.tsv`.
    Another maintainer suggested runs, or broadening the `split`, `part` or `chunk` entities.
  - The pull request rewrites `split`: parts "form one recording with a single timeline", and all parts listed in `scans.tsv` MUST share one `acq_time`.
    Alignment between files comes from `scans.tsv`; "If no `scans.tsv` file is present, the alignment is undefined."
  - `VideoFrameRate`: "For variable rate videos, this value should be the nominal frame rate."
    That is the only variable-rate provision; there is no per-frame timestamp field.
  - It adds `AudioBitDepth` ("Number of bits per sample ... for example, `16`, `24`, or `32`") and `ImageBitDepth`: the closest BIDS precedent for a bit-depth field name (relevant to part B).
- **Inference:** the irregular-sampling thread the owner refers to is the discontinuity discussion in #1771, not normative text in the pull request.
  BEP047's working answer is "one file per continuous piece, aligned by `scans.tsv`", with nominal rates for variable-rate media.
  The BIDS precedents for genuinely irregular samples are elsewhere: the motion `LATENCY` channel and `SamplingFrequencyEffective`, and the physio `timestamp` column with `OnsetSource`.
  BEP045, "Peripheral Physiological Recordings", is also listed and was not read for this report.

### A.3 Candidate designs for biosig-zarr

Assumptions for the cost figures: a 64-channel `int16` group at 250 Hz is 32,000 bytes per second before compression; a 4-channel EMG group at 1000 Hz is 8,000 bytes per second.

**D1. Explicit timestamps array per group** (`<group>/time`, float64 seconds, or int64 ticks plus a tick rate, shape `[n_samples]`).

- Storage: 8 bytes per sample per group before compression: plus 6% for the 64-channel EEG group, plus 100% for the 4-channel EMG group.
  Near-regular timestamps compress well only with a delta filter, which is not a Zarr v3 core codec (zarr-python offers numcodecs codecs as extensions; thin JavaScript readers may not).
- Window query: a search over `time` (about log2 of the number of chunks in fetches) before the signal read, unless a small per-chunk start-time index is added.
- BIDS: `SamplingFrequency` becomes nominal; maps to the motion `LATENCY` channel, the physio `timestamp` column, NWB `timestamps`, XDF, SNIRF option 1, Neo `IrregularlySampledSignal`.
  `events.tsv` onsets in seconds stay valid; converting an onset to a sample index needs the search.
- Streaming and chunking: appendable; chunk `time` with the same `chunk_samples` as level 0 so windows stay aligned.
- Tooling: xarray reads it natively as a non-uniform coordinate, once arrays carry `dimension_names` (draft open question 13); zarr-python and zarrita.js read the arrays; MNE cannot represent it (uniform `sfreq` only) and would need resampling.
- Compatibility: changes what a level-0 column means, so it needs `format_version` 3; old biosigIO readers would return wrong times.

**D2. Segments with per-segment start time and rate** (`<group>/segments`: `start_sample` int64, `n_samples` int64, `start_time` float64; level 0 holds only the recorded samples, concatenated).

- Storage: about 24 bytes per segment; negligible.
- Window query: one small fetch of the segment table, then direct indexing; cheap.
- BIDS: `RecordingType: "discontinuous"`; maps one to one onto EDF+D record onsets, MEF3 table of contents, FIF skips, WFDB null segments, GDF `0x7ffe`, BrainVision "New Segment".
  A per-segment rate is possible but unnecessary for every source surveyed (rates change across files, not within one).
- Streaming: the writer learns segments as it reads; the table is written at the end.
- Tooling: no reader understands it natively; MNE models the same thing as concatenated data plus `BAD_ACQ_SKIP` only when gaps are placed on the grid.
- Compatibility: old readers silently treat concatenated samples as continuous, the exact EDF+D defect above, so it needs `format_version` 3.

**D2b. Gaps on the uniform grid** (level 0 keeps `i / rate` timing; gap samples hold a reserved "no sample" value; whole chunks inside a gap are never written; a per-group list of valid intervals says where data exists).

- Storage: a chunk entirely inside a gap costs nothing (absent chunk or empty shard-index entry reads as the fill value); only the partial chunks at gap edges hold filler.
  With 1,000-sample inner chunks at 250 Hz that is at most 4 seconds of filler per gap edge.
- Window query: identical to today (direct index); a reader masks with the interval list or the reserved value.
- BIDS: `RecordingType: "discontinuous"`; `RecordingDuration` becomes wall-clock span; events onset-to-sample is `round(onset * rate)` with no search, which also closes draft open question 16.
- Streaming: the writer must not write gap chunks; the streaming exporter already fills memmaps chunk-wise, so this is feasible (inferred).
- Tooling: this is MNE's own model for FIF and MEF3 (zeros plus `BAD_ACQ_SKIP`), and xarray sees a regular axis; zarr-python and zarrita.js need no new code to read correct timing.
- Compatibility: an old reader returns correct times and sees filler as data, which matches today's MEF3/FIF behavior, so it can ship as an addition within version 2 if the reserved value is announced by a new attribute.
- Limits: gaps must be rounded to the sample grid (error at most half a sample period, 2 ms at 250 Hz, which is below what the resampler already moves); a clock that runs backward cannot be expressed; a gap of days costs no storage but makes `n_samples` large (int64 is fine).

**D3. Multiple rate groups in one store.**
Already implemented.
What is missing: a per-group start offset for groups that do not start at time 0 (BIDS physio `StartTime`, XDF streams, BEP047-style `scans.tsv` alignment), and non-integer rates (open question 5).
No storage cost; no tooling impact beyond reading one more attribute.

**D4. Sparse (time, value) or coordinate-format (COO) representation** for event-like numeric signals (GDF `0x7fff` channels, XDF `nominal_srate` 0 streams, spot measurements such as blood pressure every few minutes).

- Storage: proportional to the number of samples (8 bytes of time plus the value per sample; COO adds a 4-byte channel index).
- Window query: search over a small time array; usually one chunk.
- BIDS: closest to `physioevents.tsv` and `events.tsv` with a value column; there is no BIDS sparse continuous-signal type.
- Tooling: generic arrays; xarray as a one-dimensional variable with a `time` coordinate; MNE has no type for it.
- Fit with the draft: it must not go into the `events` group, which the draft keeps "deliberately light"; it is D1 applied to a small group, and is cleanest as a distinct group kind (`"sparse"` or `"irregular"`), which needs `format_version` 3 because old readers treat every root child as a uniform channel group.

**D5. NaN or fill-value masking.**

- `float32`: NaN is natural; a `float32` store "keeps NaN values as they are and does not flag the channel" today.
- `int16`: needs a reserved digital value. Precedents: WFDB's `WFDB_INVALID_DATA`, and GDF's rule that values outside `[DigMin, DigMax]` mark sensor-off or overflow.
  Reserving -32768 costs one code of 65,536 (quantization span 65,534 instead of 65,535).
  It also lets a store locate replaced non-finite samples (open question 6) instead of only counting them.
- Storage: dense; fully masked chunks are free as in D2b.
- BIDS: motion `MissingValues`. xarray: decodes CF `_FillValue` or `missing_value` only under CF names (the draft uses `scale`/`offset`, not CF `scale_factor`/`add_offset`, so xarray will not decode it automatically).
- D5 is the masking mechanism D2b uses; on its own it says nothing about timing.

### A.4 Recommendation for A

1. **Keep one uniform grid per channel group as the only layout for continuous signals.**
   Every deployed reader, the chunk arithmetic, the view pyramid, and the ADR 0123 digest assume it.
2. **Represent discontinuity as D2b plus D5:** gaps on the grid, never-written gap chunks, a reserved missing value
   (NaN in `float32`; -32768 in `int16` when a new group attribute such as `missing_digital_value` is present),
   and a per-group valid-interval list (`segments`: start and stop sample indices, plus the source wall-clock start of each when known).
   This is additive within `format_version` 2, matches MNE's model, and fixes the EDF+D and BrainVision segment shift at the source.
   The view pyramid builder must skip the missing value when computing min and max.
3. **Add a per-group start offset** (seconds of sample 0 relative to the recording origin, default 0), covering physio `StartTime`, multi-stream XDF, and split files.
4. **For jittered-but-regular sources** (LSL/XDF EEG, motion with `SamplingFrequencyEffective`): resample to the nominal grid at conversion, which the writer already does for rate caps, and record the effective rate.
   Do not store per-sample timestamps for them.
5. **Defer genuinely irregular and sparse signals to `format_version` 3,** as a distinct group kind with an explicit `time` array (D1/D4), chunked to match level 0 and listed in `channel_groups` with its kind,
   so old readers refuse them rather than misread them.
   Until then, a converter declines or omits such channels and records that it did.
6. Specify the onset-to-sample rule (`round((onset - start_offset) * rate)`) and that `events` onsets are on the grid time axis, including across gaps.

---

## B. Sample resolution

### B.1 Inventory: what the draft and the converter already record

From the draft (docs.nemar.org, fetched 2026-11-20; line numbers are in the Markdown mirror):

| Field | Level | Meaning today | Mirror line |
| --- | --- | --- | --- |
| root `dtype` | store | `"int16"` or `"float32"`: "the data type of every level-0 and view array in the store" | 195 |
| level-0 Zarr `data_type` | array | MUST equal root `dtype` | 296 |
| level-0 `scale` (array) | per channel | factor in `physical = digital * scale + offset`; for `int16` it *is* the quantization step (error at most `scale / 2`) | 356, 383-394 |
| level-0 `offset` (array) | per channel | additive term | 357 |
| `channels[].scale`, `channels[].offset` | per channel | copies of the above | 275-276 |
| `physical_formula` | array | literal description, not executable | 358 |
| `channels[].unit`, `bids_unit` | per channel | unit of physical values; sidecar unit not adopted | 269, 278 |
| `nonfinite_samples` | per channel | count of replaced samples | 277 |
| root `source_format` | store | source file format name, or `"n/a"` | 200 |
| root `recording_metadata` | store | free-form, importer-specific, not normative | 201, 491-494 |

In `float32` stores every `scale` is 1 and `offset` 0 (draft 380-381).

From biosigIO 1.2.13 (`/Users/yahya/Documents/git/emg/biosigio`, tag `v1.2.13`):

- The EDF importer reads per-channel `physical_min`, `physical_max`, `digital_min`, `digital_max` and keeps them on the in-memory channel (`biosigio/importers/edf.py:153-163, 445-450`);
  the tolerant reader does the same (`biosigio/importers/_edf_tolerant.py:194-197, 268-271, 636-639`).
- **Both Zarr exporters drop them.**
  The channel object written is `label, channel_type, modality, unit, prefilter, original_rate, target_rate, anti_aliased, usable_for_inference, scale, offset, row_index` plus optional `nonfinite_samples`, `bids_unit`
  (`biosigio/exporters/zarr.py:382-409`; `biosigio/exporters/zarr_stream.py:745-767`).
- The int16 quantizer spans each channel's own finite range after resampling (`biosigio/exporters/zarr.py:150-191`), so `scale` is a property of the store, unrelated to the source LSB.
- The BrainVision importer knows `BinaryFormat` only to compute bytes per sample (`biosigio/importers/brainvision.py:52, 371`); the per-channel resolution is applied by MNE and not kept.
- EDF `recording_metadata.file_info.filetype` is kept (`biosigio/importers/edf.py:123-128`); its comment reads "0: EDF, 1: EDF+, 2: BDF+", which does not match pyedflib's constants as I recall them (0 EDF, 1 EDF+, 2 BDF, 3 BDF+): inferred, worth checking.
- Aside: the streaming exporter writes `prefilter: "n/a"` unconditionally (`zarr_stream.py:750`) where the in-memory one copies the source (`zarr.py:388`).

From nemar-cli `origin/dev` `scripts/zarr/`: no field records resolution, bit depth or source digital ranges; the converter reads `SamplingFrequency` and `RecordingDuration` from sidecars for projections (`generate_zarr.py:3879-3898`) and otherwise relies on biosigIO.

**Conclusion:** the draft already records the *store's* storage type (`dtype`, store level) and the *store's* quantization step and scale/offset (`scale`/`offset`, per channel).
Nothing records the *source's* sample format, the source's quantization step, the source digital range, or the ADC bit depth.

### B.2 How the formats declare it

| Format | Storage type | ADC bits | Quantization step / scaling | Level |
| --- | --- | --- | --- | --- |
| EDF | int16, little-endian, two's complement | not stated | linear map from `[digital_min, digital_max]` to `[physical_min, physical_max]` (8-character ASCII fields; negative gain allowed) | per signal |
| BDF | int24 | not stated | as EDF | per signal |
| GDF 2.x | per-channel `GDFTYP` (int8 to uint64, float32/64/128, int24 = 279, uint24 = 535); "Each channel can use a different data type" | not stated | physical and digital min/max as float64; DigMin/DigMax "should indicate the overflow (saturation) values" | per channel |
| BrainVision | `BinaryFormat` per file: `INT_16`, `IEEE_FLOAT_32` (spec), `INT_32` (MNE also reads), `UINT_16` (spec; not in MNE's table) | not stated | per-channel resolution in the channel unit (default microvolts), no offset | type per file, step per channel |
| WFDB | per-signal format code (8, 16, 24, 32, 61, 80, 160, 212, 310, 311, FLAC 508/516/524) | per-signal "ADC resolution (bits)", default 12 | ADC gain (ADC units per physical unit), baseline, ADC zero | per signal |
| XDF | `channel_format` per stream: int8, int16, int32, int64, float32, double64, string | not stated | none | per stream |
| MEF3 | int32 samples, range-encoded-difference (RED) compressed | not stated | `units_conversion_factor` per channel | per channel |
| FIF | buffer type (short, int, float) | not stated | per-channel `range * cal` | type per buffer, scale per channel |
| NWB | HDF5/Zarr dtype | not stated | `conversion` and `offset` per series; `ElectricalSeries.channel_conversion` per channel, multiplied with the global `conversion`; `resolution` "Smallest meaningful difference ... e.g., the change in value of the least significant bit ... If unknown, use -1.0" | series default plus per-channel factor |
| SNIRF | `H5T_NATIVE_DOUBLE` or `H5T_NATIVE_FLOAT` | none | none | |
| CF | packed type (byte, short, int and unsigned variants) | none | `scale_factor`, `add_offset` (unpack: multiply then add), `valid_min`/`valid_max`/`valid_range`, `_FillValue` in the packed type | per variable |
| Zarr v3 | core: bool, int8 to int64, uint8 to uint64, float16/32/64, complex64/128; `r24` etc. only as opaque raw bytes; no int24 | none | none | per array |
| BIDS | none for EEG/MEG/iEEG; BEP047 proposes `AudioBitDepth`, `ImageBitDepth` | | | |

NWB is the one precedent for the owner's two-level question: a series-wide `conversion` and an optional per-channel `channel_conversion`, combined by multiplication.
(ADR 0128 says NWB has "one `conversion` and `offset` per series"; `channel_conversion` is per channel, multiplicative only, so that sentence is slightly incomplete.)

### B.3 The four concepts these conflate

1. **Storage data type:** how a stored sample is encoded (int16, int24, float32, ...).
2. **ADC bit depth:** how many bits the acquisition converter resolved; often smaller than the storage width (a 16-bit ADC in a 24-bit BDF, a 12-bit ADC in WFDB format 16) and usually not stated by EEG formats.
3. **Quantization step:** one LSB in physical units (EDF `(pmax - pmin) / (dmax - dmin)`, BrainVision resolution, NWB `resolution`).
4. **Scale and offset to physical values:** the linear map; equals the quantization step only when the stored integers are the ADC codes.

Each exists twice for a biosig-zarr store: once for the **source** (what was acquired) and once for the **store** (what was written after resampling and requantization).

### B.4 Recommendation for B

**Make the existing store-side fields explicit; do not duplicate them.**

- Root `dtype` is the store's storage type, store level.
  State that it is the default and the only value: Zarr already holds one `data_type` per array, and channels share one level-0 array, so a per-channel storage type is structurally impossible without splitting groups.
  If more types are allowed later (for example `int32` for 24-bit sources), allow them per group, with the array's `data_type` governing and root `dtype` describing the common case; do not add a second field.
- `scale` is the store's quantization step for integer `dtype`.
  State that in the spec ("for an integer `dtype`, `scale[c]` is one digital step in `unit`; maximum quantization error `scale[c] / 2`"), rather than adding a `resolution` field that would always equal it.
  For `float32`, state that quantization is float32 precision.

**Add source-side fields, because nothing carries them,** as part of the core derivation record (draft, Provenance), with a store-level default and a per-channel override:

| Field | Where | Type | Meaning |
| --- | --- | --- | --- |
| `source_sample_type` | root (default) and `channels[]` (override) | string from a closed list: `int8`, `uint8`, `int16`, `uint16`, `int24`, `uint24`, `int32`, `uint32`, `float32`, `float64`, `"n/a"` | storage type of the sample in the source file; the owner's "8, 16, 24 or 32 bit, integer or float" |
| `source_adc_bits` | root and `channels[]` | integer or `null` | ADC bit depth when the source states it (WFDB); `null` otherwise, never guessed from the storage type |
| `source_step` | `channels[]` only | number or `null` | one source LSB in the channel's `unit` (after any unit conversion the writer applied) |
| `source_digital_range` | `channels[]` only | `[min, max]` or `null` | source digital min and max, which GDF says mark saturation; needed to round-trip EDF, BDF and GDF headers |

- Combination rule: a reader takes a channel's member if present, else the root value, else unknown.
  Override, not multiplication: these are facts, not factors.
  A writer SHOULD write only the root value when every channel agrees, and per-channel values only where they differ (GDF, WFDB, mixed-source recordings).
- `source_step` and `source_digital_range` are inherently per channel in EDF, BDF and BrainVision, so they get no root default.
- Names follow the `source_*` prefix of the existing `source_format` and `source_rate_hz` rather than BEP047's `*BitDepth`, because "bit depth" conflates concepts 1 and 2; name the BIDS correspondence in the spec text instead.
  Do not reuse NWB's `resolution` name: NWB means the store-side step plus noise judgment.
- Optionally make the int16 quantizer aware of `source_step`: when the store's `scale` would be finer than the source LSB, the extra precision is fiction; when coarser, record it (already implied by `scale`).

**Conversion mapping.**

- EDF to store: `source_sample_type: "int16"`; per channel `source_step = (pmax - pmin) / (dmax - dmin)` and `source_digital_range = [dmin, dmax]`; `source_adc_bits: null`.
- BDF to store: as EDF with `"int24"`.
- BrainVision to store: `INT_16` to `int16`, `INT_32` to `int32`, `UINT_16` to `uint16`, `IEEE_FLOAT_32` to `float32`; `source_step` = channel resolution for integer formats, `null` for float (the resolution is then a multiplier, not a step); `source_digital_range: null`.
- Store (`int16`) to EDF: exact and lossless for the stored values: `digital_min = -32768`, `digital_max = 32767`, `physical_min = -32768 * scale + offset`, `physical_max = 32767 * scale + offset`.
  The only loss is printing the physical limits into 8 ASCII characters.
  With D5's reserved -32768, use `digital_min = -32767` and write gaps as EDF+D records.
- Store to BDF: as EDF, placing int16 codes in the 24-bit range (or requantizing a `float32` store to 24 bits).
- Store to BrainVision: BrainVision has no offset, so an `int16` store with nonzero offsets needs either `IEEE_FLOAT_32` or requantization around zero; `float32` stores map to `IEEE_FLOAT_32` with resolution 1.
- Round trip back to the source format: `source_sample_type`, `source_step` and `source_digital_range` let a writer restore the original header ranges, while the samples stay the store's (resampled, requantized) samples.

---

## Questions RFC-0001 should put to the community

1. Is "gaps on the uniform grid, with a reserved missing value and a valid-interval list" acceptable as the only way to express discontinuity, or do contributors need concatenated segments (D2) to avoid storing days of gap?
2. Should the `int16` profile reserve -32768 as "no sample", at the cost of one quantization code, so replaced and missing samples can be located?
3. Should genuinely irregular and sparse signals be in scope for this format at all (a `format_version` 3 group kind with a `time` array), or left to their source files and BIDS tabular files (`physio`, `physioevents`, motion `LATENCY`)?
4. For jittered streams (LSL/XDF), is resampling to the nominal grid with a recorded effective rate acceptable, or must original timestamps be preserved?
5. Should groups carry a start offset relative to the recording origin, and should that origin be the BIDS `scans.tsv` `acq_time`?
6. Is a closed vocabulary for `source_sample_type` (including the non-Zarr types `int24`/`uint24`) right, and should `float64` and `int32` stores be allowed, per group, for lossless-amplitude profiles?
7. Should the source ADC bit depth be recorded when no common EEG format states it, or only passed through when a source does (WFDB)?
8. Should the spec adopt CF names (`scale_factor`, `add_offset`, `_FillValue`) and `dimension_names` so xarray decodes stores natively, given the existing `scale`/`offset` names and deployed readers?
9. How should BIDS sidecars be rewritten for a discontinuous store in a `.bzx` download (`RecordingType`, `RecordingDuration`, `SamplingFrequency`)?

---

## Verified versus inferred (checked 2026-11-20)

**Verified by reading the source or specification text:**

- Draft content and line positions: https://docs.nemar.org/formats/biosig-zarr.md.
- ADR 0128 content (local file).
- BEP047 identity, leads, status, pull request dates, `split` rewrite, `VideoFrameRate` nominal-rate rule, `AudioBitDepth`/`ImageBitDepth`: `bids-website` `data/beps/beps.yml`; `gh pr view`/`gh pr diff` of bids-specification#2231; comments on bids-specification#1771.
- BIDS `RecordingType`, physio `StartTime`/`timestamp`/`OnsetSource`, the rule that physio files with different rates are split, motion `LATENCY`/`SamplingFrequencyEffective`/`MissingValues`, `channels.tsv` `sampling_frequency`, and the absence of a resolution field for EEG: bids-specification `master` (`src/modality-specific-files/*.md`, `src/schema/objects/metadata.yaml`, `columns.yaml`).
- EDF+ discontinuity, time-keeping annotations, zero record duration, 16-bit samples, min/max rules: https://www.edfplus.info/specs/edfplus.html.
- GDF types table, per-channel types, sparse sampling via `0x7fff`, DigMin/DigMax saturation semantics: GDF specification v2.51 (arXiv cs/0608052, PDF text); `0x7ffe` from the biosig `eventcodes.txt` mirror (https://raw.githubusercontent.com/donnchadh/biosig/master/biosig/doc/eventcodes.txt).
- WFDB format codes, samples per frame, ADC gain/baseline/resolution/zero, null segments: https://physionet.org/physiotools/wag/signal-5.htm and header-5.htm.
- XDF `nominal_srate` 0, `channel_format` list, optional per-sample timestamps, `ClockOffset`: https://github.com/sccn/xdf/wiki/Specifications.
- NWB `conversion`, `offset`, `resolution`, `continuity`, `starting_time`/`rate` (float32), `timestamps`, `channel_conversion`: nwb-schema `dev` `core/nwb.base.yaml`, `core/nwb.ecephys.yaml`.
- SNIRF `time` forms and the absence of a resolution field: https://github.com/fNIRS/snirf/blob/master/snirf_specification.md (document version 1.2.0-development).
- CF packing and discrete sampling geometries: cf-conventions `main` `ch08.adoc`, `ch09.adoc`.
- Zarr v3 fixed-size core types, `r*` opaque types, `dimension_names`, empty shard entries `2^64 - 1` read as fill value: zarr-specs `main` core and sharding documents.
- MNE 1.12.1 behavior (local install in another project's virtual environment): EDF reserved field discarded; FIF skips and MEF3 gaps zero-filled with `BAD_ACQ_SKIP`; BrainVision formats `INT_16`, `INT_32`, `IEEE_FLOAT_32` and "New Segment" handling; SNIRF non-uniform warning.
- biosigIO 1.2.13 source lines cited in sections 0 and B.1; nemar-cli `origin/dev` `scripts/zarr/` grep.

**Inferred or from prior knowledge, not re-verified:**

- That an EDF+D or multi-segment BrainVision file produces a time-shifted store in practice (code reading only; no file converted).
- XDF readers inferring missing timestamps from `nominal_srate` (pyxdf practice).
- MEF3 block discontinuity flag, int32 RED samples and uUTC block times (MEF3 specification not fetched; MNE's reader confirms `units_conversion_factor`, per-channel `sampling_frequency` and table-of-contents gaps).
- FIF `range * cal` scaling and buffer types (MNE knowledge, not re-read).
- BrainVision `UINT_16` in the Brain Products specification, and its default resolution unit.
- GDF 3 keeping the 2.x sample and event model.
- hdmf-zarr storing `timestamps` as a one-dimensional array (follows from its general mapping rules).
- Neo class semantics.
- xarray needing `dimension_names` to open Zarr v3 arrays, and its CF decoding applying only to CF-named attributes.
- pyedflib file-type constants.
- That D2b fits the streaming exporter without a memory cost.
- Storage percentages (simple arithmetic on assumed channel counts and rates; compression not measured).
