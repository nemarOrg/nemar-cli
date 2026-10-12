/**
 * Workflow YAML Validation Tests
 *
 * Validates that all CI workflow templates in deployWorkflows() produce
 * syntactically valid YAML. This prevents regressions like #285 where
 * unescaped \n in JS template literals broke the deployed YAML.
 *
 * It also checks the repository's own workflows: how the test workflow routes changes
 * to jobs, and that every workflow that calls `gh` gives it a repository (the last
 * describe block).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { buildEnrichmentCommitPayload } from "../backend/src/services/enrich-dataset";
import { getWorkflowTemplates } from "../backend/src/services/github";
import { VALIDATOR_VERSION } from "../src/lib/bids-validator";
import validatorPin from "../validator-version.json" with { type: "json" };

describe("CI workflow templates", () => {
  const templates = getWorkflowTemplates();

  test("all templates produce valid YAML", () => {
    for (const { path, content } of templates) {
      let parsed: unknown;
      try {
        parsed = parse(content);
      } catch (err) {
        throw new Error(
          `${path}: Invalid YAML - ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe("object");
    }
  });

  test("all templates have required GitHub Actions top-level keys", () => {
    for (const { path, content } of templates) {
      const parsed = parse(content) as Record<string, unknown>;
      expect(parsed.name).toBeDefined();
      expect(parsed.on).toBeDefined();
      expect(parsed.jobs).toBeDefined();
    }
  });

  test("webhook URLs target the canonical api.nemar.org host", () => {
    for (const { path, content } of templates) {
      // The legacy api.osc.earth host is in read-only buffer mode and will be
      // sunset; templates emitted into dataset repos must target SCCN prod.
      expect(content).not.toContain("api.osc.earth");
      if (content.includes("/webhooks/")) {
        expect(content).toMatch(/https:\/\/api\.nemar\.org\/webhooks\//);
      }
    }
  });

  test("buildEnrichmentCommitPayload returns the contract field set", () => {
    // The llm-enrichment.yml Action reads exactly these field names via jq.
    // Pin the contract so a typo (`bidsignore_entry`, dropped key) is caught
    // by a unit test instead of by a silent no-op on the Action side.
    const payload = buildEnrichmentCommitPayload(
      '{"hello":"world"}',
      [".nemar/", "extra"],
      "Update X",
    );
    expect(payload.metadata_path).toBe(".nemar/metadata.json");
    expect(payload.metadata_content).toBe('{"hello":"world"}');
    expect(payload.bidsignore_entries).toEqual([".nemar/", "extra"]);
    expect(payload.commit_message).toBe("Update X");
    // The set of keys IS the contract; any future addition must be explicit.
    expect(Object.keys(payload).sort()).toEqual([
      "bidsignore_entries",
      "commit_message",
      "metadata_content",
      "metadata_path",
    ]);
  });

  test("llm-enrichment.yml is no longer shipped per-repo (centralized, #602)", () => {
    // The template is relocated to
    // `nemarDatasets/.github/.github/workflows/run-enrichment.yml` and
    // triggered via the Worker's /webhooks/github push handler. A future
    // edit that adds it back to deployWorkflows() would defeat the
    // centralization; pin the absence.
    const llm = templates.find((t) => t.path.endsWith("llm-enrichment.yml"));
    expect(llm).toBeUndefined();
  });

  test("version-doi.yml is no longer shipped per-repo (centralized, #606)", () => {
    // The template is relocated to
    // `nemarDatasets/.github/.github/workflows/run-version-doi.yml` and
    // triggered via the Worker's /webhooks/github tag-push handler. Pin
    // the absence so a future edit can't accidentally re-ship it.
    const versionDoi = templates.find((t) => t.path.endsWith("version-doi.yml"));
    expect(versionDoi).toBeUndefined();
  });

  test("generate-archive.yml is no longer shipped per-repo (centralized, #608)", () => {
    // The template is relocated to
    // `nemarDatasets/.github/.github/workflows/run-generate-archive.yml`.
    // The archiver-v7 pin still matters but is now reviewed on that
    // workflow's PR; pin the absence here so a re-shipment is caught.
    const archive = templates.find((t) => t.path.endsWith("generate-archive.yml"));
    expect(archive).toBeUndefined();
  });

  test("shim templates mint App tokens and never reference secrets.GITHUB_TOKEN", () => {
    // Each shim template authenticates as the App and dispatches to
    // nemarDatasets/.github; the token must be scoped to `.github` (where
    // the dispatch lands) NOT to the current repo. The central workflow
    // mints its own per-dataset token internally for the checkout step.
    // Phases #602/#606/#608 already removed their per-repo templates;
    // Phase 4 (#610) replaces bids-validation.yml + pr-merge.yml with
    // shims that follow this contract.
    const shimTemplates = ["pr-merge.yml", "bids-validation.yml", "version-check.yml"];
    for (const name of shimTemplates) {
      const tpl = templates.find((t) => t.path.endsWith(name));
      expect(tpl, `${name} missing from templates`).toBeDefined();
      if (!tpl) continue;
      expect(tpl.content).not.toContain("secrets.GITHUB_TOKEN");

      const parsed = parse(tpl.content) as {
        jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
      };
      for (const [jobName, job] of Object.entries(parsed.jobs)) {
        const mintIdx = job.steps.findIndex((s) => s.uses === "actions/create-github-app-token@v1");
        // Not every job in a shim template mints (e.g. pr-merge's
        // cleanup-staging job uses AWS only). Only check when present.
        if (mintIdx < 0) continue;
        // Ordering: mint must be the first step so subsequent
        // dispatch calls can reference its outputs.
        expect(
          mintIdx,
          `${name}:${jobName} app-token step must be first (was index ${mintIdx})`,
        ).toBe(0);
        const mintWith = (job.steps[mintIdx].with ?? {}) as Record<string, unknown>;
        expect(mintWith["app-id"]).toBe("${{ secrets.NEMAR_APP_ID }}");
        expect(mintWith["private-key"]).toBe("${{ secrets.NEMAR_APP_PRIVATE_KEY }}");
        expect(mintWith.owner).toBe("nemarDatasets");
        // Phase 4 contract: shims mint a token scoped to .github (so they
        // can call repos/.github/dispatches), not the current dataset repo.
        // The central workflows on .github mint their own per-dataset
        // tokens for actual writes against the target repo.
        expect(mintWith.repositories).toBe(".github");

        // Any GH_TOKEN env in the rest of the job's steps must reference
        // the minted token, not a stale `secrets.GITHUB_TOKEN` left behind.
        for (const step of job.steps) {
          const env = (step.env ?? {}) as Record<string, unknown>;
          if ("GH_TOKEN" in env) {
            expect(env.GH_TOKEN).toBe("${{ steps.app-token.outputs.token }}");
          }
        }
      }
    }
  });

  test("shim templates dispatch to nemarDatasets/.github (centralization endstate)", () => {
    // The bids-validation and pr-merge shims must hit
    // repos/nemarDatasets/.github/dispatches with the right event_type so
    // the central workflows on .github receive the request. A future edit
    // that points the dispatch back at the dataset repo would undo the
    // centralization without obvious symptoms (the legacy workflows have
    // been stripped from dataset repos).
    const shimContracts: Array<{ name: string; eventType: string }> = [
      { name: "bids-validation.yml", eventType: "run-bids-validation" },
      { name: "pr-merge.yml", eventType: "run-pr-merge" },
      { name: "version-check.yml", eventType: "run-version-check" },
    ];
    for (const { name, eventType } of shimContracts) {
      const tpl = templates.find((t) => t.path.endsWith(name));
      expect(tpl, `${name} missing from templates`).toBeDefined();
      if (!tpl) continue;
      expect(tpl.content).toContain('"repos/nemarDatasets/.github/dispatches"');
      expect(tpl.content).toContain(`event_type=${eventType}`);
      expect(tpl.content).toContain('"client_payload[dataset_id]=$DATASET_ID"');
    }
  });

  test("bids-validation shim interpolates VALIDATOR_VERSION into the dispatch payload", () => {
    // Code-review #12 fix: the central workflow has no way to know which
    // validator version the CLI is currently pinned to, so the shim must
    // pass it as a client_payload field. The literal value lives in
    // validator-version.json and propagates through src/lib/bids-validator.ts
    // -> VALIDATOR_VERSION -> the shim's template-literal interpolation.
    const tpl = templates.find((t) => t.path.endsWith("bids-validation.yml"));
    expect(tpl, "bids-validation.yml missing from templates").toBeDefined();
    if (!tpl) return;
    // The shim must include the field, AND the value must match the pin.
    expect(tpl.content).toMatch(/client_payload\[validator_version\]=[0-9]+\.[0-9]+\.[0-9]+/);
    expect(tpl.content).toContain(`client_payload[validator_version]=${VALIDATOR_VERSION}`);
  });

  // The "App-token in BOTH jobs" contract for version-doi was specific to
  // the per-repo template. With Phase 2 centralization (#606) the
  // equivalent invariant lives in the run-version-doi.yml on
  // nemarDatasets/.github and is reviewed in that PR; this test is
  // removed rather than asserting a property of a template that no longer
  // ships from this repo.

  test("CLI BIDS validator pin stays in lockstep with the version-of-record", () => {
    // After Phase 4 (#610) the per-repo bids-validation.yml is a shim
    // and no longer contains the validator version — the central
    // run-bids-validation.yml on nemarDatasets/.github runs the
    // validator. The validator-version.json pin remains the source of
    // truth that the CLI runtime uses; this assertion stays so a future
    // CLI change can't drift from the pin file.
    expect(VALIDATOR_VERSION).toBe(validatorPin.version);
    expect(VALIDATOR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // The "read-only templates stay on the auto-token" test asserted that
  // version-check.yml carries no App-token step. Phase 4 (#610) turns it
  // into a dispatch shim, which must mint a token scoped to .github to
  // reach repos/nemarDatasets/.github/dispatches -- so the property no
  // longer holds, and version-check.yml was the list's only entry. Rather
  // than keep a vacuous loop, its coverage moved into the two shim tests
  // above, which are strictly stronger: they pin the token scoping, the
  // mint-step ordering, and the dispatch event_type. Same treatment the
  // bids-validation and generate-archive templates got in earlier phases.

  test("no literal newlines inside shell strings (escape regression)", () => {
    for (const { path, content } of templates) {
      // In valid YAML, printf format strings and jq arguments should
      // contain the two-character sequence \n, not a real newline.
      // A real newline inside a single-quoted shell string would appear
      // as a line ending with an unclosed quote.
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();
        // Skip YAML keys, list items, conditionals, and shell comments
        if (
          trimmed.startsWith("name:") ||
          trimmed.startsWith("-") ||
          trimmed.startsWith("if:") ||
          trimmed.startsWith("#")
        ) {
          continue;
        }
        // Check for lines that end with an unclosed single quote
        // (indicating a literal newline broke the string)
        const singleQuotes = (line.match(/'/g) || []).length;
        if (singleQuotes % 2 !== 0) {
          throw new Error(
            `${path}:${i + 1}: Possible unescaped newline in shell string - odd number of single quotes: ${trimmed}`,
          );
        }
      }
    }
  });
});

describe("the repo's own test workflow routes changes to jobs", () => {
  /**
   * `.github/workflows/test.yml` decides which jobs run from a
   * `dorny/paths-filter` result, and a path matched by NO filter runs NOTHING:
   * the PR goes green having been compiled by nothing at all. That is not a
   * hypothetical -- `shared/**` (the wire contract, the facet vocabulary, the
   * two published Zarr JSON Schemas) was imported by both `src/` and
   * `backend/` and matched by neither filter, so a shared-only PR merged
   * untested.
   *
   * Asserted here rather than left to review, because the failure is silent in
   * exactly the direction nobody checks: a green PR with no jobs.
   */
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8"),
  ) as {
    jobs: Record<string, { if?: string; outputs?: Record<string, string>; steps?: unknown[] }>;
  };

  const filterNames = (): string[] => {
    const steps = (workflow.jobs.changes.steps ?? []) as { with?: { filters?: string } }[];
    const filters = steps.find((s) => s.with?.filters)?.with?.filters ?? "";
    // Top-level keys of the filters block: `name:` at zero indentation.
    return [...filters.matchAll(/^(\w+):/gm)].map((m) => m[1]);
  };

  test("every declared filter is exported as a job output", () => {
    // A filter with no output is unreadable by every downstream `if:`, which
    // evaluates to false and skips the job -- the same silent nothing.
    const outputs = Object.keys(workflow.jobs.changes.outputs ?? {});
    for (const name of filterNames()) {
      expect(outputs).toContain(name);
    }
  });

  test("shared/** has a filter, and gates the jobs that compile it", () => {
    expect(filterNames()).toContain("shared");
    for (const job of ["lint", "unit-pure", "integration-dev"]) {
      expect(workflow.jobs[job]?.if ?? "").toContain("outputs.shared == 'true'");
    }
  });

  test("workflow files have a filter, and gate lint and unit-pure alike", () => {
    // test/workflow-yaml.test.ts polices every workflow, but a pull request that edits
    // only a workflow matches no other filter and would run neither job. Both jobs, not
    // just the one that runs the test: they are required checks, and a required check
    // that is skipped blocks the merge.
    expect(filterNames()).toContain("workflows");
    for (const job of ["lint", "unit-pure"]) {
      expect(workflow.jobs[job]?.if ?? "", job).toContain("outputs.workflows == 'true'");
    }
    const filters = (workflow.jobs.changes.steps as { with?: { filters?: string } }[]).find(
      (s) => s.with?.filters,
    )?.with?.filters;
    expect(filters).toContain("'.github/workflows/**'");
    expect(filters).toContain("'.github/dataset-workflows/**'");
  });

  test("the source trees the jobs build all have a filter", () => {
    // If a new top-level source directory appears without one, it is invisible
    // to CI. Keep this list in step with what the jobs actually compile.
    for (const name of ["cli", "backend", "tests", "shared", "zarr"]) {
      expect(filterNames()).toContain(name);
    }
  });
});

describe("every workflow that calls gh gives it a repository", () => {
  /**
   * `gh` finds the repository it acts on by asking git for the remote. A job with no
   * `actions/checkout` step has no git repository, so `gh issue list` dies with "failed to
   * run git: fatal: not a git repository" unless the repository is named some other way.
   * `check-summary-drift.yml` was exactly that job: it had no checkout, no `GH_REPO` and no
   * `--repo`, so every scheduled run failed (20 of 20 on record, the first on 2026-06-01)
   * and the issue the workflow exists to file was never opened. Nothing noticed, because a
   * red scheduled run on a workflow nobody watches is silence (ADR 0053).
   *
   * Three rules, all enforced over every workflow the repository ships:
   *
   * 1. A `gh` call that needs a repository has one: an earlier checkout of this repository
   *    in the job, `GH_REPO` in the workflow, job or step environment, or `--repo`.
   * 2. A lookup that decides "does an issue exist" never turns its own failure into "no".
   *    `EXISTING=$(gh issue list ... || echo "")` reads an API error as an empty result and
   *    files a duplicate; an empty result is fine, an error must fail the step.
   * 3. `gh label create` does not discard its stderr or its exit code. A label step that
   *    ended in `>/dev/null 2>&1 || true` hid the missing `drift` label for twenty weeks.
   *
   * The analysis is static text over parsed YAML, so it can be wrong in both directions;
   * the controls below pin the cases it has to get right, and that it reports a defect at
   * all (a scanner that matches nothing passes everything).
   */
  interface Step {
    name?: string;
    uses?: string;
    run?: string;
    env?: Record<string, unknown>;
    with?: Record<string, unknown>;
    shell?: string;
    "continue-on-error"?: boolean;
  }
  interface Job {
    env?: Record<string, unknown>;
    steps?: Step[];
  }
  interface Doc {
    env?: Record<string, unknown>;
    jobs?: Record<string, Job>;
  }
  interface GhCall {
    /** The gh command group: `issue` in `gh issue list`. */
    group: string;
    /** The subcommand: `list` in `gh issue list`. */
    action: string;
    /** The whole invocation, from `gh` to the end of its line or the next `gh`. */
    text: string;
  }

  /** The groups that resolve `{owner}/{repo}` from the git remote when not told otherwise. */
  // `gh repo` is left out on purpose: it takes its repository positionally, so a bare
  // `gh repo clone owner/name` needs no context and the two cannot be told apart by flags.
  const REPO_SCOPED_GROUPS = new Set([
    "issue",
    "pr",
    "label",
    "release",
    "run",
    "workflow",
    "secret",
    "variable",
    "cache",
    "ruleset",
    "browse",
  ]);

  /**
   * Commands that run another command and pass its status on, so `retry gh issue list` and
   * `timeout 30 gh issue create` are `gh` calls too. `retry` is the helper the issue-filing
   * workflows define; the rest are the usual suspects.
   */
  const WRAPPERS = String.raw`(?:(?:retry|command|exec|time|nohup|sudo|env|timeout\s+\S+|\w+=\S*)\s+)*`;

  /**
   * Where a `gh` may start: the beginning of a line, after a separator or a subshell, after
   * a shell keyword, or after a `VAR=value` prefix, optionally behind a wrapper. Group 1 is
   * the prefix, 2 the whitespace and wrappers, 3 the gh command group.
   */
  const GH_AT_COMMAND_POSITION = new RegExp(
    String.raw`(^|[;&|(\`{!]|\b(?:then|do|else|elif|if|while|until)\s|=\S*\s)(\s*${WRAPPERS})gh\s+([a-z][a-z-]*)`,
    "g",
  );

  /** A failure turned into success: `|| true`, `|| :`, `|| echo ""`, `|| VAR=""`. */
  const SWALLOWS_FAILURE =
    /\|\|\s*(?:true|:|echo(?:\s+(?:""|''))?|printf\s+(?:""|'')|[A-Za-z_][A-Za-z0-9_]*=(?:""|'')?)\s*\)?\s*(?:;|$)/;

  const DISCARDS_STDERR = /(?:2>\s*\/dev\/null|&>\s*\/dev\/null|>\s*\/dev\/null\s+2>&1)/;

  /** A script as the shell sees it: continuations joined, comments and heredoc bodies gone. */
  function logicalLines(script: string): string[] {
    const out: string[] = [];
    let heredocEnd: string | null = null;
    let pending = "";
    for (const raw of script.split("\n")) {
      if (heredocEnd !== null) {
        if (raw.trim() === heredocEnd) heredocEnd = null;
        continue;
      }
      const line = pending + raw;
      if (/\\\s*$/.test(line)) {
        pending = line.replace(/\\\s*$/, " ");
        continue;
      }
      pending = "";
      if (line.trim().startsWith("#")) continue;
      out.push(line);
      // `<<<` is a here-string, not a heredoc: the lookarounds keep it out.
      const heredoc = line.match(/(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
      if (heredoc) heredocEnd = heredoc[2];
    }
    if (pending) out.push(pending);
    return out;
  }

  function ghCalls(script: string): GhCall[] {
    const calls: GhCall[] = [];
    for (const line of logicalLines(script)) {
      const starts = [...line.matchAll(GH_AT_COMMAND_POSITION)];
      starts.forEach((m, i) => {
        const from = (m.index ?? 0) + m[1].length + m[2].length;
        const to = i + 1 < starts.length ? (starts[i + 1].index ?? line.length) : line.length;
        const text = line.slice(from, to);
        calls.push({ group: m[3], action: text.split(/\s+/)[2] ?? "", text });
      });
    }
    return calls;
  }

  const hasRepoFlag = (call: GhCall) => /(?:^|\s)(?:--repo|-R)(?:\s|=)/.test(call.text);

  /** `gh api repos/o/n/...` names its repository; `gh api repos/{owner}/{repo}/...` does not. */
  const needsRepository = (call: GhCall) =>
    call.group === "api"
      ? /\{(?:owner|repo|branch)\}/.test(call.text)
      : REPO_SCOPED_GROUPS.has(call.group);

  const namesRepo = (env: Record<string, unknown> | undefined) =>
    typeof env?.GH_REPO === "string" && env.GH_REPO.trim() !== "";

  /**
   * A checkout of THIS repository at the workspace root. One with `repository:` or `path:`
   * leaves the root without this repository's git metadata, so it does not count.
   */
  const checksOutThisRepo = (step: Step) =>
    typeof step.uses === "string" &&
    step.uses.startsWith("actions/checkout@") &&
    !step.with?.repository &&
    !step.with?.path;

  const isIssueLookup = (call: GhCall) =>
    (call.group === "issue" && ["list", "view", "status"].includes(call.action)) ||
    (call.group === "search" && call.action === "issues");

  function findDefects(label: string, doc: Doc): string[] {
    const defects: string[] = [];
    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      const steps = job.steps ?? [];
      steps.forEach((step, index) => {
        if (typeof step.run !== "string") return;
        const where = `${label}: job "${jobName}", step "${step.name ?? `#${index + 1}`}"`;
        const covered =
          namesRepo(doc.env) ||
          namesRepo(job.env) ||
          namesRepo(step.env) ||
          steps.slice(0, index).some(checksOutThisRepo);
        for (const call of ghCalls(step.run)) {
          const shown = call.text.slice(0, 70);
          if (needsRepository(call) && !covered && !hasRepoFlag(call)) {
            defects.push(
              `${where}: \`${shown}\` has no repository (no checkout, GH_REPO or --repo)`,
            );
          }
          if (isIssueLookup(call) && SWALLOWS_FAILURE.test(call.text)) {
            defects.push(`${where}: \`${shown}\` turns a failed lookup into "no issue"`);
          }
          if (
            call.group === "label" &&
            call.action === "create" &&
            (DISCARDS_STDERR.test(call.text) || SWALLOWS_FAILURE.test(call.text))
          ) {
            defects.push(`${where}: \`${shown}\` hides a failed label create`);
          }
        }
      });
    }
    return defects;
  }

  const defectsOf = (label: string, yaml: string) => findDefects(label, parse(yaml) as Doc);

  const ROOT = join(import.meta.dir, "..");
  const WORKFLOW_DIRS = [".github/workflows", ".github/dataset-workflows"];

  function shippedWorkflows(): { label: string; text: string }[] {
    const files = WORKFLOW_DIRS.flatMap((dir) =>
      readdirSync(join(ROOT, dir))
        .filter((f) => f.endsWith(".yml"))
        .sort()
        .map((f) => ({ label: `${dir}/${f}`, text: readFileSync(join(ROOT, dir, f), "utf8") })),
    );
    // The per-dataset shims deploy into every dataset repository, where a `gh` with no
    // repository would fail the same way.
    const templates = getWorkflowTemplates().map((t) => ({
      label: `template ${t.path}`,
      text: t.content,
    }));
    return [...files, ...templates];
  }

  const drift = () => readFileSync(join(ROOT, ".github/workflows/check-summary-drift.yml"), "utf8");

  test("no workflow the repository ships has a defect", () => {
    const defects = shippedWorkflows().flatMap(({ label, text }) => defectsOf(label, text));
    expect(defects).toEqual([]);
  });

  test("the scan reaches the workflows that file issues", () => {
    // A scanner that matched no `gh` call would pass the test above for any input.
    const labels = shippedWorkflows().map((w) => w.label);
    for (const expected of [
      ".github/workflows/check-summary-drift.yml",
      ".github/workflows/nightly-tests.yml",
      ".github/workflows/npm-publish.yml",
      ".github/dataset-workflows/run-pr-review.yml",
    ]) {
      expect(labels).toContain(expected);
    }
    const issueCalls = parse(drift()) as Doc;
    const steps = Object.values(issueCalls.jobs ?? {}).flatMap((j) => j.steps ?? []);
    const groups = steps.flatMap((s) => (s.run ? ghCalls(s.run).map((c) => c.group) : []));
    expect(groups.filter((g) => g === "issue").length).toBeGreaterThanOrEqual(9);
    expect(groups.filter((g) => g === "label").length).toBeGreaterThanOrEqual(2);
  });

  test("the drift workflow without its GH_REPO is caught, step by step", () => {
    // The real file with the one line that fixed it removed: the defect as it shipped.
    const broken = drift().replace(/^\s*GH_REPO:.*\n/gm, "");
    expect(broken, "the mutation must apply").not.toBe(drift());
    const defects = defectsOf("check-summary-drift.yml", broken);
    for (const step of [
      "Ensure issue labels exist",
      "Open / update drift issue",
      "Open / update probe-broken issue",
      "Open / update report-broken issue",
    ]) {
      expect(
        defects.some((d) => d.includes(`step "${step}"`) && d.includes("has no repository")),
        `${step} should be reported`,
      ).toBe(true);
    }
  });

  test("the drift workflow's old lookup and label swallows are caught", () => {
    // Re-introduce each swallow the fix removed into the real file: the lookup in every step
    // that has one, then the label create.
    const lookup = drift().replaceAll(/\.number \/\/ empty"\)/g, `.number // empty" || echo "")`);
    expect(lookup, "the lookup mutation must apply").not.toBe(drift());
    const swallowed = defectsOf("drift", lookup).filter((d) => d.includes("failed lookup"));
    for (const step of [
      "Open / update drift issue",
      "Open / update probe-broken issue",
      "Open / update report-broken issue",
    ]) {
      expect(
        swallowed.some((d) => d.includes(`step "${step}"`)),
        `${step} should be reported`,
      ).toBe(true);
    }

    const label = drift().replace(
      /gh label create "\$name" --color "\$color" --description "\$description"/,
      `gh label create "$name" --color "$color" --description "$description" >/dev/null 2>&1 || true`,
    );
    expect(label, "the label mutation must apply").not.toBe(drift());
    expect(defectsOf("drift", label).some((d) => d.includes("failed label create"))).toBe(true);
  });

  describe("the issue-filing steps of the drift and nightly workflows", () => {
    // Structure the scanner cannot see: how a lookup is retried, which step may fail without
    // stopping the job, and that a title and the lookup that finds it share one prefix.
    // Each of these was a way to quietly lose the weekly alarm, or to file it twice.
    const LOOKUP_STEPS = [
      "Open / update drift issue",
      "Open / update probe-broken issue",
      "Open / update report-broken issue",
    ];
    const stepsOf = (text: string): Step[] =>
      Object.values((parse(text) as Doc).jobs ?? {}).flatMap((j) => j.steps ?? []);
    const stepNamed = (steps: Step[], name: string): Step => {
      const found = steps.find((s) => s.name === name);
      if (!found) throw new Error(`no step named "${name}"`);
      return found;
    };
    const driftSteps = () => stepsOf(drift());
    const prefixOf = (run: string) => run.match(/^\s*PREFIX="([^"]+)"$/m)?.[1];

    test("each lookup declares its prefix once, builds the title from it and matches on it", () => {
      for (const name of LOOKUP_STEPS) {
        const run = stepNamed(driftSteps(), name).run ?? "";
        const prefix = prefixOf(run);
        expect(prefix, `${name}: PREFIX="..."`).toBeDefined();
        expect(run.match(/^\s*PREFIX=/gm)?.length, `${name}: PREFIX declared once`).toBe(1);
        // The title starts with the prefix, so the lookup finds the issue the step files.
        const title = run.match(/^\s*TITLE="([^"]*)"$/m)?.[1] ?? "";
        expect(title.startsWith("${PREFIX}"), `${name}: TITLE="${title}"`).toBe(true);
        expect(title.replace("${PREFIX}", prefix ?? "").startsWith(prefix ?? "?")).toBe(true);
        // The lookup keeps only a title with that prefix, and there is no second literal to
        // fall out of step with it.
        expect(run, name).toContain('startswith(\\"${PREFIX}\\")');
        expect(run.match(/startswith\(/g)?.length, `${name}: one startswith`).toBe(1);
      }
    });

    test("no issue prefix is a prefix of another, so one lookup cannot find another's issue", () => {
      const prefixes = LOOKUP_STEPS.map((name) =>
        prefixOf(stepNamed(driftSteps(), name).run ?? ""),
      );
      for (const a of prefixes) {
        for (const b of prefixes) {
          if (a === b) continue;
          expect(b?.startsWith(a ?? "?"), `"${b}" starts with "${a}"`).toBe(false);
        }
      }
      expect(new Set(prefixes).size).toBe(LOOKUP_STEPS.length);
    });

    test("every lookup goes through the retry helper, defined before it is used", () => {
      const steps = driftSteps();
      const helper = steps.findIndex((s) => s.name === "Define the retry helper");
      expect(helper, "the helper step exists").toBeGreaterThanOrEqual(0);
      for (const name of LOOKUP_STEPS) {
        const run = stepNamed(steps, name).run ?? "";
        expect(
          steps.findIndex((s) => s.name === name),
          name,
        ).toBeGreaterThan(helper);
        expect(run, name).toContain('source "$RUNNER_TEMP/retry.sh"');
        expect(run, name).toMatch(/EXISTING=\$\(retry gh issue list /);
        // Failing must stop the step: set -e, and no continue-on-error to soften it.
        expect(run, name).toContain("set -euo pipefail");
        expect(stepNamed(steps, name)["continue-on-error"], name).toBeUndefined();
      }
    });

    test("the label step may fail without stopping the job, and says so loudly", () => {
      const step = stepNamed(driftSteps(), "Ensure issue labels exist");
      expect(step["continue-on-error"]).toBe(true);
      // Not silent: nothing in it discards stderr or the exit status (the scanner's label
      // rule), and a failed create is reported and reflected in the step's own status.
      expect(step.run).toContain('echo "::error::Could not create label');
      expect(step.run).toContain('exit "$failed"');
    });

    test("the nightly lookup uses the same bounded retry as the drift workflow", () => {
      const fn = (run: string) =>
        (run.match(/^\s*retry\(\) \{\n[\s\S]*?\n\s*\}$/m)?.[0] ?? "")
          .split("\n")
          .map((l) => l.trim());
      const driftHelper = fn(stepNamed(driftSteps(), "Define the retry helper").run ?? "");
      expect(driftHelper.length).toBeGreaterThan(5);
      const nightly = stepsOf(
        readFileSync(join(ROOT, ".github/workflows/nightly-tests.yml"), "utf8"),
      ).find((s) => s.run?.includes("gh issue list"));
      expect(nightly, "the nightly lookup step").toBeDefined();
      expect(fn(nightly?.run ?? "")).toEqual(driftHelper);
      expect(nightly?.run).toMatch(/EXISTING=\$\(retry gh issue list /);
    });

    describe("the retry helper itself, as the workflow writes it", () => {
      // The real helper, written by the real step into a temporary directory and run by real
      // bash against a command that really fails a set number of times. It must succeed once
      // the command does, and after the third failure it must FAIL the step that called it.
      const dir = mkdtempSync(join(tmpdir(), "retry-helper-"));
      const helperStep = stepNamed(driftSteps(), "Define the retry helper").run ?? "";
      const run = (script: string) => {
        writeFileSync(join(dir, "write.sh"), helperStep);
        const r = Bun.spawnSync(
          ["bash", "-c", `set -euo pipefail\nbash "${dir}/write.sh"\n${script}`],
          { env: { ...process.env, RUNNER_TEMP: dir, RETRY_DELAY: "0" } },
        );
        return {
          status: r.exitCode,
          out: r.stdout.toString(),
          err: r.stderr.toString(),
          calls: Number(readFileSync(join(dir, "calls"), "utf8").trim()),
        };
      };
      // A command that fails its first $1 calls, then prints "found". Counts its calls.
      const flaky = (failures: number) => `
        echo 0 > "${dir}/calls"
        flaky() { n=$(($(cat "${dir}/calls") + 1)); echo $n > "${dir}/calls"; [ $n -gt ${failures} ] && echo found; }
        source "${dir}/retry.sh"
        set -euo pipefail
      `;

      test("succeeds on the first try without retrying", () => {
        const r = run(`${flaky(0)}\nX=$(retry flaky)\necho "got:$X"`);
        expect(r.status).toBe(0);
        expect(r.out.trim()).toBe("got:found");
        expect(r.calls).toBe(1);
      });

      test("recovers from two failures and prints the result once", () => {
        const r = run(`${flaky(2)}\nX=$(retry flaky)\necho "got:$X"`);
        expect(r.status).toBe(0);
        expect(r.out.trim()).toBe("got:found");
        expect(r.calls).toBe(3);
        expect(r.err).toContain("Attempt 1 of 3 failed");
      });

      test("after the third failure the calling step FAILS and never reads it as no issue", () => {
        const r = run(`${flaky(99)}\nX=$(retry flaky)\necho "reached:$X"`);
        expect(r.status).not.toBe(0);
        expect(r.out).not.toContain("reached");
        expect(r.calls).toBe(3);
        expect(r.err).toContain("Giving up after 3 attempts");
      });

      test("an empty successful result is an empty result, not a failure", () => {
        const r = run(`${flaky(0)}\nempty() { :; }\nX=$(retry empty)\necho "got:[$X]"`);
        expect(r.status).toBe(0);
        expect(r.out.trim()).toBe("got:[]");
      });

      afterAll(() => rmSync(dir, { recursive: true, force: true }));
    });
  });

  describe("a new workflow with the same defect", () => {
    const workflow = (jobBody: string, workflowEnv = "") => `
name: New
on: workflow_dispatch
${workflowEnv}
jobs:
  j:
    runs-on: ubuntu-latest
${jobBody}
`;
    const noCheckout = (stepExtra = "", jobExtra = "") =>
      workflow(`${jobExtra}
    steps:
      - name: file it
${stepExtra}
        run: gh issue create --title t --body b
`);

    test("is reported when the job has no checkout, GH_REPO or --repo", () => {
      expect(defectsOf("new.yml", noCheckout()).length).toBe(1);
    });

    test("is reported when the only checkout is of another repository or path", () => {
      for (const withBlock of ["repository: other/repo", "path: sub"]) {
        const yaml = workflow(`
    steps:
      - uses: actions/checkout@v4
        with:
          ${withBlock}
      - name: file it
        run: gh issue create --title t --body b
`);
        expect(defectsOf("new.yml", yaml).length, withBlock).toBe(1);
      }
    });

    test("is reported when the checkout comes after the gh call", () => {
      const yaml = workflow(`
    steps:
      - name: file it
        run: gh issue create --title t --body b
      - uses: actions/checkout@v4
`);
      expect(defectsOf("new.yml", yaml).length).toBe(1);
    });

    test("is reported behind a wrapper command such as retry or timeout", () => {
      // `retry gh issue create` is a gh call; a scanner that only saw `gh` at the start of a
      // command would stop seeing every call the moment it was wrapped.
      for (const wrapped of [
        "retry gh issue create --title t",
        "timeout 30 gh issue create --title t",
        "env X=1 gh issue create --title t",
        "command gh issue create --title t",
        "sudo gh issue create --title t",
      ]) {
        const yaml = workflow(`
    steps:
      - name: file it
        run: ${wrapped}
`);
        expect(defectsOf("new.yml", yaml).length, wrapped).toBe(1);
      }
      const swallowed = workflow(`
    steps:
      - uses: actions/checkout@v4
      - name: look
        run: |
          EXISTING=$(retry gh issue list --state open --json number --jq '.[0].number' || echo "")
`);
      expect(defectsOf("new.yml", swallowed).length).toBe(1);
    });

    test("is reported after a here-string, which does not start a heredoc", () => {
      // `<<< word` looks like `<< word` to a naive heredoc matcher, which would then skip
      // the rest of the script and report nothing.
      const yaml = workflow(`
    steps:
      - name: file it
        run: |
          grep -q x <<< word
          gh issue create --title t --body b
`);
      expect(defectsOf("new.yml", yaml).length).toBe(1);
    });

    test("is reported for gh api with a {owner}/{repo} placeholder", () => {
      const yaml = workflow(`
    steps:
      - name: call
        run: gh api repos/{owner}/{repo}/issues
`);
      expect(defectsOf("new.yml", yaml).length).toBe(1);
    });

    test("is not reported when the repository is named, however it is named", () => {
      const named: string[] = [
        // A checkout of this repository, before the call.
        workflow(`
    steps:
      - uses: actions/checkout@v4
      - name: file it
        run: gh issue create --title t --body b
`),
        // GH_REPO at each of the three levels.
        noCheckout("        env:\n          GH_REPO: ${{ github.repository }}"),
        noCheckout("", "    env:\n      GH_REPO: ${{ github.repository }}"),
        workflow(
          `
    steps:
      - name: file it
        run: gh issue create --title t --body b
`,
          "env:\n  GH_REPO: ${{ github.repository }}",
        ),
        // --repo, including on a continuation line and after a pipe.
        workflow(`
    steps:
      - name: file it
        run: |
          echo body | gh issue create --repo "$GITHUB_REPOSITORY" \\
            --title t --body-file -
          gh issue list -R "$GITHUB_REPOSITORY" --state open
`),
        // Calls that need no repository: an explicit API path, and text that only looks like
        // a gh invocation (a comment, a heredoc body, a quoted mention).
        workflow(`
    steps:
      - name: call
        run: |
          # then gh issue create is the thing this step does not do
          gh api "repos/o/n/dispatches" -f event_type=x
          python3 << 'EOF'
          gh issue create --title in-a-heredoc
          EOF
          echo "then run gh issue create by hand"
`),
      ];
      named.forEach((yaml, i) => {
        expect(defectsOf("new.yml", yaml), `case ${i}`).toEqual([]);
      });
    });

    test("is reported when a failed issue lookup is swallowed, in any spelling", () => {
      for (const swallow of ['|| echo ""', "|| echo ''", "|| true", "|| :", '|| EXISTING=""']) {
        const yaml = workflow(`
    steps:
      - uses: actions/checkout@v4
      - name: look
        run: |
          EXISTING=$(gh issue list --state open --json number --jq '.[0].number' ${swallow})
`);
        expect(defectsOf("new.yml", yaml).length, swallow).toBe(1);
      }
    });

    test("is not reported when a failed lookup is allowed to fail the step", () => {
      const yaml = workflow(`
    steps:
      - uses: actions/checkout@v4
      - name: look
        run: |
          set -euo pipefail
          EXISTING=$(gh issue list --state open --json number --jq '.[0].number // empty')
          gh label create x --color 000000 || echo "::warning::could not create x"
`);
      expect(defectsOf("new.yml", yaml)).toEqual([]);
    });
  });
});
