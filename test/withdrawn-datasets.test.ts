/**
 * Unit tests for the pure helpers in src/lib/withdrawn-datasets.ts (epic
 * #967 phase 4, #971). Mirrors test/exemplar-clone.test.ts's
 * parseExemplarFleet coverage.
 */

import { describe, expect, test } from "bun:test";
import {
  type WithdrawnDatasetEntry,
  parseWithdrawnDatasets,
  resolveWithdrawTargets,
} from "../src/lib/withdrawn-datasets";

describe("parseWithdrawnDatasets", () => {
  const valid: unknown = [
    { dataset_id: "on004148", reason: "upstream_403", note: "blocked upstream" },
    { dataset_id: "on005279", reason: "no_source", note: "no source found" },
  ];

  test("accepts a well-formed entry array", () => {
    const parsed = parseWithdrawnDatasets(valid);
    expect(parsed).toEqual(valid as WithdrawnDatasetEntry[]);
  });

  test("rejects a non-array payload", () => {
    expect(() => parseWithdrawnDatasets({ not: "an array" })).toThrow(/must be a JSON array/);
  });

  test("rejects a non-object entry", () => {
    expect(() => parseWithdrawnDatasets(["not an object"])).toThrow(/is not an object/);
  });

  test("rejects a malformed dataset_id", () => {
    const bad = [{ dataset_id: "ds007262", reason: "upstream_403", note: "x" }];
    expect(() => parseWithdrawnDatasets(bad)).toThrow(/is not valid/);
  });

  test("rejects a reason outside {upstream_403, no_source}", () => {
    const bad = [{ dataset_id: "on004148", reason: "dmca", note: "x" }];
    expect(() => parseWithdrawnDatasets(bad)).toThrow(/must be one of/);
  });

  test("rejects a missing/empty note", () => {
    const bad = [{ dataset_id: "on004148", reason: "upstream_403", note: "" }];
    expect(() => parseWithdrawnDatasets(bad)).toThrow(/note is required/);
  });

  test("the repo's checked-in withdrawn-datasets file parses and validates", async () => {
    const raw = await Bun.file(`${import.meta.dir}/../scripts/withdrawn-datasets.json`).json();
    const entries: WithdrawnDatasetEntry[] = parseWithdrawnDatasets(raw);

    // 11 unique ids total.
    const ids = new Set(entries.map((e) => e.dataset_id));
    expect(ids.size).toBe(entries.length);
    expect(entries.length).toBe(11);

    // Only the two documented reasons, with the exact 9/2 split from issue #967.
    const upstream403 = entries.filter((e) => e.reason === "upstream_403");
    const noSource = entries.filter((e) => e.reason === "no_source");
    expect(upstream403.length).toBe(9);
    expect(noSource.length).toBe(2);
    expect(upstream403.length + noSource.length).toBe(entries.length);

    expect(new Set(upstream403.map((e) => e.dataset_id))).toEqual(
      new Set([
        "on004148",
        "on007816",
        "on007987",
        "on008014",
        "on008017",
        "on008065",
        "on008092",
        "on008099",
        "on008115",
      ]),
    );
    expect(new Set(noSource.map((e) => e.dataset_id))).toEqual(new Set(["on005279", "on005516"]));
  });
});

describe("resolveWithdrawTargets (not-on-list --force guard)", () => {
  const entries: WithdrawnDatasetEntry[] = [
    { dataset_id: "on004148", reason: "upstream_403", note: "blocked upstream" },
    { dataset_id: "on005279", reason: "no_source", note: "no source found" },
  ];

  test("an id on the list resolves to its own reason", () => {
    const result = resolveWithdrawTargets(["on004148"], entries, {});
    expect(result).toEqual({ targets: [{ datasetId: "on004148", reason: "upstream_403" }] });
  });

  test("an explicit --reason overrides the list entry's reason", () => {
    const result = resolveWithdrawTargets(["on004148"], entries, { reason: "dmca" });
    expect(result).toEqual({ targets: [{ datasetId: "on004148", reason: "dmca" }] });
  });

  test("an id NOT on the list is refused without --force", () => {
    const result = resolveWithdrawTargets(["nm000132"], entries, {});
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/not on the checked-in.*--force/);
  });

  test("an id NOT on the list is allowed with --force + an explicit --reason", () => {
    const result = resolveWithdrawTargets(["nm000132"], entries, {
      force: true,
      reason: "upstream_403",
    });
    expect(result).toEqual({ targets: [{ datasetId: "nm000132", reason: "upstream_403" }] });
  });

  test("--force alone without --reason still fails (no default to fall back to)", () => {
    const result = resolveWithdrawTargets(["nm000132"], entries, { force: true });
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/no --reason given/);
  });

  test("multiple ids: the first failure short-circuits the rest", () => {
    const result = resolveWithdrawTargets(["on004148", "nm000132"], entries, {});
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("nm000132");
  });
});
