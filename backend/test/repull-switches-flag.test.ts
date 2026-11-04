/**
 * Where the automatic re-pull's switches and caps are set, and where they are not (epic #1046
 * phase 7, #1913; ADR 0111).
 *
 * `AUTO_REPULL_ENABLED`, `AUTO_REPULL_MERGE_ENABLED`, `REPULL_DAILY_OPEN_CAP` and
 * `REPULL_DAILY_MERGE_CAP` appear in no table of `backend/wrangler-sccn.toml`, so this file turns
 * the automatic path on nowhere and leaves both caps at their defaults. The owner adds them in a
 * reviewed change after the first re-pulls have been run by hand; a line added by any other change
 * would turn them on somewhere nobody decided it should be, and that is what this test refuses.
 * It is pinned until that change, which edits this test.
 *
 * The test reads the real file and parses it with Bun's TOML parser, then walks every table of the
 * parsed document, not only the vars blocks, so a name misplaced under another table (a binding, an
 * observability block) fails here too. The vars blocks are also checked by name, so the guard is
 * not vacuous. It covers the file and nothing else: a Worker secret of the same name also takes
 * effect, survives a deploy and does not show in the file, so a green run here is not proof that a
 * switch is off in an environment. `GET /admin/repulls/switches` reports what the Worker reads.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type VarsBlock = Record<string, unknown>;

const config = Bun.TOML.parse(
  readFileSync(join(import.meta.dir, "../wrangler-sccn.toml"), "utf-8"),
) as { vars?: VarsBlock; env?: Record<string, { vars?: VarsBlock }> };

const NAMES = [
  "AUTO_REPULL_ENABLED",
  "AUTO_REPULL_MERGE_ENABLED",
  "REPULL_DAILY_OPEN_CAP",
  "REPULL_DAILY_MERGE_CAP",
] as const;

/** The dotted path of every key named in NAMES, anywhere in the parsed document. */
function pathsOfNames(node: unknown, path = ""): string[] {
  if (typeof node !== "object" || node === null) return [];
  const found: string[] = [];
  const entries: Array<[string, unknown]> = Array.isArray(node)
    ? node.map((v, i) => [`[${i}]`, v])
    : Object.entries(node);
  for (const [key, value] of entries) {
    const here = path === "" ? key : Array.isArray(node) ? `${path}${key}` : `${path}.${key}`;
    if ((NAMES as readonly string[]).includes(key)) found.push(here);
    found.push(...pathsOfNames(value, here));
  }
  return found;
}

describe("backend/wrangler-sccn.toml and the automatic re-pull switches and caps", () => {
  test("the vars blocks it checks exist (the guard is not vacuous)", () => {
    expect(config.vars?.ENVIRONMENT).toBe("production");
    expect(config.env?.dev?.vars?.ENVIRONMENT).toBe("development");
  });

  test("the walk sees a name wherever it is (the walk is not vacuous)", () => {
    expect(
      pathsOfNames({ a: { b: [{ AUTO_REPULL_ENABLED: "1" }] }, REPULL_DAILY_MERGE_CAP: "1" }),
    ).toEqual(["a.b[0].AUTO_REPULL_ENABLED", "REPULL_DAILY_MERGE_CAP"]);
  });

  test("no switch and no cap is set in any table of the file", () => {
    expect(pathsOfNames(config)).toEqual([]);
  });

  test("auto-import is untouched by this epic: on in production, off in dev", () => {
    expect(config.vars?.AUTO_IMPORT_ENABLED).toBe("true");
    expect(config.env?.dev?.vars?.AUTO_IMPORT_ENABLED).toBe("false");
  });
});
