/**
 * Admin routes: staging exemplar datasets (epic #923, Phase 5).
 *
 * A curated fleet of xx-prefixed "exemplar" copies of real datasets that pass
 * through the full publish / DOI / reindex pipeline on the staging environment
 * (test.nemar.org). These endpoints are the FIRST writers of `is_exemplar=1`;
 * they 403 in production so a prod D1 row can never carry the flag — the Phase 4
 * visibility carve-outs rely on that invariant (see services/exemplar.ts).
 * Modeled on routes/admin/imports.ts (repo-create -> D1-insert -> rollback).
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { auditLogStatement } from "../../db/audit-log";
import type { DataCiteEnrichment } from "../../services/datacite";
import {
  buildOrcidEnrichment,
  createConceptDoi as dispatchCreateConceptDoi,
} from "../../services/doi";
import { isNonProductionEnv } from "../../services/environment";
import { type GitHubRepo, createRepository, deleteRepository } from "../../services/github";
import { getDatasetsToken } from "../../services/github-auth";
import { ORG_NAME } from "../../services/github/shared";
import { extractRepoName, readRepoMetadata } from "../../services/repo-metadata";
import type { AdminRouter } from "./shared";

/** Exemplar id band xx099900-xx099999 (canonical 8-char id: xx + 6 digits). */
export const EXEMPLAR_ID_RE = /^xx0999\d{2}$/;
/** Source dataset the exemplar is cloned from (an nm/on dataset). */
const SOURCE_ID_RE = /^(nm|on)\d{6}$/;

export function registerExemplarRoutes(admin: AdminRouter): void {
  const createExemplarSchema = z.object({
    dataset_id: z
      .string()
      .regex(EXEMPLAR_ID_RE, "Exemplar id must be in the xx099900-xx099999 band"),
    source_id: z
      .string()
      .regex(SOURCE_ID_RE, "source_id must be an nm/on dataset id (e.g. nm000132)"),
    name: z.string().min(1).max(200).optional(),
    description: z.string().optional(),
  });

  /**
   * POST /admin/datasets/exemplar
   *
   * Create a staging exemplar: a private nemarDatasets/<xx> repo + a D1 row with
   * is_exemplar=1. The CLI clone tool then copies data into the dev bucket and
   * publishes. 403 in production (staging-only fleet).
   */
  admin.post("/datasets/exemplar", zValidator("json", createExemplarSchema), async (c) => {
    // is_exemplar=1 must never exist in a production D1 (Phase 4 gate invariant).
    if (!isNonProductionEnv(c.env)) {
      return c.json(
        {
          error: "Exemplar creation is disabled in production",
          message:
            "Exemplar (xx099900-xx099999) datasets are a staging-only fleet; create them on the dev/test worker.",
        },
        403,
      );
    }

    const { dataset_id, source_id, name, description } = c.req.valid("json");
    const db = c.env.DB;
    const adminUser = c.get("user");
    const displayName = name || `[TEST COPY] ${source_id}`;

    const existing = await db
      .prepare("SELECT dataset_id FROM datasets WHERE dataset_id = ?")
      .bind(dataset_id)
      .first<{ dataset_id: string }>();
    if (existing) {
      return c.json({ error: `Dataset ${dataset_id} already exists` }, 409);
    }

    const pat = await getDatasetsToken(c.env);
    let githubRepo: GitHubRepo;
    try {
      githubRepo = await createRepository(
        dataset_id,
        `${displayName} - NEMAR staging exemplar (cloned from ${source_id})`,
        true,
        pat,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("already exists")) {
        return c.json({ error: `GitHub repo nemarDatasets/${dataset_id} already exists` }, 409);
      }
      console.error("Failed to create GitHub repo for exemplar:", error);
      return c.json({ error: `Failed to create GitHub repository: ${msg}` }, 500);
    }

    try {
      await db
        .prepare(
          `INSERT INTO datasets (dataset_id, name, description, owner_user_id, github_repo, is_sandbox, is_exemplar, visibility, source, source_id, last_activity_at)
           VALUES (?, ?, ?, ?, ?, 1, 1, 'private', 'nemar-exemplar', ?, datetime('now'))`,
        )
        .bind(
          dataset_id,
          displayName,
          description || null,
          adminUser.id,
          githubRepo.full_name,
          source_id,
        )
        .run();
    } catch (error) {
      console.error("Failed to insert exemplar record:", error);
      const dbMsg = error instanceof Error ? error.message : String(error);
      try {
        await deleteRepository(dataset_id, pat);
      } catch (cleanupErr) {
        console.error("Failed to clean up GitHub repo after D1 failure:", cleanupErr);
        // Record the orphan durably. `exemplar create --all` runs unattended and
        // continues past a failed entry, so an orphaned repo with no dataset row
        // would otherwise be discoverable only by reading Worker logs. Writing it
        // to audit_log makes it queryable later. Best-effort by necessity: D1 is
        // already misbehaving on this path, so a failure here must not mask the
        // 500 the caller needs to see.
        try {
          await auditLogStatement(db, {
            userId: adminUser.id,
            action: "exemplar_create_orphaned_repo",
            details: JSON.stringify({
              dataset_id,
              source_id,
              github_repo: `${ORG_NAME}/${dataset_id}`,
              d1_error: dbMsg,
              cleanup_error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            }),
          }).run();
        } catch (auditErr) {
          console.error(`Failed to audit-log orphaned repo for ${dataset_id}:`, auditErr);
        }
        return c.json(
          {
            error: `Failed to create exemplar record: ${dbMsg}. GitHub repo ${ORG_NAME}/${dataset_id} was created but could not be cleaned up. Manual deletion required.`,
          },
          500,
        );
      }
      return c.json({ error: `Failed to create exemplar record: ${dbMsg}` }, 500);
    }

    try {
      await auditLogStatement(db, {
        userId: adminUser.id,
        action: "exemplar_created",
        details: JSON.stringify({ dataset_id, source_id, name: displayName }),
      }).run();
    } catch (err) {
      console.error(`Failed to write audit log for exemplar ${dataset_id}:`, err);
    }

    return c.json(
      {
        dataset_id,
        name: displayName,
        github_repo: githubRepo.full_name,
        source: "nemar-exemplar",
        source_id,
      },
      201,
    );
  });

  /**
   * POST /admin/datasets/:id/exemplar/remint-dois
   *
   * Idempotent EZID re-mint of an exemplar's concept DOI (sandbox shoulder).
   * EZID identifiers are deterministic and the client tolerates "already
   * exists", so re-running recovers from a reset EZID sandbox or a drifted
   * _target. Version DOIs re-mint through the normal publish/version-doi flow.
   * 403 in production.
   */
  admin.post("/datasets/:id/exemplar/remint-dois", async (c) => {
    if (!isNonProductionEnv(c.env)) {
      return c.json({ error: "Exemplar DOI re-mint is disabled in production" }, 403);
    }
    const datasetId = c.req.param("id");
    const db = c.env.DB;
    if (!EXEMPLAR_ID_RE.test(datasetId)) {
      return c.json({ error: "Not an exemplar id (xx099900-xx099999)" }, 400);
    }

    const dataset = await db
      .prepare(
        `SELECT d.dataset_id, d.name, d.description, d.github_repo, d.concept_doi, d.is_exemplar,
                u.username as owner_username, u.orcid as owner_orcid
         FROM datasets d JOIN users u ON d.owner_user_id = u.id WHERE d.dataset_id = ?`,
      )
      .bind(datasetId)
      .first<{
        dataset_id: string;
        name: string;
        description: string | null;
        github_repo: string | null;
        concept_doi: string | null;
        is_exemplar: number | null;
        owner_username: string;
        owner_orcid: string | null;
      }>();
    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }
    if (dataset.is_exemplar !== 1) {
      return c.json({ error: "Not an exemplar dataset" }, 400);
    }

    // Assemble metadata like the concept-DOI route, then re-mint (sandbox).
    let bidsDescription: Record<string, unknown> | undefined;
    let repoEnrichment: DataCiteEnrichment | undefined;
    if (dataset.github_repo) {
      const repoName = extractRepoName(dataset.github_repo);
      if (repoName) {
        const baseEnrichment = buildOrcidEnrichment(
          undefined,
          dataset.owner_username,
          dataset.owner_orcid || undefined,
        );
        const repoMeta = await readRepoMetadata(
          repoName,
          await getDatasetsToken(c.env),
          baseEnrichment,
          dataset.name,
        );
        bidsDescription = repoMeta.bidsDescription;
        repoEnrichment = repoMeta.enrichment;
      }
    }

    try {
      const result = await dispatchCreateConceptDoi(
        {
          provider: "ezid",
          datasetId,
          datasetName: dataset.name,
          datasetDescription: dataset.description,
          githubRepo: dataset.github_repo,
          bidsDescription,
          enrichment: repoEnrichment,
          uploaderOrcid: dataset.owner_orcid || undefined,
          uploaderName: dataset.owner_username,
          sandbox: true,
        },
        {
          EZID_USERNAME: c.env.EZID_USERNAME,
          EZID_PASSWORD: c.env.EZID_PASSWORD,
          EZID_SANDBOX_USERNAME: c.env.EZID_SANDBOX_USERNAME,
          EZID_SANDBOX_PASSWORD: c.env.EZID_SANDBOX_PASSWORD,
          ZENODO_API_KEY: c.env.ZENODO_API_KEY,
          ZENODO_SANDBOX_API_KEY: c.env.ZENODO_SANDBOX_API_KEY,
          FRONTEND_URL: c.env.FRONTEND_URL,
          DATASET_LANDING_BASE_URL: c.env.DATASET_LANDING_BASE_URL,
        },
      );
      await db
        .prepare(
          // ezid_identifier/doi_provider are no longer stored (#1182):
          // the identifier derives from concept_doi and EZID is the sole
          // provider (ADR 0007).
          "UPDATE datasets SET concept_doi = ?, ezid_status = ?, updated_at = datetime('now') WHERE dataset_id = ?",
        )
        .bind(result.doi, result.status, datasetId)
        .run();
      return c.json(
        {
          dataset_id: datasetId,
          concept_doi: result.doi,
          status: result.status,
          warnings: result.warnings,
        },
        200,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Failed to re-mint exemplar DOIs for ${datasetId}:`, error);
      return c.json({ error: `Failed to re-mint DOIs: ${msg}` }, 500);
    }
  });
}
