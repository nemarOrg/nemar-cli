# ADR 0084: Curated Neurobagel annotations are a reviewed, content-pinned file keyed by dataset id

**Status:** accepted
**Date:** 2026-10-02
**Owner:** Seyed Yahya Shirazi

## Context

The transform of ADR 0081 maps only what a table says plainly: a column named `age` in years, a column named `sex` with `m` and `f`, a healthy control group.
It leaves everything else to curation: which diagnosis a free-text group value means, which column holds sex when it is called `gender`, which assessment tool a column is an item of, what an age column of placeholder zeros really holds.
A wrong annotation in a public federated index is worse than a missing one, because a search will return participants who are not what the query asked for.
Neurobagel keeps its own OpenNeuro annotations the same way, as one reviewed file per dataset in a repository, and publishes them under the MIT licence.
NEMAR mirrors about 580 OpenNeuro datasets (`on` ids) beside its own (`nm` ids), and the owner included the mirrors in the federation (epic #1586).

## Decision

**Curation is one reviewed file in this repository, `shared/neurobagel/curation.json`, keyed by dataset id, and an entry applies only to the exact bytes it was reviewed against.**

1. **The shape is the annotation tool's.**
   An entry maps each curated column of `participants.tsv` to the `Annotations` block the Neurobagel annotation tool exports (variable, variable type, levels, format, missing values, assessment tool), so tool output is pasted in unchanged.
   Four kinds of column can be curated: age, sex, diagnosis and an item of an assessment tool.
   The participant id column is always mapped by the transform, and no other variable can be curated.
2. **Every term comes from the pinned vocabulary.**
   The loader (`curation.ts`) rejects a term that is not in the pinned diagnosis, assessment, sex or age-format vocabulary, and a term whose label is not the pinned label.
   The output validators then allow a diagnosis or an assessment term in a dataset's graph and dictionary only if that dataset's entry names it, which is stronger than "the term exists": a diagnosis reaches a graph only through an entry a person signed.
3. **The loader fails closed.**
   One problem anywhere rejects the whole file, and the error lists every problem it found.
   It rejects text that is not JSON, a key that appears twice (`JSON.parse` would keep the last), `__proto__`, an unknown key at any level, an empty level map, a level that is also a missing value, a second sex or age column, a column named `age`, `sex` or `group` that is about something else, a dataset id outside `nm` and `on` or inside the reserved fixture band (ADR 0068), a malformed pin, blank evidence and a date that does not exist.
4. **A pin is the git blob SHA-1 of the bytes reviewed, computed by the transform from the text it converts.**
   Each entry pins `participants.tsv` and `participants.json` (`null` pins a file as absent).
   For a git-tracked file this is the data plane's entity tag (ADR 0066), but the transform computes it from its own input rather than trust a hash the caller passes, so a pin says something about the bytes actually being converted, and an annexed file, which has no such tag, is pinned the same way.
   A leading byte order mark is the one tolerance, because decoders drop it; text that is not valid UTF-8 never matches, which is the safe direction.
5. **An entry that does not fit is skipped whole, loudly.**
   `stale`: a pinned file is not the file in hand, so none of the entry is applied.
   `invalid`: the files are the pinned ones and the entry still does not fit them, because a column is missing from the header, the level map misses a value the table holds, or an age is unreadable in its declared format.
   `unused`: the entry fits, but none of the table's participants are the graph's.
   In each case the mechanical columns ship exactly as without an entry, the report carries a `curation` section of counts and enumerated values (never a column name, a cell or the reviewer's words), and the flags say `curation_stale`, `curation_invalid` or `curation_unused`, which the writer and the sweep surface.
   Partial application is rejected: after a table changes nobody can say which columns still describe it.
6. **An entry is applied to the participants of the graph, and checked against every row.**
   The graph holds the subjects that have data (ADR 0081), so a curated value is attached to those participants only.
   Coverage is checked over every row of the table, because the dictionary is also read by `bagel pheno` and by catalog-mode nodes, which refuse a table whose values the dictionary does not declare.
   A curated column replaces the mechanical rule for its variable: a curated sex or age column replaces the mechanical one, a curated column that is the group column replaces the group rule, and a participant's diagnoses are the distinct terms of all diagnosis columns.
   A diagnosis column may map no value at all if it lists every value as missing, which is how a reviewer withdraws the mechanical healthy control mapping from a group column whose `Control` is an intervention arm, not a healthy participant (on004166, on006801); no other kind of column may map nothing.
   An assessment tool is on a participant when any item of it is recorded, with `bagel`'s meaning: a cell is recorded unless it is a declared missing value, so a blank that is not declared missing is rejected rather than read as an assessment nobody took.
7. **Every entry says who looked at it.**
   `evidence` carries a source, a reviewer, a date and a `review` of `author` (not a domain expert), `domain_expert`, or `upstream_community` (copied from Neurobagel's published annotations, reviewed by their community and not by NEMAR beyond the loader).
   Registration of the node (phase 7) waits until the entries it will serve have the review it needs.
8. **Curation is a committed file, never generated at build or deploy time.**
   Reused upstream annotations are converted by `scripts/neurobagel/reuse-openneuro-annotations.ts`, pinned to one upstream commit, which fetches only through read-only requests, checks every file against the commit's tree, keeps a column only if the loader and the binder accept it against the mirror's current table, drops and counts the rest, and writes entries in this format with their pins.
   A person reads the diff before it is merged.

## Consequences

An entry goes stale when a dataset's `participants.tsv` or `participants.json` changes, and each stale entry costs a new review, or a regeneration for an upstream-derived one, until then the dataset is federated with its mechanical columns only.
That is deliberate: pinning to content rather than to a version tag means a new version that leaves the table alone does not stale the entry.
`scripts/neurobagel/curation-check.ts` lists entries that are stale against the data plane.
The transform's report gains a `curation` key only when the caller passes an entry, so a dataset without one produces byte-identical output and `NEUROBAGEL_TRANSFORM_VERSION` does not move.
The loader imports the full diagnosis and assessment vocabularies (about 850 KB of JSON); the transform does not, and a caller imports the loader explicitly.
The transform trusts that an entry came from the loader.

Curation can say less than a reviewer would like, and the gaps are facts about the pinned vocabulary, not about the loader.
The pinned diagnosis vocabulary has no generic amyotrophic lateral sclerosis term (only subtypes), so datasets of ALS patients stay without a diagnosis; it has no Edinburgh Handedness Inventory in the assessment vocabulary; and age in months or days has no Neurobagel format, so such a column cannot be curated into the graph.
A dataset that names an assessment only as "behavioral questionnaires" cannot be given a tool from its own documents, and is left alone.

The reused upstream annotations are the riskiest class, because NEMAR did not review them.
Numeric sex codes (`1` and `2`, `0` and `1`) are the clearest case: the meaning is a convention of the dataset and nothing in the table says it, so an entry that maps them is only as good as upstream's reading of the dataset's own description.
`upstream_community` marks them, and a person spot-checks those columns before the entries are committed in bulk.
The licence asks that its notice travel with copies, so `shared/neurobagel/NOTICE-openneuro-annotations.txt` carries it and every reused entry names its upstream file and blob.

## Alternatives considered

- **Sidecar files in the dataset repositories.**
  The repositories are published and accept pull requests only (ADR 0001), and a publicly served backend-written surface would need the anonymity blind (ADR 0065).
  Closed in ADR 0081; recorded again because it is the first idea everyone has.
- **A database table or a `datasets` column.**
  ADR 0034 keeps `datasets` one table under a column budget and says to derive, not store; a curated annotation is a reviewed claim, which a file in git versions, diffs and reviews better than a row.
- **Pin to the dataset's version tag.**
  A tag changes with every release, whether or not the table did, so most entries would go stale for nothing; a content pin is stale exactly when the reviewed bytes are not the bytes in hand.
- **Trust a hash the caller supplies.**
  The transform could not verify it, an annexed file has no `git:` entity tag, and a caller bug would silently apply an entry to the wrong table.
- **Apply the columns that still fit when the table changed.**
  A changed table can invalidate any column, and nothing says which; the entry is whole or it is skipped.
- **Generate the reused entries at build time.**
  A build would depend on two live hosts and on a repository that moves, and nobody would read what it produced.
  A pinned generator and a reviewed diff give the same entries with neither problem.
- **Map `gender` to sex, and numeric codes by convention, in the mechanical rules.**
  Rejected in ADR 0081 and still: the meaning is dataset-specific, so it is a reviewed entry or nothing.

## Receipts

- Epic #1586 and phase issue #1591; design in `.context/epic_neurobagel_federation.md`.
- ADR 0081 (the transform and its rules), ADR 0034 (no new `datasets` column), ADR 0065 (the blind), ADR 0066 (the entity tag of a git-tracked file is its blob SHA), ADR 0068 (the reserved fixture band), ADR 0073 (a reviewed declaration the code does not guess).
- `uv run scripts/neurobagel/oracle.py` runs the real pinned `bagel pheno` over every curated golden, including Collection columns, and its recordings are in `test/neurobagel/oracle/`.
- `bun run scripts/neurobagel/mutation-battery.ts` runs 48 hand-written mutants over the loader, the binder, the transform's use of an entry, the output validators and the upstream converter.
- Upstream: `neurobagel/openneuro-annotations` at commit `116676db7114b68338c48df2d6bb804c99e8c354`, MIT licence, kept under `test/neurobagel/upstream/` with its licence and provenance.
