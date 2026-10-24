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
      const cut = body.indexOf('nemar admin import-openneuro "$DATASET_ID"');
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
      const helpProc = Bun.spawn(["bun", cli, "admin", "import-openneuro", "--help"], {
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
