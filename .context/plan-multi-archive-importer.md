# Architecture RFC: Multi-Archive Importer for NEMAR

> **Decision recorded:** [ADR 0013 - The importer stays in nemar-cli, registry plus family adapters](decisions/0013-the-importer-stays-in-nemar-cli-with-registry-plus-family-adapters.md) (status: proposed).
> This document is the full RFC behind that choice.

**Date:** 2026-07-24
**Input:** `.context/research-archive-import-candidates.md` (~90 external EEG/iEEG/MEG/EMG/motion archives beyond OpenNeuro)
**Question:** Separate `nemar-importer` service, or extend `nemar-cli`'s existing import machinery?

**Recommendation up front:** Keep it **inside `nemar-cli` (this monorepo)** — do **not** spin up a separate repo/service. Add a **pluggable source-adapter layer** (`src/lib/import/adapters/`) driven by a **thin data registry + code-per-archive-family** hybrid. Reuse the existing D1 `import_jobs` state machine and retry engine, **extended** with a conversion stage and a human legal-review gate, rather than building a parallel pipeline. Rationale below.

---

## 1. What the current OpenNeuro import path actually is

The current path is already a **three-plane system**, not a monolith — this matters, because it's the substrate any new design either extends or duplicates.

**Control plane (Cloudflare Worker + D1).**
- `POST /admin/datasets/import` (`backend/src/routes/admin/imports.ts:48`) creates the `datasets` row + GitHub repo and seeds an `import_jobs` state row (`status='preparing', stage='prepare'`, `imports.ts:129`). It is hard-gated to `source: z.enum(["openneuro"])` and `dataset_id` regex `/^on\d{6}$/` (`imports.ts:33-37`) and refuses to run outside production (`imports.ts:63`) because `on######` ids are deterministic and would collide in the shared `nemarDatasets` org.
- State machine (`backend/src/services/import-recovery.ts:21-46`): `preparing → copying → finalizing → complete`, plus `incomplete`, `failed`, `quarantined`, `rolled_back`. Terminal set is `complete | rolled_back | quarantined`; `incomplete` is deliberately non-terminal (the retry engine drives it back to `complete`).
- Recovery classifier (`import-recovery.ts:92-120`): on failure, decide `rollback` (unambiguous orphan, behind `IMPORT_AUTO_ROLLBACK`) vs `quarantine`. The `upstream_inaccessible` reason and `OPENNEURO_UPSTREAM_MARKER` (`import-openneuro.ts:327`) mark OpenNeuro-side 403s as a listable, non-NEMAR-bug class.
- Retry/blocklist engine (`backend/src/services/import-retry.ts`, integrity primitive in `import-integrity.ts:verifyDatasetVersionS3`, plan in `.context/plan-phase2-retry-engine.md`): a **prod-only cron** re-dispatches the onboard workflow on a paced, capped, ~2-week window; a reclassification sweep re-verifies falsely-`complete` rows per-key against S3; upstream-403-after-window rows get **blocklisted** and trigger a once-only OpenNeuro-maintainer email behind `OPENNEURO_MAINTAINER_EMAIL_ENABLED`. `import_jobs` carries `recovery_attempts`, `first_incomplete_at`, `next_retry_at`, `blocklisted`, `blocklist_reason`, `maintainer_notified_at`, `integrity_checked_at` (migration 0058).
- Discovery (`backend/src/services/openneuro-discovery.ts`, `auto-import.ts`): a **crawl-and-diff** loop — discover via OpenNeuro GraphQL, dedup purely against D1 (`datasets.source_id` + `import_jobs`, **zero GitHub calls** to avoid the secondary-rate-limit trap), gate to `NEMAR_MODALITIES`, pick one, dispatch. Paced cron behind `AUTO_IMPORT_ENABLED`.

**Data plane (GitHub Actions).** The actual copy is a **server-side S3→S3 copy** (`batchServerSideCopy`, `src/lib/s3-server-copy.ts`) from OpenNeuro's S3 mirror to `s3://nemar`. The runner never streams bytes. Orchestrated by the CLI's phased entrypoints `prepareImport`/`copyShard`/`finalizeImport` (`src/lib/import-openneuro.ts:760/1123/…`), invoked as `nemar admin import-openneuro <id> --phase prepare|copy|finalize` (`src/commands/admin.ts:3160`).

**Validation.** `src/lib/bids-validator.ts` wraps the pinned bids-validator via Deno. But for OpenNeuro, validation is **trusted upstream** — `decideSkipCiCheck` + `--trust-upstream` (`import-openneuro.ts:157`) let it publish when the per-dataset CI validation run doesn't register, precisely because OpenNeuro pre-validates.

**Operator surface:** `nemar admin import status|rollback|retry|verify` (`admin.ts:3385`) and `nemar admin recover` (`admin.ts:3565`).

**The load-bearing assumptions:** source data already in S3, already git-annex/DataLad-structured, already BIDS-valid, one deterministic id scheme, one auth model (anonymous S3 read). **Every one of these is false for the 90 new sources.**

---

## 2. What's structurally different about the ~90 sources

Per `.context/research-archive-import-candidates.md`, the deltas are not incremental:

1. **Data plane inverts.** The S3→S3 server-side copy only works because OpenNeuro is on S3. Zenodo/GIN/Figshare/OSF/PhysioNet/GigaDB deliver over HTTPS/HTTP archives; the runner must **download bytes, convert to BIDS, and upload** — a fetch-convert-validate-push plane, not a metadata-only copy.
2. **In-house validation is the default, not the exception.** No non-OpenNeuro host enforces `bids-validator`. `src/lib/bids-validator.ts` becomes the gating step for essentially every import; `--trust-upstream` becomes the rare exception, inverting the current default.
3. **Auth is per-archive and irregular.** Open REST (Zenodo `keywords:"BIDS"`, GIN keyword pages), API-with-token (Figshare, OSF, EBRAINS KG Query), DUA/credential gates (PhysioNet-credentialed, NSRR, OMEGA, Cam-CAN), signed license agreements (SEED, TUEG), and Japanese/Chinese-only or JS-SPA UIs. No shared client.
4. **Licensing is per-dataset, and often needs a human legal gate before *any* byte moves.** The research Tier framework is explicit: the highest-value cohorts forbid rehosting. A legal-review checkpoint is a first-class pipeline state, not a config flag.
5. **Two job shapes.** "Import this known id" (TDBRAIN, WAND, a specific GigaDB set) vs. "**crawl and diff** for new BIDS deposits" (Zenodo, GIN, Figshare, OSF, EBRAINS KG). The second is the existing discovery pattern generalized per-source.
6. **Wildly different politeness needs.** A government-grade archive vs. one lab's Figshare page need per-source rate/concurrency budgets, unlike the single OpenNeuro pace constant.

---

## 3. Recommendation

### 3.1 Same repo, not a separate service

A `nemar-importer` under `nemarOrg` is the wrong call. Everything the importer must reuse already lives here and is battle-hardened: the D1 `import_jobs` state machine, the retry/blocklist engine, `deleteDatasetCascade` (rollback), DOI minting, the governance fleet, `bids-validator.ts`, the git-annex/S3 plumbing (`s3-server-copy.ts`, `git-annex/*`), and — critically — the **prod-safety fences**: the `scheduled()` prod-only allowlist, the shared-`nemarDatasets`-org and shared-`users` blast-radius rules (AGENTS.md "DANGER" section), the dataset-ID bands, and the exemplar/staging conventions. A separate repo would either duplicate all of this or RPC back into it, doubling the surface where a dev-side job can email 609 real users or cascade-delete a real repo. The import problem is *not* compute-isolated from NEMAR's core; it *is* NEMAR's core write path. Keep it co-located.

### 3.2 Adapter layer: hybrid (thin data registry + code per archive family)

Pure config cannot express "log into EBRAINS, accept a per-dataset DUA, download, run `ephys-to-BIDS`, validate." Pure code-per-archive (90 modules) bloats the CLI and duplicates auth/convert logic across sibling archives. So: **a data-driven `SourceRegistry` + code adapters keyed by archive family.**

```ts
// src/lib/import/registry.ts  — DATA (per-source, git-reviewed, low-churn)
interface SourceEntry {
  id: string;                 // "zenodo" | "gin" | "physionet" | "gigadb" | ...
  kind: "one-shot" | "crawl"; // import-by-id vs discover-and-diff
  auth: "anonymous" | "api-token" | "dua-gated" | "manual-handoff";
  bidsStatus: "native" | "shaped" | "raw";     // raw/shaped => must convert
  defaultLicense: string | null;               // null => legal gate always
  tier: 1 | 2 | 3;            // research doc: easy-win / crawler / partnership
  politeness: { rps: number; concurrency: number };
  adapter: string;            // → code module below
}

// src/lib/import/adapters/<family>.ts  — CODE (one per archive FAMILY)
interface SourceAdapter {
  resolve(sourceId: string): Promise<DatasetRef>;        // metadata + license + files
  fetch(ref: DatasetRef, workDir: string): Promise<void>;// download bytes (this plane replaces S3→S3)
  convert?(workDir: string): Promise<void>;              // to BIDS, when bidsStatus !== native
  license(ref: DatasetRef): LicenseDecision;             // feeds the legal gate
  discover?(cursor?: string): Promise<DiscoveredDataset[]>; // crawl kind only; reuses diff-vs-D1
}
```

Ninapro/putEMG/GigaDB share one `emg-gigadb` converter family; Zenodo/Figshare/OSF share a `generic-repo` fetch+discover family; PhysioNet is its own. ~8–12 code modules cover all 90 sources. New archives are usually a **registry row + reused adapter**, occasionally a new family module — added independently without touching the CLI core.

**Update 2026-07-24 — don't build the Zenodo/ScienceDB/OSF/Figshare/Radboud discover() logic from scratch.** [EEGDash](https://github.com/eegdash/EEGDash) (`scripts/ingestions/1_fetch_sources/`) already has working, BSD-3-Clause-licensed adapters for exactly these families, confirmed by direct source read: `zenodo.py` (`zenodo.org/api/records`, open+dataset filter, BIDS structure check), `scidb.py` (ScienceDB, 4-modality search incl. iEEG), `osf.py` (API v2 tag+title search, license lookup), `figshare.py` (API v2 "EEG BIDS" search), `datarn.py` (Radboud `data.ru.nl/api/search/collections/published`, no auth), and `eegmanylabs.py` (a new archive this surfaced — see `.context/research-archive-import-candidates.md` §7). Critically, **EEGDash is built by SCCN + Ben-Gurion University** — SCCN is NEMAR's own home institution, and EEGDash already ingests 330 BIDS datasets converted from NEMAR via `data.nemar.org/?format=json`. This is a sibling project, not a third party. **Recommendation: coordinate directly with the EEGDash team and port/adapt their discovery logic into the `generic-repo`/`scidb`/`datarn` adapter families rather than re-engineering crawlers that already exist under a compatible license one floor over.** The one confirmed gap: EEGDash's Zenodo adapter explicitly excludes iEEG, spiking, and LFP — NEMAR's iEEG scope needs its own query variant even if the rest of the adapter is reused.

### 3.3 CLI surface

Generic subcommand, source-registry-driven, with the current command as a back-compat alias:

```
nemar admin import-source <source> <id> [--dry-run]   # nemar admin import-source zenodo 10.5281/zenodo.123
nemar admin import-openneuro <ds…>                    # kept as an alias → import-source openneuro
nemar admin import status|rollback|retry|verify <id>  # UNCHANGED — reused verbatim
nemar admin import legal <id> --approve|--deny        # NEW: the human gate (see 3.5)
nemar admin crawl <source> [--dispatch]               # generalized discovery for crawl-kind sources
```

Do **not** make one subcommand per archive — that's the bloat trap. One generic verb + registry.

### 3.4 One state machine, extended — not a parallel pipeline

Extend `import_jobs`, do not fork it. Generalize `source` beyond `openneuro` (drop the `z.enum`; validate against the registry) and relax the `on######` id gate to a per-source id band (proposal: `ex######` for converted externals; crawled sources keep provenance in `source`/`source_id`). Add two stages/states to `ImportStatus` (`import-recovery.ts:21`):

- **`converting`** — between `preparing` and `copying`, for the fetch→convert→validate plane. Failure here quarantines with a new `conversion_failed`/`validation_failed` reason (analogous to `upstream_inaccessible`).
- **`awaiting_legal`** — a **non-terminal hold** entered immediately after `resolve`, before any bytes move, whenever `registry.defaultLicense` is null or the adapter's `license()` returns `needs-review`.

The retry engine, blocklist, `verify`, `rollback`, and `recover` all keep working unchanged — they key on statuses, not on OpenNeuro specifics. New failure reasons slot into the existing `classifyRecovery` switch.

### 3.5 Human-in-the-loop legal gate

Model it exactly like the existing once-only maintainer-email gate (behind `OPENNEURO_MAINTAINER_EMAIL_ENABLED`). A job that enters `awaiting_legal` **blocks the data plane entirely** — no fetch, no convert — until `nemar admin import legal <id> --approve` flips it (audit-logged, admin-only, mirroring the `import/verify` route). Off-prod this defaults to dry-run. This makes the Tier-3 DUA sources *representable* in the pipeline without ever risking an unlicensed byte movement.

### 3.6 Crawlers vs. one-shot

Crawl-kind sources reuse the proven `openneuro-discovery.ts` shape: **discover via the source API, diff against D1 (`source_id` + `import_jobs`), zero GitHub calls, pick, dispatch** — one `discover()` per adapter feeding the *same* `import_jobs` rows. They belong in the **same Worker cron**, each gated by its own `<SOURCE>_CRAWL_ENABLED` flag and per-source pace, not a new scheduled-worker component. A separate worker would re-inherit the prod-safety fences for no benefit. One-shot sources skip `discover()` and enter at `import-source <src> <id>`.

### 3.7 Safe testing under the dev/staging split

The existing OpenNeuro path is prod-only *only* because `on######` ids collide in the shared org. The new plane doesn't have that excuse and **must be dev-testable**, because conversion + validation are exactly what needs iteration:

- Give converted externals a **dev id band** (extend the AGENTS.md band table, e.g. `ex09XXXX` ephemeral / exemplar), so dev imports never collide with prod repos.
- Run adapters in **`--dry-run` / fetch-only** mode against `nemar-db-dev` + `s3://nemar-dev`, honoring the catalog-purity rule (exemplars-only; never re-seed prod rows).
- Keep every new cron/crawl **prod-only-by-default** in the `scheduled()` allowlist; a crawler that hits an external API is safe off-prod, but any GitHub/`nemarDatasets` write or user email stays fenced.
- Seed 2–3 Tier-1 sources as **staging exemplars** (via the existing exemplar clone tool) to exercise convert→validate→publish end-to-end on dev before any prod flip. The legal gate stays dry-run off-prod.

---

## 4. Phased rollout

**Phase 0 — Substrate (no new sources).** Add `SourceRegistry` + `SourceAdapter` interface; refactor OpenNeuro into the first adapter behind it (proves the seam without behavior change); generalize `source`/id-gate; add `converting` + `awaiting_legal` states + the legal gate route/CLI; add the `ex` dev band. Ship dark.

**Phase 1 — Easy wins (Tier 1: already-BIDS, open license, no gate).** TDBRAIN, ERP CORE, WAND, CeTI-Locomotion/Age-Kinematics, ChineseEEG/-2/EmoEEG-MC, GigaDB Korea-University/GIST (these need conversion but have clean licenses). One-shot `import-source`. Exercises the fetch+validate plane and the `emg-gigadb`/`generic-repo` converter families on dev exemplars first, then prod.

**Phase 2 — General-repo crawlers (Tier 2).** Zenodo `keywords:"BIDS"` (highest yield) and GIN `keywords/bids/` (zero-noise) first; Figshare/OSF secondary; EBRAINS KG as a metadata-only discovery index. Reuse the discovery-diff pattern; each behind its own crawl flag and pace. The legal gate catches per-deposit non-open licenses automatically.

**Phase 3 — DUA-gated partnerships (Tier 3), last.** Cam-CAN, OMEGA, NatMEG-PD, HCP-MEG, EBRAINS HIP, RAM. These are `manual-handoff` adapters: they represent the dataset in `import_jobs` at `awaiting_legal` and only proceed after a negotiated agreement + `import legal --approve`. Engineering is minimal; the value here is that the pipeline *tracks* them rather than automating them.

---

### Critical Files for Implementation
- `src/lib/import-openneuro.ts` — refactor into the first `SourceAdapter`; new adapters live beside it under `src/lib/import/adapters/`.
- `backend/src/routes/admin/imports.ts` — generalize the `source` enum + id gate; add the legal-gate route.
- `backend/src/services/import-recovery.ts` — add `converting`/`awaiting_legal` states and new quarantine reasons to the shared state machine.
- `backend/src/services/openneuro-discovery.ts` (+ `auto-import.ts`) — the crawl-and-diff pattern to generalize per-source.
- `src/commands/admin.ts` — the `import-source` / `crawl` / `import legal` CLI surface (reusing `import status|rollback|retry|verify`).
