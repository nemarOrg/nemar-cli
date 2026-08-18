# Draft policy: bare-minimum requirements for dataset submission (issue #817)

**Status:** draft for human review, prepared 2026-08-10.
Nothing here has been posted to GitHub and no code was changed.
Full sentences; abbreviations defined on first use in the source analysis below.

## 1. What issue #817 already proposes

The issue body (2026-06-20, labels `enhancement`, `P1`, `feature`, `backend`) proposes a two-tier policy plus an exemption,
calibrated against a scan of 1,777 public OpenNeuro datasets, of which 577 are in NEMAR's modality scope
(EEG 428, iEEG 70, MEG 59, NIRS 26, motion 1).

**Tier A, hard requirements blocking publication for native submissions:**
BIDS validation passes (already enforced);
README present and substantive (~200+ characters of real content);
a license declared as a recognizable license or SPDX identifier, not blank/`n/a`/`none`;
Dataset Name is a descriptive title of at least 25 characters, not a placeholder, not equal to the dataset id, not a bare author-year string.

**Tier B, strong flags that never block:**
missing IRB/ethics information (no `EthicsApprovals` and no README ethics statement),
written into `.nemar/metadata.json` as a `flags` object and rendered as a website badge; extensible to future flags.

**Exemption:** OpenNeuro imports skip Tier A (else ~10-30% of the corpus desk-rejects) but still get Tier B flags.

**Measured prevalence (from the issue's scan of 577 in-scope datasets):**
missing/stub README 10.2%; missing license 0.2%; missing IRB/ethics 68.6%; names under 25 chars 29.5%; fully clean 27.6%.

**Name checks are LLM-judged, not regex-gated** (ADR 0014,
`.context/decisions/0014-submission-minimums-are-llm-judged-not-regex-gated.md`):
a regex flags ~28 names but ~22 are legitimate acronyms (`MEGMEM`, `MAVIS`, `PRIOS`, `Chisco`, `STReEF`, `TX14`);
genuinely bad names are rare and varied (blank, name==id, `Siefert2024`, `DataSet1`, `what_are_we_talking_about`).
Measured ~3:1 false-positive rate is why the regex hard gate was rejected.

**Operational notes from the issue comments (2026-06-21):**
every prescreen callback 400'd for a period because the workflow sent `issue_url: null` (fixed; server now accepts null, PR #825);
16 MOABB datasets had boilerplate READMEs and placeholder authors (`["[Unspecified1]", "[Unspecified2]"]` in nm000273).
Two policy-relevant lessons: boilerplate-but-long READMEs pass a pure length threshold,
and placeholder author strings are a real failure mode nothing catches today.

## 2. What exists today (citations verified 2026-08-10)

- **Browser pre-check** `website/src/lib/bids-precheck.ts` (wired at `upload.astro:489,:504`).
  Hard errors: empty drop, `..` traversal (:99), path >1024 chars (:107), file >5 GB (:115), total >50 GB (:176),
  no `dataset_description.json` (:183), no `sub-*` (:190), no recognized modality dir (:197).
  Warnings only: missing README (:205), zero-byte file (:123, silently dropped from count), non-BIDS top-level (:141).
  `validateDatasetDescription` (:285): errors only on `Name` (:307) and `BIDSVersion` (:310); `Authors` warns (:313);
  **`License` is parsed (:328) but never validated.**
- **CLI prescreen** `src/lib/upload/preflight.ts`: `validateBidsStep` (:87) fails hard on missing
  `dataset_description.json` (:94) and any BIDS error (:127-:137); skippable via `--skip-validation` (:92).
  License handled in `src/lib/upload/enrich.ts:251` (`resolveLicenseStep`) — **gated on
  `process.stdin.isTTY && !options.skipValidation` (:257)**, so non-interactive uploads never resolve a license.
  Writes license into `dataset_description.json` and creates a LICENSE file (`ensureLicenseFile`, :327).
  Validator version pinned in `src/lib/bids-validator.ts:20-23`, refreshed weekly by `bump-validator.yml`.
- **Server-side gate (the only true block)** `backend/src/routes/datasets/publication.ts:124-176`:
  blocks on `bids_validation_pending|failed|in_progress`; CI infra failure also blocks (:163-:174);
  blocked row at :185; 422 at :213. Prescreen dispatch (:229-:275) is feature-flagged and non-fatal.
- **Prescreen callback** `backend/src/routes/callbacks/prescreen.ts`: verdicts `pass|block|error` (:30),
  `issue_url` accepts null (:48). `decidePrescreenOutcome` (:96-:129): **`flagged` only FLAGS, never blocks (#756)** —
  recorded as `prescreen_status='concern'`. S3 presence check is authoritative both directions
  (`isDataShortageReason` :80; empty prefix adds a synthetic "no data files" reason). One-shot handler.
  Schema: migrations `0028_prescreen.sql`, `0045_prescreen_reasons.sql`.
  Advisory surfaces at `publication.ts:370-404`; client type `src/lib/api/publish.ts:36`.
- **Approval-time** `backend/src/services/publication-orchestrator.ts:445-495` re-checks bids-validation CI in the
  16-step approval; bypassable via `skip_ci_check` (:222). Admin approve route `backend/src/routes/admin/publish.ts:140`
  reads prescreen fields for display only (:57-:59) — approval is not conditioned on them.
  Import trust-upstream decision: `src/lib/import-openneuro.ts:157` (`decideSkipCiCheck`).
- **Auto-repaired, not enforced:** `backend/src/services/participants-tsv.ts` generates a minimal `participants.tsv`
  (BIDS says recommended, validator does not fail), committed alongside enrichment (`enrich-dataset.ts:868-872`).
  Channel/electrode info (`0054_channel_montage_columns.sql`) is best-effort for filters, never gated.
- **Reusable license machinery:** `backend/src/lib/license.ts:13` (`LICENSE_TIERS`, backing `datasets.license_tier`,
  migration `0034_license_tier.sql`); CLI duplicate at `src/commands/dataset.ts:1656`;
  curated SPDX list `src/lib/license.ts:28` (`RECOMMENDED_LICENSES`).
- **Missing plumbing:** `NemarMetadataV2` (`shared/datacite-constants.ts:160-185`) has **no `flags` field** yet.

## 3. Proposed requirements

MUST = reject (native submissions); SHOULD = warn/flag, never block.
"Where enforced" names the authoritative layer; earlier layers may pre-warn.

### Tier A — structural, objectively checkable (MUST)

| # | Requirement | Where enforced | Status today |
|---|---|---|---|
| A1 | BIDS validation passes, zero errors | CLI prescreen; server at publish request + approval | enforced |
| A2 | `dataset_description.json` present at root | browser, CLI, validator | enforced |
| A3 | `dataset_description.json` parses as a JSON object | browser | enforced |
| A4 | `Name` present, non-empty | browser, validator | enforced |
| A5 | `BIDSVersion` present, non-empty | browser, validator | enforced |
| A6 | `Name` >= 25 characters | browser (feedback) + server at publish request (authoritative) | NOT enforced |
| A7 | >= 1 `sub-*` directory with data | browser, validator | enforced |
| A8 | >= 1 recognized modality datatype dir | browser, validator | enforced |
| A9 | Data blobs actually present in S3 | server only (authoritative) | enforced as flag only — promote to block |
| A10 | README present | CLI + server at publish request | browser warns only; blocks nowhere |
| A11 | README substantive, not a stub | server (deterministic length MUST; LLM boilerplate judgement — see S5) | NOT enforced |
| A12 | License declared and resolvable to a known tier | CLI prompt + server authoritative | partial: TTY-only CLI prompt; server never checks |
| A13 | LICENSE file at dataset root | CLI | partial: `ensureLicenseFile` on same TTY-only path |
| A14 | No `..` path traversal | browser + server re-check | browser-only today |
| A15 | No path > 1024 chars | browser + server on key construction | browser-only today |
| A16 | No single file > 5 GB | browser | enforced |

### Tier A-semantic — LLM-judged (MUST, per ADR 0014; never regex hard gates)

| # | Requirement | Status today |
|---|---|---|
| S1 | `Name` is not a placeholder string | judged by prescreen, never blocks |
| S2 | `Name` != dataset identifier (deterministic; browser + server) | NOT enforced |
| S3 | `Name` is not a bare author-year/approval string | judged, never blocks |
| S4 | `Authors` non-empty, no placeholder entries (placeholders MUST; absence SHOULD) | browser warns on shape only |
| S5 | README describes THIS dataset, not boilerplate for a family (MOABB case) | NOT enforced |

### Tier B — flags (SHOULD; badge, never block)

| # | Requirement | Status today |
|---|---|---|
| B1 | IRB/ethics info present (`EthicsApprovals` or README statement) | not computed; needs `flags` in `NemarMetadataV2` |
| B2 | `participants.tsv` present | auto-repaired — effectively always satisfied |
| B3 | `*_channels.tsv` per electrophysiology recording | validator covers where required |
| B4 | `*_electrodes.tsv` + `*_coordsystem.json` when positions claimed | validator (iEEG); best-effort otherwise |
| B5 | `*_events.tsv` for task runs | validator covers |
| B6 | Modality sidecar required fields | validator covers |
| B7 | No zero-byte data files | browser warns + silently drops |
| B8 | Top-level files BIDS-shaped | browser warns |
| B9 | Funding info present | not enforced |
| B10 | Total upload < 50 GB soft cap | browser enforces as error (policy: SHOULD) |

**Inherited from BIDS validation — do NOT reimplement (drift risk):** A1, A2, A4, A5, A7, A8, B5, B6 (+B3/B4 where spec-required).
The prescreen reports the validator's verdict; it does not recompute it.
**Browser-only checks the server must re-check (bypassable client):** A14, A15, A16.

## 4. Enforcement mapping by layer

- **Browser pre-check** gains A6, S2, and non-blocking notices for A10-A13 (learn before uploading). Never the sole gate.
- **CLI prescreen** owns local-directory checks A1, A2, A10-A13.
  The `resolveLicenseStep` TTY gate must become a non-interactive FAILURE, not a silent skip, if A12/A13 are MUST.
- **Server at publish request** is the authoritative gate: add a second blocking channel alongside `bids_validation_*`
  with a new `block_reason` like `min_requirements_failed`, reusing the 422 shape at `publication.ts:213`.
- **Prescreen callback** owns S1, S3-S5 and A9. Split payload: Tier A reasons -> blocking channel; rest -> existing advisory.
  Preserve `decidePrescreenOutcome`'s S3 authority logic verbatim in both directions (defends against
  "workflow passed but blobs never uploaded" and the annex-blind false negative from #753).
- **Enrichment** computes Tier B flags into `.nemar/metadata.json` (`flags` field added to `NemarMetadataV2` + neuroschema).
- **Import path** owns the exemption (`decideSkipCiCheck` precedent; or read `datasets.source = 'openneuro'`).

## 5. Exemptions

OpenNeuro imports are exempt from every Tier A row **except A1 and A9** (A9 is about our own transfer integrity).
They still get all Tier B flags, so badges render identically on imported and native datasets.
Rationale to record: re-litigating another archive's accepted review would block importing datasets that are already
public and citable; the exemption must stay explicit in code and docs or it reads as a bug in the next post-mortem.

## 6. Open questions requiring a human policy call

1. **README stub threshold.** 200+ chars as deterministic MUST plus LLM boilerplate judgement as MUST (A11+S5),
   or boilerplate advisory-only? Is 200 chars measured before or after stripping markdown/links/badges?
2. **Hard block vs authoritative advisory.** Issue proposes hard block with logged admin override; alternative is an
   advisory the admin must explicitly acknowledge before approving (cheaper: no new `block_reason` plumbing). Which?
3. **License strictness.** Must resolve to SPDX/`license_tier`, or any non-empty non-sentinel string?
   If bespoke institutional agreements are allowed (common for clinical iEEG), need an explicit
   "custom license, terms in LICENSE file" escape hatch and a tier assignment rule.
4. **Flag surfacing.** Badge only, or + auto-opened issue, or + email? (Auto-issues on 69% of imports = noise;
   if issues are wanted, restrict to native submissions.)
5. **Timing.** Upload-time (bypassable) vs publish-time (authoritative) vs both. Likely both with publish-time
   authoritative, but that doubles the surface that must stay in sync with this document.
6. **PII/defacing attestation.** Nothing checks this today; `anat` is a recognized datatype, and anatomical MRI can
   carry identifiable facial structure. Attestation checkbox at upload (cheap, defensible) vs automated detector
   (research project)? MUST or SHOULD? Applies to imports?
7. **Migrated vs native bar.** Does the exemption survive a native edit of an imported dataset?
   Does it extend to future non-OpenNeuro sources? Should imports failing Tier A be badged so the two-bar system is honest?
8. **Retroactivity.** Does Tier A gate new versions of already-published native datasets, or first publication only?
9. **Admin override auditing.** Where is the override reason stored, is it public on the dataset page,
   does an overridden dataset carry a flag? (No override mechanism exists today — new surface.)
10. **Duplicate/derived submissions.** Same recordings submitted twice (native upload of an OpenNeuro mirror)?
    `SourceDatasets` is written (`enrich.ts:346`) but never checked. Rejection reason or explicitly acceptable?

## 7. Key file references

Browser: `website/src/lib/bids-precheck.ts` (consumed `upload.astro:489,:504`).
CLI: `src/lib/upload/preflight.ts:87`, `src/lib/upload/enrich.ts:251`, `src/lib/bids-validator.ts:20`, `src/lib/license.ts:28`.
Server: `backend/src/routes/datasets/publication.ts:124,:185,:229,:370`; `backend/src/routes/callbacks/prescreen.ts:30,:80,:96`;
`backend/src/services/publication-orchestrator.ts:222,:445`; `backend/src/routes/admin/publish.ts:57,:140`.
Support: `backend/src/services/participants-tsv.ts`, `backend/src/services/enrich-dataset.ts:558,:868`,
`backend/src/lib/license.ts:13`, `src/lib/import-openneuro.ts:157`, `shared/datacite-constants.ts:160`.
Migrations: `0028_prescreen.sql`, `0034_license_tier.sql`, `0045_prescreen_reasons.sql`, `0054_channel_montage_columns.sql`.
Prior work: `.context/research-submission-minimums-deskreject.md`, `.context/decisions/0014-...md` (ADR 0014).
