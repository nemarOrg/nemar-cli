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
 * License compatibility matrix: source license -> allowed target licenses.
 * A source with "NC" (NonCommercial) restriction cannot feed a dataset under
 * a fully open license, because the source restrictions carry forward.
 * A share-alike (SA) source requires the derivative to use the same license.
 */
const LICENSE_COMPATIBILITY: Record<string, { allows: string[]; note?: string }> = {
  "CC0-1.0": {
    allows: ["*"],
    note: "Public domain; no restrictions on derivative licenses.",
  },
  "PDDL-1.0": {
    allows: ["*"],
    note: "Public domain dedication; no restrictions on derivative licenses.",
  },
  "CC-BY-4.0": {
    allows: ["*"],
    note: "Any license is allowed as long as attribution is given.",
  },
  "CC-BY-SA-4.0": {
    allows: ["CC-BY-SA-4.0"],
    note: "Share-alike: derivative datasets must use CC-BY-SA-4.0.",
  },
  "CC-BY-NC-4.0": {
    allows: ["CC-BY-NC-4.0", "CC-BY-NC-SA-4.0", "CC-BY-NC-ND-4.0"],
    note: "NonCommercial: derivative datasets must also be NonCommercial.",
  },
  "CC-BY-NC-SA-4.0": {
    allows: ["CC-BY-NC-SA-4.0"],
    note: "NonCommercial + ShareAlike: derivative must use CC-BY-NC-SA-4.0.",
  },
  "ODC-By-1.0": {
    allows: ["*"],
    note: "Any license allowed with attribution.",
  },
  "ODbL-1.0": {
    allows: ["ODbL-1.0"],
    note: "Share-alike for databases: derivative databases must use ODbL-1.0.",
  },
};

/**
 * Check whether a target license is compatible with a source license.
 * Returns an object with `compatible` (boolean) and an explanatory `reason`.
 */
export function validateLicenseCompatibility(
  sourceLicense: string,
  targetLicense: string,
): { compatible: boolean; reason: string } {
  const rule = LICENSE_COMPATIBILITY[sourceLicense];

  if (!rule) {
    // Unknown source license; cannot validate - warn but allow
    return {
      compatible: true,
      reason: `Source license "${sourceLicense}" is not in the compatibility table. Please verify compatibility manually.`,
    };
  }

  if (rule.allows.includes("*")) {
    return {
      compatible: true,
      reason: rule.note ?? "Compatible.",
    };
  }

  if (rule.allows.includes(targetLicense)) {
    return {
      compatible: true,
      reason: rule.note ?? "Compatible.",
    };
  }

  return {
    compatible: false,
    reason:
      `Source license "${sourceLicense}" does not allow derivative datasets to be licensed as ` +
      `"${targetLicense}". ${rule.note ?? ""} Allowed target licenses: ${rule.allows.join(", ")}.`,
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
      console.error(
        "\nUpload cancelled: you must confirm redistribution rights before uploading.",
      );
      process.exit(1);
    }

    return { isDerived: false, confirmedRedistributionRights: true };
  }

  // Derived dataset: collect source datasets
  const sourceDatasets: SourceDataset[] = [];
  let addMore = true;

  console.log(
    "\nProvide source dataset information so we can check license compatibility.",
  );

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
      console.error(`\n  Warning: License incompatibility detected.`);
      console.error(`  ${compatibility.reason}`);
      console.error(
        `  You should change your target license or verify this derivation is permitted.\n`,
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
        console.error("\nUpload cancelled due to license incompatibility.");
        process.exit(1);
      }
    } else if (compatibility.reason && !compatibility.reason.includes("Compatible.")) {
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
    console.error("\nUpload cancelled: redistribution rights must be confirmed before uploading.");
    process.exit(1);
  }

  return {
    isDerived: true,
    sourceDatasets,
    confirmedRedistributionRights: true,
  };
}
