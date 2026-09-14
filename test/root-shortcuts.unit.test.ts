/**
 * The root-level `nemar download` / `nemar upload` shortcuts: present,
 * and identical to the two-word commands they stand in for.
 */

import { describe, expect, test } from "bun:test";
import { describedCommands, help, optionFlags } from "./help-output";

describe("root shortcuts for download and upload", () => {
  test("both are listed at the root", async () => {
    const out = await help(["--help"]);
    expect(describedCommands(out)).toContain("download");
    expect(describedCommands(out)).toContain("upload");
  });

  for (const name of ["download", "upload"]) {
    test(`nemar ${name} accepts exactly what nemar dataset ${name} accepts`, async () => {
      // One factory builds both, so this cannot drift -- unless someone
      // re-declares the shortcut by hand, which is what this catches.
      const shortcut = await help([name, "--help"]);
      const canonical = await help(["dataset", name, "--help"]);
      expect(optionFlags(shortcut)).toEqual(optionFlags(canonical));
    });
  }

  test("the canonical dataset subcommands are still there", async () => {
    const out = await help(["dataset", "--help"]);
    expect(describedCommands(out)).toContain("download");
    expect(describedCommands(out)).toContain("upload");
  });
});
