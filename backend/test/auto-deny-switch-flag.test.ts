/**
 * The automatic denial's owner switch and cap, and where they are NOT set (ADR 0139, decision 3).
 *
 * `PUBLICATION_AUTO_DENY_MODE` and `PUBLICATION_AUTO_DENY_DAILY_CAP` appear in no table of
 * `backend/wrangler-sccn.toml`. The owner sets them in a reviewed change that edits this test; a line
 * added by any other change would let an automated agent deny depositors' requests somewhere nobody
 * decided it should, and that is what this test refuses.
 *
 * The test reads the real file, parses it with Bun's TOML parser and walks every table, not only
 * the vars blocks, so a name misplaced under another table fails too. It covers the file and nothing
 * else: a Worker secret of the same name also takes effect and does not show in the file.
 *
 * It also pins the switch rule through the real functions: only the exact word `on` denies, and a
 * value that is not one of the three words is `off`.
 *
 * CI TIER: unit-pure. Reads one file of the checkout.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { autoDenyDailyCap, autoDenyMode } from "../src/services/publication-auto-deny";
import type { Bindings } from "../src/types/bindings";

const config = Bun.TOML.parse(
  readFileSync(join(import.meta.dir, "../wrangler-sccn.toml"), "utf-8"),
) as { vars?: Record<string, unknown>; env?: Record<string, { vars?: Record<string, unknown> }> };

const SWITCH_NAMES = ["PUBLICATION_AUTO_DENY_MODE", "PUBLICATION_AUTO_DENY_DAILY_CAP"] as const;

/** The dotted path of every key named in `names`, anywhere in the parsed document. */
function pathsOfNames(names: readonly string[], node: unknown, path = ""): string[] {
  if (typeof node !== "object" || node === null) return [];
  const found: string[] = [];
  const entries: Array<[string, unknown]> = Array.isArray(node)
    ? node.map((v, i) => [`[${i}]`, v])
    : Object.entries(node);
  for (const [key, value] of entries) {
    const here = path === "" ? key : Array.isArray(node) ? `${path}${key}` : `${path}.${key}`;
    if (names.includes(key)) found.push(here);
    found.push(...pathsOfNames(names, value, here));
  }
  return found;
}

describe("backend/wrangler-sccn.toml and the automatic denial's switches", () => {
  test("the vars blocks it checks exist (the guard is not vacuous)", () => {
    expect(config.vars?.ENVIRONMENT).toBe("production");
    expect(config.env?.dev?.vars?.ENVIRONMENT).toBe("development");
  });

  test("the walk sees a name wherever it is (the walk is not vacuous)", () => {
    expect(
      pathsOfNames(SWITCH_NAMES, {
        vars: { PUBLICATION_AUTO_DENY_MODE: "on" },
        env: { dev: { vars: { PUBLICATION_AUTO_DENY_DAILY_CAP: "5" } } },
        other: [{ PUBLICATION_AUTO_DENY_MODE: "shadow" }],
        PUBLICATION_REVIEW_ENABLED: "not a switch of this test",
      }),
    ).toEqual([
      "vars.PUBLICATION_AUTO_DENY_MODE",
      "env.dev.vars.PUBLICATION_AUTO_DENY_DAILY_CAP",
      "other[0].PUBLICATION_AUTO_DENY_MODE",
    ]);
  });

  test("neither the mode nor the cap is set in any table of the file", () => {
    expect(pathsOfNames(SWITCH_NAMES, config)).toEqual([]);
  });

  test("the same walk finds a name that is there", () => {
    expect(pathsOfNames(["ENVIRONMENT"], config)).toContain("vars.ENVIRONMENT");
  });
});

function env(over: Record<string, unknown>): Bindings {
  return { ENVIRONMENT: "production", ...over } as unknown as Bindings;
}

describe("the switch as the Worker reads it", () => {
  test("only the three words are modes; unset and anything else is off", () => {
    expect(autoDenyMode(env({}))).toBe("off");
    expect(autoDenyMode(env({ PUBLICATION_AUTO_DENY_MODE: "on" }))).toBe("on");
    expect(autoDenyMode(env({ PUBLICATION_AUTO_DENY_MODE: "shadow" }))).toBe("shadow");
    for (const v of ["1", "true", "ON", " on", "on ", "enabled", "", 1, true, ["on"]]) {
      expect(autoDenyMode(env({ PUBLICATION_AUTO_DENY_MODE: v }))).toBe("off");
    }
  });

  test("the cap is 25 unless it is digits from 0 to 1000", () => {
    expect(autoDenyDailyCap(env({}))).toBe(25);
    expect(autoDenyDailyCap(env({ PUBLICATION_AUTO_DENY_DAILY_CAP: "3" }))).toBe(3);
    expect(autoDenyDailyCap(env({ PUBLICATION_AUTO_DENY_DAILY_CAP: 3 }))).toBe(25);
    expect(autoDenyDailyCap(env({ PUBLICATION_AUTO_DENY_DAILY_CAP: "1001" }))).toBe(25);
  });
});
