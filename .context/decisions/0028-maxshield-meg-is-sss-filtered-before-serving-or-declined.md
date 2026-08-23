# ADR 0028: MaxShield MEG is Signal-Space Separation filtered before serving, or declined

**Status:** accepted
**Date:** 2026-08-20
**Owner:** Seyed Yahya Shirazi

## Context

Some Elekta/MEGIN magnetoencephalography (MEG) recordings are acquired with Internal Active Shielding,
marketed as MaxShield,
in which coils actively cancel external magnetic interference during acquisition.
Active cancellation distorts the signal around what it cancels,
so MEGIN's position is that raw Internal Active Shielding data is not fit for analysis
until it has been through their MaxFilter software,
which models and removes the shielding's effect.
MNE-Python enforces that position:
`read_raw_fif` refuses these files outright unless the caller passes `allow_maxshield=True`,
warning that the data "may be distorted."

The Zarr serving copy inherited that refusal as an opaque `file_read_error`,
so 396 MEG recordings across `on006012` and `on006720` were withheld from the viewer
with no explanation of why.

Two facts reframed the problem.
MEGIN's proprietary MaxFilter is not required:
`mne.preprocessing.maxwell_filter` is an open-source implementation of the same
Signal-Space Separation family,
documented as broadly comparable to MEGIN MaxFilter 2.2.11.
And both affected datasets already ship the site-specific inputs that filtering wants,
an Elekta fine-calibration `.dat` and a cross-talk `.fif` per subject,
because the Brain Imaging Data Structure reserves filenames for exactly those files
so downstream users can run this correction themselves.

## Decision

Apply Signal-Space Separation to a MaxShield recording, and serve the filtered result,
**only when both the fine-calibration and cross-talk files resolve for that recording**.
When either is missing, do not serve the recording:
decline it deterministically and surface MNE's own explanation,
that the recording carries raw Internal Active Shielding data and needs MaxFilter,
instead of a generic read error.

Unfiltered Internal Active Shielding data is never served,
and Signal-Space Separation is never applied without the site-specific calibration
that makes it trustworthy.

## Consequences

365 of the 396 affected recordings become viewable.
All 31 that remain declined are `sub-emptyroom` noise reference measurements rather than subject data,
so the strictness costs no real subject recording.
Every subject in both datasets ships both files:
20 of 20 in `on006012`, 23 of 23 in `on006720`.

**A filtered store is not a faithful copy of its source recording,
and that is a new exception to what the serving copy has meant until now.**
Every other store is the source signal, quantized to int16 and resampled to a modality rate cap,
and nothing more.
A Signal-Space Separation store is a processed derivative.
The index must therefore record that filtering was applied,
and the machine-learning streaming path must be able to see it:
a model trained across datasets would otherwise silently mix filtered and unfiltered MEG
with no signal that it was doing so.
MNE writes the Signal-Space Separation parameters into the recording's own `proc_history`,
which makes the processing auditable inside the data,
but auditability is not the same as disclosure and the index has to say it too.

Conversion for these recordings gets more expensive,
since Signal-Space Separation is a real computation rather than a read,
and it needs the calibration sidecars resolved through Brain Imaging Data Structure inheritance
before conversion can start.

The declined empty-room recordings now carry an honest, specific reason.
That is a small improvement in its own right:
the previous generic `file_read_error` gave a user no way to tell an unreadable file
from a policy decision.

One coupling to keep in mind.
The calibration and cross-talk files are excluded from discovery as recordings by ADR 0027,
correctly, because they are calibration data and contain no measurement.
They are nonetheless read as inputs here.
Those two facts are compatible and must not be conflated;
a future change that treats "excluded from discovery" as "irrelevant to conversion"
would silently break this.

## Alternatives considered

- **Serve unfiltered data with `allow_maxshield=True` and a caveat in the index.**
  Recovers the most recordings for the least work, and was the original recommendation.
  Rejected because it makes the archive display data its own manufacturer says is unfit for analysis,
  and a caveat in metadata is weak protection against a plot that looks plausible.
  The distortion is not visible by eye.
- **Keep declining everything, but with an honest "requires MaxFilter" reason.**
  Safe and cheap, and strictly better than the opaque error it replaces.
  Rejected as the whole answer because it withholds 365 recordings
  that we can in fact correct properly with inputs the datasets already provide.
- **Apply Signal-Space Separation without the calibration pair when it is absent.**
  Technically works, and was verified to run.
  Rejected because uncalibrated Signal-Space Separation is a weaker correction
  whose quality varies by site and hardware,
  and serving it under the same label as a properly calibrated one
  would make the two indistinguishable to a consumer.
  Declining is honest; a silently worse correction is not.
- **Require MEGIN MaxFilter itself.**
  Rejected as unavailable:
  it is proprietary, licensed, and not something the conversion host can run.

## Receipts

Verified against `on006012`'s `sub-01_task-POGS_run-06_meg.fif`
using that dataset's own `sub-01_acq-calibration_meg.dat` and `sub-01_acq-crosstalk_meg.fif`:

- Filtering succeeded with all 336 channels preserved.
- `info["maxshield"]` flips from `True` to `False`.
  MNE's own guardrail, the check that was refusing to load the file, is satisfied by the output;
  the result is no longer raw Internal Active Shielding data by MNE's own reckoning.
  This is the strongest available evidence that the correction is real rather than a flag override.
- Root-mean-square amplitude falls to 62.7% of the unfiltered signal,
  consistent with interference being removed rather than the data passing through untouched.
- `proc_history` records `in_order=8`, `out_order=3`, `nfree=72`, `frame=head`,
  plus both `sss_cal` and `sss_ctc` entries.
- Temporal Signal-Space Separation (`st_duration`) also runs,
  and uncalibrated Signal-Space Separation also runs;
  neither is used under this decision.

Coverage measured from the repository trees:
`on006012` 20 of 20 subjects with both files, 158 of 173 recordings recoverable;
`on006720` 23 of 23 subjects, 207 of 223 recoverable.

An earlier count of 439 recordings for this cause was wrong.
It came from the `zarr_errors` column
and included the 43 calibration and cross-talk files themselves,
which were being attempted as recordings before ADR 0027 excluded them.

## Implementation receipt (2026-08-22)

This decision is **implemented** as of #1126; the status line stays `accepted` because
that field records the decision's standing, and the index test constrains it to
`proposed | accepted | superseded by ADR-NNNN`. The decision's own receipts verified that the correction is real;
what they did not carry is what it costs, which admission control needs.

Measured on the conversion node against `on006720`'s `sub-155`, through the shipped
functions rather than a stand-in:

- Detection (`is_maxshield_fif`, FIF header only, no preload): 1.5 s, 0.14 GiB peak.
  Cheap enough to run on every FIF.
- `apply_sss` on a 716 MiB recording: 57.5 s, peak 2.95 GiB, i.e. **4.2x its on-disk size**.
- The filtered copy then takes the STREAMING conversion path, so `convert_recording` adds
  nothing to that peak: end-to-end peak stayed 2.95 GiB.
- `info["maxshield"]` is clear on the output, as this decision's receipts predicted.

Hence `MAXSHIELD_MEM_FACTOR = 6`. The pre-existing streaming floor of 4 GiB would have
cleared the largest recording in these datasets by under 5%, which is coincidence rather
than headroom: the floor was sized for conversion, and the filter phase is a separate cost
that peaks before conversion starts. Since `apply_worker_mem_limit` sizes `RLIMIT_DATA`
from the projection, an under-projection would not merely over-schedule the node, it would
kill the filter mid-run.

Resolution coverage was re-derived from the current repository trees and reproduces this
decision's projection exactly: `on006720` 207 of 223, `on006012` 158 of 173, every declined
recording under `sub-emptyroom`.

Conversion cost is real: roughly 5 minutes per recording (57 s filtering, ~260 s streaming
conversion), so the 365-recording backfill is on the order of 30 hours of node time.

Related: ADR 0027 (raw-only discovery, which excludes the calibration files as recordings).

## Note on eventual placement

This decision, and the serving-copy guarantees it qualifies,
should eventually be reflected in the public policy documentation rather than living only here,
since it describes what a published artifact does and does not represent.
It stays an Architecture Decision Record for now.
