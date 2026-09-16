/**
 * What plain `--help` leads with for a command group, what it folds away,
 * and that the color pass does not change the layout.
 */

import { describe, expect, test } from "bun:test";
import { COMMON_COMMANDS } from "../src/lib/help-groups";
import { describedCommands, foldedCommands, help } from "./help-output";

describe("common-command tiering", () => {
  for (const [group, common] of Object.entries(COMMON_COMMANDS)) {
    const path = group.split(" ");

    test(`nemar ${group} --help leads with exactly the declared commands`, async () => {
      const out = await help([...path, "--help"]);
      // Order matters: the table is read top to bottom as the order to show.
      expect(describedCommands(out)).toEqual([...common]);
    });

    test(`nemar ${group} --help folds everything else onto one line`, async () => {
      const plain = await help([...path, "--help"]);
      const all = await help([...path, "--help-all"]);

      const folded = foldedCommands(plain);
      expect(folded.length).toBeGreaterThan(0);
      // Nothing is lost: every command --help-all describes is either led
      // with or folded. `help` is the one deliberate omission.
      const everything = describedCommands(all).filter((name) => name !== "help");
      expect([...common, ...folded].sort()).toEqual(everything.sort());
    });

    test(`every name declared for ${group} is a real subcommand`, async () => {
      // The table is a hand-written list; this is what stops it from naming a
      // command that was renamed or removed, which would silently drop a line
      // from the lead block instead of failing.
      const all = describedCommands(await help([...path, "--help-all"]));
      for (const name of common) {
        expect(all).toContain(name);
      }
    });

    test(`nemar ${group} --help-all still describes the folded commands`, async () => {
      const all = await help([...path, "--help-all"]);
      expect(all).not.toContain("More commands");
      expect(describedCommands(all).length).toBeGreaterThan(common.length);
    });
  }

  test("a group with no declared table is untouched", async () => {
    const out = await help(["auth", "--help"]);
    expect(out).not.toContain("More commands");
    expect(describedCommands(out)).toContain("login");
    expect(describedCommands(out)).toContain("keys");
  });
});

describe("colored help wraps on the visible text", () => {
  // Commander measures wrap width with `.length`, which counts a colored
  // term's ~19 bytes of ANSI escapes as columns. Stripping the color back out
  // has to reproduce the uncolored rendering exactly; when it does not, every
  // description is breaking a dozen columns early.
  // Built with String.fromCharCode rather than written as a literal: Biome
  // rewrites a `\u001b` escape inside a regex literal into a raw ESC byte,
  // which is an invisible control character sitting in the source file.
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

  for (const args of [["dataset", "--help"], ["admin", "--help"], ["--help"]]) {
    test(`nemar ${args.join(" ")}`, async () => {
      const colored = await help(args, { FORCE_COLOR: "1" });
      const plain = await help(args);
      expect(colored.replace(ANSI, "")).toEqual(plain);
    });
  }
});
