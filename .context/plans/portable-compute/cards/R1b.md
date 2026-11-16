# Card R1b: eegprep-lean passes the conformance suite and gains the engine transport

Status: ready
Tier: worker-hard
Timebox: L, 6 hours; escalate at 12 hours or two failed approaches
Needs: network
Depends: R1 (the suite's commit and tree digest); R0 (the reader branch holding the engine protocol)
Branch: feature/lean-conformance-engine
Worktree: $WT/eegprep-r1b (base origin/develop of sccn/eegprep)
Plan: .context/plans/portable-compute/plan.md, D11 (the engine's unique job is credential brokering; eegprep-lean gains an engine transport for it), section 4 (R1); the reader ADR of R0; ADR 0120 on the reader branch
Review: Sonnet panel plus one Opus review (credentials: the engine transport opens no network connection, sends and reads no credential, starts the engine without a shell, and refuses any frame it cannot fully check)

## Goal

eegprep-lean decodes every conformance case to the suite's expected values and digest, and can read a recording through NEMAR's local engine over the engine's versioned frame protocol, with request frames byte-equal and response decoding equal to the engine's committed goldens, so a Python user reaches private data through the engine's credentials without eegprep-lean ever holding one.

## Context

- Read `packages/eegprep-lean/` (`window.py`: `read_window(..., physical=False)` gives the stored integers, `to_physical`, the `Window` fields `data`, `rate`, `labels`, `unit`, `original_rate`; `recording.py`: `load_recording`; `transport.py`: the `Transport` protocol; `tests/`), and on nemar-cli's reader branch: `shared/zarr-engine-protocol.schema.json` (frames: magic `NZE0`, a u32 little-endian header length, a UTF-8 JSON header padded with spaces to an 8-byte boundary, then the payload; messages `hello`, `open` and `opened`, `read_window` and `window`, `recipe`, `release` and `released`, `error`; protocol "0.1"; unknown fields ignored; closed `dtype`, `layout` and `byte_order`; headers written with `allow_nan=False` and read with a `parse_constant` that raises), `shared/contract/zarr-engine-protocol.ts`, `test/fixtures/engine-frames/` (`hello-request.bin`, `opened.bin`, `window-float64.bin`, `window-int16-filled.bin`, `error.bin`, `error-null-id.bin`, `expected.json`), `src/commands/engine.ts` (how the engine is started), and the suite of card R1 under `shared/contract/zarr-conformance/`.
- The engine frames name a recording of `nm000103`; copying those static files reads nothing from that dataset.
- The owner merges sccn/eegprep pull requests.

## Scope

- `packages/eegprep-lean/src/eegprep_lean/` (new `content.py` with `store_content_sha256(window)`, new `engine.py`, exports in `__init__.py` through the lazy-extra table), `packages/eegprep-lean/tests/conformance/` (a byte-for-byte copy of the suite with a `PIN.json`), `packages/eegprep-lean/tests/engine-frames/` (a byte-for-byte copy of the goldens with a `PIN.json`), new `packages/eegprep-lean/tests/test_conformance.py` and `tests/test_engine_transport.py`, `packages/eegprep-lean/CHANGELOG.md`, its README's API list.
- Nothing outside `packages/eegprep-lean/`; no version field.

## Decided design

Settled:
1. **Pins.** Each copied directory has `PIN.json` `{"repository": "nemarOrg/nemar-cli", "commit": "<40 hex>", "path": "<source path>", "tree_sha256": "<64 hex>"}`; a test recomputes the tree digest (sorted `path NUL sha256 LF` lines over the copy, `PIN.json` excluded) and fails on any difference.
2. **Conformance.** `test_conformance.py` reads every case with `read_window` over a transport that serves the fixture directory from disk (a `Transport` implementation in the test, standard library only), checks `shape`, `digital_sha256` (with `physical=False`), `physical_sha256`, `filled`, `labels`, `unit`, `rate`, and `store_content_sha256` through the new `store_content_sha256(window)`, which implements card V1's item 1 from a physical window (`original_rate` never read) and also passes V1's two store-content vectors.
3. **Engine client.** `engine.py` has `EngineClient(command)` (an argument vector, started with `subprocess.Popen(..., stdin=PIPE, stdout=PIPE, shell=False)`, closed as a context manager), `hello()`, `open(dataset_id, recording, representation=None)`, `read_window(handle, start, count, channels=None, dtype="float64")` returning the samples and the filled ranges, `release(handle)`, and `load_recording_via_engine(client, dataset_id, recording)` returning the same `Window` type `load_recording` returns, so `to_eeg` and `to_mne_raw` work on it. It speaks protocol "0.1" and client name `eegprep-lean/<version>`, checks every response against what it asked (`opened.representation`, a window's channels, `dtype`, `layout`, `byte_order`, the payload length arithmetic, the request id), refuses an unknown `dtype`, `layout` or `byte_order`, maps an unknown error code to an internal error, and raises a typed `EngineError` with the code.
4. **No credential, no network.** The client opens no socket, reads no environment variable holding a key, and passes the child only the environment it was given; a test asserts the module imports no networking module.
5. **Goldens.** Encoding the hello request with id 1 and client `nemar-py/0.1` gives bytes equal to `hello-request.bin`; decoding each response golden gives `expected.json`'s header and payload; a header holding `NaN` is refused.
6. **Process behavior.** A replay engine in the tests (a short standard-library script that answers each request with the next golden frame, standing in for the external engine) proves the client end to end: hello, open, one window, release, and a clean exit; a child that exits early raises `EngineError("engine_exited")`.
The implementer may choose: helper names, the exact error codes of the client's own refusals (documented in the README).

## Acceptance

- From `packages/eegprep-lean`: `PYTHONPATH=src uv run --no-sync --project ../.. pytest tests/test_conformance.py tests/test_engine_transport.py -q` passes, with the golden frames byte-equal and every conformance case checked.
- Mutations, each failing a test: the header padding to 4 bytes instead of 8; a missing chunk read as zeros without `filled`; `original_rate` used in the digest.
- The real engine: "not run, would check: with a nemar-cli checkout at the pinned commit, `load_recording_via_engine` over `bun run src/index.ts` and its engine command reads one public store equal to `load_recording`'s window" (the manager runs it).

## Gates

- From the repository root: `uv sync --python 3.12 --all-extras --group dev`, `uv run --no-sync ruff check packages/eegprep-lean`, `uv run --no-sync ruff format --check packages/eegprep-lean`, `uv run --no-sync ty check`, `uv lock --check`; then the Acceptance command and `PYTHONPATH=src uv run --no-sync --project ../.. pytest tests -q -m "not network"` from `packages/eegprep-lean`.
- The repository's full tests: not run, would check: CI on the PR.

## Stop conditions

- eegprep-lean fails a conformance case that the TypeScript core passed: report the case and both values; fix eegprep-lean only if the cause is in eegprep-lean, else stop.
- The protocol schema and the goldens disagree: stop and report it for the collaborator's PR (never edit a copied golden).

## Report

At most 25 lines: PR URL in sccn/eegprep, head, gates, the two pins, mutations, deviations, and a patch note for nemar-process (`store_content_sha256` now exists in eegprep-lean; Q0's own copy may switch to it when the image pins a release that has it).
