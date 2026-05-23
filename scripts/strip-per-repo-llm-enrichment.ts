#!/usr/bin/env bun
/**
 * One-time cleanup: delete `.github/workflows/llm-enrichment.yml` from every
 * dataset repo under `nemarDatasets`. Phase 1 of epic #601 (sub-issue #602).
 *
 * After this runs, the legacy per-repo enrichment workflow no longer fires —
 * the central `run-enrichment.yml` on `nemarDatasets/.github` (dispatched
 * from the Worker's `/webhooks/github` push handler) is the only path.
 *
 * Cutover order matters. This script is step 4:
 *   1. `nemarDatasets/.github` PR adds the central workflow (idle).
 *   2. nemar-cli PR adds `/webhooks/github` + `triggerEnrichmentRun`.
 *   3. Operator configures the App webhook URL → api.nemar.org/webhooks/github
 *      so push events actually arrive at the Worker.
 *   4. THIS SCRIPT — sweep the per-repo file from every dataset repo.
 *   5. Verify with a real push on `nm099999`; expect exactly one central
 *      workflow run, no per-repo run, `enrichment_json` populated in D1.
 *
 * Idempotent — repos that already have the file removed are skipped.
 * Logged per-repo. Concurrency 5 to keep within GitHub's secondary-rate
 * thresholds for content writes.
 *
 * Usage:
 *   bun run scripts/strip-per-repo-llm-enrichment.ts                  # all datasets
 *   bun run scripts/strip-per-repo-llm-enrichment.ts --dry-run        # report only, no writes
 *   bun run scripts/strip-per-repo-llm-enrichment.ts nm000132 nm000154  # subset
 *
 * Auth: uses the `gh` CLI's stored token via `gh auth token`. The token
 * must have `repo` scope on `nemarDatasets`. This is operator-driven, not
 * a Worker concern — we don't want to grow a one-shot admin endpoint just
 * to delete a deprecated file.
 */

const TARGET_PATH = ".github/workflows/llm-enrichment.yml";
const ORG = "nemarDatasets";
const COMMIT_MESSAGE =
  "chore(ci): remove llm-enrichment.yml (centralized on nemarDatasets/.github, #602)";
const CONCURRENCY = 5;
const API_BASE = "https://api.nemar.org";

interface Args {
  dryRun: boolean;
  datasets: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, datasets: [] };
  for (const a of argv) {
    if (a === "--dry-run" || a === "-n") args.dryRun = true;
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.error(`Unknown flag: ${a}`);
      printHelp();
      process.exit(1);
    } else {
      args.datasets.push(a);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: strip-per-repo-llm-enrichment.ts [--dry-run] [dataset-id ...]

Deletes .github/workflows/llm-enrichment.yml from each dataset repo under
nemarDatasets/. Phase 1 of epic #601 / sub-issue #602.

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

async function getFileSha(repo: string, token: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${ORG}/${repo}/contents/${TARGET_PATH}`, {
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

async function deleteFile(repo: string, sha: string, token: string): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${ORG}/${repo}/contents/${TARGET_PATH}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "nemar-strip-script",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: COMMIT_MESSAGE,
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

async function processRepo(repo: string, token: string, dryRun: boolean): Promise<RepoResult> {
  try {
    const sha = await getFileSha(repo, token);
    if (sha === null) {
      return { repo, status: "absent" };
    }
    if (dryRun) {
      return { repo, status: "skipped", message: `would DELETE sha=${sha.slice(0, 7)}` };
    }
    await deleteFile(repo, sha, token);
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
  const token = await ghToken();
  const datasets = args.datasets.length > 0 ? args.datasets : await listAllDatasetIds();
  console.log(
    `Stripping ${TARGET_PATH} from ${datasets.length} dataset repo(s) under ${ORG} (concurrency ${CONCURRENCY}${args.dryRun ? ", DRY RUN" : ""}).`,
  );
  const results = await runPool(datasets, (id) => processRepo(id, token, args.dryRun), CONCURRENCY);

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
