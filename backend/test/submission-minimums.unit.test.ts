/**
 * Deterministic submission minimums (#1087, ADR 0026).
 *
 * Pure-function tests: the route only fetches the two files and forwards
 * them, so the whole decision is exercised here without GitHub.
 */

import { describe, expect, test } from "bun:test";
import { MIN_NAME_LENGTH, evaluateSubmissionMinimums } from "../src/services/submission-minimums";
import { freshDb } from "./helpers/d1";

const GOOD_NAME = "Auditory cortex EEG during natural speech comprehension";

function desc(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Name: GOOD_NAME,
    BIDSVersion: "1.9.0",
    Authors: ["Ada Lovelace", "Grace Hopper"],
    EthicsApprovals: ["UCSD IRB #12345"],
    ...overrides,
  });
}

describe("evaluateSubmissionMinimums", () => {
  test("passes a complete description", () => {
    expect(evaluateSubmissionMinimums(desc(), null)).toEqual([]);
  });

  test("missing or malformed dataset_description.json is its own single reason", () => {
    expect(evaluateSubmissionMinimums(null, "readme")).toHaveLength(1);
    expect(evaluateSubmissionMinimums("not json{", null)).toHaveLength(1);
    expect(evaluateSubmissionMinimums("[1,2]", null)).toHaveLength(1);
  });

  test("rejects names under the floor, counting trimmed length", () => {
    const reasons = evaluateSubmissionMinimums(desc({ Name: `  ${"x".repeat(24)}  ` }), null);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(`${MIN_NAME_LENGTH} characters`);
    expect(reasons[0]).toContain("currently 24");
  });

  test("accepts a name exactly at the floor", () => {
    expect(evaluateSubmissionMinimums(desc({ Name: "y".repeat(MIN_NAME_LENGTH) }), null)).toEqual(
      [],
    );
  });

  test("rejects missing, empty, and placeholder-only author lists", () => {
    for (const authors of [
      undefined,
      [],
      ["", "   "],
      ["[Unspecified1]", "[Unspecified2]"], // the MOABB failure mode (#817)
      ["n/a", "TBD", "anonymous", "Unknown"],
      ["placeholder name"],
      "Ada Lovelace", // not an array
    ]) {
      const reasons = evaluateSubmissionMinimums(desc({ Authors: authors }), null);
      expect(reasons).toHaveLength(1);
      expect(reasons[0]).toContain("Authors");
    }
  });

  test("one real author among placeholders passes", () => {
    expect(
      evaluateSubmissionMinimums(desc({ Authors: ["[Unspecified1]", "Ada Lovelace"] }), null),
    ).toEqual([]);
  });

  test("does not flag real names that merely resemble sentinels", () => {
    // Substring matches must not fire: only whole-string sentinels count.
    expect(
      evaluateSubmissionMinimums(desc({ Authors: ["Nana Osei", "Todd Baker"] }), null),
    ).toEqual([]);
  });

  test("ethics satisfied by EthicsApprovals OR a README statement, else rejected", () => {
    const noEthics = desc({ EthicsApprovals: undefined });
    expect(evaluateSubmissionMinimums(noEthics, null)).toHaveLength(1);
    expect(evaluateSubmissionMinimums(desc({ EthicsApprovals: ["  "] }), null)).toHaveLength(1);
    for (const readme of [
      "Approved by the Institutional Review Board of UCSD.",
      "The local ethics committee approved the protocol.",
      "All participants gave informed consent.",
      "IRB protocol #99.",
      "Ethical clearance was obtained from XYZ University.",
      "This study was approved by the REB.",
      "HREC approval number 2020/123.",
      "The protocol received an ethics exemption.",
    ]) {
      expect(evaluateSubmissionMinimums(noEthics, readme)).toEqual([]);
    }
    expect(evaluateSubmissionMinimums(noEthics, "A resting-state EEG dataset.")).toHaveLength(1);
  });

  test("independent failures accumulate as separate stated reasons", () => {
    const reasons = evaluateSubmissionMinimums(
      desc({ Name: "EEG1", Authors: [], EthicsApprovals: [] }),
      null,
    );
    expect(reasons).toHaveLength(3);
  });
});

describe("migration 0068", () => {
  test("publication_requests has the min_requirements_reasons column", () => {
    const db = freshDb();
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(publication_requests)")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("min_requirements_reasons");
  });
});
