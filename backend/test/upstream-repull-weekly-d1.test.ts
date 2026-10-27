/**
 * The weekly report's re-pull statements on Miniflare's D1 (epic #1046 phase 7, #1913; ADR 0111,
 * the Phase 7h slice), the D1 implementation `wrangler d1 --local` runs, rather than bun:sqlite.
 *
 * bun:sqlite is more lenient than D1 in places this week's reads use: numbered parameters beside a
 * `batch`, a correlated subquery inside the derived table the merges are summed over, and
 * `json_extract` read as an integer. The suite that proves the report (`import-weekly-repull-
 * section.test.ts`) runs on bun:sqlite with the audit rows the production writers leave; this one
 * runs the same statements, the real `gatherRepullWeek`, on D1 over rows of the same shapes, so a
 * statement D1 refuses, or answers differently, fails here. In-process only: no `wrangler dev` and
 * no server of the Worker's own.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import type { DispatchStatus } from "../../shared/repull-state";
import { SYSTEM_USER_ID } from "../src/lib/constants";
import { gatherRepullFacts, gatherRepullWeek } from "../src/services/upstream-repull-weekly";
import type { Bindings } from "../src/types/bindings";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";
import { DISPATCH_INSERT_SQL, type Row, SHA, dispatchBinds, rowAt } from "./helpers/repull-rows";

let mf: Miniflare;
let d1: D1Database;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB"],
  });
  d1 = await mf.getD1Database("DB");
  await applyMigrations(d1, migrationFiles());
  // D1 enforces foreign keys, so the administrator whose audit rows these are exists.
  await d1
    .prepare(
      `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
       VALUES (7, 'weeklyadmin', 'weeklyadmin@example.org', 'x', 'approved', 'admin', 1)`,
    )
    .run();
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
}, 30_000);

async function insert(table: string, row: Row): Promise<number> {
  const cols = Object.keys(row);
  const r = await d1
    .prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
  return Number(r.meta.last_row_id);
}

const NOW = new Date("2026-10-26T03:00:00Z");
const DAY = 86_400_000;
const at = (ms: number) =>
  new Date(NOW.getTime() + ms).toISOString().slice(0, 19).replace("T", " ");

async function dispatch(o: {
  dataset: string;
  status: DispatchStatus;
  code?: string;
  kind?: "open" | "finish";
  when: string;
}): Promise<void> {
  await d1
    .prepare(DISPATCH_INSERT_SQL)
    .bind(
      ...dispatchBinds({
        dataset: o.dataset,
        status: o.status,
        code: o.code,
        kind: o.kind,
        at: o.when,
      }),
    )
    .run();
}

async function audit(
  id: number,
  userId: number | null,
  from: string,
  to: string,
  when: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await insert("audit_log", {
    user_id: userId,
    action: "repull_transition",
    resource_type: "upstream_repull",
    resource_id: String(id),
    details: JSON.stringify({ dataset_id: "on000001", from, to, fields: [], ...extra }),
    timestamp: when,
  });
}

describe("the week's statements on D1", () => {
  test("dispatches, holds, claims, merges and failed re-pulls are counted as bun:sqlite counts them", async () => {
    // Dispatches: two refused for one word, one live, one unreported, one at the window's end.
    await dispatch({ dataset: "on090001", status: "refused", code: "gitlink", when: at(-DAY) });
    await dispatch({ dataset: "on090002", status: "refused", code: "gitlink", when: at(-2 * DAY) });
    await dispatch({ dataset: "on090003", status: "started", when: at(-3 * DAY) });
    await dispatch({ dataset: "on090004", status: "unreported", when: at(-4 * DAY) });
    await dispatch({ dataset: "on090005", status: "refused", code: "gitlink", when: at(0) });

    // Open automatic re-pulls, one held, and an administrator's that is not counted.
    await insert(
      "upstream_repulls",
      rowAt("pr_open", {
        dataset_id: "on090001",
        origin: "automatic",
        hold_reason: "screen-acknowledge",
        hold_since: at(-DAY),
      }),
    );
    await insert(
      "upstream_repulls",
      rowAt("pr_open", { dataset_id: "on090002", origin: "automatic" }),
    );
    await insert("upstream_repulls", rowAt("pr_open", { dataset_id: "on090003" }));

    // A claim held for two hours, a failed re-pull in the window, one outside it.
    await insert(
      "upstream_repulls",
      rowAt("gates_clear", {
        dataset_id: "on090004",
        origin: "automatic",
        merge_claimed_at: at(-2 * 3_600_000),
        merge_claim_sha: SHA,
      }),
    );
    await insert(
      "upstream_repulls",
      rowAt("failed", { dataset_id: "on090005", terminal_at: at(-DAY) }),
    );
    await insert(
      "upstream_repulls",
      rowAt("failed", { dataset_id: "on090006", to_tag: "1.0.2", terminal_at: at(-9 * DAY) }),
    );

    // Merges: the Worker's claim then its merge, an administrator's, and one with no claim.
    await audit(11, SYSTEM_USER_ID, "gates_clear", "gates_clear", at(-2 * DAY));
    await audit(11, SYSTEM_USER_ID, "gates_clear", "merged", at(-2 * DAY + 60_000), {
      merged_outside_tool: false,
    });
    // The release step's error on a merged record is an edge from merged to itself: not a merge.
    await audit(11, 7, "merged", "merged", at(-2 * DAY + 120_000));
    await audit(12, 7, "gates_clear", "gates_clear", at(-DAY));
    await audit(12, 7, "gates_clear", "merged", at(-DAY + 60_000), { merged_outside_tool: false });
    await audit(13, 7, "patch_gates_clear", "patch_gates_clear", at(-DAY));
    await audit(13, 7, "patch_gates_clear", "patch_merged", at(-DAY + 60_000), {
      merged_outside_tool: false,
    });
    await audit(13, 7, "patch_merged", "patch_merged", at(-DAY + 120_000));
    await audit(14, 7, "pr_open", "merged", at(-DAY), { merged_outside_tool: true });
    await audit(15, 7, "gates_clear", "merged", at(-DAY), { merged_outside_tool: false });
    // A merge before the window is an earlier week's.
    await audit(16, 7, "pr_open", "merged", at(-10 * DAY), { merged_outside_tool: true });
    // N.0.0 on an administrator's claim, and N.0.1 merged with its own claim edge lost: the second
    // is unattributed, and is not the administrator's claim on the other pull request.
    await audit(17, 7, "gates_clear", "gates_clear", at(-3 * DAY));
    await audit(17, 7, "gates_clear", "merged", at(-3 * DAY + 60_000), {
      merged_outside_tool: false,
    });
    await audit(17, 7, "patch_gates_clear", "patch_merged", at(-DAY), {
      merged_outside_tool: false,
    });

    const week = await gatherRepullWeek(
      { DB: d1 },
      { from: new Date(NOW.getTime() - 7 * DAY), to: NOW },
    );
    expect(week.dispatches.sent).toBe(4);
    expect(week.dispatches.by_status).toMatchObject({
      refused: 2,
      started: 1,
      unreported: 1,
      dispatch_failed: 0,
    });
    expect(week.dispatches.by_word.refused).toEqual({ gitlink: 2 });
    expect(week.open_automatic).toEqual({
      total: 3,
      held: 1,
      holds: { "screen-acknowledge": 1 },
    });
    expect(week.held_claims).toBe(1);
    expect(week.ended_failed).toBe(1);
    expect(week.merged).toEqual({ worker: 1, administrator: 3, outside_tool: 1, unattributed: 2 });
  });

  test("the whole facts, switches and scheduler included, are read on D1", async () => {
    await d1
      .prepare("UPDATE upstream_repull_scheduler SET last_tick_at = ?, last_outcome = 'ran'")
      .bind(at(-3_600_000))
      .run();
    const facts = await gatherRepullFacts(
      {
        DB: d1,
        ENVIRONMENT: "production",
        AUTO_REPULL_ENABLED: "1",
      } as unknown as Bindings,
      { from: new Date(NOW.getTime() - 7 * DAY), to: NOW },
    );
    expect(facts.switches.auto_repull_enabled).toBe(true);
    expect(facts.scheduler).toEqual({
      last_tick_at: at(-3_600_000),
      last_outcome: "ran",
      last_advance_at: null,
    });
    // Unreported and a held claim are reasons; the scheduler ran an hour ago, so it is not one.
    expect(facts.attention).toEqual([
      "1 re-pull dispatch(es) were not reported by their run in time",
      "1 re-pull merge claim(s) have been held for over 1 hour",
      "1 re-pull(s) ended failed",
    ]);
  });
});
