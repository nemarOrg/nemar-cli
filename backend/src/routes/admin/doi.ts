/**
 * Admin routes: DOI management (concept + version DOIs, metadata update,
 * enrichment commit, dataset file listing for enrichment, Zenodo deposition
 * cleanup).
 *
 * Moved verbatim from routes/admin.ts in #903 (epic #902); the only
 * intentional changes are import paths, `adminRoutes` -> `admin`, and
 * audit-log INSERTs routed through auditLogStatement().
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import {
  datasetLandingUrl,
  datasetVersionLandingUrl,
} from "../../../../shared/datacite-constants.js";
import { auditLogStatement } from "../../db/audit-log";
import {
  type DataCiteEnrichment,
  bidsToDataCite,
  buildDataCiteXml,
  nemarMetadataToEnrichment,
  parseNemarMetadata,
} from "../../services/datacite";
import {
  buildOrcidEnrichment,
  createConceptDoi as dispatchCreateConceptDoi,
  resolveEzidAuth,
} from "../../services/doi";
import { resolveDatasetLandingBase } from "../../services/environment";
import { isExemplarPublishAllowed } from "../../services/exemplar";
import {
  type EzidAuth,
  conceptEzidIdentifier,
  extractDoi,
  updateIdentifier as ezidUpdateIdentifier,
} from "../../services/ezid";
import {
  commitEnrichmentWithBidsignore,
  getBlobContent,
  getTreeAtRef,
} from "../../services/github";
import { getDatasetsToken } from "../../services/github-auth";
import { errorMessage, extractRepoName, readRepoMetadata } from "../../services/repo-metadata";
import {
  type ZenodoDeposition,
  createNewVersion,
  deleteDeposition,
  downloadFile,
  formatRecordUrl,
  getDeposition,
  publishDeposition,
  uploadFile,
} from "../../services/zenodo";
import type { AdminRouter } from "./shared";

export function registerDoiRoutes(admin: AdminRouter): void {
  // ============================================================================
  // DOI Management
  // ============================================================================

  /**
   * POST /admin/datasets/:id/doi/concept - Create concept DOI for a dataset
   *
   * WARNING: Public DOIs are PERMANENT and cannot be deleted. Reserved DOIs can be deleted before being made public.
   * Creates a pre-reserved DOI via the specified provider (EZID by default, or Zenodo if explicitly requested).
   * The DOI is reserved but not published until the first version release.
   */
  const createConceptDoiSchema = z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    authors: z
      .array(
        z.object({
          name: z.string(),
          affiliation: z.string().optional(),
        }),
      )
      .optional(),
    sandbox: z.boolean().optional().default(false),
    provider: z.enum(["ezid", "zenodo"]).optional().default("ezid"),
    skip_enrichment_check: z.boolean().optional().default(false),
  });

  admin.post("/datasets/:id/doi/concept", zValidator("json", createConceptDoiSchema), async (c) => {
    const datasetId = c.req.param("id");
    const body = c.req.valid("json");
    const adminUser = c.get("user");
    const db = c.env.DB;

    // Get dataset info
    const dataset = await db
      .prepare(
        `
    SELECT d.*, u.username as owner_username, u.orcid as owner_orcid
    FROM datasets d
    JOIN users u ON d.owner_user_id = u.id
    WHERE d.dataset_id = ?
  `,
      )
      .bind(datasetId)
      .first<{
        id: number;
        dataset_id: string;
        name: string;
        description: string | null;
        github_repo: string | null;
        concept_doi: string | null;
        zenodo_concept_id: string | null;
        ezid_status: string | null;
        owner_username: string;
        owner_orcid: string | null;
        is_sandbox: number | null;
        is_exemplar: number | null;
        enrichment_json: string | null;
      }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    // ADR 0007: EZID is the sole DOI provider. The datasets table no longer
    // carries a doi_provider column (#1182), so a zenodo mint could not be
    // recorded correctly even if it succeeded — reject it up front. The
    // zenodo code paths below are retired with it (follow-up: remove them).
    if (body.provider !== "ezid") {
      return c.json(
        {
          error: "Unsupported DOI provider",
          message: "EZID is the sole DOI provider (ADR 0007); provider must be 'ezid'.",
          provider: body.provider,
        },
        400,
      );
    }

    // Block DOI creation for sandbox datasets, except staging exemplars (epic #923).
    if (
      (dataset.is_sandbox || dataset.dataset_id.startsWith("xx")) &&
      !isExemplarPublishAllowed(c.env, dataset)
    ) {
      return c.json(
        {
          error: "Cannot create DOI for sandbox datasets",
          message:
            "Sandbox datasets are for testing only. DOIs are permanent and should only be created for real datasets.",
          dataset_id: dataset.dataset_id,
        },
        400,
      );
    }

    // Check if dataset already has a DOI (before environment checks for clearer errors)
    if (dataset.concept_doi) {
      return c.json(
        {
          error: "Dataset already has a concept DOI",
          concept_doi: dataset.concept_doi,
          zenodo_url: dataset.zenodo_concept_id
            ? formatRecordUrl(Number.parseInt(dataset.zenodo_concept_id), body.sandbox)
            : null,
        },
        400,
      );
    }

    // Gate on enrichment: require validated metadata before minting DOIs
    if (!body.skip_enrichment_check) {
      if (!dataset.enrichment_json) {
        return c.json(
          {
            error: "Metadata pipeline has not run yet",
            message:
              "Push to main (or trigger the LLM Metadata Enrichment workflow manually) so the metadata pipeline runs, then retry. Pass skip_enrichment_check: true to override.",
            dataset_id: dataset.dataset_id,
          },
          422,
        );
      }
      // Check pipeline_stage is "validated"
      let pipelineStage: string | undefined;
      try {
        const meta = JSON.parse(dataset.enrichment_json) as Record<string, unknown>;
        pipelineStage = typeof meta.pipeline_stage === "string" ? meta.pipeline_stage : undefined;
      } catch (parseErr) {
        console.error(
          `[doi] Corrupt enrichment_json for ${dataset.dataset_id}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        );
      }
      if (pipelineStage !== "validated") {
        return c.json(
          {
            error: `Metadata not yet validated (current stage: ${pipelineStage || "unknown"})`,
            message:
              "The metadata pipeline must reach 'validated' stage before DOI minting. Re-trigger the LLM Metadata Enrichment workflow or pass skip_enrichment_check: true to override.",
            dataset_id: dataset.dataset_id,
            pipeline_stage: pipelineStage || "unknown",
          },
          422,
        );
      }
    }

    // SAFETY: Block production DOI creation in non-production environments
    // Production DOIs create permanent records in DataCite registry and consume DOI quota.
    // Development/staging should only use sandbox to avoid polluting production registry.
    // Only check environment for production DOI requests (skip for sandbox)
    if (!body.sandbox) {
      const environment = c.env.ENVIRONMENT;

      // FAIL CLOSED: If environment is not explicitly set, reject production DOIs
      if (!environment) {
        console.error("SECURITY: ENVIRONMENT variable not configured - blocking production DOI");
        return c.json(
          {
            error: "Server misconfiguration: ENVIRONMENT variable not set",
            message: "Cannot create production DOIs without explicit environment configuration",
            action_required: "Set ENVIRONMENT variable to 'production' in production environment",
          },
          500,
        );
      }

      // Normalize and validate environment
      const normalizedEnv = environment.toLowerCase().trim();
      const validEnvironments = ["production", "development", "staging", "test"];

      if (!validEnvironments.includes(normalizedEnv)) {
        console.error(`SECURITY: Invalid ENVIRONMENT value: ${environment}`);
        return c.json(
          {
            error: "Server misconfiguration: Invalid ENVIRONMENT value",
            message: `ENVIRONMENT must be one of: ${validEnvironments.join(", ")}`,
            current_value: environment,
          },
          500,
        );
      }

      // Block production DOI in non-production
      if (normalizedEnv !== "production") {
        return c.json(
          {
            error: "Production DOI creation blocked in non-production environment",
            message:
              "Cannot create production DOIs in development or test environments. Use --sandbox flag for testing, or deploy to production.",
            environment: normalizedEnv,
            dataset_id: dataset.dataset_id,
          },
          400,
        );
      }
    }

    // Read BIDS + enrichment metadata from GitHub repo
    let bidsDescription: Record<string, unknown> | undefined;
    let repoEnrichment: DataCiteEnrichment | undefined;
    let bidsMetadataWarning: string | undefined;
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
          body.title || dataset.name,
        );
        bidsDescription = repoMeta.bidsDescription;
        repoEnrichment = repoMeta.enrichment;
        if (repoMeta.warnings.length > 0) {
          bidsMetadataWarning = repoMeta.warnings.join("; ");
          console.warn("[doi]", bidsMetadataWarning);
        }
      }
    }

    const provider = body.provider;

    try {
      const result = await dispatchCreateConceptDoi(
        {
          provider,
          datasetId,
          datasetName: body.title || dataset.name,
          datasetDescription: body.description || dataset.description,
          githubRepo: dataset.github_repo,
          bidsDescription,
          enrichment: repoEnrichment,
          uploaderOrcid: dataset.owner_orcid || undefined,
          uploaderName: dataset.owner_username,
          sandbox: body.sandbox,
        },
        {
          EZID_USERNAME: c.env.EZID_USERNAME,
          EZID_PASSWORD: c.env.EZID_PASSWORD,
          EZID_SANDBOX_USERNAME: c.env.EZID_SANDBOX_USERNAME,
          EZID_SANDBOX_PASSWORD: c.env.EZID_SANDBOX_PASSWORD,
          ZENODO_API_KEY: c.env.ZENODO_API_KEY,
          ZENODO_SANDBOX_API_KEY: c.env.ZENODO_SANDBOX_API_KEY,
          // Landing-base resolution for the concept DOI _target (epic #923).
          FRONTEND_URL: c.env.FRONTEND_URL,
          DATASET_LANDING_BASE_URL: c.env.DATASET_LANDING_BASE_URL,
        },
      );

      // Update dataset with DOI info. The EZID identifier is derived from
      // concept_doi at read time (conceptEzidIdentifier, #1182), not stored.
      if (provider === "ezid") {
        await db
          .prepare(
            `
        UPDATE datasets
        SET concept_doi = ?,
            ezid_status = ?,
            is_sandbox = ?,
            updated_at = datetime('now')
        WHERE dataset_id = ?
      `,
          )
          .bind(result.doi, result.status, body.sandbox ? 1 : 0, datasetId)
          .run();
      } else {
        await db
          .prepare(
            `
        UPDATE datasets
        SET concept_doi = ?,
            zenodo_concept_id = ?,
            doi_provider = 'zenodo',
            is_sandbox = ?,
            updated_at = datetime('now')
        WHERE dataset_id = ?
      `,
          )
          .bind(result.doi, result.providerRecordId, body.sandbox ? 1 : 0, datasetId)
          .run();
      }

      // Audit log
      await auditLogStatement(db, {
        userId: adminUser.id,
        action: "doi_concept_created",
        resourceType: "dataset",
        resourceId: datasetId,
        details: JSON.stringify({
          concept_doi: result.doi,
          provider,
          provider_record_id: result.providerRecordId,
          sandbox: body.sandbox,
        }),
      }).run();

      // Build response based on provider
      const response: Record<string, unknown> = {
        message: "Concept DOI created successfully",
        concept_doi: result.doi,
        provider,
        warning:
          "DOI is pre-reserved but not yet published. It will become active on first version publish.",
      };

      if (bidsMetadataWarning) {
        response.metadata_warning = bidsMetadataWarning;
      }

      if (provider === "ezid") {
        response.ezid_identifier = result.providerRecordId;
        response.doi_url = `https://doi.org/${result.doi}`;
      } else {
        const zenodoId = Number.parseInt(result.providerRecordId);
        if (!Number.isNaN(zenodoId)) {
          response.zenodo_id = zenodoId;
          response.zenodo_url = formatRecordUrl(zenodoId, body.sandbox);
        }
      }

      return c.json(response);
    } catch (error) {
      console.error("Failed to create concept DOI:", error);
      return c.json(
        {
          error: "Failed to create concept DOI",
          details: errorMessage(error),
        },
        500,
      );
    }
  });

  /**
   * POST /admin/datasets/:id/doi/publish - Publish a version DOI
   *
   * Admin endpoint to manually publish a version DOI.
   * For automated publishing, see the webhook in webhooks.ts.
   */
  const publishVersionDoiSchema = z.object({
    version: z.string(),
    release_url: z.string().url(),
    sandbox: z.boolean().optional().default(false),
  });

  admin.post(
    "/datasets/:id/doi/publish",
    zValidator("json", publishVersionDoiSchema),
    async (c) => {
      const datasetId = c.req.param("id");
      const body = c.req.valid("json");
      const adminUser = c.get("user");
      const db = c.env.DB;

      // Get dataset info
      const dataset = await db
        .prepare(
          `
    SELECT d.*, u.username as owner_username
    FROM datasets d
    JOIN users u ON d.owner_user_id = u.id
    WHERE d.dataset_id = ?
  `,
        )
        .bind(datasetId)
        .first<{
          id: number;
          dataset_id: string;
          name: string;
          description: string | null;
          concept_doi: string | null;
          zenodo_concept_id: string | null;
          owner_username: string;
          is_sandbox: number | null;
          is_exemplar: number | null;
        }>();

      if (!dataset) {
        return c.json({ error: "Dataset not found" }, 404);
      }

      // Block DOI publishing for sandbox datasets, except staging exemplars (epic #923).
      if (
        (dataset.is_sandbox || dataset.dataset_id.startsWith("xx")) &&
        !isExemplarPublishAllowed(c.env, dataset)
      ) {
        return c.json(
          {
            error: "Cannot publish DOI for sandbox datasets",
            message:
              "Sandbox datasets are for testing only. DOIs are permanent and should only be created for real datasets.",
            dataset_id: dataset.dataset_id,
          },
          400,
        );
      }

      if (!dataset.concept_doi || !dataset.zenodo_concept_id) {
        return c.json(
          {
            error: "Dataset does not have a concept DOI",
            message: "Create a concept DOI first with POST /admin/datasets/:id/doi/concept",
          },
          400,
        );
      }

      const zenodoToken = body.sandbox ? c.env.ZENODO_SANDBOX_API_KEY : c.env.ZENODO_API_KEY;

      if (!zenodoToken) {
        return c.json({ error: "Zenodo API key not configured" }, 500);
      }

      try {
        // Check if this is the first version (concept deposition not yet published)
        const conceptDeposition = await getDeposition(
          Number.parseInt(dataset.zenodo_concept_id),
          zenodoToken,
          body.sandbox,
        );

        let versionDeposition: ZenodoDeposition;

        if (!conceptDeposition.submitted) {
          // First version - use the concept deposition directly
          versionDeposition = conceptDeposition;

          // Update metadata with version
          // Metadata is already set from concept creation; version-specific fields updated below
        } else {
          // Create a new version
          versionDeposition = await createNewVersion(
            Number.parseInt(dataset.zenodo_concept_id),
            zenodoToken,
            body.sandbox,
          );
        }

        // Download the release zip from GitHub
        const releaseZipUrl = body.release_url.endsWith(".zip")
          ? body.release_url
          : `${body.release_url.replace(/\/$/, "")}/archive/refs/tags/${body.version}.zip`;

        console.log(`Downloading release from: ${releaseZipUrl}`);

        const zipContent = await downloadFile(releaseZipUrl);
        const zipFilename = `${datasetId}-${body.version}.zip`;

        // Upload to Zenodo
        if (versionDeposition.links.bucket) {
          await uploadFile(
            versionDeposition.id,
            versionDeposition.links.bucket,
            zipFilename,
            zipContent,
            zenodoToken,
          );
        } else {
          throw new Error("Zenodo deposition has no bucket URL for uploads");
        }

        // Publish the deposition
        const publishedDeposition = await publishDeposition(
          versionDeposition.id,
          zenodoToken,
          body.sandbox,
        );

        const versionDoi = publishedDeposition.doi || publishedDeposition.metadata?.doi;

        // Update dataset with version DOI (zenodo_latest_version_id was
        // dropped in #1182; the deposition id still lands in the audit log).
        await db
          .prepare(
            `
      UPDATE datasets
      SET latest_version_doi = ?,
          updated_at = datetime('now')
      WHERE dataset_id = ?
    `,
          )
          .bind(versionDoi || null, datasetId)
          .run();

        // Audit log
        await auditLogStatement(db, {
          userId: adminUser.id,
          action: "doi_version_published",
          resourceType: "dataset",
          resourceId: datasetId,
          details: JSON.stringify({
            version: body.version,
            version_doi: versionDoi,
            zenodo_id: publishedDeposition.id,
            sandbox: body.sandbox,
          }),
        }).run();

        return c.json({
          message: "Version DOI published successfully",
          version: body.version,
          version_doi: versionDoi,
          concept_doi: dataset.concept_doi,
          zenodo_url: formatRecordUrl(publishedDeposition.id, body.sandbox),
          warning: "DOI is now PERMANENT and cannot be deleted.",
        });
      } catch (error) {
        console.error("Failed to publish version DOI:", error);
        return c.json(
          {
            error: "Failed to publish version DOI",
            details: errorMessage(error),
          },
          500,
        );
      }
    },
  );

  /**
   * GET /admin/datasets/:id/doi - Get DOI info for a dataset
   */
  admin.get("/datasets/:id/doi", async (c) => {
    const datasetId = c.req.param("id");
    const db = c.env.DB;

    const dataset = await db
      .prepare(
        `
    SELECT dataset_id, name, concept_doi, latest_version_doi,
           zenodo_concept_id, ezid_status
    FROM datasets
    WHERE dataset_id = ?
  `,
      )
      .bind(datasetId)
      .first<{
        dataset_id: string;
        name: string;
        concept_doi: string | null;
        latest_version_doi: string | null;
        zenodo_concept_id: string | null;
        ezid_status: string | null;
      }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    // doi_provider and ezid_identifier are no longer stored (#1182):
    // EZID is the sole provider (ADR 0007) and the identifier derives from
    // concept_doi. zenodo_latest_version_url is gone with its column;
    // zenodo_concept_id survives as the doomsday backup reference.
    return c.json({
      dataset_id: dataset.dataset_id,
      name: dataset.name,
      concept_doi: dataset.concept_doi,
      latest_version_doi: dataset.latest_version_doi,
      doi_provider: "ezid",
      zenodo_concept_url: dataset.zenodo_concept_id
        ? formatRecordUrl(Number.parseInt(dataset.zenodo_concept_id))
        : null,
      ezid_identifier: dataset.concept_doi ? conceptEzidIdentifier(dataset.concept_doi) : null,
      ezid_status: dataset.ezid_status,
      doi_url: dataset.concept_doi ? `https://doi.org/${dataset.concept_doi}` : null,
    });
  });

  /**
   * POST /admin/datasets/:id/doi/update - Update EZID DOI metadata or status
   *
   * Allows updating metadata (re-generate DataCite XML from BIDS) or
   * changing status (reserved -> public, or public -> unavailable).
   */
  const updateDoiSchema = z.object({
    status: z.enum(["public", "unavailable"]).optional(),
    refresh_metadata: z.boolean().optional().default(false),
  });

  admin.post("/datasets/:id/doi/update", zValidator("json", updateDoiSchema), async (c) => {
    const datasetId = c.req.param("id");
    const body = c.req.valid("json");
    const db = c.env.DB;
    // Resolved once per request; reused by every DOI _target in this handler.
    const landingBase = resolveDatasetLandingBase(c.env);

    const dataset = await db
      .prepare(
        `
      SELECT d.dataset_id, d.concept_doi, d.ezid_status,
             d.github_repo, d.name, d.is_sandbox,
             u.username as owner_username, u.orcid as owner_orcid
      FROM datasets d
      JOIN users u ON d.owner_user_id = u.id
      WHERE d.dataset_id = ?
    `,
      )
      .bind(datasetId)
      .first<{
        dataset_id: string;
        concept_doi: string | null;
        ezid_status: string | null;
        github_repo: string | null;
        name: string;
        is_sandbox: number | null;
        owner_username: string;
        owner_orcid: string | null;
      }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    // EZID is the sole provider (ADR 0007); the identifier derives from
    // concept_doi (#1182), so "has a concept DOI" is the whole gate.
    if (!dataset.concept_doi) {
      return c.json({ error: "DOI update is only supported for EZID-managed DOIs" }, 400);
    }
    const conceptIdentifier = conceptEzidIdentifier(dataset.concept_doi);

    const isSandbox = !!dataset.is_sandbox;
    let auth: EzidAuth;
    try {
      auth = resolveEzidAuth(
        {
          EZID_USERNAME: c.env.EZID_USERNAME,
          EZID_PASSWORD: c.env.EZID_PASSWORD,
          EZID_SANDBOX_USERNAME: c.env.EZID_SANDBOX_USERNAME,
          EZID_SANDBOX_PASSWORD: c.env.EZID_SANDBOX_PASSWORD,
        },
        isSandbox,
      );
    } catch (err) {
      console.error("[admin] EZID auth failed:", err);
      return c.json({ error: "EZID credentials not configured" }, 500);
    }

    try {
      const updateOptions: {
        status?: "public" | "unavailable";
        dataciteXml?: string;
        target?: string;
      } = {};
      let metadataRefreshed = false;
      const warnings: string[] = [];

      // Refresh metadata from BIDS
      if (body.refresh_metadata) {
        if (!dataset.github_repo) {
          return c.json(
            { error: "Cannot refresh metadata: dataset has no GitHub repository" },
            400,
          );
        }
        const repoName = dataset.github_repo.split("/")[1];
        if (!repoName) {
          return c.json({ error: "Cannot refresh metadata: invalid github_repo format" }, 400);
        }
        const pat = await getDatasetsToken(c.env);
        const tree = await getTreeAtRef(repoName, "main", pat);
        const descFile = tree.find((f) => f.path === "dataset_description.json");
        if (!descFile) {
          return c.json(
            { error: "Cannot refresh metadata: dataset_description.json not found in repo" },
            400,
          );
        }
        const content = await getBlobContent(repoName, descFile.sha, pat);
        const parsed = JSON.parse(content);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return c.json(
            {
              error: "Cannot refresh metadata: dataset_description.json is not a valid JSON object",
            },
            400,
          );
        }
        const bidsDesc = parsed as Record<string, unknown>;
        const doi = extractDoi(conceptIdentifier);
        let enrichment = buildOrcidEnrichment(
          bidsDesc,
          dataset.owner_username,
          dataset.owner_orcid || undefined,
        );

        // Read enrichment metadata (.nemar/metadata.json first, fall back to nemar_metadata.json)
        const nemarMetaFile =
          tree.find((f) => f.path === ".nemar/metadata.json") ||
          tree.find((f) => f.path === "nemar_metadata.json");
        if (nemarMetaFile) {
          try {
            const nemarContent = await getBlobContent(repoName, nemarMetaFile.sha, pat);
            const nemarParsed = parseNemarMetadata(JSON.parse(nemarContent));
            if (nemarParsed) {
              enrichment = nemarMetadataToEnrichment(nemarParsed, enrichment);
            }
          } catch (nemarErr) {
            console.error("Failed to parse nemar_metadata.json:", nemarErr);
            warnings.push(
              `nemar_metadata.json enrichment skipped: ${nemarErr instanceof Error ? nemarErr.message : String(nemarErr)}`,
            );
          }
        }

        // Add HasVersion relations for all existing version DOIs
        const versions = await db
          .prepare(
            "SELECT version, doi FROM dataset_versions WHERE dataset_id = ? ORDER BY created_at DESC",
          )
          .bind(datasetId)
          .all<{ version: string; doi: string }>();
        if (versions.results?.length) {
          const hasVersionRels = versions.results.map((v) => ({
            doi: v.doi,
            relationType: "HasVersion" as const,
          }));
          enrichment.relatedDois = [...(enrichment.relatedDois || []), ...hasVersionRels];
        }

        const metadata = bidsToDataCite(datasetId, doi, bidsDesc, enrichment);
        updateOptions.dataciteXml = buildDataCiteXml(metadata);
        updateOptions.target = datasetLandingUrl(datasetId, landingBase);
        metadataRefreshed = true;
      }

      // Change status
      if (body.status) {
        if (body.status === "public" && dataset.ezid_status === "reserved") {
          updateOptions.status = "public";
          updateOptions.target = datasetLandingUrl(datasetId, landingBase);
        } else if (body.status === "unavailable") {
          updateOptions.status = "unavailable";
        }
      }

      const updated = await ezidUpdateIdentifier(auth, conceptIdentifier, updateOptions);

      // Update DB
      await db
        .prepare(
          "UPDATE datasets SET ezid_status = ?, updated_at = datetime('now') WHERE dataset_id = ?",
        )
        .bind(updated.status, datasetId)
        .run();

      // Also refresh version DOIs if metadata was refreshed
      let versionDoiUpdated = 0;
      if (metadataRefreshed) {
        const versions = await db
          .prepare(
            "SELECT version, doi FROM dataset_versions WHERE dataset_id = ? ORDER BY created_at DESC",
          )
          .bind(datasetId)
          .all<{ version: string; doi: string }>();

        const pat = await getDatasetsToken(c.env);
        for (const ver of versions.results || []) {
          try {
            const versionIdentifier = `${conceptIdentifier}.V${ver.version.toUpperCase()}`;
            const repoName = dataset.github_repo?.split("/")[1];
            if (!repoName) {
              warnings.push(`Version ${ver.version}: skipped DOI update (no valid github_repo)`);
              continue;
            }
            const tree = await getTreeAtRef(repoName, "main", pat);
            const descFile = tree.find((f) => f.path === "dataset_description.json");
            if (!descFile) continue;
            const content = await getBlobContent(repoName, descFile.sha, pat);
            const bidsDesc = JSON.parse(content) as Record<string, unknown>;

            let vEnrichment = buildOrcidEnrichment(
              bidsDesc,
              dataset.owner_username,
              dataset.owner_orcid || undefined,
            );
            const nemarMetaFile =
              tree.find((f) => f.path === ".nemar/metadata.json") ||
              tree.find((f) => f.path === "nemar_metadata.json");
            if (nemarMetaFile) {
              try {
                const nemarContent = await getBlobContent(repoName, nemarMetaFile.sha, pat);
                const nemarParsed = parseNemarMetadata(JSON.parse(nemarContent));
                if (nemarParsed) vEnrichment = nemarMetadataToEnrichment(nemarParsed, vEnrichment);
              } catch (metaErr) {
                console.warn(
                  `[doi/update] Metadata enrichment skipped for version ${ver.version}: ${metaErr instanceof Error ? metaErr.message : String(metaErr)}`,
                );
              }
            }

            const vDoi = extractDoi(versionIdentifier);
            const vMetadata = bidsToDataCite(datasetId, vDoi, bidsDesc, vEnrichment);
            vMetadata.version = ver.version;
            const vXml = buildDataCiteXml(vMetadata);
            const vTarget = datasetVersionLandingUrl(datasetId, ver.version, landingBase);
            await ezidUpdateIdentifier(auth, versionIdentifier, {
              dataciteXml: vXml,
              target: vTarget,
            });
            versionDoiUpdated++;
          } catch (vErr) {
            warnings.push(
              `Version ${ver.version} DOI update failed: ${vErr instanceof Error ? vErr.message : String(vErr)}`,
            );
          }
        }
      }

      return c.json({
        message: "DOI updated successfully",
        ezid_identifier: conceptIdentifier,
        status: updated.status,
        doi_url: `https://doi.org/${extractDoi(conceptIdentifier)}`,
        metadata_refreshed: metadataRefreshed,
        version_dois_updated: versionDoiUpdated,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    } catch (error) {
      console.error("Failed to update DOI:", error);
      return c.json(
        {
          error: "Failed to update DOI",
          details: errorMessage(error),
        },
        500,
      );
    }
  });

  /**
   * POST /admin/datasets/:id/enrichment - Submit rich metadata enrichment
   *
   * Accepts NemarMetadata JSON (v1.0 or v2.0), commits to the dataset repo
   * (v1 at nemar_metadata.json, v2 at .nemar/metadata.json),
   * ensures .bidsignore includes the path, and caches in D1.
   */
  const enrichmentSchemaV1 = z.object({
    version: z.literal("1.0"),
    authors: z
      .record(
        z.object({
          orcid: z.string().optional(),
          affiliation: z.string().optional(),
        }),
      )
      .optional(),
    keywords: z.array(z.string()).optional(),
    relatedDois: z
      .array(
        z.object({
          doi: z.string(),
          relationType: z.string(),
        }),
      )
      .optional(),
    fundingReferences: z
      .array(
        z.object({
          funderName: z.string(),
          awardNumber: z.string().optional(),
          awardTitle: z.string().optional(),
        }),
      )
      .optional(),
    description: z.string().optional(),
    methodsDescription: z.string().optional(),
    collectionDates: z.string().optional(),
    geoLocation: z.string().optional(),
    sizes: z.array(z.string()).optional(),
    formats: z.array(z.string()).optional(),
  });

  const enrichmentSchemaV2 = z
    .object({
      version: z.literal("2.0"),
      pipeline_stage: z.enum(["seeded", "enriched", "validated"]).optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      methods_description: z.string().optional(),
      license: z.string().optional(),
      dataset_type: z.string().optional(),
      resource_type_general: z.string().optional(),
      resource_type_specific: z.string().optional(),
      modalities: z.array(z.string()).optional(),
      sizes: z.array(z.string()).optional(),
      formats: z.array(z.string()).optional(),
      source_hash: z.string().optional(),
      authors: z
        .record(
          z.object({
            orcid: z.string().optional(),
            affiliations: z
              .array(
                z.object({
                  name: z.string(),
                  identifier: z.string().optional(),
                  scheme: z.string().optional(),
                }),
              )
              .optional(),
          }),
        )
        .optional(),
      keywords: z
        .array(
          z.object({
            term: z.string(),
            subject_scheme: z.string().optional(),
            scheme_uri: z.string().optional(),
            value_uri: z.string().optional(),
            classification_code: z.string().optional(),
          }),
        )
        .optional(),
      related_identifiers: z
        .array(
          z.object({
            identifier: z.string(),
            identifier_type: z.string(),
            relation_type: z.string(),
            resource_type_general: z.string().optional(),
          }),
        )
        .optional(),
      funding_references: z
        .array(
          z.object({
            funder_name: z.string(),
            funder_identifier: z.string().optional(),
            funder_identifier_type: z.string().optional(),
            award_number: z.string().optional(),
            award_title: z.string().optional(),
            award_uri: z.string().optional(),
          }),
        )
        .optional(),
      contributors: z
        .array(
          z.object({
            name: z.string(),
            name_type: z.string().optional(),
            given_name: z.string().optional(),
            family_name: z.string().optional(),
            orcid: z.string().optional(),
            contributor_type: z.string(),
          }),
        )
        .optional(),
      dates: z
        .array(
          z.object({
            date: z.string(),
            date_type: z.string(),
            date_information: z.string().optional(),
          }),
        )
        .optional(),
      geo_locations: z
        .array(
          z.object({
            place: z.string().optional(),
            point: z
              .object({
                latitude: z.number(),
                longitude: z.number(),
              })
              .optional(),
          }),
        )
        .optional(),
    })
    .passthrough();

  const enrichmentSchema = z.discriminatedUnion("version", [
    enrichmentSchemaV1,
    enrichmentSchemaV2,
  ]);

  admin.post("/datasets/:id/enrichment", zValidator("json", enrichmentSchema), async (c) => {
    const datasetId = c.req.param("id");
    const body = c.req.valid("json");
    const db = c.env.DB;

    const dataset = await db
      .prepare("SELECT dataset_id, github_repo, is_sandbox FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{
        dataset_id: string;
        github_repo: string | null;
        is_sandbox: number | null;
      }>();

    if (!dataset) {
      return c.json({ error: "Dataset not found" }, 404);
    }

    if (!dataset.github_repo) {
      return c.json({ error: "Dataset has no GitHub repository" }, 400);
    }

    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) {
      return c.json({ error: "Invalid github_repo format" }, 400);
    }

    const pat = await getDatasetsToken(c.env);
    const metadataContent = JSON.stringify(body, null, 2);
    const isV2 = body.version === "2.0";
    const metadataPath = isV2 ? ".nemar/metadata.json" : "nemar_metadata.json";

    const entriesToIgnore = isV2 ? [".nemar/"] : ["nemar_metadata.json"];

    try {
      const commitResult = await commitEnrichmentWithBidsignore(
        repoName,
        "main",
        metadataPath,
        metadataContent,
        entriesToIgnore,
        "Update NEMAR metadata enrichment",
        pat,
      );
      if (commitResult.bidsignoreReadError) {
        console.warn(
          `[enrichment] Could not read .bidsignore for ${datasetId}; committed metadata alone: ${commitResult.bidsignoreReadError}`,
        );
      }

      await db
        .prepare(
          "UPDATE datasets SET enrichment_json = ?, sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.enrichment_updated_at', datetime('now')), updated_at = datetime('now') WHERE dataset_id = ?",
        )
        .bind(metadataContent, datasetId)
        .run();

      return c.json({
        message: "Enrichment saved",
        dataset_id: datasetId,
        committed: true,
        bidsignore_updated: commitResult.bidsignoreUpdated,
        commit_mode: commitResult.commitMode,
        ...(commitResult.bidsignoreReadError
          ? { bidsignore_read_error: commitResult.bidsignoreReadError }
          : {}),
      });
    } catch (error) {
      console.error("Failed to save enrichment:", error);
      return c.json(
        {
          error: "Failed to save enrichment",
          details: errorMessage(error),
        },
        500,
      );
    }
  });

  /**
   * GET /admin/datasets/:id/files - Get dataset file listing with sizes
   *
   * Returns file listing from the GitHub repo tree for computing sizes and formats.
   */
  admin.get("/datasets/:id/files", async (c) => {
    const datasetId = c.req.param("id");
    const db = c.env.DB;

    const dataset = await db
      .prepare("SELECT github_repo FROM datasets WHERE dataset_id = ?")
      .bind(datasetId)
      .first<{ github_repo: string | null }>();

    if (!dataset?.github_repo) {
      return c.json({ error: "Dataset not found or has no GitHub repository" }, 404);
    }

    const repoName = dataset.github_repo.split("/")[1];
    if (!repoName) {
      return c.json({ error: "Invalid github_repo format" }, 400);
    }

    try {
      const tree = await getTreeAtRef(repoName, "main", await getDatasetsToken(c.env));
      const files = tree
        .filter((f) => f.type === "blob")
        .map((f) => ({ path: f.path, size: f.size || 0 }));

      // Use S3 for real sizes (git tree shows symlink sizes for annexed files)
      let totalSize = files.reduce((sum, f) => sum + f.size, 0);
      let fileCount = files.length;
      const { getDatasetS3Stats, extractExtensions } = await import("../../services/s3.js");
      try {
        const s3Stats = await getDatasetS3Stats(
          {
            bucket: c.env.S3_BUCKET,
            region: c.env.AWS_REGION,
            accessKeyId: c.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
          },
          datasetId,
        );
        if (s3Stats.totalSize > totalSize) {
          totalSize = s3Stats.totalSize;
          fileCount = s3Stats.objectCount ?? fileCount;
        }
      } catch (s3Err) {
        console.warn(
          `[admin/files] S3 stats failed for ${datasetId}, using tree sizes: ${s3Err instanceof Error ? s3Err.message : String(s3Err)}`,
        );
      }

      const extensions = extractExtensions(files.map((f) => f.path));

      return c.json({
        dataset_id: datasetId,
        file_count: fileCount,
        total_size: totalSize,
        extensions,
        files,
      });
    } catch (error) {
      console.error("Failed to fetch file listing:", error);
      return c.json(
        {
          error: "Failed to fetch file listing",
          details: errorMessage(error),
        },
        500,
      );
    }
  });

  /**
   * DELETE /admin/zenodo/deposition/:id - Delete unpublished Zenodo deposition
   *
   * Used by tests to cleanup unpublished depositions in sandbox.
   * WARNING: Only works for unpublished depositions. Published DOIs cannot be deleted.
   */
  admin.delete("/zenodo/deposition/:id", async (c) => {
    const depositionId = Number.parseInt(c.req.param("id"));
    const sandbox = c.req.query("sandbox") === "true";

    // Get appropriate token
    const zenodoToken = sandbox ? c.env.ZENODO_SANDBOX_API_KEY : c.env.ZENODO_API_KEY;

    if (!zenodoToken) {
      return c.json(
        {
          error: "Zenodo API token not configured",
          message: sandbox ? "ZENODO_SANDBOX_API_KEY not set" : "ZENODO_API_KEY not set",
        },
        500,
      );
    }

    try {
      await deleteDeposition(depositionId, zenodoToken, sandbox);
      return c.body(null, 204);
    } catch (error) {
      const errMsg = errorMessage(error);
      console.error(`Failed to delete Zenodo deposition ${depositionId}:`, errMsg);

      return c.json(
        {
          error: "Failed to delete deposition",
          message: errMsg,
          deposition_id: depositionId,
          sandbox,
        },
        500,
      );
    }
  });
}
