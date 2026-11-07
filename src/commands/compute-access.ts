/**
 * `nemar compute request-access`: ask for compute access, once (epic #2021 phase D1, #2022; ADR 0118,
 * the compute-access addendum; ADR 0042's request-once shape for a grant of its own).
 *
 *   nemar compute request-access [--purpose <text>] [--accept-terms] [--json]
 *
 * Compute access is a grant separate from upload access: an administrator reviews each request against
 * export-control and local-jurisdiction rules and the purpose the person states, and answers once. The
 * command sends the purpose (20 to 1000 characters) and the version of the compute terms the person
 * accepts. It PROMPTS only on a terminal that can answer (a missing purpose, an unaccepted terms
 * version); with `--json`, or with no terminal, a missing value is an error naming the flag, and nothing
 * is sent. A refusal prints the account fields still to fix with where to fix each one (the same
 * sentences the website prints, `shared/contract/account-copy.ts`). Every command takes `--json`
 * (standard output stays pure JSON; sentences go to standard error) and exits 1 on any failure.
 */

import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import { ACCOUNT_COPY } from "../../shared/contract/account-copy.js";
import {
  COMPUTE_PURPOSE_MAX_CHARS,
  COMPUTE_PURPOSE_MIN_CHARS,
  hasPurposeControlChar,
} from "../../shared/contract/compute-access.js";
import { COMPUTE_TERMS_VERSION } from "../../shared/contract/compute-terms.js";
import { describeProfileGap, resolveWireProfileGaps } from "../../shared/contract/profile-gaps.js";
import { failMessage, failWith, requireSignedIn } from "../lib/admin-command.js";
import { requestComputeAccess } from "../lib/api/compute.js";
import { ApiError } from "../lib/api/errors.js";
import { getConfig } from "../lib/config.js";
import { plain } from "../lib/terminal-text.js";

/** Characters as the database counts them (code points), not UTF-16 units. */
const charCount = (text: string): number => [...text].length;

/**
 * The prompt's own check on the purpose text: true when acceptable, else the message to show. It stops a
 * person typing a long text and then being refused for a reason the terminal already knew; the rule is the
 * Worker's, and both read their bounds from the one contract.
 */
export function validateComputePurpose(input: string | undefined): true | string {
  const n = charCount((input ?? "").trim());
  if (n < COMPUTE_PURPOSE_MIN_CHARS) {
    return `Please write at least ${COMPUTE_PURPOSE_MIN_CHARS} characters`;
  }
  if (n > COMPUTE_PURPOSE_MAX_CHARS) {
    return `Please keep it under ${COMPUTE_PURPOSE_MAX_CHARS} characters`;
  }
  // The Worker refuses control characters other than newline and tab (a NUL would make the database
  // count the text short), so the prompt says so before the text is sent.
  if (hasPurposeControlChar(input ?? "")) {
    return "Please use plain text, without control characters (newlines and tabs are fine)";
  }
  return true;
}

const REQUEST_HELP = `
Description:
  Compute access is a grant of its own, separate from upload access: an administrator reviews each
  request against export-control and local-jurisdiction rules and the purpose you state, and answers
  once. A grant opens a starting allocation of service units. You ask once; asking again while the
  request is open does nothing, and a request that was answered cannot be made again.

  Before asking, your account needs a verified email address, an ORCID iD proven by signing in with
  ORCID, your given and family name, your affiliation, and your city and country. The request tells you
  which are missing and how to set each.

  --purpose is what you intend to compute (20 to 1000 characters). --accept-terms accepts the compute
  terms, version ${COMPUTE_TERMS_VERSION}. In a terminal the command asks for whatever you did not pass; with
  --json, or without a terminal, it needs both flags.

Exit codes:
  0  the request was recorded, or one was already open.
  1  the request was refused (the reason and the fields to fix are printed), a flag was missing, or the
     request could not be sent.

Examples:
  $ nemar compute request-access
  $ nemar compute request-access --purpose "Run ICA decompositions on public EEG datasets" --accept-terms`;

interface Options {
  purpose?: string;
  acceptTerms?: boolean;
  json?: boolean;
}

/** Print a refusal's sentence, and the fields it names with where to fix each, to the right stream. */
function printRefusal(err: ApiError, json: boolean): void {
  const out = (line: string) => (json ? console.error(line) : console.log(line));
  const code = err.code;
  failMessage(err.message, { json, answered: true });
  // `terms_unpublished` and `access_closed` need nothing more: their message IS the shared copy
  // (`compute_access.terms_unpublished.body`, `.closed.body`, `.suspended.body`), per state.
  // Only the refusals that are about the ACCOUNT list fields to fix: `purpose` and `accept_terms_version`
  // are flags, not Settings fields, and the sentence above already says which.
  if (
    (code === "profile_incomplete" ||
      code === "orcid_not_proven" ||
      code === "email_not_verified") &&
    err.missing &&
    err.missing.length > 0
  ) {
    const gaps = resolveWireProfileGaps(
      err.missing.map((field) => ({ field, blocks: ["compute_access"] })),
      { orcidVerified: getConfig().orcidVerified === true },
    );
    out(chalk.dim(`  ${ACCOUNT_COPY["gaps.request.title"]}`));
    for (const gap of gaps) out(`  - ${plain(describeProfileGap(gap))}`);
    out(chalk.dim("  Settings: https://nemar.org/settings"));
  }
}

export const requestAccessCommand = new Command("request-access")
  .description("Ask an admin for compute access (one-time)")
  .option(
    "--purpose <text>",
    `What you intend to compute (${COMPUTE_PURPOSE_MIN_CHARS}-${COMPUTE_PURPOSE_MAX_CHARS} characters)`,
  )
  .option("--accept-terms", `Accept the compute terms (version ${COMPUTE_TERMS_VERSION})`)
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", REQUEST_HELP)
  .action(async (o: Options) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    // A prompt needs a person at a terminal, and never runs under --json.
    const canPrompt = !json && process.stdin.isTTY === true;

    let purpose = (o.purpose ?? "").trim();
    if (purpose === "") {
      if (!canPrompt) {
        failMessage("Provide --purpose (this terminal cannot prompt).", { json, answered: true });
        return;
      }
      const answers = await inquirer.prompt([
        {
          type: "input",
          name: "purpose",
          message: ACCOUNT_COPY["compute_access.request.purpose_label"],
          validate: validateComputePurpose,
        },
      ]);
      purpose = String(answers.purpose).trim();
    }
    const refusedPurpose = validateComputePurpose(purpose);
    if (refusedPurpose !== true) {
      failMessage(`${refusedPurpose} (${ACCOUNT_COPY["compute_access.request.purpose_hint"]}).`, {
        json,
        answered: true,
      });
      return;
    }

    let accepted = o.acceptTerms === true;
    if (!accepted) {
      if (!canPrompt) {
        failMessage(
          `Pass --accept-terms to accept the compute terms (version ${COMPUTE_TERMS_VERSION}); this terminal cannot prompt.`,
          { json, answered: true },
        );
        return;
      }
      const answers = await inquirer.prompt([
        {
          type: "confirm",
          name: "accept",
          message: `${ACCOUNT_COPY["compute_access.request.terms_label"]} (version ${COMPUTE_TERMS_VERSION})?`,
          default: false,
        },
      ]);
      accepted = answers.accept === true;
      if (!accepted) {
        failMessage("The compute terms were not accepted, so nothing was sent.", {
          json,
          answered: true,
        });
        return;
      }
    }

    try {
      const res = await requestComputeAccess({
        purpose,
        accept_terms_version: COMPUTE_TERMS_VERSION,
      });
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.already_requested) {
        console.log(ACCOUNT_COPY["compute_access.requested.title"]);
        console.log(chalk.dim(`  ${ACCOUNT_COPY["compute_access.requested.lede"]}`));
      } else {
        console.log(chalk.green(ACCOUNT_COPY["compute_access.requested.title"]));
        console.log(`  ${ACCOUNT_COPY["compute_access.requested.body"]}`);
      }
      if (res.email_sent === false) {
        console.log(
          chalk.yellow(
            "  Warning: your request is recorded but admins could not be notified;\n" +
              "  it will be retried when you run this command again.",
          ),
        );
      }
    } catch (err) {
      // A refusal the Worker made: a 4xx, or the 503 that says the terms are not published yet.
      if (
        err instanceof ApiError &&
        ((err.statusCode >= 400 && err.statusCode < 500) || err.code === "terms_unpublished")
      ) {
        printRefusal(err, json);
        return;
      }
      failWith(err, null, "Could not send the compute access request.", undefined, { json });
    }
  });
