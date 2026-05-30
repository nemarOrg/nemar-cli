/**
 * Unit tests for the stale-dataset warning maths (#662).
 *
 * These guard the runway that replaced silent nm auto-deletion: a dataset must
 * cross each of 30/14/7/2/1 days exactly once, never warn outside the window,
 * and never produce a stage that would let the cron act before the deadline.
 */

import { describe, expect, test } from "bun:test";
import {
  FIRST_WARNING_DAYS,
  STALENESS_LIMIT_DAYS,
  WARNING_THRESHOLDS,
  ageInDays,
  daysUntilDeletion,
  deletionDate,
  warningStageForDaysLeft,
} from "../backend/src/services/staleness";

const MS_PER_DAY = 86_400_000;
const CREATED = "2026-01-01 12:00:00"; // SQLite UTC form
const CREATED_MS = Date.parse("2026-01-01T12:00:00Z");

/** `now` exactly `days` after CREATED. */
function nowAfter(days: number): Date {
  return new Date(CREATED_MS + days * MS_PER_DAY);
}

describe("ageInDays", () => {
  test("counts whole elapsed days", () => {
    expect(ageInDays(CREATED, nowAfter(0))).toBe(0);
    expect(ageInDays(CREATED, nowAfter(1))).toBe(1);
    expect(ageInDays(CREATED, nowAfter(90))).toBe(90);
  });

  test("floors partial days", () => {
    const now = new Date(CREATED_MS + 5 * MS_PER_DAY + 23 * 3_600_000);
    expect(ageInDays(CREATED, now)).toBe(5);
  });

  test("never negative for a future timestamp", () => {
    expect(ageInDays(CREATED, nowAfter(-10))).toBe(0);
  });

  test("returns 0 for an unparseable timestamp", () => {
    expect(ageInDays("not-a-date", nowAfter(50))).toBe(0);
  });
});

describe("daysUntilDeletion", () => {
  test("is LIMIT minus age", () => {
    expect(daysUntilDeletion(CREATED, nowAfter(60))).toBe(STALENESS_LIMIT_DAYS - 60);
    expect(daysUntilDeletion(CREATED, nowAfter(89))).toBe(1);
    expect(daysUntilDeletion(CREATED, nowAfter(90))).toBe(0);
    expect(daysUntilDeletion(CREATED, nowAfter(95))).toBe(-5);
  });
});

describe("warningStageForDaysLeft", () => {
  test("returns null outside the warning window", () => {
    expect(warningStageForDaysLeft(FIRST_WARNING_DAYS + 1)).toBeNull();
    expect(warningStageForDaysLeft(45)).toBeNull();
    expect(warningStageForDaysLeft(0)).toBeNull();
    expect(warningStageForDaysLeft(-3)).toBeNull();
  });

  test("returns the most-urgent threshold already crossed", () => {
    expect(warningStageForDaysLeft(30)).toBe(30);
    expect(warningStageForDaysLeft(20)).toBe(30);
    expect(warningStageForDaysLeft(14)).toBe(14);
    expect(warningStageForDaysLeft(10)).toBe(14);
    expect(warningStageForDaysLeft(7)).toBe(7);
    expect(warningStageForDaysLeft(5)).toBe(7);
    expect(warningStageForDaysLeft(2)).toBe(2);
    expect(warningStageForDaysLeft(1)).toBe(1);
  });

  test("only ever returns a declared threshold", () => {
    for (let d = 1; d <= FIRST_WARNING_DAYS; d++) {
      const stage = warningStageForDaysLeft(d);
      expect(stage).not.toBeNull();
      expect(WARNING_THRESHOLDS).toContain(stage as (typeof WARNING_THRESHOLDS)[number]);
    }
  });
});

describe("escalation sequence", () => {
  test("emits each threshold exactly once as the dataset ages day by day", () => {
    // Simulate the daily cron walking a dataset from fresh to the deadline,
    // remembering the last stage emitted (mirrors staleness_warn_stage).
    const emitted: number[] = [];
    let lastStage: number | null = null;
    for (let age = 0; age <= STALENESS_LIMIT_DAYS; age++) {
      const daysLeft = daysUntilDeletion(CREATED, nowAfter(age));
      const stage = warningStageForDaysLeft(daysLeft);
      if (stage !== null && stage !== lastStage) {
        emitted.push(stage);
        lastStage = stage;
      }
    }
    expect(emitted).toEqual([...WARNING_THRESHOLDS]);
  });

  test("never emits a stage at or past the deadline", () => {
    for (let age = STALENESS_LIMIT_DAYS; age <= STALENESS_LIMIT_DAYS + 10; age++) {
      const daysLeft = daysUntilDeletion(CREATED, nowAfter(age));
      expect(warningStageForDaysLeft(daysLeft)).toBeNull();
    }
  });
});

describe("deletionDate", () => {
  test("is the activity date plus the 90-day limit, in UTC", () => {
    // 2026-01-01 + 90 days = 2026-04-01
    expect(deletionDate(CREATED)).toBe("2026-04-01");
  });

  test('falls back to "soon" when unparseable', () => {
    expect(deletionDate("")).toBe("soon");
  });
});
