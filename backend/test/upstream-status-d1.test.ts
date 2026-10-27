/**
 * The upstream status report's SQL on Miniflare D1, the implementation `wrangler --local` runs
 * (epic #1046 phase 4a, #1910).
 *
 * Every other test of the report runs on bun:sqlite, which is more lenient than D1 (a GLOB
 * pattern length limit, the bound-parameter cap, `COUNT(CASE ...)`). The statements run here
 * are the real ones through the real service, with only the database swapped. OpenNeuro is the
 * recorded-response stand-in; nothing leaves the machine.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { PUBLIC_DATASET_VERSIONS_SQL } from "../src/services/data-router";
import { runUpstreamFleetSummary, runUpstreamStatusPage } from "../src/services/upstream-status";
import type { Bindings } from "../src/types/bindings";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";
import { startOpenNeuroStandin } from "./helpers/openneuro-standin";

let mf: Miniflare;
let d1: D1Database;
let openneuro: ReturnType<typeof startOpenNeuroStandin>;

beforeAll(async () => {
  openneuro = startOpenNeuroStandin();
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB"],
  });
  d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(d1, migrationFiles());
  await d1
    .prepare(
      `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
       VALUES (1, 'd1owner', 'd1owner@example.org', 'x', 'approved', 'member', 1)`,
    )
    .run();
  const dataset = (id: string, source: string, owner: number, withdrawn: string | null) =>
    d1
      .prepare(
        `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, source, source_id, withdrawn_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, id, owner, `nemarDatasets/${id}`, source, `ds${id.slice(2)}`, withdrawn)
      .run();
  await dataset("on002893", "openneuro", 1, null);
  await dataset("on000002", "openneuro", 1, null);
  await dataset("on000003", "openneuro", 1, null);
  await dataset("on000004", "openneuro", 1, "2026-01-01 00:00:00");
  await dataset("on000005", "openneuro", -1, null);
  await dataset("nm000200", "nemar.org", 1, null);
  await d1
    .prepare(
      `INSERT INTO dataset_versions (dataset_id, version, doi, source_version, source_version_basis)
       VALUES ('on002893', '1.0.0', '10.82901/x', '2.0.0', 'doi'),
              ('on000002', '1.0.0', '10.82901/y', NULL, NULL)`,
    )
    .run();
  await d1
    .prepare(
      `INSERT INTO import_jobs (dataset_id, source, source_id, status) VALUES ('on000003', 'openneuro', 'ds000003', 'copying')`,
    )
    .run();
}, 60_000);

afterAll(async () => {
  await mf.dispose();
  openneuro.stop();
}, 30_000);

const env = () =>
  ({ DB: d1, ENVIRONMENT: "test", OPENNEURO_GRAPHQL_URL: openneuro.url }) as Bindings;

describe("upstream status on Miniflare D1", () => {
  test("the page, the keyset, the remaining count and the totals all run", async () => {
    const page = await runUpstreamStatusPage(env(), { limit: 2 });
    expect(page.rows.map((r) => [r.dataset_id, r.state])).toEqual([
      ["on000002", "not_examined"],
      ["on000003", "in_progress"],
    ]);
    expect(page.next_cursor).toBe("on000003");
    expect(page.remaining).toBe(1);
    expect(page.population_total).toBe(3);
    expect(page.withdrawn).toBe(1);
    expect(page.excluded_unmanaged).toBe(1);

    const next = await runUpstreamStatusPage(env(), {
      limit: 2,
      after: page.next_cursor as string,
    });
    expect(next.rows.map((r) => [r.dataset_id, r.state])).toEqual([["on002893", "current"]]);
    expect(next.next_cursor).toBeNull();
    expect(openneuro.log.flatMap((r) => r.ids)).toEqual(["ds002893"]);
  });

  test("one mirror, and a withdrawn one is none", async () => {
    const one = await runUpstreamStatusPage(env(), { dataset: "on002893" });
    expect(one.rows).toHaveLength(1);
    const withdrawn = await runUpstreamStatusPage(env(), { dataset: "on000004" });
    expect(withdrawn.rows).toEqual([]);
  });

  test("the whole fleet in counts, the way the weekly report reads it", async () => {
    const summary = await runUpstreamFleetSummary(env());
    expect(summary.population).toBe(3);
    expect(summary.examined).toBe(3);
    expect(summary.truncated).toBe(false);
    expect(summary.counts.states).toMatchObject({ current: 1, not_examined: 1, in_progress: 1 });
  });

  test("the version rows the landing reads carry the two snapshot columns", async () => {
    const row = await d1.prepare(PUBLIC_DATASET_VERSIONS_SQL).bind("on002893").first<{
      version: string;
      source_version: string | null;
      source_version_basis: string | null;
    }>();
    expect(row).toMatchObject({
      version: "1.0.0",
      source_version: "2.0.0",
      source_version_basis: "doi",
    });
  });
});
