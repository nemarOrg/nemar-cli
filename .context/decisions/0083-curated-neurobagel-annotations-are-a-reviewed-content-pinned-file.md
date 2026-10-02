# ADR 0083: Curated Neurobagel annotations are a reviewed, content-pinned file keyed by dataset id

**Status:** accepted
**Date:** 2026-10-02
**Owner:** Seyed Yahya Shirazi

**Amendment 2026-10-02:** the reuse converter reads a column not named `sex` as sex only when its own `participants.json` description says sex; read "Amendment 2026-10-02" below before relying on any statement here that a `gender` column is read as sex.

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
   The output validators then allow a diagnosis or an assessment term in a dataset's graph and dictionary only if that dataset's entry names it (healthy control, which the mechanical group rule emits, is always allowed), so the output carries nothing an entry does not say.
   That an entry's terms are in the vocabulary is guaranteed by the loader and by nothing else, so the entry is an opaque type: `parseCuration` registers what it returns, the type cannot be satisfied by a hand-built object, and at run time the transform and the binder refuse any entry the loader did not make (`curation_not_loaded`).
   What is guaranteed is that an entry reached them through the loader in this process; a deliberate edit of a loaded entry's maps through a cast is outside the guarantee (the entry, its columns, pins and evidence are frozen, which stops the ordinary mutation).
3. **The loader fails closed.**
   One problem anywhere rejects the whole file, and the error lists the problems of the first stage that has any: key problems first, then the shape, then the meaning.
   It rejects text that is not JavaScript Object Notation (JSON), a key that appears twice (`JSON.parse` would keep the last), `__proto__`, an unknown key at any level, an empty level map, a level that is also a missing value, a second sex or age column, a column named `age`, `sex` or `group` that is about something else, a dataset id outside `nm` and `on` or inside the reserved fixture band (ADR 0068), a malformed pin, blank evidence, a date that does not exist, and, when the caller supplies today's date (the loader has no clock), a review dated in the future.
   A file that does not load STOPS conversion, for every dataset: `lookupCuration` answers `stop`, never `none`, because a broken file cannot say which datasets it names and an entry may exist only to withdraw a claim the mechanical rule would make (without the entry for on004166 and on006801, 20 and 7 false healthy controls are published).
   The writer then writes no artifact (an existing one stays as it is) and reports a finding that needs a person; it must never catch the failure and convert with `curation: null`.
   A dataset id that has an entry is never converted without it.
4. **A pin is the git blob hash (Secure Hash Algorithm 1, SHA-1) of the bytes reviewed, computed by the transform from the text it converts.**
   Each entry pins `participants.tsv` and `participants.json` (`null` pins a file as absent).
   A pin is what `git hash-object` prints for the file, or the `git:` value of the data plane's entity tag for a git-tracked file (ADR 0066); a file that is annexed has no such tag and is pinned from its bytes with `git hash-object`.
   The transform computes the hash from its own input rather than trust one the caller passes, so a pin says something about the bytes actually being converted.
   Line endings are part of the bytes: the same table with its line endings flipped is stale.
   A leading byte order mark (BOM) is the one tolerance, because decoders drop it; text that is not valid 8-bit Unicode Transformation Format (UTF-8) never matches, which is the safe direction.
5. **An entry that does not fit is skipped whole, loudly, and what it names is withheld.**
   `stale`: a pinned file is not the file in hand, so none of the entry is applied.
   `invalid`: the files are the pinned ones and the entry still does not fit them, because a column is missing from the header, the level map misses a value the table holds, an age is unreadable in its declared format, or an age column breaks one of the age rules of item 6.
   `unused`: the entry fits, but none of the table's participants are the graph's.
   The variables the entry does not name ship as without an entry.
   The variables it names (age, sex, diagnosis) are WITHHELD: the mechanical mapping of each is held back too, because some entries exist only to withdraw a claim the mechanical rule would make, and an entry that goes stale must lose claims, never make a false one.
   The report carries a `curation` section of counts and enumerated values (never a column name, a cell or the reviewer's words), including how many mechanical mappings were withheld, and the flags say `curation_stale`, `curation_invalid`, `curation_unused` and, if anything was withheld, `curation_withheld`.
   The Phase 4 writer must treat every one of those four flags as a finding that needs a person, reported and never published silently: the dataset is federated with a different set of claims than its entry intended.
   Partial application is rejected: after a table changes nobody can say which columns still describe it.
6. **An entry is applied to the participants of the graph, and checked against every row.**
   The graph holds the subjects that have data (ADR 0081), so a curated value is attached to those participants only.
   Coverage is checked over every row of the table, because the dictionary is also read by `bagel pheno` and by catalog-mode nodes, which refuse a table whose values the dictionary does not declare.
   An age column is bound only if participants.json does not declare units other than years (Neurobagel has no age format for months, weeks or days, and a dictionary that says years over months would make six-month-olds match a search for ages five to ten) and fewer than half of its parsed ages are 0, unless 0 is declared a missing value: the mechanical rule's own two checks, which a reviewer who curates the column has not seen in the table.
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

An entry goes stale when a dataset's `participants.tsv` or `participants.json` changes, and each stale entry costs a new review, or a regeneration for an upstream-derived one; until then the dataset is federated with its mechanical columns for the variables the entry does not name, and with nothing for the ones it names.
That is deliberate: pinning to content rather than to a version tag means a new version that leaves the table alone does not stale the entry.
`scripts/neurobagel/curation-check.ts` lists entries that are stale against the data plane.
The transform's report gains a `curation` key only when the caller passes an entry, so a dataset without one produces byte-identical output and `NEUROBAGEL_TRANSFORM_VERSION` does not move.
The loader imports the full diagnosis and assessment vocabularies (about 850 kilobytes of JSON); the transform does not, and a caller imports the loader explicitly.
The age rules were added after review found two reused entries that broke them (on004635's ages are in months, on003505's are gestational weeks); on003505's only curated column was that age, so it has no entry.
Age in months, weeks or days cannot be curated into the graph, and a column of placeholder zeros cannot be curated into ages either: the binder refuses both, so a reviewer who believes the zeros are real ages (infants measured in years) has no way to say so here, and can only declare 0 a missing value.

Curation can say less than a reviewer would like, and the gaps are facts about the pinned vocabulary, not about the loader.
The pinned diagnosis vocabulary has no generic amyotrophic lateral sclerosis term (only subtypes), so datasets of ALS patients stay without a diagnosis; it has no Edinburgh Handedness Inventory in the assessment vocabulary; and age in months or days has no Neurobagel format, so such a column cannot be curated into the graph.
A dataset that names an assessment only as "behavioral questionnaires" cannot be given a tool from its own documents, and is left alone.

The reused upstream annotations are the riskiest class, because NEMAR did not review them.
Numeric sex codes (`1` and `2`, `0` and `1`) are the clearest case: the meaning is a convention of the dataset and nothing in the table says it, so an entry that maps them is only as good as upstream's reading of the dataset's own description.
`upstream_community` marks them, and a person spot-checks those columns before the entries are committed in bulk.
The licence asks that its notice travel with copies, so `shared/neurobagel/NOTICE-openneuro-annotations.txt` carries it and every reused entry names its upstream file and blob.

## Amendment 2026-10-02: a sex column not named `sex` is read as sex only when its own description says sex

Neurobagel's term is sex, not gender, and a federated search for sex must not return people whose column says gender.
The owner decided that NEMAR does not relabel a gender column as sex, and reports only what the dataset's own sidecar supports.
The rule binds the reuse converter (item 8), and is defined once, in `sexReadingDrop` in `scripts/neurobagel/upstream-annotations.ts`:

- A column literally named `sex` (any case, padding ignored, which is the mechanical rule's own test) is read as sex, as before.
- Any other column that upstream annotates as `nb:Sex` is kept only if its Description in the mirror's `participants.json` contains the word sex (a whole word, any case) and does not contain gender.
- Otherwise it is dropped, and counted in the report, never silently.
  `sex_described_as_gender` is a Description that mentions gender, and a Description that names both words says gender.
  `sex_not_described_as_sex` is a Description that names neither word, a column with no Description, or a mirror with no `participants.json`.
- A dataset with both a `sex` and a `gender` column maps each by its own description, and a column left out does not take the dataset's one sex slot.

The transform's mechanical rule (ADR 0081) is unchanged: only a column named `sex` is mapped, and `gender` is left alone and flagged `gender_column_needs_curation`.
The loader and the binder are unchanged too, so a reviewed entry that a person writes is that person's own claim, with `evidence.review` saying who made it; no committed entry maps a gender column to sex by hand.

Measured over the 579 `on` mirrors, of the 100 `gender`-named columns that upstream reads as sex, 35 are kept because the description says sex, 60 are left out because it says gender, and 5 because it says nothing.
The default regeneration gives 54 entries where it gave 111, since 57 datasets had a gender column as their only kept column.
on004574 and on006861 keep their assessment items and lose their sex column, so their goldens now carry `gender_column_needs_curation`.
`--audit-sex <file>` writes every such column, kept or left out, with the description that decided it, so a person can audit the rule column by column.
The mutation battery gained nine mutants for the rule (U18 to U26) and two for the audit (U27 and U28).

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
- **Ship the mechanical mapping whenever an entry does not apply.**
  It fails open for an entry that exists to withdraw a claim: a stale entry for a `Control` that is an intervention arm would hand the false healthy control back, which a review reproduced by appending one newline to a table.
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
- `bun run scripts/neurobagel/mutation-battery.ts` runs 71 hand-written mutants over the loader, the binder, the transform's use of an entry, the output validators and the upstream converter.
- Upstream: `neurobagel/openneuro-annotations` at commit `116676db7114b68338c48df2d6bb804c99e8c354`, MIT licence, kept under `test/neurobagel/upstream/` with its licence and provenance.
