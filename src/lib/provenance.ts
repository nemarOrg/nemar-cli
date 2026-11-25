/**
 * Data provenance prompting and license compatibility checking for uploads.
 *
 * Handles:
 * - Prompting users to declare if data is original or derived
 * - Collecting source DOI/URL and source license for derived datasets
 * - Validating license compatibility (e.g. NC source cannot become CC0)
 * - Confirming redistribution rights
 */

import inquirer from "inquirer";
import {
  COMPATIBLE_OUTCOMES,
  LINEAGE_COPY,
  type LineageOutcome,
  normalizeLicense,
  sourceOutcome,
} from "../../shared/license-lineage.js";

export interface ProvenanceInfo {
  isDerived: boolean;
  sourceDatasets?: SourceDataset[];
  confirmedRedistributionRights: boolean;
}

export interface SourceDataset {
  /** DOI or URL of the source dataset */
  identifier: string;
  /** SPDX license ID of the source dataset */
  license: string;
}

/**
 * Check whether a target license is compatible with a source license, by the one shared rule
 * (`shared/license-lineage.ts`, epic #2182 card D1) that `nemar dataset license-check` and the
 * admin lineage view also use. `outcome` is the rule's verdict; `reason` is its copy, statement
 * then remedy. An unrecognized source license needs permission: it is never assumed compatible.
 */
export function validateLicenseCompatibility(
  sourceLicense: string,
  targetLicense: string,
): { compatible: boolean; outcome: LineageOutcome; reason: string } {
  const source = normalizeLicense(sourceLicense);
  const outcome = sourceOutcome(
    { status: "resolved", license: source.license, license_version: source.version },
    normalizeLicense(targetLicense),
  );
  const copy = LINEAGE_COPY[outcome];
  return {
    compatible: COMPATIBLE_OUTCOMES.has(outcome),
    outcome,
    reason: `${copy.statement} ${copy.remedy}`,
  };
}

/**
 * Prompt the user for data provenance information.
 * Returns a ProvenanceInfo object.
 */
export async function promptForProvenance(targetLicense: string): Promise<ProvenanceInfo> {
  const { isDerived } = await inquirer.prompt<{ isDerived: boolean }>([
    {
      type: "confirm",
      name: "isDerived",
      message: "Is this dataset derived from or based on another existing dataset?",
      default: false,
    },
  ]);

  if (!isDerived) {
    // Original data - just confirm rights
    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: "confirm",
        name: "confirmed",
        message:
          "Do you confirm you have the right to upload and share this dataset under the selected license?",
        default: true,
      },
    ]);

    if (!confirmed) {
      throw new Error("Upload cancelled: you must confirm redistribution rights before uploading.");
    }

    return { isDerived: false, confirmedRedistributionRights: true };
  }

  // Derived dataset: collect source datasets
  const sourceDatasets: SourceDataset[] = [];
  let addMore = true;

  console.log("\nProvide source dataset information so we can check license compatibility.");

  while (addMore) {
    const { identifier } = await inquirer.prompt<{ identifier: string }>([
      {
        type: "input",
        name: "identifier",
        message: `Source dataset DOI or URL${sourceDatasets.length > 0 ? " (or leave empty to stop)" : ""}:`,
        validate: (input: string) => {
          if (sourceDatasets.length > 0 && !input.trim()) return true;
          if (!input.trim()) return "At least one source dataset is required for derived data.";
          return true;
        },
      },
    ]);

    if (!identifier.trim()) {
      addMore = false;
      break;
    }

    const { sourceLicense } = await inquirer.prompt<{ sourceLicense: string }>([
      {
        type: "input",
        name: "sourceLicense",
        message: `License of "${identifier}" (SPDX ID, e.g. CC-BY-4.0):`,
        validate: (input: string) => {
          if (!input.trim()) return "Source license is required.";
          return true;
        },
      },
    ]);

    const compatibility = validateLicenseCompatibility(sourceLicense.trim(), targetLicense);

    if (!compatibility.compatible) {
      console.error("\n  Warning: License incompatibility detected.");
      console.error(`  ${compatibility.reason}`);
      console.error(
        "  You should change your target license or verify this derivation is permitted.\n",
      );

      const { continueAnyway } = await inquirer.prompt<{ continueAnyway: boolean }>([
        {
          type: "confirm",
          name: "continueAnyway",
          message: "Continue despite the incompatibility warning?",
          default: false,
        },
      ]);

      if (!continueAnyway) {
        throw new Error("Upload cancelled due to license incompatibility.");
      }
    } else if (compatibility.outcome !== "compatible") {
      console.log(`\n  Note: ${compatibility.reason}\n`);
    }

    sourceDatasets.push({ identifier: identifier.trim(), license: sourceLicense.trim() });

    const { more } = await inquirer.prompt<{ more: boolean }>([
      {
        type: "confirm",
        name: "more",
        message: "Add another source dataset?",
        default: false,
      },
    ]);

    addMore = more;
  }

  // Confirm redistribution rights
  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: "confirm",
      name: "confirmed",
      message:
        "Do you confirm you have the right to redistribute this derived dataset under the selected license, respecting the source dataset(s) terms?",
      default: true,
    },
  ]);

  if (!confirmed) {
    throw new Error("Upload cancelled: redistribution rights must be confirmed before uploading.");
  }

  return {
    isDerived: true,
    sourceDatasets,
    confirmedRedistributionRights: true,
  };
}
