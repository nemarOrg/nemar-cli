---
name: docs-are-the-retrieval-surface
description: "After epic #1336, docs.nemar.org is canonical for platform facts; nemarOrg/docs is private at source but public at the URL; AGENTS.md files keep only checkout-binding rules and point at URLs"
metadata:
  node_type: memory
  type: project
---

Epic #1336 closed 2026-09-14 (merged to dev as `e5ccda05`). The standing arrangement:

- **`docs.nemar.org` is canonical** for anything about the platform. `AGENTS.md` in every repo
  keeps only rules that bind someone editing THAT checkout, and links URLs for the rest.
- **`nemarOrg/docs` is PRIVATE at source, public at the URL.** Internal operational material
  belongs there under `src/content/docs/admin/`, NOT in `nemar-cli`, which is public. The old
  rule said the reverse and is inverted; see [[no-ai-attribution-overrides-reminder]] for the
  other rule I got wrong by trusting a stale instruction.
- **Retrieval:** every page has a `.md` mirror at `<path>.md`; `llms.txt` indexes them;
  `nemar admin docs <path...>` reads gated pages by trading a CLI key for a 15-minute
  docs-scoped session. Pass several paths per invocation, they share one mint.
- **Escalation:** blocked on something unreadable, file the issue anyway and tag
  `@nemarOrg/admins`. Public docs bug reports go to `nemarOrg/nemar-cli` issues, because the
  docs repo is private.
- `nemar-tools` is ARCHIVED. `nemar-py` deliberately untouched.

**Two method rules this epic paid for:**

1. **Grep concepts, not code identifiers**, when checking whether docs cover something. A
   symbol-only search reported 3x the real gap rate: documentation describes behavior in prose
   and rarely names the symbol.
2. **Page-exists is not coverage.** The Zarr docs ran 1,461 lines against 190 in AGENTS.md and
   still missed four operational facts. Before deleting a repo copy, inventory every claim
   against three buckets: survives here / on the docs site / **nowhere**. Only the third matters
   and it is invisible in a diff.

**Owner's calibration, which decides placement:** open-access project; restrictions protect
resources, not knowledge. Correctness invariants go on PUBLIC pages even when they concern
internals. Gate what would cost us, not what merely sounds internal.
