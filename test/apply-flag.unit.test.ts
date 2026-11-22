/**
 * `addApplyOption` (ADR 0135 decision 4) on a throwaway Commander command: every
 * spelling sets `opts.apply`, the aliases stay out of help, and a spelling the
 * command never had is still rejected.
 */

import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { type ApplyAlias, addApplyOption } from "../src/lib/apply-flag";

function throwaway(aliases: readonly ApplyAlias[]): { cmd: Command; seen: () => unknown } {
  let opts: unknown;
  const cmd = new Command("throwaway")
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} })
    .argument("[id]");
  addApplyOption(cmd, "Write the change (default: dry run)", aliases);
  cmd.action((_id, o) => {
    opts = o;
  });
  return { cmd, seen: () => opts };
}

async function parse(aliases: readonly ApplyAlias[], argv: string[]) {
  const { cmd, seen } = throwaway(aliases);
  await cmd.parseAsync(argv, { from: "user" });
  return seen() as Record<string, unknown>;
}

describe("addApplyOption", () => {
  test("no flag leaves apply unset", async () => {
    const opts = await parse(["--execute"], ["nm1"]);
    expect(opts.apply).toBeUndefined();
  });

  test("--apply sets apply", async () => {
    const opts = await parse(["--execute"], ["nm1", "--apply"]);
    expect(opts.apply).toBe(true);
  });

  test.each(["--execute", "--write", "--fix"] as const)(
    "the hidden %s sets apply and no key of its own",
    async (alias) => {
      const opts = await parse([alias], ["nm1", alias]);
      expect(opts.apply).toBe(true);
      expect(opts[alias.slice(2)]).toBeUndefined();
    },
  );

  test("a command can take more than one alias", async () => {
    expect((await parse(["--write", "--fix"], ["--write"])).apply).toBe(true);
    expect((await parse(["--write", "--fix"], ["--fix"])).apply).toBe(true);
  });

  test("help lists --apply and none of the aliases", () => {
    const { cmd } = throwaway(["--execute", "--write", "--fix"]);
    const help = cmd.helpInformation();
    expect(help).toContain("--apply");
    expect(help).not.toContain("--execute");
    expect(help).not.toContain("--write");
    expect(help).not.toContain("--fix");
  });

  test("an alias the command did not declare is still an unknown option", async () => {
    const { cmd } = throwaway(["--execute"]);
    await expect(cmd.parseAsync(["--write"], { from: "user" })).rejects.toMatchObject({
      code: "commander.unknownOption",
    });
  });
});
