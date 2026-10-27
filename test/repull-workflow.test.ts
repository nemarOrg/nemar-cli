/**
 * The central `run-upstream-repull` workflow (`.github/dataset-workflows/run-upstream-repull.yml`;
 * ADR 0111, decision 6 and the Phase 7d amendment; epic #1046 phase 7): the properties its safety
 * rests on, pinned so a later "simplification" cannot remove one without a test saying which.
 *
 * The workflow is authored in this repository and deployed by copying it whole into
 * `nemarDatasets/.github`, where it is merged (`nemarDatasets/.github#148`); it is not held for the
 * epic's release. The parity check at the bottom compares the two byte for byte. The
 * `unit-pure-shard` CI job checks the deployed copy out of `nemarDatasets/.github` `main` and names
 * it in `NEMAR_REPULL_WORKFLOW_LIVE`, which turns a missing copy into a failure, and any difference
 * between the two copies fails it. Without the variable it looks for a sibling checkout of
 * `nemarDatasets/.github` and SKIPS VISIBLY when there is none. The workflow runs only on a
 * dispatch the automatic path sends. That path is off until the owner turns its switch on, except
 * that the finish of an already merged re-pull is sent in production whatever the switch says.
 *
 * The step scripts that guard the run are executed here with bash, as the runner executes them:
 * the validation against the Worker's own payload builder, the mask, the install's release check
 * (with stand-ins for `bun` and `nemar` that print the versions a test gives them), and the
 * backstop's report (with a stand-in for `curl` that records what it was handed, because the
 * address is the production API's literal one).
 *
 * CI TIER: unit-pure. Reads files and runs bash over temp directories; no server.
 */

import { afterAll, describe, expect, test } from "bun:test";
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
import { isAbsolute, join } from "node:path";
import type { Command } from "commander";
import { parse } from "yaml";
import {
  UPSTREAM_REPULL_EVENT,
  type UpstreamRepullDispatchFields,
  buildUpstreamRepullPayload,
} from "../backend/src/services/github/dispatch";
import { RESUME_WINDOW_UTC } from "../backend/src/services/upstream-repull-advance";
import {
  DISPATCH_DEADLINE_HOURS,
  repullStateSchema,
} from "../backend/src/services/upstream-repull-dispatch";
import { isOpenNeuroTag, sameUpstreamTag } from "../shared/openneuro-tag";
import {
  DISPATCH_CODES,
  DISPATCH_ID_RE,
  REPULL_DISPATCH_QUEUE_MINUTES,
  REPULL_JOB_TIMEOUT_MINUTES,
  opensTheSameUtcDay,
} from "../shared/repull-state";
import { repullCommand } from "../src/commands/admin-repull";
import {
  AUTOMATIC_FLAG,
  DISPATCH_EVENT,
  DISPATCH_PAYLOAD_KEYS,
  RESULT_LINE_RE,
} from "../src/lib/repull/execute/automatic";

const REPO_ROOT = join(import.meta.dir, "..");
const LOCAL = join(REPO_ROOT, ".github", "dataset-workflows", "run-upstream-repull.yml");
const SRC = readFileSync(LOCAL, "utf8");

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
interface Workflow {
  name: string;
  on: Record<string, { types?: string[] } | null>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<
    string,
    {
      permissions: Record<string, string>;
      env: Record<string, string>;
      "timeout-minutes": number;
      steps: Step[];
    }
  >;
}

const wf = parse(SRC) as Workflow;
const job = wf.jobs.repull as Workflow["jobs"][string];
const step = (name: string): Step => {
  const s = job.steps.find((x) => x.name === name);
  if (!s) throw new Error(`no step named "${name}"`);
  return s;
};
const MASK = "Mask the dispatch token";
const VALIDATE = "Validate the dispatch";
const INSTALL = "Install the nemar CLI the dispatch names";
const CLOCK = "Note when the App token is minted";
const OPEN = "Plan and open the re-pull pull request";
const FINISH = "Finish a merged re-pull";
const BACKSTOP = "Report a run that did not report";

const TOKEN = "5e".repeat(32);

const fields = (
  over: Partial<UpstreamRepullDispatchFields> = {},
): UpstreamRepullDispatchFields => ({
  mode: "open",
  datasetId: "on099999",
  upstreamDs: "ds099999",
  fromTag: "1.0.0",
  toTag: "1.1.0",
  dispatchId: 7,
  repullId: null,
  token: TOKEN,
  cliVersion: "0.10.24",
  ...over,
});
const sent = (over: Partial<UpstreamRepullDispatchFields> = {}) =>
  buildUpstreamRepullPayload(fields(over)).client_payload as Record<string, unknown>;

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Running a step's script as the runner does
// ---------------------------------------------------------------------------------------------

interface StepRun {
  dir: string;
  status: number;
  stdout: string;
  stderr: string;
  envFile: string;
  log: string;
}

/**
 * The environment GitHub gives the job for `payload`: each field as a string, absent as "". An
 * environment variable is a C string, so a NUL ends its value: the shell sees what precedes it,
 * while the event file, which jq and the CLI read, holds all of it.
 */
function jobEnvOf(payload: Record<string, unknown>): Record<string, string> {
  const s = (k: string) => {
    const v = payload[k];
    const text = v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);
    return text.split("\0")[0] ?? "";
  };
  return {
    MODE: s("mode"),
    DATASET_ID: s("dataset_id"),
    UPSTREAM_DS: s("upstream_ds"),
    FROM_TAG: s("from_tag"),
    TO_TAG: s("to_tag"),
    DISPATCH_ID: s("dispatch_id"),
    REPULL_ID: s("repull_id"),
    CLI_VERSION: s("cli_version"),
  };
}

/** Executables a test puts first on PATH, each a bash script. */
type Fakes = Record<string, string>;

/**
 * One step's script, run by bash in a temp directory as the runner runs it. A test that runs
 * steps in a loop (about thirty times, at most) is given 20 seconds, the bound
 * publication-review-workflow.test.ts gives its own loops of step scripts, not the default five.
 */
async function runStep(
  name: string,
  opts: {
    payload?: Record<string, unknown> | null;
    env?: Record<string, string>;
    fakes?: Fakes;
    log?: string;
    files?: Record<string, string>;
  } = {},
): Promise<StepRun> {
  const dir = mkdtempSync(join(tmpdir(), "nemar-repull-workflow-"));
  temps.push(dir);
  const runnerTemp = join(dir, "runner");
  mkdirSync(runnerTemp);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [cmd, body] of Object.entries(opts.fakes ?? {})) {
    const path = join(bin, cmd);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  }
  const genv = join(dir, "github-env");
  writeFileSync(genv, "");
  const event = join(dir, "event.json");
  const payload = opts.payload === undefined ? sent() : opts.payload;
  writeFileSync(
    event,
    JSON.stringify(
      payload === null ? { action: "x" } : { action: DISPATCH_EVENT, client_payload: payload },
    ),
  );
  if (opts.log !== undefined) writeFileSync(join(runnerTemp, "repull-auto.log"), opts.log);
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    writeFileSync(join(runnerTemp, rel), content);
  }
  const script = join(dir, "step.sh");
  writeFileSync(script, step(name).run ?? "");
  // Async on purpose, and `bash -e` as the runner's default shell runs a step.
  const proc = Bun.spawn(["bash", "-e", script], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: dir,
      RUNNER_TEMP: runnerTemp,
      GITHUB_ENV: genv,
      GITHUB_EVENT_PATH: event,
      GITHUB_EVENT_NAME: "repository_dispatch",
      GITHUB_RUN_ID: "123456",
      ...(payload ? jobEnvOf(payload) : {}),
      ...opts.env,
    },
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const logPath = join(runnerTemp, "repull-auto.log");
  return {
    dir,
    status,
    stdout,
    stderr,
    envFile: readFileSync(genv, "utf8"),
    log: existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
  };
}

// ---------------------------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------------------------

describe("what triggers it, and what it may do", () => {
  test("the file parses, and says where it is deployed", () => {
    expect(wf.name).toBe("Run Upstream Re-pull");
    expect(SRC).toContain("Deploy to: nemarDatasets/.github/workflows/run-upstream-repull.yml");
  });

  test("only the Worker's repository dispatch runs it: no manual run, no push, no pull request", () => {
    expect(Object.keys(wf.on)).toEqual(["repository_dispatch"]);
    expect(wf.on.repository_dispatch?.types).toEqual([UPSTREAM_REPULL_EVENT]);
    expect(DISPATCH_EVENT).toBe(UPSTREAM_REPULL_EVENT);
  });

  test("no default token scope, at the workflow or the job", () => {
    expect(wf.permissions).toEqual({});
    expect(job.permissions).toEqual({});
    expect(Object.keys(wf.jobs)).toEqual(["repull"]);
  });

  test("each run is its own concurrency group, never one taken from the payload", () => {
    expect(wf.concurrency.group).toContain("github.run_id");
    expect(wf.concurrency.group).toContain("github.run_attempt");
    expect(wf.concurrency.group).not.toContain("client_payload");
    expect(wf.concurrency["cancel-in-progress"]).toBe(false);
  });

  test("nothing is uploaded and nothing is checked out: the plan and the clones stay on the runner", () => {
    const uses = job.steps.map((s) => s.uses ?? "").filter(Boolean);
    expect(uses.some((u) => u.includes("upload-artifact"))).toBe(false);
    expect(uses.some((u) => u.startsWith("actions/checkout"))).toBe(false);
    expect(uses.map((u) => u.split("@")[0]).sort()).toEqual([
      "actions/create-github-app-token",
      "oven-sh/setup-bun",
    ]);
  });

  test("every action is pinned to a full commit, with the tag it was resolved from, as the review workflows' are", () => {
    const lines = [...SRC.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)(?:[ \t]+#[ \t]*(\S+))?[ \t]*$/gm)];
    expect(lines).toHaveLength(job.steps.filter((s) => s.uses !== undefined).length);
    for (const m of lines) {
      expect(m[1], m[1]).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
      expect(m[2], m[1]).toMatch(/^v\d+(\.\d+){0,2}$/);
    }
    // The same commits run-publication-review.yml pins for the same actions.
    const review = readFileSync(
      join(REPO_ROOT, ".github", "dataset-workflows", "run-publication-review.yml"),
      "utf8",
    );
    for (const m of lines) expect(review).toContain(`uses: ${m[1]} # ${m[2]}`);
  });

  test("the job's bound is the shared one, and a day's dispatches open that day's pull requests", () => {
    expect(job["timeout-minutes"]).toBe(REPULL_JOB_TIMEOUT_MINUTES);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(330);
    // The watchdog never ends a dispatch whose run can still report.
    expect(DISPATCH_DEADLINE_HOURS * 60).toBeGreaterThanOrEqual(
      REPULL_JOB_TIMEOUT_MINUTES + REPULL_DISPATCH_QUEUE_MINUTES,
    );
    // The scheduler's daily tick, read from the production configuration: a dispatch claimed then
    // ends, queueing and the whole job included, before the UTC day it was counted in does.
    const toml = readFileSync(join(REPO_ROOT, "backend", "wrangler-sccn.toml"), "utf8");
    const crons = /^\[triggers\]\s*\ncrons = \[([^\]]*)\]/m.exec(toml)?.[1] ?? "";
    const daily = crons
      .split(",")
      .map((c) => c.trim().replace(/^"|"$/g, ""))
      .find((c) => /^\d+ \d+ \* \* \*$/.test(c));
    expect(daily).toBe("0 3 * * *");
    expect(opensTheSameUtcDay(Number(daily?.split(" ")[1]))).toBe(true);
    // The stalled-run slice's resumes, the last open dispatches of a day, open the same day too.
    expect(opensTheSameUtcDay(RESUME_WINDOW_UTC.from)).toBe(true);
    expect(opensTheSameUtcDay(RESUME_WINDOW_UTC.to)).toBe(true);
  });
});

describe("the dispatch token is a secret in a public log", () => {
  test("it is in no environment at any level, and in no action's input", () => {
    const envs = [
      JSON.stringify(wf.permissions),
      JSON.stringify(job.env),
      JSON.stringify(wf.concurrency),
      ...job.steps.map((s) => JSON.stringify({ env: s.env ?? {}, with: s.with ?? {} })),
    ];
    for (const e of envs) expect(e).not.toContain("dispatch_token");
  });

  test("the first step masks it from the event file, with no env of its own", () => {
    const first = job.steps[0] as Step;
    expect(first.name).toBe(MASK);
    expect(first.env).toBeUndefined();
    expect(first.run).toContain('"$GITHUB_EVENT_PATH"');
    expect(first.run).toContain(".client_payload.dispatch_token");
    expect(first.run).toContain("::add-mask::");
  });

  test("only the mask, the validation and the backstop read it, each from the event file", () => {
    const readers = job.steps
      .filter((s) => JSON.stringify(s).includes("dispatch_token"))
      .map((s) => s.name);
    expect(readers).toEqual([MASK, VALIDATE, BACKSTOP]);
    for (const name of readers) expect(step(name as string).run).toContain("GITHUB_EVENT_PATH");
  });

  test("the mask registers the token, and every line of one that is not a token, before anything", async () => {
    const r = await runStep(MASK);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`::add-mask::${TOKEN}\n`);
    // A crafted value cannot smuggle a workflow command past the mask: every line is masked.
    const crafted = await runStep(MASK, {
      payload: { ...sent(), dispatch_token: "abc\n::warning::forged\n" },
    });
    expect(crafted.stdout).toBe("::add-mask::abc\n::add-mask::::warning::forged\n");
    // A carriage return ends a line for the runner as a line feed does. Left in, a lone one would
    // keep the forged command inside the first mask line, where only `abc` is masked and the runner
    // reads the rest as a line of its own, so the output is read here the way the runner reads it.
    const lone = await runStep(MASK, {
      payload: { ...sent(), dispatch_token: "abc\r::warning::forged" },
    });
    const lines = lone.stdout.split(/\r\n|\r|\n/).filter((l) => l !== "");
    expect(lines).toEqual(["::add-mask::abc", "::add-mask::::warning::forged"]);
    expect(lines.filter((l) => l.startsWith("::warning::"))).toEqual([]);
    expect((await runStep(MASK, { payload: null })).stdout).toBe("");
  });

  test("no run script interpolates an expression: the payload reaches the shell through env only", () => {
    for (const s of job.steps) {
      if (s.run) expect([s.name, s.run.includes("${{")]).toEqual([s.name, false]);
    }
  });
});

describe("the dispatch is checked before anything is installed or minted", () => {
  test("the job's environment is the eight fields the Worker sends beside the token, by name", () => {
    const expected: Record<string, string> = {};
    for (const key of DISPATCH_PAYLOAD_KEYS) {
      if (key !== "dispatch_token") {
        expected[key.toUpperCase()] = `\${{ github.event.client_payload.${key} }}`;
      }
    }
    const fromPayload = Object.fromEntries(
      Object.entries(job.env).filter(([, v]) => v.includes("client_payload")),
    );
    expect(fromPayload).toEqual(expected);
    expect(job.env.NEMAR_NO_UPDATE_CHECK).toBe("1");
  });

  test("mask, then validate, then the disk, before the App token is minted or the CLI installed", () => {
    const names = job.steps.map((s) => s.name);
    expect(names.slice(0, 3)).toEqual([MASK, VALIDATE, "Check the runner's free disk"]);
    // The time is noted just before the mint, so the hour the CLI counts starts no later.
    expect(names.indexOf(CLOCK)).toBe(3);
    expect(names.indexOf("Mint the App token for the dataset's repository")).toBe(4);
    expect(names.indexOf(INSTALL)).toBeGreaterThan(4);
    expect(names.at(-1)).toBe(BACKSTOP);
  });

  test("the time the App token is minted reaches every later step, as whole epoch seconds", async () => {
    expect(step(CLOCK).env).toBeUndefined();
    const before = Math.floor(Date.now() / 1000);
    const r = await runStep(CLOCK);
    const after = Math.floor(Date.now() / 1000);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
    const m = /^NEMAR_REPULL_TOKEN_SINCE=(\d+)\n$/.exec(r.envFile);
    expect(m).not.toBeNull();
    const since = Number(m?.[1]);
    expect(since).toBeGreaterThanOrEqual(before);
    expect(since).toBeLessThanOrEqual(after);
  });

  test("the keys it takes are the nine the Worker's builder writes, repull_id the one that may be absent", () => {
    const run = step(VALIDATE).run ?? "";
    const list = (name: string) =>
      JSON.parse(new RegExp(`${name}='(\\[[^']*\\])'`).exec(run)?.[1] ?? "[]") as string[];
    expect(list("allowed")).toEqual([...DISPATCH_PAYLOAD_KEYS].sort());
    expect(list("allowed")).toEqual(Object.keys(sent({ repullId: 3 })).sort());
    expect(list("required")).toEqual(Object.keys(sent()).sort());
  });

  test("a dispatch the Worker sends passes, and points the CLI's config at the runner", async () => {
    for (const over of [{}, { repullId: 4 }, { mode: "finish" as const, repullId: 4 }]) {
      const r = await runStep(VALIDATE, { payload: sent(over) });
      expect([over, r.status, r.stderr]).toEqual([over, 0, ""]);
      expect(r.envFile).toBe(`NEMAR_CONFIG_DIR=${join(r.dir, "runner", "nemar")}\n`);
      expect(r.log).toBe("");
      expect(r.stdout).not.toContain(TOKEN);
    }
  }, 20_000);

  test("a tenth key, a missing key or a value that is not a string is refused", async () => {
    const cases: Array<Record<string, unknown>> = [
      { ...sent(), callback_url: "https://example.org/hook" },
      { ...sent({ repullId: 2 }), extra: "x" },
      (({ cli_version: _, ...rest }) => rest)(sent()),
      (({ dispatch_token: _, ...rest }) => rest)(sent()),
      { ...sent(), dispatch_id: 7 },
    ];
    for (const payload of cases) {
      const r = await runStep(VALIDATE, { payload });
      expect(r.status).not.toBe(0);
      expect(r.log).toBe("repull-auto: result phase=failed code=dispatch-invalid\n");
      expect(r.envFile).toBe("");
    }
  }, 20_000);

  test("every malformed field is refused, and the value is never echoed", async () => {
    const cases: Array<[string, string]> = [
      ["mode", "close"],
      ["dataset_id", "xx090001"],
      ["dataset_id", "on09999"],
      ["dataset_id", "on099998"],
      ["upstream_ds", "ds09999x"],
      ["from_tag", "1.0.0;touch-pwned"],
      ["to_tag", "../main"],
      ["to_tag", "1.0.0"],
      ["to_tag", "v1.0.0"],
      ["dispatch_id", "0"],
      ["dispatch_id", "07"],
      ["dispatch_id", "7; touch pwned"],
      ["repull_id", "0"],
      ["cli_version", "0.10.24-dev11"],
      ["cli_version", "v0.10.24"],
      ["dispatch_token", TOKEN.toUpperCase()],
      ["dispatch_token", `${TOKEN}0`],
      // The token and the re-pull id are checked on the event file, where a final newline is still
      // there: a shell variable loses the token's to `$(...)`, and cannot tell an empty re-pull id
      // from an absent one.
      ["dispatch_token", `${TOKEN}\n`],
      ["repull_id", ""],
      ["repull_id", "1\n"],
      // A NUL ends an environment variable, so the checks on the variables see only what precedes
      // it while the event file, which the CLI reads, holds the rest: a control character in any
      // field is refused at the file.
      ...Object.entries(sent({ repullId: 4 })).map(([key, value]): [string, string] => [
        key,
        `${String(value)}\0junk`,
      ]),
    ];
    const accepted: string[] = [];
    for (const [key, value] of cases) {
      const r = await runStep(VALIDATE, { payload: { ...sent(), [key]: value } });
      if (r.status === 0) {
        // Shown as JSON, so a case with a control character in it can be told apart.
        accepted.push(`${key}=${JSON.stringify(value)}`);
        continue;
      }
      // Every string contains "", so the echo check has nothing to say about the empty value.
      if (value !== "") expect(r.stdout + r.stderr).not.toContain(value);
      expect(r.log).toBe("repull-auto: result phase=failed code=dispatch-invalid\n");
      expect(existsSync(join(r.dir, "pwned"))).toBe(false);
    }
    // Together, so a weakened check shows every case it lets through and not only the first.
    expect(accepted).toEqual([]);
    // A finish names its re-pull.
    const finish = await runStep(VALIDATE, { payload: sent({ mode: "finish", repullId: 1 }) });
    expect(finish.status).toBe(0);
    const { repull_id: _, ...noRepull } = sent({ mode: "finish", repullId: 1 });
    expect((await runStep(VALIDATE, { payload: noRepull })).status).not.toBe(0);
  }, 20_000);

  test("a tag passes exactly when the Worker's tag rule takes it", async () => {
    for (const tag of [
      "1.1.0",
      "00001",
      "2.1.0-rc1",
      "v1.2.0",
      "1..2",
      "a/b",
      "-x",
      ".1",
      "1 0",
      "x".repeat(65),
      "1.0.0",
    ]) {
      const r = await runStep(VALIDATE, { payload: { ...sent(), to_tag: tag } });
      const takes = isOpenNeuroTag(tag) && !sameUpstreamTag("1.0.0", tag);
      expect([tag, r.status === 0]).toEqual([tag, takes]);
    }
  }, 20_000);
});

describe("production only", () => {
  test("the App token is minted for the dispatch's dataset repository alone, to push and open", () => {
    const mint = step("Mint the App token for the dataset's repository");
    expect(mint.uses).toBe(
      "actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547",
    );
    expect(mint.with).toEqual({
      "app-id": "${{ secrets.NEMAR_APP_ID }}",
      "private-key": "${{ secrets.NEMAR_APP_PRIVATE_KEY }}",
      owner: "nemarDatasets",
      repositories: "${{ env.DATASET_ID }}",
      "permission-contents": "write",
      "permission-pull-requests": "write",
    });
    const holders = job.steps
      .filter((s) => s.id !== "app-token" && JSON.stringify(s).includes("app-token"))
      .map((s) => s.name);
    expect(holders).toEqual([OPEN, FINISH]);
  });

  const fakes = (installed: string): Fakes => ({
    bun: 'echo "bun $*" >> "$RUNNER_TEMP/bun.calls"',
    nemar: `if [ "$1" = "--version" ]; then echo "${installed}"; fi`,
  });

  test("it installs exactly the release the dispatch names", async () => {
    expect(step(INSTALL).run).toContain('bun install -g "nemar-cli@${CLI_VERSION}"');
    const r = await runStep(INSTALL, { fakes: fakes("0.10.24") });
    expect(r.status).toBe(0);
    expect(readFileSync(join(r.dir, "runner", "bun.calls"), "utf8")).toBe(
      "bun install -g nemar-cli@0.10.24\n",
    );
    expect(r.log).toBe("");
  });

  test("a development build, or any other version, is refused before it runs", async () => {
    for (const installed of ["0.10.24-dev11", "0.10.25", "", "0.10.24 "]) {
      const r = await runStep(INSTALL, { fakes: fakes(installed) });
      expect([installed, r.status === 0]).toEqual([installed, false]);
      expect(r.log).toBe("repull-auto: result phase=failed code=auto-cli-version\n");
    }
  }, 20_000);

  test("the CLI signs in with the key in its environment, on no command line, and prints nothing", async () => {
    const login = step("Sign in the nemar CLI");
    expect(login.env).toEqual({ NEMAR_API_KEY: "${{ secrets.NEMAR_ADMIN_API_KEY }}" });
    expect(login.run).toBe("nemar auth login --yes > /dev/null 2>&1");
    // What the login says, on either stream and whether it signed in or not, reaches no log.
    for (const exit of [0, 1]) {
      const r = await runStep("Sign in the nemar CLI", {
        fakes: {
          nemar: `echo "Signed in as someone@example.org"; echo "key nm_live_x" >&2; exit ${exit}`,
        },
      });
      expect([exit, r.status === 0]).toEqual([exit, exit === 0]);
      expect(r.stdout + r.stderr).toBe("");
    }
  }, 20_000);
});

describe("the CLI runs unattended", () => {
  /** Each `nemar admin repull <command> ...` the step runs, its options as written. */
  function invocations(name: string): Array<{ command: string; options: string[] }> {
    const run = (step(name).run ?? "").replace(/\\\n\s*/g, " ");
    return [...run.matchAll(/nemar admin repull (\w+) ([^|\n]*)/g)].map((m) => ({
      command: m[1] as string,
      options: [...(m[2] as string).matchAll(/(--[a-z-]+)/g)].map((o) => o[1] as string),
    }));
  }

  test("open plans, then executes; finish resumes; each for the dispatch, unattended", () => {
    expect(step(OPEN).if).toBe("env.MODE == 'open'");
    expect(step(FINISH).if).toBe("env.MODE == 'finish'");
    expect(invocations(OPEN).map((i) => i.command)).toEqual(["plan", "execute"]);
    expect(invocations(FINISH).map((i) => i.command)).toEqual(["resume"]);
    for (const i of [...invocations(OPEN), ...invocations(FINISH)]) {
      expect(i.options).toContain(AUTOMATIC_FLAG);
    }
    expect(invocations(OPEN)[0]?.options).toContain("--bucket-listing");
    expect(step(OPEN).run).toContain('--automatic-dispatch "$DISPATCH_ID"');
    for (const name of [OPEN, FINISH]) {
      expect(step(name).env?.GH_TOKEN).toBe("${{ steps.app-token.outputs.token }}");
      // Its output is kept for the backstop, and the step fails with the CLI.
      expect(step(name).run).toContain('| tee -a "$log"');
      expect(step(name).run).toContain("set -euo pipefail");
    }
  });

  test("every option the workflow passes is one the command declares", () => {
    const declared = (command: string) =>
      new Set(
        (repullCommand.commands.find((c) => c.name() === command) as Command).options.map(
          (o) => o.long as string,
        ),
      );
    for (const i of [...invocations(OPEN), ...invocations(FINISH)]) {
      for (const o of i.options)
        expect([i.command, o, declared(i.command).has(o)]).toEqual([i.command, o, true]);
    }
  });

  test("the copy's short-lived session is made inside the step, masked, and never written out", () => {
    for (const name of [OPEN, FINISH]) {
      const run = step(name).run ?? "";
      expect(run).toContain("aws sts get-session-token");
      // Its error is never printed: an explicit deny names the IAM user and the account.
      const sts = run.split("\n").filter((l) => l.includes("aws sts "));
      expect(sts).toHaveLength(1);
      for (const l of sts) expect(l).toContain("--output json 2> /dev/null)");
      expect(run).toContain("::add-mask::");
      expect(run).not.toContain("GITHUB_ENV");
      expect(run).toContain("code=runner-credentials");
    }
  });
});

describe("one id bound for the Worker, the workflow and the CLI", () => {
  test("every id pattern the workflow checks is the shared one", () => {
    const patterns = [...SRC.matchAll(/^\s*id_re='([^']*)'$/gm)].map((m) => m[1]);
    expect(patterns.length).toBe(2);
    for (const p of patterns) expect(p).toBe(DISPATCH_ID_RE.source);
  });
});

describe("the backstop reports a run that did not", () => {
  const curlFake = (status: string): Fakes => ({
    curl: [
      'printf "%s\\n" "$@" > "$RUNNER_TEMP/curl.args"',
      'cat > "$RUNNER_TEMP/curl.stdin"',
      `echo "repull-auto: backstop http=${status}"`,
    ].join("\n"),
  });

  function sentTo(r: StepRun): { args: string[]; stdin: string; body: unknown } | null {
    const argsPath = join(r.dir, "runner", "curl.args");
    if (!existsSync(argsPath)) return null;
    const args = readFileSync(argsPath, "utf8").split("\n").slice(0, -1);
    const body = args[args.indexOf("-d") + 1] ?? "";
    return {
      args,
      stdin: readFileSync(join(r.dir, "runner", "curl.stdin"), "utf8"),
      body: JSON.parse(body),
    };
  }

  test("it posts to the production API's literal callback, which the Worker serves", () => {
    expect(step(BACKSTOP).if).toBe("always()");
    expect(step(BACKSTOP).run).toContain('"https://api.nemar.org/webhooks/repull-state"');
    const routes = readFileSync(
      join(REPO_ROOT, "backend", "src", "routes", "callbacks", "repull-state.ts"),
      "utf8",
    );
    expect(routes).toContain('webhooks.post("/repull-state"');
  });

  test("a run that left no word reports failed runner-failed, with the token only on curl's stdin", async () => {
    const r = await runStep(BACKSTOP, { fakes: curlFake("200") });
    expect(r.status).toBe(0);
    const seen = sentTo(r);
    expect(seen?.args).toContain("https://api.nemar.org/webhooks/repull-state");
    expect(seen?.args.join(" ")).not.toContain(TOKEN);
    // curl is told to read its configuration from standard input, which is where the token is.
    const k = seen?.args.indexOf("-K") ?? -1;
    expect(k).toBeGreaterThanOrEqual(0);
    expect(seen?.args[k + 1]).toBe("-");
    expect(seen?.stdin).toBe(`header = "X-Repull-Token: ${TOKEN}"\n`);
    expect(seen?.body).toEqual({
      dispatch_id: 7,
      dataset_id: "on099999",
      phase: "failed",
      code: "runner-failed",
      workflow_run_url: "https://github.com/nemarDatasets/.github/actions/runs/123456",
    });
    expect(repullStateSchema.safeParse(seen?.body).success).toBe(true);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  test("it reports the phase and the word of the run's last result line", async () => {
    const r = await runStep(BACKSTOP, {
      fakes: curlFake("200"),
      log: [
        "repull-auto: start command=plan dispatch=7",
        "repull-auto: result phase=refused code=auto-not-clean-plan",
        "",
      ].join("\n"),
    });
    expect(sentTo(r)?.body).toMatchObject({ phase: "refused", code: "auto-not-clean-plan" });
    // A plan that passed and an execute that died without a word: the last result is no failure.
    const died = await runStep(BACKSTOP, {
      fakes: curlFake("200"),
      log: "repull-auto: result phase=planned\nrepull-auto: start command=execute dispatch=7\n",
    });
    expect(sentTo(died)?.body).toMatchObject({ phase: "failed", code: "runner-failed" });
    // A line that only looks like one is not read as one.
    const forged = await runStep(BACKSTOP, {
      fakes: curlFake("200"),
      log: "repull-auto: result phase=failed code=../x\n",
    });
    expect(sentTo(forged)?.body).toMatchObject({ phase: "failed", code: "runner-failed" });
  });

  test("a run whose report was stored is not reported again", async () => {
    const r = await runStep(BACKSTOP, {
      fakes: curlFake("200"),
      files: { "repull-reported": "opened\n" },
    });
    expect(r.status).toBe(0);
    expect(sentTo(r)).toBeNull();
    expect(r.stdout).toBe("repull-auto: backstop not-needed\n");
  });

  test("a dispatch it cannot name is not reported, and the step does not fail", async () => {
    for (const env of [{ DISPATCH_ID: "x" }, { DATASET_ID: "on1" }]) {
      const r = await runStep(BACKSTOP, { fakes: curlFake("200"), env });
      expect(r.status).toBe(0);
      expect(sentTo(r)).toBeNull();
    }
    const badToken = await runStep(BACKSTOP, {
      fakes: curlFake("200"),
      payload: { ...sent(), dispatch_token: "x" },
    });
    expect(sentTo(badToken)).toBeNull();
    // A refused or failed report does not fail the step either.
    const refused = await runStep(BACKSTOP, { fakes: curlFake("401") });
    expect(refused.status).toBe(0);
  }, 20_000);

  test("every word the workflow reports is on the closed list, and its result lines are the CLI's", () => {
    const words = [
      ...SRC.matchAll(/code=([a-z][a-z0-9-]*)/g),
      ...SRC.matchAll(/code="([a-z][a-z0-9-]*)"/g),
    ].map((m) => m[1] as string);
    expect(words).toContain("runner-failed");
    expect(words.length).toBeGreaterThan(4);
    for (const w of words)
      expect([w, (DISPATCH_CODES as readonly string[]).includes(w)]).toEqual([w, true]);
    for (const m of SRC.matchAll(/echo "(repull-auto: result [^"]*)"/g)) {
      expect(m[1]).toMatch(RESULT_LINE_RE);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Drift against the deployed copy
// ---------------------------------------------------------------------------------------------

const LIVE_ENV_VAR = "NEMAR_REPULL_WORKFLOW_LIVE";
const declaredRaw = process.env[LIVE_ENV_VAR];
const DECLARED =
  declaredRaw && declaredRaw.trim() !== ""
    ? isAbsolute(declaredRaw)
      ? declaredRaw
      : join(REPO_ROOT, declaredRaw)
    : null;
const SIBLINGS = [
  join(REPO_ROOT, "..", ".github", ".github", "workflows", "run-upstream-repull.yml"),
  join(REPO_ROOT, "..", "dot-github", ".github", "workflows", "run-upstream-repull.yml"),
  join(REPO_ROOT, "..", "..", ".github", ".github", "workflows", "run-upstream-repull.yml"),
];
const found = DECLARED ?? SIBLINGS.find((p) => existsSync(p)) ?? null;

describe("the deployed copy", () => {
  test.skipIf(DECLARED === null)(`${LIVE_ENV_VAR} names a file that is present`, () => {
    expect(
      existsSync(DECLARED ?? ""),
      `${LIVE_ENV_VAR}=${declaredRaw} but that file does not exist; the checkout step did not produce it`,
    ).toBe(true);
  });

  describe.skipIf(found === null)("is byte-identical to the authoring copy", () => {
    test("the two files match exactly", () => {
      const live = readFileSync(found ?? "", "utf8");
      if (SRC !== live) {
        const a = SRC.split("\n");
        const b = live.split("\n");
        const i = a.findIndex((line, idx) => line !== b[idx]);
        throw new Error(
          `run-upstream-repull.yml has drifted from nemarDatasets/.github (first difference at line ${
            i + 1
          }). The deploy is a whole-file copy, so any difference is a difference in what runs.`,
        );
      }
      expect(SRC).toBe(live);
    });

    test("the comparison is not vacuous: both files were read", () => {
      expect(SRC.length).toBeGreaterThan(2000);
      expect(readFileSync(found ?? "", "utf8").length).toBeGreaterThan(2000);
    });
  });
});
