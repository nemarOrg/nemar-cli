/**
 * Where the automatic re-pull's switches are set, and where they are not (epic #1046 phase 7,
 * #1913; ADR 0111).
 *
 * `AUTO_REPULL_ENABLED`, `AUTO_REPULL_MERGE_ENABLED` and `REPULL_DAILY_OPEN_CAP` are absent from
 * `[vars]` and from every `[env.*.vars]` block, so this file turns the automatic path on nowhere.
 * The owner adds them in a reviewed change after the first re-pulls have been run by hand; a line
 * added to a vars block by any other change would turn them on somewhere nobody decided it should
 * be, and that is what this test refuses. It is pinned until that change, which edits this test.
 *
 * The test reads the real file and parses it with Bun's TOML parser, as
 * pr-review-auto-require-flag.test.ts does, so a misplaced line (under another table) fails here.
 * It covers the file and nothing else: a Worker secret of the same name also turns a switch on,
 * survives a deploy and does not show in the file, so a green run here is not proof that a switch
 * is off in an environment. `GET /admin/repulls/switches` reports what the Worker reads.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REPULL_OPEN_CAP_DEFAULT,
  autoRepullEnabled,
  autoRepullMergeEnabled,
  repullOpenCap,
  repullSwitchesReport,
} from "../src/services/repull-switches";
import type { Bindings } from "../src/types/bindings";

type VarsBlock = Record<string, unknown>;

const config = Bun.TOML.parse(
  readFileSync(join(import.meta.dir, "../wrangler-sccn.toml"), "utf-8"),
) as { vars?: VarsBlock; env?: Record<string, { vars?: VarsBlock }> };

const NAMES = [
  "AUTO_REPULL_ENABLED",
  "AUTO_REPULL_MERGE_ENABLED",
  "REPULL_DAILY_OPEN_CAP",
] as const;

/** Every vars block the file declares, named as wrangler names it. */
function varsBlocks(): Array<[string, VarsBlock | undefined]> {
  return [
    ["[vars]", config.vars],
    ...Object.entries(config.env ?? {}).map(
      ([name, env]) => [`[env.${name}.vars]`, env.vars] as [string, VarsBlock | undefined],
    ),
  ];
}

describe("backend/wrangler-sccn.toml and the automatic re-pull switches", () => {
  test("the vars blocks it checks exist (the guard is not vacuous)", () => {
    expect(config.vars?.ENVIRONMENT).toBe("production");
    expect(config.env?.dev?.vars?.ENVIRONMENT).toBe("development");
    expect(varsBlocks().map(([name]) => name)).toEqual(["[vars]", "[env.dev.vars]"]);
  });

  test("no switch and no cap is set in any vars block", () => {
    for (const name of NAMES) {
      const setIn = varsBlocks()
        .filter(([, vars]) => Object.keys(vars ?? {}).includes(name))
        .map(([block]) => block);
      expect([name, setIn]).toEqual([name, []]);
    }
  });

  test("the Worker reads every block as off, with the default open cap", () => {
    for (const [block, vars] of varsBlocks()) {
      const env = {
        ENVIRONMENT: vars?.ENVIRONMENT,
        AUTO_REPULL_ENABLED: vars?.AUTO_REPULL_ENABLED,
        AUTO_REPULL_MERGE_ENABLED: vars?.AUTO_REPULL_MERGE_ENABLED,
        REPULL_DAILY_OPEN_CAP: vars?.REPULL_DAILY_OPEN_CAP,
      } as Pick<
        Bindings,
        | "ENVIRONMENT"
        | "AUTO_REPULL_ENABLED"
        | "AUTO_REPULL_MERGE_ENABLED"
        | "REPULL_DAILY_OPEN_CAP"
      >;
      expect([block, autoRepullEnabled(env)]).toEqual([block, false]);
      expect([block, autoRepullMergeEnabled(env)]).toEqual([block, false]);
      expect([block, repullOpenCap(env)]).toEqual([
        block,
        { value: REPULL_OPEN_CAP_DEFAULT, source: "default" },
      ]);
      expect(repullSwitchesReport(env).auto_repull_enabled).toBe(false);
    }
  });

  test("auto-import is untouched by this epic: on in production, off in dev", () => {
    expect(config.vars?.AUTO_IMPORT_ENABLED).toBe("true");
    expect(config.env?.dev?.vars?.AUTO_IMPORT_ENABLED).toBe("false");
  });
});
