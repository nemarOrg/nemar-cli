/**
 * The automatic re-pull scheduler's statements on Miniflare's D1 (epic #1046 phase 7, #1913; ADR
 * 0111), the D1 implementation `wrangler d1 --local` runs, rather than bun:sqlite.
 *
 * bun:sqlite is more lenient than D1 in places that matter here: numbered parameters (`?1`, `?2`)
 * beside the create's own rule nested as a subquery, a COALESCE over a bound NULL in the stamp, and
 * the staleness report's page joins. So the blockers, the proof and the holds' audit rows are run
 * on D1 for each fact, and one whole tick (with gate G4's two re-pulls recorded) is run on D1
 * against the same loopback stand-ins the SQLite suite uses (OpenNeuro in its synthetic mode, its
 * GitHub mirror, and GitHub's dispatch endpoint). In-process only: no `wrangler dev` and no server
 * of the Worker's own.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Miniflare } from "miniflare";
import {
  CANDIDATE_BLOCKERS_SQL,
  CANDIDATE_HELD_AUDIT_SQL,
  CANDIDATE_HELD_COUNT_SQL,
  MANUAL_RUN_PROOF_SQL,
  PROBES_HELD_AUDIT_SQL,
  PROBES_HELD_COUNT_SQL,
  REPULL_G4_DATASETS,
  SCHEDULER_STAMP_SQL,
  runRepullSchedulerCron,
} from "../src/services/upstream-repull-scheduler";
import type { Bindings } from "../src/types/bindings";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";
import { startOpenNeuroStandin } from "./helpers/openneuro-standin";
import { startRawHost } from "./helpers/raw-mirror-standin";
import { type Row, SHA, rowAt } from "./helpers/repull-rows";

let mf: Miniflare;
let d1: D1Database;
let openneuro: ReturnType<typeof startOpenNeuroStandin>;
let raw: ReturnType<typeof startRawHost>;
let github: Server;
const sent: Array<Record<string, string>> = [];
let previousBase: string | undefined;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB"],
  });
  d1 = await mf.getD1Database("DB");
  await applyMigrations(d1, migrationFiles());
  openneuro = startOpenNeuroStandin();
  openneuro.synthetic(true);
  raw = startRawHost();
  github = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { client_payload: Record<string, string> };
      sent.push(body.client_payload);
      return new Response(null, { status: 204 });
    },
  });
  const g = globalThis as { NEMAR_GITHUB_API_URL?: string };
  previousBase = g.NEMAR_GITHUB_API_URL;
  g.NEMAR_GITHUB_API_URL = `http://127.0.0.1:${github.port}`;
});

afterAll(async () => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = previousBase;
  openneuro?.stop();
  raw?.stop();
  github?.stop(true);
  await mf?.dispose();
});

async function insert(table: string, row: Row): Promise<void> {
  const cols = Object.keys(row);
  await d1
    .prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...cols.map((c) => row[c]))
    .run();
}

async function reset(): Promise<void> {
  for (const t of [
    "upstream_repull_dispatches",
    "upstream_repulls",
    "dataset_versions",
    "datasets",
    "audit_log",
  ]) {
    await d1.prepare(`DELETE FROM ${t}`).run();
  }
  await d1
    .prepare(
      "UPDATE upstream_repull_scheduler SET scan_after = '', last_tick_at = NULL, last_outcome = NULL",
    )
    .run();
  openneuro.reset();
  openneuro.synthetic(true);
  raw.reset();
  sent.length = 0;
}

/** A managed mirror whose 1.0.0 records 0.9.0, so upstream's synthetic 1.0.0 is newer. */
async function mirror(id: string, owner: number): Promise<void> {
  await insert("datasets", {
    dataset_id: id,
    name: id,
    owner_user_id: owner,
    github_repo: `nemarDatasets/${id}`,
    visibility: "public",
    source: "openneuro",
    source_id: `ds${id.slice(2)}`,
  });
  await insert("dataset_versions", {
    dataset_id: id,
    version: "1.0.0",
    doi: `10.82901/${id}.v1.0.0`,
    source_version: "0.9.0",
    source_version_basis: "doi",
  });
  raw.serve(`ds${id.slice(2)}`, "1.0.0");
}

async function owner(): Promise<number> {
  const existing = await d1
    .prepare("SELECT id FROM users WHERE username = 'scheddone'")
    .first<{ id: number }>();
  if (existing) return existing.id;
  await d1
    .prepare(
      "INSERT INTO users (username, email, password_hash, status, role, email_verified) VALUES ('scheddone', 'scheddone@example.org', 'x', 'approved', 'admin', 1)",
    )
    .run();
  return (
    (await d1.prepare("SELECT id FROM users WHERE username = 'scheddone'").first<{ id: number }>())
      ?.id ?? 0
  );
}

/** Gate G4: both re-pulls the design record names, run by an administrator to `complete`. */
async function g4Done(): Promise<void> {
  for (const id of REPULL_G4_DATASETS) {
    await insert(
      "upstream_repulls",
      rowAt("complete", {
        dataset_id: id,
        upstream_ds: `ds${id.slice(2)}`,
        origin: "administrator",
      }),
    );
  }
}

describe("the scheduler's statements on D1", () => {
  test("the blockers, with the create's unreconciled rule nested at ?1, and the proof", async () => {
    await reset();
    const uid = await owner();
    await mirror("on099901", uid);
    const read = () =>
      d1.prepare(CANDIDATE_BLOCKERS_SQL).bind("on099901", "1.0.0").first<Record<string, unknown>>();
    expect(await read()).toEqual({
      anonymous: 0,
      unreconciled: 0,
      open_rows: 0,
      live: 0,
      final_refusals: 0,
      unreported_last: 0,
      recent_rows: 0,
      recent_dispatches: 0,
    });
    await insert(
      "upstream_repulls",
      rowAt("failed", {
        dataset_id: "on099901",
        upstream_ds: "ds099901",
        from_tag: "0.9.0",
        to_tag: "1.0.0",
        merge_claimed_at: "2026-01-01 00:00:00",
        merge_claim_sha: SHA,
        created_at: "2026-01-01 00:00:00",
      }),
    );
    await insert("upstream_repull_dispatches", {
      kind: "open",
      dataset_id: "on099901",
      upstream_ds: "ds099901",
      from_tag: "0.9.0",
      to_tag: "1.0.0",
      status: "refused",
      code: "gitlink",
      reported_at: "2026-01-01 00:00:00",
    });
    expect(await read()).toMatchObject({
      unreconciled: 1,
      final_refusals: 1,
      recent_dispatches: 1,
    });
    expect(
      await d1.prepare(CANDIDATE_BLOCKERS_SQL).bind("on099999", "1.0.0").first(),
    ).toMatchObject({
      anonymous: null,
      unreconciled: 0,
    });

    // Gate G4's proof: any other mirror's manual run does not count, and the two named ones do.
    expect(await d1.prepare(MANUAL_RUN_PROOF_SQL).first()).toEqual({ n: 0 });
    await insert(
      "upstream_repulls",
      rowAt("complete", {
        dataset_id: "on099800",
        upstream_ds: "ds099800",
        origin: "administrator",
      }),
    );
    expect(await d1.prepare(MANUAL_RUN_PROOF_SQL).first()).toEqual({ n: 0 });
    await g4Done();
    expect(await d1.prepare(MANUAL_RUN_PROOF_SQL).first()).toEqual({ n: 2 });

    // The holds are counted from the audit rows they write, by dataset and by cursor.
    await d1.prepare(CANDIDATE_HELD_AUDIT_SQL).bind("on099901", "Error", 1).run();
    await d1.prepare(PROBES_HELD_AUDIT_SQL).bind("", 4, 1).run();
    expect(await d1.prepare(CANDIDATE_HELD_COUNT_SQL).bind("on099901").first()).toEqual({ n: 1 });
    expect(await d1.prepare(CANDIDATE_HELD_COUNT_SQL).bind("on099902").first()).toEqual({ n: 0 });
    expect(await d1.prepare(PROBES_HELD_COUNT_SQL).bind("").first()).toEqual({ n: 1 });
    // A hold is counted at its own cursor only.
    expect(await d1.prepare(PROBES_HELD_COUNT_SQL).bind("on099900").first()).toEqual({ n: 0 });

    // The stamp keeps the cursor for a NULL and takes a new one otherwise.
    await d1.prepare(SCHEDULER_STAMP_SQL).bind("on099901", "ran").run();
    await d1.prepare(SCHEDULER_STAMP_SQL).bind(null, "switch-off").run();
    expect(
      await d1.prepare("SELECT scan_after, last_outcome FROM upstream_repull_scheduler").first(),
    ).toEqual({ scan_after: "on099901", last_outcome: "switch-off" });
  });

  test("one whole tick on D1 dispatches the two lowest eligible mirrors and stamps the row", async () => {
    await reset();
    const uid = await owner();
    for (const id of ["on099901", "on099902", "on099903"]) await mirror(id, uid);
    await d1.prepare("UPDATE datasets SET anonymous = 1 WHERE dataset_id = 'on099902'").run();
    await g4Done();
    const env = {
      DB: d1,
      ENVIRONMENT: "production",
      AUTO_REPULL_ENABLED: "1",
      PRESCREEN_CALLBACK_SECRET: "scheduler-d1-secret",
      GITHUB_ADMIN_PAT: "scheduler-d1-pat",
      GITHUB_RAW_BASE: raw.base,
      OPENNEURO_GRAPHQL_URL: openneuro.url,
    } as unknown as Bindings;
    const r = await runRepullSchedulerCron(env, { cliVersion: "1.2.3" });
    expect(r).toMatchObject({ outcome: "ran", dispatched: 2, skipped: { anonymous: 1 } });
    expect(sent.map((p) => p.dataset_id)).toEqual(["on099901", "on099903"]);
    const rows = (
      await d1
        .prepare("SELECT dataset_id, status FROM upstream_repull_dispatches ORDER BY id")
        .all()
    ).results;
    expect(rows).toEqual([
      { dataset_id: "on099901", status: "dispatched" },
      { dataset_id: "on099903", status: "dispatched" },
    ]);
    expect(
      await d1.prepare("SELECT scan_after, last_outcome FROM upstream_repull_scheduler").first(),
    ).toEqual({ scan_after: "on099903", last_outcome: "ran" });
  });
});
