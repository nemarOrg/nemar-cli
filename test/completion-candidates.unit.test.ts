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
import { adminCommand } from "../src/commands/admin";
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

// Regression (test-review follow-up on #1173): Commander accepts the
// `--flag=value` combined form for any option (`_combineFlagAndOptionalValue`
// in commander/lib/option.js), but getCandidates had no notion of it at all,
// so the CLI accepts a syntax completion can never offer. The two describe
// blocks below cover the two DIFFERENT shapes it arrives in, because they
// need opposite replacement text (full "flag=value" vs. a bare value) --
// see candidates.ts's own comments on each branch for why.
describe("regression: --flag=value single-token form (zsh/fish tokenize this way)", () => {
  function buildSourceProgram(): Command {
    const program = new Command("nemar");
    const list = program.command("list");
    list.addOption(new Option("--source <values>"));
    return program;
  }

  test("a partial value after '=' completes, replacement includes 'flag='", () => {
    const result = getCandidates(buildSourceProgram(), ["list", "--source=op"]);
    expect(result).toEqual(["--source=openneuro"]);
  });

  test("an empty value after '=' offers every value for that flag, still prefixed", () => {
    const result = getCandidates(buildSourceProgram(), ["list", "--source="]);
    expect(result.sort()).toEqual(
      ["--source=openneuro", "--source=nemar", "--source=gin", "--source=other"].sort(),
    );
  });

  test("a boolean flag before '=' offers nothing (it takes no value to complete)", () => {
    // The flag is deliberately named `--source`, and deliberately declared
    // BOOLEAN (no `<value>`), so that staticEnumFor("--source") would happily
    // return the four source values if the takes-a-value guard were dropped.
    //
    // The obvious version of this test used `--doi` and proved nothing:
    // `valueCandidatesFor` returns [] for a boolean flag anyway, so removing
    // `!optionTakesValue(opt)` from the guard left the whole suite green
    // (#1173 review flagged it, and it reproduced). This spelling makes the
    // guard the only thing standing between a boolean flag and a populated
    // value list, so deleting it fails here.
    const program = new Command("nemar");
    const list = program.command("list");
    list.addOption(new Option("--source"));
    expect(getCandidates(program, ["list", "--source=op"])).toEqual([]);
  });

  test("an undeclared flag before '=' offers nothing, not an error", () => {
    const result = getCandidates(buildSourceProgram(), ["list", "--nope=x"]);
    expect(result).toEqual([]);
  });
});

describe("regression: --flag = value split-token form (bash's default COMP_WORDBREAKS)", () => {
  test("bash splits '--source=op' into ('--source', '=', 'op') -- value completes bare", () => {
    const program = new Command("nemar");
    const list = program.command("list");
    list.addOption(new Option("--source <values>"));

    const result = getCandidates(program, ["list", "--source", "=", "op"]);
    // No "--source=" prefix here: bash's own idea of "the current word" is
    // only the "op" fragment, so the replacement must be bare "openneuro"
    // or bash would duplicate the flag already on the line.
    expect(result).toEqual(["openneuro"]);
  });

  test("an empty value after the split '=' offers every bare value", () => {
    const program = new Command("nemar");
    const list = program.command("list");
    list.addOption(new Option("--source <values>"));

    const result = getCandidates(program, ["list", "--source", "=", ""]);
    expect(result.sort()).toEqual(["gin", "nemar", "openneuro", "other"]);
  });
});

// #1173 review: subcommandNames() walked cmd.commands with no hidden check,
// so `admin regenerate-iam` (registered `{ hidden: true }` in
// src/commands/admin.ts specifically to stay out of --help) leaked into
// `nemar __complete -- admin ""`. A synthetic tree built fresh in each test
// above could not have caught this even in principle -- none of those trees
// ever registered a hidden command, so the gap was never exercised, hidden
// or not. This runs getCandidates against the ACTUAL adminCommand object
// src/index.ts registers, not a stand-in shaped like it, so a future
// `{ hidden: true }` command in the real tree is covered the same way.
//
// adminCommand is a module-level singleton also imported by other test
// files; addCommand()-ing it under a throwaway root would mutate its shared
// `.parent` and risk cross-file interference, so it's passed directly as
// getCandidates' root instead -- equivalent to completing "admin"'s own
// subcommands (words = [""]) without ever attaching it anywhere.
describe("regression: hidden commands do not leak into completion (#1173)", () => {
  test("admin regenerate-iam (hidden: true) is excluded from the real tree", () => {
    const result = getCandidates(adminCommand, [""]);
    expect(result).not.toContain("regenerate-iam");
  });

  test("a visible sibling (admin s3) still completes from the same real tree", () => {
    const result = getCandidates(adminCommand, [""]);
    expect(result).toContain("s3");
  });
});
