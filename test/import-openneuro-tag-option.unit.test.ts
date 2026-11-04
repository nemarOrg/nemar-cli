/**
 * `nemar admin import-openneuro --tag` (epic #1046 Phase 3, ADR 0111 decision 10): where a tag is
 * allowed, and the shape of the workflow dispatch with and without one.
 *
 * The help text is read from the real CLI entry point, because the onboard workflow decides
 * whether an installed CLI understands `--tag` by grepping exactly that text: a workflow running an
 * older CLI must not pass a flag the CLI would reject.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importTagOptionError, openNeuroDispatchFields } from "../src/commands/admin";

describe("where --tag is allowed", () => {
  test("one dataset, any mode but copy or finalize", () => {
    expect(importTagOptionError("1.0.1", ["ds004362"], undefined)).toBeNull();
    expect(importTagOptionError("1.0.1", ["ds004362"], "prepare")).toBeNull();
    expect(importTagOptionError(undefined, ["ds004362", "ds004363"], "copy")).toBeNull();
  });

  test("never for a batch: a tag names one dataset's snapshot", () => {
    expect(importTagOptionError("1.0.1", ["ds004362", "ds004363"], undefined)).toMatch(/single/);
  });

  test("never for copy or finalize: only prepare clones", () => {
    expect(importTagOptionError("1.0.1", ["ds004362"], "copy")).toMatch(/--phase prepare/);
    expect(importTagOptionError("1.0.1", ["ds004362"], "finalize")).toMatch(/--phase prepare/);
  });

  test("never a value that is not a snapshot tag", () => {
    for (const tag of ["", "-x", "1.0.0 2", "a/b", "1..0", "$(id)"]) {
      expect(importTagOptionError(tag, ["ds004362"], undefined)).toMatch(/Invalid --tag/);
    }
  });
});

describe("the dispatch carries the tag only when one is given", () => {
  test("without a tag, the fields an older workflow accepts", () => {
    expect(openNeuroDispatchFields(["ds004362", "ds004363"])).toEqual([
      "--field",
      "openneuro_ids=ds004362,ds004363",
    ]);
  });

  test("with a tag, one more field", () => {
    expect(openNeuroDispatchFields(["ds004362"], "1.0.1")).toEqual([
      "--field",
      "openneuro_ids=ds004362",
      "--field",
      "openneuro_tag=1.0.1",
    ]);
  });
});

describe("the help text the workflow looks for", () => {
  test("`import-openneuro --help` lists `--tag <tag>`", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "nemar-tag-help-"));
    try {
      const proc = Bun.spawn(
        [
          "bun",
          join(import.meta.dir, "..", "src", "index.ts"),
          "admin",
          "import-openneuro",
          "--help",
        ],
        {
          env: {
            PATH: process.env.PATH ?? "",
            HOME: configDir,
            NEMAR_CONFIG_DIR: configDir,
            NEMAR_NO_UPDATE_CHECK: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(await proc.exited).toBe(0);
      expect(out).toContain("--tag <tag>");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  }, 30_000);
});
