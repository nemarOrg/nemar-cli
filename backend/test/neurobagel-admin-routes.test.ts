/**
 * POST /admin/neurobagel/regenerate and GET /admin/neurobagel/status
 * (epic #1586, phase 4; ADR 0084), through the real worker.
 *
 * `regenerate` is a DRY RUN BY DEFAULT: only an explicit boolean `execute: true` writes,
 * and only with the writer enabled. The body is strict, so a typo is a 400 and not a
 * silent dry run. `status` reports what is eligible, written, stale and waiting on a
 * person, says null where it does not know (never zero), and carries no identifier of
 * an anonymity-class finding and no secret.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import { hashApiKey } from "../src/services/token";
import type { Bindings } from "../src/types/bindings";
import { wrapD1 } from "./helpers/d1";
import {
  type Harness,
  recordWrites,
  seedSynthetic,
  startHarness,
  storeKeys,
} from "./helpers/neurobagel-harness";
import {
  RECORDED,
  type UpstreamStandin,
  startUpstreamStandin,
} from "./helpers/neurobagel-upstream";

const ADMIN_KEY = "nb-admin-key-0123456789abcdef0123456789abcdef";
const MEMBER_KEY = "nb-member-key-0123456789abcdef0123456789abcdef";
const API = "https://api.nemar.org";
const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

let h: Harness;
let adminId = 0;
// The verification route reads upstream's public API; this is a local server with the real
// recorded answers, so no test here reaches the internet.
let upstream: UpstreamStandin;

beforeAll(async () => {
  h = await startHarness();
  upstream = startUpstreamStandin();
});
afterAll(async () => {
  upstream.stop();
  await h.dispose();
});

beforeEach(async () => {
  await h.reset();
  upstream.answers = { ...RECORDED };
  upstream.requests.length = 0;
  for (const [username, role, key] of [
    ["nbadmin", "admin", ADMIN_KEY],
    ["nbmember", "member", MEMBER_KEY],
  ] as const) {
    h.db
      .query(
        `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
         VALUES (?, ?, 'x', 'approved', ?, 1, 1)`,
      )
      .run(username, `${username}@example.org`, role);
    const row = h.db
      .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
      .get(username);
    h.db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(row?.id ?? 0, await hashApiKey(key), key.slice(0, 8));
    if (role === "admin") adminId = row?.id ?? 0;
  }
});

function call(
  method: "GET" | "POST",
  path: string,
  opts: { key?: string | null; body?: unknown; rawBody?: string; env?: Bindings } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = opts.key === undefined ? ADMIN_KEY : opts.key;
  if (key) headers.Authorization = `Bearer ${key}`;
  const body =
    opts.rawBody !== undefined
      ? opts.rawBody
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : method === "POST"
          ? "{}"
          : undefined;
  return worker.fetch(
    new Request(`${API}${path}`, { method, headers, body }),
    opts.env ?? h.env(),
    ctx,
  );
}

const regenerate = (body: unknown, opts: { key?: string | null; env?: Bindings } = {}) =>
  call("POST", "/admin/neurobagel/regenerate", { ...opts, body });

describe("who may call", () => {
  test("a member is refused, and nothing is read or written", async () => {
    seedSynthetic(h, "nm000800");
    for (const [method, path] of [
      ["GET", "/admin/neurobagel/status"],
      ["POST", "/admin/neurobagel/regenerate"],
    ] as const) {
      const res = await call(method, path, { key: MEMBER_KEY, body: { execute: true } });
      expect(res.status).toBe(403);
    }
    expect(await storeKeys(h.bucket)).toEqual([]);
    expect(h.standin.log).toEqual([]);
  });

  test("an unauthenticated caller is refused", async () => {
    for (const [method, path] of [
      ["GET", "/admin/neurobagel/status"],
      ["POST", "/admin/neurobagel/regenerate"],
    ] as const) {
      expect((await call(method, path, { key: null })).status).toBe(401);
    }
  });
});

describe("regenerate: a dry run by default", () => {
  test("no body, an empty body and execute: false all write nothing and say they are dry runs", async () => {
    seedSynthetic(h, "nm000800");
    const rec = recordWrites(h.bucket);
    const env = h.env({ NEUROBAGEL: rec.bucket });
    for (const body of [{}, { execute: false }, { force: true }, { limit: 5 }]) {
      const res = await regenerate(body, { env });
      expect(res.status).toBe(200);
      const result = (await res.json()) as { dry_run: boolean; results: { outcome: string }[] };
      expect(result.dry_run).toBe(true);
      expect(result.results).toEqual([
        { id: "nm000800", outcome: "would_write", reason: expect.any(String) },
      ] as never);
    }
    expect(rec.log).toEqual([]);
    expect(await storeKeys(h.bucket)).toEqual([]);
    // And no audit row either: a dry run is a read.
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'neurobagel_%'").get(),
    ).toEqual({ n: 0 });
  });

  test("a dry run works while the writer is disabled: an operator can see what enabling would do", async () => {
    seedSynthetic(h, "nm000800");
    const res = await regenerate({}, { env: h.env({ NEUROBAGEL_WRITER_ENABLED: undefined }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { writer_enabled: boolean }).writer_enabled).toBe(false);
  });

  test("execute must be the boolean true: a string, a number and a typo are refused, not read as intent", async () => {
    seedSynthetic(h, "nm000800");
    for (const body of [
      { execute: "true" },
      { execute: 1 },
      { execute: "yes" },
      { exec: true },
      { dry_run: false },
      { execute: true, surprise: 1 },
    ]) {
      expect((await regenerate(body)).status).toBe(400);
    }
    expect(await storeKeys(h.bucket)).toEqual([]);
  });

  test("the list and the limit are validated", async () => {
    for (const body of [
      { datasets: [] },
      { datasets: ["garbage"] },
      { datasets: ["nm000800", "NM000801"] },
      { datasets: Array.from({ length: 51 }, (_, i) => `nm${String(1000700 + i).slice(1)}`) },
      { limit: 0 },
      // One more than a call may examine: refused, not silently shortened.
      { limit: 51 },
      { limit: 200 },
      { limit: -1 },
      { limit: 1.5 },
      { limit: "5" },
    ]) {
      expect((await regenerate(body)).status).toBe(400);
    }
  });

  test("the ceiling itself is accepted: 50 datasets named, a limit of 50", async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `nm${String(1000700 + i).slice(1)}`);
    expect((await regenerate({ datasets: fifty })).status).toBe(200);
    const res = await regenerate({ limit: 50 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { limit: number }).limit).toBe(50);
  });

  test("an invalid JSON body is a 400, not a dry run", async () => {
    const res = await call("POST", "/admin/neurobagel/regenerate", { rawBody: "{ nope" });
    expect(res.status).toBe(400);
  });
});

describe("regenerate: execute", () => {
  test("execute: true writes, honors the per-call bound, and writes one audit row naming the admin", async () => {
    for (const id of ["nm000800", "nm000801", "nm000802"]) seedSynthetic(h, id);
    const res = await regenerate({ execute: true, limit: 2 });
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      dry_run: boolean;
      examined: number;
      unexamined: number;
      limit: number;
      results: { id: string; outcome: string }[];
    };
    expect(result.dry_run).toBe(false);
    expect(result.limit).toBe(2);
    expect(result.examined).toBe(2);
    expect(result.unexamined).toBe(1);
    expect(result.results.map((r) => `${r.id}:${r.outcome}`)).toEqual([
      "nm000800:written",
      "nm000801:written",
    ]);
    const rows = h.db
      .query<{ user_id: number; details: string }, []>(
        "SELECT user_id, details FROM audit_log WHERE action = 'neurobagel_regenerate'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(adminId);
    expect(JSON.parse(rows[0]?.details ?? "{}")).toMatchObject({ limit: 2, force: false });
  });

  test("with no limit the per-tick bound applies, and NEUROBAGEL_RECONCILE_MAX sets it", async () => {
    for (const id of ["nm000800", "nm000801", "nm000802"]) seedSynthetic(h, id);
    const res = await regenerate(
      { execute: true },
      { env: h.env({ NEUROBAGEL_RECONCILE_MAX: "1" }) },
    );
    const result = (await res.json()) as { examined: number; limit: number };
    expect(result.limit).toBe(1);
    expect(result.examined).toBe(1);
  });

  test("a datasets list is examined as named, and its own length is its bound", async () => {
    for (const id of ["nm000800", "nm000801", "nm000802"]) seedSynthetic(h, id);
    const res = await regenerate({ execute: true, datasets: ["nm000802", "nm000800"] });
    const result = (await res.json()) as { results: { id: string; outcome: string }[] };
    expect(result.results.map((r) => `${r.id}:${r.outcome}`)).toEqual([
      "nm000800:written",
      "nm000802:written",
    ]);
    expect(await storeKeys(h.bucket)).not.toContain("nm000801.jsonld");
  });

  test("a named dataset that is not eligible is not written, and an unknown one is ignored", async () => {
    seedSynthetic(h, "nm000800", { visibility: "private" });
    seedSynthetic(h, "nm000801", { anonymous: 1, firstPublishedAt: null });
    const res = await regenerate({ execute: true, datasets: ["nm000800", "nm000801", "nm000999"] });
    const result = (await res.json()) as { results: unknown[]; eligible: number };
    expect(result.results).toEqual([]);
    expect(await storeKeys(h.bucket)).toEqual([]);
  });

  test("force rewrites an unchanged dataset", async () => {
    seedSynthetic(h, "nm000800");
    await regenerate({ execute: true });
    const unchanged = (await (await regenerate({ execute: true })).json()) as {
      results: { outcome: string }[];
    };
    expect(unchanged.results[0]?.outcome).toBe("unchanged");
    const forced = (await (await regenerate({ execute: true, force: true })).json()) as {
      results: { outcome: string }[];
    };
    expect(forced.results[0]?.outcome).toBe("written");
  });

  test("execute with the writer disabled is a 409 that says why, and writes nothing", async () => {
    seedSynthetic(h, "nm000800");
    const rec = recordWrites(h.bucket);
    const res = await regenerate(
      { execute: true },
      { env: h.env({ NEUROBAGEL: rec.bucket, NEUROBAGEL_WRITER_ENABLED: undefined }) },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; status: string };
    expect(body.status).toBe("disabled");
    expect(body.error).toMatch(/NEUROBAGEL_WRITER_ENABLED/);
    expect(rec.log).toEqual([]);
  });

  test("execute with no bucket bound is a 409 store_unconfigured", async () => {
    seedSynthetic(h, "nm000800");
    const res = await regenerate({ execute: true }, { env: h.env({ NEUROBAGEL: undefined }) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { status: string }).status).toBe("store_unconfigured");
  });

  test("a run that fails is a 500 with the result, not a silent success", async () => {
    seedSynthetic(h, "nm000800");
    const d1 = wrapD1(h.env().DB, (sql) => {
      if (sql.includes("FROM datasets d") && sql.includes("ORDER BY d.dataset_id")) {
        throw new Error("D1 is down");
      }
    });
    const originalError = console.error;
    console.error = () => {};
    const res = await regenerate({ execute: true }, { env: h.env({ DB: d1 }) });
    console.error = originalError;
    expect(res.status).toBe(500);
    expect(((await res.json()) as { status: string }).status).toBe("error");
  });
});

describe("status", () => {
  type Status = {
    writer: { mode: string };
    read_route: { token_configured: boolean };
    limits: { reconcile_max: number };
    counts: Record<string, number | null>;
    store: { configured: boolean; objects: number | null; total_bytes: number | null };
    index: { present: boolean | null; entries: number | null; matches_store: boolean | null };
    last_run: { trigger: string } | null;
    last_reconcile: { trigger: string } | null;
    needs_review: { id: string; source: string; flags?: string[]; code?: string; since?: string }[];
    anonymity_findings: number | null;
    warnings: string[];
  };
  const status = async (env?: Bindings) =>
    (await (await call("GET", "/admin/neurobagel/status", { env })).json()) as Status;

  test("an empty system: nothing eligible, nothing written, no run yet, and nothing is zero that is unknown", async () => {
    const s = await status();
    expect(s.writer.mode).toBe("enabled");
    expect(s.counts).toMatchObject({ eligible: 0, written: 0, missing: 0, stale: 0, residue: 0 });
    expect(s.index.present).toBe(false);
    expect(s.last_run).toBeNull();
    expect(s.last_reconcile).toBeNull();
    expect(s.needs_review).toEqual([]);
    expect(s.anonymity_findings).toBe(0);
  });

  test("it counts what is eligible, written, missing, stale and waiting to be removed", async () => {
    for (const id of ["nm000800", "nm000801", "nm000802", "nm000803"]) seedSynthetic(h, id);
    await regenerate({ execute: true, datasets: ["nm000800", "nm000801", "nm000802"] });
    // 801 changes (stale), 802 leaves (residue), 803 was never written (missing).
    h.db.run("UPDATE datasets SET name = 'Edited' WHERE dataset_id = 'nm000801'");
    h.db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000802'");
    const s = await status();
    expect(s.counts).toMatchObject({
      eligible: 3,
      written: 2,
      missing: 1,
      stale: 1,
      residue: 1,
      incomplete: 0,
    });
    expect(s.store.objects).toBeGreaterThan(0);
    expect(s.store.total_bytes).toBeGreaterThan(0);
    expect(s.index.entries).toBe(3);
    // The index as stored still names the dataset that left: it does not match the store.
    expect(s.index.matches_store).toBe(false);
  });

  test("the last reconcile is the last cron-triggered run, and the last run is the latest of any kind", async () => {
    seedSynthetic(h, "nm000800");
    await regenerate({ execute: true });
    const { runNeurobagelWriter } = await import("../src/services/neurobagel-writer");
    await runNeurobagelWriter(h.env(), { trigger: "cron", execute: true });
    const s = await status();
    expect(s.last_run?.trigger).toBe("cron");
    expect(s.last_reconcile?.trigger).toBe("cron");
  });

  test("a report flag that needs review is listed from the store, with its dataset", async () => {
    seedSynthetic(h, "nm000800", {
      subjects: ["sub-01", "sub-02", "sub-03"],
      tsv: "participant_id\tage\nsub-01\t21\nsub-02\t22\nsub-09\t23\n",
    });
    await regenerate({ execute: true });
    const s = await status();
    expect(s.needs_review).toEqual([{ id: "nm000800", source: "report", flags: ["partial_join"] }]);
  });

  test("a standing refusal is listed with its code; the anonymity class is a count and never an id", async () => {
    seedSynthetic(h, "nm000800");
    seedSynthetic(h, "nm000801");
    const { runNeurobagelWriter } = await import("../src/services/neurobagel-writer");
    // 800: a curation failure (a refusal that stands). 801: the data plane says anonymous.
    let flipped = false;
    const d1 = wrapD1(h.env().DB, (sql) => {
      if (!flipped && sql.includes("SELECT dataset_id, name, description, github_repo")) {
        // Applies to whichever dataset's metadata is built first after 800's refusal: 801.
        flipped = true;
        h.db.run(
          "UPDATE datasets SET anonymous = 1, first_published_at = NULL WHERE dataset_id = 'nm000801'",
        );
      }
    });
    await runNeurobagelWriter(h.env({ DB: d1 }), {
      trigger: "admin",
      execute: true,
      deps: {
        curation: async (id) =>
          id === "nm000800" ? { kind: "failed", reason: "broken" } : { kind: "none" },
      },
    });
    const body = await (await call("GET", "/admin/neurobagel/status")).text();
    const s = JSON.parse(body) as Status;
    expect(s.needs_review).toEqual([
      {
        id: "nm000800",
        source: "refusal",
        code: "curation_unavailable",
        since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    ]);
    expect(s.anonymity_findings).toBe(1);
    // The dataset the finding is about is named nowhere in the status.
    expect(body).not.toContain("nm000801");
  });

  test("it never carries the read token, and says only whether one is configured", async () => {
    const withToken = await call("GET", "/admin/neurobagel/status", {
      env: h.env({ NEUROBAGEL_READ_TOKEN: "super-secret-read-token-value" }),
    });
    const text = await withToken.text();
    expect(text).not.toContain("super-secret-read-token-value");
    expect((JSON.parse(text) as Status).read_route.token_configured).toBe(true);
    expect((await status()).read_route.token_configured).toBe(false);
  });

  test("unconfigured and disabled modes are reported, and what cannot be known is null, not zero", async () => {
    seedSynthetic(h, "nm000800");
    const noBucket = await status(h.env({ NEUROBAGEL: undefined }));
    expect(noBucket.writer.mode).toBe("store_unconfigured");
    expect(noBucket.store.configured).toBe(false);
    expect(noBucket.counts.written).toBeNull();
    expect(noBucket.counts.residue).toBeNull();
    expect(noBucket.index.present).toBeNull();
    expect(noBucket.counts.eligible).toBe(1);
    expect(noBucket.warnings.join(" ")).toMatch(/store_unconfigured/);

    const off = await status(h.env({ NEUROBAGEL_WRITER_ENABLED: undefined }));
    expect(off.writer.mode).toBe("disabled");
    expect(off.counts.written).toBe(0);
  });

  test("a D1 failure reads as unknown eligibility, never as nothing eligible", async () => {
    seedSynthetic(h, "nm000800");
    const d1 = wrapD1(h.env().DB, (sql) => {
      if (sql.includes("ORDER BY d.dataset_id") && sql.includes("latest_version")) {
        throw new Error("D1 is down");
      }
    });
    const originalError = console.error;
    console.error = () => {};
    const s = await status(h.env({ DB: d1 }));
    console.error = originalError;
    expect(s.counts.eligible).toBeNull();
    expect(s.counts.missing).toBeNull();
    expect(s.counts.stale).toBeNull();
    expect(s.warnings.join(" ")).toMatch(/eligible datasets could not be read/);
  });
});

describe("verify: the verification sweep on demand", () => {
  type Verify = {
    trigger: string;
    failed: boolean;
    overall: string;
    heartbeat_written: boolean;
    checks: Record<
      string,
      { verdict: string; reason: string; counts: Record<string, number | null> }
    >;
    warnings: string[];
  };
  const verify = (opts: { key?: string | null; env?: Bindings } = {}) =>
    call("POST", "/admin/neurobagel/verify", opts);
  const heartbeats = () =>
    h.db
      .query(
        "SELECT user_id, resource_id, details FROM audit_log WHERE action = 'neurobagel_verification'",
      )
      .all() as { user_id: number | null; resource_id: string; details: string }[];

  test("a member is refused and an unauthenticated caller is not let in, and nothing is read", async () => {
    expect((await verify({ key: MEMBER_KEY })).status).toBe(403);
    expect((await verify({ key: null })).status).toBe(401);
    expect(upstream.requests).toEqual([]);
    expect(heartbeats()).toEqual([]);
  });

  test("an admin gets the verdicts, with no body, and one heartbeat recorded as an on-demand run", async () => {
    seedSynthetic(h, "nm000800");
    const res = await verify();
    expect(res.status).toBe(200);
    const v = (await res.json()) as Verify;
    expect(v.trigger).toBe("admin");
    expect(v.failed).toBe(false);
    expect(v.heartbeat_written).toBe(true);
    expect(Object.keys(v.checks)).toEqual(["store", "node", "registration", "drift"]);
    // Nothing is configured for the node or the federation here, and upstream equals the pins.
    expect(v.checks.node?.verdict).toBe("unchecked");
    expect(v.checks.registration?.verdict).toBe("unchecked");
    expect(v.checks.drift?.verdict).toBe("healthy");
    expect(v.checks.store?.verdict).toBe("healthy");
    expect(heartbeats()).toHaveLength(1);
    expect(heartbeats()[0]).toMatchObject({ user_id: null, resource_id: "admin" });
  });

  test("it works on staging, which is the whole reason the sweep is unguarded: only the cron wrapper is production-only", async () => {
    for (const environment of ["staging", "development", "test"] as const) {
      const res = await verify({ env: h.env({ ENVIRONMENT: environment }) });
      expect(res.status, environment).toBe(200);
      expect(((await res.json()) as Verify).heartbeat_written).toBe(true);
    }
    expect(heartbeats()).toHaveLength(3);
  });

  test("it reports and never repairs: a store with residue is left exactly as it was", async () => {
    seedSynthetic(h, "nm000800");
    // Written, then the dataset goes private: its artifacts are now residue.
    await call("POST", "/admin/neurobagel/regenerate", { body: { execute: true } });
    h.db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000800'");
    const before = await storeKeys(h.bucket);
    const rec = recordWrites(h.bucket);
    const res = await verify({ env: h.env({ NEUROBAGEL: rec.bucket }) });
    expect(((await res.json()) as Verify).checks.store?.counts.residue).toBe(1);
    expect(rec.log).toEqual([]);
    expect(await storeKeys(h.bucket)).toEqual(before);
    expect(
      h.db.query("SELECT visibility FROM datasets WHERE dataset_id = 'nm000800'").get(),
    ).toEqual({
      visibility: "private",
    });
  });

  test("an upstream that has moved is an alarm in the answer, and the status then shows it", async () => {
    upstream.answers = {
      ...upstream.answers,
      "/repos/neurobagel/query-tool/releases/latest": {
        ...(upstream.answers["/repos/neurobagel/query-tool/releases/latest"] as object),
        tag_name: "v0.99.0",
      },
    };
    const v = (await (await verify()).json()) as Verify;
    expect(v.overall).toBe("alarm");
    expect(v.checks.drift?.reason).toContain("query tool v0.17.0 -> v0.99.0");
    const s = (await (await call("GET", "/admin/neurobagel/status")).json()) as {
      verification: Verify | null;
    };
    expect(s.verification?.overall).toBe("alarm");
    expect(s.verification?.checks.drift?.verdict).toBe("alarm");
  });

  test("the answer names no dataset: counts and verdicts only", async () => {
    seedSynthetic(h, "nm000800");
    const body = JSON.stringify(await (await verify()).json());
    expect(body).not.toMatch(/\b(nm|on)\d{6}\b/);
  });
});

describe("status carries the verification verdicts", () => {
  type WithVerification = {
    verification: {
      overall: string;
      at: string;
      trigger: string;
      checks: Record<string, { verdict: string }>;
    } | null;
    warnings: string[];
  };
  const status = async () =>
    (await (await call("GET", "/admin/neurobagel/status")).json()) as WithVerification;

  test("before any run it is null: unknown, which a reader must not take for healthy", async () => {
    const s = await status();
    expect(s.verification).toBeNull();
    expect(s.warnings.join(" ")).not.toMatch(/verification/);
  });

  test("after a run it is the latest heartbeat of any trigger, verbatim", async () => {
    await call("POST", "/admin/neurobagel/verify");
    const s = await status();
    expect(s.verification?.trigger).toBe("admin");
    expect(s.verification?.overall).toBe("healthy");
    expect(Object.values(s.verification?.checks ?? {}).map((c) => c.verdict)).toEqual([
      "healthy",
      "unchecked",
      "unchecked",
      "healthy",
    ]);
  });

  test("a heartbeat that cannot be read as one is a warning and not a healthy answer", async () => {
    h.db.run(
      "INSERT INTO audit_log (action, resource_type, resource_id, details) VALUES ('neurobagel_verification', 'neurobagel', 'cron', '{\"overall\":\"healthy\"}')",
    );
    const s = await status();
    expect(s.verification).toBeNull();
    expect(s.warnings.join(" ")).toMatch(/heartbeat could not be read/);
  });
});
