/**
 * The administrator's reads of the automatic re-pull on Miniflare's D1 (epic #1046 phase 7,
 * #1913; ADR 0111, the Phase 7h slice): the dispatch list and the scheduler's row, the D1
 * implementation `wrangler d1 --local` runs, rather than bun:sqlite.
 *
 * The list's statement binds its four parameters by number, each beside `IS NULL OR`, and names
 * its columns. `upstream-repull-dispatches-route.test.ts` proves its behavior on bun:sqlite through
 * the real route; this runs the same service on D1 over the same shapes of row, so a statement D1
 * refuses, or answers differently, fails here. In-process only: no `wrangler dev` and no server of
 * the Worker's own.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { listDispatches } from "../src/services/upstream-repull-dispatch";
import { readSchedulerRow } from "../src/services/upstream-repull-scheduler";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";

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
});

afterAll(async () => {
  await mf?.dispose();
});

async function dispatch(o: { dataset: string; status: string; code?: string }): Promise<number> {
  const live = o.status === "dispatched" || o.status === "started";
  const reported = !["dispatched", "dispatch_failed", "unreported"].includes(o.status);
  const r = await d1
    .prepare(
      `INSERT INTO upstream_repull_dispatches
         (kind, dataset_id, upstream_ds, from_tag, to_tag, repull_id, nonce, status, code,
          dispatched_at, reported_at)
       VALUES ('open', ?, ?, '1.0.0', '1.0.1', ?, ?, ?, ?, '2026-10-20 03:00:00', ?)`,
    )
    .bind(
      o.dataset,
      `ds${o.dataset.slice(2)}`,
      o.status === "opened" ? 1 : null,
      live ? `${"n".repeat(31)}${o.dataset.slice(-1)}` : null,
      o.status,
      o.code ?? null,
      reported ? "2026-10-20 03:00:00" : null,
    )
    .run();
  return Number(r.meta.last_row_id);
}

describe("the dispatch list on D1", () => {
  test("pages by cursor, filters by dataset and state, and never selects the nonce", async () => {
    const ids = [
      await dispatch({ dataset: "on090001", status: "refused", code: "gitlink" }),
      await dispatch({ dataset: "on090002", status: "unreported" }),
      await dispatch({ dataset: "on090003", status: "dispatched" }),
      await dispatch({ dataset: "on090001", status: "opened" }),
      await dispatch({ dataset: "on090004", status: "unreported" }),
    ];
    const newest = [...ids].reverse();

    const page1 = await listDispatches(d1, { limit: 2 });
    expect(page1.map((d) => d.id)).toEqual(newest.slice(0, 2));
    const page2 = await listDispatches(d1, { limit: 2, after: page1.at(-1)?.id as number });
    expect(page2.map((d) => d.id)).toEqual(newest.slice(2, 4));
    const page3 = await listDispatches(d1, { limit: 2, after: page2.at(-1)?.id as number });
    expect(page3.map((d) => d.id)).toEqual(newest.slice(4));

    expect((await listDispatches(d1, { status: "unreported" })).map((d) => d.id)).toEqual([
      ids[4],
      ids[1],
    ]);
    expect((await listDispatches(d1, { dataset: "on090001" })).map((d) => d.id)).toEqual([
      ids[3],
      ids[0],
    ]);
    expect(
      (await listDispatches(d1, { dataset: "on090001", status: "opened" })).map((d) => d.id),
    ).toEqual([ids[3]]);

    // The live dispatch is among them, and its nonce is in none of them.
    for (const d of await listDispatches(d1, { limit: 50 })) {
      expect(Object.keys(d).sort()).toEqual([
        "code",
        "dataset_id",
        "dispatched_at",
        "from_tag",
        "id",
        "kind",
        "reported_at",
        "repull_id",
        "status",
        "to_tag",
        "upstream_ds",
        "workflow_run_url",
      ]);
    }
  });
});

describe("the scheduler's row on D1", () => {
  test("is read as its three stamps, its cursor stays in the database, and an absent row is null", async () => {
    await d1
      .prepare(
        `UPDATE upstream_repull_scheduler
            SET scan_after = 'on098765', last_tick_at = '2026-10-26 03:00:01',
                last_outcome = 'ran', last_advance_at = '2026-10-26 12:30:02'`,
      )
      .run();
    expect(await readSchedulerRow(d1)).toEqual({
      last_tick_at: "2026-10-26 03:00:01",
      last_outcome: "ran",
      last_advance_at: "2026-10-26 12:30:02",
    });
    await d1.prepare("DELETE FROM upstream_repull_scheduler").run();
    expect(await readSchedulerRow(d1)).toBeNull();
  });
});
