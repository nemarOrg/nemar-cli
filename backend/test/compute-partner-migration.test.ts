/**
 * Migration 0134_compute_partner.sql (epic #2021 phase D4, #2025; ADR 0118, the amendment of this phase),
 * on two engines: bun:sqlite, which every other suite uses, and Miniflare's D1, the implementation
 * `wrangler --local` runs.
 *
 * What is pinned: the idempotency table takes one row per (scope, key) and refuses a second under the
 * primary key, a scope that is not `client:<id>`, a key with a character outside the alphabet, a hash that
 * is not 64 lowercase hex digits and a job id that is none; the three new job columns read NULL on a job
 * that is not a partner's; `partner_state` takes exactly `pending`, `verified` and `mismatch`;
 * `partner_flag` is a fixed word; the three partial indexes exist and the file writes nothing that was
 * already there (the unique index on the Tapis uuid is `compute_jobs.tapis_uuid UNIQUE` of 0115, and a
 * second row with one uuid is still refused); every GLOB is within D1's 50 characters.
 *
 * MUTATIONS (each applied to the migration text, run, and restored): drop the scope's `client:` prefix
 * term; drop the key's alphabet GLOB; widen the `partner_state` CHECK with `'released'`; drop the
 * primary key.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { OPEN_RESERVATIONS_SQL, UNVERIFIED_ROWS_SQL } from "../src/services/compute-hold-reaper";
import { MIGRATIONS_DIR, applyMigrations, migrationFiles } from "./helpers/miniflare-d1";

const FILE = "0134_compute_partner.sql";
const SQL = readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8");

interface Engine {
  name: string;
  run(sql: string, ...binds: unknown[]): Promise<string | null>;
  all<T>(sql: string, ...binds: unknown[]): Promise<T[]>;
}

const BEFORE = migrationFiles().filter((f) => f < FILE);
const HASH = "a".repeat(64);
const JOB = "job_0123456789abcdef01234567";

function sqliteEngine(): { engine: Engine; before: Database } {
  const db = new Database(":memory:");
  for (const f of BEFORE) db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  // A job that predates the migration: its three new columns must read NULL afterwards.
  db.run(
    `INSERT INTO compute_jobs (id, source, kind, app_id, app_version, spec_digest, partition, pool,
       nodes, cores_per_node, minutes) VALUES ('job_00000000000000000000aaaa', 'partner', 'batch', 'a',
       '1', '${HASH}', 'shared', 'cpu', 1, 1, 1)`,
  );
  db.exec(SQL);
  for (const f of migrationFiles().filter((n) => n > FILE)) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  }
  return {
    before: db,
    engine: {
      name: "bun:sqlite",
      async run(sql, ...binds) {
        try {
          db.prepare(sql).run(...(binds as never[]));
          return null;
        } catch (err) {
          return String(err);
        }
      },
      async all<T>(sql: string, ...binds: unknown[]) {
        return db.prepare(sql).all(...(binds as never[])) as T[];
      },
    },
  };
}

const ENGINES: Engine[] = [];
let mf: Miniflare;
let seq = 0;

beforeAll(async () => {
  ENGINES.push(sqliteEngine().engine);
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB"],
  });
  const d1 = await mf.getD1Database("DB");
  await applyMigrations(d1, BEFORE);
  await d1
    .prepare(
      `INSERT INTO compute_jobs (id, source, kind, app_id, app_version, spec_digest, partition, pool,
         nodes, cores_per_node, minutes) VALUES ('job_00000000000000000000aaaa', 'partner', 'batch', 'a',
         '1', '${HASH}', 'shared', 'cpu', 1, 1, 1)`,
    )
    .run();
  await applyMigrations(d1, [FILE]);
  await applyMigrations(
    d1,
    migrationFiles().filter((n) => n > FILE),
  );
  ENGINES.push({
    name: "Miniflare D1",
    async run(sql, ...binds) {
      try {
        await d1
          .prepare(sql)
          .bind(...binds)
          .run();
        return null;
      } catch (err) {
        return String(err);
      }
    },
    async all<T>(sql: string, ...binds: unknown[]) {
      return (
        await d1
          .prepare(sql)
          .bind(...binds)
          .all<T>()
      ).results;
    },
  });
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

function onEveryEngine(name: string, body: (e: Engine) => Promise<void>) {
  test(name, async () => {
    expect(ENGINES).toHaveLength(2);
    for (const e of ENGINES) {
      try {
        await body(e);
      } catch (err) {
        throw new Error(`${e.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, 60_000);
}

const CHECK = /CHECK constraint failed/;
const UNIQUE = /UNIQUE constraint failed/;

const claim = (e: Engine, over: Record<string, unknown> = {}) => {
  seq += 1;
  const row: Record<string, unknown> = {
    scope: "client:oc_0123456789abcdef",
    key: `key-${seq}`,
    request_hash: HASH,
    job_id: JOB,
    ...over,
  };
  const names = Object.keys(row);
  return e.run(
    `INSERT INTO compute_idempotency_keys (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    ...names.map((n) => row[n]),
  );
};

describe("compute_idempotency_keys", () => {
  onEveryEngine("takes one row per (scope, key) and refuses a second", async (e) => {
    expect(await claim(e, { key: "same" })).toBeNull();
    expect(await claim(e, { key: "same" })).toMatch(UNIQUE);
    // Another client may use the same key.
    expect(await claim(e, { key: "same", scope: "client:oc_other" })).toBeNull();
  });

  onEveryEngine("refuses a scope that is not client:<id>", async (e) => {
    for (const scope of ["user:5", "client:", "client:bad id", "client:a/b", "x".repeat(8)]) {
      expect([scope, await claim(e, { scope })]).toEqual([scope, expect.stringMatching(CHECK)]);
    }
    expect(await claim(e, { scope: `client:${"a".repeat(65)}` })).toMatch(CHECK);
  });

  onEveryEngine("refuses a key outside the alphabet and a key of the wrong length", async (e) => {
    for (const key of ["", "has space", "slash/1", "q?", "a".repeat(65)]) {
      expect([key, await claim(e, { key })]).toEqual([key, expect.stringMatching(CHECK)]);
    }
    expect(await claim(e, { key: "a".repeat(64) })).toBeNull();
  });

  onEveryEngine(
    "refuses a hash that is not 64 lowercase hex digits and a job id that is none",
    async (e) => {
      for (const request_hash of ["", "A".repeat(64), "a".repeat(63), `${"a".repeat(63)}g`]) {
        expect(await claim(e, { request_hash })).toMatch(CHECK);
      }
      for (const job_id of ["", "job_zz", `job_${"A".repeat(24)}`, `jobs_${"a".repeat(23)}`]) {
        expect(await claim(e, { job_id })).toMatch(CHECK);
      }
    },
  );
});

describe("the new columns of compute_jobs", () => {
  onEveryEngine("read NULL on a job that predates the migration", async (e) => {
    const rows = await e.all<Record<string, unknown>>(
      `SELECT partner_state, partner_flag, partner_verified_at FROM compute_jobs
        WHERE id = 'job_00000000000000000000aaaa'`,
    );
    expect(rows).toEqual([{ partner_state: null, partner_flag: null, partner_verified_at: null }]);
  });

  const insertJob = (e: Engine, columns: Record<string, unknown>) => {
    seq += 1;
    const row: Record<string, unknown> = {
      id: `job_${seq.toString(16).padStart(24, "0")}`,
      source: "partner",
      kind: "batch",
      app_id: "a",
      app_version: "1",
      spec_digest: HASH,
      partition: "shared",
      pool: "cpu",
      nodes: 1,
      cores_per_node: 1,
      minutes: 1,
      ...columns,
    };
    const names = Object.keys(row);
    return e.run(
      `INSERT INTO compute_jobs (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      ...names.map((n) => row[n]),
    );
  };

  onEveryEngine("partner_state takes exactly pending, verified and mismatch", async (e) => {
    for (const partner_state of ["pending", "verified", "mismatch"]) {
      expect([partner_state, await insertJob(e, { partner_state })]).toEqual([partner_state, null]);
    }
    for (const partner_state of ["released", "PENDING", "", "bound"]) {
      expect(await insertJob(e, { partner_state })).toMatch(CHECK);
    }
  });

  onEveryEngine("partner_flag is a fixed word", async (e) => {
    for (const partner_flag of ["owner_mismatch", "ambiguous_tag", "tapis_unreachable", "a1_b2"]) {
      expect(await insertJob(e, { partner_flag })).toBeNull();
    }
    for (const partner_flag of ["", "Has Space", "UPPER", "a-b", "x".repeat(65)]) {
      expect([partner_flag, await insertJob(e, { partner_flag })]).toEqual([
        partner_flag,
        expect.stringMatching(CHECK),
      ]);
    }
  });

  onEveryEngine(
    "the unique index on the bound Tapis uuid is still there (0115, not rewritten)",
    async (e) => {
      expect(await insertJob(e, { tapis_uuid: "uuid-shared-1" })).toBeNull();
      expect(await insertJob(e, { tapis_uuid: "uuid-shared-1" })).toMatch(UNIQUE);
    },
  );
});

describe("the review round's columns and the reaper's plans (M3, Sonnet)", () => {
  onEveryEngine(
    "partner_expires_at and partner_files_digest exist, NULL on a row that predates them",
    async (e) => {
      const rows = await e.all<Record<string, unknown>>(
        `SELECT partner_expires_at, partner_files_digest FROM compute_jobs
        WHERE id = 'job_00000000000000000000aaaa'`,
      );
      expect(rows).toEqual([{ partner_expires_at: null, partner_files_digest: null }]);
    },
  );

  onEveryEngine("partner_files_digest is a lowercase SHA-256 or nothing", async (e) => {
    const base = (digest: string | null) => {
      seq += 1;
      return e.run(
        `INSERT INTO compute_jobs (id, source, kind, app_id, app_version, spec_digest, partition, pool,
           nodes, cores_per_node, minutes, partner_files_digest)
         VALUES (?, 'partner', 'batch', 'a', '1', ?, 'shared', 'cpu', 1, 1, 1, ?)`,
        `job_${(seq + 5000).toString(16).padStart(24, "0")}`,
        HASH,
        digest,
      );
    };
    expect(await base(null)).toBeNull();
    expect(await base(HASH)).toBeNull();
    for (const bad of ["", "A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
      expect([bad.length, await base(bad)]).toEqual([bad.length, expect.stringMatching(CHECK)]);
    }
  });

  onEveryEngine(
    "the reaper's two lists are served by the partial indexes, with no sort of their own",
    async (e) => {
      const plan = async (sql: string, ...binds: unknown[]) =>
        (await e.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...binds))
          .map((r) => r.detail)
          .join(" | ");
      const open = await plan(OPEN_RESERVATIONS_SQL, 30, 25);
      expect(open).toContain("compute_jobs_partner_open");
      expect(open).not.toContain("TEMP B-TREE");
      const unverified = await plan(UNVERIFIED_ROWS_SQL, 25);
      expect(unverified).toContain("compute_jobs_partner_unverified");
      expect(unverified).not.toContain("TEMP B-TREE");
    },
  );
});

describe("the indexes and the file", () => {
  onEveryEngine("the three partial indexes exist", async (e) => {
    const names = (
      await e.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'compute_jobs_%'",
      )
    ).map((r) => r.name);
    for (const n of [
      "compute_jobs_client_live",
      "compute_jobs_partner_open",
      "compute_jobs_partner_unverified",
    ]) {
      expect(names).toContain(n);
    }
  });

  test("the file adds no unique index of its own and every GLOB is within D1's 50 characters", () => {
    const code = SQL.split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(/CREATE UNIQUE INDEX/);
    for (const m of code.matchAll(/GLOB '([^']*)'/g)) {
      expect((m[1] as string).length).toBeLessThanOrEqual(50);
    }
  });
});
