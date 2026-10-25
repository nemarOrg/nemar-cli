/**
 * The switch and cap readers of the automatic re-pull (epic #1046 phase 7, #1913; ADR 0111).
 * Pure functions, so the whole cross product is enumerated rather than sampled: an environment
 * that is not exactly `production` must read off whatever the switches say.
 */

import { describe, expect, test } from "bun:test";
import {
  REPULL_CAP_MAX,
  REPULL_OPEN_CAP_DEFAULT,
  autoRepullEnabled,
  autoRepullMergeEnabled,
  isExactProduction,
  readCap,
  repullOpenCap,
  repullSwitchesReport,
} from "../src/services/repull-switches";
import type { Bindings } from "../src/types/bindings";

type E = Pick<
  Bindings,
  "ENVIRONMENT" | "AUTO_REPULL_ENABLED" | "AUTO_REPULL_MERGE_ENABLED" | "REPULL_DAILY_OPEN_CAP"
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
const SWITCH_VALUES = ["1", "true", "0", " 1", "1 ", "yes", "", undefined] as const;

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

describe("repullSwitchesReport", () => {
  test("carries the four facts and nothing else", () => {
    const report = repullSwitchesReport(
      env({
        ENVIRONMENT: "production",
        AUTO_REPULL_ENABLED: "1",
        AUTO_REPULL_MERGE_ENABLED: "1",
        REPULL_DAILY_OPEN_CAP: "3",
      }),
    );
    expect(report).toEqual({
      environment_is_production: true,
      auto_repull_enabled: true,
      auto_repull_merge_enabled: true,
      open_cap: { value: 3, source: "set" },
    });
  });

  test("outside production everything reads off, the cap included as it was set", () => {
    const report = repullSwitchesReport(
      env({
        ENVIRONMENT: "development",
        AUTO_REPULL_ENABLED: "1",
        AUTO_REPULL_MERGE_ENABLED: "1",
        REPULL_DAILY_OPEN_CAP: "x",
      }),
    );
    expect(report).toEqual({
      environment_is_production: false,
      auto_repull_enabled: false,
      auto_repull_merge_enabled: false,
      open_cap: { value: 0, source: "unreadable" },
    });
  });
});
