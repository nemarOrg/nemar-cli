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

Three facts shape the answer.
First, nothing reaches the backend while a job runs: the runner heartbeat carries only a phase (`started` or `uploading`), and a Tapis job reports only through the observer and its completion, so an admin sees "running" for hours and then "finished" or a failure code, never which step a dataset reached or which files broke.
Second, the legacy pipeline already had the view admins want: `sbatch/pipeline_status_all.csv` in `sccn/NEMAR-pipeline` holds one row per dataset and one column per checkpoint (`check_import`, `check_chanloc`, `remove_chan`, `cleanraw`, `runica`, `iclabel`, `dataqual`), each cell a count such as `7/22`.
Third, the legacy pipeline also had quality metrics and display plugins (`eeg_nemar_dataqual.m`, `nemar_plugins/`) that the new pipeline has not ported.

## Decision

**1. signalJourney stays the record.**
The process already writes it, and every quality result lands in it: a metric is a `qualityMetrics` entry of the step that computed it, and a recording's or dataset's headline numbers are `summaryMetrics`.
The dataset-level quality control (QC) document (`docs/schemas/qc-summary.v1.json` in nemar-process) is extended for new metrics, never replaced by a second format.
Live progress (below) is a view for operators, not a record: when a job completes, the recordings table and the signalJourney records replace whatever the live counts said.

**2. Every recipe declares its checkpoints.**
A checkpoint is a coarse stage an admin recognizes, not every step: for the standard process `import` (load, signal channels), `preprocess` (flat line, drift, line noise, bad channels, bad windows), `ica`, `iclabel`, `quality` (the metric plugins) and `figures`, followed by `stored`, which the backend sets when the derivatives are copied (ADR 0123).
A recipe maps each of its steps to one checkpoint in code beside its step order, and `nemar-recipe version` prints the map, so the backend's registry entry for a recipe version names the same checkpoints the image runs.
A checkpoint is per recording: a recording passes `import` or fails it, and a dataset's cell is the count of recordings that passed, failed, were skipped and remain.

**3. Progress is reported live, through the paths each executor already has.**
A runner's heartbeat gains an optional, closed `progress` object; a Tapis job posts the same object to a route authenticated by its job token (`X-Compute-Job-Token`).
The object names the current checkpoint and, per checkpoint, the counts of recordings passed, failed, skipped and total, plus the most recent failures (relative path, failure code, step), capped in number;
it carries no samples, no free text and no personal data.
The launcher reads the counts from the recipe's own output (the recordings table it already flushes row by row), so a recipe adds no network code and the recipe's no-network fence is unchanged.
Reports come at most once a minute.
The object is declared once in `shared/contract/` and pinned by nemar-process the way the launch specification is.

**4. The backend keeps one progress row per run and checkpoint.**
A new table holds, per pipeline stamp and checkpoint, the four counts, the capped failure list and the time of the last report.
A running job with no report for three cadences (or no heartbeat, which already ends a runner lease) shows as `stalled`, distinct from `failed`.
At completion the row is reconciled from the uploaded recordings table, and a disagreement between the live counts and the table is itself recorded, so a broken reporter is visible.

**5. Admins get one dashboard, built like the Zarr one.**
The admin overview gains a coverage card per recipe (datasets whose current version passed, out of those eligible) with a failure trend, as the Zarr conversion card has.
An admin page shows the legacy grid: datasets as rows, checkpoints as columns, each cell `passed/total` with failed, running, stalled and not-started marked, filters by recipe, recipe version, executor and runner, and a drill-down to the failed files and their codes.
`nemar admin compute pipeline status` gives the same view in the terminal and as JSON.
Both are admin-only.
The people who build metrics are given admin roles, so they read the dashboard and the gated design page directly.

**6. Quality metrics and figures are plugins, and NEMAR reviews every plugin its pipeline runs.**
A plugin is a Python module with a manifest: its name, version, checkpoint, what it reads (the floor's or the decomposition's outputs, or the dataset itself), its parameters and the schema of what it writes.
It writes signalJourney entries, `qualityMetrics` on the step it adds and `summaryMetrics` for headline numbers, which is the shape signalJourney already defines for any processing step, so a plugin needs no format of its own.
For display it may also write figures in a fixed list of formats (Portable Network Graphics, Scalable Vector Graphics, WebP) under a size cap.
It never writes samples, as no recipe does.
The interface is general and public: NEMAR's team writes the first plugins, and anyone may write one against the same manifest and run it on their own machine or as their own compute job through the gateway.
What runs in NEMAR's pipeline, and so what NEMAR shows for a dataset, is the set of plugins merged into nemar-process through reviewed pull requests, each pinned by version in the image; NEMAR never runs an unreviewed plugin under its own identity.
A plugin in NEMAR's pipeline follows the recipe rule for numerics: every signal-processing call is an eegprep function, and a missing one goes into eegprep upstream; drawing a figure from those results may use the image's plotting library.

**7. The first plugins port the legacy set, then extend it.**
Ported from `eeg_nemar_dataqual.m`: the share of data kept, the share of channels kept, the share of components ICLabel calls brain, the mutual information reduction (MIR) of the decomposition, and the line-noise magnitude in decibels.
Ported from `nemar_plugins/`: the power spectrum with scalp maps at fixed frequencies, ICLabel component maps, the ICLabel class histogram, component activations, and a raw segment from the middle of the recording.
The dataset summary keeps the legacy bounds and distributions (the QC document's `distributions` already holds them).
Signal-to-noise measures and further scalp maps come next, each as its own plugin and version.

**8. The same contract is the platform for every compute job, not only NEMAR's pipeline.**
A job that follows it (it runs in a nemar-process image or one built from it, under the launcher, declares its checkpoints, and writes signalJourney records and a recordings table) gets the same submission and the same reports wherever it runs.
On a person's own machine, the launcher writes the progress and results reports locally from the same files, with no NEMAR service involved.
On NEMAR's workstation runners and through Tapis on the supercomputer, the backend receives the same `progress` object and reconciles the same results, so the job's owner sees progress and a results report in their own job view, and admins see it in the dashboard.
Third parties, whether researchers submitting their own jobs or partner sites, adopt the platform by following the contract: the launch specification, the plugin manifest and the progress object are public and versioned.
A job that does not follow it still runs as it does today, with the job-level states only.

## Consequences

- Admins can tell where a dataset stopped and which files broke without opening a job's outputs, and a silent job is flagged as stalled instead of looking busy.
- The progress object is a new contract between nemar-cli and nemar-process: a change to it needs a pin bump on both sides, and the heartbeat schema stops being phase-only.
- The Tapis route is a new job-token surface; it accepts only the closed object and only for a job that is running, and it is revoked with the job token.
- One more table, reconciled at completion, and one more admin page and card in the website.
- Recipes gain a step-to-checkpoint map; a recipe version that changes it changes its registry entry.
- Adding a metric is writing a plugin against one manifest, for NEMAR's team and for outside experts alike.
- A plugin reaches NEMAR's pages only through review and the upstream-first rule, which is slower than dropping in a script, and deliberately so: the numbers NEMAR shows for a dataset are NEMAR's claim.
- Job submission and reporting become one path across a person's machine, NEMAR's runners and the supercomputer, for NEMAR and for third parties; the cost is that the launch specification, the manifest and the progress object are public interfaces that must stay versioned and backward compatible.
- The manifest is a public interface: changing it needs a version, and plugins written against the old one must keep working or be refused by name.

## Alternatives considered

- **Report only at job end:** simplest, but a long job reads as "running" until it ends and a hung one is invisible; the Zarr experience and the legacy status file both showed admins need the in-between.
- **Report every step instead of checkpoints:** exact but noisy, and it ties the dashboard's columns to each recipe's internal steps, which change with every recipe version; checkpoints stay stable across versions.
- **Let the recipe post progress itself:** it would put network code inside the recipe and break its no-network fence; the launcher already reads the recipe's outputs.
- **A separate progress or results format beside signalJourney:** two records of the same run drift, and the process already writes signalJourney.
- **Running any plugin that ships a valid manifest, without review:** grows faster, but runs unreviewed code under NEMAR's identity and publishes its numbers as NEMAR's.
- **Closed recipes only, no plugin interface:** keeps control but makes every new metric a recipe change; the manifest gives the same control through review at lower cost.
- **Any output type a plugin declares, such as NumPy arrays:** derived signals could leave through plugins; display images and JSON cover the display need.

## Receipts

- The lab's request of 2026-11-19 (progress and error tracking, metric plugins with JSON and display output, extensibility).
- Legacy pipeline: `sccn/NEMAR-pipeline` (`sbatch/pipeline_status_all.csv`, `eeg_nemar_dataqual.m`, `nemar_dataqual.m`, `eeg_nemar_plugin.m`, `nemar_plugins/`).
- nemar-process: `docs/recipes.md` (recordings table, exit codes, the upstream-first and annotation rules), `recipes/nemar_process/common/records.py` (`qualityMetrics`, `summaryMetrics`), `docs/schemas/qc-summary.v1.json`.
- nemar-cli: `shared/contract/compute-runner.ts` (`RunnerHeartbeatRequestSchema`), migrations 0117 and 0141 (pipeline stamps), 0143 (derivatives); the website's admin overview Zarr coverage card.
- Related: ADR 0118 (gateway and records), ADR 0121 (executors and runners), ADR 0123 (derivatives store), ADR 0033 (the Zarr queue's engine stamps).
- signalJourney: https://signaljourney.github.io/introduction/
