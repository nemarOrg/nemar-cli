/**
 * The naming rule on a pull request the review does not run for (ADR 0107).
 *
 * A pull request opened by a NEMAR owner or administrator is not reviewed, but the naming rule
 * applies to it all the same, and it runs first: a title that starts with an author and a year or
 * holds a naming-template token, or a change of the dataset's name to such a name, fails its check.
 * The rule is the one in `shared/naming-rule.ts`, which the CLI and the review job use too, so the
 * three refuse the same text. The review job applies it to everyone else's pull requests before it
 * asks any model; this module applies it here, because an exempt pull request never reaches the job.
 *
 * **What is read.** The title comes from the delivery (or, for an administrator's start, GitHub's
 * own record of the pull request); it is read for this rule only, and never shown, stored or logged.
 * The dataset's name is the `Name` of `dataset_description.json`, read from GitHub at the head and
 * at the merge base: the rule applies when the pull request CHANGES the name, so a name that was
 * already there is not this pull request's to fix. The merge base comes from GitHub's comparison of
 * the base and the head, whose file list also says when `dataset_description.json` did not change,
 * and then nothing more is read.
 *
 * **Unknown is never green.** A name that cannot be read (GitHub refuses, times out, or answers with
 * something this cannot read) is `unchecked`, which publishes a check that does not pass. Each read
 * runs inside the webhook's own request, which GitHub gives ten seconds, so each is bounded.
 */

import { type NamingProblem, namingProblemOf } from "../../../shared/naming-rule.js";
import type { NamingFacts } from "../../../shared/pr-review.js";
import type { Bindings } from "../types/bindings.js";
import { getDatasetsTokenWithRefresher } from "./github-auth.js";
import { GITHUB_API, ORG_NAME, ghHeaders } from "./github/shared.js";
import { githubFetchWithRetry } from "./github/transport.js";

/**
 * The longest one read may take before the name is `unchecked`. The comparison and then the two
 * reads of the file (made together) run inside the webhook's ten seconds, after the exemption's own
 * GitHub question and before the check is posted, so each is kept short.
 */
let readTimeoutMs = 3_000;

export function __setNamingReadTimeoutForTests(ms: number | null): void {
  readTimeoutMs = ms ?? 3_000;
}

const SHA40 = /^[0-9a-f]{40}$/;
const DESCRIPTION = "dataset_description.json";
/** GitHub's comparison lists at most this many files; a list this long may be cut. */
const COMPARE_FILE_CAP = 300;

/** The pull request the rule is applied to. `title` is the pull request's own, unread elsewhere. */
export interface NamingSubject {
  datasetId: string;
  prNumber: number;
  headSha: string;
  /** The base branch's commit GitHub named with the pull request; null when it named none. */
  baseSha: string | null;
  title: string;
}

class Unreadable extends Error {
  constructor(what: string) {
    super(what);
    this.name = "Unreadable";
  }
}

async function get(
  token: string,
  refresh: () => Promise<string>,
  url: string,
  accept?: string,
): Promise<Response> {
  return await githubFetchWithRetry(
    url,
    {
      headers: { ...ghHeaders(token), ...(accept ? { Accept: accept } : {}) },
      signal: AbortSignal.timeout(readTimeoutMs),
    },
    { kind: "interactive", maxAttempts: 1, refreshTokenOn401: refresh },
  );
}

/**
 * The merge base of the pull request, whether `dataset_description.json` may have changed (it is in
 * GitHub's list of changed files, the list is long enough to have been cut, or there is no list),
 * and whether the list says the file is there at the head (added, changed or renamed to it).
 */
async function compare(
  token: string,
  refresh: () => Promise<string>,
  pr: NamingSubject & { baseSha: string },
): Promise<{ mergeBase: string; descriptionMayChange: boolean; listedAtHead: boolean }> {
  const res = await get(
    token,
    refresh,
    `${GITHUB_API()}/repos/${ORG_NAME}/${encodeURIComponent(pr.datasetId)}/compare/${pr.baseSha}...${pr.headSha}?per_page=1`,
  );
  if (!res.ok) throw new Unreadable(`compare answered HTTP ${res.status}`);
  const body: unknown = await res.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const base = record.merge_base_commit as { sha?: unknown } | null | undefined;
  const mergeBase = typeof base?.sha === "string" && SHA40.test(base.sha) ? base.sha : null;
  if (mergeBase === null) throw new Unreadable("compare named no merge base");
  const files = Array.isArray(record.files) ? record.files : null;
  if (files === null) return { mergeBase, descriptionMayChange: true, listedAtHead: false };
  const entries = files.map((f) =>
    typeof f === "object" && f !== null ? (f as Record<string, unknown>) : {},
  );
  const named = entries.some(
    (file) => file.filename === DESCRIPTION || file.previous_filename === DESCRIPTION,
  );
  const listedAtHead = entries.some(
    (file) => file.filename === DESCRIPTION && file.status !== "removed",
  );
  return {
    mergeBase,
    descriptionMayChange: named || files.length >= COMPARE_FILE_CAP,
    listedAtHead,
  };
}

/**
 * `dataset_description.json` at a commit: whether it is there, and its `Name`, null when the file
 * has no string `Name` or is not JSON.
 */
async function nameAt(
  token: string,
  refresh: () => Promise<string>,
  datasetId: string,
  ref: string,
): Promise<{ present: boolean; name: string | null }> {
  const res = await get(
    token,
    refresh,
    `${GITHUB_API()}/repos/${ORG_NAME}/${encodeURIComponent(datasetId)}/contents/${DESCRIPTION}?ref=${ref}`,
    "application/vnd.github.raw+json",
  );
  if (res.status === 404) return { present: false, name: null };
  if (!res.ok) throw new Unreadable(`contents answered HTTP ${res.status}`);
  const text = await res.text();
  try {
    const doc: unknown = JSON.parse(text);
    const name =
      typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>).Name : undefined;
    return { present: true, name: typeof name === "string" ? name : null };
  } catch {
    // A file that is not JSON has no name to check; the BIDS validator says what is wrong with it.
    return { present: true, name: null };
  }
}

/**
 * How the pull request's new dataset name breaks the naming rule: null when the name did not change
 * or is fine, `unchecked` when it could not be read. Never throws.
 */
async function nameProblemOf(
  env: Bindings,
  pr: NamingSubject,
): Promise<NamingProblem | null | "unchecked"> {
  const where = `${pr.datasetId}#${pr.prNumber}`;
  if (pr.baseSha === null || !SHA40.test(pr.baseSha)) {
    console.error(`[pr-review-naming] ${where}: no base commit to compare with; name unchecked`);
    return "unchecked";
  }
  try {
    const { token, refresh } = await getDatasetsTokenWithRefresher(env);
    const { mergeBase, descriptionMayChange, listedAtHead } = await compare(token, refresh, {
      ...pr,
      baseSha: pr.baseSha,
    });
    if (!descriptionMayChange) return null;
    const [after, before] = await Promise.all([
      nameAt(token, refresh, pr.datasetId, pr.headSha),
      nameAt(token, refresh, pr.datasetId, mergeBase),
    ]);
    // GitHub listed the file as there at the head and then said it is not: the two answers
    // disagree, and the name is not known, which is not the same as there being none.
    if (listedAtHead && !after.present) throw new Unreadable("the listed file was not found");
    if (after.name === null || after.name === before.name) return null;
    return namingProblemOf(after.name);
  } catch (err) {
    // Fixed words and the error's own message (a status or a timeout), never a name or a title.
    console.error(
      `[pr-review-naming] ${where}: the dataset name could not be read (${err instanceof Error ? err.message.slice(0, 120) : "unknown"}); name unchecked`,
    );
    return "unchecked";
  }
}

/** What the naming rule finds on a pull request: its title, and its new dataset name. */
export async function namingFactsFor(env: Bindings, pr: NamingSubject): Promise<NamingFacts> {
  return { title: namingProblemOf(pr.title), name: await nameProblemOf(env, pr) };
}

/** Whether the rule found nothing at all: neither a problem nor a name it could not read. */
export function namingClean(facts: NamingFacts): boolean {
  return facts.title === null && facts.name === null;
}

/** The audit action of an administrator's waiver of the naming rule for one commit. */
export const NAMING_WAIVED_ACTION = "pr_review_naming_waived";

/** The audit row's resource for a pull request: the same shape `pr_review_started` uses. */
export function namingResource(datasetId: string, prNumber: number): string {
  return `${datasetId}#${prNumber}`;
}

/**
 * Whether an administrator waived what the naming rule finds now on this commit of this pull
 * request: a recorded override (`nemar admin pr-reviews allow <dataset> <pr> --admin`), read from
 * the audit log, which is where the waiver lives. It is for one commit, so a new commit is checked
 * again, and it covers what it recorded: each problem found now must be the one the waiver recorded
 * for that field. A name that cannot be read now matches no waiver (none records one), so it is a
 * check that needs a person rather than a skip.
 */
export async function isNamingWaived(
  db: D1Database,
  pr: { datasetId: string; prNumber: number; headSha: string },
  facts: NamingFacts,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS waived FROM audit_log
        WHERE action = ? AND resource_id = ? AND json_valid(details)
          AND json_extract(details, '$.head_sha') = ?
          AND (? IS NULL OR json_extract(details, '$.title') = ?)
          AND (? IS NULL OR json_extract(details, '$.name') = ?)
        LIMIT 1`,
    )
    .bind(
      NAMING_WAIVED_ACTION,
      namingResource(pr.datasetId, pr.prNumber),
      pr.headSha,
      facts.title,
      facts.title,
      facts.name,
      facts.name,
    )
    .first<{ waived: number }>();
  return row !== null && row !== undefined;
}
