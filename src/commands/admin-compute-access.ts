/**
 * `nemar admin compute access`: an administrator decides on a person's compute access (epic #2021 phase
 * D1, #2022; ADR 0118, the compute-access addendum; ADR 0042: approval is a person's decision).
 *
 *   nemar admin compute access list [--state <state>] [--limit <n>] [--after <id>] [--json]
 *   nemar admin compute access grant   <username> | --id <n>  [--reason <text>] [--json]
 *   nemar admin compute access deny    <username> | --id <n>  [--reason <text>] [--json]
 *   nemar admin compute access suspend <username> | --id <n>  [--reason <text>] [--json]
 *   nemar admin compute access revoke  <username> | --id <n>  [--reason <text>] [--json]
 *
 * Compute access is its own grant and never touches upload access. A grant opens the owner's default
 * allocation once (a zero default opens nothing, and the answer says so); a suspension and a revocation
 * freeze the person's pools, cancel their jobs that never started and mark the rest for cancellation. The
 * reason is recorded on the audit row and is NOT sent to the person. A web account has no username, so
 * every decision also takes `--id`. These work whether or not compute is switched on: they are
 * bookkeeping. Every command takes `--json` (standard output stays pure JSON) and exits 1 on any failure.
 */

import { Command } from "commander";
import {
  COMPUTE_ACCESS_DECISIONS,
  COMPUTE_ACCESS_STATES,
  type ComputeAccessDecision,
} from "../../shared/compute-access-state.js";
import {
  COMPUTE_ACCESS_PAGE_MAX,
  COMPUTE_ACCESS_REASON_MAX_CHARS,
  type ComputeAccessAccount,
  type ComputeAccessDecisionResponse,
} from "../../shared/contract/compute-access.js";
import { formatSu } from "../../shared/contract/compute.js";
import { failMessage, failWith, requireSignedIn } from "../lib/admin-command.js";
import { decideComputeAccess, listComputeAccess } from "../lib/api/compute-access-admin.js";
import { plain } from "../lib/terminal-text.js";

const say = (line: string): void => console.log(line);

/** A fixed word or a stored value, made plain before it reaches a terminal. */
const text = (value: string | null | undefined): string => plain(value ?? "");

const LISTED_STATES = COMPUTE_ACCESS_STATES.filter((s) => s !== "none");

function who(a: ComputeAccessAccount): string {
  const name = [a.given_name, a.family_name].filter(Boolean).join(" ");
  return `${a.username ? text(a.username) : `(no username, id ${a.id})`}${name ? `  ${text(name)}` : ""}`;
}

function accountLine(a: ComputeAccessAccount): string {
  const place = [a.affiliation, a.city, a.country].filter(Boolean).map(text).join(", ");
  const when = a.compute_access_requested_at
    ? `  asked ${text(a.compute_access_requested_at)}`
    : "";
  return `${String(a.id).padEnd(7)} ${text(a.compute_access).padEnd(10)} ${who(a)}${place ? `  [${place}]` : ""}${when}`;
}

// ---------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------

const LIST_HELP = `
Description:
  Lists the accounts that have a compute-access state, oldest account first: who asked, where they
  work, what for, and what is decided. --state narrows it (requested is the queue to answer; the others
  are active, suspended, denied and revoked); accounts that never asked are not listed. A page holds at
  most ${COMPUTE_ACCESS_PAGE_MAX}; the last line names the --after value that continues it. The purpose each
  person wrote is shown under their line.

Exit codes:
  0  listed.
  1  the Worker refused (you are not an admin), an option was not valid, or the read failed.

Examples:
  $ nemar admin compute access list --state requested`;

const listCommand = new Command("list")
  .description("List accounts with a compute-access state (the queue is --state requested)")
  .option("--state <state>", `Only this state (${LISTED_STATES.join(", ")})`)
  .option("--limit <n>", `At most this many (1-${COMPUTE_ACCESS_PAGE_MAX}; default 50)`)
  .option("--after <id>", "Continue after this account id (the last line of a full page names it)")
  .option("--json", "Print the Worker's answer as JSON")
  .addHelpText("after", LIST_HELP)
  .action(async (o: { state?: string; limit?: string; after?: string; json?: boolean }) => {
    const json = o.json === true;
    if (!requireSignedIn(json)) return;
    if (o.state !== undefined && !(LISTED_STATES as readonly string[]).includes(o.state)) {
      failMessage(`"${o.state}" is not a state to list (${LISTED_STATES.join(", ")}).`, {
        json,
        answered: true,
      });
      return;
    }
    const number = (flag: string, raw: string | undefined, min: number, max: number) => {
      if (raw === undefined) return undefined;
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
        failMessage(`${flag} is a whole number from ${min} to ${max}.`, { json, answered: true });
        return null;
      }
      return n;
    };
    const limit = number("--limit", o.limit, 1, COMPUTE_ACCESS_PAGE_MAX);
    const after = number("--after", o.after, 0, Number.MAX_SAFE_INTEGER);
    if (limit === null || after === null) return;
    try {
      const res = await listComputeAccess({ state: o.state, limit, after });
      if (json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.accounts.length === 0) {
        say(
          o.state ? `No account is ${text(o.state)}.` : "No account has asked for compute access.",
        );
        return;
      }
      for (const a of res.accounts) {
        say(accountLine(a));
        if (a.compute_purpose) say(`        ${text(a.compute_purpose)}`);
      }
      if (res.next_after != null) say(`More: --after ${res.next_after}`);
    } catch (err) {
      failWith(err, null, "Could not list compute access.", undefined, { json });
    }
  });

// ---------------------------------------------------------------------------------------------
// the four decisions
// ---------------------------------------------------------------------------------------------

const DECISION_ABOUT: Record<ComputeAccessDecision, string> = {
  grant:
    "Opens compute access (from requested, suspended, denied or revoked) and the owner's default allocation, once; a second grant after a suspension adds nothing. The account must be in good standing. The person is mailed.",
  deny: "Declines an open request. The person cannot ask again; only an administrator's grant reopens it. The person is mailed.",
  suspend:
    "Pauses an active grant: the person's pools are frozen, their jobs that never started are cancelled and the rest are marked for cancellation. A grant lifts it. The person is mailed.",
  revoke:
    "Ends an active or suspended grant, as a suspension does. The person cannot ask again; only an administrator's grant reopens it. The person is mailed.",
};

function decisionHelp(decision: ComputeAccessDecision): string {
  return `
Description:
  ${DECISION_ABOUT[decision]}

  Name the account by username, or with --id for an account that has none (a web sign-up). --reason
  (up to ${COMPUTE_ACCESS_REASON_MAX_CHARS} characters) is recorded on the audit row and is NOT sent to the person. This
  does not need compute to be switched on.

Exit codes:
  0  decided.
  1  the Worker refused (not an admin, no such account, or the account is not in a state this decision
     can start from), the arguments were not valid, or the request failed.

Examples:
  $ nemar admin compute access ${decision} alovelace
  $ nemar admin compute access ${decision} --id 42 --reason "reviewed against the export-control list"`;
}

const PAST: Record<ComputeAccessDecision, string> = {
  grant: "granted",
  deny: "denied",
  suspend: "suspended",
  revoke: "revoked",
};

function printDecision(res: ComputeAccessDecisionResponse): void {
  const a = res.account;
  say(
    `Compute access ${text(PAST[res.decision as ComputeAccessDecision] ?? res.decision)} for ${who(a)}: ${text(res.from)} -> ${text(res.to)}.`,
  );
  const alloc = res.allocation;
  if (alloc) {
    if (alloc.granted) {
      say(
        `  Default allocation opened: cpu ${formatSu(alloc.cpu_milli)} SU, gpu ${formatSu(alloc.gpu_milli)} SU.`,
      );
    } else if (alloc.reason === "already_granted") {
      say("  No allocation opened: the default was opened by an earlier grant.");
    } else {
      say(
        "  No allocation opened: the owner policy's default is zero. Use `nemar admin compute pool grant` to give SU.",
      );
    }
  }
  if (res.email_sent === false) say("  The person was not mailed (the decision stands).");
}

function decisionCommand(decision: ComputeAccessDecision): Command {
  return new Command(decision)
    .description(DECISION_ABOUT[decision].split(". ")[0] ?? decision)
    .argument("[username]", "The account's username (omit it with --id)")
    .option("--id <n>", "The account's id, for an account with no username")
    .option(
      "--reason <text>",
      `Why (up to ${COMPUTE_ACCESS_REASON_MAX_CHARS} characters; recorded, not mailed)`,
    )
    .option("--json", "Print the Worker's answer as JSON")
    .addHelpText("after", decisionHelp(decision))
    .action(
      async (username: string | undefined, o: { id?: string; reason?: string; json?: boolean }) => {
        const json = o.json === true;
        if (!requireSignedIn(json)) return;
        if ((username === undefined) === (o.id === undefined)) {
          failMessage("Name the account with exactly one of <username> and --id <n>.", {
            json,
            answered: true,
          });
          return;
        }
        let target: { username: string } | { id: number };
        if (o.id !== undefined) {
          if (!/^[1-9][0-9]{0,14}$/.test(o.id)) {
            failMessage(`"${o.id}" is not an account id (a whole number from 1).`, {
              json,
              answered: true,
            });
            return;
          }
          target = { id: Number(o.id) };
        } else {
          target = { username: username as string };
        }
        if (o.reason !== undefined && [...o.reason].length > COMPUTE_ACCESS_REASON_MAX_CHARS) {
          failMessage(`--reason is at most ${COMPUTE_ACCESS_REASON_MAX_CHARS} characters.`, {
            json,
            answered: true,
          });
          return;
        }
        try {
          const res = await decideComputeAccess(decision, target, o.reason);
          if (json) console.log(JSON.stringify(res, null, 2));
          else printDecision(res);
        } catch (err) {
          failWith(err, null, `Could not ${decision} compute access.`, undefined, { json });
        }
      },
    );
}

export const accessCommand = new Command("access").description(
  "Decide on a person's compute access: list the requests, grant, deny, suspend or revoke (ADR 0118)",
);

accessCommand.addCommand(listCommand);
for (const decision of COMPUTE_ACCESS_DECISIONS)
  accessCommand.addCommand(decisionCommand(decision));
