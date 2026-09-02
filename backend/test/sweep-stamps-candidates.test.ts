/**
 * Per-sweep candidate selection through each sweep's REAL entry point,
 * after migration 0073 moved every sweep bookkeeping stamp into the
 * `sweep_stamps` JSON column (#1183).
 *
 * Why this file exists: every sweep finds its work with a predicate over
 * its stamp, and a wrong predicate does not throw -- the sweep silently
 * stops finding candidates (or reprocesses the same rows forever) under a
 * green cron log, the exact #1184 failure mode. So each rewritten
 * predicate is exercised through the real Hono route with a real D1
 * (freshDb = every production migration), never through a hand-copied SQL
 * string that could drift from the handler.
 *
 * How each sweep is observed without real network credentials (the env
 * carries no S3/GitHub config at all, so nothing here can leave the
 * process):
 *
 *  - archive-sweep / zarr-sweep run their candidate query, then fail each
 *    candidate at the S3 client constructor (aws4fetch throws
 *    "accessKeyId is a required option" synchronously, before any fetch).
 *    The response's `checked`/`errors`/`remaining` fields therefore report
 *    the REAL selection.
 *  - channel-montage-sweep / hed-sweep run their candidate query, then 500
 *    at the GitHub token fetch (getDatasetsToken throws synchronously with
 *    no App config and no PAT). The selection is observed via a
 *    result-recording D1 passthrough -- real SQLite executing the route's
 *    own SQL, with the rows additionally recorded (an observation hook,
 *    not a canned response).
 *  - data-integrity-sweep reaches stampDatasetIntegrity even when the S3
 *    verify throws (integrity=null -> "unknown" outcome, stamp-only
 *    write), so its response AND its stamp writes are fully observable --
 *    including that a stamp write on a fresh row (sweep_stamps NULL)
 *    persists, the COALESCE trap.
 *  - the records-ready webhook route needs only a webhook token.
 *
 * Every seeded row that should be a candidate is seeded across the three
 * never-swept shapes at least once per sweep family: sweep_stamps NULL (a
 * fresh post-0073 row), '{}' (json_remove took the stamp away), and an
 * explicit JSON null for the key (the 0073 backfill's shape) -- all three
 * MUST select, or the migration's backfill and the callbacks' json_remove
 * re-arming would strand rows.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { SYSTEM_USER_ID } from "../src/lib/constants";
import { adminRoutes } from "../src/routes/admin";
import {
  ARCHIVE_SWEEP_READY_SQL,
  ARCHIVE_SWEEP_SKIP_SQL,
  ARCHIVE_SWEEP_STAMP_ONLY_SQL,
  CHANNEL_MONTAGE_SWEEP_WRITE_SQL,
  HED_SWEEP_STAMP_ONLY_SQL,
  HED_SWEEP_WRITE_SQL,
  ZARR_SWEEP_READY_SQL,
  ZARR_SWEEP_STAMP_ONLY_SQL,
} from "../src/routes/admin/datasets-lifecycle";
import { registerRecordsReadyRoutes } from "../src/routes/callbacks/records-ready";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

// bun's runtime lacks `crypto.subtle.timingSafeEqual` (a Workers
// extension); the webhook handler's token check needs it. Same real
// constant-time comparison polyfill as recording-stats-callback.test.ts.
const subtle = crypto.subtle as SubtleCrypto & {
  timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
};
if (typeof subtle.timingSafeEqual !== "function") {
  subtle.timingSafeEqual = (a: ArrayBufferView, b: ArrayBufferView): boolean => {
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= (x[i] as number) ^ (y[i] as number);
    return diff === 0;
  };
}

const ADMIN_KEY = "stamp-sweeps-admin-key-0123456789abcdef01234567";
const WEBHOOK_TOKEN = "stamp-sweeps-webhook-token";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
/** Every `.all()` result from the real engine, keyed by its SQL text. */
let allCalls: { sql: string; rows: unknown[] }[];

/**
 * Real-engine D1 passthrough (realD1) that ADDITIONALLY records the rows
 * each `.all()` returns. Needed for the two GitHub-backed sweeps whose
 * handlers 500 after the candidate query (token fetch), so the selection
 * cannot be read off the response body. Every query still executes against
 * the real SQLite `db`; this only observes.
 */
function resultRecordingD1(target: Database, calls: { sql: string; rows: unknown[] }[]): D1Database {
  const base = realD1(target);
  return {
    prepare(sql: string) {
      const stmt = base.prepare(sql);
      const wrap = {
        bind(...args: unknown[]) {
          stmt.bind(...args);
          return wrap;
        },
        run: () => stmt.run(),
        first: <T>() => stmt.first<T>(),
        all: async <T>() => {
          const result = await stmt.all<T>();
          calls.push({ sql, rows: result.results ?? [] });
          return result;
        },
      };
      return wrap;
    },
  } as unknown as D1Database;
}

function env(): Bindings {
  return {
    DB: resultRecordingD1(db, allCalls),
    ENVIRONMENT: "development",
    NEMAR_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
  } as Bindings;
}

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('stampadmin', 'stampadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='stampadmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    u.id,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
}

function post(path: string): Promise<Response> {
  return app.request(
    path,
    { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
    env(),
  );
}

/**
 * Seed a dataset row. `stamps` is the raw sweep_stamps value: null (fresh
 * row), "{}" (emptied object), or a JSON object string, e.g.
 * `{"hed_checked_at":"2026-01-01 00:00:00"}` or `{"hed_checked_at":null}`.
 */
function seedDataset(
  id: string,
  opts: {
    owner?: number;
    visibility?: "public" | "private";
    isSandbox?: 0 | 1;
    githubRepo?: string | null;
    modalities?: string | null;
    zarrStatus?: string | null;
    stamps?: string | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, visibility, is_sandbox,
                           github_repo, modalities, zarr_status, sweep_stamps)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    id,
    opts.owner ?? 1,
    opts.visibility ?? "public",
    opts.isSandbox ?? 0,
    opts.githubRepo === undefined ? null : opts.githubRepo,
    opts.modalities ?? null,
    opts.zarrStatus ?? null,
    opts.stamps ?? null,
  );
}

const stamp = (id: string, key: string): string | null =>
  (
    db
      .query(`SELECT json_extract(sweep_stamps, '$.${key}') AS v FROM datasets WHERE dataset_id = ?`)
      .get(id) as { v: string | null }
  ).v;

/** The recorded rows of the sweep's candidate SELECT (the one carrying the
 *  given stamp's json_extract and a LIMIT ?). */
function recordedCandidates(stampKey: string): string[] {
  const call = allCalls.find((c) => c.sql.includes(`$.${stampKey}`) && c.sql.includes("LIMIT ?"));
  if (!call) throw new Error(`no recorded candidate query for ${stampKey}`);
  return (call.rows as { dataset_id: string }[]).map((r) => r.dataset_id);
}

beforeEach(async () => {
  db = freshDb();
  allCalls = [];
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  registerRecordsReadyRoutes(app as unknown as Parameters<typeof registerRecordsReadyRoutes>[0]);
  db.run(
    `INSERT INTO users (id, username, email, github_username, status)
     VALUES (1, 'alice', 'alice@nemar.org', 'alice', 'approved')`,
  );
  await seedAdmin();
});

// ---------------------------------------------------------------------------
// archive-sweep
// ---------------------------------------------------------------------------

describe("POST /admin/datasets/archive-sweep candidate selection", () => {
  test("selects exactly the unswept managed public rows, across all three never-swept shapes", async () => {
    seedDataset("nm000001"); // candidate: sweep_stamps NULL
    seedDataset("nm000002", { stamps: "{}" }); // candidate: emptied object
    seedDataset("nm000003", { stamps: '{"archive_checked_at":null}' }); // candidate: backfill null
    seedDataset("nm000004", { stamps: '{"archive_checked_at":"2026-01-01 00:00:00"}' }); // excluded: stamped
    seedDataset("nm000005", { visibility: "private" }); // excluded: private
    seedDataset("xx000006", { isSandbox: 1 }); // excluded: sandbox
    seedDataset("ds000007", { owner: SYSTEM_USER_ID }); // excluded: catalog sentinel

    const res = await post("/admin/datasets/archive-sweep");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      checked: number;
      errors: { dataset_id: string }[];
      remaining: number | null;
    };
    // Each selected candidate fails at the S3 client constructor (no env
    // creds), lands in errors unstamped, and still counts as checked --
    // which makes `checked`/`errors` a faithful readout of the selection.
    expect(body.checked).toBe(3);
    expect(body.errors.map((e) => e.dataset_id).sort()).toEqual([
      "nm000001",
      "nm000002",
      "nm000003",
    ]);
    expect(body.remaining).toBe(3); // errored candidates stay candidates
  });

  test("a stamp written by a prior sweep run keeps the row out on re-run", async () => {
    seedDataset("nm000001", {
      stamps: '{"zarr_checked_at":null,"archive_checked_at":"2026-01-01 00:00:00"}',
    });
    const res = await post("/admin/datasets/archive-sweep");
    const body = (await res.json()) as { checked: number; remaining: number | null };
    expect(body.checked).toBe(0);
    expect(body.remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// zarr-sweep
// ---------------------------------------------------------------------------

describe("POST /admin/datasets/zarr-sweep candidate selection", () => {
  test("selects unswept public rows with unknown zarr state, across all three shapes", async () => {
    seedDataset("nm000010"); // candidate: NULL
    seedDataset("nm000011", { stamps: "{}" }); // candidate
    seedDataset("nm000012", { stamps: '{"zarr_checked_at":null}' }); // candidate
    seedDataset("nm000013", { stamps: '{"zarr_checked_at":"2026-01-01 00:00:00"}' }); // excluded: swept
    seedDataset("nm000014", { zarrStatus: "ready" }); // excluded: webhook already confirmed
    seedDataset("nm000015", { visibility: "private" }); // excluded

    const res = await post("/admin/datasets/zarr-sweep");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      checked: number;
      errors: { dataset_id: string }[];
      remaining: number | null;
    };
    expect(body.checked).toBe(3);
    expect(body.errors.map((e) => e.dataset_id).sort()).toEqual([
      "nm000010",
      "nm000011",
      "nm000012",
    ]);
    expect(body.remaining).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// channel-montage-sweep
// ---------------------------------------------------------------------------

describe("POST /admin/datasets/channel-montage-sweep candidate selection", () => {
  test("candidate query selects unswept EEG repos across all three shapes (500 at token fetch is expected)", async () => {
    const repo = (id: string) => `nemarDatasets/${id}`;
    seedDataset("nm000020", { githubRepo: repo("nm000020"), modalities: "eeg" }); // candidate: NULL
    seedDataset("nm000021", { githubRepo: repo("nm000021"), modalities: "eeg", stamps: "{}" });
    seedDataset("nm000022", {
      githubRepo: repo("nm000022"),
      modalities: "ieeg",
      stamps: '{"channel_montage_checked_at":null}',
    }); // candidate: `eeg` LIKE also matches ieeg (documented on the route)
    seedDataset("nm000023", {
      githubRepo: repo("nm000023"),
      modalities: "eeg",
      stamps: '{"channel_montage_checked_at":"2026-01-01 00:00:00"}',
    }); // excluded: probed
    seedDataset("nm000024", { githubRepo: repo("nm000024"), modalities: "meg" }); // excluded: not eeg
    seedDataset("ds000025", { modalities: "eeg" }); // excluded: no repo (catalog)
    seedDataset("xx000026", { githubRepo: repo("xx000026"), modalities: "eeg", isSandbox: 1 }); // excluded

    // With no GitHub App config and no PAT the route 500s at the token
    // fetch -- AFTER running its candidate query against the real engine,
    // which the recording passthrough observed.
    const res = await post("/admin/datasets/channel-montage-sweep");
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("GitHub token");
    expect(recordedCandidates("channel_montage_checked_at")).toEqual([
      "nm000020",
      "nm000021",
      "nm000022",
    ]);
  });

  test("?reset=1 removes only real stamps and clears the probed columns", async () => {
    seedDataset("nm000027", {
      stamps: '{"channel_montage_checked_at":"2026-01-01 00:00:00","hed_checked_at":"2026-02-02 00:00:00"}',
    });
    db.query(
      "UPDATE datasets SET n_channels = 64, electrode_system = 'intl 10/20' WHERE dataset_id = 'nm000027'",
    ).run();
    seedDataset("nm000028", { stamps: '{"channel_montage_checked_at":null}' }); // never probed
    seedDataset("nm000029"); // never probed (NULL)

    const res = await post("/admin/datasets/channel-montage-sweep?reset=1");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reset: number }).reset).toBe(1);

    expect(stamp("nm000027", "channel_montage_checked_at")).toBeNull();
    // Sibling stamps survive the per-key json_remove.
    expect(stamp("nm000027", "hed_checked_at")).toBe("2026-02-02 00:00:00");
    const r = db
      .query("SELECT n_channels, electrode_system FROM datasets WHERE dataset_id = 'nm000027'")
      .get() as { n_channels: number | null; electrode_system: string | null };
    expect(r.n_channels).toBeNull();
    expect(r.electrode_system).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hed-sweep
// ---------------------------------------------------------------------------

describe("POST /admin/datasets/hed-sweep candidate selection", () => {
  test("candidate query selects every unswept managed repo across all three shapes (500 at token fetch is expected)", async () => {
    const repo = (id: string) => `nemarDatasets/${id}`;
    seedDataset("nm000030", { githubRepo: repo("nm000030") }); // candidate: NULL
    seedDataset("nm000031", { githubRepo: repo("nm000031"), stamps: "{}" }); // candidate
    seedDataset("nm000032", { githubRepo: repo("nm000032"), stamps: '{"hed_checked_at":null}' }); // candidate
    seedDataset("nm000033", {
      githubRepo: repo("nm000033"),
      stamps: '{"hed_checked_at":"2026-01-01 00:00:00"}',
    }); // excluded: probed
    seedDataset("ds000034", {}); // excluded: no repo
    seedDataset("xx000035", { githubRepo: repo("xx000035"), isSandbox: 1 }); // excluded

    const res = await post("/admin/datasets/hed-sweep");
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("GitHub token");
    expect(recordedCandidates("hed_checked_at")).toEqual(["nm000030", "nm000031", "nm000032"]);
  });

  test("?reset=1 removes only real stamps and clears the HED columns", async () => {
    seedDataset("nm000036", { stamps: '{"hed_checked_at":"2026-01-01 00:00:00"}' });
    db.query(
      "UPDATE datasets SET has_hed = 1, hed_version = '8.3.0' WHERE dataset_id = 'nm000036'",
    ).run();
    seedDataset("nm000037", { stamps: '{"hed_checked_at":null}' });
    seedDataset("nm000038");

    const res = await post("/admin/datasets/hed-sweep?reset=1");
    expect(((await res.json()) as { reset: number }).reset).toBe(1);
    expect(stamp("nm000036", "hed_checked_at")).toBeNull();
    const r = db
      .query("SELECT has_hed, hed_version FROM datasets WHERE dataset_id = 'nm000036'")
      .get() as { has_hed: number | null; hed_version: string | null };
    expect(r.has_hed).toBeNull();
    expect(r.hed_version).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// data-integrity-sweep
// ---------------------------------------------------------------------------

describe("POST /admin/datasets/data-integrity-sweep candidate selection and stamping", () => {
  const repo = (id: string) => `nemarDatasets/${id}`;

  test("default drain selects all three never-swept shapes and STAMPS them (COALESCE pin through the route)", async () => {
    seedDataset("nm000040", { githubRepo: repo("nm000040") }); // NULL
    seedDataset("nm000041", { githubRepo: repo("nm000041"), stamps: "{}" });
    seedDataset("nm000042", { githubRepo: repo("nm000042"), stamps: '{"data_checked_at":null}' });
    seedDataset("nm000043", {
      githubRepo: repo("nm000043"),
      stamps: `{"data_checked_at":"2026-01-01 00:00:00"}`,
    }); // excluded: checked

    const res = await post("/admin/datasets/data-integrity-sweep");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      processed: number;
      unknown: number;
      remaining: number | null;
    };
    // The S3 verify throws at client construction (no creds), so each
    // candidate classifies as "unknown" -- and stampDatasetIntegrity still
    // stamps it, which is exactly the production convergence contract.
    expect(body.processed).toBe(3);
    expect(body.unknown).toBe(3);
    expect(body.remaining).toBe(0);

    // The stamp PERSISTED on rows whose sweep_stamps was NULL / '{}' /
    // json-null: a missed COALESCE in the stamp write would leave these
    // NULL and this sweep re-selecting them forever.
    for (const id of ["nm000040", "nm000041", "nm000042"]) {
      expect(stamp(id, "data_checked_at")).not.toBeNull();
    }
    // The already-checked row's stamp is untouched.
    expect(stamp("nm000043", "data_checked_at")).toBe("2026-01-01 00:00:00");
  });

  test("?older-than widens candidacy to stale stamps only (time-comparison pin)", async () => {
    seedDataset("nm000044", {
      githubRepo: repo("nm000044"),
      stamps: '{"data_checked_at":"2020-01-01 00:00:00"}',
    }); // stale -> candidate
    seedDataset("nm000045", { githubRepo: repo("nm000045") });
    db.query(
      "UPDATE datasets SET sweep_stamps = json_set(COALESCE(sweep_stamps, '{}'), '$.data_checked_at', datetime('now')) WHERE dataset_id = 'nm000045'",
    ).run(); // freshly checked -> excluded from the 30-day window

    const res = await post("/admin/datasets/data-integrity-sweep?older-than=30");
    const body = (await res.json()) as { processed: number; errors: { dataset_id: string }[] };
    expect(body.processed).toBe(1);
    expect(body.errors.map((e) => e.dataset_id)).toEqual(["nm000044"]);
  });

  test("?before anchors the cutoff: stamps before it re-qualify, later ones do not", async () => {
    seedDataset("nm000046", {
      githubRepo: repo("nm000046"),
      stamps: '{"data_checked_at":"2026-01-01 00:00:00"}',
    }); // before the anchor -> candidate
    seedDataset("nm000047", {
      githubRepo: repo("nm000047"),
      stamps: '{"data_checked_at":"2026-06-01 00:00:00"}',
    }); // after the anchor -> excluded

    const res = await post("/admin/datasets/data-integrity-sweep?before=2026-03-01T00:00:00Z");
    const body = (await res.json()) as { processed: number; errors: { dataset_id: string }[] };
    expect(body.processed).toBe(1);
    expect(body.errors.map((e) => e.dataset_id)).toEqual(["nm000046"]);
  });

  test("?reset=1 removes only real stamps and clears the audit columns", async () => {
    seedDataset("nm000048", {
      githubRepo: repo("nm000048"),
      stamps: '{"data_checked_at":"2026-01-01 00:00:00"}',
    });
    db.query(
      "UPDATE datasets SET data_complete = 1, bytes_present = 2048 WHERE dataset_id = 'nm000048'",
    ).run();
    seedDataset("nm000049", { githubRepo: repo("nm000049"), stamps: '{"data_checked_at":null}' });

    const res = await post("/admin/datasets/data-integrity-sweep?reset=1");
    expect(((await res.json()) as { reset: number }).reset).toBe(1);
    expect(stamp("nm000048", "data_checked_at")).toBeNull();
    const r = db
      .query("SELECT data_complete, bytes_present FROM datasets WHERE dataset_id = 'nm000048'")
      .get() as { data_complete: number | null; bytes_present: number | null };
    expect(r.data_complete).toBeNull();
    expect(r.bytes_present).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Per-candidate stamp writes (pinned exact SQL, imported not copied)
// ---------------------------------------------------------------------------
//
// The four inline route sweeps' per-candidate writes run only after a real
// S3 LIST/GET or GitHub tree walk, which tests cannot perform -- so the
// exported SQL constants the routes execute are pinned here directly, each
// against a row whose sweep_stamps is NULL: the shape on which a missing
// COALESCE makes json_set return NULL, silently dropping the stamp and
// leaving the row a permanent re-sweep candidate.

describe("per-candidate stamp writes persist on a fresh row and end candidacy", () => {
  const cases: [name: string, sql: string, key: string, binds: unknown[]][] = [
    ["archive ready", ARCHIVE_SWEEP_READY_SQL, "archive_checked_at", [1024, "nm000060"]],
    ["archive skip", ARCHIVE_SWEEP_SKIP_SQL, "archive_checked_at", ["too big", "nm000060"]],
    ["archive stamp-only", ARCHIVE_SWEEP_STAMP_ONLY_SQL, "archive_checked_at", ["nm000060"]],
    ["zarr ready", ZARR_SWEEP_READY_SQL, "zarr_checked_at", [3, "etag", "abc", "nm000060"]],
    ["zarr stamp-only", ZARR_SWEEP_STAMP_ONLY_SQL, "zarr_checked_at", ["nm000060"]],
    [
      "channel-montage write",
      CHANNEL_MONTAGE_SWEEP_WRITE_SQL,
      "channel_montage_checked_at",
      [64, "intl 10/20", "nm000060"],
    ],
    ["hed write", HED_SWEEP_WRITE_SQL, "hed_checked_at", [1, "8.3.0", "nm000060"]],
    ["hed stamp-only", HED_SWEEP_STAMP_ONLY_SQL, "hed_checked_at", ["nm000060"]],
  ];

  for (const [name, sql, key, binds] of cases) {
    test(`${name} stamps ${key} on a sweep_stamps=NULL row`, () => {
      seedDataset("nm000060"); // sweep_stamps NULL
      db.prepare(sql).run(...(binds as never[]));
      expect(stamp("nm000060", key)).not.toBeNull();
    });
  }

  test("a stamped row leaves the archive-sweep candidate set through the real route", async () => {
    seedDataset("nm000061");
    db.prepare(ARCHIVE_SWEEP_STAMP_ONLY_SQL).run("nm000061");
    const res = await post("/admin/datasets/archive-sweep");
    const body = (await res.json()) as { checked: number; remaining: number | null };
    expect(body.checked).toBe(0);
    expect(body.remaining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// records-ready webhook (stamp write on a fresh row)
// ---------------------------------------------------------------------------

describe("POST /records-ready stamps records_checked_at through the real route", () => {
  function postWebhook(body: Record<string, unknown>): Promise<Response> {
    return app.request(
      "/records-ready",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Token": WEBHOOK_TOKEN },
        body: JSON.stringify(body),
      },
      env(),
    );
  }

  test("a fresh row (sweep_stamps NULL) gets the stamp persisted (COALESCE pin)", async () => {
    seedDataset("nm000050");
    const res = await postWebhook({ dataset_id: "nm000050", status: "ready" });
    expect(res.status).toBe(200);
    const r = db
      .query(
        "SELECT records_status, json_extract(sweep_stamps, '$.records_checked_at') AS at FROM datasets WHERE dataset_id = 'nm000050'",
      )
      .get() as { records_status: string; at: string | null };
    expect(r.records_status).toBe("ready");
    expect(r.at).not.toBeNull();
  });

  test("unknown dataset still 404s (0-row UPDATE)", async () => {
    const res = await postWebhook({ dataset_id: "nm012345", status: "failed" });
    expect(res.status).toBe(404);
  });
});
