# ADR 0134: Pipelines report checkpoints live, quality metrics are plugins NEMAR reviews, and the same contract serves every compute job

**Status:** proposed
**Date:** 2026-11-21
**Owner:** Seyed Yahya Shirazi

## Context

nemar-process runs NEMAR's own processing in containers, on workstation runners (ADR 0121) and on the supercomputer through Tapis (ADR 0118).
Its first recipe, `nemar-floor`, replaces the legacy MATLAB pipeline's annotation steps with eegprep calls and reads either a dataset directory (Brain Imaging Data Structure, BIDS) or NEMAR's Zarr serving copy;
`nemar-ica` decomposes the floor's cleaned data.
Each run writes a recordings table (one row per recording: status, code, the step that failed) and a signalJourney record per recording and per dataset, whose steps carry `qualityMetrics` and whose record carries `summaryMetrics`.
The lab asked (2026-11-19) for three things before more quality work starts:
progress and error tracking like the Zarr conversion's (a share of files processed, and the files that failed named),
a way to add Python modules that compute quality metrics on the processed data and return JSON or files for display on NEMAR,
and a design general enough that new metrics are easy to add.

Four facts shape the answer.
First, nothing reaches the backend while a job runs: the runner heartbeat carries only a phase (`started` or `uploading`), and a Tapis job reports only through the observer and its completion, so an admin sees "running" for hours and then "finished" or a failure code, never which step a dataset reached or which files broke.
Second, the legacy pipeline already had the view admins want: `sbatch/pipeline_status_all.csv` in `sccn/NEMAR-pipeline` holds one row per dataset and one column per checkpoint (`check_import`, `check_chanloc`, `remove_chan`, `cleanraw`, `runica`, `iclabel`, `dataqual`), each cell a count such as `7/22`.
Third, the legacy pipeline also had quality metrics and display plugins (`eeg_nemar_dataqual.m`, `nemar_plugins/`) that the new pipeline has only partly ported: the floor already measures the share of samples and channels kept and the line noise.
Fourth, signalJourney gives each step an open `qualityMetrics` slot but no shape for a metric's value, and NEMAR's metadata schema, neuroschema (`nemarOrg/neuroschema`), already reserves extension namespaces for this work (`dataQuality`, `signalJourney`) that are still placeholders.

## Decision

**1. signalJourney stays the record; neuroschema carries what NEMAR indexes from it.**
Every step, parameter, per-step `qualityMetrics` entry and `summaryMetrics` entry lives only in the signalJourney record a run writes.
What NEMAR stores and serves about a recording or dataset (headline metrics, figures, checkpoint outcomes) is a projection of those records into neuroschema extensions (decision 9), each carrying the digest of the record it came from, never a second source of the same numbers.
The dataset quality control (QC) summary is derived from the records; its next version is the dataset-level `dataQuality` document of neuroschema, which replaces `docs/schemas/qc-summary.v1.json` in nemar-process and lifts that schema's fixed `recipe: nemar-floor`, so `nemar-ica` and plugins can write one.
Live progress (decision 3) is a view for operators, not a record: when a job completes, the recordings table and the signalJourney records replace whatever the live counts said.

**2. Every recipe declares its checkpoints.**
A checkpoint is a coarse stage an admin recognizes, not every step: `import`, `preprocess`, `ica`, `iclabel`, `quality` and `figures`, followed by `stored`, which the backend sets when the derivatives are copied (ADR 0123).
A recipe maps each of its steps to one checkpoint in code beside its step order, and `nemar-recipe version` prints the map, so the backend's registry entry for a recipe version names the same checkpoints the image runs.
For `nemar-floor`, `load` and `signal_channels` are `import`; flat line, drift, the line-noise steps, bad channels and bad windows are `preprocess`; `qc` is `quality`.
For `nemar-ica`, the floor steps it re-runs as preparation for the decomposition map as they do in the floor, except that its re-run `qc` is `preprocess`; `asr` and `reref` are `preprocess`; then `ica` and `iclabel`; so `import` is filled for both recipes and `quality` always comes after the decomposition.
A checkpoint is per recording: a recording passes it, fails it or is skipped.
A recording that failed or was skipped at an earlier checkpoint counts as skipped at every later one, keeping its first code, so each column sums to the same total.
A dataset's cell is `passed/total`, where the total is the number of recordings the run discovered, beside the counts that failed, were skipped and remain.

**3. Progress is reported live, through the paths each executor already has.**
A runner's heartbeat gains an optional, closed `progress` object; a Tapis job posts the same object to a route authenticated by its job token (`X-Compute-Job-Token`).
The object names the current checkpoint and, per checkpoint, the counts of recordings passed, failed, skipped and total, plus the most recent failures (relative path, failure code, step), capped in number;
it carries no samples, no free text and no personal data.
The recordings table alone cannot supply this, because a recording gets its row only when it ends.
So the shared recipe layer also writes a small local progress file: the recordings it discovered (which fixes the total) when discovery ends, and each running recording's current step as it starts it.
The launcher reads that file and the recordings table and sends the object; the recipe opens no network connection, so its no-network fence is unchanged, and the change lives once in the shared layer, not in each recipe.
Reports come at most once a minute.
The object is a transport message, not metadata: it is declared in `shared/contract/` and pinned by nemar-process the way the launch specification is, and its counts reuse the shape of neuroschema's checkpoint counts, so live and final differ only in transport.

**4. The backend keeps one progress row per run and checkpoint.**
A new table holds, per pipeline stamp and checkpoint, the four counts, the capped failure list and the time of the last report.
A running job with no report for three cadences (or no heartbeat, which already ends a runner lease) shows as `stalled`, distinct from `failed`.
At completion the row is reconciled from the uploaded recordings table, and a disagreement between the live counts and the table is itself recorded, so a broken reporter is visible.
The reconciled counts are what the backend writes to neuroschema (decision 9); `stalled` and the failure list stay operator views.

**5. Admins get one dashboard, built like the Zarr one.**
The admin overview gains a coverage card per recipe (datasets whose current version passed, out of those eligible) with a failure trend, as the Zarr conversion card has.
An admin page shows the legacy grid: datasets as rows, checkpoints as columns, each cell `passed/total` with failed, running, stalled and not-started marked, filters by recipe, recipe version, executor and runner, and a drill-down to the failed files and their codes.
`nemar admin compute pipeline status` gives the same view in the terminal and as JSON.
Both are admin-only.
The people who build metrics are given admin roles, so they read the dashboard and the gated design page directly.

**6. Quality metrics and figures are plugins, and NEMAR reviews every plugin its pipeline runs.**
A plugin is a Python module with a manifest, a JavaScript Object Notation (JSON) document: its name, version, checkpoint, what it reads (the floor's or the decomposition's outputs, or the dataset itself), its parameters and the schema of what it writes.
That output schema is the plugin's real contract, because signalJourney leaves a metric's value unshaped: each metric a plugin declares uses neuroschema's `dataQuality` metric definition (value, unit, description, optional bounds, and the plugin's name and version).
A plugin adds a step to the signalJourney record with its metrics as `qualityMetrics`, headline numbers as `summaryMetrics`, and each figure as an `outputTargets` entry.
Figures come from a fixed list of formats (Portable Network Graphics (PNG), Scalable Vector Graphics (SVG), WebP) under a size cap.
A figure that draws a time series (a data segment, component activations) is raster only, PNG or WebP, because a vector trace stores the samples as coordinates; vector graphics are for maps, histograms and charts of computed values.
A plugin never writes samples, as no recipe does.
A plugin reports a value the floor already measures from the floor's output rather than computing it again.
The interface is general and public: NEMAR's team writes the first plugins, and anyone may write one against the same manifest and run it on their own machine or as their own compute job through the gateway.
What runs in NEMAR's pipeline, and so what NEMAR shows for a dataset, is the set of plugins merged into nemar-process through reviewed pull requests, each pinned by version in the image; NEMAR never runs an unreviewed plugin under its own identity.
A plugin in NEMAR's pipeline follows the recipe rule for numerics: every signal-processing call is an eegprep function, and a missing one goes into eegprep upstream.
nemar-process's guards change by exactly this much: the product-tree assertions (`tests/recipes/test_cli.py`, `tests/recipes/test_floor_input_zarr.py`) accept the declared figure formats under the plugins' output directory, and the upstream-first scan (`tests/recipes/test_upstream_first.py`) extends to the plugins directory and gains a ban on plotting libraries everywhere except plugin figure code.

**7. The first plugins port the legacy set, then extend it.**
From `eeg_nemar_dataqual.m`: the share of data kept, the share of channels kept and the line-noise magnitude (reported from the floor's values), and, new to this pipeline, the share of components ICLabel calls brain and the mutual information reduction (MIR) of the decomposition.
From `nemar_plugins/`: the power spectrum with scalp maps at fixed frequencies, ICLabel component maps, the ICLabel class histogram, component activations, and a segment of cleaned data from the middle of the recording.
The dataset summary adds the legacy per-dataset bounds (lowest and highest good channels, good data and brain components), which today's QC summary does not hold.
Signal-to-noise measures and further scalp maps come next, each as its own plugin and version.

**8. The same contract is the platform for every compute job, not only NEMAR's pipeline.**
A job that follows it (it runs in a nemar-process image or one built from it, under the launcher, declares its checkpoints, and writes signalJourney records and a recordings table) gets the same submission and the same reports wherever it runs.
On a person's own machine, a standalone mode of the launcher, which does not exist today (the launcher now always needs a NEMAR launch specification and job token), writes the progress and results reports locally from the same files, with no NEMAR service involved.
On NEMAR's workstation runners and through Tapis on the supercomputer, the backend receives the same `progress` object and reconciles the same results, so the job's owner sees progress and a results report in their own job view, and admins see it in the dashboard.
Third parties, whether researchers submitting their own jobs or partner sites, adopt the platform by following the contract: the launch specification, the plugin manifest, the progress object and the neuroschema extensions are public and versioned, and NEMAR's rules for signalJourney records are published in signalJourney's `nemar` namespace so the public validator can check them.
A job that does not follow it still runs as it does today, with the job-level states only.

**9. Each schema has one home, and metadata goes into neuroschema as extensions.**
Nothing here enters neuroschema's core; it uses extension namespaces, which neuroschema keeps open and versions on its own.

| Artifact | Home |
|---|---|
| Quality results per recording (typed metrics, figures with location, format, size, Secure Hash Algorithm 256 (SHA-256) digest and caption) | neuroschema `dataQuality`, record level (replaces the placeholder fields) |
| Dataset QC summary (counts, distributions, bounds, not-processed list, record digest) | neuroschema `dataQuality`, dataset level (needs a dataset key beside the record key) |
| Checkpoint outcomes (per record and recipe: recipe version, each checkpoint's status, failure code and step; per dataset: the declared checkpoints and reconciled counts) | a new neuroschema namespace, `processing` |
| Link to the signalJourney records (per recipe: location, SHA-256, signalJourney version; `processing_status` `in_progress` while reports arrive, then `completed` or `failed`) | neuroschema `signalJourney` |
| Plugin manifest | nemar-cli `shared/contract/`, pinned by nemar-process; it declares software before a run and has no dataset or record to attach to |
| Live progress object | nemar-cli `shared/contract/`, closed, pinned by nemar-process |
| Step-to-checkpoint map | recipe code in nemar-process, printed by `nemar-recipe version`, held in nemar-cli's registry |
| NEMAR's rules for signalJourney records (figure formats, size caps, the no-samples rule, metric naming) | signalJourney's `nemar` extension namespace |

nemar-cli already vendors neuroschema as one bundle in `shared/contract/neuroschema/`, rooted at the dataset document; the vendor script gains a record root (or validates extension objects by their `$id`), and nemar-process will validate against that bundle through its existing nemar-cli pin, so no third pin is added.
neuroschema's extension-manager table is corrected so the NEMAR backend is the writer of `dataQuality`, `processing` and `signalJourney`.
Proposed upstream to signalJourney, in order: checksum and size on output targets (signalJourney#7), the `nemar` namespace (signalJourney#8), a typed metric entry, and optionally a step `stage` label; none of these blocks the work here.

## Consequences

- Admins can tell where a dataset stopped and which files broke without opening a job's outputs, and a silent job is flagged as stalled instead of looking busy.
- The progress object is a new contract between nemar-cli and nemar-process: a change to it needs a pin bump on both sides, and the heartbeat schema stops being phase-only.
- The Tapis route is a new job-token surface; it accepts only the closed object and only for a job that is running, and it is revoked with the job token.
- One more table, reconciled at completion, and one more admin page and card in the website.
- Recipes gain a step-to-checkpoint map and the shared recipe layer a local progress file; a recipe version that changes the map changes its registry entry.
- neuroschema 0.5.0, one minor release, adds the `processing` namespace and fills the `dataQuality` and `signalJourney` placeholders; nemar-cli re-vendors it with a record root and moves `NEUROSCHEMA_VERSION` to 0.5.0, a minor bump the live checks see; `qc-summary.v1` is retired in favor of the `dataQuality` dataset document.
- Adding a metric is writing a plugin against one manifest, for NEMAR's team and for outside experts alike.
- A plugin reaches NEMAR's pages only through review and the upstream-first rule, which is slower than dropping in a script, and deliberately so: the numbers NEMAR shows for a dataset are NEMAR's claim.
- Job submission and reporting become one path across a person's machine, NEMAR's runners and the supercomputer, for NEMAR and for third parties; the cost is that the launch specification, the manifest, the progress object and the neuroschema extensions are public interfaces that must stay versioned and backward compatible, and the launcher needs a standalone mode.

## Alternatives considered

- **Report only at job end:** simplest, but a long job reads as "running" until it ends and a hung one is invisible; the Zarr experience and the legacy status file both showed admins need the in-between.
- **Report every step instead of checkpoints:** exact but noisy, and it ties the dashboard's columns to each recipe's internal steps, which change with every recipe version; checkpoints stay stable across versions.
- **Let the recipe post progress itself:** it would put network code inside the recipe and break its no-network fence; writing a local file the launcher reads keeps the fence.
- **A separate progress or results format beside signalJourney:** two records of the same run drift, and the process already writes signalJourney.
- **Put the schemas in signalJourney:** signalJourney records what was done after the fact and changes rarely; a manifest, a checkpoint vocabulary and a transport message are NEMAR's runtime concerns, so only generic pieces go upstream.
- **A core NEMAR schema, or neuroschema core:** core is frozen and shared across registries; extensions keep NEMAR's processing metadata out of it.
- **Put the manifest and the progress object in neuroschema:** its extensions attach to dataset and record documents and are open, while a manifest describes software and the progress object must be closed.
- **Overload the `signalJourney` namespace with checkpoint outcomes:** it holds one pipeline id per record, and a record now has two recipes.
- **Running any plugin that ships a valid manifest, without review:** grows faster, but runs unreviewed code under NEMAR's identity and publishes its numbers as NEMAR's.
- **Closed recipes only, no plugin interface:** keeps control but makes every new metric a recipe change; the manifest gives the same control through review at lower cost.
- **Any output type a plugin declares, such as NumPy arrays:** derived signals could leave through plugins; display images and JSON cover the display need.

## Receipts

- The lab's request of 2026-11-19 (progress and error tracking, metric plugins with JSON and display output, extensibility).
- Legacy pipeline: `sccn/NEMAR-pipeline` (`sbatch/pipeline_status_all.csv`, `eeg_nemar_dataqual.m`, `nemar_dataqual.m`, `eeg_nemar_plugin.m`, `nemar_plugins/`).
- nemar-process: `docs/recipes.md` (recordings table, exit codes, the upstream-first and annotation rules), `recipes/nemar_process/common/records.py` (`qualityMetrics`, `summaryMetrics`), `recipes/nemar_process/nemar_floor/steps.py` and `nemar_ica/steps.py` (step orders), `docs/schemas/qc-summary.v1.json`; docs PR nemarOrg/nemar-process#63.
- neuroschema: `schema/extensions/` (`dataQuality`, `signalJourney`, `extensionsContainer`), `docs/extension-managers.md`; nemar-cli `shared/contract/neuroschema/` (vendored bundle).
- signalJourney: `qualityMetricsObject` (open), `processingStep.outputTargets`, `extensions/nemar` (reserved, empty); issues signalJourney#7 and #8; https://signaljourney.github.io/introduction/
- nemar-cli: `shared/contract/compute-runner.ts` (`RunnerHeartbeatRequestSchema`), migrations 0117 and 0141 (pipeline stamps), 0143 (derivatives); the website's admin overview Zarr coverage card.
- Related: ADR 0118 (gateway and records), ADR 0121 (executors and runners), ADR 0123 (derivatives store), ADR 0033 (the Zarr queue's engine stamps).
