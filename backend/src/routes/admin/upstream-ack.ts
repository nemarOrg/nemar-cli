/**
 * Admin route: batch acknowledgment of identifier screens on a confirmed public upstream (epic
 * #2182, card D3; ADR 0086, amendment 2026-11-25).
 *
 *   POST /admin/publish/acknowledge-batch
 *
 * A DRY RUN unless the body says `apply: true`. The dry run selects requests (`dataset_ids`, or
 * `all_requested` paged by `after`), reads each one and reports a per-request outcome from
 * `shared/upstream-ack.ts`: `eligible` or `not_eligible:<reason>`, with what it read (the screen
 * state and screened commit) and the reason it would record. It writes nothing.
 *
 * An apply carries `expect`, the entries the dry run reported eligible with the state and commit
 * it showed. For each one the route reads the request again, compares, runs the whole rule again,
 * and records the acknowledgment with `recordScreenAcknowledgment`, as the calling administrator,
 * conditional on the exact stored report it read. A request that changed answers `state_moved`
 * and nothing is recorded for it. Nothing is approved: an acknowledgment is a recorded reason on
 * the request, which counts only for the administrator who gave it (ADR 0086).
 *
 * At most {@link ACK_BATCH_MAX} (20) requests per call, for the Worker's subrequest budget. Network
 * reads per eligible-looking request: the repository's `main` ref, the screened commit's recursive
 * tree, up to six repository files and the registry records (cached per DOI); a request that fails
 * a database-only check reads nothing. The command pages at the same size.
 *
 * Photo, face and questionnaire files are looked for twice: in the screened commit's own tree
 * (`treeEligibility`, the same classifier as the measurement), and in D2's measurement, which also
 * saw files only in history (`shared/upstream-ack-excluded.ts`, generated from d2-blockers.json and
 * checked by `exclusionsOf`; one that does not check refuses the whole call, fail closed).
 *
 * Each request is evaluated and recorded on its own: an error in one is that request's outcome
 * (`not_eligible:evaluation_failed`, or `not_recorded:write_failed` for a write that failed; a guard
 * that no longer matches is `state_moved`), and the response always
 * carries every request's outcome. An acknowledgment is never left without its audit row.
 *
 * 400 a malformed body; 500 the exclusions do not check; 502 no GitHub credential. Every message
 * is `UPSTREAM_ACK_COPY`'s.
 */

import type { ScreenReport } from "../../../../shared/identifier-screen-report.js";
import type { LineageResult } from "../../../../shared/license-lineage.js";
import { PUBLICATION_DATASET_ID_RE } from "../../../../shared/publication-limits.js";
import { UPSTREAM_ACK_EXCLUSIONS } from "../../../../shared/upstream-ack-excluded.js";
import {
  ACK_BATCH_MAX,
  type AckResult,
  type D2Exclusions,
  type AckExpected as Expected,
  type NotEligibleReason,
  UPSTREAM_ACK_ANCHOR,
  UPSTREAM_ACK_COPY,
  UPSTREAM_ACK_DOCS_URL,
  type UpstreamAckMessage,
  buildAckReason,
  exclusionsOf,
  lineageEligibility,
  reasonEligibility,
  screenEligibility,
  treeEligibility,
} from "../../../../shared/upstream-ack.js";
import { AUDIT_DETAILS_MAX_BYTES } from "../../db/audit-log";
import { getDatasetsToken } from "../../services/github-auth";
import { GITHUB_API, ORG_NAME } from "../../services/github/shared";
import { githubFetchWithRetry } from "../../services/github/transport";
import {
  isScreenExempt,
  readStoredReport,
  readStoredState,
  recordScreenAcknowledgment,
  verifyScreenHead,
} from "../../services/identifier-screen";
import { extractRepoName } from "../../services/repo-metadata";
import type { Bindings } from "../../types/bindings";
import { readDatasetLineage } from "./license-lineage";
import type { AdminRouter } from "./shared";

/** How many requests are read at once inside one call. */
const CONCURRENCY = 4;

/** The columns one evaluation reads. */
interface AckRow {
  id: number;
  dataset_id: string;
  status: string;
  identifier_screen_status: string | null;
  identifier_screen_report: string | null;
  identifier_screen_ack_at: string | null;
  identifier_screen_ack_by: number | null;
  github_repo: string | null;
  attestation: string | null;
}

const ROW_SQL = `SELECT pr.id, pr.dataset_id, pr.status, pr.identifier_screen_status,
                        pr.identifier_screen_report, pr.identifier_screen_ack_at,
                        pr.identifier_screen_ack_by, d.github_repo, d.attestation
                   FROM publication_requests pr
                   LEFT JOIN datasets d ON d.dataset_id = pr.dataset_id`;

type Body =
  | { apply: false; dataset_ids: string[] }
  | { apply: false; all_requested: true; after: string | null; limit: number }
  | { apply: true; expect: Expected[] };

const HEAD_RE = /^[0-9a-f]{40}$/;

function parseBody(raw: unknown): Body | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "a JSON object";
  const b = raw as Record<string, unknown>;
  const allowed = new Set(["apply", "dataset_ids", "all_requested", "after", "limit", "expect"]);
  for (const k of Object.keys(b)) if (!allowed.has(k)) return `no field named ${k}`;
  if (b.apply !== undefined && typeof b.apply !== "boolean") return "apply as a boolean";
  if (b.apply === true) {
    if (b.dataset_ids !== undefined || b.all_requested !== undefined) {
      return "an apply that names its requests in expect only";
    }
    if (!Array.isArray(b.expect) || b.expect.length === 0 || b.expect.length > ACK_BATCH_MAX) {
      return `expect, 1 to ${ACK_BATCH_MAX} entries the dry run reported eligible`;
    }
    const expect: Expected[] = [];
    for (const e of b.expect) {
      const x = e as Record<string, unknown>;
      if (
        typeof x?.dataset_id !== "string" ||
        !PUBLICATION_DATASET_ID_RE.test(x.dataset_id) ||
        !Number.isSafeInteger(x.request_id) ||
        typeof x.screen_state !== "string" ||
        typeof x.screen_head !== "string" ||
        !HEAD_RE.test(x.screen_head)
      ) {
        return "expect entries of dataset_id, request_id, screen_state and screen_head";
      }
      expect.push({
        dataset_id: x.dataset_id,
        request_id: x.request_id as number,
        screen_state: x.screen_state,
        screen_head: x.screen_head,
      });
    }
    return { apply: true, expect };
  }
  if (b.expect !== undefined) return "expect only with apply: true";
  if (b.all_requested === true) {
    if (b.dataset_ids !== undefined) return "dataset_ids or all_requested, not both";
    if (
      b.after !== undefined &&
      (typeof b.after !== "string" || !PUBLICATION_DATASET_ID_RE.test(b.after))
    ) {
      return "after as a dataset id";
    }
    const limit = b.limit ?? ACK_BATCH_MAX;
    if (
      !Number.isSafeInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > ACK_BATCH_MAX
    ) {
      return `limit from 1 to ${ACK_BATCH_MAX}`;
    }
    return {
      apply: false,
      all_requested: true,
      after: (b.after as string | undefined) ?? null,
      limit: limit as number,
    };
  }
  if (b.all_requested !== undefined) return "all_requested as true";
  if (b.after !== undefined || b.limit !== undefined)
    return "after and limit only with all_requested";
  if (
    !Array.isArray(b.dataset_ids) ||
    b.dataset_ids.length === 0 ||
    b.dataset_ids.length > ACK_BATCH_MAX ||
    !b.dataset_ids.every((d) => typeof d === "string" && PUBLICATION_DATASET_ID_RE.test(d))
  ) {
    return `dataset_ids, 1 to ${ACK_BATCH_MAX} dataset ids, or all_requested: true`;
  }
  return { apply: false, dataset_ids: [...new Set(b.dataset_ids as string[])] };
}

/** The outcome of reading one request, before anything is recorded. */
type Evaluation =
  | { ok: false; result: AckResult }
  | { ok: true; result: AckResult; reason: string; lineage: LineageResult; report: ScreenReport };

function baseResult(row: AckRow): AckResult {
  const report = readStoredReport(row.identifier_screen_report);
  return {
    dataset_id: row.dataset_id,
    request_id: row.id,
    outcome: "eligible",
    screen_state: readStoredState(row.identifier_screen_status),
    screen_head: report?.head ?? null,
  };
}

/**
 * Every blob path of the screened commit, from one recursive tree listing (GitHub resolves a commit
 * sha to its tree). Null when the call fails or the listing is truncated: a partial list cannot say
 * a file is absent. The repository is addressed by the dataset id, as the screen addresses it.
 */
async function readTreePaths(
  datasetId: string,
  head: string,
  token: string,
): Promise<string[] | null> {
  try {
    const res = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${datasetId}/git/trees/${head}?recursive=1`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "NEMAR-API",
        },
      },
    );
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const body = await res.json<{
      tree?: Array<{ path?: unknown; type?: unknown }>;
      truncated?: unknown;
    }>();
    if (body.truncated !== false || !Array.isArray(body.tree)) return null;
    return body.tree.flatMap((e) =>
      e.type === "blob" && typeof e.path === "string" ? [e.path] : [],
    );
  } catch (err) {
    console.error(`[acknowledge-batch] tree read failed for ${datasetId}:`, err);
    return null;
  }
}

/** The whole rule, for one request: the database facts, then the head, then the lineage. */
async function evaluate(
  env: Bindings,
  row: AckRow,
  exclusions: D2Exclusions,
  token: string,
): Promise<Evaluation> {
  const result = baseResult(row);
  const no = (reason: NotEligibleReason): Evaluation => ({
    ok: false,
    result: notEligible(result, reason),
  });
  const report = readStoredReport(row.identifier_screen_report);
  const screen = screenEligibility({
    datasetId: row.dataset_id,
    exempt: isScreenExempt(row.dataset_id),
    requestStatus: row.status,
    acknowledged: row.identifier_screen_ack_at !== null,
    screenState: readStoredState(row.identifier_screen_status),
    report,
    exclusions,
  });
  if (!screen.eligible) return no(screen.reason);
  const head = await verifyScreenHead(env, row.dataset_id, row, token);
  if (!head.ok) return no(head.refusal.gate === "stale" ? "screen_stale" : "head_unverified");
  if (!report?.head) return no("no_screen");
  const tree = treeEligibility(await readTreePaths(row.dataset_id, report.head, token));
  if (!tree.eligible) return no(tree.reason);
  const repo = row.github_repo ? extractRepoName(row.github_repo) : null;
  if (!repo) return no("lineage_unreadable");
  const read = await readDatasetLineage(env, {
    datasetId: row.dataset_id,
    repo,
    attestation: row.attestation,
    ref: report.head,
  });
  if (!read.ok) return no("lineage_unreadable");
  result.lineage_outcome = read.result.outcome;
  const lineage = lineageEligibility(read.result);
  if (!lineage.eligible) return no(lineage.reason);
  result.source = {
    id: lineage.source.id,
    license: lineage.source.license,
    resolver: lineage.source.resolver,
  };
  const reason = reasonEligibility(buildAckReason(report, lineage.source, lineage.others));
  if (!reason.eligible) return no(reason.reason);
  result.reason = reason.reason;
  return { ok: true, result, reason: reason.reason, lineage: read.result, report };
}

function notEligible(r: AckResult, reason: NotEligibleReason): AckResult {
  return { ...r, outcome: `not_eligible:${reason}` };
}

/** A refusal body: the closed word and the copy table's statement (and a detail, when given). */
function refusal(entry: UpstreamAckMessage, detail?: string) {
  const copy = UPSTREAM_ACK_COPY[entry];
  return {
    error: entry.slice("error:".length),
    message: detail ? `${copy.statement} ${detail}` : copy.statement,
    remedy: copy.remedy,
    docs: copy.anchor,
  };
}

/** The class of an error, never its message: messages can carry values. */
function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** `baseResult`, which cannot throw: a report that does not read is shown as no state. */
function baseResultSafe(row: AckRow): AckResult {
  try {
    return baseResult(row);
  } catch {
    return {
      dataset_id: row.dataset_id,
      request_id: row.id,
      outcome: "eligible",
      screen_state: null,
      screen_head: null,
    };
  }
}

/** Run `fn` over `items`, `CONCURRENCY` at a time, keeping order. */
async function mapLimited<T, R>(items: T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

export function registerUpstreamAckRoutes(admin: AdminRouter): void {
  admin.post("/publish/acknowledge-batch", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = null;
    }
    const body = parseBody(raw);
    if (typeof body === "string") {
      return c.json(refusal("error:invalid_body", `The body must give ${body}.`), 400);
    }

    let exclusions: D2Exclusions;
    try {
      exclusions = exclusionsOf(UPSTREAM_ACK_EXCLUSIONS);
    } catch (err) {
      console.error(`[acknowledge-batch] the exclusions do not check: ${errorClass(err)}`);
      return c.json(refusal("error:exclusions_unreadable"), 500);
    }

    let token: string;
    try {
      token = await getDatasetsToken(c.env);
    } catch (err) {
      console.error(`[acknowledge-batch] no GitHub credential: ${errorClass(err)}`);
      return c.json(refusal("error:github_unavailable"), 502);
    }

    const db = c.env.DB;
    const policy = `${UPSTREAM_ACK_DOCS_URL}#${UPSTREAM_ACK_ANCHOR}`;

    if (!body.apply) {
      let rows: AckRow[];
      let missing: string[] = [];
      let next: string | null = null;
      if ("dataset_ids" in body) {
        const placeholders = body.dataset_ids.map(() => "?").join(", ");
        // The newest request of each dataset: an older one is history, never acknowledged.
        const all = (
          await db
            .prepare(
              `${ROW_SQL} WHERE pr.dataset_id IN (${placeholders})
                 AND pr.id = (SELECT MAX(id) FROM publication_requests p2 WHERE p2.dataset_id = pr.dataset_id)`,
            )
            .bind(...body.dataset_ids)
            .all<AckRow>()
        ).results;
        const byId = new Map(all.map((r) => [r.dataset_id, r]));
        rows = body.dataset_ids.flatMap((d) => byId.get(d) ?? []);
        missing = body.dataset_ids.filter((d) => !byId.has(d));
      } else {
        rows = (
          await db
            .prepare(
              `${ROW_SQL} WHERE pr.status = 'requested' AND pr.dataset_id > ?
                ORDER BY pr.dataset_id, pr.id LIMIT ?`,
            )
            .bind(body.after ?? "", body.limit + 1)
            .all<AckRow>()
        ).results;
        if (rows.length > body.limit) {
          rows = rows.slice(0, body.limit);
          next = rows[rows.length - 1].dataset_id;
        }
      }
      const evaluated = await mapLimited(rows, async (r): Promise<AckResult> => {
        try {
          return (await evaluate(c.env, r, exclusions, token)).result;
        } catch (err) {
          console.error(`[acknowledge-batch] ${r.dataset_id}: evaluation threw ${errorClass(err)}`);
          return notEligible(baseResultSafe(r), "evaluation_failed");
        }
      });
      const results: AckResult[] = [
        ...evaluated,
        ...missing.map(
          (d): AckResult => ({
            dataset_id: d,
            request_id: null,
            outcome: "not_eligible:no_request",
            screen_state: null,
            screen_head: null,
          }),
        ),
      ];
      return c.json({ apply: false, policy, results, next });
    }

    const admin = c.get("user");
    const results = await mapLimited(body.expect, async (e): Promise<AckResult> => {
      const moved: AckResult = {
        dataset_id: e.dataset_id,
        request_id: e.request_id,
        outcome: "state_moved",
        screen_state: e.screen_state,
        screen_head: e.screen_head,
      };
      let row: AckRow | null;
      let ev: Evaluation;
      let details: Record<string, unknown>;
      try {
        row = await db.prepare(`${ROW_SQL} WHERE pr.id = ?`).bind(e.request_id).first<AckRow>();
        if (!row || row.dataset_id !== e.dataset_id) return moved;
        const shown = baseResult(row);
        if (
          row.status !== "requested" ||
          row.identifier_screen_ack_at !== null ||
          shown.screen_state !== e.screen_state ||
          shown.screen_head !== e.screen_head
        ) {
          return { ...moved, screen_state: shown.screen_state, screen_head: shown.screen_head };
        }
        ev = await evaluate(c.env, row, exclusions, token);
        if (!ev.ok) return ev.result;
        details = { via: "acknowledge-batch", policy, lineage: ev.lineage };
        // The audit row keeps the whole lineage or nothing is recorded: a details payload over the
        // audit bound would be stored truncated, without it.
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            ...details,
            request_id: row.id,
            screen_state: row.identifier_screen_status,
            reason: ev.reason,
          }),
        ).byteLength;
        if (bytes > AUDIT_DETAILS_MAX_BYTES) return notEligible(ev.result, "evaluation_failed");
      } catch (err) {
        console.error(`[acknowledge-batch] ${e.dataset_id}: evaluation threw ${errorClass(err)}`);
        return { ...moved, outcome: "not_eligible:evaluation_failed" };
      }
      try {
        const recorded = await recordScreenAcknowledgment(db, {
          requestId: row.id,
          datasetId: row.dataset_id,
          adminUserId: admin.id,
          reason: ev.reason,
          state: row.identifier_screen_status as string,
          shown: { report: row.identifier_screen_report as string },
          details,
        });
        if (!recorded) return { ...ev.result, outcome: "state_moved" };
        return { ...ev.result, outcome: "acknowledged" };
      } catch (err) {
        console.error(`[acknowledge-batch] ${e.dataset_id}: record threw ${errorClass(err)}`);
        return { ...ev.result, outcome: "not_recorded:write_failed" };
      }
    });
    return c.json({ apply: true, policy, results, next: null });
  });
}
