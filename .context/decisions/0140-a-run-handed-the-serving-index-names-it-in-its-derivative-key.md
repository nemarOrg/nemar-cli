# ADR 0140: A run handed the serving index names it in its derivative key

**Status:** proposed
**Date:** 2026-11-25
**Owner:** Seyed Yahya Shirazi

Decision 3 is refined by [ADR 0141](0141-the-dispatcher-stages-the-serving-index-and-the-launch-specification-is-version-2.md) decision 6: the dispatcher now stages the index and records its digest.

Refines [ADR 0123](0123-derivatives-live-in-a-keyed-store-named-by-what-they-read.md) decision 2 with a second key format, as its Consequences require of any change to the key ("a new format name and a new ADR").
Every key ADR 0123 defines stays valid and keeps its bytes.

## Context

A run of nemar-ica on the archive copy (`--input bids`) reads no store of the serving copy, so it takes the serving copy's channel group, rate and length from the serving copy's index, handed to it as a file (`--serving-index`, nemarOrg/nemar-process#95).
The index changes the product: with a row for the recording, the run declares the views of the serving copy (activations and the signal window); without one, it skips them with a word, and its record names the index it was given (`extensions.nemar.ica.serving_index`).
ADR 0123's key has eight lines and none of them is the index, so a run with an index and a run without one, of the same dataset version, recipe version and engine, would share a key, and the first derivative would stand for both (nemar-cli #2341).

## Decision

1. **A recipe that reads the serving index on the archive input has a version 2 key.**
   Its text is `nemar.derivative-key.v2`, the eight lines of version 1 in their order, and a ninth, `serving_index`, a space, the value and a line feed.
   The value is `sha256:` and the 64 lowercase hexadecimal digits of the SHA-256 of the index file's bytes, or `none` when the run was given no index.
   The field goes with input `bids` only; on `zarr` it is refused.
   The recipes are listed once, in `RECIPES_KEYING_SERVING_INDEX` of `shared/compute-recipes.ts`: nemar-ica today.
2. **Every other key is version 1, byte for byte.**
   A key without the field is ADR 0123's eight-line key, so no key made before this decision changes, and a version 1 text and a version 2 text are different bytes from their first line.
3. **The value is what the platform knows, never what the record claims.**
   A run whose dispatched specification names no `--serving-index` is keyed `none`.
   A run whose specification names one is not keyed (`serving_index_unattested`) until the dispatcher stages the index itself and records the digest of what it staged: until then nothing the platform holds says which index the run read, and keying it as `none` would let it collide with a run that had none.
4. **The derivative row keeps the field** (`compute_derivatives.serving_index`, migration 0153): null for a version 1 key, `none` or the digest for a version 2 key, so the description writes the key's own text again from the row.

## Consequences

- Runs of one recording with no index, with an index, and with two different indexes have four different keys, so none of their derivatives stands for another.
- No nemar-ica derivative existed when this was decided: the registry holds nemar-ica as a placeholder that no path dispatches, so no stamp of it has succeeded and none was keyed.
- Until the dispatcher stages the serving index (#2341), every nemar-ica derivative of the archive is keyed `none`, and its views of the serving copy are skipped with `no_serving_index`.
- The definition is in `shared/contract/derivatives.ts`, held by vectors in `shared/contract/derivatives-vectors.json` computed in Python and in Bun.
  A later change to the key, such as the channel types of nemar-cli #2344, is again a new format name and a new ADR.

## Alternatives considered

- **Add the line under `nemar.derivative-key.v1`:** a version 1 text would then mean two definitions, against ADR 0123's rule that a change is a new format name.
- **Take the digest from the run's record:** the record is the run's claim, and the key is the platform's name for what was run; a run that misstated its index would be filed under another run's key.
- **Key every archive run with the field:** it would change the key of every floor run of the archive, which reads no index, for nothing.
- **Leave the key alone and refuse to key a run with an index:** a later run with an index would then never be stored, and a run without one could not be told from it by its key.

## Receipts

- nemar-cli #2341 (backend follow-ups from nemar-process P7) and the owner's ruling of 2026-11-25 on the derivative key.
- nemarOrg/nemar-process#95 (`--serving-index`, `common/serving_index.py`).
- `shared/contract/derivatives.ts`, `shared/contract/derivatives-vectors.json`, `backend/src/services/compute-derivatives.ts` and migration `0153_compute_derivatives_serving_index.sql`.
