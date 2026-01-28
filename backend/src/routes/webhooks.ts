/**
 * Webhook routes for GitHub Actions integration
 *
 * These endpoints are called by GitHub Actions workflows
 * and authenticated via a shared secret token.
 */

import { Hono } from "hono";
import { generateManifest } from "../services/manifest.js";
import { uploadManifest } from "../services/s3.js";
import * as zenodo from "../services/zenodo.js";
import type { Bindings } from "../types/bindings.js";

const webhooks = new Hono<{ Bindings: Bindings }>();

/**
 * Publish a version DOI for a dataset
 *
 * Called by GitHub Actions when a new release is created.
 * Requires X-Webhook-Token header matching GITHUB_WEBHOOK_SECRET.
 */
webhooks.post("/publish-version-doi", async (c) => {
  // Validate webhook token
  const token = c.req.header("X-Webhook-Token");
  const expectedToken = c.env.GITHUB_WEBHOOK_SECRET;

  // If webhook secret not configured OR token doesn't match, reject as unauthorized
  // Treat missing secret as "no valid token exists" for better security
  if (!expectedToken || !token || token !== expectedToken) {
    return c.json({ error: "Invalid webhook token" }, 401);
  }

  // Parse request body
  const body = await c.req.json<{
    dataset_id: string;
    version: string;
    release_url: string;
    sandbox?: boolean;
  }>();

  if (!body.dataset_id || !body.version || !body.release_url) {
    return c.json({ error: "Missing required fields: dataset_id, version, release_url" }, 400);
  }

  const { dataset_id, version, release_url, sandbox = false } = body;

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
    }>();

  if (!dataset) {
    return c.json({ error: "Dataset not found" }, 404);
  }

  // Check if concept DOI exists
  if (!dataset.concept_doi || !dataset.zenodo_concept_id) {
    return c.json(
      {
        error: "No concept DOI exists for this dataset. Admin must create concept DOI first.",
        skipped: true,
      },
      200,
    ); // Return 200 so workflow doesn't fail
  }

  // Get the appropriate Zenodo API key
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
    const zipFilename = `${dataset_id}-${version}.zip`;

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

    // Update database with new version info
    await c.env.DB.prepare("UPDATE datasets SET zenodo_latest_version_id = ? WHERE id = ?")
      .bind(published.id.toString(), dataset.id)
      .run();

    const baseUrl = sandbox ? "https://sandbox.zenodo.org" : "https://zenodo.org";

    // Generate and upload version manifest
    let manifestGenerated = false;
    if (dataset.github_repo) {
      try {
        const repoName = dataset.github_repo.split("/")[1];
        if (repoName) {
          const pat = c.env.GITHUB_ADMIN_PAT;
          const manifest = await generateManifest(
            repoName,
            version,
            pat,
            dataset_id,
            published.doi,
            dataset.concept_doi,
          );

          await uploadManifest(
            {
              bucket: c.env.S3_BUCKET,
              region: c.env.AWS_REGION,
              accessKeyId: c.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
            },
            dataset_id,
            version,
            JSON.stringify(manifest, null, 2),
          );
          manifestGenerated = true;
        }
      } catch (manifestError) {
        // Non-fatal: DOI was published, manifest can be regenerated later
        console.error(
          `[webhook] Manifest generation failed for ${dataset_id}@${version}:`,
          manifestError,
        );
      }
    }

    return c.json({
      message: "Version DOI published successfully",
      version: version,
      version_doi: published.doi,
      concept_doi: dataset.concept_doi,
      zenodo_url: `${baseUrl}/records/${published.id}`,
      manifest_generated: manifestGenerated,
    });
  } catch (error) {
    console.error("Zenodo publish error:", error);
    return c.json(
      {
        error: "Failed to publish version DOI",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default webhooks;
