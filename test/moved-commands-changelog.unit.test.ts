/**
 * The CHANGELOG's list of moved and retired admin paths is the moved-command table, rendered
 * (scripts/moved-commands-changelog.ts). A row added to the table without regenerating the list,
 * or a list edited by hand, fails here; `bun scripts/moved-commands-changelog.ts --write` fixes it.
 *
 * CI TIER: unit-pure. It reads one file and imports the table.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  END_MARKER,
  START_MARKER,
  generatedBlock,
  renderMovedCommands,
} from "../scripts/moved-commands-changelog";
import { MOVED_COMMANDS } from "../src/lib/moved-commands";

const changelog = readFileSync(join(import.meta.dir, "..", "CHANGELOG.md"), "utf-8");

describe("the CHANGELOG's moved-command list", () => {
  test("sits between its markers, once", () => {
    expect(changelog.split(START_MARKER)).toHaveLength(2);
    expect(changelog.split(END_MARKER)).toHaveLength(2);
    expect(generatedBlock(changelog)).not.toBeNull();
  });

  test("is exactly the table, rendered", () => {
    expect(generatedBlock(changelog)).toBe(renderMovedCommands());
  });

  test("names every row once, moved or retired", () => {
    const lines = (generatedBlock(changelog) ?? "").split("\n");
    expect(lines).toHaveLength(MOVED_COMMANDS.length);
    for (const row of MOVED_COMMANDS) {
      const line = lines.find((l) => l.startsWith(`- \`nemar admin ${row.oldPath}\``));
      expect({ row: row.oldPath, line: line !== undefined }).toEqual({
        row: row.oldPath,
        line: true,
      });
      if ("retired" in row) expect(line).toContain(": retired.");
      else expect(line).toContain(`-> \`nemar admin ${row.newPath}\``);
    }
  });
});
