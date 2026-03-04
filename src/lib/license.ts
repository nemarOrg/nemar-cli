/**
 * License detection, validation, and prompting for NEMAR dataset uploads.
 *
 * Handles:
 * - Detecting existing license from dataset_description.json and LICENSE file
 * - Prompting user to select or confirm a license
 * - Creating LICENSE file if missing
 * - Validating research use compatibility
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import inquirer from "inquirer";

export interface LicenseInfo {
  spdxId: string;
  name: string;
  description: string;
  url: string;
  allowsResearchUse: boolean;
  licenseText?: string;
}

/**
 * Curated list of recommended licenses for neuroimaging datasets.
 * Ordered from most permissive (public domain) to most restrictive.
 */
export const RECOMMENDED_LICENSES: LicenseInfo[] = [
  {
    spdxId: "CC0-1.0",
    name: "CC0 1.0 Universal (Public Domain)",
    description: "No rights reserved. Anyone can use the data for any purpose.",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
    allowsResearchUse: true,
  },
  {
    spdxId: "PDDL-1.0",
    name: "Open Data Commons Public Domain Dedication and License (PDDL)",
    description: "Database-specific public domain dedication.",
    url: "https://opendatacommons.org/licenses/pddl/1-0/",
    allowsResearchUse: true,
  },
  {
    spdxId: "CC-BY-4.0",
    name: "Creative Commons Attribution 4.0 International",
    description: "Attribution required. Free for any use including commercial.",
    url: "https://creativecommons.org/licenses/by/4.0/",
    allowsResearchUse: true,
  },
  {
    spdxId: "CC-BY-SA-4.0",
    name: "Creative Commons Attribution-ShareAlike 4.0 International",
    description: "Attribution + share-alike required. Derivatives must use same license.",
    url: "https://creativecommons.org/licenses/by-sa/4.0/",
    allowsResearchUse: true,
  },
  {
    spdxId: "CC-BY-NC-4.0",
    name: "Creative Commons Attribution-NonCommercial 4.0 International",
    description: "Attribution required. Non-commercial use only.",
    url: "https://creativecommons.org/licenses/by-nc/4.0/",
    allowsResearchUse: true,
  },
  {
    spdxId: "CC-BY-NC-SA-4.0",
    name: "Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International",
    description: "Attribution + non-commercial + share-alike required.",
    url: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
    allowsResearchUse: true,
  },
  {
    spdxId: "ODC-By-1.0",
    name: "Open Data Commons Attribution License v1.0",
    description: "Database-specific attribution license.",
    url: "https://opendatacommons.org/licenses/by/1.0/",
    allowsResearchUse: true,
  },
  {
    spdxId: "ODbL-1.0",
    name: "Open Data Commons Open Database License v1.0",
    description: "Database attribution + share-alike. Produced works can be any license.",
    url: "https://opendatacommons.org/licenses/odbl/1.0/",
    allowsResearchUse: true,
  },
];

/**
 * Broader set of SPDX license IDs that allow research redistribution.
 * Used to validate custom SPDX IDs entered by the user.
 */
export const RESEARCH_COMPATIBLE_LICENSES = new Set([
  "CC0-1.0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "CC-BY-NC-4.0",
  "CC-BY-NC-SA-4.0",
  "CC-BY-ND-4.0",
  "CC-BY-NC-ND-4.0",
  "PDDL-1.0",
  "ODC-By-1.0",
  "ODbL-1.0",
  "MIT",
  "Apache-2.0",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Unlicense",
]);

/**
 * Detect license from dataset_description.json and/or a LICENSE file.
 * Returns the detected SPDX ID or undefined if not found.
 */
export function detectLicense(datasetPath: string): {
  spdxId: string | undefined;
  source: "dataset_description" | "license_file" | "none";
} {
  // First check dataset_description.json License field
  const descPath = resolve(datasetPath, "dataset_description.json");
  if (existsSync(descPath)) {
    try {
      const desc = JSON.parse(readFileSync(descPath, "utf-8")) as Record<string, unknown>;
      if (typeof desc.License === "string" && desc.License.trim()) {
        return { spdxId: desc.License.trim(), source: "dataset_description" };
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        console.warn(`  Warning: dataset_description.json has invalid JSON; skipping license detection from it.`);
      } else {
        console.warn(
          `  Warning: Could not read dataset_description.json: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Check for a LICENSE file (common patterns)
  const licenseFiles = ["LICENSE", "LICENSE.txt", "LICENSE.md", "LICENCE", "LICENCE.txt"];
  for (const filename of licenseFiles) {
    const licensePath = resolve(datasetPath, filename);
    if (existsSync(licensePath)) {
      // Attempt to identify the license from content
      try {
        const content = readFileSync(licensePath, "utf-8").toLowerCase();
        if (content.includes("cc0") || content.includes("public domain dedication")) {
          return { spdxId: "CC0-1.0", source: "license_file" };
        }
        if (content.includes("attribution-noncommercial-sharealike")) {
          return { spdxId: "CC-BY-NC-SA-4.0", source: "license_file" };
        }
        if (content.includes("attribution-noncommercial")) {
          return { spdxId: "CC-BY-NC-4.0", source: "license_file" };
        }
        if (content.includes("attribution-sharealike")) {
          return { spdxId: "CC-BY-SA-4.0", source: "license_file" };
        }
        if (content.includes("creativecommons") && content.includes("attribution")) {
          return { spdxId: "CC-BY-4.0", source: "license_file" };
        }
        if (content.includes("open database license") || content.includes("odbl")) {
          return { spdxId: "ODbL-1.0", source: "license_file" };
        }
        if (content.includes("open data commons") && content.includes("attribution")) {
          return { spdxId: "ODC-By-1.0", source: "license_file" };
        }
        if (content.includes("public domain dedication and license") || content.includes("pddl")) {
          return { spdxId: "PDDL-1.0", source: "license_file" };
        }
        if (
          content.includes("permission is hereby granted, free of charge") ||
          content.includes("mit license")
        ) {
          return { spdxId: "MIT", source: "license_file" };
        }
      } catch (err) {
        console.warn(
          `  Warning: Could not read ${filename}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // LICENSE file exists but couldn't identify; signal it exists
      return { spdxId: undefined, source: "license_file" };
    }
  }

  return { spdxId: undefined, source: "none" };
}

/**
 * Prompt user to select a license from the recommended list or enter a custom SPDX ID.
 * Returns the chosen SPDX ID.
 */
export async function promptForLicense(defaultSpdxId?: string): Promise<string> {
  const choices = RECOMMENDED_LICENSES.map((l) => ({
    name: `${l.spdxId.padEnd(22)} ${l.description}`,
    value: l.spdxId,
    short: l.spdxId,
  }));

  choices.push({
    name: "Other (enter SPDX ID manually)",
    value: "__custom__",
    short: "Custom",
  });

  const defaultChoice = defaultSpdxId
    ? RECOMMENDED_LICENSES.find((l) => l.spdxId === defaultSpdxId)?.spdxId
    : undefined;

  const { selected } = await inquirer.prompt<{ selected: string }>([
    {
      type: "list",
      name: "selected",
      message: "Select a license for this dataset:",
      choices,
      default: defaultChoice,
      pageSize: choices.length,
    },
  ]);

  if (selected === "__custom__") {
    const { customId } = await inquirer.prompt<{ customId: string }>([
      {
        type: "input",
        name: "customId",
        message: "Enter SPDX license ID (e.g., MIT, Apache-2.0):",
        validate: (input: string) => {
          if (!input.trim()) return "License ID is required";
          return true;
        },
      },
    ]);
    return customId.trim();
  }

  return selected;
}

/**
 * Check whether a license SPDX ID is considered research-compatible.
 * Returns true for known open/research licenses; false for unknown or restrictive ones.
 */
export function isResearchCompatible(licenseId: string): boolean {
  const normalized = licenseId.toUpperCase().replace(/\s+/g, "-");
  // Check exact match first
  if (RESEARCH_COMPATIBLE_LICENSES.has(licenseId)) return true;
  // Check normalized
  for (const id of RESEARCH_COMPATIBLE_LICENSES) {
    if (id.toUpperCase() === normalized) return true;
  }
  return false;
}

/**
 * Generate LICENSE file content for known licenses.
 * Returns a minimal reference text pointing to the official license URL.
 */
export function generateLicenseText(spdxId: string): string {
  const info = RECOMMENDED_LICENSES.find((l) => l.spdxId === spdxId);
  if (info) {
    return `${info.name}\n\n${info.url}\n\nThis dataset is licensed under the ${info.name}.\nSee the URL above for the full license text.\n`;
  }
  // Generic fallback
  return `SPDX-License-Identifier: ${spdxId}\n\nPlease see https://spdx.org/licenses/${spdxId}.html for the full license text.\n`;
}

/**
 * Ensure a LICENSE file exists in the dataset directory.
 * Creates one if missing. Returns true if a file was created.
 */
export function ensureLicenseFile(datasetPath: string, spdxId: string): boolean {
  const licensePath = resolve(datasetPath, "LICENSE");
  if (existsSync(licensePath)) {
    return false;
  }
  writeFileSync(licensePath, generateLicenseText(spdxId));
  return true;
}

/**
 * Update the License field in dataset_description.json.
 * No-ops if the file does not exist.
 */
export function updateLicenseInDescription(datasetPath: string, spdxId: string): void {
  const descPath = resolve(datasetPath, "dataset_description.json");
  if (!existsSync(descPath)) return;

  const desc = JSON.parse(readFileSync(descPath, "utf-8")) as Record<string, unknown>;
  desc.License = spdxId;
  writeFileSync(descPath, `${JSON.stringify(desc, null, 2)}\n`);
}
