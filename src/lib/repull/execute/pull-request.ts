/**
 * The release branch and its pull request (ADR 0111, decision 2; epic #1046 phase 6): the
 * synthesized commit is pushed to `release/v<N.0.0>`, and the pull request into `main` is opened
 * with the administrator's own GitHub token. Execution never merges it.
 *
 * Before the push, NEMAR's `main` must be the commit the re-pull is based on, or a descendant of it
 * by enrichment-shaped commits only (`main-moved` otherwise). A release branch that already exists
 * is reused only when it is the synthesized commit or an enrichment-shaped descendant of it, since
 * enrichment commits to every `release/*` push; anything else on it is `branch-foreign`. The pull
 * request is found among the open ones by its head branch before one is opened, so a run whose
 * answer was lost finds it again; any other open release pull request refuses (`release-pr-open`).
 */

import { isOwnDatasetRepo } from "../../../../shared/nemar-app.js";
import { sanitizeNote } from "../../../../shared/pr-review.js";
import { repullTrailerLines } from "../../../../shared/repull-squash.js";
import { DATASETS_ORG } from "../../pr-review-approve.js";
import { buildReleaseTitle, findSentTitleProblem } from "../../pr-text.js";
import { type ListedPull, listPulls, listedPull, pullListWhy } from "../pulls.js";
import type { PushContext } from "../write-guard.js";
import { type HeadCheck, MOVED_REF_FETCH_DEPTH, enrichmentOnlySince } from "./head.js";
import { guardedPush, pushCauseWords } from "./push.js";
import { ExecuteRefused } from "./verify-plan.js";
import { git } from "./workdir.js";

const REQUEST_TIMEOUT_MS = 20_000;

/** `refs/heads/release/v<version>`. */
export function releaseRefOf(version: string): string {
  return `refs/heads/release/v${version}`;
}

/** Origin's commit for each of `refs`, by `git ls-remote` in the working clone; absent when none. */
async function remoteHeads(
  work: string,
  refs: string[],
  env: Record<string, string> | undefined,
): Promise<Map<string, string>> {
  const r = await git(work, ["ls-remote", "origin", ...refs], {
    ...(env ? { env } : {}),
    code: "origin-unreadable",
    step: "ls-remote",
  });
  const out = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const [oid, name] = line.split("\t");
    if (oid && name && /^[0-9a-f]{40}$/.test(oid)) out.set(name, oid);
  }
  return out;
}

/** Fetch `ref` deep enough for {@link enrichmentOnlySince} to reach a recorded commit. */
async function fetchRef(
  work: string,
  ref: string,
  env: Record<string, string> | undefined,
): Promise<void> {
  const local = ref.replace(/^refs\/heads\//, "refs/remotes/origin/");
  await git(
    work,
    [
      "fetch",
      "--quiet",
      "--no-tags",
      `--depth=${MOVED_REF_FETCH_DEPTH}`,
      "origin",
      `+${ref}:${local}`,
    ],
    { ...(env ? { env } : {}), code: "origin-unreadable", step: "fetch" },
  );
}

/**
 * Whether `head`, a commit origin names, is `from` or an enrichment-shaped descendant of it; the
 * commits are fetched from `ref` when the clone does not hold them.
 */
export async function acceptsHead(args: {
  work: string;
  from: string;
  head: string;
  ref: string;
  env: Record<string, string> | undefined;
}): Promise<HeadCheck> {
  if (args.head === args.from) return "ok";
  await fetchRef(args.work, args.ref, args.env);
  const verdict = await enrichmentOnlySince(args.work, args.from, args.head);
  if (verdict.ok) return "ok";
  return verdict.code === "unreadable" ? "unreadable" : "foreign";
}

/**
 * Refuse unless origin's `main` is `baseSha` or an enrichment-shaped descendant of it. Returns
 * origin's `main`.
 */
export async function checkMain(args: {
  work: string;
  baseSha: string;
  env: Record<string, string> | undefined;
}): Promise<string> {
  const heads = await remoteHeads(args.work, ["refs/heads/main"], args.env);
  const main = heads.get("refs/heads/main");
  if (!main) throw new ExecuteRefused("origin-unreadable", "NEMAR's main could not be read.");
  const verdict = await acceptsHead({
    work: args.work,
    from: args.baseSha,
    head: main,
    ref: "refs/heads/main",
    env: args.env,
  });
  if (verdict === "unreadable") {
    throw new ExecuteRefused(
      "main-unreadable",
      "Whether NEMAR's main moved only by commits enrichment makes could not be read from the working clone; nothing was pushed. Run again; if it persists, this re-pull's record has to be ended (nemar admin repull abandon <id>).",
    );
  }
  if (verdict !== "ok") {
    throw new ExecuteRefused(
      "main-moved",
      "NEMAR's main moved since the re-pull was prepared, by a commit enrichment does not make: this re-pull cannot continue, and its record has to be ended (nemar admin repull abandon <id>) and the dataset planned again.",
    );
  }
  return main;
}

/**
 * The release branch at the synthesized commit: pushed when absent, reused when it is that commit
 * or an enrichment-shaped descendant of it. Returns the branch's head.
 */
export async function pushRelease(args: {
  work: string;
  synthSha: string;
  version: string;
  push: PushContext;
  env: Record<string, string> | undefined;
}): Promise<{ head: string; pushed: boolean }> {
  const ref = releaseRefOf(args.version);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const existing = (await remoteHeads(args.work, [ref], args.env)).get(ref);
    if (existing) {
      const verdict = await acceptsHead({
        work: args.work,
        from: args.synthSha,
        head: existing,
        ref,
        env: args.env,
      });
      if (verdict === "unreadable") {
        throw new ExecuteRefused(
          "branch-unreadable",
          `Whether release/v${args.version} holds only this re-pull's commit and enrichment's could not be read from the working clone; nothing was pushed.`,
        );
      }
      if (verdict !== "ok") {
        throw new ExecuteRefused(
          "branch-foreign",
          `release/v${args.version} exists on NEMAR's repository and is not this re-pull's commit: it holds a commit enrichment does not make. Remove the branch after checking what it holds, or end this re-pull's record (nemar admin repull abandon <id>).`,
        );
      }
      return { head: existing, pushed: false };
    }
    const pushed = await guardedPush(args.work, [`${args.synthSha}:${ref}`], args.push, args.env);
    if (pushed.outcome === "pushed" || pushed.outcome === "up-to-date") {
      return { head: args.synthSha, pushed: true };
    }
    if (pushed.outcome === "remote-rejected") {
      // NEMAR's repository refused the branch by its own rule; pushing again cannot change it.
      throw new ExecuteRefused(
        "push-refused",
        `release/v${args.version} was refused by NEMAR's repository (${pushCauseWords(pushed.cause)}); a second push would be refused the same way.`,
      );
    }
    if (pushed.outcome === "failed") {
      throw new ExecuteRefused(
        "push-failed",
        `release/v${args.version} could not be pushed to NEMAR's repository (${pushCauseWords(pushed.cause)}).`,
      );
    }
    // Rejected: the branch appeared in between. Read it once more and judge it.
  }
  throw new ExecuteRefused(
    "push-failed",
    `release/v${args.version} was refused twice because the remote moved under the push, and does not hold this re-pull's commit.`,
  );
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "nemar-cli repull",
    "Content-Type": "application/json",
  };
}

async function githubCall(
  url: string,
  init: { method: string; token: string; body?: unknown },
): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: headers(init.token),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

/**
 * The open pull request of `release/v<version>` from the dataset's own repository, or none; refuses
 * when GitHub cannot be read, when 100 or more are open (the page cannot be complete), or when
 * another release pull request is open (decision 2: the two are never open together).
 */
async function openReleasePull(args: {
  token: string;
  base: string;
  datasetId: string;
  version: string;
}): Promise<ListedPull | null> {
  const own = `${DATASETS_ORG}/${args.datasetId}`;
  const listed = await listPulls({
    token: args.token,
    base: args.base,
    datasetId: args.datasetId,
    state: "open",
  });
  if (!listed.ok) {
    throw new ExecuteRefused(
      "github-unreadable",
      `GitHub's open pull requests of ${own} could not be read whole (${pullListWhy(listed)}).`,
    );
  }
  const pulls = listed.pulls;
  const branch = `release/v${args.version}`;
  const releases = pulls.filter((p) => p.headRef.startsWith("release/"));
  // The head repository must be the dataset's own: a fork's branch of the same name is not ours,
  // and one whose repository GitHub no longer names (a deleted fork) fails closed the same way.
  const ours = releases.filter(
    (p) => p.headRef === branch && isOwnDatasetRepo(p.headRepo, args.datasetId),
  );
  const others = releases.filter((p) => !ours.includes(p));
  if (others.length > 0 || ours.length > 1) {
    throw new ExecuteRefused(
      "release-pr-open",
      `Another release pull request is open on ${own} (#${(others[0] ?? ours[1])?.number}); a re-pull's pull request is never open beside another.`,
    );
  }
  return ours[0] ?? null;
}

/**
 * The pull request of `release/v<version>` into `main`: the open one found by its head, else one
 * opened now with the administrator's token. `acceptHead` judges the head GitHub reports (the
 * synthesized commit, or an enrichment-shaped descendant). Returns its number and head.
 */
export async function openRelease(args: {
  token: string;
  base: string;
  datasetId: string;
  version: string;
  body: string;
  acceptHead: (sha: string) => Promise<HeadCheck>;
}): Promise<{ number: number; head: string; reused: boolean }> {
  const branch = `release/v${args.version}`;
  const found = await openReleasePull(args);
  if (found) {
    const verdict = found.baseRef === "main" ? await args.acceptHead(found.headSha) : "foreign";
    if (verdict === "unreadable") {
      throw new ExecuteRefused(
        "pr-unreadable",
        `Whether the open pull request of ${branch} (#${found.number}) is at this re-pull's commit could not be read from the working clone.`,
      );
    }
    if (verdict !== "ok") {
      throw new ExecuteRefused(
        "pr-foreign",
        `The open pull request of ${branch} (#${found.number}) is not into main at this re-pull's commit.`,
      );
    }
    return { number: found.number, head: found.headSha, reused: true };
  }
  const title = buildReleaseTitle(args.version);
  const problem = findSentTitleProblem(title);
  if (problem)
    throw new ExecuteRefused("pr-title", `The title would be refused: ${problem.reason}.`);
  const answer = await githubCall(`${args.base}/repos/${DATASETS_ORG}/${args.datasetId}/pulls`, {
    method: "POST",
    token: args.token,
    body: { title, head: branch, base: "main", body: args.body, maintainer_can_modify: false },
  });
  if (!answer || answer.status >= 500) {
    throw new ExecuteRefused(
      "pr-create-unknown",
      `GitHub did not say whether the pull request of ${branch} was opened${answer ? ` (HTTP ${answer.status})` : ""}; the next run looks for it before opening one.`,
    );
  }
  const created = answer.status === 201 ? listedPull(answer.body) : null;
  if (answer.status === 201 && !created) {
    // It was opened; only its answer could not be read. The next run finds it by its head.
    throw new ExecuteRefused(
      "pr-created-unreadable",
      `GitHub opened the pull request of ${branch} (HTTP 201) but its answer could not be read; the next run looks for it before opening one.`,
    );
  }
  if (!created) {
    const message =
      typeof answer.body === "object" && answer.body !== null && "message" in answer.body
        ? sanitizeNote((answer.body as { message: unknown }).message, 160)
        : "";
    throw new ExecuteRefused(
      "pr-create-refused",
      `GitHub refused to open the pull request of ${branch} (HTTP ${answer.status}${message ? `: ${message}` : ""}).`,
    );
  }
  const createdVerdict =
    created.headRef === branch && created.baseRef === "main"
      ? await args.acceptHead(created.headSha)
      : "foreign";
  if (createdVerdict === "unreadable") {
    throw new ExecuteRefused(
      "pr-unreadable",
      `GitHub opened pull request #${created.number}, but whether it is at this re-pull's commit could not be read from the working clone.`,
    );
  }
  if (createdVerdict !== "ok") {
    throw new ExecuteRefused(
      "pr-foreign",
      `GitHub opened pull request #${created.number}, but not of ${branch} into main at this re-pull's commit.`,
    );
  }
  return { number: created.number, head: created.headSha, reused: false };
}

/** The pull request's body: counts and the plan digest, never a path or a key. */
export function releaseBody(args: {
  datasetId: string;
  repullId: number;
  ds: string;
  fromTag: string;
  toTag: string;
  toVersion: string;
  patchVersion: string | null;
  digest: string;
  doiCount: number;
  counts: Record<string, number>;
}): string {
  const c = (k: string) =>
    typeof args.counts[k] === "number" ? String(args.counts[k]) : "unknown";
  return [
    `Re-pull of upstream ${args.ds} from snapshot ${args.fromTag} to ${args.toTag}, as v${args.toVersion} of ${args.datasetId} (ADR 0111).`,
    "",
    `This pull request replays upstream's snapshot ${args.ds}@${args.toTag} onto NEMAR's main as one synthesized commit, scrubbed before anything was copied or pushed. Upstream wins every conflict in v${args.toVersion}${args.patchVersion ? `; NEMAR's corrections follow as v${args.patchVersion} once this is merged and tagged` : ""}.`,
    "",
    `- Re-pull record: #${args.repullId}`,
    `- Plan digest: ${args.digest}`,
    `- Delta paths: ${c("delta_paths")} (written ${c("written")}, deleted ${c("deleted")})`,
    `- Keys copied from upstream by version: ${c("annex_copy_items")}; uploaded from the administrator's machine: ${c("local_uploads")}`,
    `- Recording headers scrubbed: ${c("scrubbed_recordings")}; acquisition dates set: ${c("dated_recordings")}; JSON files blanked: ${c("scrubbed_json")}`,
    `- Version DOIs the re-pull mints when merged: ${args.doiCount}`,
    "",
    `\`nemar admin repull execute\` never merges. \`nemar admin repull resume ${args.datasetId}\` takes this pull request through the identifier screen and the gates, and \`nemar admin repull merge ${args.datasetId}\` (or \`nemar admin pr-reviews\`, through the same gate) squash-merges it under the daily merge cap; a merge mints a version DOI that cannot be withdrawn.`,
    "",
    "The squash commit message must end with both trailers of the re-pull commit, as its last paragraph; the merge path writes that message itself and refuses one that does not:",
    "",
    "```",
    ...repullTrailerLines({
      upstream_ds: args.ds,
      to_tag: args.toTag,
      plan_digest: args.digest,
    }),
    "```",
    "",
    "GitHub's default squash message lists each commit as a bullet, which puts the trailers mid-message; the privacy ledger's fresh-clone proof (ADR 0085) then fails the dataset. Do not merge this from GitHub's page.",
  ].join("\n");
}
