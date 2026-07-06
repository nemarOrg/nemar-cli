/**
 * Environment classification tests (epic #923, phase 3 / #925).
 *
 * isNonProductionEnv gates information disclosure (the onError verbose-error
 * flag) and later phases' non-prod behavior, so it must fail CLOSED: only a
 * recognized non-production value returns true; anything unknown/unset is
 * treated as production.
 */

import { describe, expect, test } from "bun:test";
import { isNonProductionEnv } from "../src/services/environment";
import type { Bindings } from "../src/types/bindings";

const env = (v: unknown) => ({ ENVIRONMENT: v }) as Pick<Bindings, "ENVIRONMENT">;

describe("isNonProductionEnv", () => {
  test("recognized non-production values -> true", () => {
    expect(isNonProductionEnv(env("development"))).toBe(true);
    expect(isNonProductionEnv(env("staging"))).toBe(true);
    expect(isNonProductionEnv(env("test"))).toBe(true);
  });

  test("production -> false", () => {
    expect(isNonProductionEnv(env("production"))).toBe(false);
  });

  test("fail-closed: unset/empty/unknown -> false (treated as production)", () => {
    expect(isNonProductionEnv(env(undefined))).toBe(false);
    expect(isNonProductionEnv(env(""))).toBe(false);
    expect(isNonProductionEnv(env("prod"))).toBe(false);
    expect(isNonProductionEnv(env("staging-2"))).toBe(false);
  });

  test("case/whitespace tolerant", () => {
    expect(isNonProductionEnv(env("  Development "))).toBe(true);
    expect(isNonProductionEnv(env("PRODUCTION"))).toBe(false);
  });
});
