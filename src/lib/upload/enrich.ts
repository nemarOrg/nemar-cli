/**
 * Upload pipeline: dataset analysis and metadata-enrichment steps (manifest,
 * co-author ORCIDs, license, provenance). All warn-and-continue by
 * construction: they return plain values, never fail the pipeline.
 *
 * Moved verbatim from the upload action in commands/dataset.ts (#907,
 * epic #902); the only intentional changes are import paths (including the
 * dynamic doi-orcid-discovery import gaining one `../`) and the
 * step-function wrappers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import { getCurrentUser } from "../api/auth.js";
import { type NemarMetadataPayload, ORCID_REGEX } from "../api/datasets.js";
import { ApiError, errorDetail } from "../api/errors.js";
import { collectFileManifest } from "../git-annex/transfer.js";
import {
  detectLicense,
  ensureLicenseFile,
  isResearchCompatible,
  promptForLicense,
  updateLicenseInDescription,
} from "../license.js";
import { promptForProvenance } from "../provenance.js";

export interface DatasetAnalysis {
  datasetName: string;
  manifest: Awaited<ReturnType<typeof collectFileManifest>>;
  bidsDescription: Record<string, unknown>;
}

/** Step 4: Collect the file manifest and resolve the dataset name. */
export async function analyzeDataset(
  absolutePath: string,
  options: { name?: string },
): Promise<DatasetAnalysis> {
  const spinner = ora("Analyzing dataset files...").start();

  // Read dataset_description.json once (used for Name fallback and co-author ORCIDs)
  let bidsDescription: Record<string, unknown> = {};
  try {
    const descPath = resolve(absolutePath, "dataset_description.json");
    bidsDescription = JSON.parse(readFileSync(descPath, "utf-8")) as Record<string, unknown>;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.log(
        chalk.yellow(`Warning: Could not read dataset_description.json: ${(err as Error).message}`),
      );
    }
  }

  // Use explicit --name flag, then BIDS Name from dataset_description.json, then directory name
  const datasetName =
    options.name ||
    (typeof bidsDescription.Name === "string" ? bidsDescription.Name : null) ||
    basename(absolutePath);
  const manifest = await collectFileManifest(absolutePath);
  spinner.succeed(
    `Found ${manifest.files.length} files (${manifest.dataFiles} data, ${manifest.metadataFiles} metadata)`,
  );
  return { datasetName, manifest, bidsDescription };
}

/**
 * Step 4b: Collect co-author ORCIDs (skips when metadata already exists from
 * a prior run, when --skip-orcid, or when stdin is not a TTY).
 */
export async function collectAuthorOrcids(
  absolutePath: string,
  options: { skipOrcid?: boolean },
  bidsDescription: Record<string, unknown>,
): Promise<NemarMetadataPayload | undefined> {
  // Check v2 first (.nemar/metadata.json), fall back to v1 (nemar_metadata.json)
  let coAuthorEnrichment: NemarMetadataPayload | undefined;
  const existingNemarMetaV2 = resolve(absolutePath, ".nemar", "metadata.json");
  const existingNemarMetaV1 = resolve(absolutePath, "nemar_metadata.json");
  if (existsSync(existingNemarMetaV2)) {
    try {
      coAuthorEnrichment = JSON.parse(readFileSync(existingNemarMetaV2, "utf-8"));
      console.log(
        chalk.dim("  Using existing .nemar/metadata.json (author ORCIDs from prior run)"),
      );
    } catch (err) {
      console.log(
        chalk.yellow(
          `  Warning: Could not read .nemar/metadata.json: ${err instanceof Error ? err.message : err}. Will re-collect author information.`,
        ),
      );
    }
  } else if (existsSync(existingNemarMetaV1)) {
    try {
      coAuthorEnrichment = JSON.parse(readFileSync(existingNemarMetaV1, "utf-8"));
      console.log(chalk.dim("  Using existing nemar_metadata.json (author ORCIDs from prior run)"));
    } catch (err) {
      console.log(
        chalk.yellow(
          `  Warning: Could not read nemar_metadata.json: ${err instanceof Error ? err.message : err}. Will re-collect author information.`,
        ),
      );
    }
  }

  if (!coAuthorEnrichment && !options.skipOrcid && process.stdin.isTTY) {
    const rawAuthors = bidsDescription.Authors;
    const authorList = Array.isArray(rawAuthors)
      ? rawAuthors.filter((a): a is string => typeof a === "string")
      : [];

    if (authorList.length > 0) {
      try {
        // Get uploader's ORCID from profile
        let uploaderOrcid: string | undefined;
        let uploaderUsername: string | undefined;
        try {
          const user = await getCurrentUser();
          uploaderOrcid = user.orcid || undefined;
          uploaderUsername = user.username ?? undefined;
        } catch (userErr) {
          console.log(chalk.dim(`  Could not fetch profile: ${errorDetail(userErr)}`));
        }

        console.log();
        console.log(chalk.cyan("Authors found:"), authorList.join(" | "));

        // Auto-match uploader ORCID (v2 format with affiliations array)
        const authors: Record<string, { orcid?: string; affiliations?: Array<{ name: string }> }> =
          {};
        let uploaderMatchedAuthor: string | undefined;
        if (uploaderOrcid && uploaderUsername) {
          const lowerName = uploaderUsername.toLowerCase();
          const match = authorList.find((a) => a.toLowerCase().includes(lowerName));
          if (match) {
            authors[match] = { orcid: uploaderOrcid };
            uploaderMatchedAuthor = match;
            console.log(
              `  Your ORCID (from profile): ${chalk.green(uploaderOrcid)} (matched to "${match}")`,
            );
          }
        }

        // Auto-discover ORCIDs from referenced DOIs
        try {
          const { discoverOrcidsFromReferencedDois } = await import(
            "../../../backend/src/services/doi-orcid-discovery.js"
          );
          const spinner = ora("Looking up author ORCIDs from referenced publications...").start();
          const orcidResult = await discoverOrcidsFromReferencedDois(bidsDescription, authors);
          const count = Object.keys(orcidResult.discoveries).length;
          if (count > 0) {
            spinner.succeed(`Found ${count} ORCID(s) from referenced DOIs`);
            for (const [name, d] of Object.entries(orcidResult.discoveries)) {
              console.log(
                `  ${chalk.green(d.orcid)} -> "${name}" (from ${d.sourceDoi}, ${d.confidence} match)`,
              );
            }
            const { confirmOrcids } = await inquirer.prompt([
              {
                type: "confirm",
                name: "confirmOrcids",
                message: "Accept these auto-discovered ORCIDs?",
                default: true,
              },
            ]);
            if (confirmOrcids) {
              for (const [name, d] of Object.entries(orcidResult.discoveries)) {
                authors[name] = {
                  ...authors[name],
                  orcid: d.orcid,
                  ...(d.affiliations && { affiliations: d.affiliations }),
                };
              }
            }
          } else {
            spinner.info("No ORCIDs found from referenced DOIs");
          }
        } catch (discoverErr) {
          console.log(
            chalk.yellow(`  Could not auto-discover ORCIDs: ${errorDetail(discoverErr)}`),
          );
        }

        // Prompt for each co-author's ORCID
        for (const author of authorList) {
          if (author === uploaderMatchedAuthor) continue;
          if (authors[author]?.orcid) continue; // skip auto-discovered

          const { orcid } = await inquirer.prompt([
            {
              type: "input",
              name: "orcid",
              message: `ORCID for "${author}" (Enter to skip):`,
              validate: (input: string) => {
                if (!input) return true;
                return ORCID_REGEX.test(input) || "Invalid ORCID format (XXXX-XXXX-XXXX-XXXX)";
              },
            },
          ]);

          if (orcid) {
            const entry: { orcid: string; affiliations?: Array<{ name: string }> } = { orcid };
            const { affiliation } = await inquirer.prompt([
              {
                type: "input",
                name: "affiliation",
                message: `  Affiliation for "${author}" (optional):`,
              },
            ]);
            if (affiliation) entry.affiliations = [{ name: affiliation }];
            authors[author] = entry;
          }
        }

        if (Object.keys(authors).length > 0) {
          coAuthorEnrichment = { version: "2.0", authors };

          // Write immediately so resumed uploads don't re-prompt
          try {
            const nemarMetaDir = resolve(absolutePath, ".nemar");
            if (!existsSync(nemarMetaDir)) {
              mkdirSync(nemarMetaDir, { recursive: true });
            }
            const nemarMetaPath = resolve(nemarMetaDir, "metadata.json");
            writeFileSync(nemarMetaPath, JSON.stringify(coAuthorEnrichment, null, 2));
            console.log(chalk.dim("  Saved .nemar/metadata.json with author ORCIDs"));
          } catch (writeErr) {
            console.log(
              chalk.yellow(
                `  Warning: Could not save .nemar/metadata.json: ${errorDetail(writeErr)}`,
              ),
            );
          }
        }
        console.log();
      } catch (orcidErr) {
        if (orcidErr instanceof ApiError) {
          console.log(chalk.yellow(`  Could not fetch profile: ${orcidErr.message}`));
        } else {
          console.log(chalk.yellow(`  Could not collect ORCIDs: ${errorDetail(orcidErr)}`));
        }
        console.log(chalk.dim("  Continuing without author enrichment."));
      }
    }
  }
  return coAuthorEnrichment;
}

/** Step 4c: License detection and enforcement (TTY-only). */
export async function resolveLicenseStep(
  absolutePath: string,
  options: { skipValidation?: boolean },
): Promise<string | undefined> {
  let resolvedLicense: string | undefined;
  if (process.stdin.isTTY && !options.skipValidation /* non-interactive guard */) {
    const detected = detectLicense(absolutePath);

    if (detected.spdxId) {
      console.log();
      console.log(
        chalk.cyan("License detected:"),
        chalk.bold(detected.spdxId),
        chalk.dim(
          `(from ${detected.source === "dataset_description" ? "dataset_description.json" : "LICENSE file"})`,
        ),
      );

      if (!isResearchCompatible(detected.spdxId)) {
        console.log(
          chalk.yellow(
            `  Warning: "${detected.spdxId}" is not in the list of known research-compatible licenses.`,
          ),
        );
      }

      const { keepLicense } = await inquirer.prompt<{ keepLicense: boolean }>([
        {
          type: "confirm",
          name: "keepLicense",
          message: `Use "${detected.spdxId}" as the dataset license?`,
          default: true,
        },
      ]);

      if (keepLicense) {
        resolvedLicense = detected.spdxId;
      } else {
        resolvedLicense = await promptForLicense(detected.spdxId);
      }
    } else {
      console.log();
      if (detected.source === "license_file") {
        console.log(
          chalk.yellow(
            "A LICENSE file was found but the license could not be identified automatically.",
          ),
        );
      } else {
        console.log(chalk.yellow("No license found in this dataset."));
      }
      console.log(chalk.dim("A license is required to publish on NEMAR."));
      resolvedLicense = await promptForLicense();
    }

    // Apply the resolved license back to dataset_description.json if it differs
    try {
      const descPath = resolve(absolutePath, "dataset_description.json");
      if (existsSync(descPath)) {
        const desc = JSON.parse(readFileSync(descPath, "utf-8")) as Record<string, unknown>;
        if (desc.License !== resolvedLicense) {
          updateLicenseInDescription(absolutePath, resolvedLicense);
          console.log(
            chalk.dim(`  Updated dataset_description.json License -> ${resolvedLicense}`),
          );
        }
      }
    } catch (licErr) {
      console.log(
        chalk.yellow(
          `  Warning: Could not update license in dataset_description.json: ${errorDetail(licErr)}`,
        ),
      );
    }

    // Ensure LICENSE file exists
    const created = ensureLicenseFile(absolutePath, resolvedLicense);
    if (created) {
      console.log(chalk.dim(`  Created LICENSE file (${resolvedLicense})`));
    }
    console.log();
  }
  return resolvedLicense;
}

/** Step 4d: Data provenance (TTY-only, requires a resolved license). */
export async function collectProvenance(
  absolutePath: string,
  options: { skipValidation?: boolean },
  resolvedLicense: string | undefined,
): Promise<void> {
  if (process.stdin.isTTY && !options.skipValidation && resolvedLicense) {
    const provenance = await promptForProvenance(resolvedLicense);

    // Update dataset_description.json SourceDatasets field for derived data
    if (provenance.isDerived && provenance.sourceDatasets && provenance.sourceDatasets.length > 0) {
      try {
        const descPath = resolve(absolutePath, "dataset_description.json");
        if (existsSync(descPath)) {
          const desc = JSON.parse(readFileSync(descPath, "utf-8")) as Record<string, unknown>;
          const existingSources = Array.isArray(desc.SourceDatasets) ? desc.SourceDatasets : [];
          const newSources = provenance.sourceDatasets.map((s) => s.identifier);
          // Merge without duplicates
          const merged = Array.from(new Set([...(existingSources as string[]), ...newSources]));
          desc.SourceDatasets = merged;
          writeFileSync(descPath, `${JSON.stringify(desc, null, 2)}\n`);
          console.log(
            chalk.dim(
              `  Updated dataset_description.json SourceDatasets (${merged.length} source(s))`,
            ),
          );
        }
      } catch (srcErr) {
        console.log(
          chalk.yellow(`  Warning: Could not update SourceDatasets: ${errorDetail(srcErr)}`),
        );
      }
      console.log();
    }
  }
}
