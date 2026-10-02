# NEMAR to Neurobagel transform

One pure TypeScript transform that turns the documents the NEMAR data plane already serves into the artifacts a stock Neurobagel node loads (epic #1586, phase 1).
Nothing in this directory does I/O, uses a Node-only API or needs wasm, so the same code runs in the Cloudflare Worker and in Bun scripts.
The only code that reads the network lives in `scripts/neurobagel/`.

## Inputs

| Document | Source | Absent means |
| --- | --- | --- |
| `metadata.json` | `GET <data host>/<id>/metadata.json` | the dataset cannot be transformed |
| `participants.tsv` | `GET <data host>/<id>/<latest>/participants.tsv` | the dataset has no phenotype table (HTTP 404) |
| `participants.json` | `GET <data host>/<id>/<latest>/participants.json` | no column descriptions (HTTP 404) |

A caller passes `null` only for an HTTP 404.
A failed fetch is an error and must not be passed as `null`.
`input-schema.ts` holds the zod schema of the fields the transform reads.

Identity (name, authors, keywords, DOI) comes only from `metadata.json`, which the backend writes and blinds.
A depositor's own files are never an identity source, and the transform refuses any input whose `anonymous` is not exactly `false`.
Eligibility is decided elsewhere, from the database row; this refusal is a backstop.

## Outputs

`buildNeurobagelArtifacts(input)` returns four files, named so a catalog-mode node can read the pair too:

| File | What it is |
| --- | --- |
| `<id>.jsonld` | graph-mode JSON-LD (the `bagel.models.Dataset` shape with Neurobagel's `@context`) |
| `<id>_annotated.json` | the data dictionary, the input of `bagel pheno --dictionary` |
| `<id>_dataset_description.json` | the dataset description, the input of `bagel pheno --dataset-description` |
| `<id>.report.json` | counts and flags only, never a participant id or value |

Output bytes are stable: keys are sorted, lists keep the order the transform built, and identifiers are version 5 UUIDs derived from names under one fixed namespace (`identifiers.ts`).
Changing that namespace changes every identifier at once, so it is committed once and never edited.
`version.ts` holds the output version, which moves in any PR that changes a byte of output for the same input.

## Mapping rules

| Source | Becomes | When the rule does not apply |
| --- | --- | --- |
| `participant_id` | subject label (`sub-` is added if missing) | no usable column: subjects come from the bids index only |
| column `age` (any case) | `hasAge`, by value grammar: decimal, range (midpoint), lower bound (`90+`), ISO 8601 years and months | units other than years, a mostly unparseable column, values outside 0 to 120: left to curation |
| column `sex` (any case) | `hasSex`: m/male, f/female, o/other | numeric codes and unknown spellings are not guessed; the column goes to curation when more than 10% cannot be mapped |
| column `group` (any case) | healthy control spellings become `ncit:C94342` as a diagnosis | every other group value is a declared missing value |
| `gender`, assessments, handedness, anything else | nothing | `gender` and assessments are left to curation |
| bids index `eeg`, `meg` | one acquisition per datatype, `nidm:Electroencephalography` and `nidm:Magnetoencephalography` | every other datatype (iEEG, EMG, NIRS, motion, behavior, anatomy) gets no term and is counted in the report |

A value the rules cannot map is a declared missing value, counted in the report, never a guess.
Missing values are `""`, `n/a`, `N/A` and `NA`.
An electromyography recording is never mapped to EEG.

Subjects are the union of the participants table and the bids index.
Phenotype comes only from the table and imaging only from the index.
Every subject gets exactly one phenotypic session (label `ses-unnamed`, as `bagel pheno` labels a table without sessions), because the node API reaches a subject only through that session.
If the table and the index share no subject id, the table is not joined, so a subject count is never doubled.

The bids index records which datatype is in which session (`session_modalities`, added in phase 2, #1588), and each session that holds a mapped datatype becomes an imaging session with exactly those acquisitions.
A datatype directory directly under the subject (the `no-session` key) goes in `ses-unnamed`, and a session that holds nothing NEMAR maps gets no imaging session.
A document written before the field existed has only two independent sets, session labels and datatypes.
With at most one label the pairing is certain and the imaging session keeps its label.
With two or more, any pairing would be a guess, so the datatypes go on one `ses-unnamed` imaging session and the report counts the subjects affected (`imaging.session_pairing_subjects.unknown`).
A `session_modalities` that is malformed, or names other datatypes than the subject has, is not trusted: the subject falls back to the same rules and the report flags `session_modalities_unreadable` or `session_modalities_inconsistent`.
`imagingSessionsFor` in `jsonld.ts` is the one place this is decided.

The output is validated before it is returned (`validate-output.ts`): strict shapes mirroring Neurobagel's pydantic models, and every controlled term checked against the pinned vocabulary.
A failure there is a bug and surfaces as a `NeurobagelRefusal` with code `output_invalid`.

## The pinned vocabulary

`vocab/` is a snapshot of Neurobagel's vocabulary and models, generated and never edited by hand:

| File | Holds |
| --- | --- |
| `snapshot.json` | pins (repository, commit, and the blob and sha256 of every file used), namespaces, the JSON-LD `@context`, sex, imaging modality and age format terms |
| `diagnosis-terms.json`, `assessment-terms.json` | every term of those vocabularies, one `identifier: label` pair per line (about 700 KB and 150 KB; the curation loader of a later phase needs them whole) |
| `dataset.schema.json`, `dictionary.schema.json` | JSON Schemas generated from the pinned `bagel` pydantic models |

Regenerate after moving a pin in `scripts/neurobagel/generate-vocab.ts`:

```bash
bun run scripts/neurobagel/generate-vocab.ts           # rewrite vocab/
bun run scripts/neurobagel/generate-vocab.ts --check   # exit 1 if vocab/ differs from the pins (needs network)
```

A pin change that alters any output needs a version bump in `version.ts`, regenerated goldens and a fresh oracle run.

## Fixtures, goldens and the Neurobagel oracle

`test/neurobagel/fixtures/<id>/` holds documents captured byte for byte from `data.nemar.org`, with `provenance.json` (URL, fetch time, version, sha256, size, ETag).
The anonymous negative control, `nm099998`, comes from `data-test.nemar.org`.
The live anonymous deposit is never copied here.

```bash
# refresh a fixture
bun run scripts/neurobagel/gather.ts --out test/neurobagel/fixtures nm000132
bun run scripts/neurobagel/gather.ts --out test/neurobagel/fixtures --base https://data-test.nemar.org nm099998

# rewrite the goldens, then READ THE DIFF
bun run scripts/neurobagel/regenerate-goldens.ts

# run Neurobagel's own code over the goldens and refresh test/neurobagel/oracle/
uv run scripts/neurobagel/oracle.py
```

`oracle.py` runs the pinned `bagel` release (`bagel pheno`, `bagel bids`, its pydantic models and validators), the recipes graph-mode and catalog-mode loaders at the pinned commit, an RDF expansion of the JSON-LD, and the queries a federated search sends, built by the node API's own `create_query` at the pinned tag and run by rdflib over the goldens.
None of that is a GraphDB load: no container runtime was available, so loading a golden into a stock GraphDB-backed stack is checked separately, on the real host.
It records bagel's output, with identifiers set aside, so `bun test` compares the goldens to it without Python.

Opt-in tests that need the network or `uv`:

```bash
NEUROBAGEL_ORACLE=1 bun test test/neurobagel-oracle.integration.test.ts
NEUROBAGEL_LIVE=1 bun test test/neurobagel-gather.integration.test.ts
```
