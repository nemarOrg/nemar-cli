/**
 * What a failed dataset lookup is allowed to be called
 * (`datasetLookupFailure`, src/commands/dataset.ts).
 *
 * `nemar dataset status <id>` and `nemar dataset clone <id>` both used to print
 * "Dataset not found" from a catch that never looked at the error, so an unreachable
 * backend was reported as a 404 -- the CLI asserting a fact about the dataset from a
 * request that never got an answer. Surfaced while fencing the test suite off from
 * production: with the backend unreachable the output read "Dataset not found",
 * immediately followed by "Network error: Could not connect".
 *
 * Pure, so the rule is checked without a subprocess or a backend. The two subprocess
 * cases that assert on a real 404 still need a live backend and are annotated as such
 * in test/cli.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { datasetLookupFailure } from "../src/commands/dataset";
import { ApiError } from "../src/lib/api/errors";

describe("only a real 404 is absence", () => {
  test("404 is the one status that may say not found", () => {
    expect(datasetLookupFailure(new ApiError(404, "Dataset nm099998 not found"))).toBe(
      "Dataset not found",
    );
  });

  test("a connection failure never claims the dataset does not exist", () => {
    // THE case. A thrown Error (not an ApiError) is what a DNS failure, a refused
    // connection, or an aborted socket looks like from here.
    const msg = datasetLookupFailure(new Error("Could not connect to http://127.0.0.1:1"));
    expect(msg).toBe("Could not reach the backend");
    expect(msg).not.toContain("not found");
  });

  test("a 5xx never claims the dataset does not exist", () => {
    for (const status of [500, 502, 503]) {
      const msg = datasetLookupFailure(new ApiError(status, "Internal error"));
      expect(msg).not.toContain("not found");
      expect(msg).toContain(String(status));
    }
  });

  test("403 is named as access, not absence", () => {
    // Different things to the person reading it, and the backend distinguishes them
    // deliberately: a private dataset that exists must not read as a typo.
    expect(datasetLookupFailure(new ApiError(403, "Forbidden"))).toBe("Dataset not accessible");
  });

  test("401 is neither absence nor access-to-this-dataset", () => {
    const msg = datasetLookupFailure(new ApiError(401, "Unauthorized"));
    expect(msg).not.toContain("not found");
    expect(msg).not.toContain("not accessible");
  });

  test("a non-Error throw still produces a sentence, not a crash", () => {
    // `throw "string"` and `throw undefined` are both legal, and this runs inside a
    // catch that then formats the value.
    expect(datasetLookupFailure("boom")).toBe("Could not reach the backend");
    expect(datasetLookupFailure(undefined)).toBe("Could not reach the backend");
  });
});
