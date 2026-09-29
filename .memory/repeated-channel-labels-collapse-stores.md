---
name: repeated-channel-labels-collapse-stores
description: A source file that repeats a channel label lost a channel per repeat before biosigio 1.2.9; channels.tsv cannot vouch for the count, only the file header can
metadata:
  type: project
---

EDF does not require unique channel labels. CHB-MIT (nm000110) declares `T8-P8` twice
and uses `-` as a placeholder for several unused inputs. biosigIO keys a Recording by
label, so before 1.2.9 each repeat overwrote an earlier channel on the in-memory path
and the store came up one short per repeat: all 686 of nm000110's stores were short,
22 of 23 channels being the commonest case (measured with the detector on 2026-09-28).
The streaming EDF path kept every channel but wrote the repeated label as is, which moves
the collapse into any consumer that keys channels by label.

biosigio 1.2.9 suffixes repeats the way MNE does (`T8-P8-0`, `T8-P8-1`; `-` becomes
`--0`, `--1`, ...), records `{new_label: file_label}` under
`recording_metadata.channel_labels_deduplicated`, and `Recording.add_channel` now
raises on a duplicate. Its EEGLAB importer uses a different scheme: the FIRST
occurrence keeps its label and the second becomes `<label>_2`, then `_3`, ... (never
`_1`); it does NOT record that map (verified in `importers/eeglab.py` of 1.2.9 on
2026-09-28). biosigio PR #140, merged and shipping as 1.2.10, records the EEGLAB, XDF
and neo renames under `channel_labels_deduplicated` too; once a release carrying it is
the floor, `positions_for_renamed_labels` and `units_report.unmatched_raw_label` cover
EEGLAB renames with no change here, since both read only that map. That release is
capped out for now (`>=1.2.9,<1.2.10`, see the sidecar join below).

**Why it matters:** the fidelity gate used to consult the file header only when a store
fell short of channels.tsv. A dataset with no channels.tsv, or one written by a tool
that also keys by label, agrees with the collapsed store and passed. Since #1538 the
header is read for every EDF/BDF, BrainVision and FIF recording, and a store short of it
is always withheld (`channel_gate_verdict`). Other formats (EEGLAB `.set`, CTF, MEF3,
4D/BTi, KIT) have no cheap header read (`file_declared_channel_count` returns None), so
they are still compared with channels.tsv alone.

A second trap sits in biosigIO's sidecar join: on 1.2.9 a channels.tsv row applies only
to the channel whose label matches exactly, case included (biosigio#136), and the
`units_report` counts only matched rows, so a missed channel keeps the importer's unit
behind a clean report. `units_report.unmatched_channels` (and `unmatched_raw_label`,
`unmatched_case_only`) now says which. biosigio 1.2.10 (the converter's floor since
this was written) matches a case-only difference when exactly one channel folds to the
row, applies it (converting the unit), and reports it as `matched_case_insensitive`, a
per-channel map. `sidecar_join_report` reads that map; the index republishes it only
bounded, as `units_report.matched_case_only` plus at most five examples, and the schema
refuses the raw map. `unmatched_case_only` on a store means it was converted before 1.2.10
or the case match was ambiguous.

**What to do:** never key a channel structure by label (a set or dict of labels drops
the repeat); count from a list. To find stores published before the fix, run
`scripts/zarr/find_collapsed_channel_stores.py --dataset <id>` (read-only), then requeue
what it flags on the conversion host.
