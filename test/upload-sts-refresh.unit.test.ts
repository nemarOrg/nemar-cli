/**
 * S3 copy across STS credential windows (upload credentials are capped at
 * 2 h). A long copy is batched; the lease is renewed before it runs out, and
 * a batch that dies of expiry is retried with fresh credentials instead of
 * failing the upload.
 */

import { describe, expect, test } from "bun:test";
import type { S3Credentials } from "../src/lib/git-annex/s3-remote";
import {
  type CopyBatchFn,
  type CredentialLease,
  copyWithCredentialRefresh,
  isExpiredCredentialError,
  leaseFromResponse,
  planCopyBatches,
} from "../src/lib/upload/s3-copy-session";

const MIN = 60 * 1000;

function creds(tag: string): S3Credentials {
  return { accessKeyId: `AKIA${tag}`, secretAccessKey: "s", sessionToken: `tok-${tag}` };
}

/** A fake clock plus a lease factory issuing 2 h leases tagged 1, 2, 3, ... */
function harness(startMs = 0) {
  let t = startMs;
  let issued = 0;
  const now = () => t;
  const advance = (ms: number) => {
    t += ms;
  };
  const lease = (): CredentialLease => {
    issued++;
    return { credentials: creds(String(issued)), expiresAtMs: t + 120 * MIN };
  };
  return {
    now,
    advance,
    lease,
    renewLease: async () => lease(),
    get issued() {
      return issued;
    },
  };
}

describe("planCopyBatches", () => {
  test("bounds batches by file count and by bytes, preserving order", () => {
    const paths = ["a", "b", "c", "d", "e"];
    const sizes = new Map([
      ["a", 10],
      ["b", 10],
      ["c", 50],
      ["d", 10],
      ["e", 10],
    ]);
    expect(planCopyBatches(paths, sizes, { maxFiles: 2, maxBytes: 1000 })).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"],
    ]);
    expect(planCopyBatches(paths, sizes, { maxFiles: 10, maxBytes: 30 })).toEqual([
      ["a", "b"],
      ["c"],
      ["d", "e"],
    ]);
  });

  test("an empty list makes no batches", () => {
    expect(planCopyBatches([], new Map())).toEqual([]);
  });
});

describe("isExpiredCredentialError", () => {
  test("recognises the STS/S3 expiry wording", () => {
    expect(
      isExpiredCredentialError("S3 error: ExpiredToken: The provided token has expired."),
    ).toBe(true);
    expect(isExpiredCredentialError("RequestExpired")).toBe(true);
    expect(isExpiredCredentialError("The security token included in the request is expired")).toBe(
      true,
    );
    expect(isExpiredCredentialError("EntityTooLarge")).toBe(false);
    expect(isExpiredCredentialError(undefined)).toBe(false);
  });
});

describe("leaseFromResponse", () => {
  test("uses the server's expiration", () => {
    const l = leaseFromResponse(creds("x"), "2026-10-07T12:00:00Z", 0);
    expect(l.expiresAtMs).toBe(Date.parse("2026-10-07T12:00:00Z"));
  });

  test("a missing or bad expiration is treated conservatively (55 min)", () => {
    expect(leaseFromResponse(creds("x"), undefined, 1000).expiresAtMs).toBe(1000 + 55 * MIN);
    expect(leaseFromResponse(creds("x"), "soon", 1000).expiresAtMs).toBe(1000 + 55 * MIN);
  });
});

describe("copyWithCredentialRefresh", () => {
  test("a 3-hour copy renews the lease instead of dying at 2 h", async () => {
    const h = harness();
    const usedTokens: string[] = [];
    // Each batch takes 30 minutes and is killed at its deadline, like the real copy.
    const copyBatch: CopyBatchFn = async (paths, c, { deadlineMs }) => {
      usedTokens.push(c.sessionToken ?? "");
      if (h.now() + 30 * MIN > deadlineMs) {
        h.advance(deadlineMs - h.now());
        return { success: false, filesCopied: 0, timedOut: true, error: "Copy deadline reached" };
      }
      h.advance(30 * MIN);
      return { success: true, filesCopied: paths.length };
    };
    const paths = Array.from({ length: 6 }, (_, i) => `sub-${i}.edf`);
    const res = await copyWithCredentialRefresh({
      paths,
      sizes: new Map(paths.map((p) => [p, 1])),
      initialLease: h.lease(),
      renewLease: h.renewLease,
      copyBatch,
      now: h.now,
      batchMaxFiles: 1,
    });
    expect(res.success).toBe(true);
    expect(res.filesCopied).toBe(6);
    // Renewed once, before the batch that would have outrun the first lease;
    // no batch was ever killed at a deadline.
    expect(res.refreshes).toBe(1);
    expect(usedTokens).toEqual(["tok-1", "tok-1", "tok-1", "tok-2", "tok-2", "tok-2"]);
  });

  test("a batch that fails with ExpiredToken is retried with fresh credentials", async () => {
    const h = harness();
    let calls = 0;
    const copyBatch: CopyBatchFn = async (paths, c) => {
      calls++;
      if (c.sessionToken === "tok-1") {
        return {
          success: false,
          filesCopied: 1,
          error: "sub-2.edf: S3 error: ExpiredToken: The provided token has expired.",
        };
      }
      return { success: true, filesCopied: paths.length - 1 };
    };
    const res = await copyWithCredentialRefresh({
      paths: ["sub-1.edf", "sub-2.edf"],
      sizes: new Map(),
      initialLease: h.lease(),
      renewLease: h.renewLease,
      copyBatch,
      now: h.now,
    });
    expect(res).toMatchObject({ success: true, refreshes: 1, filesCopied: 2 });
    expect(calls).toBe(2);
  });

  test("a batch killed at the credential deadline is retried after renewal", async () => {
    const h = harness();
    const copyBatch: CopyBatchFn = async (paths, c, { deadlineMs }) => {
      if (c.sessionToken === "tok-1") {
        h.advance(deadlineMs - h.now());
        return { success: false, filesCopied: 3, timedOut: true, error: "Copy deadline reached" };
      }
      return { success: true, filesCopied: paths.length - 3 };
    };
    const paths = ["a", "b", "c", "d", "e"];
    const res = await copyWithCredentialRefresh({
      paths,
      sizes: new Map(),
      initialLease: h.lease(),
      renewLease: h.renewLease,
      copyBatch,
      now: h.now,
    });
    expect(res).toMatchObject({ success: true, refreshes: 1, filesCopied: 5 });
  });

  test("a non-credential failure is returned without renewing", async () => {
    const h = harness();
    const res = await copyWithCredentialRefresh({
      paths: ["a"],
      sizes: new Map(),
      initialLease: h.lease(),
      renewLease: h.renewLease,
      copyBatch: async () => ({ success: false, filesCopied: 0, error: "EntityTooLarge" }),
      now: h.now,
    });
    expect(res).toMatchObject({ success: false, error: "EntityTooLarge", refreshes: 0 });
    expect(h.issued).toBe(1);
  });

  test("renewals that never make progress stop instead of looping", async () => {
    const h = harness();
    const res = await copyWithCredentialRefresh({
      paths: ["a"],
      sizes: new Map(),
      initialLease: h.lease(),
      renewLease: h.renewLease,
      copyBatch: async () => ({ success: false, filesCopied: 0, error: "ExpiredToken" }),
      now: h.now,
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("no progress");
    expect(res.refreshes).toBe(2);
  });

  test("a renewal failure is reported with its cause", async () => {
    const h = harness();
    const res = await copyWithCredentialRefresh({
      paths: ["a"],
      sizes: new Map(),
      initialLease: { credentials: creds("old"), expiresAtMs: 5 * MIN },
      renewLease: async () => {
        throw new Error("401 Not authenticated");
      },
      copyBatch: async () => ({ success: true, filesCopied: 1 }),
      now: h.now,
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("Could not renew upload credentials");
    expect(res.error).toContain("401 Not authenticated");
  });
});

describe("copyPathsToAnnexRemote deadline", () => {
  test("a deadline already passed returns timedOut without starting git-annex", async () => {
    const { copyPathsToAnnexRemote } = await import("../src/lib/git-annex/transfer");
    const res = await copyPathsToAnnexRemote(
      "/nonexistent-repo",
      "nemar-s3",
      ["a.edf"],
      1,
      undefined,
      {
        deadlineMs: 1000,
        now: () => 2000,
      },
    );
    expect(res).toEqual({
      success: false,
      error: "Copy deadline reached",
      filesCopied: 0,
      timedOut: true,
    });
  });
});
