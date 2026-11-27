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
      const cut = body.indexOf('nemar admin import openneuro "$DATASET_ID"');
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

      // Colored help is stripped before it is matched, so FORCE_COLOR changes nothing.
      // Control: the help really is colored under FORCE_COLOR, so the strip is exercised.
      const coloredHelp = Bun.spawn(["bun", cli, "admin", "import", "openneuro", "--help"], {
        env: { ...env, FORCE_COLOR: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await new Response(coloredHelp.stdout).text()).toContain("\u001b[");
      await coloredHelp.exited;
      const colored = Bun.spawn(["bash", "-e", script], {
        env: { ...env, OPENNEURO_TAG: "1.0.1", FORCE_COLOR: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [coloredOut] = await Promise.all([
        new Response(colored.stdout).text(),
        new Response(colored.stderr).text(),
      ]);
      expect(await colored.exited).toBe(0);
      expect(args(coloredOut)).toEqual(args(out));

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

  test("an empty help capture with a tag requested fails the step; with no tag it proceeds", async () => {
    // A `nemar` that prints nothing and fails, as a broken install would: the capture is empty
    // and says nothing about --tag, so a requested tag must not be dropped silently.
    const dir = mkdtempSync(join(tmpdir(), "prepare-empty-help-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "nemar"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(bin, "nemar"), 0o755);
      const body = prepareStep.run as string;
      const cut = body.indexOf('nemar admin import openneuro "$DATASET_ID"');
      expect(cut).toBeGreaterThan(0);
      // The step logs to /tmp; this run logs to its own directory instead.
      // The step's own log path, as the workflow spells it; `dir` may itself sit under /tmp (it does
      // on a Linux runner), so check for this literal rather than for any "/tmp/.
      const stepLog = '"/tmp/prepare-${DATASET_ID}';
      const original = body.slice(0, cut);
      expect(original).toContain(stepLog);
      const head = original.replaceAll('"/tmp/', `"${dir}/`);
      expect(head).not.toContain(stepLog);
      expect(head).toContain(`"${dir}/prepare-\${DATASET_ID}`);
      const script = join(dir, "prepare.sh");
      writeFileSync(
        script,
        `${head}for a in "\${tag_args[@]}"; do printf 'ARG:%s\\n' "$a"; done\necho REACHED_IMPORT\n`,
      );
      const run = async (tag: string) => {
        const proc = Bun.spawn(["bash", "-e", script], {
          env: {
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            HOME: dir,
            DATASET_ID: "ds004362",
            OPENNEURO_TAG: tag,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        return { code: await proc.exited, out: out + err };
      };

      const tagged = await run("1.0.1");
      expect(tagged.code).not.toBe(0);
      expect(tagged.out).toContain("::error::The installed nemar CLI printed no help");
      expect(tagged.out).not.toContain("REACHED_IMPORT");
      expect(tagged.out).not.toContain("has no --tag");
      // The reason is in the log as a CLI failure line, where the prepare reporter reads it.
      const log = readFileSync(join(dir, "prepare-ds004362.log"), "utf-8");
      expect(log).toStartWith("✖ nemar admin import openneuro --help printed nothing");

      const untagged = await run("");
      expect(untagged.code).toBe(0);
      expect(untagged.out).toContain("REACHED_IMPORT");
      expect(untagged.out).not.toContain("ARG:");
      expect(untagged.out).not.toContain("::error::");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

// ADR 0135, phase P4: `admin import-openneuro` moved to `admin import openneuro` (0.10.40), and the
// old path is a moved-command stub that exits 1. The workflow is deployed to nemarDatasets/.github
// and installs the CLI unpinned, so for one release it probed which path the installed CLI had and
// fell back to the old one. npm `latest` has carried the new path since, so the probe and the
// fallback are gone (#2348): every step calls `admin import openneuro` directly.
describe("onboard-openneuro calls only paths the CLI has", () => {
  type RunStep = { name?: string; run?: string };
  const raw = readFileSync(
    join(import.meta.dir, "..", ".github/dataset-workflows/onboard-openneuro.yml"),
    "utf-8",
  );
  const doc = parse(raw) as { jobs: Record<string, { steps?: RunStep[] }> };
  const runs = Object.values(doc.jobs).flatMap((j) => (j.steps ?? []).map((s) => s.run ?? ""));
  const all = runs.join("\n");

  type Cmd = import("commander").Command;
  const childOf = (cmd: Cmd, word: string): Cmd | undefined =>
    cmd.commands.find((c) => c.name() === word || c.aliases().includes(word));

  /**
   * The command path of each `nemar admin ...`, read by walking the real tree as the words are
   * matched: a word that names a child of the current command extends the path, and the first one
   * that does not ends it, so an operand after a command is never read as part of its path. The
   * one exception is a word under a group that has no action of its own: such a group takes no
   * operand, so the word can only be meant as a subcommand, and it is kept, which makes a
   * misspelled or missing command fail the existence check below.
   */
  const pathsNamed = async (text: string): Promise<string[]> => {
    const { adminCommand } = await import("../src/commands/admin");
    const found = new Set<string>();
    const starts = [...text.matchAll(/nemar admin((?: [^\s"'|\\;)]+)*)/g)].map((m) => m[1]);
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
          "nemar admin import-openneuro ds000001",
        ].join("\n"),
      ),
    ).toEqual([
      "admin import openneuro",
      "admin import status",
      "admin repull upstream-status",
      "admin import no-such-report",
      "admin improt",
      "admin import-openneuro",
    ]);
    // The two misspellings are what the existence check below rejects, and the old path is what
    // its stub check rejects.
    expect((await resolve("admin import no-such-report")).exists).toBe(false);
    expect((await resolve("admin improt")).exists).toBe(false);
    expect(await resolve("admin import-openneuro")).toEqual({ exists: true, stub: true });
  });

  test("every admin path the workflow runs is a live command, none of them a moved-command stub", async () => {
    const paths = await pathsNamed(all);
    expect(paths).toContain("admin import openneuro");
    for (const path of paths) {
      expect({ path, ...(await resolve(path)) }).toEqual({ path, exists: true, stub: false });
    }
  });

  test("prepare, copy and finalize each call admin import openneuro directly", () => {
    const calls = all.match(
      /^\s*nemar admin import openneuro "\$DATASET_ID" --phase (prepare|copy|finalize) /gm,
    );
    expect(calls?.map((c) => c.trim().split(" ").pop())).toEqual(["prepare", "copy", "finalize"]);
  });

  test("the old path, the probe and its fallback do not come back", () => {
    // The whole file, comments included: a comment naming the old path is how a fallback creeps
    // back in. The one mention allowed is the stub warning in prepare's comment.
    const oldMentions = raw.split("\n").filter((l) => l.includes("import-openneuro"));
    expect(oldMentions.map((l) => l.trim())).toEqual([
      "# test/import-openneuro-tag-option.unit.test.ts pins in the CLI. A help capture",
      "# `admin import-openneuro` is a stub that exits 1. Its help is captured for the --tag",
    ]);
    // And no command line (a script line that is not a comment) names it at all.
    const commandLines = all.split("\n").filter((l) => !l.trim().startsWith("#"));
    expect(commandLines.filter((l) => l.includes("import-openneuro"))).toEqual([]);
    expect(all).not.toContain("import_cmd");
    expect(all).not.toContain("Usage: nemar admin import");
    // prepare reads the help once, for --tag; copy and finalize read none.
    expect(all.match(/\$\(nemar admin import openneuro --help/g)).toHaveLength(1);
  });
});
