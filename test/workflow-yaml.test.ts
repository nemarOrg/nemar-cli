/**
 * Workflow YAML Validation Tests
 *
 * Validates that all CI workflow templates in deployWorkflows() produce
 * syntactically valid YAML. This prevents regressions like #285 where
 * unescaped \n in JS template literals broke the deployed YAML.
 */

import { describe, expect, test } from "bun:test";
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

  test("migrated templates mint App tokens and never reference secrets.GITHUB_TOKEN", () => {
    // Each migrated template authenticates as the App with least-privilege
    // repo scope and no static GITHUB_TOKEN. Parsed YAML so input values
    // are pinned exactly (a copy-pasted hardcoded `repositories:` would
    // still pass a substring check; this catches it).
    // llm-enrichment.yml (#602) and version-doi.yml (#606) were removed
    // when centralized to nemarDatasets/.github; their central counterparts
    // have their own App-token discipline reviewed separately.
    const writeTemplates = ["pr-merge.yml"];
    for (const name of writeTemplates) {
      const tpl = templates.find((t) => t.path.endsWith(name));
      expect(tpl, `${name} missing from templates`).toBeDefined();
      if (!tpl) continue;
      expect(tpl.content).not.toContain("secrets.GITHUB_TOKEN");

      const parsed = parse(tpl.content) as { jobs: Record<string, { steps: Array<Record<string, unknown>> }> };
      for (const [jobName, job] of Object.entries(parsed.jobs)) {
        const mintIdx = job.steps.findIndex(
          (s) => s.uses === "actions/create-github-app-token@v1",
        );
        // Not every job in a migrated template mints (e.g. pr-merge's
        // cleanup-staging job uses AWS only). Only check when present.
        if (mintIdx < 0) continue;
        // Ordering: mint must be the first step so subsequent
        // checkout/`gh` calls can reference its outputs.
        expect(
          mintIdx,
          `${name}:${jobName} app-token step must be first (was index ${mintIdx})`,
        ).toBe(0);
        const mintWith = (job.steps[mintIdx].with ?? {}) as Record<string, unknown>;
        expect(mintWith["app-id"]).toBe("${{ secrets.NEMAR_APP_ID }}");
        expect(mintWith["private-key"]).toBe("${{ secrets.NEMAR_APP_PRIVATE_KEY }}");
        expect(mintWith.owner).toBe("nemarDatasets");
        expect(mintWith.repositories).toBe("${{ github.event.repository.name }}");

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

  // The "App-token in BOTH jobs" contract for version-doi was specific to
  // the per-repo template. With Phase 2 centralization (#606) the
  // equivalent invariant lives in the run-version-doi.yml on
  // nemarDatasets/.github and is reviewed in that PR; this test is
  // removed rather than asserting a property of a template that no longer
  // ships from this repo.

  test("CLI and bids-validation template pin the same @bids/validator version (issue #586)", () => {
    expect(VALIDATOR_VERSION).toBe(validatorPin.version);
    expect(VALIDATOR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const tpl = templates.find((t) => t.path.endsWith("bids-validation.yml"));
    expect(tpl, "bids-validation.yml missing from templates").toBeDefined();
    if (!tpl) return;
    expect(tpl.content).toContain(`jsr:@bids/validator@${VALIDATOR_VERSION}`);
    expect(tpl.content).not.toMatch(/jsr:@bids\/validator(?!@\d)/);
  });

  test("read-only / AWS-only templates stay on the auto-token (no App-token step)", () => {
    // bids-validation + version-check do no writes and need no App token.
    // generate-archive.yml (#608) was removed when centralized — its
    // central counterpart on nemarDatasets/.github DOES mint an App token
    // (to check out the target dataset repo), which is reviewed there.
    const readOnlyTemplates = ["bids-validation.yml", "version-check.yml"];
    for (const name of readOnlyTemplates) {
      const tpl = templates.find((t) => t.path.endsWith(name));
      expect(tpl, `${name} missing from templates`).toBeDefined();
      if (!tpl) continue;
      expect(tpl.content).not.toContain("create-github-app-token");
    }
  });

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
