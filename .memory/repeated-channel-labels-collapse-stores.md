---
name: repeated-channel-labels-collapse-stores
description: A source file that repeats a channel label lost a channel per repeat before biosigio 1.2.9; channels.tsv cannot vouch for the count, only the file header can
metadata:
  type: project
---

EDF does not require unique channel labels. CHB-MIT (nm000110) declares `T8-P8` twice
and uses `-` as a placeholder for several unused inputs. biosigIO keys a Recording by
label, so before 1.2.9 each repeat overwrote an earlier channel on the in-memory path
and the store came up one short per repeat: nm000110 serves 22 of 23 channels. The
streaming EDF path kept every channel but wrote the repeated label as is, which moves
the collapse into any consumer that keys channels by label.

biosigio 1.2.9 suffixes repeats the way MNE does (`T8-P8-0`, `T8-P8-1`; `-` becomes
`--0`, `--1`, ...), records `{new_label: file_label}` under
`recording_metadata.channel_labels_deduplicated`, and `Recording.add_channel` now
raises on a duplicate. Its EEGLAB importer renames repeats `<label>_1`, ... and does
NOT record that map (verified against 1.2.9 on 2026-09-28).

**Why it matters:** the fidelity gate used to consult the file header only when a store
fell short of channels.tsv. A dataset with no channels.tsv, or one written by a tool
that also keys by label, agrees with the collapsed store and passed. Since
`fix/zarr-duplicate-channel-hardening` the header is read for every recording and a
store short of it is always withheld (`channel_gate_verdict`).

A second trap sits in biosigIO's sidecar join: a channels.tsv row applies only to the
channel whose label matches exactly (case included, biosigio#136), and the
`units_report` counts only matched rows, so a missed channel keeps the importer's unit
behind a clean report. `units_report.unmatched_channels` (and `unmatched_raw_label`,
`unmatched_case_only`) now says which.

**What to do:** never key a channel structure by label (a set or dict of labels drops
the repeat); count from a list. To find stores published before the fix, run
`scripts/zarr/find_collapsed_channel_stores.py --dataset <id>` (read-only), then requeue
what it flags on the conversion host.
