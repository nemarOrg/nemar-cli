/**
 * Repair a dataset repository whose concept-DOI update never reached `main` (#1386).
 *
 * The publication orchestrator's two DOI writes carried no branch, so the GitHub
 * Contents API put them on the repository's default branch. For sixteen imported
 * repositories that is `git-annex`, and fourteen of them therefore still advertise
 * OpenNeuro's DOI on `main` while NEMAR's concept DOI and README badge sit on a
 * branch nothing reads.
 *
 * This applies the same edit publish would have, now, to main's CURRENT content --
 * not by copying the blobs stranded in June, which are months behind. The rules come
 * from `services/doi.ts` (`applyConceptDoiToDescription`, `buildDoiBadge`,
 * `planReadmeBadgeCommit`), the same functions the orchestrator calls, so the repair
 * cannot drift from the thing it is repairing.
 *
 * Two independent sources have to agree on the concept DOI before anything is
 * written: NEMAR's own API (`concept_doi`, from D1) and the value publish actually
 * wrote, which for these sixteen is stranded on the `git-annex` branch. A dataset
 * where they disagree is reported and skipped, never guessed at; a dataset where
 * the second source does not exist can only be repaired by naming it explicitly,
 * because then D1 is the only witness and that is a judgment call, not a sweep.
 *
 * Read-only by default.
 *
 *   bun run scripts/repair-doi-metadata.ts on002720 on002721      # report
 *   bun run scripts/repair-doi-metadata.ts --scan on              # find every case
 *   bun run scripts/repair-doi-metadata.ts --apply on002720       # fix named ones
 *
 * `--apply` refuses `--scan`: discovery is a sweep, writing to published metadata
 * is not.
 */

import {
  applyConceptDoiToDescription,
  buildDoiBadge,
  planReadmeBadgeCommit,
} from "../backend/src/services/doi";
import { createOrUpdateFile, getFileContent } from "../backend/src/services/github/contents";

const API_BASE = process.env.NEMAR_API_BASE ?? "https://api.nemar.org";
const BRANCH = "main";
/** Where the orchestrator's DOI writes landed for the affected repositories. */
const STRANDED_BRANCH = "git-annex";

export interface DatasetVerdict {
  datasetId: string;
  /** What D1 says this dataset's concept DOI is. */
  conceptDoi: string | null;
  /** What `main` advertises today. */
  mainDoi: string | null;
  /** Whether main's README carries a badge for the concept DOI. */
  badgeOnMain: boolean;
  /** What publish wrote on the branch its write was misdirected to, when present. */
  strandedDoi?: string | null;
  action: "ok" | "needs-repair" | "repaired" | "skipped" | "failed";
  detail?: string;
  commits?: string[];
}

async function githubToken(): Promise<string> {
  const fromEnv = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
  const token = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !token) {
    throw new Error("No GitHub token: set GH_TOKEN or run `gh auth login`.");
  }
  return token;
}

async function conceptDoiFromApi(datasetId: string): Promise<string | null> {
  const response = await fetch(`${API_BASE}/datasets/${datasetId}`, {
    headers: { "User-Agent": "nemar-cli repair-doi-metadata (#1386)" },
  });
  // A repository the catalog does not know is not a repair target: there is no
  // concept DOI to repair toward. Two of the sixteen are in this state.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET /datasets/${datasetId}: HTTP ${response.status}`);
  const body = (await response.json()) as {
    concept_doi?: string | null;
    dataset?: { concept_doi?: string | null };
  };
  return body.concept_doi ?? body.dataset?.concept_doi ?? null;
}

/** Read a JSON file from a ref, or null when it is absent or unparseable. */
async function readJson(
  repo: string,
  path: string,
  pat: string,
  ref: string,
): Promise<Record<string, unknown> | null> {
  const raw = await getFileContent(repo, path, pat, ref);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${repo}:${ref}/${path} is not valid JSON: ${(error as Error).message}`);
  }
}

export async function inspect(datasetId: string, pat: string): Promise<DatasetVerdict> {
  const conceptDoi = await conceptDoiFromApi(datasetId);
  const onMain = await readJson(datasetId, "dataset_description.json", pat, BRANCH);
  const mainDoi = typeof onMain?.DatasetDOI === "string" ? onMain.DatasetDOI : null;
  const readme = await getFileContent(datasetId, "README.md", pat, BRANCH);
  // Ask the same function publish asks, rather than a looser reimplementation. A
  // README that merely mentions the DOI in prose is not a badge, and treating it as
  // one reported the dataset as needing nothing and left it without one.
  const badgeOnMain =
    conceptDoi !== null &&
    readme !== null &&
    !planReadmeBadgeCommit({
      readmeContent: readme,
      doiBadge: buildDoiBadge(conceptDoi),
      conceptDoi,
      contentSourcePath: "README.md",
    }).commit;

  const verdict: DatasetVerdict = {
    datasetId,
    conceptDoi,
    mainDoi,
    badgeOnMain,
    action: "ok",
  };

  if (!conceptDoi) {
    verdict.action = "skipped";
    verdict.detail = "the catalog has no concept DOI for it: nothing to repair toward";
    return verdict;
  }
  if (!onMain) {
    verdict.action = "failed";
    verdict.detail = "no dataset_description.json on main";
    return verdict;
  }

  // The second witness: what publish actually wrote. For the sixteen repositories
  // this script exists for, that write landed on `git-annex` because the Contents
  // API sent it to the default branch. If it is there and it disagrees with D1,
  // something re-minted or rolled back a DOI and a repair would confidently write
  // the wrong one onto published metadata.
  const stranded = await readJson(datasetId, "dataset_description.json", pat, STRANDED_BRANCH);
  const strandedDoi = typeof stranded?.DatasetDOI === "string" ? stranded.DatasetDOI : null;
  verdict.strandedDoi = strandedDoi;
  if (strandedDoi && strandedDoi !== conceptDoi) {
    verdict.action = "skipped";
    verdict.detail = `the catalog says ${conceptDoi} and the ${STRANDED_BRANCH} branch says ${strandedDoi}; refusing to guess which is current`;
    return verdict;
  }

  if (mainDoi !== conceptDoi || !badgeOnMain) verdict.action = "needs-repair";
  return verdict;
}

export async function repair(
  datasetId: string,
  pat: string,
  apply: boolean,
): Promise<DatasetVerdict> {
  const verdict = await inspect(datasetId, pat);
  if (verdict.action !== "needs-repair") return verdict;
  const conceptDoi = verdict.conceptDoi as string;
  const commits: string[] = [];

  // 1. dataset_description.json, by the same rule publish uses.
  const onMain = (await readJson(datasetId, "dataset_description.json", pat, BRANCH)) ?? {};
  const applied = applyConceptDoiToDescription(onMain, conceptDoi);
  if (applied.changed) {
    const message = `Update DatasetDOI with concept DOI: ${conceptDoi} [skip ci]`;
    commits.push(
      `dataset_description.json: ${verdict.mainDoi ?? "(none)"} -> ${conceptDoi}${
        applied.preservedSourceDoi ? ` (preserving ${applied.preservedSourceDoi})` : ""
      }`,
    );
    if (apply) {
      await createOrUpdateFile(
        datasetId,
        "dataset_description.json",
        JSON.stringify(applied.description, null, 2),
        message,
        pat,
        BRANCH,
      );
    }
  }

  // 2. README.md. A repair does not invent a README that was never there.
  const readme = await getFileContent(datasetId, "README.md", pat, BRANCH);
  if (readme === null) {
    commits.push("README.md: absent on main, left alone");
  } else {
    const plan = planReadmeBadgeCommit({
      readmeContent: readme,
      doiBadge: buildDoiBadge(conceptDoi),
      conceptDoi,
      contentSourcePath: "README.md",
    });
    if (plan.commit) {
      commits.push(`README.md: ${plan.message}`);
      if (apply) {
        await createOrUpdateFile(datasetId, "README.md", plan.content, plan.message, pat, BRANCH);
      }
    }
  }

  verdict.commits = commits;
  if (!apply) return verdict;

  // 3. Read main back: the point of the exercise is what main says, so ask it.
  const after = await inspect(datasetId, pat);
  verdict.action = after.action === "ok" ? "repaired" : "failed";
  if (after.action !== "ok") {
    verdict.detail = `after the write, main still reports DatasetDOI=${after.mainDoi} badge=${after.badgeOnMain}`;
  }
  return verdict;
}

async function datasetsWithPrefix(prefix: string): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; ; offset += 200) {
    const response = await fetch(`${API_BASE}/datasets?limit=200&offset=${offset}`, {
      headers: { "User-Agent": "nemar-cli repair-doi-metadata (#1386)" },
    });
    if (!response.ok) throw new Error(`GET /datasets: HTTP ${response.status}`);
    const body = (await response.json()) as {
      datasets: Array<{ dataset_id: string }>;
      total_count: number;
    };
    ids.push(...body.datasets.map((d) => d.dataset_id));
    if (body.datasets.length < 200 || ids.length >= body.total_count) break;
  }
  return ids.filter((id) => id.startsWith(prefix)).sort();
}

// Exported above for the tests; run only when this file IS the program, so
// importing it does not parse argv, ask for a token, or write to any repository.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const scanAt = args.indexOf("--scan");
  const explicit = args.filter(
    (a) => !a.startsWith("--") && (scanAt === -1 || a !== args[scanAt + 1]),
  );

  // `--scan` is a discovery tool and stays read-only. `--apply` writes to published
  // dataset repositories, and `--scan on --apply` would be every imported dataset --
  // hundreds of them, each write starting that repository's CI. Naming the datasets
  // is the confirmation.
  if (apply && scanAt !== -1) {
    console.error(
      "--apply does not take --scan. Run --scan <prefix> to find the datasets, check the report, then name them explicitly with --apply.",
    );
    process.exit(1);
  }
  const pat = await githubToken();
  const targets = scanAt !== -1 ? await datasetsWithPrefix(args[scanAt + 1] ?? "on") : explicit;
  if (targets.length === 0) {
    console.error("Nothing to do: name datasets, or --scan <prefix>.");
    process.exit(1);
  }
  console.log(`${apply ? "Repairing" : "Inspecting"} ${targets.length} dataset(s) on ${BRANCH}\n`);

  const verdicts: DatasetVerdict[] = [];
  for (const datasetId of targets) {
    try {
      verdicts.push(await repair(datasetId, pat, apply));
    } catch (error) {
      verdicts.push({
        datasetId,
        conceptDoi: null,
        mainDoi: null,
        badgeOnMain: false,
        action: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const v = verdicts[verdicts.length - 1];
    if (v.action === "ok") continue;
    console.log(`${v.datasetId}  ${v.action}${v.detail ? `: ${v.detail}` : ""}`);
    for (const line of v.commits ?? []) console.log(`    ${line}`);
  }

  const tally = verdicts.reduce<Record<string, number>>((acc, v) => {
    acc[v.action] = (acc[v.action] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\n${JSON.stringify(tally)}`);
  if ((tally.failed ?? 0) > 0) process.exit(1);
}
