/**
 * Environment classification tests (epic #923, phase 3 / #925).
 *
 * isNonProductionEnv gates information disclosure (the onError verbose-error
 * flag) and later phases' non-prod behavior, so it must fail CLOSED: only a
 * recognized non-production value returns true; anything unknown/unset is
 * treated as production.
 */

import { describe, expect, test } from "bun:test";
import {
  isNonProductionEnv,
  resolveDataBaseOrigin,
  resolveDatasetLandingBase,
} from "../src/services/environment";
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

describe("resolveDatasetLandingBase", () => {
  test("prefers DATASET_LANDING_BASE_URL over FRONTEND_URL", () => {
    expect(
      resolveDatasetLandingBase({
        DATASET_LANDING_BASE_URL: "https://landing.example",
        FRONTEND_URL: "https://test.nemar.org",
      }),
    ).toBe("https://landing.example");
  });

  test("falls back to FRONTEND_URL (dev staging host)", () => {
    expect(resolveDatasetLandingBase({ FRONTEND_URL: "https://test.nemar.org" })).toBe(
      "https://test.nemar.org",
    );
  });

  test("prod default when both unset -> nemar.org", () => {
    expect(resolveDatasetLandingBase({})).toBe("https://nemar.org");
  });

  test("empty strings fall through to the next candidate", () => {
    expect(
      resolveDatasetLandingBase({ DATASET_LANDING_BASE_URL: "  ", FRONTEND_URL: "https://x.test" }),
    ).toBe("https://x.test");
    expect(resolveDatasetLandingBase({ DATASET_LANDING_BASE_URL: "", FRONTEND_URL: "" })).toBe(
      "https://nemar.org",
    );
  });

  test("strips trailing slashes", () => {
    expect(resolveDatasetLandingBase({ FRONTEND_URL: "https://test.nemar.org/" })).toBe(
      "https://test.nemar.org",
    );
  });
});

describe("resolveDataBaseOrigin", () => {
  test("prod default when unset -> data.nemar.org (byte-identical)", () => {
    expect(resolveDataBaseOrigin({ ENVIRONMENT: "production" })).toBe("https://data.nemar.org");
    expect(resolveDataBaseOrigin({ ENVIRONMENT: "production", DATA_BASE_URL: "" })).toBe(
      "https://data.nemar.org",
    );
  });

  test("staging override", () => {
    expect(
      resolveDataBaseOrigin({
        ENVIRONMENT: "development",
        DATA_BASE_URL: "https://data-test.nemar.org",
      }),
    ).toBe("https://data-test.nemar.org");
  });

  test("strips trailing slash", () => {
    expect(
      resolveDataBaseOrigin({
        ENVIRONMENT: "development",
        DATA_BASE_URL: "https://data-test.nemar.org/",
      }),
    ).toBe("https://data-test.nemar.org");
  });

  test("non-prod without override still returns the prod default (safe fallback)", () => {
    expect(resolveDataBaseOrigin({ ENVIRONMENT: "development" })).toBe("https://data.nemar.org");
  });
});
