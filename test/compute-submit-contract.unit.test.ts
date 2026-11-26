/**
 * The shared contract of a person's job submission (epic #2021 phase D3, #2024): the bundle caps the
 * command-line interface and the Worker both read, the one manifest rule, and the words and sentences
 * of the routes. Pure: nothing here reaches a network or a database.
 */

import { describe, expect, test } from "bun:test";
import {
  COMPUTE_REFUSAL_CODES,
  COMPUTE_REFUSAL_STATUS,
  COMPUTE_ROUTE_SENTENCES,
} from "../shared/compute-state";
import { DEFAULT_COMPUTE_POLICY } from "../shared/contract/compute";
import {
  BUNDLE_ARCHIVE_FILE,
  BUNDLE_BODY_MAX_BYTES,
  BUNDLE_DEFAULT_LIMITS,
  BUNDLE_MAX_FILES,
  BUNDLE_MAX_FILE_BYTES,
  BUNDLE_MAX_TOTAL_BYTES,
  BUNDLE_PATH_MAX,
  checkBundleManifest,
} from "../shared/contract/compute-bundle";
import {
  COMPUTE_SUBMIT_KEY_RE,
  COMPUTE_SUBMIT_SENTENCES,
  submitRefusal,
} from "../shared/contract/compute-submit";
import {
  BundleManifestSchema,
  ComputeSubmitRequestSchema,
} from "../shared/contract/compute-submit-request";

const sha = "a".repeat(64);
const file = (path: string, size = 10) => ({ path, size, sha256: sha });

describe("the caps", () => {
  test("are the numbers the issue fixes, and the owner policy's defaults are the same numbers", () => {
    expect(BUNDLE_MAX_TOTAL_BYTES).toBe(100 * 1024 * 1024);
    expect(BUNDLE_MAX_FILES).toBe(2000);
    expect(BUNDLE_MAX_FILE_BYTES).toBe(25 * 1024 * 1024);
    expect(BUNDLE_PATH_MAX).toBe(240);
    expect(BUNDLE_ARCHIVE_FILE).toBe("bundle.tar.gz");
    expect({ ...BUNDLE_DEFAULT_LIMITS }).toEqual({ ...DEFAULT_COMPUTE_POLICY.bundleLimits });
  });

  test("the body bound holds a manifest at the file cap with the longest legal paths", () => {
    const entry = JSON.stringify(file("é".repeat(BUNDLE_PATH_MAX), Number.MAX_SAFE_INTEGER));
    expect(new TextEncoder().encode(entry).length * BUNDLE_MAX_FILES).toBeLessThan(
      BUNDLE_BODY_MAX_BYTES - 64 * 1024,
    );
  });
});

describe("checkBundleManifest: the first failure is the answer", () => {
  test("a clean manifest passes, with or without an entry", () => {
    expect(checkBundleManifest([file("run.py"), file("lib/a.py")])).toEqual({ ok: true });
    expect(checkBundleManifest([file("run.py")], BUNDLE_DEFAULT_LIMITS, "run.py")).toEqual({
      ok: true,
    });
  });

  const cases: Array<[string, unknown, string, string | undefined]> = [
    ["not a list", {}, "invalid_spec", "files"],
    ["empty", [], "invalid_spec", "files"],
    ["not an object", ["x"], "invalid_spec", "files.0"],
    ["an unknown key", [{ ...file("a"), mode: 1 }], "invalid_spec", "files.0"],
    ["an absolute path", [file("/etc/passwd")], "invalid_spec", "files.0.path"],
    ["a dot-dot segment", [file("a/../b")], "invalid_spec", "files.0.path"],
    ["a backslash", [file("a\\b")], "invalid_spec", "files.0.path"],
    [
      "a path over the cap",
      [file("a".repeat(BUNDLE_PATH_MAX + 1))],
      "invalid_spec",
      "files.0.path",
    ],
    ["a duplicate path", [file("a"), file("a")], "invalid_spec", "files.1.path"],
    ["a negative size", [file("a", -1)], "invalid_spec", "files.0.size"],
    ["a fractional size", [file("a", 1.5)], "invalid_spec", "files.0.size"],
    [
      "an upper-case digest",
      [{ path: "a", size: 1, sha256: sha.toUpperCase() }],
      "invalid_spec",
      "files.0.sha256",
    ],
    ["a file over its cap", [file("a", BUNDLE_MAX_FILE_BYTES + 1)], "bundle_too_large", undefined],
  ];
  for (const [name, input, code, field] of cases) {
    test(name, () => {
      const verdict = checkBundleManifest(input);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.code).toBe(code as never);
        if (field !== undefined) expect("field" in verdict && verdict.field).toBe(field);
      }
    });
  }

  test("the running total is the cap, and one byte over is refused", () => {
    const limits = { maxTotalBytes: 100, maxFiles: 10, maxFileBytes: 60 };
    expect(checkBundleManifest([file("a", 60), file("b", 40)], limits)).toEqual({ ok: true });
    expect(checkBundleManifest([file("a", 60), file("b", 41)], limits)).toEqual({
      ok: false,
      code: "bundle_too_large",
    });
  });

  test("too many files is reported before a bad path inside them", () => {
    const limits = { maxTotalBytes: 100, maxFiles: 2, maxFileBytes: 60 };
    expect(checkBundleManifest([file("a"), file("b"), file("/bad")], limits)).toEqual({
      ok: false,
      code: "bundle_too_many_files",
    });
  });

  test("a bad path is reported before an entry that is missing", () => {
    expect(checkBundleManifest([file("/bad")], BUNDLE_DEFAULT_LIMITS, "run.py")).toMatchObject({
      code: "invalid_spec",
    });
    expect(checkBundleManifest([file("a")], BUNDLE_DEFAULT_LIMITS, "run.py")).toEqual({
      ok: false,
      code: "entry_not_in_bundle",
    });
  });

  test("a refusal never holds a path or a value", () => {
    const verdict = checkBundleManifest([file("secret-name/../x")]);
    expect(JSON.stringify(verdict)).not.toContain("secret-name");
  });
});

describe("the schemas", () => {
  test("the manifest schema is closed and the request is closed", () => {
    expect(BundleManifestSchema.safeParse({ files: [file("a")] }).success).toBe(true);
    expect(BundleManifestSchema.safeParse({ files: [file("a")], extra: 1 }).success).toBe(false);
    expect(ComputeSubmitRequestSchema.safeParse({ spec: {}, extra: 1 }).success).toBe(false);
  });

  test("an idempotency key is 8 to 128 of the allowed characters", () => {
    expect(COMPUTE_SUBMIT_KEY_RE.test("a1b2c3d4")).toBe(true);
    expect(COMPUTE_SUBMIT_KEY_RE.test("short")).toBe(false);
    expect(COMPUTE_SUBMIT_KEY_RE.test("has space in it")).toBe(false);
    expect(COMPUTE_SUBMIT_KEY_RE.test("a".repeat(129))).toBe(false);
  });
});

describe("the words", () => {
  test("every sentence belongs to a refusal word with a status, and the new words are all declared", () => {
    for (const code of Object.keys(COMPUTE_SUBMIT_SENTENCES)) {
      expect(COMPUTE_REFUSAL_CODES as readonly string[]).toContain(code);
      expect(COMPUTE_REFUSAL_STATUS[code as keyof typeof COMPUTE_REFUSAL_STATUS]).toBeGreaterThan(
        399,
      );
    }
    for (const code of Object.keys(COMPUTE_ROUTE_SENTENCES)) {
      expect(COMPUTE_SUBMIT_SENTENCES[code as keyof typeof COMPUTE_SUBMIT_SENTENCES]).toBe(
        COMPUTE_ROUTE_SENTENCES[code as keyof typeof COMPUTE_ROUTE_SENTENCES],
      );
    }
    for (const code of [
      "entry_not_in_bundle",
      "bundle_incomplete",
      "idempotency_conflict",
      "logs_not_available",
      "upload_expired",
      "version_not_found",
      "version_untagged",
      "too_many_files",
      "storage_unavailable",
    ]) {
      expect(COMPUTE_REFUSAL_CODES as readonly string[]).toContain(code);
    }
  });

  test("the statuses the issue names", () => {
    expect(submitRefusal("idempotency_conflict").status).toBe(422);
    expect(submitRefusal("bundle_incomplete").status).toBe(409);
    expect(submitRefusal("logs_not_available").status).toBe(404);
    expect(submitRefusal("results_expired").status).toBe(410);
    expect(submitRefusal("no_compute_access").status).toBe(403);
    expect(submitRefusal("suspended").status).toBe(403);
  });

  test("the balance sentence says to ask an administrator and promises no refund", () => {
    const sentence = COMPUTE_SUBMIT_SENTENCES.insufficient_balance;
    expect(sentence).toContain("administrator");
    expect(sentence.toLowerCase()).not.toContain("refund");
  });
});
