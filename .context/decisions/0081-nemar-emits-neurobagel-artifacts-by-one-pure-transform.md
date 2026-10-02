# ADR 0081: NEMAR emits Neurobagel artifacts by one pure transform over data-plane documents

**Status:** accepted
**Date:** 2026-10-02
**Owner:** Seyed Yahya Shirazi

## Context

Epic #1586 makes NEMAR datasets discoverable through Neurobagel's federated search by running a stock Neurobagel node on nemaring and feeding it records converted from what NEMAR already serves.
The stock node loads graph-mode JSON-LD, one document per dataset.
Neurobagel's own converter, `bagel`, expects a BIDS tree on disk and a hand-annotated data dictionary, mints a random uuid4 for every node, and is Python.
NEMAR has to convert about 780 datasets, keep the output stable across regenerations, run the conversion in the Worker as a step of publication and import, and never let an anonymous deposit's identity near the result.

## Decision

**One pure TypeScript transform in `shared/neurobagel/` turns the three documents the data plane already serves (`metadata.json`, `participants.tsv`, `participants.json`) into graph-mode JSON-LD, a Neurobagel data dictionary, a dataset description and a counts-only report.**
It does no I/O, uses no Node-only API and no wasm, so the same module runs in the Worker and in Bun scripts; the only code that reads the network is the gatherer under `scripts/neurobagel/`.

Six rules bind it:

1. **Identity comes only from `metadata.json`.**
   The backend writes and blinds that file (ADR 0065); a depositor's files cannot be blinded (ADR 0067), so name, authors, keywords and DOI are never read from them.
   The transform refuses any input whose `anonymous` is not exactly `false`; a missing value is unknown, not false.
   This is a backstop: eligibility is decided from the database row by the writer.
2. **Identifiers are derived, never random.**
   Every node id is a version 5 UUID of a URL under `https://nemar.org/dataset/<id>`, under one namespace committed once (`shared/neurobagel/identifiers.ts`).
   Changing that namespace changes every identifier in every graph.
3. **The vocabulary is a pinned snapshot, generated and never edited by hand.**
   `shared/neurobagel/vocab/` is built by `scripts/neurobagel/generate-vocab.ts` from commit-pinned `neurobagel/communities`, `bagel`, `api` and `recipes`, and every term the transform may emit is looked up there.
4. **A fact the rules cannot establish is left out and counted, never guessed.**
   Only `eeg` and `meg` map to an imaging modality; iEEG, EMG, NIRS, motion and the rest get no term, and an EMG recording is never mapped to EEG.
   Age, sex and healthy-control group map mechanically; every other column, and every value the rules do not recognise, is a declared missing value or is left to curation.
5. **Output is byte-stable and validated before it is returned.**
   Keys are sorted, lists keep the order the transform built, and strict shapes mirroring Neurobagel's pydantic models plus the pinned vocabulary reject a bad document as a bug (`output_invalid`), because the federation API does not catch an invalid record from a node.
6. **The session pairing is used only where it is recorded.**
   When `bids_index` carries `session_modalities` each session holds exactly its datatypes; otherwise two or more session labels would make any pairing a guess, so the datatypes go on one `ses-unnamed` imaging session and the report counts the subjects affected.

Subjects are the union of the participants table and the bids index; every subject gets one phenotypic session, because the node API reaches a subject only through it.

## Consequences

One definition of the conversion exists, with fixtures, goldens and an oracle, so the writer, the reconcile and a local run cannot disagree.
A change to any output byte for the same input needs a bump of `NEUROBAGEL_TRANSFORM_VERSION`, which marks every dataset stale for the writer; a vocabulary pin change is a reviewed diff of `vocab/`.
The union of table and index counts a participant listed in `participants.tsv` with no data in the release (43 of 776 datasets differ from `demographics.subjects_count`, for example on004796 at 192 against 79); it follows `bagel`, which makes a subject of every table row, and the report carries both numbers.
The vocabulary snapshot adds about 900 KB to the repository, because the curation loader of a later phase needs the diagnosis and assessment vocabularies whole.
`nm`-prefixed fixtures and goldens are real public documents; the live anonymous deposit is never copied into the repository.

## Alternatives considered

- **Run unmodified `bagel` in GitHub Actions.** Python, random uuid4 churn on every run, pybids over a checked-out tree, and per-repository workflow machinery for about 780 repositories (ADR 0020). Lost on churn and cost.
- **Emit the catalog-mode pair only.** Cheap, but a catalog-mode node answers no modality filter, and the owner chose a stock graph-mode node. The pair falls out of the same transform and is emitted anyway (`<id>_annotated.json`, `<id>_dataset_description.json`).
- **Sidecar files in the dataset repositories.** The repositories are published and PR-only (ADR 0001), and a publicly served backend-written surface would need the anonymity blind (ADR 0065).
- **A hand-written Workers implementation of the node API.** Dropped by the owner: the node is stock, so contract conformance holds by construction.

## Receipts

- Epic #1586 and phase issue #1587; design in `.context/epic_neurobagel_federation.md`.
- `uv run scripts/neurobagel/oracle.py` runs the pinned `bagel` (pheno, bids, models, validators), the recipes graph-mode and catalog-mode loaders, an RDF expansion and the node API's own SPARQL generator over every golden; its results are in the phase 1 pull request.
- ADR 0034 (no new `datasets` column), ADR 0050 (no wasm in the Worker), ADR 0065 and ADR 0067 (anonymity), ADR 0072 (the manifest is never read whole).
