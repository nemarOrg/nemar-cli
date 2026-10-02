# NEMAR to Neurobagel transform

One pure TypeScript transform that turns the documents the NEMAR data plane already serves into the artifacts a stock Neurobagel node loads (epic #1586, phase 1).
Nothing in this directory does input or output (I/O), uses a Node-only application programming interface (API) or needs wasm, so the same code runs in the Cloudflare Worker and in Bun scripts.
The only code that reads the network lives in `scripts/neurobagel/`.
Two checks hold that claim, and they run in different places.
`tsc --noEmit` in `backend/` compiles this directory against the Worker's types (`backend/tsconfig.json` includes it), where `node:` modules, `process`, `Buffer` and `Bun` do not exist; it runs in the `deploy-backend.yml` type-check steps and in the husky pre-commit hook (`bun run typecheck`), not in the pull request gate.
The pull request gate (`test.yml`) runs the root `tsc --noEmit`, which compiles it against Bun's types, and the unit tier, which includes `test/neurobagel-purity.unit.test.ts`, a source scan for everything the type check cannot see (`eval`, `new Function`, dynamic `import()`, `Date`, randomness, `fetch`, timers and imports from outside the directory).

## Inputs

The input is `NeurobagelInput` (`input-schema.ts`):

| Field | Source | `null` means |
| --- | --- | --- |
| `expectedDatasetId` | the dataset the caller is converting; REQUIRED, checked against `metadata.json` | not allowed |
| `metadata` | parsed `GET <data host>/<id>/metadata.json` | not allowed |
| `participantsTsv` | text of `GET <data host>/<id>/<latest>/participants.tsv`; TSV is tab-separated values | the dataset has no phenotype table (Hypertext Transfer Protocol, HTTP, status 404) |
| `participantsJson` | text of `GET <data host>/<id>/<latest>/participants.json` | no column descriptions (HTTP 404) |
| `curation` | the dataset's entry from `curation.json`, as `parseCuration` returns it | no reviewed entry for this dataset (also: the field is absent) |

A caller passes `null` for the two participants files only for an HTTP 404.
A failed fetch is an error and must not be passed as `null`.
The two participants files are passed as text, so a file that is served but not valid is reported (`malformed`, `unreadable`) instead of failing in the caller.

Identity (name, authors, keywords, digital object identifier or DOI) comes only from `metadata.json`, which the backend writes and blinds.
A depositor's own files are never an identity source, and the transform refuses any input whose `anonymous` is not exactly `false`.
Eligibility is decided elsewhere, from the database row; this refusal is a backstop.

## Outputs

`buildNeurobagelArtifacts(input)` returns `{ datasetId, files, report }`.
`files` holds four documents, named by `artifactFileNames(datasetId)` so a catalog-mode node can read the pair too, and `report` is the typed `NeurobagelReport` view of the fourth.

| File | What it is |
| --- | --- |
| `<id>.jsonld` | graph-mode JavaScript Object Notation for Linked Data (JSON-LD): the `bagel.models.Dataset` shape with Neurobagel's `@context` |
| `<id>_annotated.json` | the data dictionary, the input of `bagel pheno --dictionary` |
| `<id>_dataset_description.json` | the dataset description, the input of `bagel pheno --dataset-description` |
| `<id>.report.json` | counts and flags only, never a participant id or value |

Output bytes are stable: keys are sorted, lists keep the order the transform built, and identifiers are version 5 universally unique identifiers (UUIDs) derived from names under one fixed namespace (`identifiers.ts`).
Changing that namespace, or any identifier name, changes every identifier at once, so both are committed once and never edited (architecture decision record, ADR, 0081 records the name grammar).
`version.ts` holds the output version, which moves in any pull request that changes a byte of output for the same input.

## Mapping rules

| Source | Becomes | When the rule does not apply |
| --- | --- | --- |
| `participant_id` | subject label (`sub-` is added if missing) | no usable column: the table is not used |
| column `age` (any case) | `hasAge`, by value grammar: decimal, range (midpoint), lower bound (`90+`), ISO 8601 years and months | units other than years, a mostly unparseable column, values outside 0 to 120, or zeros making up at least half of the parsed ages (a placeholder): left to curation |
| column `sex` (any case) | `hasSex`: m/male, f/female, o/other | numeric codes and unknown spellings are not guessed; the column goes to curation when more than 10% cannot be mapped |
| column `group` (any case) | healthy control spellings become `ncit:C94342` as a diagnosis | every other group value is a declared missing value |
| `gender`, assessments, handedness, anything else | nothing | `gender` and assessments are left to curation |
| bids index `eeg`, `meg` | one acquisition per datatype: `nidm:Electroencephalography` for electroencephalography (EEG) and `nidm:Magnetoencephalography` for magnetoencephalography (MEG) | every other datatype (intracranial EEG or iEEG, electromyography or EMG, near-infrared spectroscopy or NIRS, motion, behavior, anatomy) gets no term and is counted in the report |

A value the rules cannot map is a declared missing value, counted in the report, never a guess.
What the rules leave out can be supplied by a reviewed curation entry, which replaces the rule for the variable it curates (see Curation below).
Missing values are `""`, `n/a`, `N/A` and `NA`.
An EMG recording is never mapped to EEG.

## Subjects

The graph holds the subjects of the bids index, the participants that have data at NEMAR (the Brain Imaging Data Structure, BIDS, index of the dataset's latest version).
Rows of `participants.tsv` for participants with no data are counted in the report (`subjects.table_only`) and left out, and a column is mapped from the graph's participants only, so a row nobody has data for cannot change a value range, a level or the 10% rule.
Phenotype comes only from the table and imaging only from the index, joined by exact participant id after `sub-` is added.
Ids that meet only in part are never joined by guesswork: when ids are left over on both sides the report flags `partial_join` and carries the counts.
If the table and the index share no id at all, the table is not used (`ids_do_not_join`).
If the index lists no subject, the table's participants are the subjects and the report flags `bids_index_empty_fell_back_to_table`.
`ParticipantCount` is the declared `demographics.subjects_count` when it is positive, otherwise the number of graph subjects, and `participant_count.used_from` says which.

A participant listed twice with identical rows is one participant.
Listed twice with rows that disagree, no row can be taken as the truth: the participant stays and carries no phenotype, and the report counts them (`conflicting_ids`).

Every subject gets exactly one phenotypic session (label `ses-unnamed`, as `bagel pheno` labels a table without sessions), because the node API reaches a subject only through that session.

## Imaging sessions

The bids index records which datatype is in which session (`session_modalities`, added in phase 2, #1595), and each session that holds a mapped datatype becomes an imaging session with exactly those acquisitions.
A datatype directory directly under the subject (the `no-session` key, `NO_SESSION_KEY` in `shared/contract/dataset.ts`) goes in `ses-unnamed`, and a session that holds nothing NEMAR maps gets no imaging session.
A datatype here is any directory name found under a subject or a session, so every datatype is filtered through the `eeg` and `meg` allowlist before it reaches the graph.
A document written before the field existed has only two independent sets, session labels and datatypes.
With at most one label the pairing is certain and the imaging session keeps its label.
With two or more, any pairing would be a guess, so the datatypes go on one `ses-unnamed` imaging session and the report counts the subjects affected (`imaging.session_pairing_subjects.unknown`).
A `session_modalities` that is malformed, or whose mapped datatypes differ from the subject's, is not trusted: the subject falls back to the same rules and the report flags `session_modalities_unreadable` or `session_modalities_inconsistent`.
`imagingSessionsFor` in `jsonld.ts` is the one place this is decided.

The output is validated before it is returned (`validate-output.ts`): strict shapes mirroring Neurobagel's pydantic models, and every controlled term checked against the pinned vocabulary.
A failure there is a bug and surfaces as a `NeurobagelRefusal` with code `output_invalid`.

## Curation

Some annotations a table cannot yield mechanically: which diagnosis a free-text group value means, which column holds sex when it is called `gender`, which assessment tool a column is an item of, what an age column of placeholder zeros holds.
They live in one reviewed file, `curation.json`, keyed by dataset id, and an entry applies only to the exact bytes it was reviewed against (architecture decision record, ADR, 0084).

```json
{
  "format": 1,
  "datasets": {
    "nm000158": {
      "columns": { "group": { "IsAbout": {"TermURL": "nb:Diagnosis", "Label": "Diagnosis"}, "Levels": {"acute stroke patients (1-30 days post-stroke)": {"TermURL": "snomed:230690007", "Label": "Cerebrovascular accident"}}, "MissingValues": [], "VariableType": "Categorical" } },
      "evidence": { "source": "...", "reviewer": "...", "review": "author", "date": "2026-10-02" },
      "pins": { "participants_tsv": "<git blob sha of the file>", "participants_json": "<sha, or null if the dataset has none>" }
    }
  }
}
```

Each column maps to the `Annotations` block the Neurobagel annotation tool exports, pasted as exported.
Four kinds are curatable: age (`nb:Age`, a `Continuous` block with a `Format`), sex and diagnosis (`Categorical` with `Levels`), and an item of an assessment tool (`Collection` with `IsPartOf`).
Terms must be in the pinned vocabulary with the pinned label, a column named `age`, `sex` or `group` must be about the same thing, and a dataset has at most one sex and one age column.

| Step | Module | Decides |
| --- | --- | --- |
| `parseCuration(text)` | `curation.ts` | whether the FILE is fit to be believed; throws `CurationError` listing every problem, and never returns a half-checked file |
| `bindCuration(entry, documents, table)` | `curation-bind.ts` | whether the entry fits THIS dataset's documents: the pins, then that every curated column exists and its level map covers every value of the table |
| `buildNeurobagelArtifacts({..., curation})` | `transform.ts` | applies a bound entry, to the graph's participants only |

Import the loader from `curation.ts` explicitly; the transform and `index.ts` do not load the full diagnosis and assessment vocabularies.
The text of a participants file must reach the transform exactly as the data plane served it, because the pin is the git blob SHA-1 of those bytes (a leading byte order mark may be dropped; invalid UTF-8 makes the entry stale, which is safe).

An entry that does not fit is skipped whole, never partly applied, and the report says why in `curation` (counts and enumerated values only):

| `curation.status` | Meaning | Flag |
| --- | --- | --- |
| `applied` | the entry's columns are in the dictionary and the graph | none |
| `stale` | a pinned file is not the file in hand (`stale_files` names it); the reviewer never saw these bytes | `curation_stale` |
| `invalid` | the files are the pinned ones and the entry does not fit them (`problems` counts) | `curation_invalid` |
| `unused` | the entry fits, but none of the table's participants are the graph's | `curation_unused` |

Whatever the status, the mechanical columns ship as they would without an entry.
The `curation` key is absent from the report of a dataset with no entry, so such a dataset's output is byte-identical to before.
`participants_with` counts the graph participants that received a value from the entry, by kind.

To add an entry, write it in the file with the pins of the dataset's current files, then check it:

```bash
bun run scripts/neurobagel/curation-check.ts            # every entry against the captured fixtures
bun run scripts/neurobagel/curation-check.ts --live     # every entry against data.nemar.org now (read-only GETs)
```

A new entry needs a captured fixture of its dataset (`gather.ts`, below) and regenerated goldens; the tests bind every committed entry to its fixture and compare the curated goldens with the real `bagel pheno`.
`evidence.review` is `author` (written by the author of the change, not a domain expert), `domain_expert`, or `upstream_community`; registration of the node waits until the entries it serves have the review they need.

### Reusing Neurobagel's OpenNeuro annotations

[`neurobagel/openneuro-annotations`](https://github.com/neurobagel/openneuro-annotations) is published under the MIT licence, one `dsNNNNNN.json` per OpenNeuro dataset, and NEMAR's mirror `onNNNNNN` is OpenNeuro's `dsNNNNNN`.
`scripts/neurobagel/reuse-openneuro-annotations.ts` converts those annotations into entries of this file, pinned to one upstream commit:

```bash
# measure only: how many mirrors would be covered, how many columns dropped and why, the size
bun run scripts/neurobagel/reuse-openneuro-annotations.ts --skip-redundant --cache <dir> --report <file>
# write the entries for some mirrors into the committed file, and keep the upstream files and licence
bun run scripts/neurobagel/reuse-openneuro-annotations.ts --skip-redundant --date 2026-10-02 \
  --merge-into shared/neurobagel/curation.json --save-upstream test/neurobagel/upstream on003568 ...
```

It keeps a column only if it is about one of the four curatable variables, every term is in the pinned vocabulary (upstream's blank labels are rewritten, `nb:FromInt` is read as `nb:FromFloat`), the loader accepts it, and the binder accepts it against the mirror's CURRENT table; whatever fails is dropped and counted.
`--skip-redundant` leaves out a column the mechanical rules would already map to the same values for every row.
`NOTICE-openneuro-annotations.txt` carries the upstream licence notice that reused entries require.
`scripts/neurobagel/mutation-battery.ts` runs hand-written mutants over the loader, the binder, the transform's use of an entry, the output validators and the converter, and reports which survive.

## The pinned vocabulary

`vocab/` is a snapshot of Neurobagel's vocabulary and models, generated and never edited by hand:

| File | Holds |
| --- | --- |
| `snapshot.json` | pins (repository, commit, and the blob and sha256 of every file used), namespaces, the JSON-LD `@context`, sex, imaging modality and age format terms |
| `diagnosis-terms.json`, `assessment-terms.json` | every term of those vocabularies, one `identifier: label` pair per line (about 700 KB and 150 KB; only the curation loader imports them, through `vocab-terms.ts`) |
| `dataset.schema.json`, `dictionary.schema.json` | JSON Schemas generated from the pinned `bagel` pydantic models |

Regenerate after moving a pin in `scripts/neurobagel/generate-vocab.ts`:

```bash
bun run scripts/neurobagel/generate-vocab.ts           # rewrite vocab/
bun run scripts/neurobagel/generate-vocab.ts --check   # exit 1 if vocab/ differs from the pins (needs network)
```

A pin change that alters any output needs a version bump in `version.ts`, regenerated goldens and a fresh oracle run.

## Fixtures, goldens and the Neurobagel oracle

`test/neurobagel/fixtures/<id>/` holds documents captured byte for byte from `data.nemar.org`, with `provenance.json` (uniform resource locator or URL, fetch time, version, sha256, size, entity tag or ETag).
Nothing whose metadata is not `anonymous: false` is written there, with one declared exception (`refusalToWrite` in `scripts/neurobagel/gather.ts`): the negative control `nm099998`, and then only its `metadata.json`.
`nm000284`, the live anonymous deposit, is never fetched into this repository.
`nm099998` is the dev-owned standing anonymous deposit (AGENTS.md); it is the negative control, and only its public, blinded `metadata.json`, fetched from the dev host `data-test.nemar.org`, is kept, never its participants files.
Every dataset with an entry in `curation.json` has a fixture, and `loadFixture` passes the entry to the transform as the writer will, so its golden is the output of the production path and the curated goldens are the ones the oracle compares with `bagel pheno`.
`test/neurobagel/upstream/<short commit>/` holds the upstream annotation files the reused entries were converted from, unchanged, with the upstream licence and a `provenance.json`.

```bash
# refresh a fixture
bun run scripts/neurobagel/gather.ts --out test/neurobagel/fixtures nm000132
bun run scripts/neurobagel/gather.ts --out test/neurobagel/fixtures --base https://data-test.nemar.org --metadata-only nm099998

# rewrite the goldens, then READ THE DIFF
bun run scripts/neurobagel/regenerate-goldens.ts

# run Neurobagel's own code over the goldens and refresh test/neurobagel/oracle/
uv run scripts/neurobagel/oracle.py
```

`oracle.py` runs the pinned `bagel` release (`bagel pheno`, `bagel bids`, its pydantic models and validators), the recipes graph-mode and catalog-mode loaders at the pinned commit, a Resource Description Framework (RDF) expansion of the JSON-LD, and the SPARQL Protocol and RDF Query Language (SPARQL) queries a federated search sends, built by the node API's own `create_query` at the pinned tag and run by rdflib over the goldens.
Its environment is locked (`scripts/neurobagel/*.py.lock`, written by `uv lock --script`), so a rerun resolves the same packages.
None of that is a GraphDB load: no container runtime was available, so loading a golden into a stock GraphDB-backed stack is checked separately, on the real host.
It records bagel's output, with identifiers set aside, so `bun test` compares the goldens to it without Python.
`bagel pheno` reads the whole table, and the mechanical dictionary is built from the graph's participants only, so a table that lists participants with no data could hold a value the dictionary does not declare; the oracle would then stop and print bagel's message.
No fixture does this today.
A curated column is checked against every row of the table before it is applied, so it cannot.
For a curated golden the oracle also compares assessments (`bagel` marks a tool on a participant with at least one item that is not a declared missing value), and it compares a participant's diagnoses as a set.

Opt-in tests that need the network or `uv`:

```bash
NEUROBAGEL_ORACLE=1 bun test test/neurobagel-oracle.integration.test.ts
NEUROBAGEL_LIVE=1 bun test test/neurobagel-gather.integration.test.ts
NEUROBAGEL_LIVE=1 bun test test/neurobagel-reuse.integration.test.ts
```

Without the opt-in they are reported as skipped.
