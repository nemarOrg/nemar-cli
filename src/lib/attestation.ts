/**
 * Deposit attestation for uploads (#1077).
 *
 * The Data Contributor Terms (https://docs.nemar.org/policies/contributor-terms/)
 * require every deposit to record: whether the depositor is the owner or is
 * redistributing licensed data, the status of the re-identification key, and
 * (for redistribution) that the dataset is not already archived in BIDS form.
 * The answers are sent with the create-dataset request and persisted on the
 * dataset row (migration 0067).
 *
 * Non-interactive rule: `--yes` does NOT satisfy the attestation. Without a
 * TTY the flags must spell it out (--deposit-type, --key-status, and
 * --affirm-no-duplicate for redistribution), so an automated pipeline cannot
 * silently affirm legal statements nobody read. Sandbox uploads are exempt:
 * they carry training fixtures, not participant data.
 */

import chalk from "chalk";
import inquirer from "inquirer";

export interface DepositAttestation {
  deposit_type: "owner" | "redistribution";
  key_status: "destroyed" | "retained";
  no_duplicate?: boolean;
  upstream_source?: string;
}

export interface AttestationFlagOptions {
  depositType?: string;
  keyStatus?: string;
  affirmNoDuplicate?: boolean;
  upstreamSource?: string;
}

export const CONTRIBUTOR_TERMS_URL = "https://docs.nemar.org/policies/contributor-terms/";

/**
 * Build an attestation purely from flags. Returns null when no attestation
 * flags were given at all; throws on incomplete or inconsistent combinations
 * so automation fails loudly rather than half-attesting.
 */
export function attestationFromFlags(options: AttestationFlagOptions): DepositAttestation | null {
  const { depositType, keyStatus, affirmNoDuplicate, upstreamSource } = options;
  const anyGiven =
    depositType !== undefined ||
    keyStatus !== undefined ||
    affirmNoDuplicate === true ||
    upstreamSource !== undefined;
  if (!anyGiven) return null;

  if (depositType !== "owner" && depositType !== "redistribution") {
    throw new Error(
      `--deposit-type must be "owner" or "redistribution" (got ${depositType ?? "nothing"}); it is required when attesting via flags.`,
    );
  }
  if (keyStatus !== "destroyed" && keyStatus !== "retained") {
    throw new Error(
      `--key-status must be "destroyed" or "retained" (got ${keyStatus ?? "nothing"}); it is required when attesting via flags.`,
    );
  }
  if (depositType === "redistribution" && affirmNoDuplicate !== true) {
    throw new Error(
      "Redistribution deposits require --affirm-no-duplicate: you must affirm the dataset is not already on NEMAR or an upstream archive in BIDS format.",
    );
  }
  if (depositType === "owner" && affirmNoDuplicate) {
    throw new Error("--affirm-no-duplicate only applies to --deposit-type redistribution.");
  }

  const attestation: DepositAttestation = { deposit_type: depositType, key_status: keyStatus };
  if (depositType === "redistribution") {
    attestation.no_duplicate = true;
    if (upstreamSource) attestation.upstream_source = upstreamSource;
  } else if (upstreamSource) {
    throw new Error("--upstream-source only applies to --deposit-type redistribution.");
  }
  return attestation;
}

/** Interactive attestation, mirroring the provenance prompt style. */
export async function promptForAttestation(): Promise<DepositAttestation> {
  console.log();
  console.log(chalk.bold("Deposit attestation"));
  console.log(
    chalk.dim(`  These answers are recorded with the dataset. Terms: ${CONTRIBUTOR_TERMS_URL}`),
  );

  const { depositType } = await inquirer.prompt<{ depositType: "owner" | "redistribution" }>([
    {
      type: "list",
      name: "depositType",
      message: "Which describes this deposit?",
      choices: [
        {
          name: "I own this dataset (or am authorized by the owner) and hold ethics permissions for public sharing",
          value: "owner",
        },
        {
          name: "I am redistributing a publicly released dataset whose license permits it",
          value: "redistribution",
        },
      ],
    },
  ]);

  const { keyStatus } = await inquirer.prompt<{ keyStatus: "destroyed" | "retained" }>([
    {
      type: "list",
      name: "keyStatus",
      message: "The key linking subject codes to participant identities:",
      choices: [
        { name: "Has been destroyed (dataset is anonymous)", value: "destroyed" },
        {
          name: "Is retained by the owning institution and is never transmitted to NEMAR",
          value: "retained",
        },
      ],
    },
  ]);

  const attestation: DepositAttestation = { deposit_type: depositType, key_status: keyStatus };

  if (depositType === "redistribution") {
    const { noDuplicate } = await inquirer.prompt<{ noDuplicate: boolean }>([
      {
        type: "confirm",
        name: "noDuplicate",
        message:
          "Do you affirm this dataset is NOT already available on NEMAR or an upstream archive (e.g. OpenNeuro) in BIDS format?",
        default: false,
      },
    ]);
    if (!noDuplicate) {
      throw new Error(
        "Upload cancelled: NEMAR does not accept duplicates of datasets already archived in BIDS format.",
      );
    }
    attestation.no_duplicate = true;

    const { upstream } = await inquirer.prompt<{ upstream: string }>([
      {
        type: "input",
        name: "upstream",
        message:
          "Upstream source of this dataset in its original form (URL or accession; blank if none):",
      },
    ]);
    if (upstream.trim()) attestation.upstream_source = upstream.trim();
  }

  const { deidentified } = await inquirer.prompt<{ deidentified: boolean }>([
    {
      type: "confirm",
      name: "deidentified",
      message:
        "Do you confirm the dataset contains no identifiable personal information (HIPAA Safe Harbor identifiers removed, anatomical images defaced, headers scrubbed)?",
      default: true,
    },
  ]);
  if (!deidentified) {
    throw new Error(
      "Upload cancelled: datasets must be de-identified before deposit. See the contributor terms for what must be removed.",
    );
  }

  return attestation;
}

/**
 * Resolve the attestation for an upload: flags win; otherwise prompt on a
 * TTY; otherwise fail closed (except sandbox, which auto-attests as owner
 * fixtures). Exported as the single decision point so it is unit-testable.
 */
export async function resolveAttestation(
  options: AttestationFlagOptions & { sandbox?: boolean },
  isTty: boolean = process.stdin.isTTY === true,
): Promise<DepositAttestation> {
  const fromFlags = attestationFromFlags(options);
  if (fromFlags) return fromFlags;
  if (options.sandbox) {
    // Sandbox datasets hold training fixtures; a human attestation would be
    // meaningless and would break `nemar sandbox` automation.
    return { deposit_type: "owner", key_status: "destroyed" };
  }
  if (!isTty) {
    throw new Error(
      `Deposit attestation required: run interactively, or pass --deposit-type and --key-status (plus --affirm-no-duplicate for redistribution). --yes does not substitute for attestation. Terms: ${CONTRIBUTOR_TERMS_URL}`,
    );
  }
  return promptForAttestation();
}
