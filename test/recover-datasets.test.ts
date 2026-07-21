/**
 * Unit tests for the pure helpers in src/lib/recover-datasets.ts (epic #967
 * phase 5, #972). Mirrors test/withdrawn-datasets.test.ts's coverage.
 */

import { describe, expect, test } from "bun:test";
import {
  type RecoverDatasetEntry,
  parseRecoverDatasets,
  resolveRecoverTargets,
} from "../src/lib/recover-datasets";
import { parseWithdrawnDatasets } from "../src/lib/withdrawn-datasets";

describe("parseRecoverDatasets", () => {
  const valid: unknown = [
    { dataset_id: "on002814", note: "upstream accessible" },
    { dataset_id: "on003190", note: "upstream accessible" },
  ];

  test("accepts a well-formed entry array", () => {
    const parsed = parseRecoverDatasets(valid);
    expect(parsed).toEqual(valid as RecoverDatasetEntry[]);
  });

  test("rejects a non-array payload", () => {
    expect(() => parseRecoverDatasets({ not: "an array" })).toThrow(/must be a JSON array/);
  });

  test("rejects a non-object entry", () => {
    expect(() => parseRecoverDatasets(["not an object"])).toThrow(/is not an object/);
  });

  test("rejects a malformed dataset_id", () => {
    const bad = [{ dataset_id: "ds002814", note: "x" }];
    expect(() => parseRecoverDatasets(bad)).toThrow(/is not valid/);
  });

  test("rejects a dataset_id outside the on###### shape (nm/xx not accepted)", () => {
    const bad = [{ dataset_id: "nm002814", note: "x" }];
    expect(() => parseRecoverDatasets(bad)).toThrow(/is not valid/);
  });

  test("rejects a missing/empty note", () => {
    const bad = [{ dataset_id: "on002814", note: "" }];
    expect(() => parseRecoverDatasets(bad)).toThrow(/note is required/);
  });

  test("the repo's checked-in recover-datasets file parses and validates", async () => {
    const raw = await Bun.file(`${import.meta.dir}/../scripts/recover-datasets.json`).json();
    const entries: RecoverDatasetEntry[] = parseRecoverDatasets(raw);

    // 45 unique ids total (issue #967).
    const ids = new Set(entries.map((e) => e.dataset_id));
    expect(ids.size).toBe(entries.length);
    expect(entries.length).toBe(45);

    // All on###### shaped (recover only targets OpenNeuro-imported mirrors).
    for (const id of ids) {
      expect(id).toMatch(/^on\d{6}$/);
    }
  });

  test("the 45 recover targets are disjoint from the 11 withdrawn datasets (45 + 11 = 56)", async () => {
    const recoverRaw = await Bun.file(`${import.meta.dir}/../scripts/recover-datasets.json`).json();
    const withdrawnRaw = await Bun.file(
      `${import.meta.dir}/../scripts/withdrawn-datasets.json`,
    ).json();

    const recoverEntries = parseRecoverDatasets(recoverRaw);
    const withdrawnEntries = parseWithdrawnDatasets(withdrawnRaw);

    const recoverIds = new Set(recoverEntries.map((e) => e.dataset_id));
    const withdrawnIds = new Set(withdrawnEntries.map((e) => e.dataset_id));

    expect(recoverIds.size).toBe(45);
    expect(withdrawnIds.size).toBe(11);
    expect(recoverIds.size + withdrawnIds.size).toBe(56);

    const overlap = [...recoverIds].filter((id) => withdrawnIds.has(id));
    expect(overlap).toEqual([]);
  });
});

describe("resolveRecoverTargets (not-on-list --force guard)", () => {
  const entries: RecoverDatasetEntry[] = [
    { dataset_id: "on002814", note: "upstream accessible" },
    { dataset_id: "on003190", note: "upstream accessible" },
  ];

  test("an id on the list resolves as a target", () => {
    const result = resolveRecoverTargets(["on002814"], entries, {});
    expect(result).toEqual({ targets: ["on002814"] });
  });

  test("multiple ids on the list all resolve", () => {
    const result = resolveRecoverTargets(["on002814", "on003190"], entries, {});
    expect(result).toEqual({ targets: ["on002814", "on003190"] });
  });

  test("an id NOT on the list is refused without --force", () => {
    const result = resolveRecoverTargets(["on999999"], entries, {});
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/not on the checked-in.*--force/);
  });

  test("an id NOT on the list is allowed with --force", () => {
    const result = resolveRecoverTargets(["on999999"], entries, { force: true });
    expect(result).toEqual({ targets: ["on999999"] });
  });

  test("multiple ids: the first failure short-circuits the rest", () => {
    const result = resolveRecoverTargets(["on002814", "on999999"], entries, {});
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toContain("on999999");
  });
});
