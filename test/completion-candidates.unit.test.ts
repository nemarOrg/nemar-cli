/**
 * Candidate resolution for `nemar __complete` (epic #1144 phase 5b, issue
 * #1149 -- plan verification cases 3 and 4).
 *
 * Built against throwaway Commander `Command` trees rather than the real
 * `program` from src/index.ts: importing index.ts would run the whole CLI
 * as a side effect (its `main()` call at module load), which is exactly why
 * src/lib/completion/run.ts takes `program` as a parameter instead of
 * importing it (D1's own note on avoiding an import cycle). Every tree here
 * is still a REAL Commander object graph, not a hand-rolled stand-in --
 * getCandidates walks `cmd.commands`/`cmd.options`/`opt.argChoices` exactly
 * as it would on the production tree, so what these tests pin is the
 * introspection contract itself.
 */

import { describe, expect, test } from "bun:test";
import { Command, Option } from "commander";
import { datasetSourceSchema } from "../shared/contract/dataset";
import { FACETS } from "../shared/facets";
import { getCandidates } from "../src/lib/completion/candidates";

function buildTree(): Command {
  const program = new Command("nemar");
  program.addCommand(new Command("alpha").description("first"));
  program.addCommand(new Command("beta").description("second"));
  return program;
}

describe("verification case 3: a newly registered subcommand completes for free", () => {
  test("a subcommand added to the tree is found without any completion-code change", () => {
    const program = buildTree();
    // Stands in for "someone registered a new command in src/commands/*.ts":
    // getCandidates never had to be told this name.
    program.addCommand(new Command("brand-new-thing").description("just added"));

    const result = getCandidates(program, [""]);

    expect(result).toContain("alpha");
    expect(result).toContain("beta");
    expect(result).toContain("brand-new-thing");
  });

  test("a subcommand's alias completes too", () => {
    const program = buildTree();
    program.addCommand(new Command("gamma").alias("g"));

    const result = getCandidates(program, [""]);
    expect(result).toContain("gamma");
    expect(result).toContain("g");
  });

  test("prefix filtering narrows subcommand candidates", () => {
    const program = buildTree();
    expect(getCandidates(program, ["al"])).toEqual(["alpha"]);
  });

  test("descending into a subcommand completes ITS subcommands, not the root's", () => {
    const program = buildTree();
    const dataset = program.command("dataset");
    dataset.addCommand(new Command("list"));
    dataset.addCommand(new Command("search"));

    const result = getCandidates(program, ["dataset", ""]);
    expect(result.sort()).toEqual(["list", "search"]);
  });
});

describe("verification case 4: .choices() and facet enums complete for their flags", () => {
  test("a Commander .choices() option completes its declared values", () => {
    const program = new Command("nemar");
    const list = program.command("list");
    list.addOption(new Option("--sort <order>").choices(["newest", "oldest", "name"]));

    const result = getCandidates(program, ["list", "--sort", ""]);
    expect(result.sort()).toEqual(["name", "newest", "oldest"]);
  });

  test("a facet flag with a declared static enum completes from shared/facets.ts", () => {
    const sourceFacet = FACETS.find((f) => f.flag === "--source");
    if (!sourceFacet || !sourceFacet.enumValues) {
      throw new Error("test assumes --source stays a declared enum facet");
    }

    const program = new Command("nemar");
    const list = program.command("list");
    list.addOption(new Option(`${sourceFacet.flag} <values>`));

    const result = getCandidates(program, ["list", "--source", ""]);
    expect(result.sort()).toEqual([...sourceFacet.enumValues].sort());
    // Cross-checked against the contract enum directly (not just the facet
    // table's own copy of it) so a drift between the two would show up here.
    expect(result.sort()).toEqual([...datasetSourceSchema.options].sort());
  });

  test("prefix filtering narrows an enum flag's value candidates too", () => {
    const program = new Command("nemar");
    const list = program.command("list");
    list.addOption(new Option("--source <values>"));

    const result = getCandidates(program, ["list", "--source", "op"]);
    expect(result).toEqual(["openneuro"]);
  });

  test("a flag with neither .choices() nor a declared enum offers nothing (not an error)", () => {
    const program = new Command("nemar");
    const list = program.command("list");
    list.addOption(new Option("--reference <text>"));

    const result = getCandidates(program, ["list", "--reference", ""]);
    expect(result).toEqual([]);
  });

  test("a boolean flag does not attempt value completion for the next word", () => {
    const program = new Command("nemar");
    const list = program.command("list");
    list.addOption(new Option("--doi"));
    list.addOption(new Option("--json"));

    // After a boolean flag with no argument, the next empty word should
    // offer this command's OTHER flags rather than trying (and failing) to
    // complete a value for --doi.
    const result = getCandidates(program, ["list", "--doi", ""]);
    expect(result).toContain("--json");
    expect(result).toContain("--doi");
  });

  test("flag-name completion is prefix-filtered by the partial flag itself", () => {
    const program = new Command("nemar");
    const list = program.command("list");
    list.addOption(new Option("--source <values>"));
    list.addOption(new Option("--sort <order>").choices(["newest"]));
    list.addOption(new Option("--doi"));

    const result = getCandidates(program, ["list", "--so"]);
    expect(result.sort()).toEqual(["--sort", "--source"]);
  });
});
