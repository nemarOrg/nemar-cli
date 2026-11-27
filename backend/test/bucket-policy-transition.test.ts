/**
 * Bucket-policy transitions and alerts over real policy documents (#2497,
 * ADR 0145).
 *
 * `markDatasetPublic` / `markDatasetPrivate` run unchanged through
 * `transitionDatasetVisibility` against the local S3 stand-in (reached through
 * `endpointUrl`), so every assertion reads the policy the stand-in actually
 * stored. The alerts run unchanged against bun:sqlite behind realD1 and the
 * local Resend stand-in; admin mail is opted in only inside `withFakeResend`.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type BucketPolicy,
  MAX_BUCKET_POLICY_BYTES,
  PUBLIC_ACCESS_SID,
  STAGING_PREFIX,
  buildMigratedPolicy,
  isDatasetPrivate,
  listPrivateDatasets,
  policyByteSize,
  prefixArn,
  removePrivateDataset,
} from "../src/services/bucket-policy";
import {
  BucketPolicyFullError,
  type PresignedUrlOptions,
  markDatasetPrivate,
  markDatasetPublic,
} from "../src/services/s3";
import {
  alertIfPolicyFull,
  notifyIfPolicyNearCap,
  notifyStoragePolicyAlert,
} from "../src/services/storage-policy-alert";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { type CapturedEmail, sendsTo, withFakeResend } from "./helpers/resend";
import { type S3ManifestStandin, startS3ManifestStandin } from "./helpers/s3-manifest-standin";

const BUCKET = "nemar";
const ADMIN_A = "storage-admin-a@example.org";
const ADMIN_B = "storage-admin-b@example.org";

let s3: S3ManifestStandin;
let db: Database;

function opts(): PresignedUrlOptions {
  return {
    bucket: BUCKET,
    region: "us-east-2",
    accessKeyId: "ASIASTANDINONLY00000",
    secretAccessKey: "standin-secret-never-real",
    endpointUrl: s3.url,
  };
}

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    DEV_ADMIN_NOTIFICATIONS: "1",
    DEV_EMAIL_ALLOWLIST: `${ADMIN_A},${ADMIN_B}`,
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
  } as Bindings;
}

function rawPolicy(entries: string[]): BucketPolicy {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: PUBLIC_ACCESS_SID,
        Effect: "Allow",
        Principal: "*",
        Action: "s3:GetObject",
        NotResource: entries.map((e) => prefixArn(BUCKET, e)),
      },
    ],
  };
}

function stored(): BucketPolicy {
  return s3.getBucketPolicy() as BucketPolicy;
}

function decade(prefix: string): string[] {
  return Array.from({ length: 10 }, (_, d) => `${prefix}${d}`);
}

function seedAdmin(email: string, prefs: Record<string, boolean> | null): void {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, email_preferences)
     VALUES (?, ?, 'x', 'approved', 'admin', 1, ?)`,
  ).run(email.split("@")[0] as string, email, prefs ? JSON.stringify(prefs) : null);
}

beforeEach(() => {
  s3 = startS3ManifestStandin();
  db = freshDb();
});

afterEach(() => {
  s3.stop();
});

describe("transitions over a wildcard policy, through the S3 stand-in", () => {
  test("making one id of a covered decade public leaves the other nine private", async () => {
    s3.setBucketPolicy(rawPolicy([STAGING_PREFIX, "nm00054?", "nm000111"]));
    await markDatasetPublic(opts(), "nm000543");
    const after = stored();
    expect(isDatasetPrivate(after, BUCKET, "nm000543")).toBe(false);
    for (const id of decade("nm00054").filter((i) => i !== "nm000543")) {
      expect(isDatasetPrivate(after, BUCKET, id)).toBe(true);
    }
    expect(isDatasetPrivate(after, BUCKET, "nm000111")).toBe(true);
    const arns = after.Statement.find((s) => s.Sid === PUBLIC_ACCESS_SID)?.NotResource as string[];
    expect(arns.some((a) => a.includes("?"))).toBe(false);
    expect(arns[0]).toBe(prefixArn(BUCKET, STAGING_PREFIX));
  });

  test("making it private again recompacts the decade and returns the written size", async () => {
    s3.setBucketPolicy(rawPolicy([STAGING_PREFIX, ...decade("nm00054").slice(0, 9)]));
    const bytes = await markDatasetPrivate(opts(), "nm000549");
    const arns = stored().Statement.find((s) => s.Sid === PUBLIC_ACCESS_SID)?.NotResource;
    expect(arns).toEqual([prefixArn(BUCKET, STAGING_PREFIX), prefixArn(BUCKET, "nm00054?")]);
    expect(bytes).toBe(policyByteSize(stored()));
    // Idempotent: nothing to write, so no size.
    expect(await markDatasetPrivate(opts(), "nm000545")).toBeNull();
  });

  test("a removal that would expand a hundred past the cap is refused before any write", async () => {
    // Pad with sparse ids (never sharing a decade) until one more expansion of
    // the hundred (17 entries) no longer fits.
    const pad: string[] = [];
    const build = () => rawPolicy([STAGING_PREFIX, "nm0005??", ...pad]);
    while (
      policyByteSize(removePrivateDataset(build(), BUCKET, "nm000543")) <= MAX_BUCKET_POLICY_BYTES
    ) {
      pad.push(`on${String(pad.length * 10).padStart(6, "0")}`);
    }
    expect(policyByteSize(build())).toBeLessThanOrEqual(MAX_BUCKET_POLICY_BYTES);
    s3.setBucketPolicy(build());
    const before = JSON.stringify(stored());
    let caught: unknown;
    try {
      await markDatasetPublic(opts(), "nm000543");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BucketPolicyFullError);
    expect((caught as Error).message).toContain("wildcard carve-out expands");
    expect(s3.log.some((r) => r.method === "PUT")).toBe(false);
    expect(JSON.stringify(stored())).toBe(before);
    expect(isDatasetPrivate(stored(), BUCKET, "nm000543")).toBe(true);

    // The caller's alert: the full condition is mailed.
    await withFakeResend(async (calls) => {
      seedAdmin(ADMIN_A, null);
      await alertIfPolicyFull(env(), caught);
      expect(sendsTo(calls, ADMIN_A).map((m) => m.subject)).toEqual([
        "[NEMAR] ALERT: bucket policy full, dataset creation refused",
      ]);
    });
  });
});

describe("the migration keeps opaque entries", () => {
  test("a hand-added ARN on the live statement survives the rewrite", () => {
    const foreign = `arn:aws:s3:::${BUCKET}/nm*/*`;
    const live = rawPolicy([STAGING_PREFIX, "nm000111"]);
    (live.Statement[0]?.NotResource as string[]).push(foreign);
    const next = buildMigratedPolicy(live, BUCKET, ["nm000111", "nm000222"], []);
    expect(next.Statement[0]?.NotResource).toContain(foreign);
    expect(listPrivateDatasets(next, BUCKET)).toEqual(["nm000111", "nm000222"]);
  });
});

function stampCount(key: string): number {
  return (
    db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'storage_policy_alert' AND resource_id = ?",
      )
      .get(key)?.n ?? -1
  );
}

function subjects(calls: CapturedEmail[], to: string): string[] {
  return sendsTo(calls, to).map((m) => m.subject);
}

describe("storage alerts: category, daily stamp, escalation", () => {
  test("routed by storage_alerts: an admin who opted out gets none, one who opted out of publication mail still does", async () => {
    seedAdmin(ADMIN_A, { storage_alerts: false });
    seedAdmin(ADMIN_B, { publication_request: false });
    await withFakeResend(async (calls) => {
      await notifyIfPolicyNearCap(env(), Math.ceil(MAX_BUCKET_POLICY_BYTES * 0.85));
      expect(subjects(calls, ADMIN_A)).toEqual([]);
      expect(subjects(calls, ADMIN_B)).toEqual(["[NEMAR] Bucket policy above 80% of its size cap"]);
    });
  });

  test("80% and 95% each mail once a day", async () => {
    seedAdmin(ADMIN_A, null);
    await withFakeResend(async (calls) => {
      for (let i = 0; i < 2; i++) {
        await notifyIfPolicyNearCap(env(), Math.ceil(MAX_BUCKET_POLICY_BYTES * 0.85));
        await notifyIfPolicyNearCap(env(), Math.ceil(MAX_BUCKET_POLICY_BYTES * 0.96));
      }
      await notifyIfPolicyNearCap(env(), Math.floor(MAX_BUCKET_POLICY_BYTES * 0.8));
      expect(subjects(calls, ADMIN_A)).toEqual([
        "[NEMAR] Bucket policy above 80% of its size cap",
        "[NEMAR] ALERT: bucket policy above 95% of its size cap",
      ]);
    });
    expect(stampCount("near_cap")).toBe(1);
    expect(stampCount("near_cap_95")).toBe(1);
  });

  test("a send that reaches nobody releases the stamp, so the next occurrence retries", async () => {
    seedAdmin(ADMIN_A, null);
    const alert = { condition: "full", bytes: 20_500, capBytes: MAX_BUCKET_POLICY_BYTES } as const;
    await withFakeResend(
      async (calls) => {
        expect(await notifyStoragePolicyAlert(env(), alert)).toBe(0);
        expect(subjects(calls, ADMIN_A)).toHaveLength(1);
      },
      { status: 500 },
    );
    expect(stampCount("full")).toBe(0);
    await withFakeResend(async (calls) => {
      expect(await notifyStoragePolicyAlert(env(), alert)).toBe(1);
      expect(await notifyStoragePolicyAlert(env(), alert)).toBe(0);
      expect(subjects(calls, ADMIN_A)).toHaveLength(1);
    });
    expect(stampCount("full")).toBe(1);
  });

  test("no recipients releases the stamp too", async () => {
    await withFakeResend(async () => {
      await notifyStoragePolicyAlert(env(), {
        condition: "full",
        bytes: 20_500,
        capBytes: MAX_BUCKET_POLICY_BYTES,
      });
    });
    expect(stampCount("full")).toBe(0);
  });
});
