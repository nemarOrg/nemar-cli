/**
 * The switch and cap readers of the automatic re-pull (epic #1046 phase 7, #1913; ADR 0111).
 * Pure functions, so the whole cross product is enumerated rather than sampled: an environment
 * that is not exactly `production` must read off whatever the switches say.
 */

import { describe, expect, test } from "bun:test";
import {
  REPULL_CAP_MAX,
  REPULL_MERGE_CAP_DEFAULT,
  REPULL_OPEN_CAP_DEFAULT,
  autoRepullEnabled,
  autoRepullMergeEnabled,
  isExactProduction,
  readCap,
  repullMergeCap,
  repullOpenCap,
  repullSwitchesReport,
} from "../src/services/repull-switches";
import type { Bindings } from "../src/types/bindings";

type E = Pick<
  Bindings,
  | "ENVIRONMENT"
  | "AUTO_REPULL_ENABLED"
  | "AUTO_REPULL_MERGE_ENABLED"
  | "REPULL_DAILY_OPEN_CAP"
  | "REPULL_DAILY_MERGE_CAP"
>;

const ENVIRONMENTS = [
  "production",
  "Production",
  " production",
  "production ",
  "PRODUCTION",
  "staging",
  "development",
  "test",
  "",
  undefined,
] as const;
const SWITCH_VALUES = ["1", "true", "0", " 1", "1 ", "1\n", "yes", "", undefined] as const;

const env = (o: Record<string, string | undefined>): E => o as unknown as E;

describe("isExactProduction", () => {
  test("only the exact string production", () => {
    for (const environment of ENVIRONMENTS) {
      expect([environment, isExactProduction(env({ ENVIRONMENT: environment }))]).toEqual([
        environment,
        environment === "production",
      ]);
    }
  });
});

describe("the open switch", () => {
  test("on only for exact production and the exact string 1", () => {
    for (const environment of ENVIRONMENTS) {
      for (const value of SWITCH_VALUES) {
        const got = autoRepullEnabled(
          env({ ENVIRONMENT: environment, AUTO_REPULL_ENABLED: value }),
        );
        expect([environment, value, got]).toEqual([
          environment,
          value,
          environment === "production" && value === "1",
        ]);
      }
    }
  });
});

describe("the merge switch", () => {
  test("needs the open switch, the merge switch and exact production, all three", () => {
    for (const environment of ENVIRONMENTS) {
      for (const open of SWITCH_VALUES) {
        for (const merge of SWITCH_VALUES) {
          const got = autoRepullMergeEnabled(
            env({
              ENVIRONMENT: environment,
              AUTO_REPULL_ENABLED: open,
              AUTO_REPULL_MERGE_ENABLED: merge,
            }),
          );
          expect([environment, open, merge, got]).toEqual([
            environment,
            open,
            merge,
            environment === "production" && open === "1" && merge === "1",
          ]);
        }
      }
    }
  });

  test("the merge switch alone does nothing", () => {
    expect(
      autoRepullMergeEnabled(env({ ENVIRONMENT: "production", AUTO_REPULL_MERGE_ENABLED: "1" })),
    ).toBe(false);
  });
});

describe("caps", () => {
  test("absent takes the fallback", () => {
    expect(readCap(undefined, 7)).toEqual({ value: 7, source: "default" });
    expect(repullOpenCap(env({}))).toEqual({ value: REPULL_OPEN_CAP_DEFAULT, source: "default" });
    expect(REPULL_OPEN_CAP_DEFAULT).toBe(2);
  });

  test("whole numbers from 0 to the maximum are read as set", () => {
    for (const [raw, value] of [
      ["0", 0],
      ["5", 5],
      ["05", 5],
      ["10", 10],
      [String(REPULL_CAP_MAX), REPULL_CAP_MAX],
    ] as const) {
      expect([raw, repullOpenCap(env({ REPULL_DAILY_OPEN_CAP: raw }))]).toEqual([
        raw,
        { value, source: "set" },
      ]);
    }
    expect(REPULL_CAP_MAX).toBe(20);
  });

  test("anything else reads 0 and is unreadable, never the default", () => {
    for (const raw of [
      "5\n",
      "\n5",
      "5\t",
      "1\n2",
      "005",
      "000",
      "21",
      "99",
      "100",
      "2.5",
      "-1",
      "+2",
      "",
      " 2",
      "2 ",
      "two",
      "1e1",
      "0x5",
      "١",
    ]) {
      expect([raw, repullOpenCap(env({ REPULL_DAILY_OPEN_CAP: raw }))]).toEqual([
        raw,
        { value: 0, source: "unreadable" },
      ]);
    }
  });
});

describe("the merge cap", () => {
  test("reads through the same rule, with its own default", () => {
    expect(repullMergeCap(env({}))).toEqual({ value: REPULL_MERGE_CAP_DEFAULT, source: "default" });
    expect(REPULL_MERGE_CAP_DEFAULT).toBe(5);
    expect(repullMergeCap(env({ REPULL_DAILY_MERGE_CAP: "1" }))).toEqual({
      value: 1,
      source: "set",
    });
    expect(repullMergeCap(env({ REPULL_DAILY_MERGE_CAP: "5\n" }))).toEqual({
      value: 0,
      source: "unreadable",
    });
  });
});

describe("repullSwitchesReport", () => {
  const report = (o: Record<string, string | undefined>) => repullSwitchesReport(env(o));
  const shape = (
    production: boolean,
    open: boolean,
    merge: boolean,
    openCap: { value: number; source: string },
    mergeCap: { value: number; source: string },
  ) => ({
    environment_is_production: production,
    auto_repull_enabled: open,
    auto_repull_merge_enabled: merge,
    open_cap: openCap,
    merge_cap: mergeCap,
  });
  const defaults = {
    open: { value: 2, source: "default" },
    merge: { value: 5, source: "default" },
  };

  test("production with both switches on and both caps set", () => {
    expect(
      report({
        ENVIRONMENT: "production",
        AUTO_REPULL_ENABLED: "1",
        AUTO_REPULL_MERGE_ENABLED: "1",
        REPULL_DAILY_OPEN_CAP: "3",
        REPULL_DAILY_MERGE_CAP: "1",
      }),
    ).toEqual(shape(true, true, true, { value: 3, source: "set" }, { value: 1, source: "set" }));
  });

  test("production, open on, merge unset: merge reads off", () => {
    expect(report({ ENVIRONMENT: "production", AUTO_REPULL_ENABLED: "1" })).toEqual(
      shape(true, true, false, defaults.open, defaults.merge),
    );
  });

  test("production, merge on, open off: both read off", () => {
    expect(report({ ENVIRONMENT: "production", AUTO_REPULL_MERGE_ENABLED: "1" })).toEqual(
      shape(true, false, false, defaults.open, defaults.merge),
    );
  });

  test("production, open on, merge set to something that is not 1: merge reads off", () => {
    expect(
      report({
        ENVIRONMENT: "production",
        AUTO_REPULL_ENABLED: "1",
        AUTO_REPULL_MERGE_ENABLED: "true",
      }),
    ).toEqual(shape(true, true, false, defaults.open, defaults.merge));
  });

  test("production with everything unset", () => {
    expect(report({ ENVIRONMENT: "production" })).toEqual(
      shape(true, false, false, defaults.open, defaults.merge),
    );
  });

  test("outside production everything reads off, the caps as they were set", () => {
    expect(
      report({
        ENVIRONMENT: "development",
        AUTO_REPULL_ENABLED: "1",
        AUTO_REPULL_MERGE_ENABLED: "1",
        REPULL_DAILY_OPEN_CAP: "x",
        REPULL_DAILY_MERGE_CAP: "4",
      }),
    ).toEqual(
      shape(false, false, false, { value: 0, source: "unreadable" }, { value: 4, source: "set" }),
    );
  });

  test("an unreadable merge cap is reported unreadable beside a readable open cap", () => {
    expect(
      report({
        ENVIRONMENT: "production",
        REPULL_DAILY_OPEN_CAP: "2",
        REPULL_DAILY_MERGE_CAP: "21",
      }),
    ).toEqual(
      shape(true, false, false, { value: 2, source: "set" }, { value: 0, source: "unreadable" }),
    );
  });
});
