/**
 * Epic #775 Phase 2 — paced auto-import engine.
 *
 * No mocks: the pure decisions (gate, pick, id-map, timestamp parse) are tested
 * directly; the dispatch is tested with an injected fetch returning a real
 * Response; migration 0047 is applied to a real bun:sqlite DB.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTO_IMPORT_GATE_QUERY,
  type FailedJobInfo,
  decideAutoImportGate,
  mapToNemarId,
  parseSqliteUtc,
  pickNextDataset,
  resolveMinIntervalMs,
} from "../src/services/auto-import";
import { triggerOpenNeuroOnboard } from "../src/services/github";
import type { DiscoveredDataset } from "../src/services/openneuro-discovery";

const ds = (id: string): DiscoveredDataset => ({ id, latestTag: "1.0.0", modalities: ["eeg"] });
const GATE_MS = 25 * 60 * 1000;

describe("mapToNemarId", () => {
  test("ds###### -> on######; rejects bad shapes", () => {
    expect(mapToNemarId("ds007964")).toBe("on007964");
    expect(mapToNemarId("ds000001")).toBe("on000001");
    expect(mapToNemarId("on007964")).toBeNull();
    expect(mapToNemarId("ds12345")).toBeNull();
    expect(mapToNemarId("")).toBeNull();
  });
});

describe("parseSqliteUtc", () => {
  test("parses SQLite datetime() (space, zoneless) as UTC, not local", () => {
    // 12:00:00 UTC -> known epoch; must NOT be shifted by the test machine's tz.
    expect(parseSqliteUtc("2026-06-17 12:00:00")).toBe(Date.parse("2026-06-17T12:00:00Z"));
    expect(parseSqliteUtc("2026-06-17T12:00:00Z")).toBe(Date.parse("2026-06-17T12:00:00Z"));
    expect(parseSqliteUtc(null)).toBeNull();
    expect(parseSqliteUtc("not-a-date")).toBeNull();
  });
});

describe("resolveMinIntervalMs (tunable pacing macro)", () => {
  test("parses a valid AUTO_IMPORT_MIN_INTERVAL_MIN to ms", () => {
    expect(resolveMinIntervalMs({ AUTO_IMPORT_MIN_INTERVAL_MIN: "45" })).toBe(45 * 60 * 1000);
    expect(resolveMinIntervalMs({ AUTO_IMPORT_MIN_INTERVAL_MIN: "90" })).toBe(90 * 60 * 1000);
  });
  test("falls back to the 25-min default when unset/invalid/non-positive", () => {
    const def = 25 * 60 * 1000;
    expect(resolveMinIntervalMs({})).toBe(def);
    expect(resolveMinIntervalMs({ AUTO_IMPORT_MIN_INTERVAL_MIN: undefined })).toBe(def);
    expect(resolveMinIntervalMs({ AUTO_IMPORT_MIN_INTERVAL_MIN: "abc" })).toBe(def);
    expect(resolveMinIntervalMs({ AUTO_IMPORT_MIN_INTERVAL_MIN: "0" })).toBe(def);
    expect(resolveMinIntervalMs({ AUTO_IMPORT_MIN_INTERVAL_MIN: "-5" })).toBe(def);
  });
});

describe("decideAutoImportGate", () => {
  const now = Date.parse("2026-06-17T12:00:00Z");
  test("never dispatched -> proceed", () => {
    expect(
      decideAutoImportGate({ lastDispatchAt: null, now, minIntervalMs: GATE_MS }).proceed,
    ).toBe(true);
  });
  test("< 25 min since last -> gated", () => {
    const last = "2026-06-17 11:50:00"; // 10 min ago
    expect(
      decideAutoImportGate({ lastDispatchAt: last, now, minIntervalMs: GATE_MS }).proceed,
    ).toBe(false);
  });
  test(">= 25 min since last -> proceed", () => {
    const last = "2026-06-17 11:30:00"; // 30 min ago (one cron tick)
    expect(
      decideAutoImportGate({ lastDispatchAt: last, now, minIntervalMs: GATE_MS }).proceed,
    ).toBe(true);
  });
  test("unparseable last -> proceed (fail open, don't stall forever)", () => {
    expect(
      decideAutoImportGate({ lastDispatchAt: "garbage", now, minIntervalMs: GATE_MS }).proceed,
    ).toBe(true);
  });
});

describe("pickNextDataset", () => {
  const now = Date.parse("2026-06-17T12:00:00Z");
  const opts = { maxAttempts: 3, backoffMs: 6 * 60 * 60 * 1000, now };
  const recent = "2026-06-17 11:30:00"; // 30 min ago (within 6h backoff)
  const old = "2026-06-10 12:00:00"; // a week ago (past backoff)

  test("fresh datasets first, in discovered order", () => {
    const picked = pickNextDataset([ds("dsA"), ds("dsB"), ds("dsC")], new Map(), opts);
    expect(picked?.id).toBe("dsA");
  });

  test("fresh chosen over a failed candidate", () => {
    const jobInfo: FailedJobInfo = new Map([["dsA", { autoAttempts: 1, updatedAt: old }]]);
    const picked = pickNextDataset([ds("dsA"), ds("dsB")], jobInfo, opts);
    expect(picked?.id).toBe("dsB"); // dsA failed -> rotated behind fresh dsB
  });

  test("failed candidate in backoff is excluded", () => {
    const jobInfo: FailedJobInfo = new Map([["dsA", { autoAttempts: 1, updatedAt: recent }]]);
    expect(pickNextDataset([ds("dsA")], jobInfo, opts)).toBeNull();
  });

  test("failed candidate at the retry cap is excluded (bounded)", () => {
    const jobInfo: FailedJobInfo = new Map([["dsA", { autoAttempts: 3, updatedAt: old }]]);
    expect(pickNextDataset([ds("dsA")], jobInfo, opts)).toBeNull();
  });

  test("among only-failed candidates, the oldest failure (past backoff) is retried", () => {
    const jobInfo: FailedJobInfo = new Map([
      ["dsA", { autoAttempts: 1, updatedAt: "2026-06-12 12:00:00" }],
      ["dsB", { autoAttempts: 1, updatedAt: "2026-06-10 12:00:00" }], // older
    ]);
    const picked = pickNextDataset([ds("dsA"), ds("dsB")], jobInfo, opts);
    expect(picked?.id).toBe("dsB");
  });

  test("empty candidates -> null", () => {
    expect(pickNextDataset([], new Map(), opts)).toBeNull();
  });
});

describe("triggerOpenNeuroOnboard (injected fetch, real Response)", () => {
  test("POSTs the onboard-openneuro repository_dispatch with the ids", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await triggerOpenNeuroOnboard("ds007964", "tok123", fetchImpl);

    expect(captured).not.toBeNull();
    const cap = captured as unknown as { url: string; init: RequestInit };
    expect(cap.url).toMatch(/\/repos\/nemarDatasets\/\.github\/dispatches$/);
    expect(cap.init.method).toBe("POST");
    expect((cap.init.headers as Record<string, string>).Authorization).toBe("Bearer tok123");
    const body = JSON.parse(cap.init.body as string);
    expect(body.event_type).toBe("onboard-openneuro");
    expect(body.client_payload.openneuro_ids).toBe("ds007964");
  });

  test("non-2xx throws", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    await expect(triggerOpenNeuroOnboard("ds1", "tok", fetchImpl)).rejects.toThrow(/HTTP 403/);
  });
});

describe("AUTO_IMPORT_GATE_QUERY against a real audit_log", () => {
  // Regression guard: the column is `timestamp` (migration 0001), not
  // `created_at` -- the wrong name made the gate query throw and the tick never
  // fire. Run the real query against the real audit_log shape.
  test("reads the latest auto_import_dispatch timestamp and feeds the gate", () => {
    const db = new Database(":memory:");
    db.run(
      "CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL DEFAULT (datetime('now')), user_id INTEGER, action TEXT NOT NULL, resource_type TEXT, resource_id TEXT, details TEXT, ip_address TEXT)",
    );
    db.run(
      "INSERT INTO audit_log (timestamp, action, resource_id) VALUES ('2026-06-17 10:00:00','auto_import_dispatch','ds1'), ('2026-06-17 11:00:00','other','x')",
    );
    const row = db.query(AUTO_IMPORT_GATE_QUERY).get() as { timestamp: string } | null;
    expect(row?.timestamp).toBe("2026-06-17 10:00:00"); // the dispatch row, not 'other'
    const gate = decideAutoImportGate({
      lastDispatchAt: row?.timestamp ?? null,
      now: Date.parse("2026-06-17T12:00:00Z"),
      minIntervalMs: GATE_MS,
    });
    expect(gate.proceed).toBe(true); // 120 min elapsed >= 25 min gate
  });
});

describe("migration 0047: import_jobs.auto_attempts", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    const m = (n: string) =>
      readFileSync(join(import.meta.dir, "..", "src/db/migrations", n), "utf8");
    db.exec(m("0044_import_jobs.sql"));
    db.exec(m("0047_import_jobs_auto_attempts.sql"));
  });

  test("column defaults 0 and increments", () => {
    db.run(
      "INSERT INTO import_jobs (dataset_id, source, source_id, status) VALUES ('on1','openneuro','ds1','failed')",
    );
    const before = db
      .query("SELECT auto_attempts FROM import_jobs WHERE dataset_id='on1'")
      .get() as {
      auto_attempts: number;
    };
    expect(before.auto_attempts).toBe(0);
    db.run("UPDATE import_jobs SET auto_attempts = auto_attempts + 1 WHERE dataset_id='on1'");
    const after = db
      .query("SELECT auto_attempts FROM import_jobs WHERE dataset_id='on1'")
      .get() as {
      auto_attempts: number;
    };
    expect(after.auto_attempts).toBe(1);
  });
});
