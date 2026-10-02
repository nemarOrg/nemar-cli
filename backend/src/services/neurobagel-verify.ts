/**
 * The Neurobagel verification sweep (epic #1586, phase 6; ADR 0067's amendment).
 *
 * A daily sweep that answers one question, "does the federation hold exactly what it
 * should?", and REPORTS the answer. It never repairs: no write to the store, no delete,
 * no D1 write except its own heartbeat and (for one anonymity-class case) an audit row.
 * A repair would destroy the evidence that a guarantee failed (ADR 0067), and the writer
 * already owns every correction (ADR 0084).
 *
 * FOUR CHECKS, each ending in a verdict (ADR 0053, ADR 0054):
 *
 *   store         the artifact store against the eligibility predicate: residue (artifacts or
 *                 an index entry for a dataset that is no longer eligible) and eligible
 *                 datasets missing for more than 48 hours.
 *   node          the private node, as seen over its network address: it serves no ineligible
 *                 dataset and every record validates, protected. Configured by
 *                 NEUROBAGEL_NODE_URL.
 *   registration  the public federation lists NEMAR and reports no error for it. Configured
 *                 by NEUROBAGEL_FEDERATION_URL.
 *   drift         upstream release tags and vocabulary files against the pins
 *                 (neurobagel-drift.ts).
 *
 * VERDICTS. `healthy`, `alarm`, `unknown`, and `unchecked`:
 *   - A check that is not configured here is `unchecked`, shown as such, NEVER healthy.
 *   - A check that was configured and could not be answered (a failed read, a thrown error)
 *     is `unknown`: never zero, never healthy, never an alarm.
 *   - `alarm` only when there was outstanding work. An empty store with nothing eligible is
 *     healthy; a store nobody is maintaining (the writer is off) is `unchecked`.
 *   - Residue is an alarm only when it PERSISTS. The writer's daily reconcile removes what
 *     is no longer eligible, and the read route already hides it (ADR 0084, item 3), so a
 *     dataset withdrawn this morning is expected to be residue until that run. A dataset
 *     seen as residue by a sweep at least 20 hours earlier has survived a whole reconcile,
 *     which is the failure. The earlier sweep's residue is remembered as short digests in
 *     its heartbeat, never as dataset ids.
 *   - "Missing" is dated from the later of the dataset's first publication and the clock's
 *     origin: the writer's first recorded run, or the first sweep that saw the writer
 *     enabled. A dataset eligible for months before the writer was switched on is not
 *     "missing for months".
 *
 * THE HEARTBEAT. Every run writes one `audit_log` row, even when the sweep throws (a throw
 * becomes an `unknown` verdict for every check and a logged failure). Three states have to
 * be distinguishable: the job ran and found things, ran and found nothing, did not run
 * (ADR 0054).
 *
 * WHAT IS NEVER SAID. Counts and public upstream tags only. A residue or served dataset
 * may be an anonymous deposit, so no output of this module names a dataset: not the route,
 * not the heartbeat, not the weekly report. The one anonymity-class case the node check can
 * find, a served record that is an anonymous deposit's, goes to the audit log and nowhere
 * else: no GitHub issue, no mail (this module loads no mail code, and a source scan holds
 * it to that). The anonymity sweep owns the mail category (ADR 0067).
 *
 * The cron wrapper is production-only and absent from `DEV_CRON_ALLOWLIST`; the sweep
 * function itself is unguarded so the admin route works on staging.
 */

import {
  NEUROBAGEL_CHECKS,
  type NeurobagelCheckName,
  type NeurobagelCheckResult,
  type NeurobagelVerdict,
  type NeurobagelVerification,
  type NeurobagelVerifyResult,
} from "../../../shared/contract/neurobagel-admin.js";
import { datasetName, nbIdentifier } from "../../../shared/neurobagel/identifiers.js";
import { VOCAB } from "../../../shared/neurobagel/vocab.js";
import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { isNonProductionEnv } from "./environment.js";
import { checkUpstreamDrift } from "./neurobagel-drift.js";
import { LEDGER_ACTIONS, hasCompleteSet, ledgerTime, loadPlanRows } from "./neurobagel-plan.js";
import { listStore, readStoredIndex, sha256OfBytes } from "./neurobagel-store.js";
import { neurobagelWriterMode } from "./neurobagel-writer.js";

export type {
  NeurobagelCheckName,
  NeurobagelCheckResult,
  NeurobagelVerdict,
  NeurobagelVerification,
  NeurobagelVerifyResult,
};

export const VERIFY_ACTIONS = {
  /** One row per run, whatever happened. */
  heartbeat: "neurobagel_verification",
  /** A served record that is an anonymous deposit's: the audit log, and nowhere else. */
  nodeAnonymity: "neurobagel_verify_anonymity_finding",
} as const;

/** How long an eligible dataset may be missing from the store before it is an alarm. */
export const MISSING_GRACE_MS = 48 * 60 * 60 * 1000;

/**
 * How old a previous sweep must be to count as evidence that residue PERSISTS: older than
 * an on-demand run an hour earlier, younger than a missed day (20 hours, as the anonymity
 * sweep uses for its own daily cadence).
 */
export const PERSISTENCE_MIN_AGE_MS = 20 * 60 * 60 * 1000;

/** Residue digests a heartbeat remembers. More residue than this is an alarm by itself. */
export const RESIDUE_MEMORY_CAP = 200;

/** The name the registration lists the node under. */
export const NEMAR_NODE_NAME = "NEMAR";

const DEFAULT_TIMEOUT_MS = 20_000;

// ----------------------------------------------------------------------------
// Verdicts
// ----------------------------------------------------------------------------

const verdict = (
  v: NeurobagelVerdict,
  reason: string,
  counts: Record<string, number | null> = {},
): NeurobagelCheckResult => ({ verdict: v, reason, counts });

/**
 * The worst verdict among the checks that RAN: alarm, then unknown, then healthy; and
 * `unchecked` when none ran. An unchecked check is neither good nor bad news, so it does
 * not move the answer, and it never makes one healthy that was not.
 */
export function overallVerdict(
  checks: Record<NeurobagelCheckName, NeurobagelCheckResult>,
): NeurobagelVerdict {
  const verdicts = NEUROBAGEL_CHECKS.map((name) => checks[name].verdict);
  if (verdicts.includes("alarm")) return "alarm";
  if (verdicts.includes("unknown")) return "unknown";
  if (verdicts.includes("healthy")) return "healthy";
  return "unchecked";
}

// ----------------------------------------------------------------------------
// Check: the store against the predicate
// ----------------------------------------------------------------------------

/** What the store holds, set against what the predicate says, as plain data. */
export interface StoreObservation {
  eligible: number;
  /** In the index with a complete artifact set. */
  written: number;
  index_entries: number;
  /** Eligible datasets without a complete set or an index entry. `published` is `first_published_at`. */
  missing: { published: string | null }[];
  /** Digests of the ids of stored artifacts or index entries that are no longer eligible. */
  residue: string[];
  /** Digests the previous qualifying sweep saw, or null when there was none. */
  previousResidue: ReadonlySet<string> | null;
  /** The clock a dataset's "missing" starts no earlier than. */
  origin: Date;
}

/** The store check's verdict from its observation. Pure: the rules, with nothing else. */
export function judgeStore(obs: StoreObservation, now: Date): NeurobagelCheckResult {
  const overdue = obs.missing.filter((m) => {
    const published = m.published === null ? null : ledgerTime(m.published);
    // A publication time that cannot be read cannot be shown young: it counts as overdue.
    const since =
      published === null
        ? obs.origin
        : new Date(Math.max(published.getTime(), obs.origin.getTime()));
    return now.getTime() - since.getTime() > MISSING_GRACE_MS;
  }).length;
  const persisting =
    obs.previousResidue === null
      ? 0
      : obs.residue.filter((d) => obs.previousResidue?.has(d)).length;
  const tooMuch = obs.residue.length > RESIDUE_MEMORY_CAP;
  const counts = {
    eligible: obs.eligible,
    written: obs.written,
    index_entries: obs.index_entries,
    missing: obs.missing.length,
    missing_overdue: overdue,
    residue: obs.residue.length,
    residue_persisting: persisting,
  };
  const problems: string[] = [];
  if (overdue > 0) {
    problems.push(
      `${overdue} eligible dataset(s) have been missing from the store for more than 48 hours`,
    );
  }
  if (persisting > 0) {
    problems.push(
      `${persisting} dataset(s) that are no longer eligible are still in the store or its index after a whole day`,
    );
  }
  if (tooMuch) {
    problems.push(
      `${obs.residue.length} stored datasets are no longer eligible, more than the ${RESIDUE_MEMORY_CAP} this sweep can follow`,
    );
  }
  if (problems.length > 0) return verdict("alarm", `${problems.join("; ")}.`, counts);
  const notes: string[] = [];
  if (obs.residue.length > 0) {
    notes.push(
      `${obs.residue.length} first seen as no longer eligible (due for removal at the next reconcile)`,
    );
  }
  if (obs.missing.length > 0) {
    notes.push(`${obs.missing.length} not yet in the store, none for more than 48 hours`);
  }
  return verdict(
    "healthy",
    `${obs.eligible} eligible dataset(s), ${obs.written} written and indexed${notes.length > 0 ? `; ${notes.join("; ")}` : "; no residue"}.`,
    counts,
  );
}

interface EligibleRead {
  ok: true;
  rows: { dataset_id: string; first_published_at: string | null }[];
}
type EligibleOutcome = EligibleRead | { ok: false; error: string };

interface Memory {
  residue: string[];
  origin: string | null;
}

/** What one check hands back: its verdict, what the next sweep should remember, and warnings. */
interface CheckOutcome {
  result: NeurobagelCheckResult;
  memory?: Memory;
  warnings?: string[];
}

async function digestOf(id: string): Promise<string> {
  return (await sha256OfBytes(new TextEncoder().encode(id))).slice(0, 16);
}

/** The store check. Throws only on a failed read, which the caller turns into `unknown`. */
async function checkStore(
  env: Bindings,
  eligible: EligibleOutcome,
  previous: { residue: ReadonlySet<string> | null; origin: Date | null },
  firstWriterRun: Date | null,
  now: Date,
): Promise<CheckOutcome> {
  const none: Memory = { residue: [], origin: null };
  const mode = neurobagelWriterMode(env);
  if (mode === "store_unconfigured") {
    return {
      result: verdict("unchecked", "No NEUROBAGEL bucket is bound, so there is no store to check."),
      memory: none,
    };
  }
  if (mode === "disabled" || !env.NEUROBAGEL) {
    return {
      result: verdict(
        "unchecked",
        "The writer is off, so nothing maintains the store and none of it is judged.",
      ),
      memory: none,
    };
  }
  if (!eligible.ok) {
    return {
      result: verdict(
        "unknown",
        "The eligible datasets could not be read, so the store could not be judged.",
      ),
      memory: none,
    };
  }
  const listing = await listStore(env.NEUROBAGEL);
  const index = await readStoredIndex(env.NEUROBAGEL);
  const indexIds = new Set((index.document?.datasets ?? []).map((d) => d.id));
  const eligibleIds = new Set(eligible.rows.map((r) => r.dataset_id));

  let written = 0;
  const missing: { published: string | null }[] = [];
  for (const row of eligible.rows) {
    if (hasCompleteSet(listing.datasets.get(row.dataset_id)) && indexIds.has(row.dataset_id))
      written++;
    else missing.push({ published: row.first_published_at });
  }
  const residueIds = new Set<string>();
  for (const id of listing.datasets.keys()) if (!eligibleIds.has(id)) residueIds.add(id);
  for (const id of indexIds) if (!eligibleIds.has(id)) residueIds.add(id);
  const residue = await Promise.all([...residueIds].sort().map(digestOf));

  // The origin of "missing": the writer's first run, else what an earlier sweep recorded,
  // else now. It is remembered so a writer that is enabled and never runs still ages.
  const origin = firstWriterRun ?? previous.origin ?? now;
  const result = judgeStore(
    {
      eligible: eligible.rows.length,
      written,
      index_entries: indexIds.size,
      missing,
      residue,
      previousResidue: previous.residue,
      origin,
    },
    now,
  );
  return {
    result,
    memory: { residue: residue.slice(0, RESIDUE_MEMORY_CAP), origin: origin.toISOString() },
  };
}

// ----------------------------------------------------------------------------
// Check: the node, as seen over the network
// ----------------------------------------------------------------------------

type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

async function request(
  url: string,
  init: { method: "GET" | "POST"; body?: string },
  timeoutMs: number,
): Promise<Read<unknown>> {
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: {
        "User-Agent": "nemar-neurobagel-verify/1.0 (+https://nemar.org)",
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: init.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 2xx all count: the public federation answers 207 when some node failed.
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    try {
      return { ok: true, value: await res.json() };
    } catch {
      return { ok: false, reason: "the answer was not JSON" };
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return {
      ok: false,
      reason: name === "TimeoutError" || name === "AbortError" ? "timed out" : "network error",
    };
  }
}

/** A configured address, trimmed of trailing slashes, or null when unset or blank. */
function configured(value: string | undefined): string | null {
  const v = value?.trim().replace(/\/+$/, "");
  return v ? v : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why one record of the node's dataset list would not validate. Pure. */
export function recordProblems(record: unknown): string[] {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return ["not an object"];
  }
  const r = record as Record<string, unknown>;
  const problems: string[] = [];
  const iri = r.dataset_uuid;
  if (
    typeof iri !== "string" ||
    !iri.startsWith(VOCAB.namespaces.nb) ||
    !UUID.test(iri.slice(VOCAB.namespaces.nb.length))
  ) {
    problems.push("dataset_uuid");
  }
  if (typeof r.dataset_name !== "string" || r.dataset_name === "") problems.push("dataset_name");
  for (const field of ["dataset_total_subjects", "num_matching_subjects"]) {
    const n = r[field];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) problems.push(field);
  }
  if (typeof r.records_protected !== "boolean") problems.push("records_protected");
  if (!Array.isArray(r.image_modals) || r.image_modals.some((m) => typeof m !== "string")) {
    problems.push("image_modals");
  }
  // NEMAR never publishes a contact address: a record that carries one is not ours.
  if (r.access_email !== undefined && r.access_email !== null) problems.push("access_email");
  return problems;
}

/** What the node served, set against who may be served. */
export interface NodeObservation {
  records: unknown[];
  /** The IRI each eligible dataset is served under. */
  eligible: ReadonlySet<string>;
  /** The IRI of each anonymous deposit (or a row whose anonymity is unknown). */
  anonymous: ReadonlySet<string>;
}

export function judgeNode(obs: NodeObservation): {
  result: NeurobagelCheckResult;
  anonymousServed: string[];
} {
  let invalid = 0;
  let unprotected = 0;
  let ineligible = 0;
  const anonymousServed: string[] = [];
  const served = new Set<string>();
  for (const record of obs.records) {
    if (recordProblems(record).length > 0) invalid++;
    const r = (typeof record === "object" && record !== null ? record : {}) as Record<
      string,
      unknown
    >;
    if (r.records_protected === false) unprotected++;
    const iri = typeof r.dataset_uuid === "string" ? r.dataset_uuid : null;
    if (iri === null) continue;
    served.add(iri);
    if (obs.anonymous.has(iri)) anonymousServed.push(iri);
    if (!obs.eligible.has(iri)) ineligible++;
  }
  const notServed = [...obs.eligible].filter((iri) => !served.has(iri)).length;
  const counts = {
    records: obs.records.length,
    invalid,
    unprotected,
    ineligible_served: ineligible,
    anonymous_served: anonymousServed.length,
    eligible_not_served: notServed,
  };
  const problems: string[] = [];
  if (ineligible > 0) {
    problems.push(
      `${ineligible} record(s) are for datasets that are not eligible${anonymousServed.length > 0 ? ` (${anonymousServed.length} anonymity-class, recorded in the audit log)` : ""}; the node may still hold a release from before a takedown until its next reload`,
    );
  }
  if (invalid > 0) problems.push(`${invalid} record(s) do not validate`);
  if (unprotected > 0) problems.push(`${unprotected} record(s) are not protected`);
  if (problems.length > 0) {
    return {
      result: verdict("alarm", `The node serves ${problems.join("; ")}.`, counts),
      anonymousServed,
    };
  }
  return {
    result: verdict(
      "healthy",
      `The node serves ${obs.records.length} valid, protected record(s), all for eligible datasets${notServed > 0 ? `; ${notServed} eligible dataset(s) are not served yet (the node reloads once a day)` : ""}.`,
      counts,
    ),
    anonymousServed,
  };
}

async function iriOf(datasetId: string): Promise<string> {
  const id = await nbIdentifier(datasetName(datasetId));
  // `nb:<uuid>` in a graph, `<namespace><uuid>` in the node's answers.
  return `${VOCAB.namespaces.nb}${id.slice("nb:".length)}`;
}

const ANONYMOUS_ROWS_SQL = "SELECT dataset_id FROM datasets WHERE anonymous IS NOT 0";

async function checkNode(
  env: Bindings,
  eligible: EligibleOutcome,
  timeoutMs: number,
): Promise<CheckOutcome> {
  const warnings: string[] = [];
  const base = configured(env.NEUROBAGEL_NODE_URL);
  if (base === null) {
    return {
      result: verdict("unchecked", "NEUROBAGEL_NODE_URL is not set, so the node is not probed."),
      warnings,
    };
  }
  if (!eligible.ok) {
    return {
      result: verdict(
        "unknown",
        "The eligible datasets could not be read, so the node's answer could not be judged.",
      ),
      warnings,
    };
  }
  // The same question the federation asks: the empty datasets query.
  const read = await request(`${base}/datasets`, { method: "POST", body: "{}" }, timeoutMs);
  if (!read.ok) {
    return {
      result: verdict("unknown", `The node did not answer the datasets query (${read.reason}).`),
      warnings,
    };
  }
  if (!Array.isArray(read.value)) {
    return {
      result: verdict(
        "alarm",
        "The node answered the datasets query with something that is not a list.",
      ),
      warnings,
    };
  }
  const anonymousRows = await env.DB.prepare(ANONYMOUS_ROWS_SQL).all<{ dataset_id: string }>();
  const anonymousByIri = new Map<string, string>();
  for (const row of anonymousRows.results ?? []) {
    anonymousByIri.set(await iriOf(row.dataset_id), row.dataset_id);
  }
  const eligibleIris = new Set(await Promise.all(eligible.rows.map((r) => iriOf(r.dataset_id))));
  const { result, anonymousServed } = judgeNode({
    records: read.value,
    eligible: eligibleIris,
    anonymous: new Set(anonymousByIri.keys()),
  });
  // The durable, private record of the one finding that must never leave the audit log.
  for (const iri of anonymousServed) {
    try {
      await auditLogStatement(env.DB, {
        userId: null,
        action: VERIFY_ACTIONS.nodeAnonymity,
        resourceType: "dataset",
        resourceId: anonymousByIri.get(iri) ?? null,
        details: JSON.stringify({ check: "node_serves_anonymous_record" }),
      }).run();
    } catch (err) {
      warnings.push(
        `the anonymity-class audit row failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { result, warnings };
}

// ----------------------------------------------------------------------------
// Check: registration with the public federation
// ----------------------------------------------------------------------------

const same = (a: unknown, b: string): boolean =>
  typeof a === "string" && a.trim().toLowerCase() === b.toLowerCase();

/** Is NEMAR in the federation's node list? Null when the answer is not a list. Pure. */
export function nemarListed(nodes: unknown): boolean | null {
  if (!Array.isArray(nodes)) return null;
  return nodes.some((n) => same((n as { NodeName?: unknown } | null)?.NodeName, NEMAR_NODE_NAME));
}

/** The registration verdict from the federation's answers. Pure; `diagnoses` is read only when listed. */
export function judgeRegistration(nodes: unknown, diagnoses: unknown): NeurobagelCheckResult {
  const listed = nemarListed(nodes);
  if (listed === null) {
    return verdict(
      "unknown",
      "The federation's node list was not a list, so registration could not be judged.",
    );
  }
  const total = (nodes as unknown[]).length;
  if (!listed) {
    return verdict("alarm", `The federation's node list does not include ${NEMAR_NODE_NAME}.`, {
      nodes_listed: total,
      nemar_listed: 0,
      nemar_errors: null,
    });
  }
  const errors = (diagnoses as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) {
    return verdict(
      "unknown",
      "The federation's diagnoses answer carried no error list, so the node's health could not be judged.",
      { nodes_listed: total, nemar_listed: 1, nemar_errors: null },
    );
  }
  const failing = errors.some((e) =>
    same((e as { node_name?: unknown } | null)?.node_name, NEMAR_NODE_NAME),
  );
  const counts = { nodes_listed: total, nemar_listed: 1, nemar_errors: failing ? 1 : 0 };
  return failing
    ? verdict(
        "alarm",
        `${NEMAR_NODE_NAME} is listed, but the federation reports an error for it.`,
        counts,
      )
    : verdict(
        "healthy",
        `${NEMAR_NODE_NAME} is listed by the federation and reports no error.`,
        counts,
      );
}

async function checkRegistration(env: Bindings, timeoutMs: number): Promise<NeurobagelCheckResult> {
  const base = configured(env.NEUROBAGEL_FEDERATION_URL);
  if (base === null) {
    return verdict(
      "unchecked",
      "NEUROBAGEL_FEDERATION_URL is not set, so registration is not checked.",
    );
  }
  const nodes = await request(`${base}/nodes`, { method: "GET" }, timeoutMs);
  if (!nodes.ok) {
    return verdict("unknown", `The federation's node list could not be read (${nodes.reason}).`);
  }
  // Not listed needs no second question; listed asks whether the federation could reach it.
  if (nemarListed(nodes.value) !== true) return judgeRegistration(nodes.value, null);
  const diagnoses = await request(`${base}/diagnoses`, { method: "GET" }, timeoutMs);
  if (!diagnoses.ok) {
    return verdict(
      "unknown",
      `The federation's diagnoses could not be read (${diagnoses.reason}).`,
      {
        nodes_listed: (nodes.value as unknown[]).length,
        nemar_listed: 1,
        nemar_errors: null,
      },
    );
  }
  return judgeRegistration(nodes.value, diagnoses.value);
}

// ----------------------------------------------------------------------------
// The run, and its heartbeat
// ----------------------------------------------------------------------------

export interface VerifyOptions {
  /** `cron` for the daily run; anything else is recorded as an on-demand run. */
  trigger?: "cron" | "admin";
  now?: Date;
  /** Seams for a test's local servers. Production passes none. */
  upstreamApiBase?: string;
  timeoutMs?: number;
}

const HEARTBEAT_LATEST_SQL =
  "SELECT details, timestamp FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1";
const HEARTBEAT_BEFORE_SQL =
  "SELECT details, timestamp FROM audit_log WHERE action = ? AND timestamp <= ? ORDER BY id DESC LIMIT 1";
const FIRST_WRITER_RUN_SQL = "SELECT MIN(timestamp) AS first_run FROM audit_log WHERE action = ?";

/** An instant in SQLite's `datetime()` shape, which `audit_log.timestamp` is written in. */
function toSqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function isVerdict(v: unknown): v is NeurobagelVerdict {
  return v === "healthy" || v === "alarm" || v === "unknown" || v === "unchecked";
}

/** A stored heartbeat's details as a verification, or null when it is not one. */
export function parseHeartbeat(
  details: string | null,
): { verification: NeurobagelVerification; memory: Memory | null } | null {
  if (!details) return null;
  try {
    const d = JSON.parse(details) as Partial<NeurobagelVerification> & { memory?: Partial<Memory> };
    if (typeof d.at !== "string" || typeof d.trigger !== "string" || !isVerdict(d.overall))
      return null;
    if (typeof d.checks !== "object" || d.checks === null) return null;
    for (const name of NEUROBAGEL_CHECKS) {
      const c = d.checks[name];
      if (!c || !isVerdict(c.verdict) || typeof c.reason !== "string") return null;
    }
    const memory =
      Array.isArray(d.memory?.residue) && d.memory.residue.every((x) => typeof x === "string")
        ? {
            residue: d.memory.residue,
            origin: typeof d.memory.origin === "string" ? d.memory.origin : null,
          }
        : null;
    return {
      verification: {
        at: d.at,
        trigger: d.trigger,
        failed: d.failed === true,
        ...(typeof d.error === "string" ? { error: d.error } : {}),
        overall: d.overall,
        checks: d.checks as NeurobagelVerification["checks"],
        warnings: Array.isArray(d.warnings) ? d.warnings.filter((w) => typeof w === "string") : [],
      },
      memory,
    };
  } catch {
    return null;
  }
}

/** The latest heartbeat of any trigger. `none` means no run is recorded: unknown, not healthy. */
export async function readLatestVerification(
  db: D1Database,
): Promise<
  { kind: "none" } | { kind: "unreadable" } | { kind: "ok"; verification: NeurobagelVerification }
> {
  const row = await db
    .prepare(HEARTBEAT_LATEST_SQL)
    .bind(VERIFY_ACTIONS.heartbeat)
    .first<{ details: string | null; timestamp: string }>();
  if (!row) return { kind: "none" };
  const parsed = parseHeartbeat(row.details);
  return parsed ? { kind: "ok", verification: parsed.verification } : { kind: "unreadable" };
}

async function readPrevious(
  db: D1Database,
  now: Date,
): Promise<{ residue: ReadonlySet<string> | null; origin: Date | null }> {
  const row = await db
    .prepare(HEARTBEAT_BEFORE_SQL)
    .bind(VERIFY_ACTIONS.heartbeat, toSqliteUtc(new Date(now.getTime() - PERSISTENCE_MIN_AGE_MS)))
    .first<{ details: string | null; timestamp: string }>();
  const parsed = row ? parseHeartbeat(row.details) : null;
  const memory = parsed?.memory ?? null;
  return {
    residue: memory === null ? null : new Set(memory.residue),
    origin: memory?.origin ? new Date(memory.origin) : null,
  };
}

async function readFirstWriterRun(db: D1Database): Promise<Date | null> {
  const row = await db
    .prepare(FIRST_WRITER_RUN_SQL)
    .bind(LEDGER_ACTIONS.run)
    .first<{ first_run: string | null }>();
  return row?.first_run ? ledgerTime(row.first_run) : null;
}

async function readEligible(db: D1Database): Promise<EligibleOutcome> {
  try {
    const { rows } = await loadPlanRows(db);
    return {
      ok: true,
      rows: rows.map((r) => ({
        dataset_id: r.dataset_id,
        first_published_at: r.first_published_at,
      })),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const errText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 300);

/** Run one check; a throw becomes an `unknown` verdict, a logged failure and a warning. */
async function contained(
  name: NeurobagelCheckName,
  run: () => Promise<CheckOutcome>,
  warnings: string[],
): Promise<CheckOutcome> {
  try {
    const outcome = await run();
    warnings.push(...(outcome.warnings ?? []));
    return outcome;
  } catch (err) {
    console.error(`[neurobagel] verification check ${name} failed:`, err);
    warnings.push(`${name}: ${errText(err)}`);
    return {
      result: verdict(
        "unknown",
        "The check could not run to an answer (see the Worker logs), which is not a healthy result.",
      ),
    };
  }
}

async function runChecks(
  env: Bindings,
  now: Date,
  trigger: string,
  opts: VerifyOptions,
): Promise<{ verification: NeurobagelVerification; memory: Memory }> {
  const warnings: string[] = [];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const eligible = await readEligible(env.DB);
  if (!eligible.ok) warnings.push(`eligible datasets: ${eligible.error.slice(0, 300)}`);

  let previous: { residue: ReadonlySet<string> | null; origin: Date | null } = {
    residue: null,
    origin: null,
  };
  let firstWriterRun: Date | null = null;
  try {
    previous = await readPrevious(env.DB, now);
    firstWriterRun = await readFirstWriterRun(env.DB);
  } catch (err) {
    // Without history nothing can be shown to persist, and the store check says what it had.
    warnings.push(`history: ${errText(err)}`);
  }

  const [store, node, registration, drift] = await Promise.all([
    contained("store", () => checkStore(env, eligible, previous, firstWriterRun, now), warnings),
    contained("node", () => checkNode(env, eligible, timeoutMs), warnings),
    contained(
      "registration",
      async () => ({ result: await checkRegistration(env, timeoutMs) }),
      warnings,
    ),
    contained(
      "drift",
      async () => ({
        result: await checkUpstreamDrift({
          apiBase: opts.upstreamApiBase,
          timeoutMs: Math.min(timeoutMs, 8000),
        }),
      }),
      warnings,
    ),
  ]);
  const checks = {
    store: store.result,
    node: node.result,
    registration: registration.result,
    drift: drift.result,
  };
  return {
    verification: {
      at: now.toISOString(),
      trigger,
      failed: false,
      overall: overallVerdict(checks),
      checks,
      warnings,
    },
    memory: store.memory ?? { residue: [], origin: null },
  };
}

/** What a sweep that threw reports: every check unknown, and why. */
export function failedVerification(
  now: Date,
  trigger: string,
  err: unknown,
): NeurobagelVerification {
  const unknown = verdict(
    "unknown",
    "The sweep itself failed before it could judge this check (see the Worker logs).",
  );
  return {
    at: now.toISOString(),
    trigger,
    failed: true,
    error: errText(err),
    overall: "unknown",
    checks: { store: unknown, node: unknown, registration: unknown, drift: unknown },
    warnings: [],
  };
}

async function writeHeartbeat(
  db: D1Database,
  v: NeurobagelVerification,
  memory: Memory | null,
): Promise<void> {
  await auditLogStatement(db, {
    userId: null,
    action: VERIFY_ACTIONS.heartbeat,
    resourceType: "neurobagel",
    resourceId: v.trigger,
    details: JSON.stringify({ ...v, ...(memory ? { memory } : {}) }),
  }).run();
}

/**
 * Run the sweep once and record its heartbeat. Never throws and never repairs. The function
 * is unguarded so the admin route works anywhere; the cron wrapper below carries the fence.
 */
export async function runNeurobagelVerificationSweep(
  env: Bindings,
  opts: VerifyOptions = {},
): Promise<NeurobagelVerifyResult> {
  const now = opts.now ?? new Date();
  const trigger = opts.trigger ?? "admin";
  let verification: NeurobagelVerification;
  let memory: Memory | null = null;
  try {
    ({ verification, memory } = await runChecks(env, now, trigger, opts));
  } catch (err) {
    console.error("[neurobagel] verification sweep failed:", err);
    verification = failedVerification(now, trigger, err);
  }
  // Written even when the sweep threw: a heartbeat that stops on failure turns a broken
  // job into "did not run" (ADR 0054).
  let heartbeatWritten = false;
  try {
    await writeHeartbeat(env.DB, verification, memory);
    heartbeatWritten = true;
  } catch (err) {
    console.error("[neurobagel] verification heartbeat failed:", err);
    verification.warnings.push(`the heartbeat could not be written: ${errText(err)}`);
  }
  return { ...verification, heartbeat_written: heartbeatWritten };
}

/**
 * The daily entry point: PRODUCTION ONLY, and absent from `DEV_CRON_ALLOWLIST`. The fence
 * lives here so the admin route still works on staging.
 */
export async function runNeurobagelVerificationSweepCron(
  env: Bindings,
): Promise<NeurobagelVerifyResult | null> {
  if (isNonProductionEnv(env)) {
    console.log("[neurobagel] verification skipped (non-production)");
    return null;
  }
  return runNeurobagelVerificationSweep(env, { trigger: "cron" });
}

/** The cron's one log line. */
export function verificationLogLine(r: NeurobagelVerification): string {
  return `[neurobagel] verification overall=${r.overall}${r.failed ? " FAILED" : ""} ${NEUROBAGEL_CHECKS.map((c) => `${c}=${r.checks[c].verdict}`).join(" ")}`;
}
