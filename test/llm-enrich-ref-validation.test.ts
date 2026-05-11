/**
 * Unit tests for validateEnrichmentRef (epic #417 phase 1).
 *
 * The ref parameter is interpolated into GitHub API URL fragments and into
 * the shell payload emitted by llm-enrichment.yml. The character allowlist
 * + traversal/leading-slash guards are security-adjacent, so we pin the
 * accept/reject matrix as a table-driven test.
 */

import { describe, expect, test } from "bun:test";
import { validateEnrichmentRef } from "../backend/src/routes/webhooks";

describe("validateEnrichmentRef", () => {
  test("returns null when the field is absent (back-compat)", () => {
    expect(validateEnrichmentRef(undefined)).toBeNull();
  });

  describe("accepts", () => {
    const accepted = [
      "main",
      "release/v1.0.0",
      "release/v10.20.30-rc1",
      "v1.2.3",
      "v0.0.0-dev",
      "feat/my_branch",
      "feat/my-branch.with.dots",
      "a", // single char
      "a".repeat(200), // boundary length
    ];
    for (const ref of accepted) {
      test(`ref="${ref.length > 30 ? `${ref.slice(0, 27)}...` : ref}"`, () => {
        expect(validateEnrichmentRef(ref)).toBeNull();
      });
    }
  });

  describe("rejects", () => {
    const rejected: Array<[unknown, string, string]> = [
      [null, "json null", "must be a non-empty string"],
      [123, "non-string number", "must be a non-empty string"],
      [true, "non-string boolean", "must be a non-empty string"],
      [{}, "object", "must be a non-empty string"],
      ["", "empty string", "must be a non-empty string"],
      ["a".repeat(201), "over 200 chars", "must be a non-empty string"],
      ["../main", "path traversal", "forbidden characters"],
      ["main..evil", "embedded double-dot", "forbidden characters"],
      ["/main", "leading slash", "forbidden characters"],
      ["main with space", "space character", "forbidden characters"],
      ["main\nrelease", "embedded newline", "forbidden characters"],
      ["main\x00null", "null byte", "forbidden characters"],
      ["main\t", "tab", "forbidden characters"],
      ['main"', "double quote", "forbidden characters"],
      ["main'", "single quote", "forbidden characters"],
      ["main$x", "dollar sign", "forbidden characters"],
      ["main;rm -rf /", "shell metacharacters", "forbidden characters"],
      ["main`whoami`", "backticks", "forbidden characters"],
      ["main|pipe", "pipe", "forbidden characters"],
      ["main&background", "ampersand", "forbidden characters"],
      ["main?query", "question mark", "forbidden characters"],
      ["main#fragment", "hash", "forbidden characters"],
      ["main\\backslash", "backslash", "forbidden characters"],
      ["main:colon", "colon", "forbidden characters"],
      ["heads/main", "ok", null as unknown as string], // expected to pass; placeholder filtered out below
    ];
    for (const [value, label, expectedFragment] of rejected) {
      if (expectedFragment === null) continue;
      test(`rejects ${label}`, () => {
        const err = validateEnrichmentRef(value);
        expect(err).not.toBeNull();
        expect(err).toContain(expectedFragment);
      });
    }
  });

  test("accepts heads/main (slash with no leading slash and no '..')", () => {
    // Sanity case: nested ref paths are allowed; only leading / and '..' are
    // blocked. GitHub refspecs like refs/heads/main are not currently passed
    // here, but the predicate stays permissive for namespaced refs.
    expect(validateEnrichmentRef("heads/main")).toBeNull();
  });

  test("error messages distinguish type/length failures from character failures", () => {
    expect(validateEnrichmentRef("")).toContain("non-empty string");
    expect(validateEnrichmentRef("../x")).toContain("forbidden characters");
  });
});
