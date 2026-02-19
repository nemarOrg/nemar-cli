/**
 * Webhook routes for GitHub Actions integration
 *
 * These endpoints are called by GitHub Actions workflows
 * and authenticated via a shared secret token.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import type { NemarMetadataV2 } from "../../../shared/datacite-constants.js";

/** Constant-time string comparison to prevent timing attacks on secret tokens. */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}
import { parseNemarMetadata } from "../services/datacite.js";
import { createEzidVersionDoi, parseDoiProvider } from "../services/doi.js";
import { TEST_SHOULDER, extractDoi } from "../services/ezid.js";
import {
  createOrUpdateFile,
  downloadReleaseArchive,
  getBlobContent,
  getTreeAtRef,
} from "../services/github.js";
import {
  correctFromFeedback,
  enrichFromReadme,
  mergeWithExisting,
  seedFromBids,
  validateMeshTerms,
  validateMetadata,
} from "../services/llm-enrich.js";
import { generateManifest } from "../services/manifest.js";
import { errorMessage, extractRepoName, readRepoMetadata } from "../services/repo-metadata.js";
import { uploadManifest } from "../services/s3.js";
import * as zenodo from "../services/zenodo.js";
import type { Bindings } from "../types/bindings.js";

type WebhookContext = Context<{ Bindings: Bindings }>;

const webhooks = new Hono<{ Bindings: Bindings }>();

/**
 * Publish a version DOI for a dataset
 *
 * Called by GitHub Actions when a new release is created.
 * Requires X-Webhook-Token header matching GITHUB_WEBHOOK_SECRET.
 *
 * Routes to EZID or Zenodo based on dataset's doi_provider setting.
 */
webhooks.post("/publish-version-doi", async (c) => {
  // Validate webhook token
  const token = c.req.header("X-Webhook-Token");
  const expectedToken = c.env.GITHUB_WEBHOOK_SECRET;

  // If webhook secret not configured OR token doesn't match, reject as unauthorized
  // Treat missing secret as "no valid token exists" for better security
  if (!expectedToken || !token || !timingSafeEqual(token, expectedToken)) {
    return c.json({ error: "Invalid webhook token" }, 401);
  }

  // Parse request body
  let body: { dataset_id: string; version: string; release_url: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  if (!body.dataset_id || !body.version || !body.release_url) {
    return c.json({ error: "Missing required fields: dataset_id, version, release_url" }, 400);
  }

  const { dataset_id, version: rawVersion, release_url } = body;

  // Normalize version: strip leading "v" or "V" prefix if present
  const version = rawVersion.replace(/^[vV]/, "");

  // Validate semver format: only stable versions get permanent DOIs.
  // Pre-release versions (beta, rc, dev) are transient and must not receive
  // permanent identifiers.
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.info(
      `[webhook] Skipping DOI for ${dataset_id} version "${rawVersion}": not a stable semver`,
    );
    return c.json(
      {
        error: `Invalid version format: "${rawVersion}". Only stable semver versions (e.g., 1.0.0) are supported for DOI minting.`,
        skipped: true,
      },
      200,
    );
  }

  // Get dataset from database
  const dataset = await c.env.DB.prepare("SELECT * FROM datasets WHERE dataset_id = ?")
    .bind(dataset_id)
    .first<{
      id: number;
      dataset_id: string;
      name: string;
      description: string | null;
      github_repo: string | null;
      concept_doi: string | null;
      zenodo_concept_id: string | null;
      ezid_identifier: string | null;
      ezid_status: string | null;
      doi_provider: string | null;
    }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  // Check if concept DOI exists
  if (!dataset.concept_doi) {
    return c.json(
      {
        error: "No concept DOI exists for this dataset. Admin must create concept DOI first.",
        skipped: true,
      },
      200,
    ); // Return 200 so workflow doesn't fail
  }

  const provider = parseDoiProvider(dataset.doi_provider);

  // Auto-detect sandbox from EZID test shoulder prefix
  const sandboxPrefix = TEST_SHOULDER.replace(/^doi:/, "").split("/")[0];
  const sandbox =
    provider === "ezid" && dataset.ezid_identifier
      ? dataset.ezid_identifier.includes(sandboxPrefix)
      : false;

  // Route to appropriate provider
  if (provider === "ezid") {
    return handleEzidVersionDoi(c, dataset, version, release_url, sandbox);
  }
  return handleZenodoVersionDoi(c, dataset, version, release_url, sandbox);
});

/**
 * Handle EZID version DOI creation: reads BIDS metadata, mints DOI, updates DB, and generates version manifest.
 */
async function handleEzidVersionDoi(
  c: WebhookContext,
  dataset: {
    id: number;
    dataset_id: string;
    name: string;
    description: string | null;
    github_repo: string | null;
    concept_doi: string | null;
    ezid_identifier: string | null;
  },
  version: string,
  _releaseUrl: string,
  sandbox: boolean,
) {
  if (!dataset.ezid_identifier) {
    return c.json(
      {
        error: "No EZID identifier found for this dataset.",
        skipped: true,
      },
      200,
    );
  }

  if (!dataset.github_repo) {
    return c.json({ error: "Dataset has no GitHub repository" }, 400);
  }

  const repoName = extractRepoName(dataset.github_repo);
  if (!repoName) {
    return c.json({ error: "Invalid github_repo format" }, 400);
  }

  try {
    // Read BIDS + NEMAR metadata from the release tag (not main)
    const repoMeta = await readRepoMetadata(
      repoName,
      c.env.GITHUB_ADMIN_PAT,
      undefined,
      dataset.name,
      `v${version}`,
    );
    const { bidsDescription, enrichment } = repoMeta;
    for (const w of repoMeta.warnings) {
      console.error("[webhook]", w);
    }

    // Query all existing version DOIs so concept DOI keeps all HasVersion relations
    const versionRows = await c.env.DB.prepare(
      "SELECT doi FROM dataset_versions WHERE dataset_id = ?",
    )
      .bind(dataset.dataset_id)
      .all<{ doi: string }>();
    const existingVersionDois = versionRows.results.map((r) => r.doi);

    const result = await createEzidVersionDoi(
      {
        EZID_USERNAME: c.env.EZID_USERNAME,
        EZID_PASSWORD: c.env.EZID_PASSWORD,
        EZID_SANDBOX_USERNAME: c.env.EZID_SANDBOX_USERNAME,
        EZID_SANDBOX_PASSWORD: c.env.EZID_SANDBOX_PASSWORD,
      },
      {
        datasetId: dataset.dataset_id,
        conceptIdentifier: dataset.ezid_identifier,
        version,
        bidsDescription,
        githubRepo: dataset.github_repo,
        sandbox,
        existingVersionDois,
        enrichment,
      },
    );

    // DOI is now public and permanent. DB and manifest failures below are
    // non-fatal but must be surfaced in the response for operator awareness.
    let dbError: string | undefined;
    try {
      await c.env.DB.prepare(
        "UPDATE datasets SET latest_version_doi = ?, updated_at = datetime('now') WHERE id = ?",
      )
        .bind(result.doi, dataset.id)
        .run();

      await c.env.DB.prepare(
        "INSERT OR IGNORE INTO dataset_versions (dataset_id, version, doi, provider) VALUES (?, ?, ?, 'ezid')",
      )
        .bind(dataset.dataset_id, version, result.doi)
        .run();
    } catch (err) {
      dbError = errorMessage(err);
      console.error(`[webhook] DOI ${result.doi} is PUBLIC but DB update failed:`, err);
    }

    // Generate and upload version manifest
    let manifestGenerated = false;
    let manifestErrorMsg: string | undefined;
    try {
      const manifest = await generateManifest(
        repoName,
        version,
        c.env.GITHUB_ADMIN_PAT,
        dataset.dataset_id,
        result.doi,
        dataset.concept_doi,
      );

      await uploadManifest(
        {
          bucket: c.env.S3_BUCKET,
          region: c.env.AWS_REGION,
          accessKeyId: c.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
        },
        dataset.dataset_id,
        version,
        JSON.stringify(manifest, null, 2),
      );
      manifestGenerated = true;
    } catch (manifestErr) {
      manifestErrorMsg = errorMessage(manifestErr);
      console.error(
        `[webhook] Manifest generation failed for ${dataset.dataset_id}@${version}:`,
        manifestErr,
      );
    }

    // Upload archive to Zenodo as draft backup (non-fatal)
    let zenodoBackup: string | undefined;
    let zenodoBackupError: string | undefined;
    try {
      const zenodoToken = sandbox ? c.env.ZENODO_SANDBOX_API_KEY : c.env.ZENODO_API_KEY;
      if (!zenodoToken) {
        console.info(
          `[webhook] Zenodo backup skipped for ${dataset.dataset_id}: no ${sandbox ? "sandbox " : ""}API key configured`,
        );
      } else if (!dataset.github_repo) {
        console.info(
          `[webhook] Zenodo backup skipped for ${dataset.dataset_id}: no GitHub repo configured`,
        );
      }
      if (zenodoToken && dataset.github_repo) {
        const tag = `v${version}`;
        const archiveData = await downloadReleaseArchive(repoName, tag, c.env.GITHUB_ADMIN_PAT);

        // Check if dataset already has a Zenodo backup deposition
        const row = await c.env.DB.prepare("SELECT zenodo_concept_id FROM datasets WHERE id = ?")
          .bind(dataset.id)
          .first<{ zenodo_concept_id: string | null }>();

        let depositionId = row?.zenodo_concept_id
          ? Number.parseInt(row.zenodo_concept_id, 10)
          : Number.NaN;

        if (Number.isNaN(depositionId)) {
          // Create initial Zenodo draft deposition
          const deposition = await zenodo.createDeposition(
            {
              title: `${dataset.name} (NEMAR backup archive)`,
              description: `Backup archive for NEMAR dataset ${dataset.dataset_id}. Primary DOI: ${dataset.concept_doi}`,
              creators: [{ name: "NEMAR" }],
              keywords: ["BIDS", "neuroscience", "NEMAR", "backup"],
              version,
            },
            zenodoToken,
            sandbox,
          );
          depositionId = deposition.id;
          await c.env.DB.prepare(
            "UPDATE datasets SET zenodo_concept_id = ?, updated_at = datetime('now') WHERE id = ?",
          )
            .bind(String(depositionId), dataset.id)
            .run();
        } else {
          // Create a new version draft from existing deposition
          const newVersion = await zenodo.createNewVersion(depositionId, zenodoToken, sandbox);
          depositionId = newVersion.id;
          await zenodo.updateDepositionMetadata(
            depositionId,
            {
              title: `${dataset.name} (NEMAR backup archive)`,
              description: `Backup archive v${version}`,
              creators: [{ name: "NEMAR" }],
              version,
            },
            zenodoToken,
            sandbox,
          );
        }

        const deposition = await zenodo.getDeposition(depositionId, zenodoToken, sandbox);
        if (deposition.links.bucket) {
          await zenodo.uploadFile(
            depositionId,
            deposition.links.bucket,
            `${dataset.dataset_id}-v${version}.zip`,
            archiveData,
            zenodoToken,
            sandbox,
          );
          zenodoBackup = `Zenodo draft #${depositionId}`;
        } else {
          console.warn(
            `[webhook] Zenodo deposition #${depositionId} has no bucket URL; file upload skipped`,
          );
          zenodoBackupError = `Zenodo deposition #${depositionId} has no bucket URL`;
        }
      }
    } catch (zenodoErr) {
      zenodoBackupError = errorMessage(zenodoErr);
      console.error(
        `[webhook] Zenodo backup failed for ${dataset.dataset_id}@${version} (non-fatal):`,
        zenodoErr,
      );
    }

    return c.json({
      message: "Version DOI published successfully",
      version,
      version_doi: result.doi,
      concept_doi: dataset.concept_doi,
      provider: "ezid",
      doi_url: `https://doi.org/${result.doi}`,
      manifest_generated: manifestGenerated,
      ...(zenodoBackup && { zenodo_backup: zenodoBackup }),
      ...(repoMeta.warnings.length > 0 && { metadata_warnings: repoMeta.warnings }),
      ...(dbError && { db_error: dbError }),
      ...(manifestErrorMsg && { manifest_error: manifestErrorMsg }),
      ...(zenodoBackupError && { zenodo_backup_error: zenodoBackupError }),
      ...(result.warnings && { doi_warnings: result.warnings }),
    });
  } catch (error) {
    console.error("EZID version DOI error:", error);
    return c.json(
      {
        error: "Failed to publish version DOI via EZID",
        details: errorMessage(error),
      },
      500,
    );
  }
}

/**
 * Handle Zenodo version DOI creation: downloads release, uploads to Zenodo, publishes, and generates version manifest.
 */
async function handleZenodoVersionDoi(
  c: WebhookContext,
  dataset: {
    id: number;
    dataset_id: string;
    name: string;
    description: string | null;
    github_repo: string | null;
    concept_doi: string | null;
    zenodo_concept_id: string | null;
  },
  version: string,
  release_url: string,
  sandbox: boolean,
) {
  if (!dataset.zenodo_concept_id) {
    return c.json(
      {
        error: "No Zenodo concept ID found. Cannot create version DOI.",
        skipped: true,
      },
      200,
    );
  }

  const zenodoToken = sandbox ? c.env.ZENODO_SANDBOX_API_KEY : c.env.ZENODO_API_KEY;
  if (!zenodoToken) {
    return c.json({ error: `Zenodo ${sandbox ? "sandbox " : ""}API key not configured` }, 500);
  }

  try {
    // Create a new version from the concept deposition
    const conceptId = Number.parseInt(dataset.zenodo_concept_id);
    const newVersion = await zenodo.createNewVersion(conceptId, zenodoToken, sandbox);

    // Verify we have a bucket URL for upload
    if (!newVersion.links.bucket) {
      throw new Error("New version deposition has no upload bucket");
    }

    // Download the release zip from GitHub
    const releaseZipUrl = `${release_url.replace("/tag/", "/archive/refs/tags/")}.zip`;
    const zipResponse = await fetch(releaseZipUrl);
    if (!zipResponse.ok) {
      throw new Error(`Failed to download release: ${zipResponse.status}`);
    }
    const zipBuffer = await zipResponse.arrayBuffer();
    const zipFilename = `${dataset.dataset_id}-${version}.zip`;

    // Upload the file to Zenodo
    await zenodo.uploadFile(
      newVersion.id,
      newVersion.links.bucket,
      zipFilename,
      new Uint8Array(zipBuffer),
      zenodoToken,
      sandbox,
    );

    // Update metadata for the new version
    const updatedMetadata: Partial<zenodo.ZenodoMetadata> = {
      title: `${dataset.name} - Version ${version}`,
      description: dataset.description || `BIDS dataset: ${dataset.name}`,
      creators: [{ name: "NEMAR Team" }],
      version: version,
    };

    // Update the deposition metadata
    await zenodo.updateDepositionMetadata(newVersion.id, updatedMetadata, zenodoToken, sandbox);

    // Publish the new version
    const published = await zenodo.publishDeposition(newVersion.id, zenodoToken, sandbox);

    // DOI is now published and permanent. DB and manifest failures below are
    // non-fatal but must be surfaced in the response for operator awareness.
    const baseUrl = sandbox ? "https://sandbox.zenodo.org" : "https://zenodo.org";
    let dbError: string | undefined;
    try {
      await c.env.DB.prepare("UPDATE datasets SET zenodo_latest_version_id = ? WHERE id = ?")
        .bind(published.id.toString(), dataset.id)
        .run();

      if (published.doi) {
        await c.env.DB.prepare(
          "INSERT OR IGNORE INTO dataset_versions (dataset_id, version, doi, provider) VALUES (?, ?, ?, 'zenodo')",
        )
          .bind(dataset.dataset_id, version, published.doi)
          .run();
      }
    } catch (err) {
      dbError = errorMessage(err);
      console.error(
        `[webhook] Zenodo DOI ${published.doi} is PUBLISHED but DB update failed:`,
        err,
      );
    }

    // Generate and upload version manifest
    let manifestGenerated = false;
    let manifestErrorMsg: string | undefined;
    const zenodoRepoName = dataset.github_repo ? extractRepoName(dataset.github_repo) : null;
    if (zenodoRepoName) {
      try {
        const manifest = await generateManifest(
          zenodoRepoName,
          version,
          c.env.GITHUB_ADMIN_PAT,
          dataset.dataset_id,
          published.doi ?? null,
          dataset.concept_doi,
        );

        await uploadManifest(
          {
            bucket: c.env.S3_BUCKET,
            region: c.env.AWS_REGION,
            accessKeyId: c.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
          },
          dataset.dataset_id,
          version,
          JSON.stringify(manifest, null, 2),
        );
        manifestGenerated = true;
      } catch (manifestErr) {
        manifestErrorMsg = errorMessage(manifestErr);
        console.error(
          `[webhook] Manifest generation failed for ${dataset.dataset_id}@${version}:`,
          manifestErr,
        );
      }
    }

    return c.json({
      message: "Version DOI published successfully",
      version,
      version_doi: published.doi,
      concept_doi: dataset.concept_doi,
      provider: "zenodo",
      zenodo_url: `${baseUrl}/records/${published.id}`,
      manifest_generated: manifestGenerated,
      ...(dbError && { db_error: dbError }),
      ...(manifestErrorMsg && { manifest_error: manifestErrorMsg }),
    });
  } catch (error) {
    console.error("Zenodo publish error:", error);
    return c.json(
      {
        error: "Failed to publish version DOI",
        details: errorMessage(error),
      },
      500,
    );
  }
}

/**
 * Trigger LLM-based metadata enrichment for a dataset
 *
 * Called by GitHub Actions when README.md or dataset_description.json changes.
 * Reads source files from GitHub, extracts metadata via OpenRouter,
 * merges with existing author ORCIDs, commits .nemar/metadata.json,
 * ensures .bidsignore includes .nemar/, and caches enrichment in D1.
 */
webhooks.post("/llm-enrich", async (c) => {
  // Validate webhook token
  const token = c.req.header("X-Webhook-Token");
  const expectedToken = c.env.GITHUB_WEBHOOK_SECRET;

  if (!expectedToken || !token || !timingSafeEqual(token, expectedToken)) {
    return c.json({ error: "Invalid webhook token" }, 401);
  }

  // Check for API key
  const apiKey = c.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return c.json({ error: "OPENROUTER_API_KEY not configured" }, 500);
  }

  // Parse request body
  let body: { dataset_id: string; force?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON in request body" }, 400);
  }

  if (!body.dataset_id) {
    return c.json({ error: "Missing required field: dataset_id" }, 400);
  }

  const { dataset_id } = body;
  const forceReenrich = body.force === true;

  // Look up dataset in D1
  const dataset = await c.env.DB.prepare(
    "SELECT dataset_id, github_repo, enrichment_json FROM datasets WHERE dataset_id = ?",
  )
    .bind(dataset_id)
    .first<{
      dataset_id: string;
      github_repo: string | null;
      enrichment_json: string | null;
    }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  if (!dataset.github_repo) {
    return c.json({ error: "Dataset has no GitHub repository" }, 400);
  }

  const repoName = extractRepoName(dataset.github_repo);
  if (!repoName) {
    return c.json({ error: "Invalid github_repo format" }, 400);
  }

  const pat = c.env.GITHUB_ADMIN_PAT;

  try {
    // Read repo tree to find README and dataset_description.json
    const tree = await getTreeAtRef(repoName, "main", pat);

    // Read README.md
    const readmeFile = tree.find(
      (f) => f.path === "README.md" || f.path === "README" || f.path === "readme.md",
    );
    if (!readmeFile) {
      return c.json({ error: "No README found in repository", skipped: true }, 200);
    }
    const readmeContent = await getBlobContent(repoName, readmeFile.sha, pat);

    // Read dataset_description.json
    let bidsDescription: Record<string, unknown> = {};
    const descFile = tree.find((f) => f.path === "dataset_description.json");
    if (descFile) {
      const descContent = await getBlobContent(repoName, descFile.sha, pat);
      try {
        bidsDescription = JSON.parse(descContent) as Record<string, unknown>;
      } catch (parseErr) {
        console.error(
          `[llm-enrich] Could not parse dataset_description.json for ${dataset_id}: ${errorMessage(parseErr)}`,
        );
        return c.json(
          {
            error: "dataset_description.json exists but contains invalid JSON",
            details: errorMessage(parseErr),
          },
          422,
        );
      }
    }

    // Read existing .nemar/metadata.json to preserve author ORCIDs
    let existingMetadata: NemarMetadataV2 | null = null;
    const nemarMetaFile =
      tree.find((f) => f.path === ".nemar/metadata.json") ||
      tree.find((f) => f.path === "nemar_metadata.json");
    if (nemarMetaFile) {
      const nemarContent = await getBlobContent(repoName, nemarMetaFile.sha, pat);
      try {
        const parsed = parseNemarMetadata(JSON.parse(nemarContent));
        if (parsed?.version === "2.0") {
          existingMetadata = parsed;
        } else if (parsed?.version === "1.0" && parsed.authors) {
          // Convert v1 authors to v2 format for preservation
          const v2Authors: Record<
            string,
            { orcid?: string; affiliations?: Array<{ name: string }> }
          > = {};
          for (const [name, entry] of Object.entries(parsed.authors)) {
            v2Authors[name] = {};
            if (entry.orcid) v2Authors[name].orcid = entry.orcid;
            if (entry.affiliation) v2Authors[name].affiliations = [{ name: entry.affiliation }];
          }
          existingMetadata = { version: "2.0", authors: v2Authors };
        }
      } catch (parseErr) {
        console.error(
          `[llm-enrich] Existing metadata for ${dataset_id} is corrupt and will not be preserved: ${errorMessage(parseErr)}`,
        );
      }
    }

    // Compute source content hash for change detection
    const sourceContent = readmeContent + "\n---\n" + JSON.stringify(bidsDescription);
    const sourceHashBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(sourceContent),
    );
    const sourceHash = Array.from(new Uint8Array(sourceHashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Guard: skip re-enrichment if metadata is already validated and sources unchanged
    if (
      existingMetadata?.pipeline_stage === "validated" &&
      !forceReenrich
    ) {
      if (existingMetadata.source_hash === sourceHash) {
        console.log(
          `[llm-enrich] Skipping ${dataset_id}: already validated and sources unchanged`,
        );
        return c.json({
          message: "Metadata already validated and sources unchanged",
          dataset_id,
          skipped: true,
          pipeline_stage: "validated",
        });
      }
      console.log(
        `[llm-enrich] Re-enriching ${dataset_id}: sources changed since last validation`,
      );
    }

    // Stage 1: Seed from BIDS (deterministic, no LLM call)
    const treePaths = tree.map((f) => f.path);
    const seeded = seedFromBids(bidsDescription, existingMetadata, dataset_id, treePaths);
    console.log(
      `[llm-enrich] Stage 1 (seed): ${dataset_id} - ${Object.keys(seeded.authors || {}).length} authors, ${(seeded.related_identifiers || []).length} related IDs`,
    );

    // Stage 2: LLM enrichment (adds description, keywords, methods, etc.)
    const llmResult = await enrichFromReadme(readmeContent, bidsDescription, apiKey);
    const enriched = mergeWithExisting(seeded, llmResult);
    const enrichedFields = Object.keys(llmResult).filter(
      (k) => llmResult[k as keyof typeof llmResult] !== undefined,
    );
    console.log(
      `[llm-enrich] Stage 2 (enrich): ${dataset_id} - extracted: ${enrichedFields.join(", ")}`,
    );

    // Stage 2b: MeSH term validation (NLM API, deterministic)
    let meshValidated = enriched;
    try {
      const meshResult = await validateMeshTerms(enriched);
      meshValidated = meshResult.metadata;
      if (meshResult.log.length > 0) {
        const counts = { confirmed: 0, corrected: 0, scheme_removed: 0 };
        for (const entry of meshResult.log) {
          counts[entry.action]++;
          if (entry.action === "corrected") {
            console.log(`[llm-enrich]   MeSH corrected: "${entry.term}" -> "${entry.mesh_label}"`);
          } else if (entry.action === "scheme_removed") {
            console.log(`[llm-enrich]   MeSH not found: "${entry.term}" (scheme stripped)`);
          }
        }
        console.log(
          `[llm-enrich] Stage 2b (MeSH): ${dataset_id} - ${counts.confirmed} confirmed, ${counts.corrected} corrected, ${counts.scheme_removed} scheme removed`,
        );
      }
    } catch (meshErr) {
      console.warn(
        `[llm-enrich] Stage 2b (MeSH) failed for ${dataset_id}, continuing with unchecked keywords: ${errorMessage(meshErr)}`,
      );
    }

    // Stage 3: LLM validation with feedback loop (up to 3 correction attempts)
    const MAX_CORRECTIONS = 3;
    let finalMetadata = meshValidated;
    let validationResult = null;
    let correctionAttempts = 0;
    let issueCreationError: string | undefined;

    try {
      let currentMetadata = meshValidated;
      for (let attempt = 0; attempt <= MAX_CORRECTIONS; attempt++) {
        const validated = await validateMetadata(
          currentMetadata,
          readmeContent,
          bidsDescription,
          apiKey,
        );
        validationResult = validated.validation;
        finalMetadata = validated.metadata;

        const label = attempt === 0 ? "validate" : `correction-${attempt}`;
        console.log(
          `[llm-enrich] Stage 3 (${label}): ${dataset_id} - ${validated.validation.valid ? "PASSED" : "FAILED"}, blocking: ${validated.validation.blocking_issues.length}, warnings: ${validated.validation.warnings.length}`,
        );

        // Stop if validation passed or no more correction attempts remain
        if (validated.validation.valid || attempt === MAX_CORRECTIONS) break;

        // Feed blocking issues back to LLM for correction
        correctionAttempts++;
        console.log(
          `[llm-enrich] Correction attempt ${correctionAttempts}/${MAX_CORRECTIONS} for ${dataset_id}`,
        );
        try {
          const corrections = await correctFromFeedback(
            currentMetadata,
            validated.validation.blocking_issues,
            validated.validation.warnings,
            readmeContent,
            bidsDescription,
            apiKey,
          );
          currentMetadata = mergeWithExisting(currentMetadata, corrections);
        } catch (corrErr) {
          console.warn(
            `[llm-enrich] Correction attempt ${correctionAttempts} failed for ${dataset_id}: ${errorMessage(corrErr)}`,
          );
          break;
        }
      }
    } catch (valErr) {
      console.warn(
        `[llm-enrich] Stage 3 (validate) failed for ${dataset_id}, staying at 'enriched': ${errorMessage(valErr)}`,
      );
    }

    // If still not validated after all attempts, create a GitHub issue (if not already reported)
    if (
      finalMetadata.pipeline_stage !== "validated" &&
      validationResult &&
      validationResult.blocking_issues.length > 0
    ) {
      try {
        const issueTitle = `Metadata validation failed for ${dataset_id}`;

        // Check for existing open issue to avoid duplicates on re-trigger
        const existingResp = await fetch(
          `https://api.github.com/repos/nemarDatasets/${repoName}/issues?state=open&labels=metadata&per_page=100`,
          {
            headers: {
              Authorization: `token ${pat}`,
              Accept: "application/vnd.github+json",
            },
          },
        );
        let alreadyReported = false;
        if (existingResp.ok) {
          const existing = (await existingResp.json()) as Array<{ title: string }>;
          alreadyReported = existing.some((i) => i.title === issueTitle);
        }

        if (alreadyReported) {
          console.log(
            `[llm-enrich] GitHub issue already exists for ${dataset_id}, skipping creation`,
          );
        } else {
          const issueBody = [
            "## Metadata Validation Failed",
            "",
            `The automated metadata pipeline for **${dataset_id}** could not reach the "validated" stage after ${correctionAttempts} correction attempt(s).`,
            "",
            "### Blocking Issues",
            ...validationResult.blocking_issues.map((i) => `- ${i}`),
            "",
            ...(validationResult.warnings.length > 0
              ? ["### Warnings", ...validationResult.warnings.map((w) => `- ${w}`), ""]
              : []),
            "### Next Steps",
            "1. Review the issues above and fix the underlying data (e.g., `dataset_description.json`)",
            "2. Push the fix to `main` to re-trigger the enrichment pipeline",
            "3. Or manually trigger the LLM Metadata Enrichment workflow",
            "",
            "*This issue was created automatically by the metadata pipeline.*",
          ].join("\n");

          const issueResp = await fetch(
            `https://api.github.com/repos/nemarDatasets/${repoName}/issues`,
            {
              method: "POST",
              headers: {
                Authorization: `token ${pat}`,
                Accept: "application/vnd.github+json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                title: issueTitle,
                body: issueBody,
                labels: ["metadata"],
              }),
            },
          );
          if (issueResp.ok) {
            console.log(
              `[llm-enrich] Created GitHub issue for unresolved validation failures on ${dataset_id}`,
            );
          } else {
            const respBody = await issueResp.text();
            console.error(
              `[llm-enrich] Failed to create GitHub issue for ${dataset_id}: HTTP ${issueResp.status}: ${respBody}`,
            );
          }
        }
      } catch (issueErr) {
        issueCreationError = errorMessage(issueErr);
        console.warn(
          `[llm-enrich] Failed to create GitHub issue for ${dataset_id}: ${issueCreationError}`,
        );
      }
    }

    // Store source hash for future change detection
    finalMetadata.source_hash = sourceHash;

    // Pipeline LLM work is complete. Commit results; individual failures are
    // non-fatal since the expensive LLM calls already succeeded.
    const metadataContent = JSON.stringify(finalMetadata, null, 2);
    let commitError: string | undefined;
    let bidsignoreError: string | undefined;
    let cacheError: string | undefined;

    // Commit .nemar/metadata.json to repo
    try {
      await createOrUpdateFile(
        repoName,
        ".nemar/metadata.json",
        metadataContent,
        `Update NEMAR metadata (pipeline: ${finalMetadata.pipeline_stage})`,
        pat,
      );
    } catch (err) {
      commitError = errorMessage(err);
      console.error(`[llm-enrich] Failed to commit metadata for ${dataset_id}:`, err);
    }

    // Ensure .bidsignore includes .nemar/
    try {
      const bidsignoreFile = tree.find((f) => f.path === ".bidsignore");
      let bidsignoreContent = "";
      if (bidsignoreFile) {
        bidsignoreContent = await getBlobContent(repoName, bidsignoreFile.sha, pat);
      }
      if (!bidsignoreContent.includes(".nemar/")) {
        bidsignoreContent = bidsignoreContent
          ? `${bidsignoreContent.trimEnd()}\n.nemar/\n`
          : ".nemar/\n";
        await createOrUpdateFile(
          repoName,
          ".bidsignore",
          bidsignoreContent,
          "Add .nemar/ to .bidsignore",
          pat,
        );
      }
    } catch (err) {
      bidsignoreError = errorMessage(err);
      console.error(`[llm-enrich] Failed to update .bidsignore for ${dataset_id}:`, err);
    }

    // Cache in D1
    try {
      await c.env.DB.prepare(
        "UPDATE datasets SET enrichment_json = ?, enrichment_updated_at = datetime('now'), updated_at = datetime('now') WHERE dataset_id = ?",
      )
        .bind(metadataContent, dataset_id)
        .run();
    } catch (err) {
      cacheError = errorMessage(err);
      console.error(`[llm-enrich] Failed to cache enrichment in D1 for ${dataset_id}:`, err);
    }

    return c.json({
      message: `Metadata pipeline completed (stage: ${finalMetadata.pipeline_stage})`,
      dataset_id,
      pipeline_stage: finalMetadata.pipeline_stage,
      seeded_fields: {
        authors: Object.keys(seeded.authors || {}).length,
        related_identifiers: (seeded.related_identifiers || []).length,
        funding_references: (seeded.funding_references || []).length,
      },
      enriched_fields: enrichedFields,
      validation: validationResult
        ? {
            valid: validationResult.valid,
            blocking_issues: validationResult.blocking_issues,
            warnings: validationResult.warnings,
          }
        : null,
      ...(commitError && { commit_error: commitError }),
      ...(bidsignoreError && { bidsignore_error: bidsignoreError }),
      ...(cacheError && { cache_error: cacheError }),
      ...(issueCreationError && { issue_creation_error: issueCreationError }),
    });
  } catch (error) {
    console.error(`[llm-enrich] Failed for ${dataset_id}:`, error);
    return c.json(
      {
        error: "LLM enrichment failed",
        details: errorMessage(error),
      },
      500,
    );
  }
});

export default webhooks;
