# ADR 0039: The CLI update check stays bespoke; update-notifier is declined

**Status:** accepted
**Date:** 2026-09-03
**Owner:** Seyed Yahya Shirazi

## Context

The offload audit (`.context/research-make-vs-take-audit.md`, candidate 12) proposed replacing
`src/lib/update-check.ts` (npm registry check, on-disk TTL cache, background refresh, env opt-out,
about 180 lines) with `update-notifier`, the package most popular CLIs use for the same job.
The audit's stated side benefit, real semver precedence for `-devN` builds, had already landed
through phase 6 of epic #1225 (`semver.gt`, issue #1228), so the remaining question was only
whether the library is a better home for the behaviour.

Probing `update-notifier` 7.3.1 under Bun answered it. The library does its background refresh
by spawning a detached child on a helper file it locates beside its own module
(`path.join(__dirname, "check.js")`). `nemar-cli` ships as a single minified bundle
(`bun build --target bun --minify`, no `node_modules` in the published tarball), so in an
installed copy that helper does not exist: a bundled probe run from a directory without
`node_modules` never populated the update cache across two runs six seconds apart, while the
unbundled module populated it on its second run. A silently dead update check is worse than
none. Three smaller mismatches compound it: the cache lives under the XDG configstore path, not
`NEMAR_CONFIG_DIR` (which every test and the E2E harness rely on for isolation); the opt-out is
`NO_UPDATE_NOTIFIER`, not the documented `NEMAR_NO_UPDATE_CHECK`; and `notify()` is suppressed
when stdout is not a TTY or a CI variable is set, where NEMAR's banner goes to stderr regardless
so piped output stays clean without losing the notice. Adopting it would add ten transitive
dependencies to the bundle and a shim for each of those four differences.

## Decision

The update check stays bespoke in `src/lib/update-check.ts`. `update-notifier` is declined.
The module already satisfies the audit's substantive concerns: it uses the `semver` package for
ordering (phase 6), it never blocks a command (cache-first, five-second fetch timeout on a cold
cache, refresh in the background), and it is skipped entirely on the shell-completion path
(`src/index.ts`'s `__complete` guard). Its entry-point tests pin the precedence cases from #1163.

The general rule this adds to ADR 0037's test: **a library that reaches outside the process
(spawning helpers, locating sibling files, writing to its own config root) must be probed in
the shape we actually ship, not in `node_modules`.** A bundled, single-file CLI is a different
runtime from a library's development checkout, and a package that works in the second can be
inert in the first without raising an error.

## Consequences

`update-check.ts` keeps its 180 lines and its four tests; no dependency is added. The
`NEMAR_NO_UPDATE_CHECK` opt-out and the `NEMAR_CONFIG_DIR`-relative cache are unchanged, so
nothing in docs or the E2E harness moves. The next audit does not need to re-derive this: the
probe recipe (bundle a caller with `bun build --target bun`, copy the output elsewhere, run
twice) is the receipt below.

## Alternatives considered

- **Adopt `update-notifier` and ship `check.js` beside the bundle:** rejected; it means adding
  a second file to the published package purely to satisfy a library's private layout, and the
  three other mismatches still need shims.
- **Adopt it with `updateCheckInterval: 0` and a foreground check:** rejected; that reintroduces
  the blocking registry fetch on every invocation the current design deliberately avoids.
- **Delete the update check:** rejected; users on `-devN` and on stale releases are exactly who
  the banner exists for, and the #1163 regression showed it was silently off for them until
  phase 6.

## Receipts

- `.context/research-make-vs-take-audit.md`, candidate 12, annotated with this verdict.
- Measured 2026-09-03 under Bun 1.4 with `update-notifier` 7.3.1: unbundled probe, second run,
  cache holds `{"latest":"0.9.14","current":"0.1.0"}`; the same probe bundled with
  `bun build --target bun --minify`, copied to a directory without `node_modules`, run twice
  six seconds apart: cache never holds an `update` entry.
- `update-notifier/update-notifier.js` lines 56 to 59 (opt-out and CI suppression), 110 to 113
  (detached spawn of `check.js`), 130 (TTY gate).
- Phase 6 of epic #1225 (#1242): `isNewerVersion` on `semver.gt`; ADR 0037; ADR 0038 (the same
  keep pattern for byte formatting).
