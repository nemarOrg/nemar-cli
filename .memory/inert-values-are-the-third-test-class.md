---
name: inert-values-are-the-third-test-class
description: One valid plus one empty value per parameter cannot see disagreements that only appear after parsing
metadata:
  node_type: memory
  type: feedback
---

In nemar-cli #1442 I wrote a test asserting that "counted as a filter" and "builds a SQL clause"
agree for all 30 `search_datasets` filters, in both directions. It passed, and the equivalence was
false for 10 of them. My table supplied exactly ONE valid value and ONE empty value per filter, and
every divergence lives at a third class: **supplied, non-empty, and inert.**

`license: "CC0-1.0"` is a non-empty string that `parseLicenseTierFilter` reduces to no tiers.
A version facet given `"v"` strips to an empty prefix. An enum facet given `","` yields no values.
Mirror image: `modality: "  "` is whitespace my counter trimmed away while the builder's bare
`if (opts.modality)` accepted it and bound `%  %`.

The structural fix was to stop asking the question twice: count from the PARSED options, not the raw
wire arguments, so three of the four cannot happen.

**Why:** valid and empty are the two points where two predicates were never in doubt. Any predicate
pair agrees there. The interesting values are the ones a parser resolves to nothing.

**How to apply:** when two code paths must agree about whether an input is "set", enumerate three
classes, not two: valid, empty, and inert-after-parsing. Better, remove the second predicate. Related
trap from the same review: `expect(text).toContain(name)` in a loop could not tell a complete list
from one missing `has_zarr`, because `has_zarr` is a prefix of `has_zarr_verified` -- parse the list
and compare it, never substring-match names that share a prefix.
Related: [[passthrough-defeats-schema-tests]], [[test-entry-point-not-callee]], [[prove-the-inverse-path-too]].
