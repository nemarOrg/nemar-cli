/**
 * The LICENSE text NEMAR generates for a dataset, and the licenses it recommends.
 *
 * Shared because two places need the same bytes: the upload flow writes this text
 * (`src/lib/license.ts`, which re-exports it), and the publication review recognizes it byte for
 * byte as NEMAR's own notice (`scripts/ci/license-file-fact.ts`, ADR 0142 section 1). This file has
 * no Node or Worker imports.
 */

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
