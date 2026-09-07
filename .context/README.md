# `.context/` — map

Documents accumulated here over the project's life, mixing binding decisions,
live runbooks, point-in-time research, and completed plans. Nothing distinguished them, so a
reader could not tell a current rule from a superseded one. This index does that.

**Start with [`decisions/`](decisions/README.md).** Where any document below disagrees with an
ADR, **the ADR wins** — these keep the analysis, the ADR is the verdict.

Documents that record completed work carry a `STATUS: HISTORICAL` banner. They are kept because
*how* something was decided is worth having, but they are not a current-state reference.

---

## Decisions

- [`decisions/`](decisions/README.md) — the Architecture Decision Records, index enforced by
  `test/adr-index.unit.test.ts`. Read before designing, and before "fixing" something that looks
  odd — several oddities here are deliberate.

## Current reference

Trust these for how things work today.

| Document | What it is |
|---|---|
| [systems-inventory.md](systems-inventory.md) | Every host and service, with paths, cron schedules, and deploy procedures. Expands the map in `AGENTS.md`. |
| [validated_workflows.md](validated_workflows.md) | Workflows proven by prototype, with the gotchas. The git-annex and staging-to-final recipes live here. |
| [release-safety-playbook.md](release-safety-playbook.md) | Environments, promotion path, pre-release checks. |
| [recover-runbook.md](recover-runbook.md) | Recovering 0-byte imports (epic #967 Phase 5). |
| [access_control.md](access_control.md) | How collaborator-based access is implemented. |
| [dataset_workflow.md](dataset_workflow.md) | Dataset lifecycle: IDs, upload, download, versioning. |
| [pr_architecture.md](pr_architecture.md) | PR + staging mechanics. **The branch-protection payload it described is superseded** — see ADR 0001. |
| [phase5-cross-repo-owner-deploys.md](phase5-cross-repo-owner-deploys.md) | Known cross-repo gaps needing owner action. |
| [ideas.md](ideas.md) | Exploratory design notes. Frequently rewritten; promote settled items to an ADR. |
| [research.md](research.md) | Prior art from the `nemar-tools` scripts. Describes the **pre-NEMAR** Zenodo flow — DOIs are EZID now (ADR 0007). |

## Research — point-in-time findings

Measurements and investigations. Accurate as of their date; re-verify before relying on numbers.

| Document | Question it answered |
|---|---|
| [research-catalog-consolidation.md](research-catalog-consolidation.md) | How to collapse the two dataset tables (-> ADR 0003). |
| [research-d1-backup-655.md](research-d1-backup-655.md) | How to back up D1 (-> ADR 0004). |
| [research-submission-minimums-deskreject.md](research-submission-minimums-deskreject.md) | How many datasets would trip each proposed reject rule (-> ADR 0014). |
| [research-archive-import-candidates.md](research-archive-import-candidates.md) | Survey of ~90 non-OpenNeuro archives (-> ADR 0013). |
| [research-openneuro-import-forensics.md](research-openneuro-import-forensics.md) | Why a 5-dataset import batch failed. |
| [openneuro-support-403-report.md](openneuro-support-403-report.md) | Objects inaccessible upstream, for reporting. |
| [security-fix-dataset-visibility.md](security-fix-dataset-visibility.md) | The 2026-01 private-dataset leak (-> ADR 0017). |
| [plan-multi-archive-importer.md](plan-multi-archive-importer.md) | Architecture RFC for multi-archive import (-> ADR 0013, **proposed**). |
| [research-make-vs-take-audit.md](research-make-vs-take-audit.md) | 2026-09-03 audit of bespoke code an established library or platform feature already covers, with replace / wrap / keep verdicts (-> ADR 0037). |
| [research-agent-findability.md](research-agent-findability.md) | 2026-09-03: how AI agents and crawlers actually find datasets (robots tokens, sitemaps, JSON-LD, registries, DataCite); evidence that llms.txt and markdown mirrors are not read; Zarr guidance for agents (-> OSCAR epic). |

## Historical — completed work

Records of what was done. Do not use as a current-state reference.

[plan.md](plan.md) · [prototyping_plan.md](prototyping_plan.md) ·
[architecture_review.md](architecture_review.md) ·
[epic_central_manifest_state.md](epic_central_manifest_state.md) ·
[sprint_review_publication_workflow.md](sprint_review_publication_workflow.md) ·
[deleted-datasets-incident.md](deleted-datasets-incident.md) ·
[blast-radius-catalog-fold.md](blast-radius-catalog-fold.md) ·
[plan-923-test-staging.md](plan-923-test-staging.md) ·
[plan-legacy-separation-793.md](plan-legacy-separation-793.md) ·
[plan-import-robustness.md](plan-import-robustness.md) ·
[plan-phase2-retry-engine.md](plan-phase2-retry-engine.md) ·
[draft-1023-service-access-endpoints-plan.md](draft-1023-service-access-endpoints-plan.md)

---

## Known stale content, deliberately kept

Left in place because the surrounding document is still useful, each annotated inline:

- **`plan.md` "Storage Strategy"** lists Zenodo for DOIs — superseded by ADR 0007.
- **`prototyping_plan.md`** shows `enforce_admins=true` protection payloads — superseded by ADR 0001.
- **`epic_central_manifest_state.md`** ops sequence references the retired personal Cloudflare
  account — superseded by ADR 0008.
- **`architecture_review.md`** item 2 is marked RESOLVED but was later reversed — see ADR 0019.
- **`draft-1023-service-access-endpoints-plan.md`** proposes separate service-access grant/revoke
  endpoints — superseded by ADR 0040, which puts the grant on approve/revoke themselves.

## Adding to this directory

- A **decision** goes in `decisions/` as an ADR, not here.
- A **runbook or reference** goes here and gets a row in "Current reference" above.
- When a plan is finished, add the `STATUS: HISTORICAL` banner and move its row to Historical
  rather than deleting it.
