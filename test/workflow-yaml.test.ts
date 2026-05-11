/**
 * Workflow YAML Validation Tests
 *
 * Validates that all CI workflow templates in deployWorkflows() produce
 * syntactically valid YAML. This prevents regressions like #285 where
 * unescaped \n in JS template literals broke the deployed YAML.
 */

import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { buildEnrichmentCommitPayload } from "../backend/src/routes/webhooks";
import { getWorkflowTemplates } from "../backend/src/services/github";

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

  test("llm-enrichment opts into client_commits and has write permission", () => {
    // Phase 5 contract: the Action sends client_commits:true so the Worker
    // returns the metadata payload and skips its own commit. The Action
    // commits with the per-repo GITHUB_TOKEN, moving the REST traffic off
    // the shared admin PAT.
    const llm = templates.find((t) => t.path.endsWith("llm-enrichment.yml"));
    expect(llm).toBeDefined();
    if (!llm) return;
    expect(llm.content).toContain("\\\"client_commits\\\": true");
    expect(llm.content).toContain("actions/checkout@v4");
    // permissions should be job-scoped, not workflow-scoped, so future jobs
    // added to this template don't silently inherit write.
    const parsed = parse(llm.content) as {
      permissions?: unknown;
      jobs: Record<string, { permissions?: { contents?: string } }>;
    };
    expect(parsed.permissions).toBeUndefined();
    expect(parsed.jobs.enrich.permissions?.contents).toBe("write");
    // Worker-fallback path: when client_commits is missing/false in the
    // response (older backend), the Action must skip the local commit.
    expect(llm.content).toMatch(/client_commits.*\/\/\s*false/);
  });

  test("llm-enrichment triggers on release branches and passes ref through (epic #417 phase 1)", () => {
    const llm = templates.find((t) => t.path.endsWith("llm-enrichment.yml"));
    expect(llm).toBeDefined();
    if (!llm) return;

    const parsed = parse(llm.content) as {
      on: { push?: { branches?: string[]; paths?: string[] } };
    };
    // Trigger must cover release/** branches so the release PR re-enriches
    // before merge, baking fresh .nemar/metadata.json into the merge commit
    // (and therefore into the tag created by pr-merge.yml).
    expect(parsed.on.push?.branches).toEqual(["main", "release/**"]);
    // .nemar/metadata.json change must also re-trigger so a hand-edit reflects.
    expect(parsed.on.push?.paths).toContain(".nemar/metadata.json");

    // The Action must pass ref to the webhook so the Worker reads from the
    // right snapshot (main, release/v*, etc.) instead of always "main".
    expect(llm.content).toContain('\\"ref\\": \\"$BRANCH_REF\\"');
    expect(llm.content).toContain('BRANCH_REF="${{ github.ref_name }}"');

    // Release-branch pushes must force re-enrichment so the source_hash
    // short-circuit doesn't skip a Version-only bump.
    expect(llm.content).toMatch(/case "\$BRANCH_REF" in\s*\n\s*release\/\*\) FORCE="true"/);

    // The commit-back path must push to the branch that triggered the run,
    // not always to main.
    expect(llm.content).toContain('git push origin "HEAD:$BRANCH_REF"');
    expect(llm.content).toContain('git pull --rebase origin "$BRANCH_REF"');

    // Checkout must use the triggering ref (not the default branch) so the
    // local working tree matches what we're about to commit back to.
    expect(llm.content).toContain("ref: ${{ github.ref_name }}");
  });

  test("version-doi.yml refreshes enrichment before minting (epic #417 phase 1)", () => {
    const versionDoi = templates.find((t) => t.path.endsWith("version-doi.yml"));
    expect(versionDoi).toBeDefined();
    if (!versionDoi) return;

    // The defensive refresh step must call llm-enrich with the tag as ref
    // and force=true, and it must be tolerant of failure so a transient
    // outage does not block DOI publication. client_commits=true keeps the
    // Worker from attempting a (doomed) commit against an immutable tag.
    expect(versionDoi.content).toContain("Refresh enrichment from tag");
    expect(versionDoi.content).toContain("continue-on-error: true");
    expect(versionDoi.content).toContain('\\"force\\": true');
    expect(versionDoi.content).toContain('\\"client_commits\\": true');
    expect(versionDoi.content).toContain('\\"ref\\": \\"$TAG\\"');
    // Curl-level failure must fall through to the warning branch, not a
    // silent green step.
    expect(versionDoi.content).toContain("|| HTTP_CODE=0");
    expect(versionDoi.content).toContain('[ "$HTTP_CODE" = "0" ]');
    // The Worker returns HTTP 200 with embedded *_error fields when a
    // sub-step fails (commit/openrouter/doi/cache); the Action must surface
    // these as warnings so a green check does not mask a silent failure.
    expect(versionDoi.content).toMatch(/for field in commit_error openrouter_error/);

    // The refresh step must appear before the publish-DOI step.
    const refreshIdx = versionDoi.content.indexOf("Refresh enrichment from tag");
    const publishIdx = versionDoi.content.indexOf("Publish version DOI");
    expect(refreshIdx).toBeGreaterThan(0);
    expect(publishIdx).toBeGreaterThan(refreshIdx);
  });

  test("llm-enrichment.yml guards curl-level failures and includes failure context (epic #417 phase 1)", () => {
    const llm = templates.find((t) => t.path.endsWith("llm-enrichment.yml"));
    expect(llm).toBeDefined();
    if (!llm) return;
    // Network/DNS/TLS failure should fall through to the warning branch
    // instead of leaving HTTP_CODE empty (which bash coerces to 0 and would
    // bypass the >= 400 check, yielding a silent green step).
    expect(llm.content).toContain("|| HTTP_CODE=0");
    expect(llm.content).toContain('[ "$HTTP_CODE" = "0" ]');
    // Push-retry warnings should point operators at the git output they
    // need to read instead of being opaque.
    expect(llm.content).toContain("(see git output above)");
  });

  test("generate-archive workflow pins archiver to v7", () => {
    // Guards against a future hand-edit dropping the archiver version pin.
    // archiver v8 is ESM-only and breaks the require()-style streaming
    // script, throwing "archiver is not a function" at runtime.
    const archive = templates.find((t) => t.path.endsWith("generate-archive.yml"));
    expect(archive).toBeDefined();
    expect(archive?.content).toMatch(/'archiver@\^?7\./);
    // Reject the bare unpinned form on the install line specifically.
    const installLine = archive?.content
      .split("\n")
      .find((l) => /npm install.*archiver/.test(l));
    expect(installLine).toBeDefined();
    expect(installLine).not.toMatch(/\barchiver\b(?!@)/);
  });

  test("pr-merge / llm-enrichment / version-doi mint App tokens for writes (#439)", () => {
    // Each migrated template should:
    //   - reference actions/create-github-app-token@v1
    //   - pass app-id from secrets.NEMAR_APP_ID and key from secrets.NEMAR_APP_PRIVATE_KEY
    //   - scope `repositories:` to the calling repo (least-privilege)
    //   - NOT reference secrets.GITHUB_TOKEN anywhere
    const writeTemplates = [
      "pr-merge.yml",
      "llm-enrichment.yml",
      "version-doi.yml",
    ];
    for (const name of writeTemplates) {
      const tpl = templates.find((t) => t.path.endsWith(name));
      expect(tpl, `${name} missing from templates`).toBeDefined();
      if (!tpl) continue;
      expect(tpl.content).toContain("uses: actions/create-github-app-token@v1");
      expect(tpl.content).toContain("app-id: ${{ secrets.NEMAR_APP_ID }}");
      expect(tpl.content).toContain("private-key: ${{ secrets.NEMAR_APP_PRIVATE_KEY }}");
      expect(tpl.content).toContain("repositories: ${{ github.event.repository.name }}");
      expect(tpl.content).not.toContain("secrets.GITHUB_TOKEN");
    }
  });

  test("version-doi spawns the App-token step in BOTH jobs (publish-doi + trigger-archive)", () => {
    // version-doi has two jobs; each does its own write and needs its own
    // installation token. If a future refactor coalesces jobs, this test
    // documents the contract.
    const versionDoi = templates.find((t) => t.path.endsWith("version-doi.yml"));
    expect(versionDoi).toBeDefined();
    if (!versionDoi) return;
    const appTokenCount = (versionDoi.content.match(/actions\/create-github-app-token@v1/g) || []).length;
    expect(appTokenCount).toBe(2);
  });

  test("read-only / AWS-only templates stay on the auto-token (no App-token step)", () => {
    // bids-validation + version-check do no writes; generate-archive writes
    // only to S3 (AWS creds, not GitHub). Adding an App-token step there
    // would force an org-secret prerequisite for no benefit.
    const readOnlyTemplates = [
      "bids-validation.yml",
      "version-check.yml",
      "generate-archive.yml",
    ];
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
