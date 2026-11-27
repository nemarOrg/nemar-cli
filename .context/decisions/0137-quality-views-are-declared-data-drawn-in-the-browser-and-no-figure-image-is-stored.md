# ADR 0137: Quality views are declared data drawn in the browser, and no figure image is stored

**Status:** proposed
**Date:** 2026-11-23
**Owner:** Seyed Yahya Shirazi

This record moves to accepted when the nemar-process and website epics that build the rest of it reach their integration branches; the nemar-cli epic (#2324) alone does not complete it.

Partially supersedes [ADR 0134](0134-pipelines-report-checkpoints-live-and-quality-metrics-are-reviewed-plugins.md) where it names figures or a floor value:
its decisions 2, 6, 7 and 9 (the `figures` checkpoint, figure formats and caps, the first figure plugins, a plugin that re-reports a floor value, and the homes of figure rules), and its rejected alternative of array outputs;
the word "figures" in its decision 1 now reads "views".
Every other part of ADR 0134 stands.
Refines [ADR 0123](0123-derivatives-live-in-a-keyed-store-named-by-what-they-read.md) with the first route that serves a derivative's product files, and by adding channel types to what a derivative is keyed by.

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
A view refuses rather than mislead: a position guess that is not confident draws no map and says why, and a declared bad-segment table that is missing or damaged refuses the view.
An activation view whose record says ASR repaired a span is refused (`label_unmatched`) when it declares no bad-segment table or no row of it carries the repaired spans' label;
otherwise the view is drawn and says what it did not shade: `no_bad_segment_table` when it has no table, and, for an activation view whose table has no labeled row, `no_shaded_rows`;
neuroschema's view specifications hold the details.
`figures` leaves the standard checkpoints; plugins run at `quality`.
No file of nemar-process imports a plotting library; matplotlib stays only as a dependency of eegprep.

**2. neuroschema owns the view vocabulary, from neuroschema 0.6.0 (tag `v0.6.0`, nemarOrg/neuroschema#21), a breaking release.**
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
It also states what eegprep leaves implicit: sensors closer than 10⁻³ layout units are merged and their values averaged, and fewer than 8 interpolated sensors draw no map (`too_few_sensors`).
The map interpolates each value's deviation from the mean and adds the mean back.
eegprep's `topoplot` at commit `edf694c8` is the reference implementation; where the two differ, neuroschema's `docs/views/sensor-field.md` decides, and the amendment of 2026-11-24 lists the differences.
Note (#2411): the reference is now eegprep `871bc7f8`, the recipes' engine; neuroschema 0.6.1 regenerated the vectors there, within the regeneration tolerance of the `edf694c8` ones.
The website's renderer and a Python reference renderer in neuroschema are held to the same vectors: every cell within 10⁻⁶ of the reference map's range plus 10⁻¹² of its magnitude (a map of zeros is compared exactly), and the same masked cells.
Montages with duplicate positions and with rank-deficient interpolation matrices are among the vectors.
`nemar.sensor-layout.v1` (positions to layout) and `nemar.ic-activity.v1` are specified and tested the same way.
`nemar.sensor-layout.v1` turns measured positions into a layout only from a coordinate system it knows by its BIDS name, and it never assumes one.
When a recording has no measured positions, or their coordinate system is undeclared or unknown, positions are inferred from the electrode names by `nemar.sensor-labels.v1`, which neuroschema owns and holds to vectors like the others.
It keeps channels typed as electroencephalography (EEG) or untyped, leaving out fiducials and untyped labels that name another signal;
normalizes each label (case folded, and a modality prefix or reference suffix removed, as in `EEG Fp1-REF`);
takes the old and new names of one site as aliases (T3 and T7, T4 and T8, T5 and P7, T6 and P8);
and matches the result against standard montages, MNE-Python's at a pinned version, with each montage's provenance recorded.
Its thresholds are stated defaults: at least 8 channels matched, and a matched share of at least 0.8.
When no montage passes, it refuses with one of nine reasons: `too_few_channels`, `bipolar_labels`, `labels_unrecognized`, `share_too_low`, `too_few_matched`, `cap_model_unknown`, `duplicate_label`, `montage_ambiguous` or `net_coverage_low`.
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
A produced role may state its value `unit`, with the grammar and cap of a neuroschema column `unit` (at most 32 code points, not empty), so a role without `columns` still has one (#2358);
a column's own `unit` overrides the role's for that column, a `{from: "recipe"}` role never carries one,
and the loader requires a role `unit` or `columns` with units on a role of a generic kind that needs a value unit.
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
a high-pass filter, line-noise removal, ASR with a cutoff of 30 and the removal of bad channels, then the decomposition.
Line-noise removal is a conditional band-stop at 50 or 60 Hz today;
ZapLine-plus comes later as an eegprep extension under the GNU General Public License version 3 (GPL-3.0), `eegprep-ext-zapline-plus`, and becomes the default once its parity with the MATLAB implementation is measured.
ASR repairs bursts and cuts nothing;
the share of samples its reconstruction changed is recorded per recording as the quality metric `asrBurstFraction`, and ASR's lack of a mask of repaired samples is tracked upstream (sccn/eegprep#684).
Channel types are kept per row, so a typed lead that is not EEG never enters the decomposition (sccn/eegprep#669),
and the channel types are part of what a derivative is keyed by (nemarOrg/nemar-cli#2344).
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
| View vocabulary (declaration, kinds, dimensions, formats, transforms, `nemar.sensor-field.v1`, `nemar.sensor-layout.v1`, `nemar.sensor-labels.v1` and its montages, `nemar.view-digest.v1`, parity vectors, the Python reference renderer) | neuroschema 0.6.0 (tag `v0.6.0`, nemarOrg/neuroschema#21), vendored by nemar-cli in `shared/contract/neuroschema/`, copied by digest into nemar-process and the website |
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

- neuroschema 0.6.0 (released 2026-11-24 as tag `v0.6.0`, commit e09ed407, nemarOrg/neuroschema#21) is a breaking release; nemar-cli moves `NEUROSCHEMA_VERSION` to 0.6.0 and re-vendors it, with the view files beside the bundle in `shared/contract/neuroschema/views/` and their digests in its `SHA256SUMS.json`.
- The plugin manifest loses figure formats and caps, and all four copies of the standard checkpoints lose `figures` (nemar-cli, two in nemar-process, the website), each held by a drift test.
- The figure plugins nemar-components and nemar-segment, eegprep's static plotting work, and the plugin that would re-report the floor's values are cut;
  nemar-ica declares its own views and writes `_chanlocs.tsv`, nemar-quality writes `_icclasses.json`, and nemar-spectrum writes `_spectrum.tsv`.
- nemar-ica is dispatched on the Zarr serving copy with the same preprocessing as on the archive copy;
  a run that read the archive copy keeps the archive caption, every Zarr run draws activations with the unchecked caption until the converter publishes per-store content digests, and the converter needs a follow-up that writes those digests at commit (nemarOrg/nemar-cli#2343).
- The derivatives store gains the first route that serves a derivative's product files; ADR 0123's private bucket and server-side copy stand.
- The website owns a small renderer, a worker and its parity suites, and the signal viewer's scalp map changes from a thin-plate spline to EEGLAB's map.
- The signal viewer stops assuming a coordinate frame: a recording whose positions are in an undeclared or unknown frame gets a map from its electrode names when `nemar.sensor-labels.v1` accepts them, and otherwise none, with the reason, so some maps the viewer draws today from as few as three matched labels disappear.
- The montage coordinates come from other projects, so each montage's provenance and license are recorded with it, and confirming them is a precondition of the neuroschema 0.6.0 release.
- A drawing bug is fixed once and every view redraws; no stored image goes stale.
- Activations need the public serving copy, so a private dataset has none in the browser.
- Activations approximate the decomposition's input by design: the browser's single multiply leaves out the high-pass filter, line-noise removal and ASR, and the caption says so; a test holds the folding (the weights matrix times the data equals the unmixing matrix times the sphere matrix times the average-referenced data).
- On the Zarr input, a channel is not typed as electrocardiography (ECG) until eegprep-lean reads each channel's type from the store (sccn/eegprep#668); nemar-process re-pins eegprep once that lands, and until then this is a known limitation.
- Public pages show quality only for promoted derivatives, so a run stays off the dataset page until an administrator promotes it.

## Amendment 2026-11-24: what the neuroschema 0.6.0 release review settled

The adversarial review of neuroschema 0.6.0 (nemarOrg/neuroschema#27 to #30, merged into `feature/issue-21-views-0.6.0` at 68c549cd) settled the rules below.
neuroschema's `docs/views.md`, `docs/views/` and `docs/processing-extensions.md` state them in full and hold them to vectors.
Decisions 1 and 3 above are corrected to match, and this section records what changed and why.
Where this amendment and the decisions above differ, this amendment holds.

**Scalp maps (`nemar.sensor-field.v1`).**
- Parity is with eegprep's `topoplot` and `griddata_v4` at `edf694c8` (`871bc7f8` since neuroschema 0.6.1, #2411), which follow EEGLAB's `topoplot` and its v4 interpolation.
  Where they differ, `docs/views/sensor-field.md` decides:
  the map interpolates each value's deviation from the mean and adds the mean back, z = m + spline(v − m), because the biharmonic spline has no constant term and a shared offset (a spectrum's decibels) would ripple across the color axis;
  sensors within 10⁻³ merge at their mean, where eegprep gives an empty map for duplicates;
  a sensor whose value is not finite is dropped with its value, where eegprep shifts the later values onto the wrong sensors;
  the `minmax` axis widens by 5% of the range on each side, where EEGLAB moves each limit away from zero and clips a map of one sign (the `absmax` axis stays EEGLAB's);
  the nose is EEGLAB's, not eegprep's triangle, and the head outline is a circle on the layout's equator (`0.5 * squeezefac`), as eegprep draws it and 0.35% outside EEGLAB's;
  and fewer than 8 sensors, a grid past the head and an interpolation that overflows are refused with a word, where eegprep draws or returns an empty map.
- A map needs at least 8 interpolated sensors (`too_few_sensors`):
  a spline through fewer shows the spline more than the field, and 8 is what `nemar.sensor-labels.v1` needs to place sensors by name.
- A field whose usable sensors share one value is that value in every cell, with the note `flat_field`;
  one whose range is at most 10⁻⁹ of its magnitude is one color at the mean, with the note `near_flat`,
  because a spline over differences in the last digits would fill the color axis with noise.
- Merged values and the mean are computed as `first + sum(x − first) / k`,
  so equal values give themselves exactly and values near the binary64 limit do not overflow.
- Parity is every unmasked cell within 10⁻⁶ of the reference map's range plus 10⁻¹² of its magnitude, and a map of zeros is compared exactly;
  the second term absorbs the last bits of a map drawn at its mean.

**Placement words.**
Each word, when it refuses, takes every map's place, and the view's other parts are still drawn.
- `frame_not_scalp`: the positions are in a coordinate system of intracranial recordings (`Pixels`, `ACPC` or `ScanRAS`), so no scalp map is drawn from them, by place or by name.
- `no_eeg_sensors`: no sensor says it is EEG: measured positions whose rows are none of them typed EEG (untyped, or an intracranial recording's SEEG, ECOG or DBS contacts), or other sensors typed and none EEG; a scalp map draws EEG sensors only.
- `montage_unknown`: a template layout names a montage that neuroschema's montages do not hold, compared exactly, so nothing else would stop it being drawn.
- `template_name_unknown`: a row of template positions names no electrode of the montage they declare.
- `frame_unknown`: positions name a frame whose orientation is not known, or name it inconsistently, so they cannot be projected.
- `positions_flat`: measured positions too flat, or too few, to locate the head's center.
- `positions_partial`: measured positions that cover too little of the head, or fix its center too unstably (below).
- After `frame_unknown`, `positions_flat` or `positions_partial`, the sensors are placed by name when every drawn row is typed EEG, and the reason is kept in `unused_positions` so the map says why its positions were not used;
  otherwise the projection's word takes every map's place.
- The label algorithm's nine refusal reasons also take every map's place, among them `cap_model_unknown`, new in the review,
  when names number an Electrical Geodesics, Inc. (EGI) net and the recording's cap model does not name the HydroCel net they point to;
  and `net_coverage_low`, which decision 3 had left out,
  when names match fewer than 90% of a numbered net's electrodes, so they may come from another cap with the same numbering.

**Position rules.**
- Measured positions (a layout or positions role) must declare `sensor_type`, because only rows typed EEG are drawn;
  template positions and names may be untyped.
- Only scalp rows are fitted: the rows typed EEG when any row is typed, never a fiducial, and never a row at (0, 0, 0), which is a missing position.
- `positions_partial` refuses when any of four bounds fails:
  the dilution of the fitted center D > 4.5;
  the leave-one-out move of the center L > 0.12 of its radius;
  the whole-head coverage C > 38°, when some quadrant (front, back, left or right) has no position within 38° above the equator, or below it;
  or the azimuth gap G > 120°.
  Each bound is calibrated between the sparse whole-head montages it keeps and the regional sets it refuses.
- The residual is documented, not closed: at 8 mm of per-axis noise about 1.3% of motor-imagery-16 draws (and 0.1% of P300-8 draws) still pass,
  and no angular bound removes them without refusing sleep montages.
  A head-size bound for positions that declare units is tracked in nemarOrg/neuroschema#31.

**Labels.**
- A recording is placed by name on a HydroCel net only when its `CapManufacturersModelName` names that net from an exact list;
  `ManufacturersModelName` is not read.
  Older EGI nets number their electrodes alike on other positions, so names alone never decide between them.
- The older EGI nets are never reached by names;
  a sensor role reaches one only as template positions that name it exactly.
- A name is folded by a fixed table (full-width ASCII and the compatibility spaces), never by Unicode normalization such as NFKC, whose mappings grow with each runtime's Unicode version;
  a key with any character outside ASCII matches no montage.
- The channel `EEGReference` names is reported as the reference, and only on a 10-05 montage or a HydroCel net; on a BioSemi cap the bank labels are also the ear names, so the reference names no channel.
  The reference row is kept, and a map leaves it out of the interpolation only when every value of that row, in every map, is exactly zero, since after re-referencing it carries data.
- `cap_model` and `reference` (BIDS `CapManufacturersModelName` and `EEGReference`) are carried by the role that names the sensors: the positions role, or the values role when there is no sensor role; never a layout.
  A placement by name passes them to `nemar.sensor-labels.v1`.

**`sensors_mismatch`.**
One definition, `check_sensor_names`, serves a scalp map's model and `nemar.spectrum`.
In a scalp map whose sensors run along the value columns and are placed by a layout or positions role, the role's name cells, top to bottom, must be the value columns' names in declared order, compared as exact text.
In `nemar.spectrum` with a layout, the values' sensor columns (every declared column but `freq_hz`) must be the layout's `name` cells, top to bottom, compared as text.
A spectrum whose sensors mismatch shows as the fallback's tables, with no lines and no maps,
because no value may be drawn at another sensor's place.

**Envelope rules.**
- Every JSON text neuroschema reads (a view's JSON file, a declaration the view digest reads, a document the validator checks) is Internet JSON (I-JSON, RFC 7493):
  UTF-8 with no byte order mark; no object with two members of one name however the names are escaped; no `NaN` or `Infinity`, and every number finite as a binary64; no lone surrogate or noncharacter, written or escaped; and at most 64 levels of nesting.
  Each number is read as the binary64 nearest its text, as `JSON.parse` reads it, and a schema check applies to that reading, so Python and a browser read one document alike.
- Every `integer` in every schema is capped at 2^53 − 1 in magnitude, a schema rule.
- Every schema's `$id` is absolute and pinned to `v0.6.0`, so relative references resolve the same in every engine, and validation fetches nothing.
- Schema patterns use explicit character classes, never a bare `.` or the shorthand classes `\s`, `\S`, `\d`, `\w` and `\b`, which Python and JavaScript read apart; a test guards every pattern.
- A location (`relativeLocation`) is a relative POSIX path with no leading slash, URI scheme, `.`, `..` or empty segment, trailing `/`, backslash, `%`, `?` or `#`, leading or trailing space, control character (C0, DEL or C1), line or paragraph separator (U+2028, U+2029) or bidirectional control,
  so it names one file under every URL resolution and cannot show one name as another.
- A data entry's or file input's `size` is at most 4,194,304 bytes, and a renderer checks the declared size before it fetches the file, so `cap_exceeded` comes before `file_missing` or any digest.
- The extension and the format name each other in both directions: a location ending in `.tsv` or `.json`, in any case, is of that format, so an `.html` file cannot pose as a table.
- Every table `nemar.ic-activity` and `nemar.signal-window` read is the recording's, at the stem nemar-process gives its products under the label of the view's recipe (`table_location_mismatch`),
  so a view cannot be pointed at a decoy table of another recording or recipe.
- A plugin's name has the grammar of a metric name's prefix, so each plugin metric is `<plugin>:<name>` and stays a safe document key.
- `nemar.record-checks.v1` holds the cross-field rules of a recording's entry, which the backend and a renderer both run:
  `metric_producer_mismatch`, `view_source_mismatch` and `view_key_repeated`.
- `views_skipped` lists the views a run did not write for a recording, with one of the words `labels_unusable`, `plugin_failed`, `step_failed`, `step_skipped` or `cap_exceeded`, so no view goes missing silently.
- A view's `base` never names a preset, so a renderer that falls back to the base always reaches a generic kind.
- `dataQuality` is closed at its root and in its record and dataset definitions, so a misspelled member is refused, not ignored.
- Each metric has exactly one producer, a plugin or a recipe: a bare name requires the producer `recipe`, `<plugin>:<name>` the producer `plugin`.

**Presets.**
- The activation view's display filter runs over the window and up to one second of real context on each side, padded only at the recording's ends, so the same window always gives the same numbers;
  activations are labeled `a.u.`, since an unmixed time course has no physical unit.
- The spectrum's Welch estimate detrends each window by its mean, averages by the mean, is one-sided, and leaves out the 0 Hz row, which a mean detrend makes meaningless.
- `nemar.ic-classes` labels a bar's variance "summed variance of components classed X", never "variance explained by X", because the components are not orthogonal.

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
- eegprep `functions/sigprocfunc/topoplot.py` and `griddata_v4` at edf694c8, and at 871bc7f8 since neuroschema 0.6.1 (#2411).
- `sccn/NEMAR-pipeline` `nemar_plugins/`.
- neuroschema `schema/extensions/dataQuality.schema.json` (0.5.0) and `docs/views.md` (neuroschema 0.6.0, tag `v0.6.0`, nemarOrg/neuroschema#21).
- signalJourney `qualityMetricsObject`, `outputTarget`, `extensions/nemar` (signalJourney#7 and #8).
- nemar-cli `shared/contract/plugin-manifest.ts`, `shared/compute-recipes.ts`, `backend/src/services/compute-derivatives.ts`.
- The website's `src/lib/eeg-viewer/{topo,gl-trace,store}.ts` and its ADRs 0007, 0009 and 0033.
- ADRs 0123, 0124, 0125, 0134 and 0136.
