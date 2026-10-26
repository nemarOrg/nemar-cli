/**
 * `nemar admin mail`: work the support tickets that arrive at support@ (epic #1893, phase 4).
 *
 *   nemar admin mail list [filters]              the tickets you may see, newest activity first
 *   nemar admin mail show <id>                   one ticket: header, tags, thread, events
 *   nemar admin mail reply <id> --text|--file|-  answer the requester (always with an Idempotency-Key)
 *   nemar admin mail note <id> --text|--file|-   an internal note (always with an Idempotency-Key)
 *   nemar admin mail summarize <id> --text|--file|-   the summary kept after the retention purge
 *   nemar admin mail assign <id> <user|me|none>
 *   nemar admin mail status <id> <open|pending|closed|spam>     (`close <id>` is `closed`)
 *   nemar admin mail escalate <id> [--reason r]
 *   nemar admin mail spam <id> [--block address|domain|none] [--reason r]   spam, unassign, block
 *   nemar admin mail blocklist [add <address-or-domain> | remove <id>]      refuse senders at delivery
 *   nemar admin mail queues [set <tag> ...]      queues and how they assign (set: owner)
 *   nemar admin mail away [set|clear]            your away window (--user: owner)
 *   nemar admin mail reprocess <raw_key>         owner
 *
 * The routes and their shapes are in shared/contract/mail-admin.ts. Humans and agents use the same
 * commands: nothing here reads an account's kind or username, only what the API answers.
 */

import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  FILTERED_LIST_MODES,
  QUEUE_STRATEGIES,
  SETTABLE_STATUSES,
  SPAM_BLOCK_CHOICES,
  TICKET_STATUSES,
} from "../../shared/contract/mail-admin.js";
import type {
  Availability,
  BlocklistEntry,
  FilteredListMode,
  ListTicketsQuery,
  MailErrorCode,
  MailQueue,
  PutAvailabilityRequest,
  PutQueueRequest,
  QueueStrategy,
  SettableStatus,
  SpamBlockChoice,
  TicketDetail,
  TicketStatus,
  TicketSummary,
} from "../../shared/contract/mail-admin.js";
import {
  addMailBlock,
  addMailNote,
  assignMailTicket,
  escalateMailTicket,
  getAdminUserByUsername,
  getMailAvailability,
  getMailTicket,
  getUsernameById,
  listMailBlocklist,
  listMailQueues,
  listMailTickets,
  markMailTicketSpam,
  putMailAvailability,
  putMailQueue,
  removeMailBlock,
  replyToMailTicket,
  reprocessMail,
  setMailTicketStatus,
  setMailTicketSummary,
} from "../lib/api/admin.js";
import { getCurrentUser } from "../lib/api/auth.js";
import { ApiError, errorDetail } from "../lib/api/errors.js";
import { isAuthenticated } from "../lib/config.js";
import { confirm } from "../lib/confirm.js";
import { markReportedExit, markUsageExit, unmarkReportedExit } from "../lib/debug-log.js";
import { terminalSafeText } from "../lib/display-name.js";

/**
 * Every command of the group is one of these, so that what Commander itself rejects (a missing
 * argument, an unknown option, a missing required option) is a usage error like every other: exit 2,
 * and `{"error", "code": "usage"}` on standard error under `--json`. `index.ts` replaces each
 * command's `exitOverride`, so the exit code cannot be set there; `error` is what Commander calls
 * for all of these, and it is overridden for this tree alone.
 */
/** `--json` among the options, ignoring anything after a `--` terminator. */
function jsonRequested(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end)).includes("--json");
}

class MailCommand extends Command {
  override createCommand(name?: string): Command {
    return new MailCommand(name);
  }

  override error(message: string): never {
    const clean = message.replace(/^error: /, "").trim();
    if (jsonRequested(process.argv)) {
      console.error(JSON.stringify({ error: clean, code: "usage" }));
    } else {
      console.error(`Error: ${oneLine(clean)}`);
    }
    markUsageExit();
    process.exit(EXIT_USAGE);
  }
}

// ---------------------------------------------------------------------------------------------
// Errors, exit codes and guidance
// ---------------------------------------------------------------------------------------------

/** Exit codes, documented in `--help`. */
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_NOT_FOUND = 3;
const EXIT_NOT_PERMITTED = 4;

/** A mistyped or refused invocation: nothing was sent. */
class UsageError extends Error {}

/**
 * One sentence of guidance for each closed word the mail routes answer with. A server that grows
 * a word this table lacks still prints its own sentence; the table only adds what to do next.
 */
export const MAIL_ERROR_GUIDANCE: Record<MailErrorCode, string> = {
  bad_request: "The server rejected the request as malformed; check the arguments and try again.",
  not_found: "There is no such ticket, or it is not visible to you.",
  forbidden:
    "Your account is not permitted to do that (an owner-only action, or an account that is not active).",
  ineligible_assignee:
    "That person cannot take it: on a restricted queue everyone named must be an owner, on any other an admin or an owner.",
  ticket_is_spam:
    "The ticket is marked spam; reopen it with 'status <id> open' before changing it.",
  ticket_closed: "The ticket is closed; reopen it with 'status <id> open' before changing it.",
  already_escalated: "The ticket is already escalated; nothing more to do.",
  no_escalation_owner:
    "The queue has no escalation owner; an owner sets one with 'queues set <tag> --escalation <user>'.",
  escalation_owner_ineligible:
    "The queue's escalation owner cannot take this ticket; an owner should name another with 'queues set <tag> --escalation <user>'.",
  restricted_locked: "The ticket is in a restricted queue, which locks this change; ask an owner.",
  restricted_flag_busy:
    "The queue still has open tickets, so its restricted flag cannot change: close or move them first.",
  restriction_mismatch:
    "The ticket's restricted flag no longer matches its queue, so it cannot be reopened; ask an owner.",
  reply_in_progress:
    "A reply with this key is still being sent; wait a moment and retry with the same key.",
  fallback_not_restrictable: "The '*' fallback queue is never restricted.",
  reply_not_sent:
    "Nothing was sent and the key is released; retry with the same key if you still want to reply.",
  summary_has_address:
    "The summary contains an email address. Rewrite it without names, addresses, account ids or quoted message text: describe the request and the outcome.",
  ticket_purged:
    "The ticket was purged under the retention policy; only its summary remains and nothing can be changed.",
  reply_delivery_unknown:
    "The mail provider did not confirm the send, so the reply may or may not have reached the requester. This key will never send it again, so retrying it is pointless: read the thread with 'nemar admin mail show', and ask the requester if needed. Only a new --idempotency-key sends again, and it may deliver a second copy.",
  block_sender_unverified:
    "The sender was not verified (DMARC did not pass), so its address may be forged. A domain is never blocked for such a sender; to block the address anyway, repeat with --force.",
  block_not_allowed:
    "That sender cannot be blocked: our own domain is never blocked, nor the domain of a shared mailbox provider (block the address instead).",
  inbound_not_configured:
    "This deployment has no inbound mail bucket, so there is nothing to reprocess.",
  internal: "The mail routes failed unexpectedly; try again, and report it if it keeps happening.",
};

/** The closed word in a mail error body (`ApiError.code` is the sentence, the word is `rawBody.code`). */
function mailErrorCode(error: ApiError): string | undefined {
  const raw = error.rawBody;
  if (raw && typeof raw === "object" && "code" in raw && typeof raw.code === "string") {
    return raw.code;
  }
  return undefined;
}

function guidanceFor(word: string | undefined): string | undefined {
  return word !== undefined && Object.hasOwn(MAIL_ERROR_GUIDANCE, word)
    ? MAIL_ERROR_GUIDANCE[word as MailErrorCode]
    : undefined;
}

/** The two commands that send an Idempotency-Key. */
type KeyedKind = "reply" | "note";

/**
 * Whether a reply is worth retrying under its key, decided by the closed `code` first: the mail
 * routes answer 409 and 422, not 502, whose body a proxy can strip. Retry when the connection failed
 * or the server answered 5xx (including an HTML gateway error and maintenance mode), so the retry
 * learns what happened, or when the route said the send is still running or certainly sent nothing.
 * Not `reply_delivery_unknown`: the server answers every repeat of that key the same way and never
 * sends it. Not a definite 4xx refusal either: the same request would be refused again.
 */
function retryableWithKey(error: ApiError, kind: KeyedKind = "reply"): boolean {
  // A note sends no mail and a repeat is idempotent: a lost answer (a network failure, a 5xx) or a
  // request that was not processed (408, 429) is worth a retry. A reply keeps its narrower rule.
  if (kind === "note") {
    return (
      error.statusCode === 0 ||
      error.statusCode >= 500 ||
      error.statusCode === 408 ||
      error.statusCode === 429
    );
  }
  const word = mailErrorCode(error);
  if (word === "reply_delivery_unknown") return false;
  return (
    word === "reply_in_progress" ||
    word === "reply_not_sent" ||
    error.statusCode === 0 ||
    error.statusCode >= 500
  );
}

function retryAdvice(error: ApiError, key: string, kind: KeyedKind): string | undefined {
  return retryableWithKey(error, kind)
    ? `Retry with: --idempotency-key ${key}  (the same key never ${kind === "note" ? "stores the note" : "sends the reply"} twice)`
    : undefined;
}

interface Failure {
  message: string;
  code: string;
  exit: number;
  hint?: string;
  /** The reply may be retried under its key. */
  retryWithKey?: boolean;
  /** Whether exit is the command's answer and not a crash (suppresses the bug-report nudge). */
  answered: boolean;
}

function failureOf(error: unknown, replyKey?: string, kind: KeyedKind = "reply"): Failure {
  if (error instanceof UsageError) {
    return { message: error.message, code: "usage", exit: EXIT_USAGE, answered: true };
  }
  if (error instanceof ApiError) {
    const word = mailErrorCode(error);
    const notFound = word === "not_found" || error.statusCode === 404;
    const notPermitted = word === "forbidden" || error.statusCode === 403;
    const guidance = guidanceFor(word);
    const retry = replyKey ? retryAdvice(error, replyKey, kind) : undefined;
    const hint = [guidance, retry].filter(Boolean).join(" ") || undefined;
    return {
      message: error.message,
      code: word ?? (error.statusCode === 0 ? "network_error" : `http_${error.statusCode}`),
      exit: notFound ? EXIT_NOT_FOUND : notPermitted ? EXIT_NOT_PERMITTED : EXIT_ERROR,
      hint,
      retryWithKey: replyKey !== undefined && retryableWithKey(error, kind),
      answered: error.statusCode >= 400 && error.statusCode < 500,
    };
  }
  return { message: errorDetail(error), code: "error", exit: EXIT_ERROR, answered: false };
}

/**
 * Run a command body and turn whatever it throws into one failure: a sentence on standard error
 * (`{"error", "code"}` under `--json`) and an exit code of 1 to 4. `replyKey` is read when the
 * failure is made, so a reply that has not generated its key yet still reports correctly.
 */
async function run(
  json: boolean,
  body: () => Promise<void>,
  replyKey?: () => string | undefined,
  kind: KeyedKind = "reply",
) {
  if (!isAuthenticated()) {
    fail(json, {
      message: "Not authenticated. Run 'nemar auth login' first.",
      code: "not_authenticated",
      exit: EXIT_ERROR,
      answered: true,
    });
    return;
  }
  try {
    await body();
  } catch (error) {
    fail(json, failureOf(error, replyKey?.(), kind), replyKey?.());
  }
}

function fail(json: boolean, f: Failure, replyKey?: string): void {
  if (json) {
    const payload: Record<string, string> = { error: f.message, code: f.code };
    // The key is reported whenever the send may have happened, so the caller can record it.
    if (replyKey && (f.retryWithKey || f.code === "reply_delivery_unknown")) {
      payload.idempotency_key = replyKey;
    }
    console.error(JSON.stringify(payload));
  } else {
    console.error(`Error: ${oneLine(f.message)}`);
    if (f.hint) console.error(`  ${f.hint}`);
  }
  process.exitCode = f.exit;
  if (f.answered) markReportedExit();
  else unmarkReportedExit();
}

// ---------------------------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------------------------

/** {@link terminalSafeText} for a value that sits on one line: a kept newline or tab is written out. */
function oneLine(value: unknown): string {
  return terminalSafeText(String(value ?? ""))
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

function printJson(body: unknown): void {
  console.log(JSON.stringify(body, null, 2));
}

/** Indent every line of a block of text. */
function indent(text: string, by = "    "): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? line : `${by}${line}`))
    .join("\n");
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

// ---------------------------------------------------------------------------------------------
// People: me, none, a numeric id or a username
// ---------------------------------------------------------------------------------------------

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Users resolved or named in one run: each is looked up once, concurrent callers sharing the lookup. */
class People {
  private readonly names = new Map<number, Promise<string>>();
  private readonly ids = new Map<string, number>();
  private me: number | undefined;

  /**
   * `me`, `none` (when `allowNone`), a numeric id, a username, or `@username` (a username even
   * when it is all digits), as the id the API takes.
   */
  async resolve(arg: string, label: string, allowNone = false): Promise<number | null> {
    if (arg === "none") {
      if (allowNone) return null;
      throw new UsageError(`${label} cannot be 'none' here.`);
    }
    if (arg === "me") return this.whoAmI();
    const explicit = arg.startsWith("@");
    if (!explicit && /^\d{1,12}$/.test(arg)) return Number(arg);
    const username = explicit ? arg.slice(1) : arg;
    if (!USERNAME_RE.test(username)) {
      throw new UsageError(
        `${label}: '${oneLine(arg)}' is not me${allowNone ? ", none" : ""}, a user id, a username or @username.`,
      );
    }
    const cached = this.ids.get(username);
    if (cached !== undefined) return cached;
    const { user } = await getAdminUserByUsername(username);
    if (typeof user.id !== "number") {
      throw new ApiError(500, `The user lookup for '${oneLine(arg)}' did not return an id.`);
    }
    this.ids.set(username, user.id);
    if (user.username) this.names.set(user.id, Promise.resolve(user.username));
    return user.id;
  }

  private async whoAmI(): Promise<number> {
    if (this.me === undefined) {
      const user = await getCurrentUser();
      this.me = user.id;
      if (user.username) this.names.set(user.id, Promise.resolve(user.username));
    }
    return this.me;
  }

  /**
   * A person as a human reads it: the username, else `#id` (an account with no username, or one
   * the lookup answers 404 for). Any other failure of the lookup is the command's failure: a name
   * is not worth hiding a 401, an outage or a rate limit behind ids that look like an answer.
   * The text is escaped on every return, the cache holds it raw.
   */
  async name(id: number | null | undefined): Promise<string> {
    if (id === null || id === undefined) return "-";
    let lookup = this.names.get(id);
    if (!lookup) {
      lookup = getUsernameById(id).then(
        (username) => username || `#${id}`,
        (error: unknown) => {
          if (error instanceof ApiError && error.statusCode === 404) return `#${id}`;
          throw error;
        },
      );
      this.names.set(id, lookup);
    }
    return oneLine(await lookup);
  }

  async list(ids: readonly number[]): Promise<string> {
    const named = await Promise.all(ids.map((id) => this.name(id)));
    return named.length > 0 ? named.join(", ") : "-";
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function ticketLine(t: TicketSummary, assignee: string): string {
  return `#${t.id}  ${oneLine(t.ref)}  ${oneLine(t.status)}${t.purged ? " (purged)" : ""}${t.filtered ? ` (filtered: ${oneLine(t.filtered)})` : ""}  ${oneLine(t.queue_tag)}${t.restricted ? " (restricted)" : ""}  assignee ${assignee}  ${oneLine(t.subject)}`;
}

async function printTicketAction(verb: string, t: TicketSummary, people: People): Promise<void> {
  console.log(`${verb}: ${ticketLine(t, await people.name(t.assignee_user_id))}`);
}

async function renderList(tickets: TicketSummary[], people: People): Promise<void> {
  if (tickets.length === 0) {
    console.log("No tickets.");
    return;
  }
  const rows: string[][] = [];
  for (const t of tickets) {
    rows.push([
      t.unread ? "new" : "",
      `#${t.id}`,
      oneLine(t.ref),
      `${oneLine(t.status)}${t.purged ? " (purged)" : ""}${t.filtered ? ` [${oneLine(t.filtered)}]` : ""}`,
      `${oneLine(t.queue_tag)}${t.restricted ? "*" : ""}`,
      await people.name(t.assignee_user_id),
      oneLine(t.last_message_at),
      oneLine(t.requester_email),
      oneLine(t.subject),
    ]);
  }
  const head = [
    "NEW",
    "ID",
    "REF",
    "STATUS",
    "QUEUE",
    "ASSIGNEE",
    "LAST MESSAGE",
    "FROM",
    "SUBJECT",
  ];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : pad(c, widths[i])))
      .join("  ")
      .trimEnd();
  console.log(line(head));
  for (const r of rows) console.log(line(r));
  console.log("\n* restricted queue");
}

async function renderTicket(detail: TicketDetail, people: People): Promise<string[]> {
  const out: string[] = [];
  const t = detail.ticket;
  out.push(`Ticket #${t.id}  ${oneLine(t.ref)}`);
  out.push(`Subject:    ${oneLine(t.subject)}`);
  out.push(`Status:     ${oneLine(t.status)}`);
  if (t.filtered) {
    out.push(`Filtered:   ${oneLine(t.filtered)}  (filed quietly: not assigned, nobody was told)`);
  }
  out.push(`Queue:      ${oneLine(t.queue_tag)}${t.restricted ? " (restricted)" : ""}`);
  out.push(`Assignee:   ${await people.name(t.assignee_user_id)}`);
  const requester =
    t.requester_user_id === null
      ? oneLine(t.requester_email)
      : `${oneLine(t.requester_email)} (account ${await people.name(t.requester_user_id)})`;
  out.push(`Requester:  ${requester}`);
  out.push(`Tags:       ${detail.tags.length > 0 ? detail.tags.map(oneLine).join(", ") : "-"}`);
  out.push(`Created:    ${oneLine(t.created_at)}`);
  out.push(`Updated:    ${oneLine(t.updated_at)}`);
  if (detail.purged_at) {
    out.push(`Purged on:  ${oneLine(detail.purged_at)}  (retention: only the summary is kept)`);
  }
  if (detail.summary !== null && detail.summary !== undefined) {
    const by = await people.name(detail.summary_author_user_id);
    out.push(`\nSummary (by ${by}, ${oneLine(detail.summarized_at ?? "unknown time")})`);
    out.push(indent(terminalSafeText(detail.summary)));
  } else {
    out.push("\nSummary:    (none)");
  }

  out.push("\nThread (oldest first)");
  const messages = [...detail.messages].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id,
  );
  if (messages.length === 0) out.push("  (no messages)");
  for (const m of messages) {
    const kind = m.direction === "in" ? "IN" : m.direction === "out" ? "OUT" : "NOTE";
    const who =
      m.direction === "note"
        ? `by ${await people.name(m.author_user_id)}`
        : `${oneLine(m.from_addr)} -> ${oneLine(m.to_addr)}`;
    out.push(`\n[${oneLine(m.created_at)}] ${kind} #${m.id}  ${who}`);
    if (m.direction === "in") {
      out.push(`  auth: spf=${oneLine(m.spf)} dkim=${oneLine(m.dkim)} dmarc=${oneLine(m.dmarc)}`);
    }
    out.push(`  subject: ${oneLine(m.subject)}`);
    out.push(indent(terminalSafeText(m.text_body)));
  }

  out.push("\nEvents");
  const events = [...detail.events].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id,
  );
  if (events.length === 0) out.push("  (none)");
  for (const e of events) {
    const detailText =
      e.detail === null || e.detail === undefined ? "" : `  ${oneLine(JSON.stringify(e.detail))}`;
    out.push(
      `  [${oneLine(e.created_at)}] ${oneLine(e.kind)} by ${await people.name(e.actor_user_id)}${detailText}`,
    );
  }
  return out;
}

async function renderQueue(q: MailQueue, people: People): Promise<string[]> {
  const out: string[] = [];
  out.push(`${oneLine(q.tag)}${q.restricted ? " (restricted)" : ""}`);
  out.push(`  strategy:    ${oneLine(q.strategy)}`);
  out.push(`  assignee:    ${await people.name(q.assignee_user_id)}`);
  out.push(`  backup:      ${await people.name(q.backup_user_id)}`);
  out.push(`  members:     ${await people.list(q.rr_members)}`);
  out.push(`  escalation:  ${await people.name(q.escalation_user_id)}`);
  out.push(`  open:        ${oneLine(q.open_tickets)}`);
  out.push(`  notify:      ${q.notify ? "yes" : "no (quiet: new tickets announce nothing)"}`);
  return out;
}

async function renderAvailability(a: Availability, people: People): Promise<string[]> {
  const out: string[] = [];
  out.push(`User:    ${await people.name(a.user_id)}`);
  if (!a.away_until && !a.away_from) {
    out.push("Away:    no window set");
    return out;
  }
  out.push(
    `Away:    ${a.away_from ? oneLine(a.away_from) : "now"} until ${a.away_until ? oneLine(a.away_until) : "further notice"}`,
  );
  out.push(`Backup:  ${await people.name(a.backup_user_id)}`);
  out.push(`Note:    ${a.note ? oneLine(a.note) : "-"}`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------------------------

function ticketIdOf(raw: string): number {
  if (!/^\d{1,12}$/.test(raw) || Number(raw) <= 0) {
    throw new UsageError(`'${oneLine(raw)}' is not a ticket id (a number like 42).`);
  }
  return Number(raw);
}

/** The body of a reply or note: exactly one of --text, --file and `-`; never empty. */
async function bodyText(
  opts: { text?: string; file?: string },
  source: string | undefined,
  max = MAX_TEXT,
): Promise<string> {
  if (source !== undefined && source !== "-") {
    throw new UsageError(
      `Unexpected argument '${oneLine(source)}'; use '-' to read standard input.`,
    );
  }
  const given = [opts.text !== undefined, opts.file !== undefined, source === "-"].filter(
    Boolean,
  ).length;
  if (given !== 1) {
    throw new UsageError("Give the text with exactly one of --text, --file <path> or '-' (stdin).");
  }
  let text: string;
  if (opts.text !== undefined) text = opts.text;
  else if (opts.file !== undefined && opts.file !== "-") {
    try {
      text = readFileSync(opts.file, "utf8");
    } catch (error) {
      throw new UsageError(`Cannot read ${oneLine(opts.file)}: ${errorDetail(error)}`);
    }
  } else text = await Bun.stdin.text();
  text = text.trim();
  if (text === "") throw new UsageError("The text is empty; nothing was sent.");
  if (text.length > max) {
    throw new UsageError(`The text is ${text.length} characters; the limit is ${max}.`);
  }
  return text;
}

/** What a person is shown before a reply is sent: recipient, subject and text, all made safe. */
export function replyPreview(
  ticket: Pick<TicketSummary, "requester_email" | "subject">,
  text: string,
): string {
  return [
    `To:       ${oneLine(ticket.requester_email)}`,
    `Subject:  Re: ${oneLine(ticket.subject)}`,
    "",
    terminalSafeText(text),
    "",
  ].join("\n");
}

/** The Worker's own bound on a reply or note (TEXT_MAX in backend/src/routes/admin/mail.ts). */
const MAX_TEXT = 20_000;

/** The Worker's bound on a summary (SUMMARY_MAX in backend/src/routes/admin/mail.ts). */
const MAX_SUMMARY = 4_000;

const KEY_RE = /^[A-Za-z0-9._:-]{1,64}$/;

function statusOf(raw: string): SettableStatus {
  if ((SETTABLE_STATUSES as readonly string[]).includes(raw)) return raw as SettableStatus;
  throw new UsageError(
    raw === "escalated"
      ? "'escalated' is set with 'nemar admin mail escalate <id>', not with status."
      : `'${oneLine(raw)}' is not a status you can set: use ${SETTABLE_STATUSES.join(", ")}.`,
  );
}

function enumOf<T extends string>(raw: string, allowed: readonly T[], label: string): T {
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new UsageError(`${label} must be one of ${allowed.join(", ")}, not '${oneLine(raw)}'.`);
}

/** An ISO 8601 instant with an explicit zone: a date alone or a local time would depend on where this runs. */
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function instantOf(raw: string, label: string): string {
  const ms = Date.parse(raw);
  if (!INSTANT_RE.test(raw) || Number.isNaN(ms)) {
    throw new UsageError(
      `${label}: '${oneLine(raw)}' is not an ISO 8601 instant with a zone, like 2026-10-24T09:00:00Z.`,
    );
  }
  return new Date(ms).toISOString();
}

interface Common {
  json?: boolean;
}

/** Options as Commander resolved them, parent groups' included: `--json` may sit anywhere. */
function optsOf<T extends Common>(command: Command): T {
  return command.optsWithGlobals() as T;
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

const EXIT_HELP = `
Exit codes:
  0  done
  1  the API or the network failed (a refusal such as a closed ticket, a server error, no connection)
  2  usage: a bad or missing argument, an empty body, or a reply not confirmed (nothing was sent)
  3  not found or not visible to you (the API answers a ticket you may not see with not found)
  4  not permitted (403: an owner-only action, or an account that is not active)

With --json the API's answer is printed verbatim as one JSON document on standard output, and
standard error is JSON Lines, one JSON document per line: {"error", "code"} for a failure (code
"usage" for a mistyped command) and, for a reply, {"idempotency_key"} before it is sent. Text in tickets comes from outside: human output
escapes control and bidirectional characters, --json does not, so a consumer must treat it as data.
A <user> is 'me', a numeric id, a username, or @username (a username even when it is all digits);
'none' where the command says so.
`;

const jsonOption = [
  "--json",
  "Print the API's answer as JSON (errors as JSON on standard error)",
] as const;

const listCommand = new MailCommand("list")
  .description("List support tickets you may see, newest activity first")
  .option("--status <status>", `One of ${TICKET_STATUSES.join(", ")} (default: not closed or spam)`)
  .option("--queue <tag>", "Only this queue")
  .option("--mine", "Only tickets assigned to you")
  .option("--assignee <user>", "Only tickets assigned to this user, or 'none' for unassigned")
  .option(
    "--filtered <mode>",
    `${FILTERED_LIST_MODES.join(" | ")}: filtered tickets (bulk, auto-reply, bounce, rate-limited) are hidden by default`,
  )
  .option("--needs-summary", "Only closed tickets that still have no summary (not purged)")
  .option("--search <text>", "Part of the subject or the requester's address")
  .option("--limit <n>", "Page size, 1 to 100 (default 25; 100 with --all)")
  .option("--cursor <cursor>", "The next_cursor of the previous page")
  .option("--all", "Follow next_cursor until the last page (--json: the pages merged)")
  .option(...jsonOption)
  .action(async (_o, command: Command) => {
    const o = optsOf<
      Common & {
        status?: string;
        queue?: string;
        mine?: boolean;
        assignee?: string;
        needsSummary?: boolean;
        filtered?: string;
        search?: string;
        limit?: string;
        cursor?: string;
        all?: boolean;
      }
    >(command);
    await run(!!o.json, async () => {
      const people = new People();
      const query: ListTicketsQuery = {};
      if (o.status) query.status = enumOf(o.status, TICKET_STATUSES, "--status") as TicketStatus;
      if (o.queue) query.queue = o.queue;
      if (o.mine && o.assignee) throw new UsageError("Use --mine or --assignee, not both.");
      if (o.mine) query.assignee = "me";
      else if (o.assignee) {
        const id = await people.resolve(o.assignee, "--assignee", true);
        query.assignee = id === null ? "none" : o.assignee === "me" ? "me" : String(id);
      }
      if (o.filtered) {
        query.filtered = enumOf(o.filtered, FILTERED_LIST_MODES, "--filtered") as FilteredListMode;
      }
      if (o.needsSummary) query.summary = "missing";
      if (o.search) query.q = o.search;
      if (o.limit !== undefined) {
        if (!/^\d{1,3}$/.test(o.limit) || Number(o.limit) < 1 || Number(o.limit) > 100) {
          throw new UsageError("--limit must be a number from 1 to 100.");
        }
        query.limit = Number(o.limit);
      } else if (o.all) query.limit = 100;
      if (o.cursor) query.cursor = o.cursor;
      if (o.all && o.cursor) throw new UsageError("--all starts at the first page; drop --cursor.");

      let page = await listMailTickets(query);
      let tickets = page.tickets;
      let next = page.next_cursor;
      if (o.all) {
        const seen = new Set<string>();
        while (next) {
          if (seen.has(next)) {
            throw new Error(
              "The server repeated a page cursor, so the listing is incomplete; nothing was printed.",
            );
          }
          seen.add(next);
          page = await listMailTickets({ ...query, cursor: next });
          tickets = tickets.concat(page.tickets);
          next = page.next_cursor;
        }
      }
      if (o.json) {
        printJson(o.all ? { tickets, next_cursor: null } : page);
        return;
      }
      await renderList(tickets, people);
      if (!o.all && next) console.log(`More: --cursor ${oneLine(next)}  (or --all)`);
    });
  });

const showCommand = new MailCommand("show")
  .description("Show a ticket: header, tags, the thread oldest first, and its events")
  .argument("<id>", "Ticket id")
  .option(...jsonOption)
  .action(async (rawId: string, _o, command: Command) => {
    const o = optsOf<Common>(command);
    await run(!!o.json, async () => {
      const detail = await getMailTicket(ticketIdOf(rawId));
      if (o.json) return printJson(detail);
      console.log((await renderTicket(detail, new People())).join("\n"));
    });
  });

const replyCommand = new MailCommand("reply")
  .description("Send a reply to the requester from support@, with an Idempotency-Key")
  .argument("<id>", "Ticket id")
  .argument("[source]", "'-' reads the reply from standard input")
  .option("--text <text>", "The reply")
  .option("--file <path>", "Read the reply from a file")
  .option(
    "--idempotency-key <key>",
    "Your own key (1 to 64 of letters, digits . _ : -); default: generated",
  )
  .option("-y, --yes", "Send without asking (required when there is no terminal)")
  .option(...jsonOption)
  .addHelpText(
    "after",
    `
A reply reaches a person, so it is sent with an Idempotency-Key: a repeat of the same key never
sends twice. The key is printed to standard error before anything is sent. If the answer is lost
(a network failure, a 5xx, reply_in_progress) retry with --idempotency-key <that key>.
With a terminal the recipient, subject and text are shown and you confirm; without one, --yes is
required and the command refuses (exit 2, nothing sent) otherwise.
Reusing a key replays the earlier result and sends no new text: a changed --text under a key that
was already used is not sent. reply_delivery_unknown is final for its key: the provider did not
confirm the send, and the same key will never send it. Read the thread and ask the requester; only
a new key sends again, and it may deliver a second copy.`,
  )
  .action(async (rawId: string, source: string | undefined, _o, command: Command) => {
    const o = optsOf<
      Common & { text?: string; file?: string; idempotencyKey?: string; yes?: boolean }
    >(command);
    let key: string | undefined;
    await run(
      !!o.json,
      async () => {
        const id = ticketIdOf(rawId);
        if (o.idempotencyKey !== undefined && !KEY_RE.test(o.idempotencyKey)) {
          throw new UsageError("--idempotency-key must be 1 to 64 letters, digits or . _ : -");
        }
        const text = await bodyText(o, source);
        if (!o.yes && !process.stdin.isTTY) {
          throw new UsageError(
            "Not sending: there is no terminal to confirm on. Add --yes to send without asking.",
          );
        }
        if (!o.yes) {
          const ticket = (await getMailTicket(id)).ticket;
          console.error(replyPreview(ticket, text));
          const answer = await confirm("Send this reply?", {});
          if (answer !== "confirmed")
            throw new UsageError("Not sent: the reply was not confirmed.");
        }
        key = o.idempotencyKey ?? `nemar-cli-${crypto.randomUUID()}`;
        if (o.json) console.error(JSON.stringify({ idempotency_key: key }));
        else console.error(`Idempotency-Key: ${key}`);
        const sent = await replyToMailTicket(id, text, key);
        if (o.json) return printJson(sent);
        if (sent.message_id === 0) {
          console.log(
            "Reply sent, but not recorded: the ticket was purged under the retention policy while it was being sent. Do not send it again.",
          );
          return;
        }
        console.log(
          `Reply sent (message ${oneLine(sent.message_id)}); the ticket is now ${oneLine(sent.status)}.`,
        );
      },
      () => key,
    );
  });

const noteCommand = new MailCommand("note")
  .description("Add an internal note to a ticket (never sent to the requester)")
  .argument("<id>", "Ticket id")
  .argument("[source]", "'-' reads the note from standard input")
  .option("--text <text>", "The note")
  .option("--file <path>", "Read the note from a file")
  .option(
    "--idempotency-key <key>",
    "Your own key (1 to 64 of letters, digits . _ : -); default: generated",
  )
  .option(...jsonOption)
  .addHelpText(
    "after",
    `
A note is sent with an Idempotency-Key, printed to standard error before anything is sent. If the
answer is lost (a network failure or a 5xx), retry with --idempotency-key <that key>: the note is
stored once, and the repeat returns the same message id. Note keys are separate from reply keys.
A key identifies the intent, not the text: reusing a key with different text replays the first
note and stores nothing new. A 408 or 429 is also safe to retry with the key.
Under --json standard error is JSON Lines: the {"idempotency_key"} line first, then the error object.`,
  )
  .action(async (rawId: string, source: string | undefined, _o, command: Command) => {
    const o = optsOf<Common & { text?: string; file?: string; idempotencyKey?: string }>(command);
    let key: string | undefined;
    await run(
      !!o.json,
      async () => {
        const id = ticketIdOf(rawId);
        if (o.idempotencyKey !== undefined && !KEY_RE.test(o.idempotencyKey)) {
          throw new UsageError("--idempotency-key must be 1 to 64 letters, digits or . _ : -");
        }
        const text = await bodyText(o, source);
        key = o.idempotencyKey ?? `nemar-cli-${crypto.randomUUID()}`;
        if (o.json) console.error(JSON.stringify({ idempotency_key: key }));
        else console.error(`Idempotency-Key: ${key}`);
        const added = await addMailNote(id, text, key);
        if (o.json) return printJson(added);
        console.log(`Note added to ticket #${id} (message ${oneLine(added.message_id)}).`);
      },
      () => key,
      "note",
    );
  });

const summarizeCommand = new MailCommand("summarize")
  .description("Write (or replace) the summary kept after the retention purge")
  .argument("<id>", "Ticket id")
  .argument("[source]", "'-' reads the summary from standard input")
  .option("--text <text>", "The summary")
  .option("--file <path>", "Read the summary from a file")
  .option(...jsonOption)
  .addHelpText(
    "after",
    `
After the retention period a ticket keeps only this summary; its messages, address and subject are
removed. Describe the request and the outcome in 1 to ${MAX_SUMMARY} characters. Do NOT include
names, email addresses, account ids or quoted message text: a summary containing an email address
is refused (summary_has_address). A later summary replaces an earlier one; a purged ticket cannot
be summarized (ticket_purged). A restricted ticket can be summarized only by an owner. Find the
tickets still to do with 'list --needs-summary'.`,
  )
  .action(async (rawId: string, source: string | undefined, _o, command: Command) => {
    const o = optsOf<Common & { text?: string; file?: string }>(command);
    await run(!!o.json, async () => {
      const id = ticketIdOf(rawId);
      const res = await setMailTicketSummary(id, await bodyText(o, source, MAX_SUMMARY));
      if (o.json) return printJson(res);
      console.log(`Summary saved on ticket #${id}.`);
    });
  });

const assignCommand = new MailCommand("assign")
  .description("Assign a ticket to a person, or unassign it")
  .argument("<id>", "Ticket id")
  .argument("<user>", "me, none, a user id, a username or @username")
  .option(...jsonOption)
  .action(async (rawId: string, who: string, _o, command: Command) => {
    const o = optsOf<Common>(command);
    await run(!!o.json, async () => {
      const id = ticketIdOf(rawId);
      const people = new People();
      const userId = await people.resolve(who, "<user>", true);
      const res = await assignMailTicket(id, userId);
      if (o.json) return printJson(res);
      await printTicketAction("Assigned", res.ticket, people);
    });
  });

async function changeStatus(rawId: string, rawStatus: string, json: boolean): Promise<void> {
  await run(json, async () => {
    const id = ticketIdOf(rawId);
    const status = statusOf(rawStatus);
    const res = await setMailTicketStatus(id, status);
    if (json) return printJson(res);
    await printTicketAction("Status set", res.ticket, new People());
  });
}

const statusCommand = new MailCommand("status")
  .description(`Set a ticket's status: ${SETTABLE_STATUSES.join(", ")}`)
  .argument("<id>", "Ticket id")
  .argument("<status>", SETTABLE_STATUSES.join(" | "))
  .option(...jsonOption)
  .action(async (rawId: string, status: string, _o, command: Command) => {
    await changeStatus(rawId, status, !!optsOf<Common>(command).json);
  });

const closeCommand = new MailCommand("close")
  .description("Close a ticket (same as: status <id> closed)")
  .argument("<id>", "Ticket id")
  .option(...jsonOption)
  .action(async (rawId: string, _o, command: Command) => {
    await changeStatus(rawId, "closed", !!optsOf<Common>(command).json);
  });

const escalateCommand = new MailCommand("escalate")
  .description("Hand a ticket to its queue's escalation owner")
  .argument("<id>", "Ticket id")
  .option("--reason <text>", "Why (up to 500 characters; the owner is told)")
  .option(...jsonOption)
  .action(async (rawId: string, _o, command: Command) => {
    const o = optsOf<Common & { reason?: string }>(command);
    await run(!!o.json, async () => {
      const id = ticketIdOf(rawId);
      if (o.reason && o.reason.trim().length > 500) {
        throw new UsageError("--reason is limited to 500 characters.");
      }
      const res = await escalateMailTicket(id, o.reason?.trim());
      if (o.json) return printJson(res);
      await printTicketAction("Escalated", res.ticket, new People());
    });
  });

const spamCommand = new MailCommand("spam")
  .description(
    "Mark a ticket spam and unassign it; --block address|domain also refuses the sender at delivery (default: none)",
  )
  .argument("<id>", "Ticket id")
  .option("--block <what>", `${SPAM_BLOCK_CHOICES.join(" | ")} (default: none)`)
  .option("--force", "Block the address of an unverified sender (its From address may be forged)")
  .option("--reason <text>", "Why (up to 200 characters, kept on the block)")
  .option(...jsonOption)
  .action(async (rawId: string, _o, command: Command) => {
    const o = optsOf<Common & { block?: string; reason?: string; force?: boolean }>(command);
    await run(!!o.json, async () => {
      const id = ticketIdOf(rawId);
      const block = enumOf(o.block ?? "none", SPAM_BLOCK_CHOICES, "--block") as SpamBlockChoice;
      if (o.reason && o.reason.trim().length > 200) {
        throw new UsageError("--reason is limited to 200 characters.");
      }
      if (o.force && block !== "address") {
        throw new UsageError("--force applies to --block address only.");
      }
      const res = await markMailTicketSpam(id, {
        block,
        ...(o.reason ? { reason: o.reason.trim() } : {}),
        ...(o.force ? { force: true } : {}),
      });
      if (o.json) return printJson(res);
      await printTicketAction("Marked spam", res.ticket, new People());
      console.log(
        res.block
          ? `Blocked ${oneLine(res.block.kind)} ${oneLine(res.block.value)} (entry #${res.block.id}); mail from it is refused at delivery.`
          : "No block added.",
      );
    });
  });

function renderBlock(e: BlocklistEntry): string {
  return `#${e.id}  ${oneLine(e.kind)}  ${oneLine(e.value)}  ${oneLine(e.created_at)}${e.reason ? `  ${oneLine(e.reason)}` : ""}`;
}

const blocklistAddCommand = new MailCommand("add")
  .description("Refuse mail from an address, or with --domain from a domain and its subdomains")
  .argument("<value>", "An email address, or a domain with --domain")
  .option("--domain", "Block the domain (and every subdomain) instead of one address")
  .option("--reason <text>", "Why (up to 200 characters)")
  .option(...jsonOption)
  .action(async (value: string, _o, command: Command) => {
    const o = optsOf<Common & { domain?: boolean; reason?: string }>(command);
    await run(!!o.json, async () => {
      if (!o.domain && !value.includes("@")) {
        throw new UsageError(
          `'${oneLine(value)}' is not an email address; to block a domain add --domain.`,
        );
      }
      if (o.domain && value.includes("@") && !value.startsWith("@")) {
        throw new UsageError("--domain takes a domain (spam.example), not an address.");
      }
      if (o.reason && o.reason.trim().length > 200) {
        throw new UsageError("--reason is limited to 200 characters.");
      }
      const res = await addMailBlock({
        kind: o.domain ? "domain" : "address",
        value,
        ...(o.reason ? { reason: o.reason.trim() } : {}),
      });
      if (o.json) return printJson(res);
      console.log(`${res.created ? "Blocked" : "Already blocked"}: ${renderBlock(res.entry)}`);
    });
  });

const blocklistRemoveCommand = new MailCommand("remove")
  .description("Lift a block")
  .argument("<id>", "Blocklist entry id (see 'blocklist')")
  .option(...jsonOption)
  .action(async (rawId: string, _o, command: Command) => {
    const o = optsOf<Common>(command);
    await run(!!o.json, async () => {
      if (!/^\d{1,12}$/.test(rawId) || Number(rawId) < 1) {
        throw new UsageError(`'${oneLine(rawId)}' is not a blocklist entry id.`);
      }
      const res = await removeMailBlock(Number(rawId));
      if (o.json) return printJson(res);
      console.log(`Removed: ${renderBlock(res.removed)}`);
    });
  });

const blocklistCommand = new MailCommand("blocklist")
  .description("List the sender blocklist; 'blocklist add' and 'blocklist remove' change it")
  .option("--limit <n>", "Page size, 1 to 100 (default 50)")
  .option("--cursor <cursor>", "The next_cursor of the previous page")
  .option(...jsonOption)
  .action(async (_o, command: Command) => {
    const o = optsOf<Common & { limit?: string; cursor?: string }>(command);
    await run(!!o.json, async () => {
      if (
        o.limit !== undefined &&
        (!/^\d{1,3}$/.test(o.limit) || Number(o.limit) < 1 || Number(o.limit) > 100)
      ) {
        throw new UsageError("--limit must be a number from 1 to 100.");
      }
      const res = await listMailBlocklist({
        ...(o.limit !== undefined ? { limit: Number(o.limit) } : {}),
        ...(o.cursor ? { cursor: o.cursor } : {}),
      });
      if (o.json) return printJson(res);
      if (res.entries.length === 0) console.log("The blocklist is empty.");
      for (const e of res.entries) console.log(renderBlock(e));
      if (res.next_cursor) console.log(`More: --cursor ${oneLine(res.next_cursor)}`);
    });
  })
  .addCommand(blocklistAddCommand)
  .addCommand(blocklistRemoveCommand);

const queuesSetCommand = new MailCommand("set")
  .description("Create or change a queue (owner); only the options you give change")
  .argument("<tag>", "Queue tag")
  .option("--strategy <strategy>", QUEUE_STRATEGIES.join(" | "))
  .option("--assignee <user>", "Who a 'fixed' queue assigns to: a user, or 'none'")
  .option("--backup <user>", "Who takes tickets while the assignee is away: a user, or 'none'")
  .option("--members <users>", "Comma-separated users of the rotation (restarts it); '' empties it")
  .option("--escalation <user>", "The escalation owner: a user, or 'none'")
  .option("--restricted <bool>", "true or false: only owners see a restricted queue")
  .option(
    "--notify <bool>",
    "true or false: false makes the queue quiet (no notice for new tickets)",
  )
  .option(...jsonOption)
  .action(async (tag: string, _o, command: Command) => {
    const o = optsOf<
      Common & {
        strategy?: string;
        assignee?: string;
        backup?: string;
        members?: string;
        escalation?: string;
        restricted?: string;
        notify?: string;
      }
    >(command);
    await run(!!o.json, async () => {
      const people = new People();
      const body: PutQueueRequest = {};
      if (o.strategy !== undefined) {
        body.strategy = enumOf(o.strategy, QUEUE_STRATEGIES, "--strategy") as QueueStrategy;
      }
      if (o.restricted !== undefined) {
        body.restricted =
          enumOf(o.restricted, ["true", "false"] as const, "--restricted") === "true";
      }
      if (o.notify !== undefined) {
        body.notify = enumOf(o.notify, ["true", "false"] as const, "--notify") === "true";
      }
      if (o.assignee !== undefined) {
        body.assignee_user_id = await people.resolve(o.assignee, "--assignee", true);
      }
      if (o.backup !== undefined) {
        body.backup_user_id = await people.resolve(o.backup, "--backup", true);
      }
      if (o.escalation !== undefined) {
        body.escalation_user_id = await people.resolve(o.escalation, "--escalation", true);
      }
      if (o.members !== undefined) {
        const members: number[] = [];
        for (const m of o.members
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)) {
          members.push((await people.resolve(m, "--members")) as number);
        }
        body.rr_members = members;
      }
      if (Object.keys(body).length === 0) {
        throw new UsageError("Nothing to change: give at least one option (see --help).");
      }
      const res = await putMailQueue(tag, body);
      if (o.json) return printJson(res);
      const lines = await renderQueue(res.queue, people);
      console.log(["Queue saved.", ...lines].join("\n"));
    });
  });

const queuesCommand = new MailCommand("queues")
  .description("List the queues you may see; 'queues set <tag>' changes one (owner)")
  .option(...jsonOption)
  .action(async (_o, command: Command) => {
    const o = optsOf<Common>(command);
    await run(!!o.json, async () => {
      const res = await listMailQueues();
      if (o.json) return printJson(res);
      if (res.queues.length === 0) return console.log("No queues.");
      const people = new People();
      const blocks: string[] = [];
      for (const q of res.queues) blocks.push((await renderQueue(q, people)).join("\n"));
      console.log(blocks.join("\n\n"));
    });
  })
  .addCommand(queuesSetCommand);

const awayShowCommand = new MailCommand("show")
  .description("Show your away window (--user: anyone's, owner)")
  .option("--user <user>", "Another person (owner only)")
  .option(...jsonOption)
  .action(async (_o, command: Command) => {
    const o = optsOf<Common & { user?: string }>(command);
    await showAway(o);
  });

async function showAway(o: Common & { user?: string }): Promise<void> {
  await run(!!o.json, async () => {
    const people = new People();
    const userId = o.user ? ((await people.resolve(o.user, "--user")) as number) : undefined;
    const res = await getMailAvailability(userId);
    if (o.json) return printJson(res);
    console.log((await renderAvailability(res.availability, people)).join("\n"));
  });
}

const awaySetCommand = new MailCommand("set")
  .description("Set an away window: tickets assigned to you go to your backup meanwhile")
  .option("--from <date>", "Start (ISO 8601 with Z or an offset; default: now)")
  .requiredOption("--until <date>", "End (ISO 8601 with Z or an offset, like 2026-10-24T09:00:00Z)")
  .option("--backup <user>", "Who covers; 'none' for nobody")
  .option("--note <text>", "A note (up to 500 characters)")
  .option("--user <user>", "Set another person's window (owner only)")
  .option(...jsonOption)
  .action(async (_o, command: Command) => {
    const o = optsOf<
      Common & { from?: string; until: string; backup?: string; note?: string; user?: string }
    >(command);
    await run(!!o.json, async () => {
      const people = new People();
      const body: PutAvailabilityRequest = { away_until: instantOf(o.until, "--until") };
      if (o.from !== undefined) body.away_from = instantOf(o.from, "--from");
      if (body.away_from && body.away_from >= (body.away_until as string)) {
        throw new UsageError("--from must be before --until.");
      }
      if (o.backup !== undefined)
        body.backup_user_id = await people.resolve(o.backup, "--backup", true);
      if (o.note !== undefined) {
        if (o.note.length > 500) throw new UsageError("--note is limited to 500 characters.");
        body.note = o.note;
      }
      const userId = o.user ? ((await people.resolve(o.user, "--user")) as number) : undefined;
      const res = await putMailAvailability(body, userId);
      if (o.json) return printJson(res);
      const lines = await renderAvailability(res.availability, people);
      console.log(["Away window set.", ...lines].join("\n"));
    });
  });

const awayClearCommand = new MailCommand("clear")
  .description("Clear an away window")
  .option("--user <user>", "Clear another person's window (owner only)")
  .option(...jsonOption)
  .action(async (_o, command: Command) => {
    const o = optsOf<Common & { user?: string }>(command);
    await run(!!o.json, async () => {
      const people = new People();
      const userId = o.user ? ((await people.resolve(o.user, "--user")) as number) : undefined;
      const res = await putMailAvailability(
        { away_from: null, away_until: null, backup_user_id: null, note: null },
        userId,
      );
      if (o.json) return printJson(res);
      const lines = await renderAvailability(res.availability, people);
      console.log(["Away window cleared.", ...lines].join("\n"));
    });
  });

const awayCommand = new MailCommand("away")
  .description("Show, set or clear your away window (set and clear: --user for an owner)")
  .option("--user <user>", "Another person (owner only)")
  .option(...jsonOption)
  .action(async (_o, command: Command) => {
    await showAway(optsOf<Common & { user?: string }>(command));
  })
  .addCommand(awayShowCommand)
  .addCommand(awaySetCommand)
  .addCommand(awayClearCommand);

const reprocessCommand = new MailCommand("reprocess")
  .description("Rebuild a ticket from a stored raw message (owner)")
  .argument("<raw_key>", "inbound/raw/YYYY/MM/DD/<uuid>.eml")
  .option(...jsonOption)
  .action(async (rawKey: string, _o, command: Command) => {
    const o = optsOf<Common>(command);
    await run(!!o.json, async () => {
      if (!/^inbound\/raw\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.eml$/.test(rawKey)) {
        throw new UsageError("That is not a raw key (inbound/raw/YYYY/MM/DD/<uuid>.eml).");
      }
      const res = await reprocessMail(rawKey);
      if (o.json) return printJson(res);
      console.log(`${oneLine(res.outcome)}: ticket #${res.ticket_id} (${oneLine(res.status)}).`);
    });
  });

export const mailCommand = new MailCommand("mail")
  .description("Support tickets (exit: 0 ok, 1 error, 2 usage, 3 not found, 4 not permitted)")
  .addHelpText(
    "after",
    `${EXIT_HELP}
Examples:
  nemar admin mail list --mine
  nemar admin mail show 42
  nemar admin mail reply 42 --text "Thanks, this is fixed." --yes
  nemar admin mail assign 42 me
  nemar admin mail close 42`,
  )
  .addCommand(listCommand)
  .addCommand(showCommand)
  .addCommand(replyCommand)
  .addCommand(noteCommand)
  .addCommand(summarizeCommand)
  .addCommand(assignCommand)
  .addCommand(statusCommand)
  .addCommand(closeCommand)
  .addCommand(escalateCommand)
  .addCommand(spamCommand)
  .addCommand(blocklistCommand)
  .addCommand(queuesCommand)
  .addCommand(awayCommand)
  .addCommand(reprocessCommand);
