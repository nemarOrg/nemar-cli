/**
 * The shape ADR 0135 gives `nemar admin`, checked on the real Commander tree rather than on help
 * text: one write flag, object groups at the top, at most three levels, and groups kept to about
 * twelve visible children.
 *
 * - Decision 4: `--apply` is the one write flag. `--execute`, `--write` and `--fix` survive only
 *   as hidden aliases, so no visible option anywhere under `admin` may carry those names.
 * - Decision 1: a top-level entry names an object and is a group. The two leaves that stay at the
 *   top by decision are `notify` and `docs`.
 * - Decision 2: no path is deeper than three below `admin`, and a group aims at no more than about
 *   twelve visible children. Past that a sub-group is made; the groups over the cap today are
 *   listed below with the reason they are allowed, so a new one fails here until it is decided.
 *
 * Hidden commands (the moved-command stubs, `help`) are not part of the shape and are skipped.
 *
 * CI TIER: unit-pure. It imports the command tree and runs nothing.
 */

import { describe, expect, test } from "bun:test";
import type { Command, Option } from "commander";
import { adminCommand } from "../src/commands/admin";

const isHidden = (cmd: Command): boolean =>
  (cmd as unknown as { _hidden?: boolean })._hidden === true;
const visibleChildren = (cmd: Command): Command[] =>
  cmd.commands.filter((c) => !isHidden(c) && c.name() !== "help");

interface Node {
  path: string;
  cmd: Command;
  depth: number;
}

/** Every visible command under `admin`, with its depth below `admin` (a top-level entry is 1). */
function walk(root: Command = adminCommand): Node[] {
  const out: Node[] = [];
  const visit = (cmd: Command, path: string[]): void => {
    for (const child of visibleChildren(cmd)) {
      const p = [...path, child.name()];
      out.push({ path: p.join(" "), cmd: child, depth: p.length });
      visit(child, p);
    }
  };
  visit(root, []);
  return out;
}

/** The soft cap of ADR 0135 decision 2. */
const GROUP_CAP = 12;

/**
 * Groups allowed past the cap, each with its reason: ADR 0135's amendment of 2026-11-23 names
 * them, and a new one needs a line there before it is added here.
 * Measured when this test was written: `admin` itself has 14 (the fourteen groups of decision 1),
 * `mail` has 14 (support tickets, left unchanged by the restructure on the owner's answer of
 * 2026-11-22), and `users` and `dataset` sit exactly at 12.
 */
const OVER_CAP_ALLOWED: Readonly<Record<string, string>> = {
  "(admin)": "the fourteen top-level groups of decision 1",
  mail: "support tickets, unchanged by the restructure",
};

describe("the admin tree keeps the shape of ADR 0135", () => {
  const nodes = walk();

  test("the walk sees the tree (it cannot pass vacuously)", () => {
    expect(nodes.length).toBeGreaterThan(100);
    expect(nodes.map((n) => n.path)).toContain("dataset publish approve");
    expect(nodes.map((n) => n.path)).toContain("fleet sweep hed");
  });

  test("no visible option is named --execute, --write or --fix", () => {
    const offenders: string[] = [];
    for (const { path, cmd } of nodes) {
      for (const option of cmd.options as Option[]) {
        if (option.hidden) continue;
        if (["--execute", "--write", "--fix"].includes(option.long ?? "")) {
          offenders.push(`admin ${path} ${option.long}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every visible top-level entry is a group, except notify and docs", () => {
    const leaves = nodes
      .filter((n) => n.depth === 1 && visibleChildren(n.cmd).length === 0)
      .map((n) => n.path)
      .sort();
    expect(leaves).toEqual(["docs", "notify"]);
  });

  test("the top level is the fourteen groups of decision 1", () => {
    expect(
      nodes
        .filter((n) => n.depth === 1)
        .map((n) => n.path)
        .sort(),
    ).toEqual(
      [
        "compute",
        "dataset",
        "docs",
        "fleet",
        "import",
        "mail",
        "neurobagel",
        "notice",
        "notify",
        "oidc",
        "pr-reviews",
        "repull",
        "rework",
        "users",
      ].sort(),
    );
  });

  test("no path is deeper than three below admin", () => {
    expect(nodes.filter((n) => n.depth > 3).map((n) => n.path)).toEqual([]);
  });

  test("a group past the cap of twelve visible children is one decided to be", () => {
    const over = [{ path: "", cmd: adminCommand }, ...nodes]
      .map((n) => ({ path: n.path || "(admin)", count: visibleChildren(n.cmd).length }))
      .filter((g) => g.count > GROUP_CAP);
    expect(over.map((g) => g.path).sort()).toEqual(Object.keys(OVER_CAP_ALLOWED).sort());
  });
});
