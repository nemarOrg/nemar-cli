/**
 * Whether a re-pull pull request's head fails BIDS validation and nothing else (ADR 0111, the
 * Phase 7g amendment and the #1983 review amendment), read now with the administrator's own
 * GitHub token. The rule is `shared/repull-bids-override.ts`'s, built on the facts the Worker's
 * claim to merge reads; this file only reads GitHub (every check run and commit status of the
 * head, two GETs) and words the answer.
 *
 * Its two callers:
 *  - `resume` records the gates of such a head on a record an administrator opened, where GitHub
 *    reports `unstable` and no `clean` comes while the validation fails: {@link readBidsOnly}, the
 *    whole rule, because nothing reads the facts again at the gates;
 *  - the merge gate takes `--bids-failure-reason` only while nothing but BIDS validation fails:
 *    {@link readNothingElseFails}, the part the Worker's claim does not read, which then reads the
 *    facts itself and refuses in its own words.
 */

import {
  type BidsOnlyFault,
  type HeadChecks,
  bidsOnlyFault,
  othersNotPassing,
} from "../../../shared/repull-bids-override.js";
import { sanitizeNote } from "../../../shared/untrusted-text.js";
import { fetchDatasetRepoJson } from "../pr-review-approve.js";

/** `bids-only`: the rule holds; `not`: GitHub was read and it does not; `unreadable`: GitHub was not. */
export type BidsOnlyRead =
  | { kind: "bids-only" }
  | { kind: "not"; why: string }
  | { kind: "unreadable"; why: string };

/** The record and the pull request as the caller read them, and how to read GitHub. */
export interface BidsOnlyAsk {
  token: string;
  base: string;
  datasetId: string;
  /** The head the gates or the merge are about. */
  sha: string;
  /** The record's `origin`. */
  origin: string;
  /** GitHub's `mergeable_state`, as read for that head. */
  mergeableState: string;
}

/** Every check run and commit status of the head, or why they could not be read. */
async function readHead(a: BidsOnlyAsk): Promise<HeadChecks | { unreadable: string }> {
  const head = a.sha.slice(0, 12);
  const [runs, statuses] = await Promise.all([
    fetchDatasetRepoJson(
      a.token,
      a.datasetId,
      `/commits/${a.sha}/check-runs?filter=latest&per_page=100`,
      a.base,
    ),
    fetchDatasetRepoJson(a.token, a.datasetId, `/commits/${a.sha}/status?per_page=100`, a.base),
  ]);
  if (!runs.ok) {
    return { unreadable: `the check runs of ${head} could not be read (${runs.reason})` };
  }
  if (!statuses.ok) {
    return { unreadable: `the commit statuses of ${head} could not be read (${statuses.reason})` };
  }
  return { datasetId: a.datasetId, sha: a.sha, runs: runs.value, statuses: statuses.value };
}

/**
 * The whole rule: the facts the Worker's claim reads, from the head's unfiltered runs, and nothing
 * else failing. A read that fails, or an answer the rule cannot read, is `unreadable`: unknown is
 * never BIDS-only.
 */
export async function readBidsOnly(a: BidsOnlyAsk): Promise<BidsOnlyRead> {
  const read = await readHead(a);
  if ("unreadable" in read) return { kind: "unreadable", why: read.unreadable };
  const fault = bidsOnlyFault({ ...read, origin: a.origin, mergeableState: a.mergeableState });
  if (fault === null) return { kind: "bids-only" };
  const why = faultWords(fault, a);
  return fault.fault === "unreadable" ? { kind: "unreadable", why } : { kind: "not", why };
}

/** Nothing but BIDS validation fails at the head: the rule's part the Worker's claim does not read. */
export async function readNothingElseFails(a: BidsOnlyAsk): Promise<BidsOnlyRead> {
  const read = await readHead(a);
  if ("unreadable" in read) return { kind: "unreadable", why: read.unreadable };
  const others = othersNotPassing(read);
  if (others === "unreadable") {
    return { kind: "unreadable", why: faultWords({ fault: "unreadable" }, a) };
  }
  if (others.length === 0) return { kind: "bids-only" };
  return { kind: "not", why: faultWords({ fault: "others", others }, a) };
}

/** Why the head is not BIDS validation's failure alone, in words. */
function faultWords(f: BidsOnlyFault, a: BidsOnlyAsk): string {
  const head = a.sha.slice(0, 12);
  switch (f.fault) {
    case "unreadable":
      return `the checks of ${head} could not be read (GitHub's answer is not complete, or not of its shape)`;
    case "automatic":
      return "the automatic path opened this re-pull, and its pull request is merged over a failed BIDS validation by no one";
    case "blocked":
      return "GitHub reports it blocked: a rule requires BIDS validation, and a merge would be a bypass, which a re-pull never uses";
    case "not-unstable":
      return `GitHub reports it '${sanitizeNote(a.mergeableState, 30) || "unrecognized"}', not unstable`;
    case "bids":
      return `BIDS validation of ${head} has not completed with failure`;
    case "version-check":
      return `version-check of ${head} has not completed with success`;
    case "others":
      return `another check of ${head} does not pass (${f.others.map((n) => sanitizeNote(n, 60) || "unnamed").join(", ")})`;
  }
}
