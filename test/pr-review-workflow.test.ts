/**
 * The central pull-request review workflow (ADR 0092): the properties its security rests on,
 * pinned so a later "simplification" cannot remove one without a test saying which.
 *
 * The workflow is authored in this repository and deployed by copying it whole into
 * `nemarDatasets/.github` (the same arrangement and the same drift risk as the onboarding
 * workflow, see `test/dataset-workflow-parity.test.ts`). The parity check at the bottom compares
 * the two byte for byte when a deployed copy is available, and SKIPS VISIBLY otherwise: until the
 * file is deployed there is nothing to compare, and a required CI job must not fail on a file that
 * cannot exist yet. Once it is deployed, add the file to the `unit-pure` job's sparse checkout and
 * set NEMAR_PR_REVIEW_WORKFLOW_LIVE there, which turns a missing copy into a failure.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse } from "yaml";

const REPO_ROOT = join(import.meta.dir, "..");
const LOCAL = join(REPO_ROOT, ".github", "dataset-workflows", "run-pr-review.yml");
const SRC = readFileSync(LOCAL, "utf8");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  id?: string;
  "working-directory"?: string;
}
interface Workflow {
  name: string;
  on: { repository_dispatch?: { types: string[] }; [k: string]: unknown };
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: {
    review: {
      permissions: Record<string, string>;
      env: Record<string, string>;
      "timeout-minutes": number;
      steps: Step[];
    };
  };
}

const wf = parse(SRC) as Workflow;
const job = wf.jobs.review;
const step = (name: string): Step => {
  const s = job.steps.find((x) => x.name === name);
  if (!s) throw new Error(`no step named "${name}"`);
  return s;
};

describe("what triggers it", () => {
  test("only a repository_dispatch of run-pr-review, never a pull request or a manual run", () => {
    expect(Object.keys(wf.on)).toEqual(["repository_dispatch"]);
    expect(wf.on.repository_dispatch?.types).toEqual(["run-pr-review"]);
  });

  test("the event type matches what the Worker dispatches", () => {
    const dispatch = readFileSync(
      join(REPO_ROOT, "backend", "src", "services", "github", "dispatch.ts"),
      "utf8",
    );
    expect(dispatch).toContain('event_type: "run-pr-review"');
  });

  test("a newer commit supersedes the run for the same pull request", () => {
    expect(wf.concurrency["cancel-in-progress"]).toBe(true);
    expect(wf.concurrency.group).toContain("dataset_id");
    expect(wf.concurrency.group).toContain("pr_number");
  });
});

describe("what it is allowed to hold", () => {
  test("no permissions by default; the job has contents read and the OIDC token, and nothing that writes", () => {
    expect(wf.permissions).toEqual({});
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  test("the GitHub App token is read-only and for one repository", () => {
    const mint = step("Mint a read-only token for the dataset repository");
    expect(mint.uses).toMatch(/^actions\/create-github-app-token@/);
    expect(mint.with?.["permission-contents"]).toBe("read");
    expect(mint.with?.["permission-pull-requests"]).toBe("read");
    const permissionKeys = Object.keys(mint.with ?? {}).filter((k) => k.startsWith("permission-"));
    expect(permissionKeys.sort()).toEqual(["permission-contents", "permission-pull-requests"]);
    expect(mint.with?.repositories).toBe("${{ env.DATASET_ID }}");
    expect(mint.with?.owner).toBe("nemarDatasets");
  });

  test("the OIDC token is requested for Anthropic's audience", () => {
    const oidc = step("Fetch the GitHub OIDC token for Anthropic");
    expect(oidc.with?.script).toContain("getIDToken('https://api.anthropic.com')");
    expect(oidc.with?.script).toContain("core.setSecret(token)");
  });

  test("the GitHub token reaches only the steps that read the repository, never the model step", () => {
    const withToken = job.steps
      .filter((s) => JSON.stringify(s).includes("steps.app-token.outputs.token"))
      .map((s) => s.name);
    expect(withToken.sort()).toEqual(
      ["Fetch the pull request as git data", "Read the pull request from the API"].sort(),
    );
    const model = step("Review");
    expect(JSON.stringify(model.env)).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|app-token/);
  });

  test("the model step has the federation identity and the callback token, from variables and the job env", () => {
    const env = step("Review").env ?? {};
    for (const k of [
      "ANTHROPIC_FEDERATION_RULE_ID",
      "ANTHROPIC_ORGANIZATION_ID",
      "ANTHROPIC_SERVICE_ACCOUNT_ID",
      "ANTHROPIC_WORKSPACE_ID",
    ]) {
      expect(env[k]).toBe(`\${{ vars.${k} }}`);
    }
    expect(env.ANTHROPIC_IDENTITY_TOKEN_FILE).toContain("anthropic-oidc.jwt");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(job.env.PR_REVIEW_CALLBACK_TOKEN).toBe(
      "${{ github.event.client_payload.callback_token }}",
    );
  });

  test("no API key is configured anywhere in the file", () => {
    expect(SRC).not.toMatch(/ANTHROPIC_API_KEY|secrets\.ANTHROPIC/);
  });
});

describe("the dispatch payload is untrusted", () => {
  test("payload fields reach the shell only through env, never inline in a run block", () => {
    for (const s of job.steps) {
      if (s.run) expect(s.run).not.toContain("client_payload");
      if (s.run) expect(s.run).not.toMatch(/\$\{\{\s*github\.event/);
    }
    for (const field of [
      "dataset_id",
      "pr_number",
      "head_sha",
      "review_id",
      "environment",
      "callback_token",
    ]) {
      expect(Object.values(job.env).some((v) => v.includes(`client_payload.${field}`))).toBe(true);
    }
  });

  test("every field is validated before anything uses it", () => {
    const validate = step("Validate the dispatch");
    expect(job.steps[0].name).toBe("Validate the dispatch");
    for (const re of ["(nm|xx|on)[0-9]{6}", "[0-9a-f]{40}", "production", "dev"]) {
      expect(validate.run).toContain(re);
    }
    expect(validate.run).toContain("::add-mask::$PR_REVIEW_CALLBACK_TOKEN");
  });

  test("the pull request is re-read from the API and handed to the script, not taken from the payload", () => {
    expect(step("Read the pull request from the API").run).toContain(
      'gh api "repos/nemarDatasets/${DATASET_ID}/pulls/${PR_NUMBER}"',
    );
    expect(step("Review").run).toContain('--pr-json "$RUNNER_TEMP/pr.json"');
    expect(step("Review").run).toContain('--fetched-head "$FETCHED_SHA"');
  });
});

describe("nothing from the pull request runs", () => {
  test("the repository is fetched with init and fetch, and never checked out", () => {
    const fetch = step("Fetch the pull request as git data").run ?? "";
    expect(fetch).toContain("git init");
    expect(fetch).toContain("git fetch");
    expect(fetch).toContain("--filter=blob:none");
    expect(fetch).toContain("core.hooksPath /dev/null");
    expect(fetch).not.toMatch(/git (checkout|clone|worktree|reset|merge|pull|switch)\b/);
    expect(SRC).not.toMatch(
      /uses: actions\/checkout@v\d+\s*\n\s*with:\s*\n\s*repository: nemarDatasets/,
    );
  });

  test("a fork is read through the pull ref on the base repository", () => {
    expect(step("Fetch the pull request as git data").run).toContain(
      '"+refs/pull/${PR_NUMBER}/head:refs/remotes/pr/head"',
    );
  });

  test("the only code that runs is the script checked out from nemar-cli main", () => {
    const checkout = step("Check out the review script");
    expect(checkout.with?.repository).toBe("nemarOrg/nemar-cli");
    expect(checkout.with?.ref).toBe("main");
    expect(checkout.with?.["persist-credentials"]).toBe(false as never);
    for (const s of job.steps) {
      if (s.run?.includes("bun run")) {
        expect(s["working-directory"]).toBe("tool");
        expect(s.run).toMatch(/bun run scripts\/ci\/pr-review\.ts (review|fail)/);
      }
    }
    expect(SRC).not.toMatch(/\$RUNNER_TEMP\/repo\/(?!\.git)[^\s"']*\.(sh|ts|js|py)/);
  });
});

describe("failure and logging", () => {
  test("a job that fails before the script can report still tells the Worker", () => {
    const last = job.steps[job.steps.length - 1];
    expect(last.if).toBe("failure()");
    expect(last.run).toContain("pr-review.ts fail");
    expect(last.run).toContain("--error workflow_failed");
  });

  test("a missing federation variable is reported as a sign-in failure, with a clear message", () => {
    const check = step("Check the federation configuration");
    expect(check.run).toContain("--error auth_failed");
    expect(check.run).toContain("::error::");
  });

  test("nothing in the file echoes the payload or a token into the public log", () => {
    expect(SRC).not.toMatch(
      /echo[^\n]*(callback_token|PR_REVIEW_CALLBACK_TOKEN|GH_TOKEN|\$auth)[^\n]*(?<!add-mask::[^\n]*)$/m,
    );
    for (const s of job.steps) {
      expect(s.run ?? "").not.toMatch(/\bset -x\b/);
      expect(s.run ?? "").not.toMatch(/cat\s+[^\n]*(pr\.json|anthropic-oidc)/);
    }
  });

  test("a job cannot run for ever", () => {
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(30);
  });
});

// ---------------------------------------------------------------------------------------------
// Drift against the deployed copy
// ---------------------------------------------------------------------------------------------

const LIVE_ENV_VAR = "NEMAR_PR_REVIEW_WORKFLOW_LIVE";
const declaredRaw = process.env[LIVE_ENV_VAR];
const DECLARED =
  declaredRaw && declaredRaw.trim() !== ""
    ? isAbsolute(declaredRaw)
      ? declaredRaw
      : join(REPO_ROOT, declaredRaw)
    : null;
const SIBLINGS = [
  join(REPO_ROOT, "..", ".github", ".github", "workflows", "run-pr-review.yml"),
  join(REPO_ROOT, "..", "dot-github", ".github", "workflows", "run-pr-review.yml"),
  join(REPO_ROOT, "..", "..", ".github", ".github", "workflows", "run-pr-review.yml"),
];
const found = DECLARED ?? SIBLINGS.find((p) => existsSync(p)) ?? null;

describe("the deployed copy", () => {
  test("the authoring copy says where it is deployed", () => {
    expect(SRC).toContain("Deploy to: nemarDatasets/.github/.github/workflows/run-pr-review.yml");
  });

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
          `run-pr-review.yml has drifted from nemarDatasets/.github (first difference at line ${
            i + 1
          }). The deploy is a whole-file copy, so any difference is a difference in what runs.`,
        );
      }
      expect(SRC).toBe(live);
    });
  });
});
