> **Historical planning note, 2026-11-20.**
> The owner decisions in [`../plan.md`](../plan.md) section 2 override it where they differ:
> one central thread venue, a 14-day extension cap, RFC-0001 covering the whole format with RFC-9 as prior art only, and RFC-0002 not pre-decided.

# Initialization specification: the biosig-zarr and `.bzx` specification repository

Prepared 2026-11-20 as a planning document.
Nothing was created, pushed, or edited outside this file.
It is the brief for a later `/project:init-project` run and the outline of the first Request for Comment (RFC) document.

Every claim carries one of two marks:

- **[V]** verified on 2026-11-20 by reading the source named beside it.
- **[I]** inferred, recommended, or recalled; not checked against a primary source.

## 1. What the grounding changed

Four findings from the reading change the shape of the task as it was posed.
Each one is an owner decision in section 13.

1. **`.bzx` is not a format of its own.**
   It is the packaged, single-file form of the `biosig-zarr` format,
   whose directory form is what the Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) already serves.
   [V: Architecture Decision Record (ADR) 0128, Consequences; `https://docs.nemar.org/formats/biosig-zarr.md`, section "The packaged form (`.bzx`)".]
   A repository for `.bzx` alone would split one specification across two homes.
2. **The license was already decided, and it is neither MIT nor Creative Commons Attribution 4.0 (CC BY 4.0).**
   The owner's decision of 2026-11-18 follows the model of the Open Microscopy Environment Next-Generation File Format (OME-NGFF) specification:
   specification text under the World Wide Web Consortium (W3C) Software and Document License;
   software, schemas, test vectors, and sample implementations under the Apache License 2.0.
   [V: ADR 0128, Consequences; neuromechanist/biosigio#179, comment "Decisions, 2026-11-18"; the pre-beta page, open question 33.]
3. **The repository was planned for beta, not for now.**
   The recorded plan: the specification stays on docs.nemar.org while pre-beta,
   and moves to a public `biosig-zarr` repository under nemarOrg at beta.
   The trigger is the first of: `.bzx` files leaving NEMAR, an outside reader starting, or nemarOrg/nemar-cli#2144 merging.
   [V: biosigio#179, same comment.]
   None of the three has happened: #2144 is open, and nothing writes or reads `.bzx`.
   [V: `gh pr view 2144` reports OPEN; `git grep -i bzx origin/dev` matches only ADR 0128 and one binary fixture; a code search of neuromechanist/biosigio for `bzx` returns 0.]
   Creating the repository now, to host the RFC, is earlier than the record says.
4. **A pre-beta specification already exists.**
   It is a published page of 852 lines, `/formats/biosig-zarr/`, source at `src/content/docs/formats/biosig-zarr.md` in the private nemarOrg/docs repository,
   with 33 open questions, six of them (25 to 30) about the packaged form.
   [V: fetched the Markdown mirror, HTTP 200; `git ls-tree` of nemarOrg/docs; nemarOrg/docs#122 is merged.]
   The new repository starts by moving that text, not by writing one.

## 2. State of the world

### Implemented and decided inside NEMAR

- `.bzx` has no implementation anywhere: no packer, no reader, no test vector. [V, as above.]
- No branch or pull request in nemarOrg/nemar-cli mentions `bzx`. [V: `git branch -r --list '*bzx*'` empty; `gh pr list --search bzx` empty.]
- biosigIO's latest release is 1.2.13 (2026-10-16); it writes the legacy tag `biosigio-zarr` with `format_version` 2. [V: GitHub releases API; nemar-cli#2217 body.]
- The rename to `biosig-zarr` (#2217) and `nemar dataset download --zarr` (#2216) are both open. [V.]
- #2216 carries two blockers:
  stores do not record the anti-alias cutoff, and the command must not ship before the `.bzx` packing rules and test vectors are frozen. [V: #2216 body.]
- #2216 states where code goes: "The packing rules and `pack`/`unpack` functions belong in biosigIO, the format's owner, with test vectors; the CLI calls them (or a TypeScript twin held to the same vectors)." [V.]
  ADR 0128, which is later and wins over an issue, restates the relationship: biosigIO is "one exemplar implementation, not its definition". [V.]
- ADR 0124 (proposed) places the reader conformance suite in `shared/contract/zarr-conformance/` of nemar-cli, copied byte for byte with a pinned digest into every other repository that holds a reader. [V: decision index.]
  That directory does not exist on `origin/dev`. [V: `git ls-tree -r origin/dev`.]
- Neither `nemarOrg/biosig-zarr` nor `nemarOrg/bzx` exists. [V: `gh repo view` cannot resolve either.]
- biosigio#179 still lists "Freeze the names: `biosig-zarr` for the format, `.bzx` for the packaged form" as an unchecked owner decision. [V.]

### External facts

- **OME-Zarr RFC-9 (zipped OME-Zarr, `.ozx`) is not accepted.**
  Its front matter reads `manual_status: R4`, which the OME process names "authors reply to reviews";
  three reviews recommended accept, minor changes, and major changes.
  [V: `rfc/9/index.md` in ome/ngff read through the GitHub API; the review table through a summarizing fetch of `https://ngff.openmicroscopy.org/rfc/9/`.]
- **RFC-9 requires little and recommends most.**
  MUST or SHALL NOT: exactly one hierarchy, archive root equals hierarchy root, no embedding in a parent hierarchy, no split archives.
  SHOULD: ZIP64, no ZIP compression, sharding, root `zarr.json` first then the other `zarr.json` entries breadth first, the `.ozx` suffix,
  and an archive comment holding the JSON `{"ome": {"version": "XX.YY"}}` in Unicode Transformation Format 8-bit (UTF-8), with an optional `zipFile.centralDirectory.jsonFirst` flag.
  [V: lines 155 to 190 of the RFC source.]
  The pre-beta page turns several of those recommendations into requirements. [V.]
- RFC-9 names a validation and test-case toolkit, `clbarnes/ozx-tck`. [V: RFC source, line 233. Its contents were not read.]
- **OME's RFC process (RFC-1)** has draft states D1 to D6, review states R1 to R9, and specification states S0 to S4,
  with authors, editors, reviewers, endorsers, and implementers;
  adoption needs two released implementations, one of them from someone who is not an author.
  [V through a summarizing fetch of `https://ngff.openmicroscopy.org/rfc/1/`; exact wording not checked line by line.]
- **How comparable specifications are laid out** [V: GitHub contents API, top level only]:
  - `ome/ngff`: `rfc/` (numbered directories 0 to 10, each with `index.md`, `reviews/`, `comments/`), `specifications/`, `LICENSE.md` stating the three-part license model above.
  - `ome/ngff-spec`: `index.md` (the text), `schemas/`, `examples/`, `tests/attributes/`, `tests/zarr/` (metadata-only hierarchies), `conformance/` (a runner that feeds cases to any implementation wrapped as a small command), `version_history.md`, `CITATION.cff`.
  - `bids-standard/bids-specification` (Brain Imaging Data Structure, BIDS): `src/` (text and a machine-readable `schema/`), `CITATION.cff`, `DECISION-MAKING.md`, `Release_Protocol.md`, `LICENSES/` with CC BY 4.0, CC BY-SA 4.0 and MIT, a `REUSE.toml`; GitHub reports CC-BY-4.0.
  - `NeurodataWithoutBorders/nwb-schema` (Neurodata Without Borders, NWB): `core/` (the schema), `docs/`, a Berkeley Software Distribution (BSD) style license from Lawrence Berkeley National Laboratory.
  - `zarr-conventions/zarr-conventions-spec`: a convention is declared by a `zarr_conventions` array in node attributes, identified by a `uuid`, a `schema_url`, or a `spec_url`; no central approval is needed; the organization holds a `template` repository.
- **Names.**
  One file-extension listing (file.org) has an entry for `.bzx` with a user-submitted opener, Radan, and no format description. [V: web search result; the listing itself was not opened.]
  BioSig is a long-standing biomedical signal library by Alois Schlögl (C, Octave and MATLAB, Python), so `biosig-zarr` can be misread as its Zarr backend. [V: web search; the collision risk is my reading.]
- `https://w3id.org/biosig-zarr` returns 404, so the path looks unclaimed. [V: one request; the w3id.org registry repository was not checked.]

## 3. Repository name and organization

**Recommendation: `nemarOrg/biosig-zarr`, public.** [I]

| Candidate | For | Against |
| --- | --- | --- |
| `nemarOrg/biosig-zarr` | The name already recorded in ADR 0128 and biosigio#179; covers both forms; matches the format tag | Possible confusion with the BioSig library |
| `nemarOrg/bzx` | Short; matches the file suffix | Names the packaging, not the format; orphans the directory form |
| `nemarOrg/biosig-zarr-spec` | Says "specification" in the name | Diverges from the recorded name; the suffix adds little |

Organization: nemarOrg, per the recorded decision.
An organization of its own comes only when a second institution co-maintains. [V: ADR 0128.]
The repository name must not appear in any permanent identifier (section 6).

## 4. Purpose and non-goals

**Purpose.**

- Hold the normative text of biosig-zarr: the directory form and the packaged form (`.bzx`).
- Hold the JSON Schema documents for every attribute object.
- Hold the conformance suite: small real stores, packaged files, invalid cases, and expected results.
- Hold the RFC documents and the record of comments on them.
- Publish tagged releases that every implementation and the documentation site pin.

**Non-goals.**

- No reader or writer library lives here (section 8).
- No NEMAR profile: the `nemar` provenance block, `index.json`, `events.parquet`, and the serving rules stay on docs.nemar.org as the Store Contract. [V: the pre-beta page calls them a profile with its own document.]
- No sidecar rewrite rules: rewriting `SamplingFrequency` and the other rate-dependent fields is behavior of `nemar dataset download --zarr` (#2216), defined in nemar-cli's `shared/contract/`.
  The format holds one recording and has no notion of a dataset. [V: page, "Scope and non-goals"; placing the rewrite outside the specification is I.]
- No NWB or OME-Zarr data model, and no conversion code. [V: ADR 0128.]
- No large data: example recordings are short crops (section 5).

## 5. Directory layout

```
biosig-zarr/
  README.md                  what the format is, status, how to comment, where implementations live
  LICENSE.md                 the three-part statement (text, software and schemas, contributions)
  LICENSES/                  full license texts, one file per license
  CITATION.cff
  CHANGELOG.md               one entry per tagged release, normative changes separated from editorial
  CONTRIBUTING.md            the one-page change process (beta criterion 4 of biosigio#179)
  GOVERNANCE.md              editor, decision rule, how an RFC is accepted
  CODE_OF_CONDUCT.md
  AGENTS.md, CLAUDE.md       from init-project
  .rules/ .context/ .memory/ from init-project (.context/decisions/ holds this repository's ADRs)
  spec/
    index.md                 the specification, single document, plain Markdown
    version-history.md       what changed in the format per format_version and per release
  rfc/
    README.md                the RFC process and the index of RFCs with status
    0000-template.md
    0001-bzx-packaged-form/
      index.md
      comments/              one file per written comment received outside GitHub
      responses/
  schemas/
    v2/                      one directory per format_version; file names are stable
      root.schema.json
      channel-group.schema.json
      level0-array.schema.json
      view-array.schema.json
      events.schema.json
      bzx-comment.schema.json
  conformance/
    README.md                levels, how to run, how to wrap an implementation
    manifest.json            every vector: path, class, expected outcome, rule cited, SHA-256
    stores/valid/            directory-form stores cropped from real recordings
    stores/invalid/          each violates exactly one MUST
    bzx/valid/
    bzx/invalid/
    goldens/                 expected decoded values and digests per valid vector
    SOURCES.md               provenance and license of every source recording
    runner/                  small Python runner (uv), wraps any implementation as a command
  examples/                  informative: attribute documents shown in the text, kept valid by CI
  tools/                     build and check scripts (schema checks, example extraction, vector regeneration)
  .github/workflows/
```

Notes on the layout:

- **One specification document, plain Markdown.**
  The current page uses Starlight asides (`:::caution`) and site-relative links (`/platform/zarr/...`). [V.]
  Both must be rewritten when the text moves, so the file renders on GitHub and on any site. [I]
- **Real example files, not invented ones.**
  Valid vectors are crops of a few seconds from real recordings under a public-domain dedication (CC0), written by a released writer, with subject information excluded. [I]
  Target: under about 1 MB per vector and under about 20 MB in total, so plain Git suffices. [I]
  Invalid vectors are valid files altered in one controlled way by a recorded script, so a failure is attributable to one rule. [I]
- **Vectors cover the hard cases named in the page's open questions**:
  both format names, a version 1 store, `float32`, more than one channel group, zero events, a non-integer source rate, replaced non-finite samples, and for `.bzx` an archive over the 65,535-entry limit that forces real ZIP64 records. [I]
- **`manifest.json` is the contract** between this repository and every copy vendored elsewhere, which fits the "copied byte for byte, with a pinned digest" rule of ADR 0124. [V for the ADR; the fit is I.]

## 6. Versioning policy

Four things carry versions, and they must not be conflated. [I, except where marked]

| Thing | Scheme | Who bumps it |
| --- | --- | --- |
| `format_version` in a store | Integer, now 2; rises only when a conforming reader would return wrong data or none [V: page] | A normative change accepted through an RFC |
| Specification release | `<format_version>.<minor>.<patch>` Git tag; minor for additive normative text, patch for editorial; pre-release suffixes `-draft.N` and `-beta.N` | The editor, at release |
| Schemas | Directory per `format_version`; a published tag is immutable; `$id` contains the release | Same release as the text |
| RFC documents | Sequential four-digit number; immutable once accepted, superseded by a later RFC, never edited | The editor |

- The first tag is `2.0.0-draft.1`: the text as moved from docs.nemar.org, with nothing changed but syntax.
- Beta is the five criteria already written in biosigio#179 ("What beta means"). [V.]
- Whether the packaged form carries its own version, separate from `format_version`, is a question for RFC-0001 (section 12).
- Permanent identifiers do not name GitHub or the organization:
  `https://w3id.org/biosig-zarr/` for the text, `/schemas/<release>/...` for schemas, `/rfc/0001` for the RFC. [V: the requirement is in biosigio#179; the w3id.org choice is "for example" there.]
- A Zarr convention is identified by a `uuid` first, so the identifier in every store can be minted before any address is final. [V: zarr-conventions-spec README.]
  This matters because the rename migration (#2217) rewrites every root `zarr.json` once, and additive attributes should ride along with it. [V: biosigio#179 lists that decision as open.]

## 7. License

**Recommendation: keep the decision of 2026-11-18 and do not reopen it.** [I]

- Text: W3C Software and Document License. Schemas, vectors, runner, tools: Apache License 2.0. [V: decided.]
- The MIT norm for new nemarOrg tooling does not apply here: an ADR recorded a different choice for this repository, and an ADR wins over a convention.
  Apache 2.0 also carries an explicit patent grant, which MIT lacks and which matters more for a format than for a tool. [I]
- CC BY 4.0, which BIDS uses [V], would be the natural alternative for the text.
  It is better known to researchers; the W3C license is permissive, allows derivative works, and is what the nearest neighbor (OME-NGFF) uses, so RFC-9 text can be quoted without a license mismatch. [I]
- **Still open: how contributions are licensed.**
  OME-NGFF uses the W3C contributor agreement, which applies only inside a W3C community group. [V: biosigio#179.]
  Recommendation: a Developer Certificate of Origin (DCO) sign-off plus an "inbound equals outbound" sentence in `CONTRIBUTING.md`; no contributor license agreement to administer. [I]
- **A conflict to resolve when the text moves.**
  nemarOrg/docs is licensed CC BY-NC-ND 4.0 [V: its `LICENSE`], and the specification page lives there today.
  A non-commercial, no-derivatives license contradicts the decided license for the text.
  The page needs an explicit per-page license notice, and the canonical copy needs to live in the new repository. [I]
- Vectors cropped from real recordings keep the source dataset's license; use only CC0 sources and record each in `conformance/SOURCES.md`. [I]

## 8. Where the reference reader and writer live

**Recommendation: none in this repository.** [I]

| Piece | Home | Why |
| --- | --- | --- |
| Normative text, schemas, vectors, expected results, a runner | `biosig-zarr` | The definition must be implementable from the document alone (biosigio#179 goal) |
| Python `pack`, `unpack`, in-place read, validator | neuromechanist/biosigio | It holds the format constant, the only writer, and a reader; #2216 and biosigio#179 already assign this work there [V] |
| TypeScript reading of `.bzx` | nemar-cli read core, as a zip-backed `Fetcher` (#2144) | The core does all input and output through `Fetcher`; stored entries make an in-entry range a file range [V: #2216 comment] |
| Converter (source recording to store) | nemar-cli `scripts/zarr/` calling biosigIO | ADR 0029: the conversion engine lives with the command-line tool [V] |

Reasons:

- ADR 0128 says biosigIO is an exemplar, not the definition. A library inside the specification repository would become the definition in practice. [V for the ADR; I for the consequence.]
- Beta requires two readers that share no code, one of them written against the text. [V: biosigio#179.] Python in biosigIO and TypeScript in nemar-cli are that pair, and they are forced to agree only through the vectors.
- nemar-cli is licensed CC BY-NC-ND [V: user memory note, not rechecked], so reference code there could not be reused by others; biosigIO is BSD 3-Clause. [V: GitHub API.]

**A seam this creates.**
ADR 0124 puts the canonical conformance suite in nemar-cli.
If the canonical vectors live in `biosig-zarr`, nemar-cli becomes one of the repositories that vendors them with a pinned digest.
ADR 0124 is still proposed, so it can be amended at no migration cost now. [I]
The NEMAR-specific cases (the `nemar` block, the store content digest of ADR 0123) stay in nemar-cli as the profile's suite. [I]

## 9. The docs.nemar.org page

Facts: the site is Astro Starlight, built with Bun from the private nemarOrg/docs repository;
the sidebar has a group "Formats (pre-beta)" with one entry, slug `formats/biosig-zarr`, carrying a "Pre-beta" badge. [V: `astro.config.mjs`, `package.json`.]
How the docs build could ingest outside content was not investigated. [I]

**Recommendation: one canonical text, pinned by tag, rendered at the existing address.** [I]

1. `spec/index.md` in `biosig-zarr` becomes the only editable copy.
2. A build step in nemarOrg/docs fetches that file at a pinned release tag, verifies its SHA-256, and writes the page; the pin is one line, bumped by a pull request.
   A hand-kept copy is rejected: two copies drift, which is the reason ADR 0057 exists. [V: `.rules/docs-site.md`.]
3. The address `/formats/biosig-zarr/` and its `.md` mirror stay as they are, so existing links hold.
4. Add `/formats/biosig-zarr/rfc-0001/` rendered the same way, and a short "How to comment" page that sends readers to the repository.
5. The NEMAR profile pages (Store Contract, Format Stability) stay native to docs.nemar.org and link to the pinned release they conform to.
6. `w3id.org/biosig-zarr` redirects to the docs.nemar.org page for now, and can be repointed later without breaking a link.

Rejected alternatives: a separate site built from the new repository (a second site to maintain, and the request was for a docs.nemar.org page);
a link-only stub on docs.nemar.org (loses the Markdown mirror and `llms.txt` indexing that agents use).

## 10. Continuous integration (CI)

Tooling is fixed: Bun and Biome for JavaScript, TypeScript, and JSON; uv, Ruff, and ty for Python; never npm, npx, pip, or conda. [V: user and project instructions.]

| Workflow | Runs when these paths change | What it checks |
| --- | --- | --- |
| `text.yml` | `spec/**`, `rfc/**`, `*.md` | Spelling (`typos`), links, every JSON block in the text extracted and validated against the schemas, no abbreviation used before its definition (a script), semantic line breaks |
| `schemas.yml` | `schemas/**`, `examples/**` | Biome format and lint on JSON; each schema valid against its meta-schema; every example valid; `$id` matches the path |
| `conformance.yml` | `conformance/**`, `tools/**` | Ruff, ty, pytest; `manifest.json` digests match the files; valid vectors open with stock zarr-python and no other code; the pinned biosigIO release passes the suite; each invalid vector is refused for the rule the manifest cites |
| `release.yml` | a tag `[0-9]+.*` | Assembles text, schemas, and vectors into one archive with a digest file; creates the GitHub Release |

Shared rules: triggers on pull requests and pushes to `main` only; `concurrency` cancels superseded pull-request runs; every job has `timeout-minutes`. [V: user instructions.]

Two template defaults are wrong for this repository and must be changed during initialization:

- The template `test.yml` has `paths-ignore: ['**.md', 'docs/**', ...]`. [V: template file.]
  Here the Markdown is the product, so text changes must run `text.yml`.
- The template triggers on `main` and `develop`. [V.]
  A specification repository needs one integration branch, `main`, with tags as releases. [I]

A check with no way to fail proves nothing:
before the conformance job is trusted, turn each rule off in the implementation under test and confirm the matching invalid vector then passes wrongly. [I, from the owner's recorded testing lessons.]

## 11. Which init-project outputs to use

Source: `~/.claude/plugins/cache/research-skills/project/0.14.2/` (command `commands/init-project.md`, skill `skills/init-project/SKILL.md`, script `scripts/project-init-templates`). [V: all three read.]

| Output | Verdict | Adaptation |
| --- | --- | --- |
| `AGENTS.md` | Use | Hard rules only: published tags and accepted RFCs are immutable; no library code; vectors are real and CC0; normative change needs an RFC; one text, pinned elsewhere |
| `CLAUDE.md` | Use as is | `@AGENTS.md` only |
| `.rules/git.md`, `code_review.md`, `self_improve.md` | Use | Single `main` branch; atomic commits; at most two review rounds |
| `.rules/testing.md` | Use, adapt | "No mocks" becomes "vectors come from real recordings; invalid cases are altered real files" |
| `.rules/documentation.md` | Rewrite | The template is about MkDocs; replace with the specification style: RFC 2119 key words, CONDITIONAL, semantic line breaks, abbreviations defined once, American English |
| `.rules/python.md` | Keep | Applies to `conformance/runner/` and `tools/` only |
| `.rules/ci_cd.md` | Use, adapt | Section 10 |
| `.rules/lsp.md` | Drop | Too little code to need it |
| `.context/plan.md`, `ideas.md`, `research.md`, `scratch_history.md` | Use | Seed `plan.md` with the beta criteria; seed `research.md` with section 2 of this file |
| `.context/decisions/` | Use | First ADRs: license and contribution terms; no library here; vectors canonical here; identifiers; versioning. Each cites ADR 0128 by content |
| `.memory/` | Use | Empty at the start |
| Ruff pre-commit hook | Use | Python exists (runner, tools) |
| `config/pyproject.toml`, `pytest.ini` | Use as reference | uv project scoped to `conformance/runner/` |
| `config/mkdocs.yml`, `workflows/docs.yml` | Skip | The page is built by nemarOrg/docs |
| `workflows/test.yml` | Replace | The three path-filtered workflows of section 10 |
| `workflows/release.yml` | Adapt | Tag-driven release of text, schemas, vectors; no package registry |
| Cursor templates | Skip | |
| GitHub labels (after the first push, on request) | Use, extend | Add `rfc`, `normative`, `editorial`, `schema`, `vectors`, `packaged-form`, `directory-form` |

Not produced by init-project, to add by hand in the same run:
`LICENSE.md`, `LICENSES/`, `CITATION.cff`, `CHANGELOG.md`, `CONTRIBUTING.md`, `GOVERNANCE.md`, `CODE_OF_CONDUCT.md`, issue templates ("RFC comment", "defect in the text", "question"), and GitHub Discussions switched on. [V: the script copies none of these.]

Suggested argument for the run:
"Specification repository for biosig-zarr, a Zarr version 3 layout for one biosignal recording, and its single-file packaged form `.bzx`: normative text, JSON Schemas, conformance vectors, and RFC documents. No reader or writer library."

Order of work on the day: create the repository empty; run init-project; add the hand-made files; move the text and tag `2.0.0-draft.1`; add schemas and the first vectors; add RFC-0001 as a draft; only then announce.

## 12. Outline of RFC-0001: the `.bzx` packaged form

Proposed process, a small version of OME's RFC-1: Draft, Open for comment (a fixed window, six weeks suggested), Revised (a written response to every comment), then Accepted or Withdrawn.
The owner is editor; acceptance needs two implementations that share no code and pass the vectors. [I]

### Sections

1. **Header.** Number, title, authors, editor, status, dates, the specification release it amends, the comment deadline.
2. **Summary.** One paragraph: one recording, one file, a ZIP archive of a biosig-zarr store, readable in place.
3. **Motivation.** Thousands of chunk objects per recording on a researcher's disk; a store stands in for a data file, so it should be one file.
4. **Background.** The directory form in one page, with a link to the full text; what a store is and is not; why not NWB or OME-Zarr, quoted from ADR 0128.
5. **Terminology and key words.**
6. **Specification of the packaged form.**
   Archive contents; root placement and entry order; stored entries and the byte-range property; ZIP64; the archive comment; no nesting; written once; file naming; what is never inside.
7. **Relation to OME-Zarr RFC-9.**
   A table of every RFC-9 rule against this document: adopted as is, strengthened from SHOULD to MUST, changed, or not adopted;
   a statement of RFC-9's status on the day of publication and what happens if RFC-9 changes afterward.
8. **Reading a `.bzx`.** Locating the central directory; mapping a chunk to a file range; local and Hypertext Transfer Protocol (HTTP) range reads; what stock zarr-python can do.
9. **Identification.** Suffix, archive comment, media type.
10. **Integrity.** What the shard index checksum covers and what nothing covers.
11. **Security.** Entry names that escape the store, duplicate names, encrypted entries, overlapping or oversized entries, lenient readers.
12. **Privacy.** A `.bzx` holds exactly what the store holds; subject-information exclusion; no free-text annotations.
13. **Conformance.** The packaging writer class, the packaged-form reader capability, the vectors and how to run them.
14. **Implementations.** Status of each, honestly: none on the day the RFC opens unless that has changed.
15. **Compatibility.** With the directory form (byte identical entries), with generic ZIP tools, with a generic RFC-9 reader.
16. **Drawbacks.**
17. **Alternatives considered.** A plain `.zarr.zip`; reusing `.ozx`; tar; Hierarchical Data Format 5 (HDF5); SQLite; one shard per array with no archive; waiting for a Zarr-level zip store specification.
18. **Out of scope for comment** (below).
19. **Questions for the community** (below).
20. **How to comment, and the timeline.**

### Decided, and therefore out of scope for comment

Each item cites its record, so a commenter can see it is closed and why.

- A store is not an NWB container and will not be made NWB-conformant; any NWB output is a stateless export. [V: ADR 0128, Decision.]
- The OME-Zarr data model is not adopted; only RFC-9's packing approach is. [V: ADR 0128, Context and Consequences.]
- One package holds one recording. It is an alternative to a data file, not to a dataset. [V: ADR 0128.]
- The events group stays light (onset, duration, code, label map). Full events stay in the dataset's `events.tsv`; `events.parquet` is never packed. [V: ADR 0128; the page.]
- No participant or session fields, no verbatim sidecar JSON, no NWB-shaped block inside a store. [V: ADR 0128.]
- The store is derived and lossy by design (rate caps, 16-bit integers with per-channel scale and offset, channels-first arrays); the source recording stays authoritative. [V.]
- Entries are stored without ZIP compression, and each is byte identical to the directory-form object. [V: #2216; the page.]
- A package is written once and never edited in place. [V: #2216; the page.]
- NEMAR builds packages on the researcher's machine and stores none server side; the sidecar rewrite belongs to the NEMAR download command, not to the format. [V: #2216.]
- License model and the nemarOrg home. [V: biosigio#179.]

The layout of the directory form (`format_version` 2) is also not the subject of RFC-0001:
it is what more than 900 live datasets already carry [V for the count only as recorded in the owner's memory notes], and it has its own 24 open questions on the page.
Comments on it are welcome as issues, and belong to a later RFC.

### Questions to ask the community

Grouped as they would appear; numbers in brackets are the open questions on the pre-beta page. [V for the bracketed sources; the remaining questions are I.]

**Names and identification**

1. Does `.bzx` collide with anything you use? One listing associates it with other software. [30]
2. Should a media type be registered, and which one? [30]
3. Is `biosig-zarr` likely to be confused with the BioSig library, and does that matter?

**The archive comment**

4. Encoding and shape: should it mirror RFC-9, a UTF-8 JSON object under one top-level key holding the version? [26]
5. Should it also carry RFC-9's `jsonFirst` flag, or is the ordering simply required?
6. Should the packaged form have a version of its own, separate from `format_version`?

**Entry order and reproducible bytes**

7. Should all `zarr.json` entries precede chunk entries in breadth-first order, as RFC-9 recommends? [27]
8. Should entry order after that, entry timestamps, and external attributes be fixed, so that two tools packing one store produce identical bytes? [28]
9. Should data descriptors (streamed writing) and directory entries be forbidden?
10. Should entry data be aligned to a block boundary for memory-mapped and direct reads?

**Strictness**

11. This proposal requires what RFC-9 only recommends (ZIP64 always, root entry first, stored entries). Does that lock out a tool you rely on?
12. Should a reader refuse a nonconforming archive or read it leniently? The draft says SHOULD refuse.
13. Should encrypted entries be forbidden outright? [29]
14. May an archive hold entries that are not part of the store, such as a digest manifest or a license file?

**Integrity**

15. Is a whole-file checksum, a per-entry digest manifest, or a signature needed before `.bzx` files circulate? Where should it live? [24]

**Compatibility and reach**

16. Should a `.bzx` remain openable by a generic RFC-9 reader, and should this document track RFC-9 if it changes before acceptance?
17. View levels are not sharded, so a long recording has many entries. Is the entry count a problem for your reader? [I: derived from the hierarchy table on the page]
18. Do you need to read a remote `.bzx` over HTTP ranges, or only local files?
19. What would stop you from writing a reader in your language or tool, and which vectors are missing?
20. Would you implement it, and by when? (OME's process counts implementer statements as endorsements.)

## 13. Open decisions for the owner

1. **Scope and name.** One repository for the whole format, `nemarOrg/biosig-zarr`, with `.bzx` as its first RFC (recommended), or a `.bzx`-only repository.
2. **Timing.** Create the repository now, ahead of the recorded "at beta" trigger. If yes, amend the record in biosigio#179 and say why.
3. **Freeze the names** before the RFC opens, or put the suffix up for comment. Publishing the RFC is the last cheap moment to change `.bzx`.
4. **License.** Confirm the W3C and Apache 2.0 decision stands over the MIT norm and the CC BY 4.0 alternative; choose the contribution terms (DCO recommended).
5. **Canonical home of the vectors.** Here, with nemar-cli vendoring them, which amends proposed ADR 0124; or in nemar-cli, with this repository vendoring.
6. **RFC-0001 scope.** The packaged form only (recommended), or the whole format including the directory form.
7. **Can the RFC open with no implementation?** #2216 says the command must not ship before the rules are frozen; an RFC with at least a prototype packer and three vectors would be far easier to comment on.
8. **Convention identifier and the rename.** Mint the Zarr convention `uuid` now so #2217's single migration can write it, or accept a second pass later.
9. **Permanent identifier.** Register `w3id.org/biosig-zarr` (a pull request to an outside registry), or another scheme.
10. **Documentation mechanics.** Build-time fetch of a pinned tag into nemarOrg/docs (recommended), and a per-page license notice that overrides that repository's CC BY-NC-ND.
11. **Citable releases.** Whether tagged releases get a Digital Object Identifier, and through which registrar.
12. **Comment venue and window.** GitHub Discussions and issues for six weeks, and whether to notify the RFC-9 authors and the Zarr community directly.

## 14. Not checked

- The docs repository's build scripts, and whether a build-time fetch fits its admin-gating and link checks.
- The w3id.org registry itself; only one request to the path was made.
- The contents of `ozx-tck`, and whether its cases can be reused under a compatible license.
- The file.org listing for `.bzx` beyond the search result.
- The body of ADRs 0023, 0027, 0029, 0030, and 0033; only their index lines were read, and none bears on the repository design beyond ADR 0029.
- The two OME pages were read through a summarizing fetch, except the RFC-9 front matter and normative lines, which were read from source.
