/**
 * The pull-request review's offline calibration (`scripts/ci/pr-review-calibrate.ts`, ADR 0107).
 *
 * The calibration runs the review job's own stage flow, so these tests run it for real: a real git
 * repository built in a temporary directory stands in for the dataset GitHub would serve (the one
 * part that needs the network), and the real Anthropic SDK talks to a local server that answers the
 * way the Messages API does, streamed (`helpers/anthropic-sse.ts`). What is checked is what the
 * table says, what it never says (a pull request's text, a model's words), and that nothing is
 * posted anywhere.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CalibrationRow,
  type CalibrationTarget,
  type FetchedPullRequest,
  calibrateMain,
  calibrateOne,
  parseTarget,
  renderTable,
} from "../scripts/ci/pr-review-calibrate";
import { type StandInMessage, replyFor, standInMessage } from "./helpers/anthropic-sse";

let root: string;
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.org",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.org",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
}

function write(dir: string, rel: string, content: string) {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const SECRET = "SMITH-SECRET-NAME";

/** A dataset at 1.0.0 on main, and a branch that bumps it to 1.1.0 with a CHANGES entry. */
function localPullRequest(
  name: string,
  pr: Record<string, unknown> = {},
  opts: { merge?: boolean } = {},
): (t: CalibrationTarget) => FetchedPullRequest {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  write(dir, "dataset_description.json", JSON.stringify({ Name: "Resting EEG", Version: "1.0.0" }));
  write(dir, "CHANGES", "1.0.0 2026-01-01\n - Initial release\n");
  write(dir, "sub-01/eeg/sub-01_task-rest_eeg.json", JSON.stringify({ SamplingFrequency: 256 }));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  const base = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "contrib");
  write(dir, "dataset_description.json", JSON.stringify({ Name: "Resting EEG", Version: "1.1.0" }));
  write(dir, "CHANGES", "1.1.0 2026-10-16\n - Fixed units\n1.0.0 2026-01-01\n - Initial release\n");
  write(dir, "sub-01/eeg/sub-01_task-rest_eeg.json", JSON.stringify({ SamplingFrequency: 512 }));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fix units");
  const head = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  // Merged: main now holds the head, so only the base the pull request recorded still shows it.
  if (opts.merge) git(dir, "merge", "-q", "--ff-only", "contrib");
  return () => ({
    dir,
    base,
    head,
    pr: {
      title: "Correct the sampling rate in the EEG sidecar",
      body: `The sidecar said 256 Hz; the recording is 512 Hz. ${SECRET}`,
      author_association: "NONE",
      base: { repo: { full_name: "nemarDatasets/nm000460" } },
      head: { repo: { full_name: "nemarDatasets/nm000460" } },
      ...pr,
    },
  });
}

const PROCEED = JSON.stringify({ decision: "proceed", note: `Looks like a fix. ${SECRET}` });
const REVIEW = JSON.stringify({
  criteria: { no_degradation: "pass", advances_revision: "pass", material_improvement: "pass" },
  title_ok: true,
  body_ok: true,
  steering: false,
  misleading_body: false,
  findings: [],
  summary: `Fixes the sampling rate. ${SECRET}`,
});

let screenReply: () => StandInMessage | Response = () => standInMessage(PROCEED);
let reviewReply: () => StandInMessage | Response = () =>
  standInMessage(REVIEW, {
    model: "claude-sonnet-5-5",
    usage: { input_tokens: 20000, output_tokens: 8000 },
  });
const requests: Array<{ path: string; model: unknown }> = [];
let server: ReturnType<typeof Bun.serve>;
const SAVED: Record<string, string | undefined> = {};
const SDK_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_IDENTITY_TOKEN",
  "PR_REVIEW_CALLBACK_TOKEN",
];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pr-review-calibrate-"));
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      requests.push({ path: new URL(req.url).pathname, model: body.model });
      return replyFor(body, body.model === "claude-sonnet-5-5" ? reviewReply() : screenReply());
    },
  });
  for (const k of SDK_ENV) {
    SAVED[k] = process.env[k];
    Reflect.deleteProperty(process.env, k);
  }
  process.env.ANTHROPIC_API_KEY = "sk-ant-calibration-stand-in";
});

afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
  for (const k of SDK_ENV) {
    if (SAVED[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = SAVED[k];
  }
});

beforeEach(() => {
  requests.length = 0;
  screenReply = () => standInMessage(PROCEED);
  reviewReply = () =>
    standInMessage(REVIEW, {
      model: "claude-sonnet-5-5",
      usage: { input_tokens: 20000, output_tokens: 8000 },
    });
});

/**
 * Run with the SDK pointed at the stand-in for the length of `fn`. The calibration itself refuses to
 * run with ANTHROPIC_BASE_URL set, so the variable is set only around the one-pull-request call.
 */
async function withStandIn<T>(fn: () => Promise<T>): Promise<T> {
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`;
  try {
    return await fn();
  } finally {
    Reflect.deleteProperty(process.env, "ANTHROPIC_BASE_URL");
  }
}

const target = (expected: CalibrationTarget["expected"] = null): CalibrationTarget => ({
  dataset: "nm000460",
  number: 2,
  expected,
});

describe("which pull requests it reads", () => {
  test("a pull request is a dataset and a number, with an optional expected outcome", () => {
    expect(parseTarget("nm000153#2")).toEqual({ dataset: "nm000153", number: 2, expected: null });
    expect(parseTarget("nemarDatasets/nm000456#1 fail")).toEqual({
      dataset: "nm000456",
      number: 1,
      expected: "fail",
    });
    for (const bad of ["nm000153", "nm153#2", "nm000153#2 maybe", "a/b#1", "nm000153#2 pass x"]) {
      expect(parseTarget(bad), bad).toBeNull();
    }
  });
});

describe("it posts nothing, and the key reaches only the API", () => {
  async function refused(argv: string[], env: Record<string, string> = {}) {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    const lines: string[] = [];
    const quiet = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      return { code: await calibrateMain(argv, () => {}), said: lines.join("\n") };
    } finally {
      console.error = quiet;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
    }
  }

  test("a review's own arguments are refused, by name", async () => {
    for (const flag of ["--environment", "--review-id", "--callback-url", "--repo-dir", "--head"]) {
      const r = await refused(["--pr", "nm000153#2", flag, "x"]);
      expect(r.code, flag).toBe(2);
      expect(r.said).toContain("calibrate posts nothing");
    }
  });

  test("it will not run where a review's callback token is set", async () => {
    const r = await refused(["--pr", "nm000153#2"], { PR_REVIEW_CALLBACK_TOKEN: "t" });
    expect(r.code).toBe(2);
    expect(r.said).toContain("callback token is set");
  });

  test("it will not run while the SDK could be pointed elsewhere, and names the variable, not its value", async () => {
    const r = await refused(["--pr", "nm000153#2"], {
      ANTHROPIC_BASE_URL: "https://gateway.example/secret-path",
    });
    expect(r.code).toBe(2);
    expect(r.said).toContain("ANTHROPIC_BASE_URL is set");
    expect(r.said).not.toContain("gateway.example");
  });

  test("no pull request named is a usage error", async () => {
    expect((await refused([])).code).toBe(2);
    expect((await refused(["--pr", "not-a-pr"])).code).toBe(2);
  });
});

describe("one pull request, through the job's own stage flow", () => {
  test("a clean pull request passes: both stages, their tokens and seconds, and the cost", async () => {
    const row = await withStandIn(() =>
      calibrateOne(target("pass"), root, localPullRequest("clean")),
    );
    expect(row).toMatchObject({
      pr: "nm000460#2",
      files: 3,
      facts: [],
      stage: "full",
      screen: "proceed",
      verdict: "pass",
      check: "success",
      error: null,
      reviewTokens: { input_tokens: 20000, output_tokens: 8000 },
    });
    expect(row.screenTokens).toEqual({ input_tokens: 1200, output_tokens: 300 });
    expect(row.screenSeconds).not.toBeNull();
    expect(row.reviewSeconds).not.toBeNull();
    // 1,200 x 0.10 + 300 x 0.50 + 20,000 x 2 + 8,000 x 10, per million: $0.12.
    expect(row.costUsd).toBe(0.12);
    expect(requests.map((r) => r.model)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect(requests.every((r) => r.path === "/v1/messages")).toBe(true);
  });

  test("a merged pull request is judged on what it changed: the base is the one it recorded", async () => {
    // The pull request is closed and its head is reachable from main: a run of the job's own
    // dispatch checks would call it stale. The calibration reviews it all the same.
    const read = localPullRequest("merged", { state: "closed", merged: true }, { merge: true });
    const row = await withStandIn(() => calibrateOne(target(), root, read));
    expect(row.verdict).toBe("pass");
    expect(row.files).toBe(3);
  });

  test("a stop by the screen is one call and a fail", async () => {
    screenReply = () => standInMessage(JSON.stringify({ decision: "reject", note: "Advert." }));
    const row = await withStandIn(() => calibrateOne(target(), root, localPullRequest("spam")));
    expect(row).toMatchObject({ stage: "screen", screen: "reject", verdict: "fail" });
    expect(row.reviewTokens).toBeNull();
    expect(requests).toHaveLength(1);
  });

  test("a refusal at the review is no verdict, and the screen's tokens are still counted", async () => {
    reviewReply = () => standInMessage(REVIEW, { stop_reason: "refusal" });
    const row = await withStandIn(() => calibrateOne(target(), root, localPullRequest("refused")));
    expect(row).toMatchObject({ verdict: null, error: "model_refused", screen: "proceed" });
    expect(row.screenTokens).not.toBeNull();
    expect(row.costUsd).not.toBeNull();
  });

  test("a pull request that cannot be read is a row that says so, not a crash", async () => {
    const row = await calibrateOne(target(), root, () => {
      throw new Error(`gh failed ${SECRET}`);
    });
    expect(row).toMatchObject({ error: "not_readable", verdict: null });
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });
});

describe("the table", () => {
  test("is closed words and numbers: never a pull request's text or a model's words", async () => {
    const rows: CalibrationRow[] = [];
    rows.push(await withStandIn(() => calibrateOne(target("pass"), root, localPullRequest("t1"))));
    reviewReply = () => standInMessage(REVIEW, { stop_reason: "max_tokens" });
    rows.push(await withStandIn(() => calibrateOne(target("fail"), root, localPullRequest("t2"))));
    const table = renderTable(rows).join("\n");
    expect(table).not.toContain(SECRET);
    expect(table).not.toContain("sampling rate");
    expect(table).toContain("PR");
    expect(table).toContain("EXPECTED");
    expect(table).toContain("no verdict (model_truncated)");
    expect(table).toMatch(
      /nm000460#2 +3 +none +proceed +pass pass pass pass pass +pass +success +pass +yes/,
    );
    expect(table).toContain("claude-haiku-5-5");
    expect(table).toContain("claude-sonnet-5-5");
  });
});
