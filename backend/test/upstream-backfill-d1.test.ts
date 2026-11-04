/**
 * The upstream backfill on Miniflare D1, the implementation `wrangler --local` runs (epic #1046
 * phase 2, #1908; ADR 0111, decision 4, and the #1983 review amendment).
 *
 * The route's tests (`upstream-backfill-route.test.ts`) run on bun:sqlite, which is more lenient
 * than D1 (a GLOB pattern's length, the bound-parameter cap). Here the candidate, remaining, write
 * and count statements run through the real service on real D1 with every migration applied, and
 * the raw content host is a local `Bun.serve()`, so nothing leaves the machine.
 *
 * The property: a version D1 holds in the tag's spelling, `vN.N.N`, is examined as `N.N.N` is. Its
 * description is read at its tag, its own row is written, a version stored in both spellings is
 * read once, and the cursor after a `v`-spelled row carries its `v` and is taken back. Any other
 * stored spelling is never read.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Miniflare } from "miniflare";
import { CURSOR_RE, runUpstreamBackfill } from "../src/services/upstream-backfill";
import type { Bindings } from "../src/types/bindings";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";

/** The raw content host: `/nemarDatasets/<repo>/<ref>/dataset_description.json`, and a log. */
const files = new Map<string, string>();
const log: string[] = [];
let raw: Server;

beforeAll(() => {
  raw = Bun.serve({
    port: 0,
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      log.push(path);
      const body = files.get(path);
      return body === undefined
        ? new Response("404: Not Found", { status: 404 })
        : new Response(body, { status: 200 });
    },
  });
});
afterAll(() => raw.stop(true));

let mf: Miniflare;
let d1: D1Database;

beforeEach(async () => {
  files.clear();
  log.length = 0;
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB"],
  });
  d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(d1, migrationFiles());
});
afterEach(async () => {
  await mf.dispose();
});

const env = () =>
  ({
    DB: d1,
    ENVIRONMENT: "development",
    GITHUB_RAW_BASE: `http://127.0.0.1:${raw.port}`,
    GITHUB_ADMIN_PAT: "ubf-d1-test-pat",
  }) as Bindings;

/** A mirror whose version rows, each three hours old and never examined, are `versions`. */
async function seed(id: string, versions: string[]): Promise<void> {
  await d1
    .prepare(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo) VALUES (?, ?, -1, ?)",
    )
    .bind(id, id, `nemarDatasets/${id}`)
    .run();
  for (const v of versions) {
    await d1
      .prepare(
        `INSERT INTO dataset_versions (dataset_id, version, doi, created_at)
         VALUES (?, ?, ?, datetime('now', '-3 hours'))`,
      )
      .bind(id, v, `10.82901/${id}.${v}`)
      .run();
  }
}

/** Serve, at the tag `v<bare>` of `id`, a description whose own entry names `tag`. */
function serve(id: string, bare: string, tag: string): void {
  files.set(
    `/nemarDatasets/${id}/v${bare}/dataset_description.json`,
    JSON.stringify({
      Name: id,
      SourceDatasets: [{ DOI: `10.18112/openneuro.ds${id.slice(2)}.v${tag}` }],
    }),
  );
}

const snapshotOf = (id: string, version: string) =>
  d1
    .prepare(
      "SELECT source_version, source_version_basis FROM dataset_versions WHERE dataset_id = ? AND version = ?",
    )
    .bind(id, version)
    .first<{ source_version: string | null; source_version_basis: string | null }>();

describe("the upstream backfill on Miniflare D1", () => {
  test("a v-only row is examined at its tag, and its source_version is written", async () => {
    await seed("on000001", ["v1.0.0"]);
    serve("on000001", "1.0.0", "2.0.2");
    const dry = await runUpstreamBackfill(env());
    expect(dry).toMatchObject({ ok: true, scanned: 1, recorded: { doi: 1, unknown: 0 } });
    expect(await snapshotOf("on000001", "v1.0.0")).toEqual({
      source_version: null,
      source_version_basis: null,
    });

    const run = await runUpstreamBackfill(env(), { execute: true });
    expect(run).toMatchObject({
      ok: true,
      execute: true,
      scanned: 1,
      recorded: { doi: 1, unknown: 0 },
      not_examined: 0,
      next_cursor: null,
      remaining: 0,
      counts: { doi: 1, not_examined: 0 },
    });
    expect(await snapshotOf("on000001", "v1.0.0")).toEqual({
      source_version: "2.0.2",
      source_version_basis: "doi",
    });
    // Read at the canonical tag, never `vv1.0.0`, once by the dry run and once by the run.
    expect(log).toEqual([
      "/nemarDatasets/on000001/v1.0.0/dataset_description.json",
      "/nemarDatasets/on000001/v1.0.0/dataset_description.json",
    ]);
    // Examined, it is no candidate again.
    expect(await runUpstreamBackfill(env(), { execute: true })).toMatchObject({ scanned: 0 });
  });

  test("a version stored in both spellings is read once, and each row is written", async () => {
    await seed("on000001", ["1.0.0", "v1.0.0"]);
    serve("on000001", "1.0.0", "2.0.2");
    const run = await runUpstreamBackfill(env(), { execute: true });
    expect(run).toMatchObject({ scanned: 2, recorded: { doi: 2, unknown: 0 } });
    for (const v of ["1.0.0", "v1.0.0"]) {
      expect(await snapshotOf("on000001", v)).toEqual({
        source_version: "2.0.2",
        source_version_basis: "doi",
      });
    }
    expect(log).toEqual(["/nemarDatasets/on000001/v1.0.0/dataset_description.json"]);
  });

  test("the cursor after a v-spelled row carries its v, and paging finishes", async () => {
    await seed("on000001", ["v2.0.0"]);
    await seed("on000002", ["1.0.0"]);
    serve("on000001", "2.0.0", "2.0.2");
    serve("on000002", "1.0.0", "1.0.0");
    const first = await runUpstreamBackfill(env(), { execute: true, limit: 1 });
    expect(first).toMatchObject({ scanned: 1, next_cursor: "on000001@v2.0.0", remaining: 1 });
    // The route's check takes the cursor back.
    expect(CURSOR_RE.test(first.next_cursor as string)).toBe(true);
    const second = await runUpstreamBackfill(env(), {
      execute: true,
      limit: 1,
      after: first.next_cursor as string,
    });
    expect(second).toMatchObject({ scanned: 1, next_cursor: null, remaining: 0 });
    expect(await snapshotOf("on000001", "v2.0.0")).toMatchObject({ source_version: "2.0.2" });
    expect(await snapshotOf("on000002", "1.0.0")).toMatchObject({ source_version: "1.0.0" });
  });

  test("any other stored spelling is never a candidate", async () => {
    const odd = ["vv1.0.0", "V1.0.0", "v1.0", "1.0", "1.0.0.1", "v1.0.0-rc1"];
    await seed("on000001", odd);
    for (const v of odd) serve("on000001", v.replace(/^v/, ""), "2.0.2");
    const run = await runUpstreamBackfill(env(), { execute: true });
    expect(run).toMatchObject({ scanned: 0, counts: { not_examined: odd.length } });
    expect(log).toEqual([]);
  });
});
