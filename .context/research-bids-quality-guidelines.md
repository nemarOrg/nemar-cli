# Research: BIDS data-quality and transparency guidelines for NEMAR submissions (2026-11-19)

> **Status:** research input, not a ruling.
> It proposes the item set for NEMAR's submission guidelines;
> adopting a tier, a preflight check or a gate rule is a separate decision.
> The same items are in machine-readable form in
> [`research-bids-quality-guidelines.json`](research-bids-quality-guidelines.json),
> so a future preflight check and the documentation page can be generated from one source;
> the item tables, the ranking and the enforcement table below are generated from that file, so edit the JSON, not the tables.
> **Scope:** this is metadata completeness at submission,
> distinct from the signal-quality metrics of the processing pipeline (proposed ADR 0134, #2297, which writes them to neuroschema's `dataQuality` extension).
> If preflight or gate results from this study are ever persisted, they need their own home, not `dataQuality`.

## Question

Which parts of the Brain Imaging Data Structure (BIDS) specification can a NEMAR submission never omit,
and which RECOMMENDED or OPTIONAL parts decide whether a dataset can be understood, reused, searched or visualized,
so that NEMAR should strongly recommend them at submission?

NEMAR is the Neuroelectromagnetic Data Archive and Tools Resource.
Other abbreviations, defined here once:
tab-separated values (TSV), JavaScript Object Notation (JSON), Hierarchical Event Descriptors (HED),
Digital Object Identifier (DOI), Open Researcher and Contributor ID (ORCID),
Software Package Data Exchange (SPDX) license identifiers,
anterior commissure-posterior commissure (ACPC) coordinate frame, Shared Near Infrared Spectroscopy Format (SNIRF),
Montreal Neurological Institute (MNI) template space, Uniform Resource Identifier (URI), and command-line interface (CLI).
Modality abbreviations are spelled out in the hosted-modality table.

The trigger was a spot check of public intracranial electroencephalography (iEEG) datasets on NEMAR:
datasets with every electrode coordinate `n/a`,
coordinate frame `Other` with the template named only in free text,
and, elsewhere, event codes reported without descriptions in sidecars.

Settled before this study and not reopened here:
for iEEG, `_electrodes.tsv` is REQUIRED and `_coordsystem.json` MUST accompany it,
so guidance never says "omit the file";
and the NEMAR viewer does not read coordinate frames from free text.

## Sources and versions

- BIDS specification **1.11.2** (`bids_version` in the published schema), schema version **2.0.0**,
  read from the machine-readable schema at `bids-specification.readthedocs.io/en/stable/schema.json`.
- Prose at tag `v1.11.2` of `bids-standard/bids-specification` (`src/`), read where a level is conditional or lives only in prose
  (file-level levels such as "this file is RECOMMENDED" are not in the schema's file rules for most companion files).
- BIDS validator: NEMAR pins `@bids/validator` **3.0.2** (`validator-version.json`),
  and the validator source was read at tag `3.0.2` of `bids-standard/bids-validator`
  (`src/issues/list.ts`, `src/schema/applyRules.ts`, `src/schema/tables.ts`, `src/validators/hed.ts`)
  for how requirement levels turn into issues.
  NEMAR runs it without a schema option, so it checks against its bundled `@bids/schema` **1.2.7**, which is BIDS **1.11.1**;
  that schema's `rules/checks` supplied the dataset-specific issue codes.
  For every item in this study the levels and checks are the same in 1.11.1 and 1.11.2.
  HED issues come from the bundled `hed-validator` 4.2.0, which reports them as `HED_ERROR` or `HED_WARNING` with the HED code as a subcode.
- NEMAR code, read on `origin/dev` at the time of writing:
  `src/lib/upload/preflight.ts`, `src/lib/bids-validator.ts`, `src/lib/upload/enrich.ts`, `src/lib/license.ts`,
  `backend/src/services/submission-gate.ts`, `shared/submission-minimums.ts`,
  the prescreen dispatch in `backend/src/routes/datasets/publication.ts`,
  and the public page `docs.nemar.org/policies/submission-standards/`.

## Method

1. Requirement levels were extracted programmatically from the schema:
   every rule under `rules/sidecars`, `rules/json` and `rules/tabular_data` was flattened to (rule, selectors, field or column, level, level addendum).
   Conditional levels (for example "required if `iEEGCoordinateSystem` is `Other`") were kept as conditions,
   and the prose was read for file-level requirements.
2. Validator behavior was read from source, not assumed (see [What the validator already reports](#what-the-validator-already-reports)).
3. Hosted modalities were counted from `api.nemar.org/datasets` (all pages; the `modalities` field).
4. Omission rates were measured on a **sample** of public datasets with read-only GETs of metadata files from `data.nemar.org`
   (directory listings with `?format=json`; at most 4 requests in flight, about 5 started per second, retries on transient failures).
   Per modality, up to 40 datasets were drawn at random from those listing the modality;
   modalities with fewer datasets (NIRS, EMG and motion) were read in full.
   The draw used a fixed seed, but its value was not recorded, and neither was the date of the reads
   (on or before 2026-11-19, the date of this document), so the sample cannot be redrawn exactly.
   For each sampled dataset the latest version was read:
   `dataset_description.json`, the root listing, `participants.tsv` and `participants.json`,
   and, for each sampled modality, the first subject that has that datatype,
   its first non-rest task recording, the sidecars that apply to it by inheritance (root, subject, session and datatype levels),
   its `channels.tsv`, `events.tsv` and `events.json`, and the position and coordinate files.
   A read that failed was recorded as unknown, never as absent.
   Rates are per sampled dataset, from one recording, so they describe how common a gap is, not how complete any single dataset is.
   Each item's `metric_definition` in the JSON says exactly what its rate counts.
   **Denominators.**
   The per-modality draws sum to 164 (40 EEG, 40 iEEG, 40 MEG, 27 NIRS, 11 EMG, 6 motion) against 163 datasets read,
   because NIRS, EMG and motion were read in full and one dataset, nm000284, lists both EMG and motion, so it was drawn twice;
   the random EEG, iEEG and MEG draws added no other overlap.
   iEEG and MEG recording items are out of 36, not 40:
   for 4 of the 40 iEEG draws and 4 of the 40 MEG draws no recording sidecar for that modality was found in the first subject,
   and those were recorded as unknown and left out of the denominator, per the rule above.
   The per-dataset log that would say which datasets these were, and why the reads came back empty, was not kept.
   Smaller denominators follow from the item: 155 datasets have a `participants.tsv`,
   151 recordings are non-rest task recordings, and 114 of those have an `events.tsv` with a categorical code column.
5. The iEEG coordinate items reuse an earlier spot check of 37 iEEG datasets
   (first `coordsystem.json` and the first rows of the first `electrodes.tsv` of each);
   that part is being classified separately and was not re-run.
   The other iEEG items were measured in the sample above.
   Two of its counts do not reconcile from what was recorded:
   14 of 37 datasets have only `n/a` in the electrode rows read,
   yet 16 of the 30 `Other` frames (out of 36 readable coordinate files) were classified as "no coordinates".
   If "no coordinates" meant exactly the all-`n/a` datasets, the second count could not exceed 14.
   The two counts came from different reads (rows of `electrodes.tsv` against the text of `coordsystem.json`),
   and the per-dataset records that would show which datasets differ were not kept,
   so both are reported as recorded and the separate classification should replace them.
6. Catalog-wide proxies (license strings, line frequency, placement scheme, age range) come from the fields of `api.nemar.org/datasets` for all 910 public datasets.
   These fields are filled by NEMAR's indexer, so a null means the indexer found nothing, which is close to, but not the same as, the field being absent.

Tiers:

- **T0**: BIDS REQUIRED; cannot be omitted.
- **T1**: BIDS RECOMMENDED or OPTIONAL, but without it the data cannot be understood, reproduced, searched or visualized; NEMAR strongly recommends it.
- **T2**: useful but not essential.

Where NEMAR's own policy already requires a BIDS-optional item (Authors, License, an ethics statement), the item stays T1 here and the table says that NEMAR already checks it.

## What NEMAR hosts

| Datatype | Datasets listing it | Datasets with only this datatype | Coverage here |
| --- | --- | --- | --- |
| electroencephalography (EEG) (`eeg`) | 654 | 564 | full table |
| intracranial EEG (iEEG) (`ieeg`) | 167 | 134 | full table |
| anatomical magnetic resonance imaging (MRI) (`anat`) | 80 | 0 | pointer |
| behavioral (`beh`) | 72 | 1 | pointer |
| magnetoencephalography (MEG) (`meg`) | 61 | 23 | full table |
| functional MRI (`func`) | 32 | 0 | pointer |
| near-infrared spectroscopy (NIRS) (`nirs`) | 27 | 23 | full table |
| electromyography (EMG) (`emg`) | 11 | 9 | full table |
| MRI field maps (`fmap`) | 11 | 0 | pointer |
| diffusion MRI (`dwi`) | 7 | 0 | pointer |
| motion (`motion`) | 6 | 0 | full table |
| perfusion MRI (`perf`) | 1 | 0 | pointer |

Total: 910 public datasets (583 OpenNeuro mirrors with `on` ids, 327 NEMAR-native with `nm` ids); one dataset lists no datatype.

The full tables cover every electrophysiology and motion datatype NEMAR hosts.
MRI and behavioral data appear almost only alongside a hosted electrophysiology modality
(no dataset is MRI-only), so they get a pointer at the end, not a table.

## T0 items in one line per modality

- **all**: `dataset_description.json` Name; `dataset_description.json` BIDSVersion; `dataset_description.json` GeneratedBy (REQUIRED when DatasetType is derivative); `dataset_description.json` DatasetLinks (REQUIRED when BIDS URIs are used); `README` file; `participants.tsv` participant_id (when participants.tsv exists); `events.tsv` onset, duration (when events.tsv exists); `every .json file` strict JSON (UTF-8, no raw control characters); `recording sidecar` TaskName.
- **eeg**: `_eeg.json` EEGReference, SamplingFrequency, PowerLineFrequency, SoftwareFilters; `_coordsystem.json` EEGCoordinateSystem, EEGCoordinateUnits; EEGCoordinateSystemDescription if Other (when coordsystem.json exists).
- **ieeg**: `_ieeg.json` iEEGReference, SamplingFrequency, PowerLineFrequency, SoftwareFilters; `_electrodes.tsv` file with name, x, y, z, size; `_coordsystem.json` iEEGCoordinateSystem, iEEGCoordinateUnits; iEEGCoordinateSystemDescription if Other.
- **meg**: `_meg.json` SamplingFrequency, PowerLineFrequency, DewarPosition, SoftwareFilters, DigitizedLandmarks, DigitizedHeadPoints; `_coordsystem.json` MEGCoordinateSystem, MEGCoordinateUnits; MEGCoordinateSystemDescription if Other (when coordsystem.json exists).
- **nirs**: `_nirs.json` SamplingFrequency, NIRSChannelCount, NIRSSourceOptodeCount, NIRSDetectorOptodeCount; `_coordsystem.json` NIRSCoordinateSystem, NIRSCoordinateUnits; NIRSCoordinateSystemDescription if Other (when coordsystem.json exists); `_optodes.tsv + _coordsystem.json` file pair (when channels.tsv is present).
- **emg**: `_emg.json` EMGPlacementScheme, EMGReference, SamplingFrequency, PowerLineFrequency, RecordingType, SoftwareFilters; EMGPlacementSchemeDescription if Other; `_coordsystem.json` EMGCoordinateSystem, EMGCoordinateUnits; EMGCoordinateSystemDescription if Other (when coordsystem.json exists); `_electrodes.tsv` name, x, y (when electrodes.tsv exists).
- **motion**: `_channels.tsv` file with name, component, type, tracked_point, units; `_motion.json` TaskName, SamplingFrequency.

## Item tables

Columns: the item (file and field or column), the BIDS level with any condition, the NEMAR tier,
the concrete benefit, what goes wrong when it is missing (a real example where one was seen),
whether the BIDS validator already reports it, and the measured omission rate in the sample.
For shared items the rate is broken down by the modality the recording was sampled for.
"Validator warns" refers to the validator's behavior read from source, described in the next section.
"Value quality" marks an item whose key or column already meets its BIDS level, where the item asks for a better value than BIDS demands.
Each row is an item of the JSON file, where it also has a stable `id`, a structured `target`, a `check` type and a `metric_definition`.

### Shared files (every modality)

| Item | BIDS level | Tier | Benefit | When missing | Validator warns | Missing in sample |
| --- | --- | --- | --- | --- | --- | --- |
| `dataset_description.json` Name | REQUIRED | T0 | Titles every listing, search hit and DOI record. | Short or slug titles are unsearchable; the gate already refuses names under 25 characters for native datasets. | yes: error when the key is absent; an n/a value passes; EMPTY_DATASET_NAME warning | not measured |
| `dataset_description.json` BIDSVersion | REQUIRED | T0 | Tells tools which rules the dataset was written against. | Catalog holds values that are not releases (for example `v1.2.1` in 15 datasets, `1.2` in 10). | yes: error when the key is absent; an n/a value passes; UNKNOWN_BIDS_VERSION warning for a value that is not a release | not measured |
| `dataset_description.json` GeneratedBy | RECOMMENDED; REQUIRED when DatasetType is derivative | T0 | Names the pipeline that produced derived data. | Processed data with no provenance cannot be reproduced. | yes: error for a derivative dataset | not measured |
| `dataset_description.json` DatasetLinks | OPTIONAL; REQUIRED when BIDS URIs are used | T0 | Resolves `bids:<name>:` URIs. | Unresolvable references. | no: the condition is prose the validator does not evaluate, so the key is treated as OPTIONAL | not measured |
| `README` file | REQUIRED in the prose definition; RECOMMENDED in the schema file rule | T0 | The only free-text explanation of what the dataset is and how it is organized. | A missing or stub README leaves every other field without context; NEMAR's policy already requires a substantive README. | yes: README_FILE_MISSING warning; README_FILE_SMALL warning at 150 bytes or fewer | 0% of 163 |
| `participants.tsv` participant_id | REQUIRED; when participants.tsv exists | T0 | Joins the table to subject folders. | Rows cannot be matched to data. | yes: PARTICIPANT_ID_MISMATCH error | not measured |
| `events.tsv` onset, duration | REQUIRED; when events.tsv exists | T0 | Places every event on the recording timeline. | Events cannot be epoched. | yes: TSV_COLUMN_MISSING error when the column is absent; n/a values pass | not measured |
| `every .json file` strict JSON (UTF-8, no raw control characters) | REQUIRED; files MUST be valid JSON | T0 | Every tool parses sidecars with a strict JSON parser. | Coordinate-system files in three live EMG datasets contain a raw control character inside a string, which a strict parser rejects ([#2298](https://github.com/nemarOrg/nemar-cli/issues/2298)). | yes: JSON_INVALID error (not re-tested against these files) | not measured |
| `recording sidecar` TaskName | REQUIRED | T0 | Names the task. | Validator error. | yes: error when the key is absent; an n/a value passes | not measured |
| `dataset_description.json` Authors | OPTIONAL; RECOMMENDED when CITATION.cff is absent (CITATION.cff then carries the authors) | T1 | Becomes the DOI creator list, so credit and citation depend on it. | A dataset with no named people cannot be cited; placeholder author lists such as `[Unspecified1]` were the motivating case for the gate. | yes: NO_AUTHORS warning when the key is absent and CITATION.cff is absent; TOO_FEW_AUTHORS warning for a single entry | 0% of 163 |
| `dataset_description.json` License | RECOMMENDED | T1 | States reuse terms; a license identifier is machine-readable for DOI rights and catalog filters. | Free-text values in the catalog: 61 of 910 datasets use a string that is neither a BIDS nor an SPDX identifier, such as `CC BY 4.0`, `CC0 BY 4.0`, `Creative commons`, `Unknown` or `n/a`. | partly: JSON_KEY_RECOMMENDED when absent; the value is not checked | 1% of 163 |
| `dataset_description.json` EthicsApprovals | OPTIONAL; unless the README carries an ethics statement | T1 | Visible evidence that the collection was approved, which reusers and journals ask for. | Absent in most OpenNeuro mirrors (68.6% of in-scope OpenNeuro datasets in the June 2026 scan, [research-submission-minimums-deskreject.md](research-submission-minimums-deskreject.md)). | no | 44% of 163 |
| `dataset_description.json` ReferencesAndLinks | OPTIONAL; when a publication or protocol describes the data | T1 | Points to the methods paper, which is where most acquisition detail lives. | Without it a reader cannot find the protocol behind sparse sidecars. | no | 38% of 163 |
| `dataset_description.json` Funding | OPTIONAL | T1 | Becomes DOI funding references, how funders find what they paid for; NEMAR's submission standards already list it as strongly recommended. | No funder link in the DOI record. | no | 40% of 163 |
| `dataset_description.json` HEDVersion | RECOMMENDED; when any HED annotation is present; needed for HED validation | T1 | Pins the HED schema so annotations validate the same way later. | HED tags without a version are not validated at all by the pinned validator. | partly: JSON_KEY_RECOMMENDED warning whenever the key is absent, HED or not; when HED is used without it, the HED annotations are silently not validated | not measured |
| `README` substance (more than 150 bytes, dataset specific) | RECOMMENDED; SHOULD describe the dataset | T1 | A specific README is what lets a reader decide whether the data fit their question. | Boilerplate copied across a family of datasets. | partly: README_FILE_SMALL at 150 bytes or fewer | 1% of 163 |
| `participants.tsv` file | RECOMMENDED in the prose; OPTIONAL in the schema file rule | T1 | The cohort table behind age, sex and group filters and the catalog's age range. | No demographics at all; the dataset cannot be filtered by cohort. | no | 5% of 163 |
| `participants.tsv` age (column present with values) | RECOMMENDED | T1 | Age filters and the catalog age range come from this column. | In the sample, 28 of 155 participants tables have no age column and 31 more have one whose every value is n/a; the catalog has no age range for 338 of 910 datasets. | no: absent RECOMMENDED columns are skipped silently | 38% of 155 |
| `participants.tsv` sex | RECOMMENDED | T1 | Sex is the most common covariate and cohort filter. | Cohort balance cannot be checked. | no: absent RECOMMENDED columns are skipped silently | 14% of 155 |
| `participants.json` description of every non-standard column, with Levels for coded values | RECOMMENDED | T1 | Turns columns such as `group` = 1/2 into meaning a reader and a search index can use. | Coded columns with no key are unreadable. | no: participants.tsv allows undefined columns without warning | 12% of 155 |
| `events.tsv` file for every non-rest task recording | RECOMMENDED; when the task name does not contain rest; a validator warning; no level in the schema file rules | T1 | Task data without events cannot be analyzed as a task. | Event codes left only inside proprietary recording headers. | yes: EVENTS_TSV_MISSING warning for non-rest tasks | 18% of 151 (eeg 3/37, ieeg 9/36, meg 6/36, nirs 1/25, emg 3/11, motion 5/6) |
| `events.json` Levels or HED on the categorical code columns (`trial_type`, `value` and similar) | RECOMMENDED; SHOULD be documented | T1 | A numeric trigger code is meaningless without its key, and the key is cheap for the submitter and impossible for anyone else to recover. | Sampled recordings whose only code columns (`trial_type`, `value` and similar) carry no Levels or HED, so codes such as 1, 2 or S 11 have no key. | no, except HED_WARNING with subcode SIDECAR_KEY_MISSING when HED is used and a value has no HED string | 64% of 114 (eeg 13/29, ieeg 11/25, meg 25/27, nirs 23/24, emg 1/8, motion 0/1) |
| `recording sidecar` TaskDescription | RECOMMENDED | T1 | One paragraph that tells a reader what the participant did; the task label alone rarely does. | Task labels such as `task-1` or `task-default` with no description. | yes: SIDECAR_KEY_RECOMMENDED or JSON_KEY_RECOMMENDED warning when the key is absent; no warning for an n/a value | 54% of 156 (eeg 24/40, ieeg 6/36, meg 29/36, nirs 24/27, emg 0/11, motion 1/6) |
| `derivatives/` processed data kept under derivatives/ with its own dataset_description.json | OPTIONAL directory; GeneratedBy REQUIRED inside it; when the deposit includes processed data | T1 | Keeps raw and processed data apart so readers and the viewer know what they are opening. | nm000389 lists MEG as a modality but its sub-*/meg folders hold only processed connectome files. | partly: derivative description rules apply only when declared | not measured |
| `dataset_description.json` DatasetType | RECOMMENDED | T2 | Distinguishes raw from derivative datasets; defaults to raw. | Processed-only deposits look like raw data. | yes: SIDECAR_KEY_RECOMMENDED or JSON_KEY_RECOMMENDED warning when the key is absent; no warning for an n/a value | 28% of 163 |
| `dataset_description.json` Acknowledgements, HowToAcknowledge, Keywords | OPTIONAL | T2 | Courtesy and discovery text. | Minor. | no | 82% of 163 |
| `dataset_description.json` SourceDatasets | RECOMMENDED | T2 | Links a converted or derived dataset to its source. | Lineage is lost for re-hosted or converted data. | yes: SIDECAR_KEY_RECOMMENDED or JSON_KEY_RECOMMENDED warning when the key is absent; no warning for an n/a value | not measured |
| `CHANGES` file | OPTIONAL | T2 | Version history for reusers of an earlier release. | Readers cannot tell what changed between versions. | no | 11% of 163 |
| `LICENSE` file | OPTIONAL; MUST match License when present | T2 | Full license text. | Mismatch with the License field. | no | not measured |
| `participants.tsv` handedness, species, strain | RECOMMENDED; species becomes essential for non-human data | T2 | Handedness matters for motor and language tasks; species and strain for non-human data. | Covariate unavailable. | no: absent RECOMMENDED columns are skipped silently | 83% of 155 |
| `events.tsv or events.json` HED annotations | OPTIONAL | T2 (judgment call: T1 if NEMAR ships HED-based event search) | Makes events comparable and searchable across datasets. | Events can be read only with each dataset's own vocabulary. | HED_ERROR or HED_WARNING (the HED code as subcode) when present, but only if HEDVersion is set | 93% of 163 |
| `events.json` StimulusPresentation | RECOMMENDED | T2 | Software and screen details for timing reproducibility. | Timing caveats unknown. | yes: SIDECAR_KEY_RECOMMENDED or JSON_KEY_RECOMMENDED warning when the key is absent; no warning for an n/a value | not measured |
| `recording sidecar` Instructions, CogAtlasID, CogPOID | RECOMMENDED | T2 | Exact wording given to participants; ontology links. | Minor. | yes: SIDECAR_KEY_RECOMMENDED or JSON_KEY_RECOMMENDED warning when the key is absent; no warning for an n/a value | 80% of 156 (eeg 31/40, ieeg 26/36, meg 34/36, nirs 25/27, emg 3/11, motion 6/6) |
| `recording sidecar` Manufacturer, ManufacturersModelName, HardwareFilters | RECOMMENDED | T2 | Device and analog filter identity for reproducibility and device-specific search. | Amplifier characteristics unknown. | yes: SIDECAR_KEY_RECOMMENDED or JSON_KEY_RECOMMENDED warning when the key is absent; no warning for an n/a value | 35% of 156 (eeg 18/40, ieeg 15/36, meg 1/36, nirs 18/27, emg 1/11, motion 1/6) |
| `recording sidecar` InstitutionName, InstitutionAddress, InstitutionalDepartmentName | RECOMMENDED | T2 | Site for multi-site pooling. | Minor. | yes: SIDECAR_KEY_RECOMMENDED or JSON_KEY_RECOMMENDED warning when the key is absent; no warning for an n/a value | 53% of 156 (eeg 10/40, ieeg 18/36, meg 25/36, nirs 24/27, emg 1/11, motion 4/6) |
| `scans.tsv` filename; acq_time | OPTIONAL file; filename REQUIRED when the file is present, acq_time OPTIONAL | T2 | Recording order and relative timing across runs. | Run order unknown; note NEMAR sets day and month of new recording dates to 1 January. | yes: SCANS_FILENAME_NOT_MATCH_DATASET error for stale rows | not measured |
| `sessions.tsv` session_id | REQUIRED; when sessions.tsv is present; OPTIONAL file | T2 | Describes longitudinal sessions. | Session meaning is implicit. | yes: TSV_COLUMN_MISSING error when the column is absent; n/a values pass | not measured |
| `sourcedata/, code/` conversion scripts and original files | OPTIONAL | T2 | Lets others repeat the conversion to BIDS. | Conversion choices are invisible. | no | not measured |

### Electroencephalography (EEG)

| Item | BIDS level | Tier | Benefit | When missing | Validator warns | Missing in sample |
| --- | --- | --- | --- | --- | --- | --- |
| `_eeg.json` EEGReference, SamplingFrequency, PowerLineFrequency, SoftwareFilters | REQUIRED | T0 | Reference and sampling are needed to read the signal at all. | Validator error. | yes: error when the key is absent; an n/a value passes | not measured |
| `_coordsystem.json` EEGCoordinateSystem, EEGCoordinateUnits; EEGCoordinateSystemDescription if Other | REQUIRED; when coordsystem.json exists; EEGCoordinateSystemDescription REQUIRED if Other | T0 | Defines the frame of the positions. | Validator error. | yes: error when the key is absent; an n/a value passes | not measured |
| `_eeg.json` EEGReference with a real value | value quality: the key is REQUIRED; its value is not checked | T1 | Re-referencing and comparison across datasets need the original reference. | `n/a` or `unknown` passes validation. | no | 28% of 40 |
| `_eeg.json` PowerLineFrequency as a number | value quality: the key is REQUIRED; `n/a` is a legal value | T1 | Line-noise removal needs 50 or 60. | Catalog has no line frequency for 314 of 910 datasets. | no | 5% of 40 |
| `_eeg.json` EEGPlacementScheme | RECOMMENDED | T1 | Names the montage family, which is what lets the viewer draw a topography without measured positions. | Catalog has no placement scheme for 508 of 910 datasets. | yes: SIDECAR_KEY_RECOMMENDED or JSON_KEY_RECOMMENDED warning when the key is absent; no warning for an n/a value | 35% of 40 |
| `_channels.tsv` file with name, type, units | RECOMMENDED file; columns REQUIRED when present | T1 | Channel types (EEG, EOG, ECG, MISC) and units are what the viewer and every pipeline read first. | Without it tools guess types from labels; auxiliary channels get treated as EEG. | no for the file; TSV_COLUMN_MISSING for its required columns | 10% of 40 |
| `_electrodes.tsv + _coordsystem.json` file pair | OPTIONAL; when positions were digitized or the montage is not a standard 10-20 family layout; coordsystem.json REQUIRED when electrodes.tsv exists | T1 | Measured or template positions drive topographies and source analysis. | Without them nonstandard nets cannot be plotted. | no for the files; REQUIRED_COORDSYSTEM error when electrodes.tsv exists without coordsystem.json | 52% of 40 |
| `_coordsystem.json` a named frame rather than Other | value quality: the value is free; Other needs a description; when electrodes.tsv is present | T1 | The viewer maps positions only from a named frame; it does not read free text. | Template named only in EEGCoordinateSystemDescription. | no | 11% of 18 |
| `_channels.tsv` status, status_description | OPTIONAL | T2 | Marks bad channels the submitter already knows about. | Every reuser rediscovers them. | no | 44% of 36 |
| `_eeg.json` EEGGround, CapManufacturer, RecordingDuration, RecordingType, SubjectArtefactDescription, EEGChannelCount | RECOMMENDED | T2 | Useful context; channel counts are checked against channels.tsv when given. | Minor. | yes: SIDECAR_KEY_RECOMMENDED or JSON_KEY_RECOMMENDED warning when the key is absent; no warning for an n/a value; channel count mismatch warnings | 70% of 40 |

### Intracranial electroencephalography (iEEG)

| Item | BIDS level | Tier | Benefit | When missing | Validator warns | Missing in sample |
| --- | --- | --- | --- | --- | --- | --- |
| `_ieeg.json` iEEGReference, SamplingFrequency, PowerLineFrequency, SoftwareFilters | REQUIRED | T0 | Needed to read the signal. | Validator error. | yes: error when the key is absent; an n/a value passes | not measured |
| `_electrodes.tsv` file with name, x, y, z, size | REQUIRED | T0 | Electrode identity and location are the core of iEEG reuse. | Never omit the file; positions that are truly unknown are written as n/a. | yes: IEEG_ELECTRODES_REQUIRED error; TSV_COLUMN_MISSING for columns | not measured |
| `_coordsystem.json` iEEGCoordinateSystem, iEEGCoordinateUnits; iEEGCoordinateSystemDescription if Other | REQUIRED; MUST accompany electrodes.tsv; iEEGCoordinateSystemDescription REQUIRED if Other | T0 | Defines the frame of the positions. | Validator error. | yes: REQUIRED_COORDSYSTEM error; key errors | not measured |
| `_electrodes.tsv` real coordinates (x, y, z not all n/a) | value quality: columns REQUIRED; n/a values allowed | T1 | Without coordinates no anatomical localization, plotting or cross-patient pooling is possible. | Spot check: 14 of 37 sampled iEEG datasets had n/a in every electrode row read. | no | 38% of 37 |
| `_coordsystem.json` a named frame (template or ACPC) rather than Other | value quality: Other allowed with a description | T1 | The viewer maps electrodes only from a named frame; it does not read frames from free text. | Spot check: 30 of 36 readable iEEG coordinate files declare Other; 14 of those name MNI or Talairach only in the description, often without the exact template, and 16 have no coordinates. | no | 83% of 36; 70% of 20 excluding files with no coordinates |
| `_coordsystem.json` IntendedFor (the anatomical image for native frames) | OPTIONAL; when the frame is ACPC, ScanRAS, Pixels or Other and an image is shared | T1 | Links patient-space coordinates to the MRI they were measured on. | ACPC or native coordinates with no image cannot be checked or re-registered. | yes when present: INTENDED_FOR error for a bad path | not measured |
| `_channels.tsv` file with name, type, units, low_cutoff, high_cutoff | RECOMMENDED file in 1.11.2; columns REQUIRED when present | T1 | Channel types and filters drive the viewer and analysis. | Types guessed from labels. | TSV_COLUMN_MISSING for required columns | 0% of 36 |
| `_electrodes.tsv` group, hemisphere, material, manufacturer | RECOMMENDED | T2 | Shaft grouping and hemisphere support quick anatomical summaries. | Minor. | no: absent RECOMMENDED columns are skipped silently | not measured |
| `_coordsystem.json` iEEGCoordinateProcessingDescription, iEEGCoordinateProcessingReference | RECOMMENDED | T2 | How coordinates were obtained (co-registration, brain shift). | Accuracy unknown. | yes: SIDECAR_KEY_RECOMMENDED or JSON_KEY_RECOMMENDED warning when the key is absent; no warning for an n/a value | not measured |
| `_ieeg.json` iEEGGround, iEEGPlacementScheme, iEEGElectrodeGroups, ElectrodeManufacturer, RecordingType | RECOMMENDED | T2 | Context. | Minor. | yes: SIDECAR_KEY_RECOMMENDED or JSON_KEY_RECOMMENDED warning when the key is absent; no warning for an n/a value | 44% of 36 |

### Magnetoencephalography (MEG)

| Item | BIDS level | Tier | Benefit | When missing | Validator warns | Missing in sample |
| --- | --- | --- | --- | --- | --- | --- |
| `_meg.json` SamplingFrequency, PowerLineFrequency, DewarPosition, SoftwareFilters, DigitizedLandmarks, DigitizedHeadPoints | REQUIRED | T0 | Needed to read and co-register the recording. | Validator error. | yes: error when the key is absent; an n/a value passes | not measured |
| `_coordsystem.json` MEGCoordinateSystem, MEGCoordinateUnits; MEGCoordinateSystemDescription if Other | REQUIRED; when coordsystem.json exists; MEGCoordinateSystemDescription REQUIRED if Other | T0 | Defines the frame and units of the positions. | Validator error. | yes: error when the key is absent; an n/a value passes | not measured |
| `_meg.json or sub-emptyroom` AssociatedEmptyRoom or an empty-room recording | RECOMMENDED; either the key or an empty-room recording | T1 | Noise covariance for source analysis is computed from the empty-room recording. | Source localization cannot be reproduced. | yes: SIDECAR_KEY_RECOMMENDED or JSON_KEY_RECOMMENDED warning when the key is absent; no warning for an n/a value; ASSOCIATED_EMPTY_ROOM error for a bad path | 67% of 36 |
| `_coordsystem.json` file with landmarks and IntendedFor when an anatomical image is shared | OPTIONAL | T1 | Co-registration of sensors to the head and MRI needs the frame and the landmarks. | Sensor-to-MRI transform must be reconstructed by hand. | no | 11% of 36 |
| `_channels.tsv` file with name, type, units | RECOMMENDED file | T1 | Channel types and bad channels in a vendor-neutral form. | Readers depend on vendor readers. | TSV_COLUMN_MISSING for its columns | 8% of 36 |
| `_headshape, _meg.json` head shape file; ContinuousHeadLocalization, HeadCoilFrequency, MaxMovement | RECOMMENDED | T2 | Improves co-registration and motion assessment. | Minor. | yes: SIDECAR_KEY_RECOMMENDED or JSON_KEY_RECOMMENDED warning when the key is absent; no warning for an n/a value | 28% of 36 |

### Near-infrared spectroscopy (NIRS)

| Item | BIDS level | Tier | Benefit | When missing | Validator warns | Missing in sample |
| --- | --- | --- | --- | --- | --- | --- |
| `_nirs.json` SamplingFrequency, NIRSChannelCount, NIRSSourceOptodeCount, NIRSDetectorOptodeCount | REQUIRED | T0 | Needed to read the recording. | Validator error. | yes: error when the key is absent; an n/a value passes | not measured |
| `_coordsystem.json` NIRSCoordinateSystem, NIRSCoordinateUnits; NIRSCoordinateSystemDescription if Other | REQUIRED; when coordsystem.json exists; NIRSCoordinateSystemDescription REQUIRED if Other | T0 | Defines the frame and units of the positions. | Validator error. | yes: error when the key is absent; an n/a value passes | not measured |
| `_optodes.tsv + _coordsystem.json` file pair | REQUIRED; when channels.tsv is present; optodes.tsv MUST exist (prose); coordsystem.json REQUIRED with optodes.tsv | T0 | Optode positions are needed to map channels to the head. | 4 of 26 sampled NIRS datasets with a channels.tsv have no optodes.tsv (on006902, on007477, on007554, on007990), which the prose forbids. | partly: REQUIRED_COORDSYSTEM and template column errors once optodes.tsv exists; nothing checks that optodes.tsv exists when channels.tsv does | 15% of 26 |
| `_channels.tsv` file with source, detector, wavelength_nominal, units | RECOMMENDED file; columns REQUIRED when present | T1 | Source-detector pairs and wavelengths are what make the signal interpretable. | Pairs must be dug out of the SNIRF file. | yes: NIRS_RECOMMENDED_CHANNELS warning | 4% of 27 |
| `_nirs.json` NIRSPlacementScheme, ShortChannelCount, SourceType, DetectorType | RECOMMENDED | T2 | Montage family and short channels guide preprocessing. | Minor. | yes: SIDECAR_KEY_RECOMMENDED or JSON_KEY_RECOMMENDED warning when the key is absent; no warning for an n/a value | 93% of 27 |

### Electromyography (EMG)

| Item | BIDS level | Tier | Benefit | When missing | Validator warns | Missing in sample |
| --- | --- | --- | --- | --- | --- | --- |
| `_emg.json` EMGPlacementScheme, EMGReference, SamplingFrequency, PowerLineFrequency, RecordingType, SoftwareFilters; EMGPlacementSchemeDescription if Other | REQUIRED; EMGPlacementSchemeDescription REQUIRED if Other | T0 | Needed to read the signal and know how sensors were placed. | Validator error. | yes: error when the key is absent; an n/a value passes | not measured |
| `_coordsystem.json` EMGCoordinateSystem, EMGCoordinateUnits; EMGCoordinateSystemDescription if Other | REQUIRED; when coordsystem.json exists; Other is the only valid EMGCoordinateSystem value in 1.11.2, so the description is effectively REQUIRED | T0 | Defines the frame and units of the positions. | Validator error. | yes: error when the key is absent; an n/a value passes | not measured |
| `_electrodes.tsv` name, x, y | REQUIRED; when electrodes.tsv exists; z is OPTIONAL for EMG | T0 | Electrode identity and position on the limb or body. | Validator error. | yes: TSV_COLUMN_MISSING error when the column is absent; n/a values pass | not measured |
| `_channels.tsv` file with target_muscle | RECOMMENDED file and column | T1 | Which muscle each channel records is the first thing an EMG reader needs, and the main search key. | Muscle only implied by channel labels. | no: absent RECOMMENDED columns are skipped silently | 50% of 10 |
| `_electrodes.tsv + _coordsystem.json` file pair | OPTIONAL; SHOULD be given when EMGPlacementScheme is Measured | T1 | Positions make sensor placement reproducible. | Placement cannot be repeated. | EMG_COORD_SYS_MISMATCH and EMG_COORD_SYS_PARENTS errors when present; REQUIRED_COORDSYSTEM does not apply to EMG | 27% of 11 |
| `_channels.tsv / _emg.json` signal_electrode, reference, group, interelectrode_distance; InterelectrodeDistance, EMGGround | RECOMMENDED; a mix of RECOMMENDED and OPTIONAL fields | T2 | Bipolar configuration details. | Minor. | no: absent RECOMMENDED columns are skipped silently | not measured |

### Motion

| Item | BIDS level | Tier | Benefit | When missing | Validator warns | Missing in sample |
| --- | --- | --- | --- | --- | --- | --- |
| `_channels.tsv` file with name, component, type, tracked_point, units | REQUIRED | T0 | Motion data have no header row, so channels.tsv is the only column key. | Validator error. | yes: TSV_COLUMN_MISSING error when the column is absent; n/a values pass | not measured |
| `_motion.json` TaskName, SamplingFrequency | REQUIRED | T0 | Needed to read the data. | Validator error. | yes: error when the key is absent; an n/a value passes | not measured |
| `_channels.tsv` placement | RECOMMENDED | T1 | Where on the body each tracked point sits. | Tracked-point labels such as `marker3` are meaningless. | no: absent RECOMMENDED columns are skipped silently | 67% of 6 |
| `_channels.tsv + _channels.json` reference_frame and its definition | RECOMMENDED; the column and its definition in channels.json | T1 | Position and orientation values cannot be interpreted without the frame. | Axes unknown. | no: absent RECOMMENDED columns are skipped silently | 67% of 6 |
| `_motion.json` TrackedPointsCount, MissingValues, SamplingFrequencyEffective | RECOMMENDED | T2 | Data-loss conventions and effective rate. | Minor. | yes: SIDECAR_KEY_RECOMMENDED or JSON_KEY_RECOMMENDED warning when the key is absent; no warning for an n/a value | 100% of 6 |

### Pointers for the other hosted datatypes

- **Behavioral (`beh`, 72 datasets, always next to another modality)**:
  `_beh.tsv` has no REQUIRED columns; `TaskName`, `TaskDescription` and `Instructions` are RECOMMENDED.
  The same rule as for `events.tsv` applies: every column described in the JSON sidecar, with Levels for coded responses.
- **Anatomical MRI (`anat`, 80 datasets)**:
  for MEG and iEEG the T1-weighted image is what the coordinate files point to,
  so the T1-weighted image items here (both tier T1) are the `IntendedFor` link from `_coordsystem.json` and anatomical landmark coordinates.
  Face removal is a de-identification matter for the identifier screen and the contributor terms, not a BIDS level.
- **Functional, field-map, diffusion and perfusion MRI (`func`, `fmap`, `dwi`, `perf`)**:
  the schema's MRI rules apply unchanged (for example `RepetitionTime` or `VolumeTiming`, and `TaskName`, REQUIRED for `_bold`;
  `.bval` and `.bvec` for diffusion; `aslcontext.tsv` for perfusion), and the validator enforces them.
  NEMAR adds nothing for these and should point to the specification.
- **Not hosted** (eye tracking and physiology as `physio`, positron emission tomography, microscopy, magnetic resonance spectroscopy, genetics):
  no guidance beyond "follow the specification" until a dataset arrives.

## What the validator already reports

Read from validator source at tag `3.0.2` (NEMAR's pin) and its bundled schema (BIDS 1.11.1), not from documentation:

- A missing REQUIRED JSON key is an error; a missing RECOMMENDED key is a warning
  (`SIDECAR_KEY_RECOMMENDED` for data-file sidecars, `JSON_KEY_RECOMMENDED` for files such as `dataset_description.json`,
  or the rule's own code where the schema gives one, such as `NO_AUTHORS`);
  OPTIONAL keys are ignored.
  In a dataset whose `DatasetType` is `derivative`, missing RECOMMENDED keys are skipped unless the rule is written for derivatives.
  A conditional level is honored only when its addendum has the simple form "required if `Key` is `Value`";
  any other addendum falls back to the base level,
  so `DatasetLinks` ("required if BIDS URIs are used") is treated as OPTIONAL.
  `Authors` is covered by a separate schema rule, which warns `NO_AUTHORS` when there is no `CITATION.cff`.
- A missing REQUIRED TSV column is an error (`TSV_COLUMN_MISSING`).
  **A missing RECOMMENDED column is skipped silently**:
  `participants.tsv` without `age` or `sex`, `_channels.tsv` without `target_muscle` or `placement`, and `_electrodes.tsv` without `hemisphere` produce nothing.
- **Values are never judged for content.**
  `n/a` passes everywhere it is a legal value, which is almost every TSV cell and several REQUIRED keys
  (`PowerLineFrequency` and `SoftwareFilters` allow `n/a` by definition).
  An `_electrodes.tsv` whose every coordinate is `n/a` is valid.
- Undefined extra columns in `channels.tsv` and `electrodes.tsv` warn (`TSV_ADDITIONAL_COLUMNS_UNDEFINED`);
  extra columns in `participants.tsv`, `events.tsv` and `scans.tsv` are `allowed`, so an undocumented column there produces nothing.
- File presence: only README (`README_FILE_MISSING`, `README_FILE_SMALL` at 150 bytes or fewer),
  `events.tsv` for non-rest task recordings in raw datasets (`EVENTS_TSV_MISSING`),
  NIRS `channels.tsv` (`NIRS_RECOMMENDED_CHANNELS`),
  iEEG `electrodes.tsv` (`IEEG_ELECTRODES_REQUIRED`, an error),
  `coordsystem.json` next to any `electrodes.tsv` except EMG's (`REQUIRED_COORDSYSTEM`, an error)
  and next to a NIRS `optodes.tsv` (also `REQUIRED_COORDSYSTEM`) are checked.
  EEG, MEG and EMG `channels.tsv`, `participants.tsv`, MEG empty-room recordings and an EMG `coordsystem.json` are not.
- HED: a dataset without `HEDVersion` gets the ordinary `JSON_KEY_RECOMMENDED` warning whether or not it uses HED,
  and when HED is used without `HEDVersion` the validator skips HED validation silently, so tag errors go unreported.
  With a version set, problems surface as `HED_ERROR` or `HED_WARNING` with the HED code as subcode
  (for example `SIDECAR_KEY_MISSING` for a value with no HED string);
  none of this fires for datasets that use no HED.

## What NEMAR checks today (verified in code)

- **CLI upload** (`validateBidsStep` in `src/lib/upload/preflight.ts`):
  refuses a dataset with no `dataset_description.json`,
  runs the pinned validator with `--prune`,
  and blocks on errors.
  On success it prints only the number of warnings (`Dataset is valid BIDS (N warnings)`), not the warnings themselves,
  so every RECOMMENDED-key warning above is reduced to a count the submitter never reads.
  `--skip-validation` bypasses the step.
- **CLI upload enrichment** (`src/lib/upload/enrich.ts`, `src/lib/license.ts`):
  detects `License` and, on a terminal, prompts for an SPDX identifier and writes `LICENSE`;
  collects co-author ORCID identifiers.
  It does not check any other metadata.
- **Publication gate** (`backend/src/services/submission-gate.ts`, `shared/submission-minimums.ts`),
  for NEMAR-native datasets only (OpenNeuro mirrors and exemplars are exempt unless the release is anonymous):
  `Name` of at least 25 characters, `Authors` naming at least one person (placeholders refused),
  and an ethics statement in `EthicsApprovals` or in the README.
  It reads `dataset_description.json` and the README and nothing else.
- **Publication prescreen** (language model, advisory, when enabled):
  per the submission-standards page, it reads the start of the README and `dataset_description.json`
  and flags a README that is missing or does not describe the data, a missing `Name` or `Authors`,
  and implausibly small declared data.
  Only the dispatch and its stored verdict were verified in code; the prompt lives in another repository.
  This is the ADR 0014 advisory pre-screen, which retires when the publication review of ADR 0102 is switched on (`PUBLICATION_REVIEW_ENABLED`).
- **Publication review** (ADR 0102, with the approval attribution of ADR 0105), for NEMAR-native datasets once switched on:
  one derived verdict per request, shown to the administrator who approves; mirrors and exemplars are not reviewed.
- **Identifier screen**: privacy, not completeness; out of scope here.

Nothing in NEMAR today looks at sidecars, `channels.tsv`, `events.json`, `participants.tsv`, `electrodes.tsv` or `coordsystem.json` beyond what the validator does.

## Top T1 items by measured omission rate

Sample: 163 datasets read (0 unreadable), drawn per modality as described in Method; a sample, not a census.

| Rank | Modality | Item | Missing | Sample |
| --- | --- | --- | --- | --- |
| 1 | ieeg | `_coordsystem.json` a named frame (template or ACPC) rather than Other | 83% (70% of 20 excluding no-coordinate files) | 36 |
| 2 | meg | `_meg.json or sub-emptyroom` AssociatedEmptyRoom or an empty-room recording | 67% | 36 |
| 3 | motion | `_channels.tsv` placement | 67% | 6 |
| 4 | motion | `_channels.tsv + _channels.json` reference_frame and its definition | 67% | 6 |
| 5 | all | `events.json` Levels or HED on the categorical code columns (`trial_type`, `value` and similar) | 64% | 114 |
| 6 | all | `recording sidecar` TaskDescription | 54% | 156 |
| 7 | eeg | `_electrodes.tsv + _coordsystem.json` file pair | 52% | 40 |
| 8 | emg | `_channels.tsv` file with target_muscle | 50% | 10 |
| 9 | all | `dataset_description.json` EthicsApprovals | 44% | 163 |
| 10 | all | `dataset_description.json` Funding | 40% | 163 |
| 11 | all | `participants.tsv` age (column present with values) | 38% | 155 |
| 12 | all | `dataset_description.json` ReferencesAndLinks | 38% | 163 |
| 13 | ieeg | `_electrodes.tsv` real coordinates (x, y, z not all n/a) | 38% | 37 |
| 14 | eeg | `_eeg.json` EEGPlacementScheme | 35% | 40 |
| 15 | eeg | `_eeg.json` EEGReference with a real value | 28% | 40 |
| 16 | emg | `_electrodes.tsv + _coordsystem.json` file pair | 27% | 11 |
| 17 | all | `events.tsv` file for every non-rest task recording | 18% | 151 |
| 18 | all | `participants.tsv` sex | 14% | 155 |
| 19 | all | `participants.json` description of every non-standard column, with Levels for coded values | 12% | 155 |
| 20 | eeg | `_coordsystem.json` a named frame rather than Other | 11% | 18 |
| 21 | meg | `_coordsystem.json` file with landmarks and IntendedFor when an anatomical image is shared | 11% | 36 |
| 22 | eeg | `_channels.tsv` file with name, type, units | 10% | 40 |
| 23 | meg | `_channels.tsv` file with name, type, units | 8% | 36 |
| 24 | eeg | `_eeg.json` PowerLineFrequency as a number | 5% | 40 |
| 25 | all | `participants.tsv` file | 5% | 163 |
| 26 | nirs | `_channels.tsv` file with source, detector, wavelength_nominal, units | 4% | 27 |
| 27 | all | `dataset_description.json` License | 1% | 163 |
| 28 | all | `README` substance (more than 150 bytes, dataset specific) | 1% | 163 |
| 29 | all | `dataset_description.json` Authors | 0% | 163 |
| 30 | ieeg | `_channels.tsv` file with name, type, units, low_cutoff, high_cutoff | 0% | 36 |

Observations behind the ranking:

- **Event codes without a key are the most common gap that blocks understanding.**
  The measured item is the share of recordings where none of the categorical code columns has `Levels` or `HED`
  (a guideline asking for every column to be described is stricter than what was measured):
  of 114 sampled non-rest task recordings with a categorical code column, 73 (64%) have none described that way.
  The stricter figure, where those undescribed codes are mostly numbers or trigger strings such as `S 11`, is 51 of 114 (45%), led by MEG (22 of 27) and NIRS (15 of 24).
  In MEG, 15 of 27 such recordings have no `events.json` at all.
  The validator says nothing about any of this.
- **The gaps are concentrated in the OpenNeuro mirrors, not in NEMAR-native datasets**, for the dataset-level items:
  undescribed codes in 66 of 79 mirror recordings against 7 of 35 native ones;
  `TaskDescription` missing in 78 of 108 mirror sidecars against 6 of 48 native ones;
  `ReferencesAndLinks` missing in 59 of 113 mirrors against 3 of 50 native datasets;
  `EthicsApprovals` missing in 62 of 113 against 9 of 50.
  Mirrors are exempt from the gate, so for them guidance can only become flags on the dataset page or upstream reports.
- **The exception is `EEGReference`:** the value is `n/a` or empty in 9 of 14 sampled NEMAR-native EEG datasets but only 2 of 26 mirrors.
  That points at NEMAR's own conversion path, where the fix is one change upstream of many datasets.
- **Age is present in name only** in many cohorts: 28 of 155 participants tables have no `age` column, and 31 more have one whose every value is `n/a`, so 38% give no usable age.
- **MEG empty-room recordings** are absent (no `AssociatedEmptyRoom`, no `sub-emptyroom`) in 24 of 36 MEG datasets read, also after checking the first subject's MEG folder for `task-noise` files (every sampled MEG dataset is a mirror).
- **iEEG coordinates** (spot check, first rows): 14 of 37 datasets have only `n/a` coordinates, and 30 of 36 readable coordinate files say `Other` (83%).
  Leaving out the 16 `Other` files recorded as having no coordinates, 14 of the remaining 20 still say `Other` (70%).
  The 14 and the 16 do not reconcile from the recorded data; see Method, step 5.
- **A T0 rule nothing checks:** 4 of 26 sampled NIRS datasets with a `channels.tsv` have no `optodes.tsv`, which the prose says MUST exist; the validator's schema checks have no rule for it.
- **EMG `target_muscle`** is absent in 5 of 10 EMG channel tables; **motion `placement` and `reference_frame`** in 4 of 6 motion channel tables.
- Already handled: `Authors` (0 of 163 missing), `License` (1 of 163), README (0 missing, 1 under 150 bytes), iEEG `channels.tsv` (0 of 36).
  These are where NEMAR's gate or long-standing archive practice already applies pressure, which is the argument for doing the same for the items above.
- Minor findings outside the tiers: 33 of the sampled `events.tsv` files start with a UTF-8 byte order mark (15 in MEG),
  and HED appears in 12 of 163 sampled datasets (catalog-wide, 222 of 910, of which 184 are NEMAR-native).

## Which of these can be enforced where

Four places, cheapest first:

1. **The BIDS validator already reports it**: NEMAR only has to show the warning.
   The single highest-value change is for the CLI to list the RECOMMENDED-key warnings for T1 keys (TaskDescription, EEGPlacementScheme, AssociatedEmptyRoom, License, Authors) instead of only counting them.
2. **A NEMAR preflight check could warn**: a deterministic check over the files already on disk,
   for everything the validator skips (RECOMMENDED columns, `n/a` content, undocumented columns and codes, named frames).
   Each T1 below except README substance is a few lines over parsed TSV and JSON.
3. **The submission gate could record or block**: the gate reads files from the repository, so any preflight check can be re-run there and recorded.
   A recorded T1 finding reaches a human through the publication review of ADR 0102 (approval attribution in ADR 0105):
   the review's verdict and reasons are what the approving administrator sees,
   so recorded findings belong there as advisory input, not as new refusal reasons.
   The ADR 0014 advisory pre-screen retires when that review is switched on, so it is not a destination for them.
   Blocking should stay limited to mechanical minimums that the policy already requires;
   ADR 0026 hard-gates those and keeps adequacy judgments advisory (ADR 0014, which first decided this, is superseded).
   A new blocking rule would need its own ADR.
4. **Documentation only**: where judgment is needed:
   whether a publication or protocol exists for `ReferencesAndLinks` to point to,
   README substance beyond length,
   whether processed data belong under `derivatives/`,
   and HED quality.
   For the first three a preflight check can still warn on the mechanical part (key absent, short README, a datatype folder with no raw files).

| Modality | T1 item | Validator already reports | Preflight could warn | Gate could record or block | Documentation only | Machine check feasible |
| --- | --- | --- | --- | --- | --- | --- |
| all | `dataset_description.json` Authors | yes |  | block (today) |  | yes |
| all | `dataset_description.json` License |  | yes | record |  | yes |
| all | `dataset_description.json` EthicsApprovals |  |  | block (today) |  | yes |
| all | `dataset_description.json` ReferencesAndLinks |  | yes |  | yes | yes |
| all | `dataset_description.json` Funding |  | yes |  |  | yes |
| all | `dataset_description.json` HEDVersion | yes | yes |  |  | yes |
| all | `README` substance (more than 150 bytes, dataset specific) |  | yes |  | yes | no |
| all | `participants.tsv` file |  | yes |  |  | yes |
| all | `participants.tsv` age (column present with values) |  | yes |  |  | yes |
| all | `participants.tsv` sex |  | yes |  |  | yes |
| all | `participants.json` description of every non-standard column, with Levels for coded values |  | yes |  |  | yes |
| all | `events.tsv` file for every non-rest task recording | yes | yes |  |  | yes |
| all | `events.json` Levels or HED on the categorical code columns (`trial_type`, `value` and similar) |  | yes | record |  | yes |
| all | `recording sidecar` TaskDescription | yes | yes |  |  | yes |
| all | `derivatives/` processed data kept under derivatives/ with its own dataset_description.json |  | yes |  | yes | yes |
| eeg | `_eeg.json` EEGReference with a real value |  | yes |  |  | yes |
| eeg | `_eeg.json` PowerLineFrequency as a number |  | yes |  |  | yes |
| eeg | `_eeg.json` EEGPlacementScheme | yes | yes |  |  | yes |
| eeg | `_channels.tsv` file with name, type, units |  | yes |  |  | yes |
| eeg | `_electrodes.tsv + _coordsystem.json` file pair |  | yes |  |  | yes |
| eeg | `_coordsystem.json` a named frame rather than Other |  | yes |  |  | yes |
| ieeg | `_electrodes.tsv` real coordinates (x, y, z not all n/a) |  | yes | record |  | yes |
| ieeg | `_coordsystem.json` a named frame (template or ACPC) rather than Other |  | yes | record |  | yes |
| ieeg | `_coordsystem.json` IntendedFor (the anatomical image for native frames) |  | yes |  |  | yes |
| ieeg | `_channels.tsv` file with name, type, units, low_cutoff, high_cutoff |  | yes |  |  | yes |
| meg | `_meg.json or sub-emptyroom` AssociatedEmptyRoom or an empty-room recording | yes | yes |  |  | yes |
| meg | `_coordsystem.json` file with landmarks and IntendedFor when an anatomical image is shared |  | yes |  |  | yes |
| meg | `_channels.tsv` file with name, type, units |  | yes |  |  | yes |
| nirs | `_channels.tsv` file with source, detector, wavelength_nominal, units | yes | yes |  |  | yes |
| emg | `_channels.tsv` file with target_muscle |  | yes |  |  | yes |
| emg | `_electrodes.tsv + _coordsystem.json` file pair |  | yes |  |  | yes |
| motion | `_channels.tsv` placement |  | yes |  |  | yes |
| motion | `_channels.tsv + _channels.json` reference_frame and its definition |  | yes |  |  | yes |

Recommended order of work, if the owner adopts this:

1. Surface validator warnings for T1 keys in the CLI (no new checks, highest reach).
2. One preflight module generated from the JSON file: `events.json` Levels for code columns, `participants.json` coverage, `participants.tsv` `age` and `sex`, EEG `EEGReference` and `PowerLineFrequency` content, `channels.tsv` presence, coordinate content and named frames for iEEG and EEG, MEG empty-room, EMG `target_muscle`, motion `placement` and `reference_frame`.
3. Record the same results at the gate and show them in the ADR 0102 publication review; do not block on them.
4. Rewrite the "Strongly recommended" section of the submission-standards page from the T1 rows.

## Where the specification and practice disagree, or where I was unsure

- **README is REQUIRED or RECOMMENDED depending on where you read.**
  The schema's file object describes it as "A REQUIRED text file", while the file rule (`rules/files/common/core`) lists it as recommended and the validator only warns.
  I put it at T0 because NEMAR's policy requires a substantive README anyway.
- **iEEG `channels.tsv` is RECOMMENDED in 1.11.2**, while `low_cutoff` and `high_cutoff` are REQUIRED columns when the file exists.
  I kept the file at T1; every sampled iEEG dataset had one.
- **iEEG coordinates: REQUIRED columns, `n/a` values allowed.**
  The specification never says a dataset must release coordinates, and some releases withhold them on purpose
  (one sampled description reads "Patient-specific electrode coordinates were not released with the segmented dataset").
  I made real coordinates T1, not T0: the guideline should ask for them, and when they are withheld, ask for the reason in the README instead of in `iEEGCoordinateSystemDescription`.
- **`Other` as a frame.**
  The specification allows `Other` with a description, so naming a template in free text is valid BIDS.
  In the iEEG spot check, 14 of the 30 `Other` frames name a template in the description (MNI or Talairach), and 16 were classified as `Other` because there are no coordinates
  (more than the 14 all-`n/a` datasets, a mismatch explained in Method, step 5, as far as the records allow).
  Part of this is a gap in the specification, not carelessness:
  the iEEG enumeration has 40 values, but no generic `MNI` keyword, only specific variants (`MNI152Lin`, `MNI152NLin2009cAsym`, `MNI305`, `MNIColin27` and others) plus `Talairach`.
  Several sources say only "MNI space, template not stated", and a curator who cannot tell the variant has no legal keyword except `Other`.
  The guideline should say: use the exact keyword whenever the source states it, and when the source says only "MNI", ask the authors which template.
  Since the viewer does not read frames from free text, those datasets stay unmapped until the frame is a keyword;
  a generic MNI keyword would be a proposal to the BIDS specification, not a NEMAR rule.
- **EEG positions are OPTIONAL**, and most standard-cap datasets reasonably omit them.
  I made the file pair T1 only for nonstandard nets or digitized positions.
  I did not verify in the viewer code whether it can draw a topography from `EEGPlacementScheme` plus standard channel names alone; if it cannot, EEG positions move up.
- **HED is T2 here, a judgment call.**
  It is the only route to cross-dataset event search, but it is not cheap for a submitter.
  If NEMAR ships HED-based event search, promote it to T1.
  Meanwhile, Levels on code columns are the cheap minimum that already makes events readable.
- **License identifiers.**
  BIDS suggests `CC0` and `PD`, which are not SPDX identifiers, while the NEMAR CLI writes SPDX (`CC0-1.0`).
  Both should be accepted; only strings that are neither are worth a warning (61 of the catalog's datasets).
- **Code and policy page disagree on the name rule.**
  `shared/submission-minimums.ts` refuses a `Name` under 25 characters, while the submission-standards page says "There is no fixed character count".
  Out of scope here, but one of them is wrong.
- **The policy page says the CLI warns about missing recommended metadata at upload.**
  The CLI prints only the warning count; the web uploader was not checked.
- **Invalid JSON in live datasets.**
  The `coordsystem.json` files of three sampled EMG datasets (nm000104, nm000105, nm000107, all at v2.0.0)
  contain a raw `0x1A` control character inside `EMGCoordinateSystemDescription`, which a strict JSON parser rejects.
  Those are live datasets; nothing was changed, and I did not re-run the validator on them.
  The defect is filed as [#2298](https://github.com/nemarOrg/nemar-cli/issues/2298).
- **What counts as an undescribed code.**
  The events metric counts a recording when it has at least one categorical code column (`trial_type`, `value` and similar, at most 50 distinct values)
  and none of those columns has `Levels` or `HED` in `events.json`.
  Descriptive labels such as `go` count as codes, so the rate overstates the problem for datasets whose labels explain themselves;
  the numeric-code subset is reported separately and is the stricter figure.
- **`n/a` in REQUIRED keys** (`SoftwareFilters`, `DewarPosition`, and to a lesser degree `PowerLineFrequency`) is legal and common.
  I flag only `EEGReference` and `PowerLineFrequency`, where `n/a` loses information a reader needs and the value is almost always known.

## Not finished

- The iEEG coordinate classification is separate work; the two iEEG coordinate rates here come from the first rows of a 37-dataset spot check and should be replaced by its results.
- One recording per dataset was read; consistency across subjects, sessions and runs was not checked.
- The sampling seed, the date of the reads and the per-dataset log were not recorded, so the sample cannot be redrawn and the unknown reads cannot be named;
  a re-run should record all three in the JSON's `meta.measurement`.
- The validator was not run on any dataset; "validator warns" comes from reading its source.
- The web uploader and the prescreen prompt were not read.
- No rates for MRI or behavioral items, and the derivatives item rests on one example, not a measurement.
- Catalog-wide figures are indexer proxies, not reads of the files.
- Motion (6 datasets) and EMG (11) rates are full counts of small populations, so a single dataset moves them by 9 to 17 points.
