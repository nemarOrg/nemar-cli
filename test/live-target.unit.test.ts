/**
 * The live-tier target fence (test/live-target.ts).
 *
 * The rule under test is one sentence: **an undeclared target must never mean
 * production.** It used to, and the cost was a test run that minted a real device
 * code on the production backend and opened the developer's browser on the sign-in
 * page -- so these cases are the record of what has to stay true.
 *
 * Pure by design: `test/setup.ts` enforces the decision at import time, which no
 * test can observe from the inside, so the decision is separated from the doing.
 */

import { describe, expect, test } from "bun:test";
import {
  BLOCKED_API_URL,
  blockedTargetMessage,
  decideLiveTarget,
  isEnvOptIn,
  pointsAtProduction,
} from "./live-target";

const DEV = "https://nemar-api-dev.sccn-org.workers.dev";
const PROD = "https://api.nemar.org";

function decide(testApiUrl: string | undefined, allowProd?: string) {
  return decideLiveTarget({ testApiUrl, allowProd, defaultApiUrl: PROD });
}

describe("an undeclared target is blocked, never silently production", () => {
  /** The founding case. `TEST_API_URL` is unset in every fresh clone, because
   *  test/.env.test is gitignored and there is nothing to copy it from. */
  test("unset is blocked", () => {
    const d = decide(undefined);
    expect(d.pointsAtProd).toBe(true);
    expect(d.blocked).toBe(true);
    expect(d.effectiveApiUrl).toBe(BLOCKED_API_URL);
  });

  test("empty and whitespace-only are treated as unset, and blocked", () => {
    for (const raw of ["", "   ", "\t", "\n"]) {
      const d = decide(raw);
      expect(d.declaredApiUrl).toBe(PROD);
      expect(d.blocked).toBe(true);
    }
  });

  test("the declared url survives so a suite can still see it is production", () => {
    // Load-bearing: six live suites skip on their own POINTS_AT_PROD check,
    // derived from TEST_CONFIG.apiUrl. Rewriting that to loopback would un-skip
    // them and turn six clean skips into six failures.
    const d = decide(undefined);
    expect(d.declaredApiUrl).toBe(PROD);
    expect(d.effectiveApiUrl).not.toBe(d.declaredApiUrl);
  });
});

describe("a declared non-production target passes through untouched", () => {
  test("the dev worker is allowed and unmodified", () => {
    const d = decide(DEV);
    expect(d.blocked).toBe(false);
    expect(d.pointsAtProd).toBe(false);
    expect(d.effectiveApiUrl).toBe(DEV);
    expect(d.declaredApiUrl).toBe(DEV);
  });

  test("a local stub server is allowed", () => {
    // The overwhelmingly common case: ~40 suites run the CLI against a local
    // Bun.serve on a random port. Blocking those would break the whole tier.
    for (const url of ["http://localhost:53219", "http://127.0.0.1:8787", "http://[::1]:3000"]) {
      expect(decide(url).blocked).toBe(false);
    }
  });

  test("surrounding whitespace does not defeat the match", () => {
    expect(decide(`  ${DEV}  `).declaredApiUrl).toBe(DEV);
    expect(decide(`  ${PROD}  `).blocked).toBe(true);
  });
});

describe("TEST_ALLOW_PROD is the only way through, and only when it means yes", () => {
  for (const yes of ["1", "true", "TRUE", "yes", " 1 "]) {
    test(`${JSON.stringify(yes)} allows production`, () => {
      const d = decide(PROD, yes);
      expect(d.blocked).toBe(false);
      expect(d.effectiveApiUrl).toBe(PROD);
      expect(d.reason).toContain("allowed by TEST_ALLOW_PROD");
    });
  }

  for (const no of ["0", "false", "no", "", "   ", "maybe", "2"]) {
    test(`${JSON.stringify(no)} does NOT allow production`, () => {
      // `TEST_ALLOW_PROD=0` is someone saying no. Reading any non-empty string as
      // truthy -- the obvious implementation -- turns that into a production run.
      expect(decide(PROD, no).blocked).toBe(true);
    });
  }

  test("the opt-in cannot make a non-production target look production", () => {
    const d = decide(DEV, "1");
    expect(d.pointsAtProd).toBe(false);
    expect(d.blocked).toBe(false);
  });
});

describe("pointsAtProduction", () => {
  test("both production hosts are recognised", () => {
    expect(pointsAtProduction("https://api.nemar.org")).toBe(true);
    expect(pointsAtProduction("https://data.nemar.org/whatever")).toBe(true);
    expect(pointsAtProduction("https://API.NEMAR.ORG")).toBe(true);
  });

  test("a host that merely CONTAINS the production name is not production", () => {
    // Why this is parsed rather than substring-matched: a substring check blocks
    // a legitimate local stub and, worse, teaches people to work around the fence.
    expect(pointsAtProduction("http://localhost:3000/api.nemar.org")).toBe(false);
    expect(pointsAtProduction("https://api.nemar.org.evil.test/")).toBe(false);
  });

  test("nemar.org itself and the dev worker are not the live API", () => {
    expect(pointsAtProduction("https://nemar.org")).toBe(false);
    expect(pointsAtProduction("https://nemar-api-dev.sccn-org.workers.dev")).toBe(false);
  });

  test("an unparseable target is treated AS production, because the fence fails closed", () => {
    // A target we cannot read is the one case where we cannot prove it is safe.
    for (const junk of ["api.nemar.org", "not a url", "://", "localhost:8787"]) {
      expect(pointsAtProduction(junk)).toBe(true);
    }
  });
});

describe("isEnvOptIn", () => {
  test("undefined is not an opt-in", () => {
    expect(isEnvOptIn(undefined)).toBe(false);
  });

  test("only the affirmative spellings count", () => {
    expect(isEnvOptIn("1")).toBe(true);
    expect(isEnvOptIn("yes")).toBe(true);
    expect(isEnvOptIn("true")).toBe(true);
    expect(isEnvOptIn("0")).toBe(false);
    expect(isEnvOptIn("off")).toBe(false);
  });
});

describe("the message tells the person what to do", () => {
  test("it names the target and all three ways out", () => {
    const msg = blockedTargetMessage(PROD);
    expect(msg).toContain(PROD);
    expect(msg).toContain("test/.env.test.example");
    expect(msg).toContain("TEST_API_URL=");
    expect(msg).toContain("TEST_ALLOW_PROD=1");
  });
});

describe("the example env file stays in step with what the harness reads", () => {
  /**
   * A drift pin, in the spirit of the repo's other surface pins. The example file
   * is the ONLY discoverable record of these names -- the real file is gitignored --
   * so a new TEST_* variable that never reaches the example is a variable nobody
   * outside this conversation will ever know to set.
   */
  test("every TEST_* variable the tier reads appears in test/.env.test.example", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = import.meta.dir;

    const referenced = new Set<string>();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(/process\.env\.(TEST_[A-Z0-9_]+)/g)) {
        referenced.add(m[1] as string);
      }
    }
    expect(referenced.size).toBeGreaterThan(5);

    const example = readFileSync(join(dir, ".env.test.example"), "utf8");
    const missing = [...referenced].filter((name) => !example.includes(name)).sort();
    expect(missing).toEqual([]);
  });
});
