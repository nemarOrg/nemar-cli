# Offload audit: bespoke code that a library/platform feature already covers

Scope: nemarOrg/nemar-cli (`triage-dev` checkout, origin/dev — CLI `src/`, Worker backend
`backend/src`, shared contract `shared/`, Python converter `scripts/zarr`) and nemarOrg/website
(origin/staging, read via `git show`/`git grep`, not checked out). Read-only audit; no files
changed. ADRs cited below are treated as binding — nothing here proposes reversing one.

## Executive summary

The signal-reader/Zarr-exporter offload to `biosigio` is the right model, but it's nearly the
only place it's been applied — small utilities get rewritten locally instead of imported, and
the clearest symptom is the same problem solved independently, and inconsistently, several times
over. Two patterns dominate: **escaping** (HTML/XML) is hand-written six separate times across
`auth.ts`, `broadcast.ts`, `email.ts`, `data-router.ts`, `s3.ts`, and `datacite.ts`, and
**byte-size formatting** is hand-written six more times, two of which actively disagree on
decimal-vs-binary units — a comment in the code already warns about the bug this caused. Both
are cheap, safe, one-dependency fixes. The GitHub API client (~4,400-4,800 lines of hand-rolled
`fetch()` with its own JWT signing, retry, and rate-limit tracking) is the single largest
duplicate surface and the one genuinely large project here — pilot it on one low-risk module.
A meaningful share of what looked bespoke turned out to be correctly so: EZID's ANVL protocol,
ORCID's linking logic, the Cloudflare rate limiter, git-annex's own glob dialect, and the SQLite
cron queue on Hallu are all justified keeps, several protected by an ADR. The spdx-correct swap
already in flight is right but incomplete — a third hand-rolled license table lives in
`datacite.ts` and should move with it.

## Ranked candidates

| # | Candidate | Replacement | Effort | Risk | Verdict |
|---|---|---|---|---|---|
| 1 | HTML/XML escaping, 6 independent copies (`auth.ts`, `broadcast.ts`, `email.ts`, `data-router.ts`, `s3.ts`, `datacite.ts`) | one shared util, or `escape-html` | S | Low | **Replace** |
| 2 | Byte-size formatting, 6 implementations, 2 disagree on unit base | `pretty-bytes` | S | Low | **Replace** |
| 3 | Hand-rolled GitHub API client (~4,400-4,800 lines: transport, JWT signing, rate limits, retry) | `@octokit/core` + `auth-app`/`retry`/`throttling` | L | Medium | **Wrap (pilot 1 module)** |
| 4 | Version-string parsing, 4 places; one drops real semver precedence (issue #1163) | npm `semver` (`.coerce()` for git-annex's scheme) | M | Low | **Replace** |
| 5 | CLI table rendering, ~55 `padEnd` call sites across 4 command files | `cli-table3` (check recent release cadence) | M | Low | **Replace** |
| 6 | Backend retry/backoff loop rewritten independently 7+ times; existing `retry.ts` under-used | Consolidate on `withRetry`, or `p-retry` | S-M | Low | **Wrap (internal)** |
| 7 | Constant-time compare hand-rolled 4 times; one comment wrong about Workers Crypto | One shared helper | S | Low | **Wrap** |
| 8 | Email: raw fetch to Resend + 21 duplicated full-HTML templates (~1,300 lines) | `resend` SDK + shared layout, or `react-email` | M | Low-Med | **Wrap** |
| 9 | Admin-broadcast markdown-to-HTML, regex-based, separate from #8 | `marked` + inline-style pass | M | Low-Med | **Replace** |
| 10 | DataCite XML (~390 lines) + S3 Multi-Object-Delete XML: hand-built/parsed via string concat & regex, with a real entity-decode bug in the S3 side | `fast-xml-parser` (S3) / `xmlbuilder2` (DataCite) | M | Low | **Wrap** |
| 11 | `datacite.ts`'s `mapLicense` — a third, independent license table | `spdx-license-list` (ride the in-flight migration) | S | Low | **Replace** |
| 12 | `update-check.ts` reimplements npm-registry check, TTL cache, opt-out | `update-notifier` | S | Low | **Replace** |
| 13 | `upload-progress.ts` hand-rolled JSON validator duplicates zod (already a dep, used 21×) | zod schema | S | ~None | **Replace** |
| 14 | `progress.ts`'s bar renderer/redraw reimplements `cli-progress`; keep its git-annex JSON parser | `cli-progress` for rendering only | S-M | Low | **Wrap** |
| 15 | Python: `aws s3 ls` text-parsed for read-only listing in zarr scripts | `boto3` `list_objects_v2`, listing calls only | S | Low | **Wrap** |
| 16 | Website: hand-rolled CommonMark-subset renderer for dataset READMEs | `marked`/`markdown-it` + Workers-safe sanitizer | M | Medium | **Wrap, not urgent** |
| 17 | Dependency hygiene: `bcryptjs` at two major versions; `fuse.js` unused; TSV `.split("\t")` w/o quote-handling in 3 backend files (low-priority, BIDS TSVs don't quote) | Align/remove | S | ~None | **Fix / note** |
| — | License detection/matching, `src/lib/license.ts` (298 lines) | `spdx-correct` + `spdx-license-list` | — | — | **Already decided, in progress** |

---

### 1. Escaping — the single cheapest, most-duplicated pattern in the repo

`escapeHtml` is independently, near-identically implemented in `backend/src/routes/auth.ts:31`,
`backend/src/services/broadcast.ts:220`, `backend/src/services/email.ts:676-683`, and (a
semantically equivalent variant) `backend/src/services/data-router.ts:452-461`. `escapeXml` is
separately duplicated in `backend/src/services/s3.ts:1709` and
`backend/src/services/datacite.ts:746`. Six copies of the same five-character-class regex
escape — each a place a future edit could drift and reopen an XSS/XML-injection gap the others
already closed. One shared `src/lib/escape.ts`/`backend/src/lib/escape.ts` (or the tiny,
ubiquitous `escape-html` package) and six call-site edits. Nothing is lost; effort S.

### 2. Byte-size formatting — six reimplementations, two of them disagree

`src/lib/progress.ts:69` (binary/1024), `src/lib/bids-validator.ts:395` (binary/1024,
2-decimal), `backend/src/services/s3.ts:419` (**decimal/1000**), `backend/src/services/
data-router.ts:464` (`humanSize`, binary/1024, compact form) and `:777` (`formatBytes`,
binary/1024, different rounding), and `backend/src/services/dataset-metadata-columns.ts:600`
(`formatFileSize`, binary/1024, the "canonical" one). `backend/src/routes/datasets/catalog.ts:
118-127` carries a comment warning future editors away from `s3.ts`'s version because it "would
silently shift every displayed size" — this already caused a real bug. `pretty-bytes`
(sindresorhus, near-ubiquitous, zero deps, supports both binary and decimal modes via an
explicit option) replaces all six with one call and makes the unit choice visible instead of
implicit. Effort S, low risk — presentation-only, independently testable per call site.

**Outcome (epic #1225 phase 4, issue #1227, 2026-09-03): `pretty-bytes` declined, kept bespoke
and consolidated instead. See [ADR 0038](decisions/0038-byte-size-formatting-stays-bespoke.md).**
Probing `pretty-bytes` 7.1.2 against NEMAR's actual served format found it reproduces none of
the six: its binary mode emits IEC labels (`"22.4 GiB"` where NEMAR serves `"22.35 GB"` over the
same 1024 base) and its decimal mode emits a lowercase `kB` over base 1000; it has no option for
the magnitude-dependent fraction-digit policy `formatFileSize` uses. `formatFileSize`'s output is
the served `file_size_formatted` catalog field and is pinned by golden tests, so this is a
contract, not a presentation-only surface — the "independently testable per call site" premise
above held for the CLI/HTML-only formatters but not for this one. The six copies were still
worth consolidating: they are now one module, `shared/bytes.ts`, with the decimal/1000 outlier
(the bug this section names) deleted rather than kept. Five formats remain because their outputs
genuinely differ and the epic forbade changing any of them; that is a product question for a
future phase, not something this consolidation could settle.

### 3. Hand-rolled GitHub API client — the biggest surface, pilot it

`backend/src/services/github/*.ts` (10 files, ~4,400 lines: `transport.ts` with its own
rate-limit-header parsing, retry/backoff, and one-shot 401 App-token refresh; `repos.ts`,
`contents.ts`, `issues.ts`, `collaborators.ts`, `branch-protection.ts`, `workflows.ts`,
`dispatch.ts`) plus `github-auth.ts` (369 lines: hand-rolled RS256 App-JWT signing via
`crypto.subtle`, installation-token minting/caching). `@octokit/core` +
`@octokit/plugin-rest-endpoint-methods`, with `@octokit/plugin-retry` and
`@octokit/plugin-throttling`, are fetch-based and confirmed Workers-compatible. What's genuinely
NEMAR-specific and needs re-wiring, not dropping: the isolate-scoped rate-limit cache, the
one-shot 401-refresh path, and the test suite's base-URL override for a local fake GitHub server
used across dozens of tests — all reproducible via Octokit's hooks/`baseUrl` option, but real
work. Given the line count, the ADR-0020 blast radius (~785 repos), and App-auth being
security-critical: **pilot on one low-risk module** (`repos.ts` or `collaborators.ts`) before
touching `transport.ts`'s retry/auth core. Effort L, risk medium.

### 4. Version comparison reimplemented four times, one with a real bug

`src/lib/semver.ts` (71L, strict `X.Y.Z`, used for dataset versions), `src/lib/git-annex/
prereq.ts:37` (a separate array comparator for git-annex's `10.20241202`-style versioning),
`src/lib/prerequisites.ts:130` (a regex extractor for generic `--version` output), and
`src/lib/update-check.ts:46-48` which **strips the entire prerelease suffix**
(`v.replace(/-.*$/, "")`) before comparing the CLI's own `X.Y.Z-devN` against npm's latest
release. Real semver precedence says a prerelease sorts below its release
(`1.2.3-dev0 < 1.2.3`); stripping-then-comparing treats them as equal and can't order
`-dev`/`-rc`/`-alpha` at all — this is the correctness gap issue #1163 points at. npm's own
`semver` package (bundled inside npm itself, the reference implementation) replaces all four:
`semver.valid()` covers the strict dataset-version case, and `semver.coerce()` is permissive
enough for git-annex's two-component scheme to preserve the current pairwise-comparison
ordering. Effort M (four files plus tests), low risk — a comparison function is easy to
unit-test against the exact cases that currently disagree.

### 5. CLI table rendering via manual `padEnd`

`src/commands/dataset.ts` (30 sites, including a hand-computed column-width table in
`renderDatasetTable` around line 1556), `admin.ts` (18), `sandbox.ts` (5), `doctor.ts` (1) — 55
occurrences total. One comment in `dataset.ts` (~1614) flags the real hazard: "pad the plain
text BEFORE colorizing so ANSI codes don't break alignment" — a footgun a real table library
eliminates structurally rather than by every call site remembering a convention. `cli-table3`
computes column widths and ANSI-aware truncation automatically; worth a maintenance check before
adopting since it hasn't shipped a release in the past year, a minor risk rather than a blocker
for a feature-complete, low-churn concern. Effort M, risk low, snapshot-testable.

### 6. Backend retry/backoff, independently written 7+ times

`retry.ts` (114L) is explicitly documented as the single source of truth for transient-failure
classification, with a real `isRetryable` classifier — but only `ezid.ts` and
`publication-orchestrator.ts` actually call it. Independent loops exist in `s3.ts` (three
blocks, ~1277/1401/1506), `github/transport.ts`, `manifest.ts`, `auto-import.ts`,
`enrich-dataset.ts`, `github/contents.ts`, and `routes/datasets/upload.ts`. Not a library gap —
the codebase's own already-decided abstraction going unused in most places it applies. Route
these through `withRetry`; only genuinely different classification earns a new parameter, not a
new loop. Effort S-M, zero new dependency.

### 7. Constant-time compare, hand-rolled four times — one comment is wrong

`backend/src/routes/webhooks/shared.ts:18`, `backend/src/services/auth-code.ts:97`,
`backend/src/services/webhook-signature.ts:81`, and `backend/src/services/github/
callback-tokens.ts:80` each independently implement a timing-safe hex compare. Only
`callback-tokens.ts`'s correctly feature-detects `crypto.subtle.timingSafeEqual`; `webhook-
signature.ts`'s comment claims it's "not exposed in the Workers runtime," contradicted by its
sibling. No external library needed — this is Workers-idiomatic code that should just exist
once, using the accurate version as the template, with the stale comment fixed. Effort S,
essentially zero behavioral risk.

### 8. Email: raw Resend fetch + 21 duplicated HTML templates

`backend/src/services/email.ts` (1,306 lines) posts to Resend's REST API via raw `fetch()`
(158-183), citing "Workers compatibility" as the reason to avoid the official `resend` SDK —
worth re-verifying, since Resend's SDK is a thin, documented-Workers-safe fetch wrapper; if so,
the raw-fetch layer is an outdated workaround. More substantially, all 21 `send*Email` functions
inline a complete duplicated HTML document (DOCTYPE/head/body chrome/footer); only `applyDevWrap`
is shared. `react-email` (built by the Resend team for this pairing) or a single shared layout
wrapper cuts ~1,300 lines to a fraction. Effort M, risk low-medium — 21 templates need a visual
diff pass before shipping, not just a code review.

### 9. Admin-broadcast markdown, separately from #8

`backend/src/services/broadcast.ts:152-227` (`markdownToEmailHtml`/`inlineMarkdown`) hand-parses
headings, bold, italic, links, code spans, lists, and horizontal rules via ordered regex
substitution for admin-authored announcement emails — a distinct renderer from `email.ts`'s
templates and from the website's markdown handling (#16). It correctly escapes before
synthesizing tags, but has the classic hand-rolled-regex gaps: nested emphasis, links with
parenthesized URLs, blockquotes (silently falls through to a paragraph), and no
backslash-escaping. `marked` (zero deps, actively maintained) is a correct, complete parser; the
real cost is that email HTML needs inline styles for client compatibility, so a small
tag-to-inline-style pass still sits on top of `renderer.parse()`'s output — hence effort M, not
S. `buildBroadcastHtml`'s outer template carries over unchanged.

### 10. DataCite XML and S3 XML: wrap the serialization, keep the domain knowledge

`backend/src/services/datacite.ts:798-1135` (`buildDataCiteXml`, ~390 lines) hand-builds a
DataCite kernel-4 XML document via string concatenation, with real domain rules baked in
(mandatory-field/`minLength` validation from issue #459) worth keeping as-is. Its `escapeXml`
only handles the five predefined entities and doesn't strip XML 1.0's forbidden raw control
characters — a stray control byte in a creator name could produce XML EZID's validator rejects,
silently failing a DOI mint. Separately, `s3.ts` hand-builds and hand-parses S3's
Multi-Object-Delete protocol: `deleteObjects` (~1550) builds the request body via template
literals, then parses the response with `xml.matchAll(/<Deleted>\s*<Key>([^<]+)/g)` — and does
**not decode** the entities it encoded on the way in, so a returned key containing `&` comes
back as the literal string `&amp;`. `aws4fetch` (the project's consistently-used signer)
deliberately carries no XML layer, which is why this exists at all. `fast-xml-parser` (zero
native deps, Workers-compatible) closes the S3 side cleanly; `xmlbuilder2` fits the DataCite
side. Effort M for either, touching one file each.

### 11. `datacite.ts`'s third license table

`backend/src/services/datacite.ts:1184-1289` (`mapLicense`, ~105 lines) hand-maps roughly a
dozen license strings to DataCite `rightsList` entries (name, URI, SPDX id) — independent of
both `src/lib/license.ts` (the CLI detector already being replaced) and
`backend/src/lib/license.ts` (a separate, correctly-bespoke permissiveness-tier classifier, see
the keep-list below). Once `spdx-license-list` lands from the first migration, this table can
pull canonical names/ids from it directly, leaving only a small CC/ODC URI lookup (SPDX's
`seeAlso` covers most of these). Flagging this now so the in-flight migration doesn't stop one
file short of covering the actual duplication it set out to fix.

### 12. `update-check.ts` reimplements `update-notifier`

**Outcome (epic #1225 phase 7, issue #1231, 2026-09-03): `update-notifier` declined, kept bespoke.
See [ADR 0039](decisions/0039-the-update-check-stays-bespoke.md).** The library spawns its
background refresh on a helper file it locates beside its own module; `nemar-cli` ships as one
bundled file with no `node_modules`, so in an installed copy that helper does not exist and the
update cache never populates (measured, both shapes). Its config root, its opt-out variable, and
its TTY gating also differ from what the CLI documents. The semver-precedence bug this section
counted as a side benefit had already been fixed in phase 6 (#1242).

182 lines doing what `update-notifier` (the standard tool most popular CLIs use for this)
provides directly: npm-registry version check, on-disk TTL cache, background refresh, env-var
opt-out. The only NEMAR-specific behavior to preserve is the `NEMAR_NO_UPDATE_CHECK` env var
name and the config-relative cache path, both configurable via its options. CLI/Bun-side only,
no Workers-compat concern. Effort S — and it incidentally fixes the semver-stripping bug in
candidate #4, since `update-notifier` uses real `semver` internally.

### 13. `upload-progress.ts` hand-rolled validator duplicates zod

`isValidProgress()` (~308-339, ~30 lines) hand-rolls JSON shape validation with manual
`typeof`/`Array.isArray` checks for the `.nemar/upload-progress.json` resume file, duplicating
what `zod` — already a dependency, already used in 21 other files including `config.ts` — does
more safely and concisely. The surrounding resume state-machine logic is legitimately
domain-specific and untouched. Cheapest possible win in the audit: zero new dependency, one
function, effort S, near-zero risk.

### 14. `progress.ts`'s bar renderer duplicates `cli-progress`

The git-annex `--json-progress` line parser and multi-file in-flight byte crediting (handling
concurrent `-J N` transfers interleaving progress events per file) are genuinely bespoke and
correct — no generic library knows about this problem. But `renderProgressBar` and the manual
`\r`-based redraw reimplement what `cli-progress` already provides, terminal-width edge cases
included. Keep the parser, wrap the renderer. Effort S-M, low risk.

### 15. Python: `aws s3 ls` text-parsing for read-only listing

`scripts/zarr/generate_zarr.py`'s prefix-emptiness/child-prefix helpers and
`purge_non_raw_stores.py`'s summary-line parser shell out to `aws s3 ls --recursive --summarize`
and regex/sentinel-string-parse the text output — one docstring flags that this command exits 1,
not 0-with-empty-list, for a prefix matching zero keys, exactly the surprise `boto3`'s typed,
paginated `list_objects_v2()` avoids. Scope the fix to the read-only listing calls only: the
actual transfers (`aws s3 cp`, `rm --recursive`) are a deliberate choice tied to the CLI's own
tuned concurrency profile, and reproducing that in `boto3` would mean hand-building a
`TransferConfig`, not eliminating hand-rolled logic. Effort S, risk low.

### 16. Website: hand-rolled CommonMark-subset markdown renderer

`src/lib/markdown.ts` (216 lines, origin/staging) parses dataset READMEs — headings, paragraphs,
lists, code fences, inline formatting, links, autolinks, HR — with real HTML-escaping and
`javascript:`/`data:` URL rejection already in place. `marked`/`markdown-it` are pure-JS and
Workers-compatible too, so "zero Node deps" isn't the real gap; the gap is that neither ships
sanitization, and `DOMPurify` needs a DOM (not Workers-safe). A real swap needs a parser *plus* a
Workers-safe sanitizer pass — genuine integration work. Given the current implementation already
handles the two things that matter most (escaping, dangerous URLs), this is a wrap when a
trigger appears (tables, footnotes, nested blockquotes), not urgent today.

### 17. Dependency hygiene and minor notes

Root `package.json` declares `bcryptjs` as a devDependency at `^3.0.3` (used only by
`scripts/setup-test-users.ts`); `backend/package.json` declares it as a production dependency at
`^2.4.3` (used by the actual password-hashing code in `password.ts`) — same package, two major
versions, in one monorepo; align both. `fuse.js` is a root dependency with zero real imports
anywhere in `src/`/`backend/src/` (every grep hit was a false positive on "fused"/"refuse")  —
wire it in or remove it. Lower priority: `channel-montage.ts:81`, `bids-tree.ts:24`, and
`hed.ts:71` all `.split("\t")` BIDS TSVs without quote-handling; BIDS itself disallows quoted
TSV fields, so the actual risk is low and a CSV library would add weight for a problem that
mostly doesn't exist in this format — noted for completeness, not worth prioritizing.

---

## Notable "keep" verdicts, with reasons

**EZID client** (`ezid.ts`, ~500L, hand-rolled ANVL encode/decode) — a niche
California-Digital-Library format with no JS ecosystem; **ADR 0007** fixes EZID as sole provider,
and this is the correct minimal client, the same category of problem `biosigio` itself solves.
**The ~1,300 lines of BIDS-to-DataCite domain mapping** in `datacite.ts` (distinct from the
XML-serialization layer flagged in #10) is genuine NEMAR logic. **ORCID OAuth** (`orcid-auth.ts`)
— ORCID doesn't support PKCE and needs no id_token verification; ~80% of the file is NEMAR's own
account-linking/relink tree, protected by **ADR 0022**; the actual OAuth surface is under 60
lines and wouldn't shrink under a generic client. **Rate limiting** (`rateLimit.ts`, ~420L) —
multiple differently-keyed buckets, each tuned against a specific past incident, plus an
`observeOnly` mode the native Cloudflare Rate Limiting binding can't express; a deliberate
platform choice (Cache API over KV, to dodge daily-operation limits), not reinvention.
**git-annex policy** (`policy.ts`, 165L, **ADR 0031**) emits glob strings for git-annex's own
matcher (whose `*`-crosses-`/` semantics don't match `minimatch`'s defaults) rather than matching
globs itself — no mechanics layer to replace. **S3 signing** (`s3.ts`, `sts.ts`) already
consistently uses `aws4fetch`; no hand-rolled SigV4 anywhere. **Multipart/streaming S3 copy**
(`s3-server-copy.ts`, **ADR 0010**) shells to the official `aws s3 cp`/`sync` CLI — same for
`aws-cli.ts` and `git-annex/s3-remote.ts` (passes `signature=v4` to git-annex's own S3 special
remote). **Archive/zip builder**: the zip bytes are built in `run-generate-archive.yml` (GitHub
Actions), not this repo's Worker; `archive-policy.ts`/`archive-retry.ts` are pure threshold and
retry logic per **ADR 0012**. **bucket-policy.ts** (259L, pure `NotResource`-deny-list algebra) is
small, well-typed, and encodes a real constraint (AWS's 20KB policy-size cap) no library knows
about. **Python BIDS discovery/sidecar inheritance** (`generate_zarr.py`) resolves sidecars via
`git cat-file` against a ref, not a materialized filesystem — `pybids`'s `BIDSLayout` indexes a
real directory tree up front, conflicting with the per-recording, memory-bounded design **ADR
0030** requires. **`parse_events_tsv`** already handles a real found edge case (a UTF-8 BOM,
`nm000329`); stdlib `csv` needs `QUOTE_NONE` to match and gains nothing. **`zarr_queue.py`'s
SQLite queue** plus **`hallu-zarr.sh`'s `flock`+cron** (**ADR 0033**) are right-sized for a
single-writer, single-host, cron-driven job — a task-queue framework would be over-engineering.
**CLI shell completion** (645L) implements the same dynamic `__complete`-subprocess pattern
kubectl/gh/Cobra hand-roll too, since none of them found a dominant cross-shell generator library
either. On the website: the **eeg-viewer** already wraps `zarrita` correctly, with its own ADR
(route-scoped CSP for the WASM codecs) — this is what "offloaded like biosigio" already looks
like elsewhere. **OG image generation** already uses `@resvg/resvg-wasm` with small, shared
SVG-layout modules. **Cloudflare cache purge** (`cloudflare.ts`, ~157L) is one well-documented
`fetch()` call to one REST endpoint — the official `cloudflare` SDK would be pure bundle weight.
**Sitemap/`llms.txt`** don't exist yet — nothing to migrate, but `@astrojs/sitemap` should be the
default when built (with a `customPages` callback, since dataset routes are API-driven).
**`backend/src/lib/license.ts`** (69L) is a *different* problem from the in-flight migration — a
free-text heuristic sorting licenses into six UI-facing permissiveness tiers, byte-parity with
the website's own tier logic; no SPDX library does permissiveness classification, so this one is
correctly bespoke and out of scope.

## Method note

Coverage combined two overlapping passes: four parallel research forks plus direct verification
(CLI presentation/completion/semver; backend DOI/DataCite/EZID/ORCID/rate-limiting/email/
webhook-signature; the Python Zarr converter and BIDS-tree files; the website repo), and a fifth
fork (backend S3/archive/git-annex/GitHub-client) that returned late and, having inherited the
full task context, wrote its own complete independent pass rather than only its narrower brief.
Each surfaced findings the other missed — the escaping and DataCite-license findings came from
the fifth pass and were re-verified by direct file reads before inclusion; the byte-formatting,
constant-time-compare, email-template, and update-check/#1163 findings came from the first four
and are preserved here. Line counts are approximate. Maturity claims for `pretty-bytes`,
`update-notifier`, `cli-table3`, `semver`, `fast-xml-parser`, and Octokit's Workers compatibility
reflect a mix of live verification and general knowledge; `xmlbuilder2`, `escape-html`,
`react-email`, `marked`, `cli-progress`, `p-retry`, and `boto3` are named accurately but
unverified this session, per the audit's instruction to skip lookups past the top ten.
