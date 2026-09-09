# ADR 0050: No WebAssembly in the MCP Worker bundle, and real workerd is the only gate that proves it

**Status:** accepted
**Date:** 2026-09-09
**Owner:** Seyed Yahya Shirazi

## Context

The NEMAR MCP server (epic #1065) runs inside the same Cloudflare Worker as the rest of the
backend. Cloudflare's runtime forbids dynamic code generation, which includes compiling or
instantiating a WebAssembly (WASM) module at runtime. A Worker that tries it does not degrade;
it fails.

Twice, in two different phases, a reasonable-looking npm dependency broke the server this exact
way, and in both cases the entire test suite was green:

- **Phase 1, `numcodecs`.** Its Blosc codec loads its WASM module through a runtime `fetch()`
  followed by `WebAssembly.instantiate()` on the fetched bytes. Under real workerd:
  `RuntimeError: Aborted(CompileError: WebAssembly.instantiate(): Wasm code generation
  disallowed by embedder)`. It also cost about 604 KiB of bundle for no benefit.
- **Phase 3, `hyparquet-compressors`.** Its `compressors` export eagerly constructs
  `hysnappy`'s `snappyUncompressor()` at MODULE LOAD, which synchronously compiles a WASM
  module: `WebAssembly.Module(): Wasm code generation disallowed by embedder`. This is the worse
  shape of the two, because it crashed isolate startup for EVERY request, not only for a
  `get_events` call, and regardless of whether any dataset's parquet actually used SNAPPY.

Neither was caught by `bun test`. Bun happily compiles WASM, so the tests passed and the
deployed server would have been dead on arrival. Both were found only by running the real
runtime.

## Decision

**No package in this server's dependency graph may compile or instantiate WebAssembly, at
import or at runtime.** When a dependency needs WASM for a codec we need, we implement the codec
in pure JavaScript or use a pure-JS package instead, and we say so where the substitution lives.

**A phase that adds or upgrades a dependency is not done until `backend/scripts/mcp-smoke.sh`
has passed under real workerd.** `bun test` is necessary and not sufficient; it cannot observe
this class of failure at all.

The two substitutions this rule has already produced:

- `backend/src/services/blosc-decode.ts` decodes blosc/zstd/shuffle int16 chunks in pure
  JavaScript (a blosc header parse plus `fzstd` plus an unshuffle), replacing `numcodecs`.
- `backend/src/mcp/tools/get-events.ts` builds a one-entry `{ ZSTD }` compressors map over
  `fzstd` instead of importing `hyparquet-compressors`. That the archive is entirely ZSTD is
  measured, not assumed: `bun run zarr:geometry-check` reads every published `events.parquet`
  footer and reports each column's codec.

## Consequences

Easier: the bundle stays small, isolate startup stays fast, and a dependency bump cannot
silently take the server down in a way tests bless.

Harder: we own codec code we would otherwise get for free, and we must keep it correct. The
mitigation is that these decoders are narrow, pure, and tested against real captured production
bytes rather than synthetic input.

New obligations: every dependency addition or upgrade in this subsystem runs the workerd smoke
before merge, and a reviewer who sees a new dependency should ask what it does at module load.
Reading a package's import-time side effects is now part of the review, not an optimization.

The smoke script currently drives a throwaway entry module
(`backend/scripts/mcp-smoke-entry.ts`) rather than `backend/src/index.ts`, because
`wrangler dev --local` cannot start the real entry in this environment (issue #1324, unrelated
to the MCP work: `index.ts` exports plain string constants, which this workerd build rejects on
an entry module). That is a real gap in the gate: it proves the MCP sub-app and its dependency
graph start under workerd, not that the whole worker does. Closing #1324 closes the gap.

## Alternatives considered

- **Allow WASM and set a Cloudflare compatibility flag.** There is no flag that permits dynamic
  WASM compilation on a Worker; the restriction is the platform's, not a configuration choice.
  A statically imported `.wasm` module is a different mechanism that Cloudflare does support,
  but neither offending package uses it, and adopting it would mean vendoring and maintaining a
  fork of each.
- **Keep the WASM packages and lazily load them only on the paths that need them.** This does
  not help the phase 3 case at all, where the failure is at module load and takes down every
  request. It would also leave a landmine for whoever later imports the module from a hot path.
- **Trust `bun test` and catch it in staging.** This is what would have happened without the
  smoke gate, and it is why the rule exists: the phase 3 failure crashed isolate startup for
  every request, so the first symptom would have been a fully dead deployment.
- **A dependency allowlist enforced in CI.** Considered and deferred as premature. The check
  that actually catches the failure is running the runtime; a list of forbidden package names
  would need maintaining and would not catch a transitive dependency that adds WASM in a patch
  release.

## Receipts

- `.context/mcp-server-design.md` section 9 (dependency table, both offending rows), section 10
  (phase 1 decode-path measurements and the bundle figures), section 10.3 (the phase 3 failure).
- `backend/src/services/blosc-decode.ts`, `backend/src/mcp/tools/get-events.ts`,
  `backend/scripts/mcp-smoke.sh`, `backend/scripts/mcp-smoke-entry.ts`.
- Issue #1324 (`wrangler dev --local` cannot start `backend/src/index.ts`).
- ADR 0049 for the posture this server inherits: a stateless, recipe-first broker whose job is
  to hand a client the information to fetch bytes itself, which is what keeps the Worker's
  dependency surface small enough for this rule to be practical.
