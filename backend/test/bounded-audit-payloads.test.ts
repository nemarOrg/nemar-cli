/**
 * Write-path bounds for audit and catalog payloads (#1189, fixes #1188).
 *
 * The D1 backup renders one INSERT per row and D1 refuses a statement over
 * ~100 KB on restore, so any row column that inlines a per-file list is a
 * row that can be written but never restored. These tests pin the three
 * write-path defenses, against the real schema (freshDb applies every
 * migration) with production SQL -- no mocks:
 *
 *  1. auditLogStatement bounds EVERY `details` payload (the shared
 *     marshaling in db/audit-log.ts) -- oversized ones become a small
 *     truncation marker.
 *  2. importVerifyAuditStatement writes the counts-and-pointer summary,
 *     never the integrity result's key arrays. Driven as a function rather
 *     than through POST /admin/imports/:id/verify because the route cannot
 *     be exercised past verifyDatasetVersionS3 without live AWS credentials
 *     (its S3 listing hardcodes a `*.s3.*.amazonaws.com` host; see
 *     imports-verify-route.test.ts, which documents the same constraint) --
 *     the route -> function call link is the uncovered residue, the same
 *     seam accepted for stampDatasetIntegrity.
 *  3. The zarr-ready callback stores a count + pointer in
 *     `zarr_data_failures`, driven through the REAL Hono handler.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { AUDIT_DETAILS_MAX_BYTES, auditLogStatement } from "../src/db/audit-log";
import { importVerifyAuditStatement } from "../src/routes/admin/imports";
import { registerZarrReadyRoutes } from "../src/routes/callbacks/zarr-ready";
import type { DatasetVersionIntegrityResult } from "../src/services/import-integrity";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

/**
 * Real constant-time comparison for the Workers-only
 * `crypto.subtle.timingSafeEqual` the zarr-ready handler's token check needs
 * (bun's runtime lacks it). Same non-mock platform shim as
 * zarr-pool-breaks.test.ts, guarded so whichever file loads first in the
 * shared bun test process installs it once; the wrong-token 401 there proves
 * the check stays live.
 */
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

const byteLength = (s: string) => new TextEncoder().encode(s).byteLength;

/** Synthetic annex keys shaped like production's (`SHA256E-s<size>--<hash>.<ext>`). */
function annexKeys(n: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    keys.push(`SHA256E-s${1000000 + i}--${String(i).padStart(8, "0").repeat(8)}.edf`);
  }
  return keys;
}

/** The production worst case (#1188): 12,397 missing keys, ~1.1 MB inlined. */
function worstCaseVerified(): DatasetVersionIntegrityResult {
  const missingKeys = annexKeys(12397);
  return {
    complete: false,
    missingKeys,
    zeroByteKeys: missingKeys.slice(0, 41),
    expectedCount: 12400,
    presentCount: 3,
    bytesPresent: 123456,
    declaredBytes: 987654321,
    declaredFiles: 12500,
    version: "2.0.0",
  };
}

let db: Database;

beforeEach(() => {
  db = freshDb();
});

function auditRow(): { user_id: number | null; action: string; details: string | null } {
  const row = db
    .query("SELECT user_id, action, resource_id, details FROM audit_log ORDER BY id DESC LIMIT 1")
    .get() as { user_id: number | null; action: string; details: string | null } | null;
  if (!row) throw new Error("no audit_log row inserted");
  return row;
}

describe("auditLogStatement details bound (#1189)", () => {
  test("an over-limit payload is stored as a small marker, not inlined", async () => {
    const oversized = "x".repeat(AUDIT_DETAILS_MAX_BYTES + 1); // exactly 1 byte over
    await auditLogStatement(realD1(db), {
      userId: null,
      action: "guard_probe",
      details: oversized,
    }).run();

    const stored = auditRow().details as string;
    expect(byteLength(stored)).toBeLessThan(AUDIT_DETAILS_MAX_BYTES);
    const marker = JSON.parse(stored);
    expect(marker.audit_details_truncated).toBe(true);
    expect(marker.original_bytes).toBe(AUDIT_DETAILS_MAX_BYTES + 1);
    expect(marker.head).toBe("x".repeat(2000));
  });

  test("a payload exactly at the limit passes through unchanged", async () => {
    const atLimit = "y".repeat(AUDIT_DETAILS_MAX_BYTES);
    await auditLogStatement(realD1(db), {
      userId: null,
      action: "guard_probe",
      details: atLimit,
    }).run();
    expect(auditRow().details).toBe(atLimit);
  });

  test("the bound is measured in UTF-8 bytes, not JS characters", async () => {
    // 2 bytes per char: under the limit in characters, over it in bytes. A
    // `.length` (UTF-16 chars) implementation would pass this through and
    // the stored row could still exceed the restore budget.
    const multibyte = "é".repeat(AUDIT_DETAILS_MAX_BYTES / 2 + 1);
    await auditLogStatement(realD1(db), {
      userId: null,
      action: "guard_probe",
      details: multibyte,
    }).run();
    const marker = JSON.parse(auditRow().details as string);
    expect(marker.audit_details_truncated).toBe(true);
    expect(marker.original_bytes).toBe(AUDIT_DETAILS_MAX_BYTES + 2);
  });

  test("null details stays null", async () => {
    await auditLogStatement(realD1(db), { userId: null, action: "guard_probe" }).run();
    expect(auditRow().details).toBeNull();
  });
});

describe("import verify audit write (#1189)", () => {
  test("stores counts and the availability-report pointer, never the key arrays", async () => {
    const verified = worstCaseVerified();
    // The fixture genuinely reaches the boundary the bound exists for.
    expect(byteLength(JSON.stringify(verified))).toBeGreaterThan(1_000_000);

    await importVerifyAuditStatement(realD1(db), 7, "on004952", verified).run();

    const row = db
      .query("SELECT user_id, action, resource_id, details FROM audit_log ORDER BY id DESC LIMIT 1")
      .get() as { user_id: number; action: string; resource_id: string; details: string };
    expect(row.user_id).toBe(7);
    expect(row.action).toBe("import_verify_forced");
    expect(row.resource_id).toBe("on004952");

    expect(byteLength(row.details)).toBeLessThan(1_000);
    // Independent literal expectation (not integrityAuditSummary(), which
    // would be circular): counts derived from the arrays, pointer to the
    // artifact that owns the per-path detail, scalars copied through.
    expect(JSON.parse(row.details)).toEqual({
      complete: false,
      expectedCount: 12400,
      presentCount: 3,
      bytesPresent: 123456,
      declaredBytes: 987654321,
      declaredFiles: 12500,
      version: "2.0.0",
      missing_count: 12397,
      zero_byte_count: 41,
      detail_ref: ".nemar/availability-report.json",
    });
    expect(row.details).not.toContain("missingKeys");
    expect(row.details).not.toContain("SHA256E-");
  });
});

describe("zarr-ready callback zarr_data_failures (#1189, real handler)", () => {
  const TOKEN = "bounded-payloads-webhook-token";
  const DATASET = "on007523";
  let app: Hono<{ Bindings: Bindings }>;

  function post(body: Record<string, unknown>): Promise<Response> {
    return app.request(
      "/zarr-ready",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Token": TOKEN },
        body: JSON.stringify(body),
      },
      { DB: realD1(db), NEMAR_WEBHOOK_TOKEN: TOKEN, ENVIRONMENT: "test" } as Bindings,
    );
  }

  const row = () =>
    db.query("SELECT * FROM datasets WHERE dataset_id = ?").get(DATASET) as Record<string, unknown>;

  beforeEach(() => {
    app = new Hono<{ Bindings: Bindings }>();
    registerZarrReadyRoutes(app);
    db.query(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('bapowner', 'bapowner@example.org', 'x', 'approved', 'user', 1)`,
    ).run();
    const owner = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='bapowner'")
      .get();
    if (!owner) throw new Error("seed: owner insert failed");
    db.query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility)
       VALUES (?, 'Bounded payloads fixture', ?, 'active', 'public')`,
    ).run(DATASET, owner.id);
  });

  /** The production worst case (#1188): 877 failure entries, 178 KB in one row. */
  function failures(n: number): { path: string; code: string; reason: string }[] {
    const out: { path: string; code: string; reason: string }[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        path: `sub-${String(i).padStart(4, "0")}/ses-01/eeg/sub-${String(i).padStart(4, "0")}_ses-01_task-rest_run-01_eeg.bdf`,
        code: "mixed_sample_rates",
        reason: "EDF/BDF channels declare differing sample rates (#737)",
      });
    }
    return out;
  }

  test("a failed run stores a count and pointer, independent of entry count", async () => {
    const df = failures(877);
    expect(byteLength(JSON.stringify(df))).toBeGreaterThan(95_000); // fixture reaches the boundary
    const res = await post({
      dataset_id: DATASET,
      status: "failed",
      errors: 900,
      failure_count: 877,
      deterministic: true,
      data_failures: df,
    });
    expect(res.status).toBe(200);

    const stored = row().zarr_data_failures as string;
    expect(byteLength(stored)).toBeLessThan(100);
    expect(JSON.parse(stored)).toEqual({ count: 877, detail_ref: "zarr/index.json" });
    expect(stored).not.toContain("sub-0000");
    expect(row().zarr_failure_count).toBe(877);
  });

  test("a partial ready run stores the summary and stamps zarr_failed_at", async () => {
    const res = await post({
      dataset_id: DATASET,
      status: "ready",
      store_count: 5,
      errors: 2,
      failure_count: 2,
      data_failures: failures(2),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(row().zarr_data_failures as string)).toEqual({
      count: 2,
      detail_ref: "zarr/index.json",
    });
    expect(row().zarr_failed_at).not.toBeNull();
  });

  test("a clean ready run still clears the failure detail", async () => {
    await post({ dataset_id: DATASET, status: "failed", errors: 3, data_failures: failures(3) });
    expect(row().zarr_data_failures).not.toBeNull();

    const res = await post({ dataset_id: DATASET, status: "ready", store_count: 9, errors: 0 });
    expect(res.status).toBe(200);
    expect(row().zarr_data_failures).toBeNull();
    expect(row().zarr_failed_at).toBeNull();
  });
});
