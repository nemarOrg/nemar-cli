# ADR 0073: A declared `.fdt` outside the raw tree is fetched for its `.set`, never discovered

**Status:** accepted
**Date:** 2026-09-28
**Owner:** Seyed Yahya Shirazi

## Context

An EEGLAB `.set` that keeps its samples in a separate `.fdt` is read from the `.fdt` beside it.
on004306 ships every raw `.set` without that sibling:
each header names a `subNN_sessN.fdt` that is absent,
and the data files sit under `derivatives/fdt_files/` with names that match neither the `.set` nor each other
(`sub13_sess-01/` holds `sub12_sess01.fdt`).
All 15 recordings fail with "EEGLAB data is in a separate .fdt file but none was found".

ADR 0027 makes Zarr discovery raw-only, so nothing under `derivatives/` is ever a recording or a conversion input.
The `.set` files here are raw recordings; only their data files live in an excluded tree.
Guessing the pairing by name is exactly what the misnamed folder shows to be unsafe,
and a wrong pairing would serve a plausible-looking signal from another session.

## Decision

A data file outside the raw tree is used only when a reviewed, per-dataset declaration in
`scripts/zarr/eeglab-fdt-declarations.json` pairs it with a raw `.set`.
This refines ADR 0027 and does not supersede it:
discovery stays raw-only, the `.set` is the recording,
and the `.fdt` is fetched for that one `.set`, never discovered and never converted on its own.

Every declaration is verified at conversion time, never trusted by name:

- the `.set` header's `nbchan x pnts x trials x 4` (EEGLAB writes float32) must equal the declared size;
- the target's exact byte size must equal it too,
  read from the git-annex key's size field before any download;
- the target must be the reviewed content:
  each entry pins a SHA256E `annex_key`,
  compared with the key at HEAD, or with the SHA-256 of the bytes when the file has no key.

Any disagreement, including a `.set` header that cannot be read, a v7.3 `.set`,
a sibling `.fdt` that already exists, or a target absent at HEAD,
REFUSES that recording with the typed, non-retryable code `fdt_declaration_refused`.
Consistent with ADR 0005, the refusal is per recording:
it is listed in the index's `failures`, and the rest of the dataset still converts and serves.

Adding an entry needs byte-size evidence
(the one `.fdt` whose size equals the header product) and the file's annex key,
recorded in the entry's `evidence`; a similar name alone is never enough.

The loader is strict: an unknown key, a missing key, an unsafe path, a size that disagrees with the dimensions,
an `annex_key` whose size field disagrees, or one `.fdt` backing two `.set` files each fail loudly.

## Consequences

The blast radius of a malformed declaration file is every run:
`load_fdt_declarations()` runs unconditionally in `main()`, for every dataset, before anything converts.
That is deliberate (a half-read declaration must never convert),
and the committed file is guarded in CI by a test that loads it and checks all 15 on004306 entries.

Operational limits an operator will meet:

- Incremental runs do not rebuild a `.set` when the declaration file changes,
  or when a `.fdt` under `derivatives/` changes,
  because `compute_worklist` skips every path under an excluded tree.
  Only `--clean`, `--full` or an engine version bump reconverts it.
  The Hallu cron always passes `--clean`, so the next run for that dataset picks the change up.
- Merging a declaration does not retry recordings that already failed.
  After deploy, requeue the dataset:
  `zarr_queue.py requeue --status data_failed --dataset on004306 --execute`,
  or `hallu-zarr.sh --dataset on004306 --requeue data_failed --execute`
  (use `done` instead of `data_failed` if other recordings in the dataset converted).
- Admission adds each declared `fdt_bytes` to its `.set`'s projected size,
  because the pointer walk cannot see a file outside the recording's directory.

The file is a list a person maintains.
It fixes one dataset's layout and does not generalise;
a second dataset needs its own reviewed entries.

## Alternatives considered

- **Pair by name or folder.** Rejected: on004306's own folders contradict their file names,
  so a name heuristic would pair at least one recording with the wrong session's data.
- **Discover `derivatives/` `.fdt` files and match them automatically by size.**
  Rejected: it reopens discovery under an excluded tree, which ADR 0027 closed,
  and it would act on every dataset without review.
  Size is the evidence a person uses to write the entry; it is not a licence to act unreviewed.
- **Rewrite the dataset** (move or rename the `.fdt` files beside their `.set`).
  Rejected: the dataset is mirrored from OpenNeuro, and a NEMAR-side rewrite would diverge from the source.
- **Serve on the header check alone.** Rejected: a header and a size can both agree with the wrong
  session's file of identical dimensions; the annex key is what ties the entry to the reviewed bytes.

## Receipts

- PR #1528 (`feat/zarr-per-dataset-fdt-map`): the loader, `stage_declared_fdt`, and the on004306 entries.
- on004306 at `9985e0d4`: each `.set` header read from its annex object,
  each `.fdt` paired by the single byte size equal to `nbchan x pnts x trials x 4`,
  annex keys read from the metadata clone.
- ADR 0005 (partial data still serves), ADR 0027 (Zarr discovery is raw-only).
