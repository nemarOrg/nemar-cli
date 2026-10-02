# ADR 0081: NEMAR emits Neurobagel artifacts by one pure transform over data-plane documents

**Status:** accepted
**Date:** 2026-10-02
**Owner:** Seyed Yahya Shirazi

## Context

Epic #1586 makes NEMAR datasets discoverable through Neurobagel's federated search by running a stock Neurobagel node on nemaring and feeding it records converted from what NEMAR already serves.
The stock node loads graph-mode JavaScript Object Notation for Linked Data (JSON-LD), one document per dataset.
Neurobagel's own converter, `bagel`, expects a Brain Imaging Data Structure (BIDS) tree on disk and a hand-annotated data dictionary, mints a random uuid4 for every node, and is Python.
NEMAR has to convert about 780 datasets, keep the output stable across regenerations, run the conversion in the Worker as a step of publication and import, and never let an anonymous deposit's identity near the result.

## Decision

**One pure TypeScript transform in `shared/neurobagel/` turns the three documents the data plane already serves (`metadata.json`, `participants.tsv` and `participants.json`) into graph-mode JSON-LD, a Neurobagel data dictionary, a dataset description and a counts-only report.**
It does no input or output (I/O), uses no Node-only application programming interface (API) and no wasm, so the same module runs in the Worker and in Bun scripts; the only code that reads the network is the gatherer under `scripts/neurobagel/`.
Two checks enforce the claim rather than leave it to memory, and they run in different places: `tsc --noEmit` in `backend/` compiles it against the Worker's types (in the `deploy-backend.yml` type-check steps and the husky pre-commit hook, not in the pull request gate), and a source scan in the unit tier rejects what the type check cannot see (in the pull request gate, with the root `tsc --noEmit` that compiles it against Bun's types).

Seven rules bind it:

1. **Identity comes only from `metadata.json`.**
   The backend writes and blinds that file (architecture decision record, ADR, 0065); a depositor's files cannot be blinded (ADR 0067), so name, authors, keywords and digital object identifier (DOI) are never read from them.
   The transform refuses any input whose `anonymous` is not exactly `false`; a missing value is unknown, not false.
   The caller must also say which dataset it is converting (`expectedDatasetId`, required), and a `metadata.json` for another dataset is refused.
   This is a backstop: eligibility is decided from the database row by the writer.
2. **Identifiers are derived, never random.**
   Every node id is a version 5 universally unique identifier (UUID) of a name under one namespace committed once (`shared/neurobagel/identifiers.ts`).
   The names are uniform resource locators (URLs) under `https://nemar.org/dataset/<id>`:
   the dataset is `<dataset>`, a subject is `<dataset>/<sub>`, its phenotypic session is `<dataset>/<sub>/phenotypic/ses-unnamed`, an imaging session is `<dataset>/<sub>/imaging/<ses>`, and an acquisition is `<dataset>/<sub>/imaging/<ses>/<datatype>`.
   The design note's literal names (`/<sub>`, `/<ses>`, `/<datatype>`) are not used for sessions and acquisitions because a phenotypic session and an imaging session both default to the label `ses-unnamed`, and under one shared name they would get one identifier on two nodes of different types; the kind segment keeps them apart, and the acquisition sits under the imaging session it belongs to.
   **This grammar is as permanent as the namespace.**
   Changing either changes every identifier in every graph at once, so a node loaded from old and new files holds two copies of every dataset.
3. **The vocabulary is a pinned snapshot, generated and never edited by hand.**
   `shared/neurobagel/vocab/` is built by `scripts/neurobagel/generate-vocab.ts` from commit-pinned `neurobagel/communities`, `bagel`, `api` and `recipes`, and every term the transform may emit is looked up there.
4. **A fact the rules cannot establish is left out and counted, never guessed.**
   Only `eeg` and `meg` map to an imaging modality (electroencephalography, EEG, and magnetoencephalography, MEG); intracranial EEG (iEEG), electromyography (EMG), near-infrared spectroscopy (NIRS), motion and the rest get no term, and an EMG recording is never mapped to EEG.
   Age, sex and healthy-control group map mechanically; every other column, and every value the rules do not recognise, is a declared missing value or is left to curation.
   An age column of which zeros are at least half the parsed ages is a placeholder and is left to curation.
   A participant listed twice with identical rows is one participant; with rows that disagree, no row is taken and the participant carries no phenotype.
5. **Output is byte-stable and validated before it is returned.**
   Keys are sorted, lists keep the order the transform built, and strict shapes mirroring Neurobagel's pydantic models plus the pinned vocabulary reject a bad document as a bug (`output_invalid`), because the federation API does not catch an invalid record from a node.
6. **The session pairing is used only where it is recorded.**
   When `bids_index` carries `session_modalities` each session holds exactly its datatypes; otherwise two or more session labels would make any pairing a guess, so the datatypes go on one `ses-unnamed` imaging session and the report counts the subjects affected.
   A datatype is any directory name under a subject or session, so every one goes through the `eeg` and `meg` allowlist.
7. **The graph holds the subjects that have data.**
   Its subjects are those of the bids index; table rows for participants with no data are counted in the report and left out, columns are mapped from the graph's participants only, and ids are joined by exact equality after `sub-` is added, never by guesswork.
   Ids left over on both sides raise `partial_join`; an index with no subjects falls back to the table and says so.
   Every subject gets one phenotypic session, because the node API reaches a subject only through it.

## Consequences

One definition of the conversion exists, with fixtures, goldens and an oracle, so the writer, the reconcile and a local run cannot disagree.
A change to any output byte for the same input needs a bump of `NEUROBAGEL_TRANSFORM_VERSION`, which marks every dataset stale for the writer; a vocabulary pin change is a reviewed diff of `vocab/`.
The subject count a federated search shows is the number of participants with data, not the length of `participants.tsv`; 50 of 776 datasets list participants with no data (2,744 rows in all; for example on004796, 79 with data against 192 rows), and `bagel` on the same table would count every row.
The report carries both numbers, so a reader can see what was left out.
Until the backend change that records `session_modalities` is deployed, 234 of 776 datasets have two or more sessions without the pairing and use the single `ses-unnamed` imaging session.
The vocabulary snapshot adds about 900 KB to the repository, because the curation loader of a later phase needs the diagnosis and assessment vocabularies whole.
Fixtures and goldens are real documents the data plane serves publicly.
`nm000284`, the live anonymous deposit, is never fetched into this repository.
`nm099998` is the dev-owned standing anonymous deposit (ADR 0068) and the negative control; only its public, blinded `metadata.json`, fetched from the dev host, is kept.
The gatherer refuses to write any document of a dataset whose metadata is not `anonymous: false`, with one declared exception: the control on the dev host, and then only its `metadata.json`, never a participants file; the exception is decided by the dataset id and the host together.

## Alternatives considered

- **Run unmodified `bagel` in GitHub Actions.**
  Python, random uuid4 churn on every run, pybids over a checked-out tree, and per-repository workflow machinery for about 780 repositories (ADR 0020).
  Lost on churn and cost.
- **Emit the catalog-mode pair only.**
  A catalog-mode node answers no modality filter, and the owner chose a stock graph-mode node.
  The pair falls out of the same transform and is emitted anyway (`<id>_annotated.json`, `<id>_dataset_description.json`).
- **Sidecar files in the dataset repositories.**
  The repositories are published and accept pull requests only (ADR 0001), and a publicly served backend-written surface would need the anonymity blind (ADR 0065).
- **A hand-written Workers implementation of the node API.**
  Dropped by the owner: the node is stock, so contract conformance holds by construction.
- **The union of table and index subjects.**
  It follows `bagel`, but it counts participants with no data in a discovery index and doubles a count when two id spaces disagree; the graph holds the subjects that have data.

## Receipts

- Epic #1586 and phase issue #1587; design in `.context/epic_neurobagel_federation.md`.
- `uv run scripts/neurobagel/oracle.py` runs the pinned `bagel` (pheno, bids, models, validators), the recipes graph-mode and catalog-mode loaders, a Resource Description Framework (RDF) expansion and the node API's own SPARQL Protocol and RDF Query Language (SPARQL) generator over every golden; its results are in the phase 1 pull request.
- ADR 0034 (no new `datasets` column), ADR 0050 (no wasm in the Worker), ADR 0065 and ADR 0067 (anonymity), ADR 0068 (the standing fixtures), ADR 0072 (the manifest is never read whole).
