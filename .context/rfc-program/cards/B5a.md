# Card B5a: Version 2 schemas and vectors on main, for 2.0.1

Status: ready
Tier: lead
Timebox: M, 2 days; escalate at 3 days or two failed approaches
Needs: none
Depends: B2 merged and O4 done (`main` holds the `2.0.0` text); Q9, Q10 and Q33 answered (owner, 2026-11-20)
Branch: feature/b5a-v2-schemas-vectors (base `main`)
Worktree: /Users/yahya/Documents/git/nemar/biosig-zarr-worktrees/b5a
Plan: /Users/yahya/Documents/git/nemar/nemar-cli-worktrees/rfc-program/.context/rfc-program/plan.md, sections 3, 4 and 5 (O4d)

## Goal

nemarOrg/biosig-zarr's `main` holds JavaScript Object Notation (JSON) Schemas for format version 2 and the first conformance vectors, cut from one real CC0 recording and written by biosigIO 1.2.13,
with the suite's layout, manifest and checks that card B5 then extends for version 3,
ready to be released as `2.0.1` (step O4d).

## Context

Owner answers this card is built on (2026-11-20, `board-log.md` Decisions):
Q9, the conformance test files live in nemarOrg/biosig-zarr and nemar-cli vendors them by digest;
Q10, RFC-0001 opens with text plus schemas and a few real vectors, and no packer;
**Q33, the owner's ruling as editor: the version 2 schemas and vectors transcribe the `2.0.0` text and are editorial, so they go on `main` and are released as `2.0.1`; the version 3 schemas and vectors go on `draft/3.0.0` (card B5).**
`GOVERNANCE.md` says any change to a JSON Schema is normative, and lets the editor decide what is normative; this card does not change `GOVERNANCE.md`, and records the ruling in `CHANGELOG.md` and `conformance/README.md` instead (the editor ruled, on 2026-11-20, that these first version 2 schemas, which add no requirement to the `2.0.0` text, are editorial).
The owner allows Opus at xhigh effort, or Fable at high effort, to write contracts and specifications; schemas are contracts, so this card is lead tier.

Read first, in full:
`spec/index.md` on `origin/main` (tag `2.0.0`; it is the definition, and the schemas transcribe it);
`AGENTS.md`, `GOVERNANCE.md`, `LICENSE.md`, `CONTRIBUTING.md`, `.gitignore`, `biome.json`, `_typos.toml`, `package.json` and `.github/workflows/text.yml` in biosig-zarr;
then `/Users/yahya/Documents/git/nemar/nemar-cli-worktrees/rfc-program/.context/rfc-program/research/biosig-zarr-repo.md` sections 5, 6 and 10, as background only (its `rfc/` directory, its tag `2.0.0-draft.1`, its `.bzx` vectors, runner and `release.yml` are overruled or out of scope).
Create the worktree with
`git -C /Users/yahya/Documents/git/nemar/biosig-zarr fetch origin && git -C /Users/yahya/Documents/git/nemar/biosig-zarr worktree add /Users/yahya/Documents/git/nemar/biosig-zarr-worktrees/b5a -b feature/b5a-v2-schemas-vectors origin/main`,
then `bun install`.
Every commit is signed off (`git commit -s`, Developer Certificate of Origin, Q8).
Install the local Ruff pre-commit hook from `/Users/yahya/Documents/git/rule_templates/shared/config/pre-commit` into this worktree's Git hooks, because this card adds the repository's first Python.

## Scope

All on the branch, in nemarOrg/biosig-zarr:

- `schemas/v2/`: one schema per attribute document.
- `conformance/`: `README.md`, `manifest.json`, `SOURCES.md`, `stores/v2/` (the vectors) and `goldens/`.
- `tools/check-schemas.ts`, and `tools/vectors/` (the build script, `test_vectors.py`, and its `pyproject.toml`).
- `package.json` (scripts and the JSON Schema validator dependency), `bun.lock`, `biome.json` and `_typos.toml` (exclusions for vector files only).
- `.gitignore`: add `.venv/`, `__pycache__/`, `.pytest_cache/`, `.ruff_cache/` and `tools/vectors/.venv/`.
- `.github/workflows/conformance.yml`.
- `CHANGELOG.md`: one entry for `2.0.1`, which states the editor's ruling.

Nothing else: `spec/index.md` and `GOVERNANCE.md` are not changed; no `.bzx` schema or vector.

## Decided design

**Schemas.**
Settled: JSON Schema draft 2020-12; one file per attribute document of version 2, named for it: `root`, `uniform-group` (the channel group), `level0-array`, `view-array` and `events-group`.
`$id` is `https://w3id.org/biosig-zarr/schemas/v2/NAME.schema.json` and matches the file's path.
A schema transcribes the `2.0.0` text and adds nothing: a constraint the text does not state is not in a schema, and every `required`, `enum`, `const` and `pattern` carries a `$comment` naming the spec heading it comes from.
Attributes the text lists as possibly absent in a version 2 store ("What changes the version") are not `required`.
Unknown attributes are allowed (no `additionalProperties: false` on attribute documents), because the text says a reader MUST ignore attributes it does not recognize.
The NEMAR profile's attributes are not in the format schemas.

**The source.**
Settled: every vector is cut from one real recording dedicated to the public domain:
nemar `on009081` version `v1.0.0` (OpenNeuro `ds009081`, license CC0), file `sub-01/eeg/sub-01_task-rest_eeg.edf` (224,464 bytes, 100 hertz (Hz), European Data Format (EDF)),
read only, from `https://data.nemar.org/on009081/v1.0.0/sub-01/eeg/sub-01_task-rest_eeg.edf`, with a named User-Agent.
Record in `conformance/SOURCES.md` the dataset, version, path, the source file's SHA-256, its license, the channels and seconds kept, and every step applied, including each alteration made to an invalid vector.
If that file is unavailable, differs in size, or is not CC0 when you read it, stop; do not substitute a recording on your own.
B5 reuses the same crop, so keep the crop step in `tools/vectors/` reproducible.

**How the vectors are made.**
Settled: `v2-legacy-name` is written by biosigIO 1.2.13 from the crop (`uvx --from biosigio==1.2.13`, subject-information exclusion on) and is byte-identical to that writer's output.
Every other vector is that store altered in one controlled, recorded way, by `tools/vectors/`, which edits metadata documents only.
`tools/vectors/` is a one-purpose vector builder, not a library: it exports nothing, and nothing outside `tools/` imports it.
Keep every vector small: a few channels and a few seconds; the whole of `conformance/` stays under 10 megabytes (MB), leaving room for B5.

**The minimum set**, by `id` (the implementer may add a vector, never drop one), with outcomes for a reader of the `2.0.0` text:

| `id` | What it is | Expected outcome for a version 2 reader |
| --- | --- | --- |
| `v2-legacy-name` | biosigIO 1.2.13 store, `format` `biosigio-zarr`, `format_version` 2, zero events | accepted, with goldens |
| `v2-new-name` | the same with `format` `biosig-zarr` | accepted, identical to `v2-legacy-name` ("Format name": both names, treated identically) |
| `v2-version-3` | the same with `format_version` 3 | refused ("Format version": greater than the highest version the reader implements) |
| `v2-unknown-format` | the same with `format` `example-zarr` | refused |
| `v2-no-channel-groups` | the same without `channel_groups` | fails `schemas/v2/root` |

**The manifest.**
Settled: `conformance/manifest.json` is a JSON object whose top-level member `vectors` is an array; each element has `id`, `path`, `format_version`, `class` (`valid` or `invalid`), `layer` (the reader-safety layer, 1 to 4, that the vector tests for the newest reader the manifest has outcomes for, or null; at `2.0.1` the newest reader is version 2, which has no layers, so every entry here is null, and card B5 sets it for version 3, `v2-version-3` included), `rule` (the spec heading's anchor), `expect`, and `files` (the SHA-256 of every file in the vector).
`expect` is an object keyed by the format version of the reader the outcome is for: this card writes key `"2"` only; card B5 adds key `"3"` to every entry, because a version 3 reader reads version 2 stores with defaults.
The manifest is the contract that copies elsewhere pin by digest (Q9).

**The checks.**
Settled:
`tools/check-schemas.ts` (`bun run check:schemas`) compiles every schema under draft 2020-12 in strict mode, checks each `$id` against its path, validates every attribute document of every `valid` vector, and confirms each schema-invalid vector fails at the path its manifest entry cites.
`tools/vectors/test_vectors.py` (pytest, under uv) opens every valid vector with stock zarr-python and no other code, dequantizes with the text's formula, compares the values with `goldens/`, and recomputes every digest in the manifest.

**Continuous integration.**
Settled: one new workflow, `.github/workflows/conformance.yml`, not a separate `schemas.yml`:
two jobs, `schemas` (`bun run check:schemas`, and `bun test` once B5 adds Bun tests) and `vectors` (Ruff, ty and pytest under uv), each with `timeout-minutes`,
on pull requests and on pushes to `main`, path-filtered to `schemas/**`, `conformance/**`, `tools/**` and the workflow itself, with the same `concurrency` rule as `text.yml`, and actions pinned by commit as `text.yml` pins them.
`text.yml` keeps running as it is; `biome.json` and `_typos.toml` exclude `conformance/stores/**`, so a writer's own JSON formatting is never rewritten.

The implementer may choose: the channels and seconds kept, the JSON Schema validator package, the layout inside `tools/vectors/`, the wording of `conformance/README.md`, and any vector added beyond the minimum set.

## Acceptance

From the worktree root:
`bun run check:schemas` exits 0.
`uv run --project tools/vectors pytest tools/vectors -q` exits 0.
`bun -e 'const m=await Bun.file("conformance/manifest.json").json(); if (!Array.isArray(m.vectors)) throw new Error("vectors is not an array"); for (const id of ["v2-legacy-name","v2-new-name","v2-version-3","v2-unknown-format","v2-no-channel-groups"]) if (!m.vectors.some(v=>v.id===id && v.layer===null && v.expect && "2" in v.expect)) throw new Error("missing "+id)'` exits 0.
`ls schemas/v2` lists `root.schema.json`, `uniform-group.schema.json`, `level0-array.schema.json`, `view-array.schema.json` and `events-group.schema.json`.
`test "$(du -sk conformance | cut -f1)" -lt 10240` exits 0.
`grep -c "CC0" conformance/SOURCES.md` and `grep -c "on009081" conformance/SOURCES.md` each print at least 1, and `grep -c "2.0.1" CHANGELOG.md` prints at least 1.
`git diff --name-only origin/main...HEAD` lists only paths in Scope, and `git diff --name-only origin/main...HEAD | grep -c "^spec/"` prints 0.
`test "$(git rev-list --count origin/main..HEAD)" = "$(git log --format=%B origin/main..HEAD | grep -c '^Signed-off-by:')"` exits 0.
`gh pr checks --repo nemarOrg/biosig-zarr` on the PR shows `schemas`, `vectors`, `spelling`, `links` and `lint` passing on its head.

## Gates

`uvx typos . && bun install && bun run lint && bun run check:schemas && uvx ruff check tools && uvx ruff format --check tools && uv run --project tools/vectors pytest tools/vectors -q`, all exiting 0, plus the Acceptance commands as stated.

## Stop conditions

The source file is unavailable, differs from the size above, or is not CC0;
writing a schema shows that the `2.0.0` text is ambiguous or contradicts itself (report the lines and the two readings; do not choose);
a schema would have to add a requirement the `2.0.0` text does not state (that would be normative, outside the owner's ruling);
biosigIO 1.2.13 cannot be run with uv, or its output cannot be kept byte-identical;
`conformance/` cannot be kept under 10 MB.

## Report

Your final message is the report, at most 25 lines: PR number (base `main` of nemarOrg/biosig-zarr) and head commit hash; gates run with their quoted last lines; the vectors made, by `id`; the schema files; each place where transcribing the text needed a judgment, with line numbers; deviations from this card; questions for the lead; patch notes for other owners (the release of step O4d, and what card B5 must merge in).
