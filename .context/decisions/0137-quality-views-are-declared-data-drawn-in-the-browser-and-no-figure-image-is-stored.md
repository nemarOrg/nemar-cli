# ADR 0137: Quality views are declared data drawn in the browser, and no figure image is stored

**Status:** proposed
**Date:** 2026-11-23
**Owner:** Seyed Yahya Shirazi

Partially supersedes [ADR 0134](0134-pipelines-report-checkpoints-live-and-quality-metrics-are-reviewed-plugins.md) where it names figures or a floor value:
its decisions 2, 6, 7 and 9 (the `figures` checkpoint, figure formats and caps, the first figure plugins, a plugin that re-reports a floor value, and the homes of figure rules), and its rejected alternative of array outputs;
the word "figures" in its decision 1 now reads "views".
Every other part of ADR 0134 stands.
Refines [ADR 0123](0123-derivatives-live-in-a-keyed-store-named-by-what-they-read.md) with the first route that serves a derivative's product files.

## Context

ADR 0134 decided that quality plugins draw figures (Portable Network Graphics (PNG), Scalable Vector Graphics (SVG) or WebP under a size cap, a time series raster only) at a `figures` checkpoint, and rejected plugins that return arrays because "derived signals could leave through plugins".
No figure plugin was built: nemar-process's plugin runner (nemarOrg/nemar-process#76) refuses one as `figures_on_hold`, holding figures for this decision.
Each legacy figure in `nemar_plugins/` draws a few small arrays.
nemar-ica already writes most of them as exact text (`_mixing.tsv`, `_unmixing.tsv`, `_components.tsv`), and the floor writes `_channels.tsv` and `_badsegments.tsv`.
The three it lacks are small (`_chanlocs.tsv`, `_spectrum.tsv`, `_icclasses.json`): about a third of a megabyte per recording at 64 channels, nearly all of it the spectrum, computed from the formats and not measured.
A stored image cannot follow the site's theme, be read by a screen reader, be checked against the numbers it shows, or be redrawn when a drawing is fixed, and it puts a plotting library in the pipeline.
Two facts limit what a browser can draw honestly.
nemar-ica is dispatched only on the dataset's archive copy today, so no digest ties its decomposition to the serving copy a browser reads, and a browser cannot redo the filters and artifact subspace reconstruction (ASR) a decomposition needs.
And the signal viewer's scalp map assumes a coordinate frame when a recording declares none or one it does not know, so a map can be drawn in the wrong orientation with nothing to say so.

## Decision

**1. NEMAR stores no figure image, and no NEMAR code draws one.**
A quality view is data that a browser draws.
`figures` leaves the standard checkpoints; plugins run at `quality`.
No file of nemar-process imports a plotting library; matplotlib stays only as a dependency of eegprep.

**2. neuroschema owns the view vocabulary (0.6.0, breaking).**
The record-level `dataQuality` replaces `figures` with `views`.
A view declaration has a key, a namespaced `kind` with its own `kind_version`, a caption, a source (a plugin or a recipe, by name and version), a scope, parameters, and stored `data[]` (each with role, location, format, size, Secure Hash Algorithm 256 (SHA-256) digest, columns and dimensions), or `inputs[]` with a named, versioned `transform`, or both.
An input is a derivative file named by its SHA-256 or a serving store named by its `nemar.store-content.v1` digest (`content_sha256`), which may be null only when the view's derivative has profile `archive` (its decomposition read the archive copy).
Kinds have two layers: five generic kinds (`nemar.table`, `nemar.lines`, `nemar.heatmap`, `nemar.histogram`, `nemar.sensor-field`), each with one renderer and one parity suite, and specific kinds that are presets over one of them (`nemar.spectrum`, `nemar.ic-maps`, `nemar.ic-classes`, `nemar.ic-activity`, `nemar.signal-window`).
A renderer that does not know a kind or a version draws its base if it knows that, and otherwise shows the data as a table with a download; an unknown kind is never an error.
Dimensions are an open vocabulary, each with coordinates, a unit and a type; `time`, `epoch`, `recording`, `subject`, `contact` and `sensor` are reserved names with fixed meanings.
A sensor role states its unit, the Brain Imaging Data Structure (BIDS) name of its coordinate system, each row's sensor type, and whether its positions are `measured` (taken from the dataset's own files, which NEMAR does not verify) or `template`;
the two-dimensional layout is a role apart from three-dimensional positions.
`scope` is `recording`; `subject`, `dataset` and `collection`, with their source records' digests, are reserved and nothing reads or writes them yet.
Formats are an open registry, `tsv` and `json` today.
A new kind or format is an addition; a change to one is a new version.
A `qualityMetric` names exactly one producer, a plugin or a recipe.
signalJourney records the derivation: each view file is an `outputTargets` entry of the step that wrote it, and the declarations sit in the record's `extensions.nemar.views`, which the backend projects into `dataQuality`.
nemar-cli keeps the plugin manifest and the serving route and vendors the rest; nemar-process and the website copy what they use by digest.

**3. The scalp map is NEMAR's own algorithm, `nemar.sensor-field.v1`, with eegprep as its reference, and no position is guessed silently in the viewer or in any sensor-field view without a layout role.**
neuroschema states it: the layout's theta and radius, EEGLAB's plotting and interpolation radii and squeeze, a 67-by-67 grid masked at the head radius, the biharmonic Green's function d²(ln d − 1) solved in double precision by lower-upper (LU) decomposition with partial pivoting, six interior contour levels, and symmetric limits for a diverging map.
It also states what eegprep leaves implicit: sensors closer than 10⁻³ layout units are merged and their values averaged, and fewer than three usable sensors draw no map.
eegprep at a pinned commit is the reference implementation.
The website's renderer and a Python reference renderer in neuroschema are held to the same vectors: every cell within 10⁻⁶ times the reference map's range, and the same masked cells.
Montages with duplicate positions and with rank-deficient interpolation matrices are among the vectors.
`nemar.sensor-layout.v1` (positions to layout) and `nemar.ic-activity.v1` are specified and tested the same way.
`nemar.sensor-layout.v1` turns measured positions into a layout only from a coordinate system it knows by its BIDS name, and it never assumes one.
When a recording has no measured positions, or their coordinate system is undeclared or unknown, positions are inferred from the electrode names by `nemar.sensor-labels.v1`, which neuroschema owns and holds to vectors like the others.
It keeps channels typed as electroencephalography (EEG) or untyped, leaving out fiducials and untyped labels that name another signal;
normalizes each label (case folded, and a modality prefix or reference suffix removed, as in `EEG Fp1-REF`);
takes the old and new names of one site as aliases (T3 and T7, T4 and T8, T5 and P7, T6 and P8);
and matches the result against standard montages, MNE-Python's at a pinned version, with each montage's provenance recorded.
Its thresholds are stated defaults: at least 8 channels matched, and a matched share of at least 0.8.
When no montage passes, it refuses with one reason: `duplicate_label`, `montage_ambiguous`, `too_few_matched`, `too_few_channels`, `bipolar_labels`, `labels_unrecognized` or `share_too_low`.
Measured positions in a known coordinate system are used as they are;
inferred positions are `template` positions, and the view says that they were inferred and why;
on a refusal no map is drawn and the view gives the reason.
This holds for the signal viewer's live scalp map, which moves onto the same code, and for any sensor-field view that carries no layout role;
the pipeline does not use it, and ICLabel still needs declared positions.
A recipe's layout role records its `coordinate_system` (which may be `n/a`) and its `position_source`, so a view drawn from it says where its positions came from.

**4. A plugin returns data; the runner checks it and writes it.**
The plugin manifest's `outputs.views` replaces `outputs.figures`; `nemar.plugin-manifest.v1` is edited in place, because it has never been published or pinned outside this epic.
A plugin returns metrics and arrays or mappings, never a file or a drawing.
The runner checks each role against its declared dimensions (`sensor` equals the good channels in layout order, `component` the rank, `class` ICLabel's classes, and a frequency axis rises strictly to a recorded upper bound), caps each dimension at 1,024 entries, each role at 262,144 cells and each file at 4 mebibytes, checks a JavaScript Object Notation (JSON) role against its kind's schema, and writes the files with the recipes' deterministic writers.
A plugin whose output fails a check is skipped (`plugin_failed`) and the recording is kept.
A plugin declares at least one metric or view (`plugin_without_output`).
A plugin's metric is named `<plugin>:<name>`, which the manifest contract enforces (`metric_not_prefixed`);
a recipe's own metrics are bare names declared as literals in the recipe.
No plugin reports a value a recipe already reports: the floor's share of data kept, share of channels kept and line-noise magnitude are recipe metrics, and the plugin planned to re-report them is dropped.
The plan hash holds each plugin's identity (name, version and `tree_sha256`, the SHA-256 of its source tree) and its outcome, so two versions with equal parameters hash differently and a skipped plugin changes the hash.

**5. The first views replace ADR 0134's first figure plugins.**
nemar-ica declares its own views: component maps from its mixing matrix and a new `_chanlocs.tsv`, activations computed in the browser (decision 9), and the two-second window of good samples nearest the middle of the recording, opened in the signal viewer.
nemar-quality writes the ICLabel class summary behind the class histogram (`_icclasses.json`), and nemar-spectrum writes the power spectrum (`_spectrum.tsv`).
The spectrum is Welch's method with two-second Hamming windows at 50% overlap, in decibels relative to 1 µV²/Hz.
The method, window, overlap, unit and upper bound are recorded as the view's parameters;
the bound is 125 Hz unless the recording's Nyquist frequency is lower, and the recorded bound says which, so spectra compare where their bounds agree.
nemar-ica reads the Zarr serving copy, the copy a browser reads, so that its record names that store by its content digest (nemarOrg/nemar-process#79).
Its decomposition always reads preprocessed data, as the legacy NEMAR pipeline's did, whether its input is the Zarr serving copy or the BIDS archive copy:
a high-pass filter, line-noise removal (CleanLine or Zapline-plus), ASR with a cutoff of 30 and the removal of bad channels, then the decomposition.
The record states this as `decomposition_input`: the source (with the store's content digest when it is the serving copy), the kept channels, the unit, the reference, ASR and the filters.

**6. View files are checked by digest, and what that proves is stated.**
View files live in the run's product in the derivatives store, never in the serving copy or a dataset repository.
The record and the projection carry each file's size and SHA-256; the server hashes a file again when it reads it from storage, and the browser checks the SHA-256 before it parses.
These checks catch corruption in storage, cache or transit; they do not protect against a dishonest backend, which serves both the files and their digests.

**7. One route serves view files, under the dataset's current read rule.**
The server resolves the derivative to its dataset and checks that dataset's current visibility, status and anonymity (ADR 0065) on every request, before any cache.
Public pages read only `catalog` and `published` derivatives, and of those the newest by `stored_at`, with a note naming the dataset version it was computed on;
`canary` is for administrators; a private dataset is read only through the caller's own authorization (ADR 0124).
The route serves only files that a stored derivative's record declares for a view, at most 4 mebibytes each.
Public responses are cached in a browser for at most 300 seconds, carry a per-dataset cache tag, and sit in the edge cache under a per-dataset epoch that every visibility or status change advances, so an unpublish or a withdrawal takes effect at the next request;
private and administrator responses are not cached.
An expired derivative or a missing file is answered with a fixed word, never a server error.
No address into the derivatives bucket is signed and no file is copied to a public bucket.
A view file is from tens of kilobytes to about 1.5 megabytes at 256 channels, under the 4 mebibyte cap, which keeps serving it through the Worker within principle 9 of ADR 0136.

**8. A recording's quality is read when asked; D1 holds dataset summaries only.**
The backend projects a recording's `dataQuality` document from its signalJourney record in the derivatives store on request, and caches it by the record's digest.
D1 keeps each run's dataset-level `dataQuality` document, which the recipe writes and the backend checks against the dataset record's digest;
pages show the one from the derivative decision 7 picks, the newest promoted by `stored_at`.

**9. The website draws the views and says what it drew.**
The dataset page gets a Quality panel (Spectrum, Components, Activations and Signal) and a dataset summary drawn on the server; administrators get a drill-down from the pipeline run page.
There is no chart library, no new dependency and no change to the Content Security Policy.
A number on screen comes from a stored row: a hover snaps to a stored row, and a map's readout is the sensor's stored value.
Activations are computed in the browser by `nemar.ic-activity.v1`, which applies no preprocessing:
it multiplies the serving copy's kept channels by one weights matrix, the decomposition's unmixing matrix times its sphere matrix times the average-reference matrix over those channels, in store row order and with the store's unit folded in.
They therefore approximate what was decomposed, by design, because the browser does not redo the high-pass filter, line-noise removal or ASR, and their caption says so.
They are labeled as computed, and they shade the floor's bad segments.
A 1 Hz high-pass filter is a display filter only: the activation view declares it as a parameter, and it is not part of the decomposition's input.
The store's content digest checks that the browser reads the channels and data the record names.
Nothing is drawn when the store does not hold each kept channel exactly once, or when the store publishes a content digest that differs from the one `decomposition_input` names.
When the store publishes no digest yet, activations are drawn with a fixed caption saying that the serving copy was not checked against the record.
A decomposition of the archive copy keeps a caption of its own, saying that it read the archive copy, which no digest ties to the serving copy.
Colors come from design tokens, with colorblind-safe diverging and sequential maps and a toggle to turbo.
Every component map has a text row.
Exports are made only on request (PNG at two to four times in a light print palette, SVG for the spectrum and the histogram, and the raw files), and each embeds the view's digest (`nemar.view-digest.v1`), its kind and kind version, and a permalink.
Once its data arrive, one view at 128 channels draws within 100 milliseconds (its first maps within 50) and at 256 channels within 300, on a mid-range laptop;
a miss is fixed in the renderer, and a binary format needs a new ADR and a measurement showing that text is the cause.

**10. Homes.** These rows replace two rows of ADR 0134's table, "Quality results per recording" and "NEMAR's rules for signalJourney records"; the rest of its table stands.
Of the second row, the figure formats and size caps are gone, metric naming moves to the plugin manifest, and the no-samples rule and NEMAR's other rules for signalJourney records stay in signalJourney's `nemar` namespace.

| Artifact | Home |
|---|---|
| View vocabulary (declaration, kinds, dimensions, formats, transforms, `nemar.sensor-field.v1`, `nemar.sensor-layout.v1`, `nemar.sensor-labels.v1` and its montages, `nemar.view-digest.v1`, parity vectors, the Python reference renderer) | neuroschema 0.6.0, vendored by nemar-cli in `shared/contract/neuroschema/`, copied by digest into nemar-process and the website |
| A recording's views and metrics | neuroschema `dataQuality`, record level, projected on request from the signalJourney record |
| The derivation of each view file | the signalJourney record: the writing step's `outputTargets` and `extensions.nemar.views` |
| Plugin `outputs.views` and metric naming (`<plugin>:<name>`) | nemar-cli `shared/contract/plugin-manifest.*` |
| The serving route's paths, words and bounds | nemar-cli `shared/contract/quality-route.ts` |
| The renderer | the website, `src/lib/quality-views/` (website ADR 0035, to be written in W1) |
| The no-samples rule and NEMAR's other rules for signalJourney records | signalJourney's `nemar` extension namespace, unchanged from ADR 0134 |

## Why arrays may now leave a plugin

ADR 0134 rejected "any output type a plugin declares, such as NumPy arrays", because derived signals could leave through plugins.
This ADR does not admit any output type.
An array leaves a plugin only as a role of a declared view of a known kind, in a registered format, with every dimension named, sized against the recording and capped at 1,024 entries, under caps of 262,144 cells per role and 4 mebibytes per file, and with its derivation in the record: the plugin's step and parameters, and, for a computed view, its inputs by digest and a named transform.
A sample axis is not banned by its name: a view with a `time` dimension must show in its declared derivation that it is a reduction, such as an average over epochs, and the caps bound what any one view can carry;
whether a derivation is honest is decided in the plugin's review, as for every plugin in NEMAR's pipeline.
NEMAR's own stored views carry no time axis; activations and the signal window, the only views over time, are drawn in the browser from the serving copy anyone can already read, and are never stored.
The images ADR 0134 accepted carried the same information, a raster trace being samples at display resolution, and hid it from every check;
declared arrays are the narrower channel, because a runner and a reviewer can check them.

## Consequences

- neuroschema 0.6.0 is a breaking release; nemar-cli moves `NEUROSCHEMA_VERSION` to 0.6.0 and re-vendors it.
- The plugin manifest loses figure formats and caps, and all four copies of the standard checkpoints lose `figures` (nemar-cli, two in nemar-process, the website), each held by a drift test.
- The figure plugins nemar-components and nemar-segment, eegprep's static plotting work, and the plugin that would re-report the floor's values are cut;
  nemar-ica declares its own views and writes `_chanlocs.tsv`, nemar-quality writes `_icclasses.json`, and nemar-spectrum writes `_spectrum.tsv`.
- nemar-ica is dispatched on the Zarr serving copy with the same preprocessing as on the archive copy;
  a run that read the archive copy keeps the archive caption, every Zarr run draws activations with the unchecked caption until the converter publishes per-store content digests, and the converter needs a follow-up that writes those digests at commit (nemarOrg/nemar-cli#2343).
- The derivatives store gains the first route that serves a derivative's product files; ADR 0123's private bucket and server-side copy stand.
- The website owns a small renderer, a worker and its parity suites, and the signal viewer's scalp map changes from a thin-plate spline to EEGLAB's map.
- The signal viewer stops assuming a coordinate frame: a recording whose positions are in an undeclared or unknown frame gets a map from its electrode names when `nemar.sensor-labels.v1` accepts them, and otherwise none, with the reason, so some maps the viewer draws today from as few as three matched labels disappear.
- The montage coordinates come from other projects, so each montage's provenance and license are recorded with it and confirmed before neuroschema 0.6.0 is released.
- A drawing bug is fixed once and every view redraws; no stored image goes stale.
- Activations need the public serving copy, so a private dataset has none in the browser.
- Activations approximate the decomposition's input by design: the browser's single multiply leaves out the high-pass filter, line-noise removal and ASR, and the caption says so; a test holds the folding (the weights matrix times the data equals the unmixing matrix times the sphere matrix times the average-referenced data).
- On the Zarr input, a channel is not typed as electrocardiography (ECG) until eegprep-lean reads each channel's type from the store (sccn/eegprep#668); nemar-process re-pins eegprep once that lands, and until then this is a known limitation.
- Public pages show quality only for promoted derivatives, so a run stays off the dataset page until an administrator promotes it.

## Alternatives considered

- **Store images, as ADR 0134 decided:** they cannot be themed, checked, read aloud or redrawn, and they need a plotting library in the pipeline.
- **Compute the spectrum in the browser:** it fetches the whole recording (about 19 megabytes for ten minutes at 64 channels) to draw a few hundred rows per sensor that a run computes once.
- **Decompose the raw serving copy so activations are exact:** the decomposition's quality drops; on one fixture, the components ICLabel calls brain fell from 11 to 7 of 18 and line-noise components rose from 3 to 6.
- **Redo the preprocessing in the browser so activations are exact:** the high-pass filter, line-noise removal and ASR would each need a browser implementation held to parity with eegprep, for a view that is a display.
- **Assume a coordinate frame when none is declared, as the viewer does today:** a wrong frame draws a plausible map in the wrong orientation that no reader can catch; a map inferred from names under a stated rule, or no map with a reason, is honest.
- **Binary or Zarr view data now:** text is enough at these sizes; binary waits for a measured miss.
- **A chart library:** website ADRs 0007 and 0033 keep the site's own drawing code.
- **Signed bucket addresses or a public copy:** an unpublish could not reach a copy or an address already handed out.
- **One D1 row per recording:** rows would grow with every run's recordings; the record already holds the data.
- **Amend ADR 0134 in place:** the decision index sends a changed verdict to a new ADR.
- **Rename the `figures` checkpoint to `views`:** views are written at `quality`, and a checkpoint per output type would tie columns to outputs.
- **Plugin manifest version 2:** version 1 was never published or pinned outside this epic.
- **Spherical splines, Clough–Tocher or the site's thin-plate spline:** none gives parity with the EEGLAB and eegprep maps that users compare against.
- **eegprep as the specification:** an implementation is not a specification; it leaves duplicate sensors to a pseudoinverse fallback and has no rule for too few sensors, which a second renderer must match exactly.

## Receipts

- The live-views design for epic nemarOrg/nemar-cli#2324 and its review, 2026-11-23.
- nemarOrg/nemar-process#76 (`figures_on_hold`, `plugin_failed`, plugin identity in the plan hash).
- eegprep `functions/sigprocfunc/topoplot.py` and `griddata_v4` at edf694c8.
- `sccn/NEMAR-pipeline` `nemar_plugins/`.
- neuroschema `schema/extensions/dataQuality.schema.json` (0.5.0) and `docs/views.md` (0.6.0).
- signalJourney `qualityMetricsObject`, `outputTarget`, `extensions/nemar` (signalJourney#7 and #8).
- nemar-cli `shared/contract/plugin-manifest.ts`, `shared/compute-recipes.ts`, `backend/src/services/compute-derivatives.ts`.
- The website's `src/lib/eeg-viewer/{topo,gl-trace,store}.ts` and its ADRs 0007, 0009 and 0033.
- ADRs 0123, 0124, 0125, 0134 and 0136.
