#!/usr/bin/env bun
/**
 * One-time cleanup: delete a per-repo workflow file from every dataset
 * repo under `nemarDatasets`. Phase 1 (#602) used this to remove
 * `llm-enrichment.yml`; Phase 2 (#606) uses it to remove `version-doi.yml`;
 * later phases of epic #601 will use it for the remaining per-repo
 * workflows as each centralizes onto `nemarDatasets/.github`.
 *
 * Cutover order matters. This script is step 4: after the central
 * workflow lands, the Worker dispatcher ships, and the App webhook is
 * pointed at /webhooks/github.
 *
 * Idempotent — repos that already have the file removed are skipped.
 * Logged per-repo. Concurrency 5 to keep within GitHub's secondary-rate
 * thresholds for content writes.
 *
 * Usage:
 *   bun run scripts/strip-per-repo-workflow.ts                                  # default: llm-enrichment.yml, all datasets
 *   bun run scripts/strip-per-repo-workflow.ts --workflow version-doi.yml      # phase 2: sweep version-doi
 *   bun run scripts/strip-per-repo-workflow.ts --dry-run                        # report only, no writes
 *   bun run scripts/strip-per-repo-workflow.ts --workflow X.yml nm000132        # one repo
 *
 * Auth: uses the `gh` CLI's stored token via `gh auth token`. The token
 * must have `repo` scope on `nemarDatasets`. This is operator-driven, not
 * a Worker concern — we don't want to grow a one-shot admin endpoint just
 * to delete a deprecated file.
 */

const DEFAULT_WORKFLOW = "llm-enrichment.yml";
const ORG = "nemarDatasets";
const CONCURRENCY = 5;
const API_BASE = "https://api.nemar.org";

/** Map a centralized-workflow basename to its sub-issue number, so the
 *  commit message anchors back to the PR that justified the removal.
 *  New phases append their entry here as they centralize. */
const WORKFLOW_ISSUE_MAP: Record<string, string> = {
  "llm-enrichment.yml": "602",
  "version-doi.yml": "606",
  "generate-archive.yml": "608",
};

interface Args {
  dryRun: boolean;
  workflow: string;
  issue: string | null;
  datasets: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, workflow: DEFAULT_WORKFLOW, issue: null, datasets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-n") args.dryRun = true;
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--workflow") {
      const v = argv[++i];
      if (!v) {
        console.error("--workflow requires a value");
        process.exit(1);
      }
      // Accept either a basename ("version-doi.yml") or a full
      // .github/workflows/<name> path; normalize to basename.
      args.workflow = v.replace(/^\.github\/workflows\//, "");
    } else if (a === "--issue") {
      const v = argv[++i];
      if (!v) {
        console.error("--issue requires a value");
        process.exit(1);
      }
      args.issue = v;
    } else if (a.startsWith("-")) {
      console.error(`Unknown flag: ${a}`);
      printHelp();
      process.exit(1);
    } else {
      args.datasets.push(a);
    }
  }
  if (!args.issue) {
    args.issue = WORKFLOW_ISSUE_MAP[args.workflow] ?? null;
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: strip-per-repo-workflow.ts [--workflow <basename>] [--dry-run] [--issue <N>] [dataset-id ...]

Deletes .github/workflows/<workflow> from each dataset repo under
nemarDatasets/. Defaults to llm-enrichment.yml (Phase 1 of epic #601).

Flags:
  --workflow <name>   Workflow file basename to remove (default: llm-enrichment.yml).
                      You can also pass the full .github/workflows/<name> path.
  --dry-run, -n       Report what would be deleted, don't write anything.
  --issue <N>         Sub-issue number for the commit message anchor.
                      Defaults to the phase appropriate for the workflow.

If no dataset IDs are given, lists every dataset via the NEMAR API and
operates on all of them. Idempotent — repos where the file is already
absent are skipped.`);
}

async function ghToken(): Promise<string> {
  // Operator-driven script; we rely on the same token they use for `gh`.
  // Reading the token via the CLI keeps the script free of explicit env
  // var contracts and surfaces any auth misconfig immediately.
  //
  // Check the exit code (not just the trimmed stdout) so an env where
  // `gh` is missing from PATH, or where the user isn't logged in, fails
  // loud with a useful stderr-derived message instead of proceeding to
  // 401 every API call. Code-review #605 fix.
  const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const token = out.trim();
  if (code !== 0 || !token) {
    const stderr = err.trim() || "(empty stderr)";
    throw new Error(
      `gh auth token failed (exit ${code}): ${stderr}. Run \`gh auth login\` and retry, or set the token in your shell.`,
    );
  }
  return token;
}

async function listAllDatasetIds(): Promise<string[]> {
  // Pull from the NEMAR list endpoint rather than enumerating GitHub
  // repos directly so we only touch repos D1 knows about — orphaned repos
  // on the org (test scratches, archives) are intentionally skipped.
  const res = await fetch(`${API_BASE}/datasets?limit=500`);
  if (!res.ok) {
    throw new Error(`GET ${API_BASE}/datasets returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { datasets?: Array<{ dataset_id: string }> };
  const ids = (body.datasets ?? [])
    .map((d) => d.dataset_id)
    .filter((id) => /^(nm|on|xx)\d{6}$/.test(id));
  return ids;
}

interface ContentsResponse {
  sha?: string;
  type?: string;
}

async function getFileSha(repo: string, targetPath: string, token: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${ORG}/${repo}/contents/${targetPath}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "nemar-strip-script",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET contents for ${repo} returned HTTP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as ContentsResponse;
  if (body.type !== "file" || !body.sha) {
    throw new Error(`GET contents for ${repo} did not return a file SHA`);
  }
  return body.sha;
}

async function deleteFile(
  repo: string,
  targetPath: string,
  sha: string,
  commitMessage: string,
  token: string,
): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${ORG}/${repo}/contents/${targetPath}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "nemar-strip-script",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: commitMessage,
      sha,
      // No `branch` field: GitHub deletes from the default branch, which
      // is `main` for every dataset repo by convention. If a repo's
      // default branch is something else (legacy `master`, etc.), the
      // delete still lands on whatever the default points at, which is
      // the correct behavior — that's the branch the legacy workflow
      // would have been firing from.
      author: { name: "nemar-publish-bot", email: "nemar-publish-bot@users.noreply.github.com" },
      committer: { name: "nemar-publish-bot", email: "nemar-publish-bot@users.noreply.github.com" },
    }),
  });
  if (!res.ok) {
    throw new Error(`DELETE for ${repo} returned HTTP ${res.status}: ${await res.text()}`);
  }
}

interface RepoResult {
  repo: string;
  status: "deleted" | "absent" | "skipped" | "error";
  message?: string;
}

async function processRepo(
  repo: string,
  targetPath: string,
  commitMessage: string,
  token: string,
  dryRun: boolean,
): Promise<RepoResult> {
  try {
    const sha = await getFileSha(repo, targetPath, token);
    if (sha === null) {
      return { repo, status: "absent" };
    }
    if (dryRun) {
      return { repo, status: "skipped", message: `would DELETE sha=${sha.slice(0, 7)}` };
    }
    await deleteFile(repo, targetPath, sha, commitMessage, token);
    return { repo, status: "deleted", message: `removed sha=${sha.slice(0, 7)}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { repo, status: "error", message: msg };
  }
}

async function runPool<T>(items: T[], worker: (it: T) => Promise<RepoResult>, concurrency: number): Promise<RepoResult[]> {
  const results: RepoResult[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      const result = await worker(items[idx]);
      results.push(result);
      // Stream progress as work happens so an operator can ^C with a sense
      // of how much was already applied.
      const marker =
        result.status === "deleted"
          ? "[del]"
          : result.status === "absent"
            ? "[skp]"
            : result.status === "skipped"
              ? "[dry]"
              : "[ERR]";
      const detail = result.message ? `  ${result.message}` : "";
      console.log(`${marker} ${result.repo}${detail}`);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const targetPath = `.github/workflows/${args.workflow}`;
  const issueAnchor = args.issue ? `, #${args.issue}` : "";
  const commitMessage = `chore(ci): remove ${args.workflow} (centralized on nemarDatasets/.github${issueAnchor})`;

  const token = await ghToken();
  const datasets = args.datasets.length > 0 ? args.datasets : await listAllDatasetIds();
  console.log(
    `Stripping ${targetPath} from ${datasets.length} dataset repo(s) under ${ORG} (concurrency ${CONCURRENCY}${args.dryRun ? ", DRY RUN" : ""}).`,
  );
  const results = await runPool(
    datasets,
    (id) => processRepo(id, targetPath, commitMessage, token, args.dryRun),
    CONCURRENCY,
  );

  const summary: Record<RepoResult["status"], number> = {
    deleted: 0,
    absent: 0,
    skipped: 0,
    error: 0,
  };
  for (const r of results) summary[r.status] += 1;

  console.log("");
  console.log(
    `Summary: deleted=${summary.deleted} already-absent=${summary.absent} dry-run=${summary.skipped} errors=${summary.error}`,
  );
  if (summary.error > 0) {
    console.log("Errors:");
    for (const r of results) {
      if (r.status === "error") console.log(`  ${r.repo}: ${r.message ?? "(no message)"}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
