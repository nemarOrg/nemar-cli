/**
 * Structural assertions for the sharded onboard-openneuro workflow (#750).
 * Pure file read + YAML parse — routes to the unit-pure tier.
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  FINALIZE_JOB_TIMEOUT_MS,
  FINALIZE_RESERVE_MS,
  MIN_SCREEN_WAIT_MS,
  SCREEN_WAIT_MS,
  screenWaitBudget,
} from "../src/lib/import-publication";

const wf = parse(
  readFileSync(
    join(import.meta.dir, "..", ".github/dataset-workflows/onboard-openneuro.yml"),
    "utf-8",
  ),
) as {
  jobs: Record<
    string,
    {
      "timeout-minutes"?: number;
      if?: string;
      needs?: string | string[];
      strategy?: { "max-parallel"?: number; "fail-fast"?: boolean; matrix?: unknown };
    }
  >;
};

const asNeeds = (n: string | string[] | undefined): string[] =>
  n === undefined ? [] : Array.isArray(n) ? n : [n];

describe("onboard-openneuro workflow", () => {
  test("has prepare, copy, finalize jobs", () => {
    expect(wf.jobs.prepare).toBeDefined();
    expect(wf.jobs.copy).toBeDefined();
    expect(wf.jobs.finalize).toBeDefined();
  });

  test("copy job is sharded, bounded, and isolation-safe", () => {
    const copy = wf.jobs.copy;
    expect(copy["timeout-minutes"]).toBeLessThan(360); // under GitHub's hard cap
    expect(copy.strategy?.["max-parallel"]).toBeGreaterThan(0);
    expect(copy.strategy?.["fail-fast"]).toBe(false);
    expect(copy.if).toContain("cancelled");
  });

  test("finalize's wait for the identifier screen is cut to the job's own timeout (ADR 0089)", () => {
    // The CLI cannot see the job's clock, so it carries the timeout as a constant and this pins
    // the two together: raise the timeout and the constant must follow, which lets the full wait
    // apply. A job killed by its timeout while it waits reports a failure for data in place.
    expect(wf.jobs.finalize["timeout-minutes"]).toBe(FINALIZE_JOB_TIMEOUT_MS / 60_000);
    // Started at once, the whole wait fits only if the job has room for it and the reserve.
    expect(screenWaitBudget(0)).toBe(
      Math.min(SCREEN_WAIT_MS, FINALIZE_JOB_TIMEOUT_MS - FINALIZE_RESERVE_MS),
    );
    // A slow run gets a shorter wait, never a negative or zero one, and never past the reserve.
    expect(screenWaitBudget(40 * 60_000)).toBe(
      FINALIZE_JOB_TIMEOUT_MS - FINALIZE_RESERVE_MS - 40 * 60_000,
    );
    expect(screenWaitBudget(10 * 60 * 60_000)).toBe(MIN_SCREEN_WAIT_MS);
    for (const elapsed of [0, 10, 20, 30, 40, 50, 60].map((m) => m * 60_000)) {
      const total = elapsed + screenWaitBudget(elapsed) + FINALIZE_RESERVE_MS;
      if (screenWaitBudget(elapsed) > MIN_SCREEN_WAIT_MS) {
        expect(total).toBeLessThanOrEqual(FINALIZE_JOB_TIMEOUT_MS);
      }
    }
  });

  test("finalize runs per-dataset even if a copy shard failed", () => {
    expect(wf.jobs.finalize.if).toContain("cancelled");
    expect(wf.jobs.finalize.strategy?.["fail-fast"]).toBe(false);
  });

  test("phase dependency graph is wired (prepare -> copy -> finalize)", () => {
    // Without these, copy/finalize could run before their inputs exist (e.g.
    // finalize reading an incomplete manifest while copy shards are still going).
    expect(asNeeds(wf.jobs.copy.needs)).toContain("prepare");
    expect(asNeeds(wf.jobs.finalize.needs)).toContain("copy");
    // Both also need parse-ids for their matrix.
    expect(asNeeds(wf.jobs.copy.needs)).toContain("parse-ids");
    expect(asNeeds(wf.jobs.finalize.needs)).toContain("parse-ids");
  });
});

/**
 * The tag pin's half of the workflow (nemarOrg/nemar-cli#1909, ADR 0111 decision 10), RUN rather
 * than read: `parse-ids` is extracted from the file and executed under `bash -e`, as Actions runs a
 * `run:` step, with `GITHUB_OUTPUT` pointed at a scratch file. The prepare step's choice of `--tag`
 * is run up to the line that would start the import, against the real CLI of this checkout, so it
 * agrees with whatever that CLI's help says.
 */
describe("onboard-openneuro pins the upstream tag", () => {
  type Step = { name?: string; id?: string; run?: string; env?: Record<string, string> };
  const raw = readFileSync(
    join(import.meta.dir, "..", ".github/dataset-workflows/onboard-openneuro.yml"),
    "utf-8",
  );
  const doc = parse(raw) as {
    on: { workflow_dispatch: { inputs: Record<string, { required?: boolean }> } };
    jobs: Record<string, { outputs?: Record<string, string>; steps: Step[] }>;
  };
  const parseStep = doc.jobs["parse-ids"].steps.find((s) => s.id === "parse") as Step;
  const prepareStep = doc.jobs.prepare.steps.find((s) => s.name === "Prepare import") as Step;

  async function runParse(
    ids: string,
    tag: string,
  ): Promise<{ code: number; out: string; outputs: Record<string, string> }> {
    const dir = mkdtempSync(join(tmpdir(), "parse-ids-"));
    try {
      const script = join(dir, "parse.sh");
      const outputs = join(dir, "github-output");
      writeFileSync(script, parseStep.run as string);
      writeFileSync(outputs, "");
      const proc = Bun.spawn(["bash", "-e", script], {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? "",
          INPUT_IDS: ids,
          INPUT_TAG: tag,
          SHARDS: "8",
          GITHUB_OUTPUT: outputs,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [o, e] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      const parsed: Record<string, string> = {};
      for (const line of readFileSync(outputs, "utf8").split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) parsed[line.slice(0, eq)] = line.slice(eq + 1);
      }
      return { code, out: o + e, outputs: parsed };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("the tag is an optional input and a job output prepare reads", () => {
    expect(doc.on.workflow_dispatch.inputs.openneuro_tag?.required).toBe(false);
    expect(doc.jobs["parse-ids"].outputs?.tag).toBe("${{ steps.parse.outputs.tag }}");
    expect(parseStep.env?.INPUT_TAG).toBe(
      "${{ github.event.client_payload.openneuro_tag || inputs.openneuro_tag }}",
    );
    expect(prepareStep.env?.OPENNEURO_TAG).toBe("${{ needs.parse-ids.outputs.tag }}");
  });

  test("a valid tag for one dataset is passed on", async () => {
    for (const tag of ["1.0.1", "00006", "57fecb0ccce88d000ac17538", "2.1.0-rc1"]) {
      const r = await runParse("ds004362", tag);
      expect(r.code).toBe(0);
      expect(r.outputs.tag).toBe(tag);
      expect(r.outputs.matrix).toBe('{"dataset_id":["ds004362"]}');
    }
  });

  test("no tag is an empty output, and a batch is fine without one", async () => {
    const r = await runParse("ds004362,ds004363", "");
    expect(r.code).toBe(0);
    expect(r.outputs.tag).toBe("");
    expect(r.outputs.matrix).toBe('{"dataset_id":["ds004362","ds004363"]}');
  });

  test("a tag with a batch is refused: it names one dataset's snapshot", async () => {
    const r = await runParse("ds004362,ds004363", "1.0.1");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("single dataset");
  });

  test("anything that is not a tag is refused, and nothing in it runs", async () => {
    const marker = join(tmpdir(), `parse-ids-injected-${process.pid}`);
    for (const tag of [
      `1.0.0; touch ${marker}`,
      `$(touch ${marker})`,
      `\`touch ${marker}\``,
      "--upload-pack=x",
      "-1.0.0",
      ".1",
      "1..2",
      "../main",
      "a/b",
      "1.0.0\nmatrix=x",
      "x".repeat(65),
    ]) {
      const r = await runParse("ds004362", tag);
      expect({ tag, code: r.code }).not.toEqual({ tag, code: 0 });
      expect(r.out).toContain("Invalid openneuro_tag");
      expect(r.outputs.tag).toBeUndefined();
    }
    expect(existsSync(marker)).toBe(false);
  });

  test("prepare passes --tag exactly when the installed CLI's help lists it", async () => {
    // The real CLI of this checkout stands behind `nemar`. The help text grepped is the one
    // test/import-openneuro-tag-option.unit.test.ts pins in the CLI; the two are the same literal.
    expect(prepareStep.run).toContain('*"--tag <tag>"*');
    const dir = mkdtempSync(join(tmpdir(), "prepare-tag-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const cli = join(import.meta.dir, "..", "src", "index.ts");
      writeFileSync(join(bin, "nemar"), `#!/bin/sh\nexec bun ${JSON.stringify(cli)} "$@"\n`);
      chmodSync(join(bin, "nemar"), 0o755);
      // Cut where the import would start; print what it would have been given.
      const body = prepareStep.run as string;
      const cut = body.indexOf('nemar "${import_cmd[@]}" "$DATASET_ID"');
      expect(cut).toBeGreaterThan(0);
      const script = join(dir, "prepare.sh");
      writeFileSync(
        script,
        `${body.slice(0, cut)}for a in "\${tag_args[@]}"; do printf 'ARG:%s\\n' "$a"; done\n`,
      );
      const args = (text: string) =>
        text
          .split("\n")
          .filter((l) => l.startsWith("ARG:"))
          .map((l) => l.slice(4));
      const env = {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: dir,
        NEMAR_CONFIG_DIR: dir,
        NEMAR_NO_UPDATE_CHECK: "1",
        DATASET_ID: "ds004362",
      };
      const helpProc = Bun.spawn(["bun", cli, "admin", "import", "openneuro", "--help"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const help = await new Response(helpProc.stdout).text();
      await helpProc.exited;
      const cliHasTag = help.includes("--tag <tag>");

      const withTag = Bun.spawn(["bash", "-e", script], {
        env: { ...env, OPENNEURO_TAG: "1.0.1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([
        new Response(withTag.stdout).text(),
        new Response(withTag.stderr).text(),
      ]);
      expect(await withTag.exited).toBe(0);
      if (cliHasTag) {
        expect(args(out)).toEqual(["--tag", "1.0.1"]);
      } else {
        expect(args(out)).toEqual([]);
        expect(out + err).toContain("has no --tag");
      }

      const without = Bun.spawn(["bash", "-e", script], {
        env: { ...env, OPENNEURO_TAG: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [none] = await Promise.all([
        new Response(without.stdout).text(),
        new Response(without.stderr).text(),
      ]);
      expect(await without.exited).toBe(0);
      expect(args(none)).toEqual([]);
      expect(none).not.toContain("has no --tag");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// ADR 0135, phase P4: `admin import-openneuro` moved to `admin import openneuro`. The workflow is
// deployed to nemarDatasets/.github and installs the CLI unpinned, so each step that runs the
// import asks the installed CLI which path it has and uses that one for the call.
describe("onboard-openneuro calls only paths the CLI has", () => {
  type RunStep = { name?: string; run?: string };
  const doc = parse(
    readFileSync(
      join(import.meta.dir, "..", ".github/dataset-workflows/onboard-openneuro.yml"),
      "utf-8",
    ),
  ) as { jobs: Record<string, { steps?: RunStep[] }> };
  const runs = Object.values(doc.jobs).flatMap((j) => (j.steps ?? []).map((s) => s.run ?? ""));
  const all = runs.join("\n");

  type Cmd = import("commander").Command;
  const childOf = (cmd: Cmd, word: string): Cmd | undefined =>
    cmd.commands.find((c) => c.name() === word || c.aliases().includes(word));

  /**
   * The command path of each `nemar admin ...` and `import_cmd=(admin ...)`, read by walking the
   * real tree as the words are matched: a word that names a child of the current command extends
   * the path, and the first one that does not ends it, so an operand after a command is never
   * read as part of its path. The one exception is a word under a group that has no action of
   * its own: such a group takes no operand, so the word can only be meant as a subcommand, and it
   * is kept, which makes a misspelled or missing command fail the existence check below.
   */
  const pathsNamed = async (text: string): Promise<string[]> => {
    const { adminCommand } = await import("../src/commands/admin");
    const found = new Set<string>();
    const starts = [
      ...[...text.matchAll(/nemar admin((?: [^\s"'|\\;)]+)*)/g)].map((m) => m[1]),
      ...[...text.matchAll(/import_cmd=\(admin([^)]*)\)/g)].map((m) => m[1]),
    ];
    for (const rest of starts) {
      const words = rest.trim().split(/\s+/).filter(Boolean);
      const path = ["admin"];
      let cmd: Cmd = adminCommand;
      for (const word of words) {
        const next = childOf(cmd, word);
        if (next) {
          path.push(word);
          cmd = next;
          continue;
        }
        const isGroupWithoutAction =
          cmd.commands.length > 0 &&
          !(cmd as unknown as { _actionHandler: unknown })._actionHandler;
        if (isGroupWithoutAction && /^[a-z][a-z0-9-]*$/.test(word)) path.push(word);
        break;
      }
      found.add(path.join(" "));
    }
    return [...found];
  };

  const resolve = async (path: string) => {
    const { adminCommand } = await import("../src/commands/admin");
    const { isMovedCommandStub } = await import("../src/lib/moved-commands");
    let cmd: Cmd | undefined = adminCommand;
    for (const word of path.split(" ").slice(1)) {
      cmd = cmd?.commands.find((c) => c.name() === word || c.aliases().includes(word));
    }
    return { exists: cmd !== undefined, stub: cmd !== undefined && isMovedCommandStub(cmd) };
  };

  test("the path reader stops at an operand and keeps a word a group can only mean as a command", async () => {
    expect(
      await pathsNamed(
        [
          "nemar admin import openneuro ds000001 --phase prepare",
          "nemar admin import status on000001",
          "nemar admin repull upstream-status --json",
          "nemar admin import no-such-report",
          "nemar admin improt openneuro",
          "import_cmd=(admin import openneuro)",
        ].join("\n"),
      ),
    ).toEqual([
      "admin import openneuro",
      "admin import status",
      "admin repull upstream-status",
      "admin import no-such-report",
      "admin improt",
    ]);
    // The two misspellings are what the existence check below rejects.
    expect((await resolve("admin import no-such-report")).exists).toBe(false);
    expect((await resolve("admin improt")).exists).toBe(false);
  });

  test("every admin path the workflow runs is a live command, except the old-CLI fallback", async () => {
    const paths = await pathsNamed(all);
    expect(paths).toContain("admin import openneuro");
    for (const path of paths) {
      const { exists, stub } = await resolve(path);
      expect({ path, exists }).toEqual({ path, exists: true });
      // The old path is named only as the fallback for a CLI that predates the move; on this CLI it
      // is the moved-command stub. Anything else the workflow names must run.
      expect({ path, stub }).toEqual({ path, stub: path === "admin import-openneuro" });
    }
  });

  test("the import is never called by a hard-coded path, only through the probe's choice", () => {
    expect(all).not.toMatch(/nemar admin import[ -]openneuro "\$DATASET_ID"/);
    const calls = all.match(
      /nemar "\$\{import_cmd\[@\]\}" "\$DATASET_ID" --phase (prepare|copy|finalize)/g,
    );
    expect(calls?.length).toBe(3);
  });

  /** Each step's probe, from `import_cmd=(admin import openneuro)` to its closing `fi`. */
  const probes = runs
    .filter((r) => r.includes("import_cmd=(admin import openneuro)"))
    .map((r) => {
      const start = r.indexOf("import_cmd=(admin import openneuro)");
      const end = r.indexOf("\nfi\n", start);
      return r.slice(start, end + 3);
    });

  test("the prepare, copy and finalize steps each carry the same probe", () => {
    expect(probes).toHaveLength(3);
    expect(new Set(probes).size).toBe(1);
  });

  const CLI = join(import.meta.dir, "..", "src", "index.ts");

  /** Runs the probe with `nemar` defined by `nemarFn`; returns the chosen path and the help. */
  async function runProbe(nemarFn: string, extraEnv: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "onboard-probe-"));
    try {
      const script = `${nemarFn}\n${probes[0]}\nprintf 'CMD:%s\\n' "\${import_cmd[*]}"\nprintf '%s' "$cli_help" > "$HELP_OUT"\n`;
      const proc = Bun.spawn(["bash", "-eo", "pipefail", "-c", script], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: dir,
          TMPDIR: dir,
          NEMAR_CONFIG_DIR: dir,
          NEMAR_NO_UPDATE_CHECK: "1",
          NEMAR_NO_BROWSER: "1",
          CLI,
          HELP_OUT: join(dir, "help.txt"),
          ...extraEnv,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect({ code: await proc.exited, err: err.slice(-500) }).toEqual({ code: 0, err: "" });
      return {
        cmd: out.match(/^CMD:(.*)$/m)?.[1],
        help: readFileSync(join(dir, "help.txt"), "utf-8"),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const realCli = 'nemar() { bun "$CLI" "$@" 2>/dev/null; }';

  test("against this CLI it picks admin import openneuro, and its help names --tag", async () => {
    const r = await runProbe(realCli);
    expect(r.cmd).toBe("admin import openneuro");
    expect(r.help).toContain("Usage: nemar admin import openneuro ");
    expect(r.help).toContain("--tag <tag>");
  }, 60_000);

  test("colored help is stripped before it is matched", async () => {
    const r = await runProbe(realCli, { FORCE_COLOR: "1" });
    expect(r.cmd).toBe("admin import openneuro");
    expect(r.help).not.toContain("\u001b[");
    expect(r.help).toContain("--tag <tag>");
  }, 60_000);

  test("control: an unknown word under import answers with the group's help and exit 0", async () => {
    // Why the probe reads the usage line and not the exit code: a CLI without `import openneuro`
    // answers `admin import openneuro --help` like this.
    const proc = Bun.spawn(["bun", CLI, "admin", "import", "no-such-command", "--help"], {
      env: { PATH: process.env.PATH ?? "", NEMAR_NO_UPDATE_CHECK: "1", NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toContain("Usage: nemar admin import [options] [command]");
  }, 30_000);

  test("against a CLI from before the move it falls back to admin import-openneuro", async () => {
    // A CLI from before the move, answered from this CLI's real help: `import openneuro --help`
    // gets the `import` group's help (the control above), and `import-openneuro --help` gets the
    // command's own help under its old name. The real 0.10.39 was checked by hand; see the PR.
    const oldCli = `nemar() {
  case "$*" in
    "admin import openneuro --help") bun "$CLI" admin import --help 2>/dev/null ;;
    "admin import-openneuro --help") bun "$CLI" admin import openneuro --help 2>/dev/null | sed 's/nemar admin import openneuro/nemar admin import-openneuro/' ;;
    *) echo "unexpected: $*" >&2; return 1 ;;
  esac
}`;
    const r = await runProbe(oldCli);
    expect(r.cmd).toBe("admin import-openneuro");
    expect(r.help).toContain("Usage: nemar admin import-openneuro ");
    expect(r.help).toContain("--tag <tag>");
  }, 60_000);
});
