/**
 * The states of an upstream re-pull and the only edges between them (epic #1046 phase 6, #1912;
 * ADR 0111, decision 3). Pure and import-free, so the Worker, the CLI and the tests read one table.
 *
 * The row is `upstream_repulls` (migration 0105). The database holds the stage invariants as
 * CHECKs; this module holds what the database cannot say: which edge is allowed, which columns an
 * edge may write and must write, and what shape each column's value takes. Column names come only
 * from {@link TRANSITION_FIELDS}, so no writer builds a column list from a request.
 */

/** Every state, in the order a re-pull walks them. */
export const REPULL_STATUSES = [
  "planned",
  "prepared",
  "copied",
  "registered",
  "pr_open",
  "gates_clear",
  "merged",
  "released",
  "patch_synthesized",
  "patch_gates_clear",
  "patch_merged",
  "patch_released",
  "complete",
  "abandoned",
  "failed",
  "superseded",
  "patch_declined",
] as const;

export type RepullStatus = (typeof REPULL_STATUSES)[number];

/** A terminal row never moves again, and the partial unique index lets a new row open. */
export const TERMINAL_STATUSES = [
  "complete",
  "abandoned",
  "failed",
  "superseded",
  "patch_declined",
] as const satisfies readonly RepullStatus[];

export function isRepullStatus(value: unknown): value is RepullStatus {
  return typeof value === "string" && (REPULL_STATUSES as readonly string[]).includes(value);
}

export function isTerminal(status: RepullStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** The states that may still end `abandoned` or `superseded`: before N.0.0 is merged. */
export const BEFORE_MERGE: readonly RepullStatus[] = [
  "planned",
  "prepared",
  "copied",
  "registered",
  "pr_open",
  "gates_clear",
];

/** The states that may end `patch_declined`: N.0.0 released, N.0.1 not yet merged. */
export const PATCH_OPEN: readonly RepullStatus[] = [
  "released",
  "patch_synthesized",
  "patch_gates_clear",
];

const NON_TERMINAL: readonly RepullStatus[] = REPULL_STATUSES.filter((s) => !isTerminal(s));

/**
 * The edges a write may take, and no others. A self-edge (`prepared` to `prepared`) is a step that
 * repeats with new facts: a re-preparation onto a moved `main`, a head moved by enrichment.
 */
export const REPULL_TRANSITIONS: Readonly<Record<RepullStatus, readonly RepullStatus[]>> = (() => {
  const forward: ReadonlyArray<readonly [RepullStatus, RepullStatus]> = [
    ["planned", "planned"],
    ["planned", "prepared"],
    ["prepared", "prepared"],
    ["prepared", "copied"],
    ["copied", "copied"],
    ["copied", "registered"],
    ["registered", "registered"],
    ["registered", "pr_open"],
    ["pr_open", "pr_open"],
    ["pr_open", "gates_clear"],
    // A pull request merged before its gates were recorded (on GitHub's page, say): only the
    // verified route writes it, from GitHub's own answer, and counts it as outside the tools.
    ["pr_open", "merged"],
    ["gates_clear", "pr_open"],
    ["gates_clear", "gates_clear"],
    ["gates_clear", "merged"],
    ["merged", "merged"],
    ["merged", "released"],
    ["released", "released"],
    ["released", "complete"],
    ["released", "patch_synthesized"],
    ["patch_synthesized", "patch_synthesized"],
    ["patch_synthesized", "patch_gates_clear"],
    ["patch_synthesized", "patch_merged"],
    ["patch_gates_clear", "patch_synthesized"],
    ["patch_gates_clear", "patch_gates_clear"],
    ["patch_gates_clear", "patch_merged"],
    ["patch_merged", "patch_merged"],
    ["patch_merged", "patch_released"],
    ["patch_released", "complete"],
  ];
  const edges = new Map<RepullStatus, RepullStatus[]>(REPULL_STATUSES.map((s) => [s, []]));
  const add = (from: RepullStatus, to: RepullStatus) => edges.get(from)?.push(to);
  for (const [from, to] of forward) add(from, to);
  for (const from of BEFORE_MERGE) {
    add(from, "abandoned");
    add(from, "superseded");
  }
  for (const from of PATCH_OPEN) add(from, "patch_declined");
  for (const from of NON_TERMINAL) add(from, "failed");
  return Object.fromEntries(edges) as unknown as Record<RepullStatus, readonly RepullStatus[]>;
})();

export function canTransition(from: RepullStatus, to: RepullStatus): boolean {
  return REPULL_TRANSITIONS[from].includes(to);
}

/**
 * States only a route that reads GitHub or the version row itself may write: the merge, the tag
 * and the DOI are facts the Worker verifies, never facts a caller states.
 */
export const VERIFIED_ONLY_STATUSES = [
  "merged",
  "released",
  "patch_merged",
  "patch_released",
] as const satisfies readonly RepullStatus[];

/**
 * While a claim to merge is held the merge may have gone out, so the edges that would close the
 * pull request (`abandoned`, `superseded`, `patch_declined`) or move its head (`pr_open`,
 * `patch_synthesized`) are refused until GitHub has been read. Each names the claim column that
 * blocks it. `failed` is not here: a lost merge answer must stay reportable.
 */
export const MERGE_CLAIM_COLUMNS = {
  abandoned: "merge_claimed_at",
  superseded: "merge_claimed_at",
  pr_open: "merge_claimed_at",
  patch_declined: "patch_merge_claimed_at",
  patch_synthesized: "patch_merge_claimed_at",
} as const;

export interface TransitionFields {
  /** Columns the transition may set. */
  may: readonly string[];
  /** Columns it must set, each present and well shaped. A subset of `may`. */
  must: readonly string[];
  /** Columns the transition clears, because their value belongs to a state it leaves. */
  reset: readonly string[];
  /** The edge must say why (it goes to `last_error`). */
  requiresError?: boolean;
  /** Columns the Worker stamps with its own clock; a request must not carry them. */
  stamp?: readonly string[];
}

const NONE: readonly string[] = [];

/**
 * What an edge into `to` may and must write. `counts` is merged key by key, never replaced.
 * `last_error` is not here: it is written through the import-error rule, from a separate field.
 * An edge that repeats a state (a head moved) sends the whole stage again, so a row never holds
 * half of one stage's facts.
 */
export const TRANSITION_FIELDS: Readonly<Record<RepullStatus, TransitionFields>> = {
  planned: { may: NONE, must: NONE, reset: NONE },
  prepared: {
    may: ["synth_tree", "synth_sha", "manifest_digest", "base_sha", "counts", "workflow_run_url"],
    must: ["synth_tree", "synth_sha", "manifest_digest"],
    reset: NONE,
  },
  copied: { may: ["counts"], must: NONE, reset: NONE },
  registered: { may: ["counts"], must: NONE, reset: NONE },
  pr_open: {
    may: [
      "branch",
      "pr_number",
      "head_sha",
      "synth_tree",
      "synth_sha",
      "manifest_digest",
      "base_sha",
      "counts",
    ],
    must: ["branch", "pr_number", "head_sha"],
    reset: ["gates_sha"],
  },
  gates_clear: { may: ["gates_sha", "counts"], must: ["gates_sha"], reset: NONE },
  merged: {
    may: ["merge_sha", "counts"],
    must: ["merge_sha"],
    reset: NONE,
  },
  released: { may: ["tag_sha", "counts"], must: ["tag_sha"], reset: NONE },
  patch_synthesized: {
    may: [
      "patch_version",
      "patch_branch",
      "patch_pr_number",
      "patch_head_sha",
      "patch_base_sha",
      "counts",
    ],
    must: ["patch_version", "patch_branch", "patch_pr_number", "patch_head_sha", "patch_base_sha"],
    reset: ["patch_gates_sha"],
  },
  patch_gates_clear: {
    may: ["patch_gates_sha", "counts"],
    must: ["patch_gates_sha"],
    reset: NONE,
  },
  patch_merged: {
    may: ["patch_merge_sha", "counts"],
    must: ["patch_merge_sha"],
    reset: NONE,
  },
  patch_released: { may: ["patch_tag_sha", "counts"], must: ["patch_tag_sha"], reset: NONE },
  complete: { may: ["counts"], must: NONE, reset: NONE },
  abandoned: { may: ["counts"], must: NONE, reset: NONE },
  failed: { may: ["counts"], must: NONE, reset: NONE, requiresError: true },
  superseded: { may: ["counts"], must: NONE, reset: NONE },
  patch_declined: { may: ["counts"], must: NONE, reset: NONE },
};

/**
 * Edges that repeat a state to write something other than the state's own facts. They override
 * {@link TRANSITION_FIELDS} for `from === to` only:
 *  - `planned`, `copied` and `registered`: record why a step could not finish (the error is the
 *    whole write): the registration that follows `copied`, the pull request that follows
 *    `registered`; the edge forward clears it;
 *  - `merged` and `patch_merged`: record why the release could not be recorded yet (no tag, a tag
 *    on another commit, no version row), the error being the whole write, as `planned`'s;
 *  - `released`: record the count of locked objects once every object N.0.0's copy and uploads
 *    wrote is locked, or why the lock did not complete (the Worker refuses one that carries
 *    neither, and a count below what the copy wrote); the row cannot leave `released` for
 *    `complete` or N.0.1 until the count is recorded ({@link LOCK_COUNT_KEY});
 *  - `gates_clear` and `patch_gates_clear`: record the claim to merge, before the merge is sent.
 *    The caller names the screened head; the Worker stamps the time with its own clock, because a
 *    caller-stated time could be backdated or set ahead and defeat the sweep for stuck claims.
 */
export const SELF_EDGE_FIELDS: Readonly<Partial<Record<RepullStatus, TransitionFields>>> = {
  planned: { may: NONE, must: NONE, reset: NONE, requiresError: true },
  copied: { may: NONE, must: NONE, reset: NONE, requiresError: true },
  registered: { may: NONE, must: NONE, reset: NONE, requiresError: true },
  merged: { may: NONE, must: NONE, reset: NONE, requiresError: true },
  patch_merged: { may: NONE, must: NONE, reset: NONE, requiresError: true },
  released: { may: ["counts"], must: NONE, reset: NONE },
  gates_clear: {
    may: ["merge_claim_sha"],
    must: ["merge_claim_sha"],
    reset: NONE,
    stamp: ["merge_claimed_at"],
  },
  patch_gates_clear: {
    may: ["patch_merge_claim_sha"],
    must: ["patch_merge_claim_sha"],
    reset: NONE,
    stamp: ["patch_merge_claimed_at"],
  },
};

/**
 * Self-edges that record the whole stage again, so the step they repeat succeeded: they clear a
 * stored error when they carry none, as an edge into another non-terminal status does. A
 * `prepared` row prepared again onto a moved base takes this edge, and so does one found intact,
 * restored from its checkpoint or prepared again to the same commit, but execution sends it then
 * only when the stored error is a preparation's own (its words begin `[prepare:`), so an error a
 * later step recorded is not cleared by a preparation that holds. A `released` self-edge that
 * records the count of locked objects with no error records the lock's stage, which is the whole
 * of what `released` waits for, so it clears the error a lock that did not complete recorded. The
 * other self-edges write one thing beside the stage and keep the error.
 */
export const CLEARING_SELF_EDGES = [
  "prepared",
  "released",
] as const satisfies readonly RepullStatus[];

/**
 * The count a released N.0.0 must record before it moves on: the objects its copy and its uploads
 * wrote (the copy manifest's keys, never the rest of the prefix), each locked under the governance
 * lock (ADR 0111, decision 8). The Worker accepts only a count of all of them (`lock-incomplete`
 * below the record's `copied`, `skipped` and `local_uploads`). Until it is recorded the row stays
 * `released`, the state a lock that failed leaves it in, and a run takes the lock up again;
 * `complete` and N.0.1 are refused (`lock-unrecorded`).
 */
export const LOCK_COUNT_KEY = "locked" as const satisfies (typeof REPULL_COUNT_KEYS)[number];

/** What the edge `from` to `to` may and must write. */
export function fieldsFor(from: RepullStatus, to: RepullStatus): TransitionFields {
  return (from === to ? SELF_EDGE_FIELDS[to] : undefined) ?? TRANSITION_FIELDS[to];
}

/**
 * Columns that, once set, keep their value: a pull request is identified by its branch and
 * number, and a changed one on a later edge would be a different pull request.
 */
export const IMMUTABLE_ONCE_SET = [
  "branch",
  "pr_number",
  "patch_version",
  "patch_branch",
  "patch_pr_number",
] as const;

export const SHA_RE = /^[0-9a-f]{40}$/;
/** `sha256:` and 64 lowercase hex digits: the shape migration 0105's CHECK pins by length. */
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
export const NEMAR_VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * The keys `counts` may hold. A count is a non-negative integer and a key never names a path, an
 * object key or a person: the column is read by the administrator's `status` and by reports, and
 * the ledger rule (ADR 0036) is that counts say how many, never which.
 */
export const REPULL_COUNT_KEYS = [
  "delta_paths",
  "written",
  "deleted",
  "annex_copy_items",
  "copy_bytes",
  "local_uploads",
  "local_upload_bytes",
  "scrubbed_recordings",
  "scrubbed_json",
  "dated_recordings",
  "headers_not_read",
  "held_keys",
  "unexplained",
  "conflicts",
  "corrections",
  "resolutions",
  "copied",
  "registered",
  "locked",
  "orphan_objects",
  "orphan_bytes",
  "skipped",
  "bytes",
  "headers_not_read_nemar_held",
  "headers_not_read_no_source",
  // What the delta scrub could not read or prove, kept so unknown is never read as zero.
  "json_files_unread",
  "json_files_annexed",
  "scans_tables_unread",
  "headers_dates_unproven",
  "headers_dates_left",
  // NEMAR-owned edits the plan listed and the preparation applied, or left with another status.
  "nemar_owned_edits",
  "nemar_owned_edits_left",
  "merged_outside_tool",
  "merged_unscreened_head",
] as const;

/**
 * Count keys only the Worker writes, from what it read on GitHub itself, each on its own:
 * `merged_outside_tool`, the pull request merged while no NEMAR tool held a claim to merge it;
 * `merged_unscreened_head`, it merged at a head other than the screened one. A request that names
 * one is refused, so no caller can set or clear the record of either.
 */
export const WORKER_COUNT_KEYS = [
  "merged_outside_tool",
  "merged_unscreened_head",
] as const satisfies readonly (typeof REPULL_COUNT_KEYS)[number][];

/** A re-pull records two pull requests: `n0` is N.0.0's, `n1` is N.0.1's (the corrections). */
export const REPULL_PULL_REQUESTS = ["n0", "n1"] as const;
export type RepullPullRequest = (typeof REPULL_PULL_REQUESTS)[number];

/** The columns and states that belong to one of the two pull requests. */
export interface PullRequestColumns {
  number: "pr_number" | "patch_pr_number";
  branch: "branch" | "patch_branch";
  head: "head_sha" | "patch_head_sha";
  gates: "gates_sha" | "patch_gates_sha";
  claimedAt: "merge_claimed_at" | "patch_merge_claimed_at";
  claimSha: "merge_claim_sha" | "patch_merge_claim_sha";
  mergeSha: "merge_sha" | "patch_merge_sha";
  tagSha: "tag_sha" | "patch_tag_sha";
  /** The version the pull request releases. */
  version: "to_version" | "patch_version";
  /** The status in which its head is screened (the pull request is open and not yet clear). */
  open: RepullStatus;
  gatesClear: RepullStatus;
  merged: RepullStatus;
  released: RepullStatus;
}

export const PULL_REQUEST_COLUMNS: Readonly<Record<RepullPullRequest, PullRequestColumns>> = {
  n0: {
    number: "pr_number",
    branch: "branch",
    head: "head_sha",
    gates: "gates_sha",
    claimedAt: "merge_claimed_at",
    claimSha: "merge_claim_sha",
    mergeSha: "merge_sha",
    tagSha: "tag_sha",
    version: "to_version",
    open: "pr_open",
    gatesClear: "gates_clear",
    merged: "merged",
    released: "released",
  },
  n1: {
    number: "patch_pr_number",
    branch: "patch_branch",
    head: "patch_head_sha",
    gates: "patch_gates_sha",
    claimedAt: "patch_merge_claimed_at",
    claimSha: "patch_merge_claim_sha",
    mergeSha: "patch_merge_sha",
    tagSha: "patch_tag_sha",
    version: "patch_version",
    open: "patch_synthesized",
    gatesClear: "patch_gates_clear",
    merged: "patch_merged",
    released: "patch_released",
  },
};

/**
 * Which pull request a gates-clear status belongs to, or null for any other status. A caller
 * reaches a gates-clear status only while the identifier screen bound to the row (ADR 0111,
 * decision 7) passes for the head it names: the Worker reads the screen itself.
 */
export function pullRequestOfGatesStatus(status: RepullStatus): RepullPullRequest | null {
  for (const pr of REPULL_PULL_REQUESTS) {
    if (PULL_REQUEST_COLUMNS[pr].gatesClear === status) return pr;
  }
  return null;
}

/** The next major of an `N.N.N` version: the number a re-pull's N.0.0 takes. Null for a non-version. */
export function nextMajorVersion(version: string): string | null {
  if (!NEMAR_VERSION_RE.test(version)) return null;
  const major = Number.parseInt(version.split(".")[0] as string, 10);
  return Number.isSafeInteger(major + 1) ? `${major + 1}.0.0` : null;
}

/** The patch that carries a re-pull's corrections: `N.0.1` for `N.0.0`. Null for a non-version. */
export function patchVersionOf(toVersion: string): string | null {
  if (!NEMAR_VERSION_RE.test(toVersion)) return null;
  const [major] = toVersion.split(".");
  return `${major}.0.1`;
}

/** The row as the API speaks it: every column, `counts` parsed. */
export interface RepullRow {
  id: number;
  dataset_id: string;
  upstream_ds: string;
  from_tag: string;
  to_tag: string;
  attempt: number;
  from_version: string;
  to_version: string;
  patch_version: string | null;
  plan_digest: string;
  planner: number;
  origin: "automatic" | "administrator";
  actor_user_id: number;
  status: RepullStatus;
  base_sha: string;
  synth_tree: string | null;
  synth_sha: string | null;
  manifest_digest: string | null;
  branch: string | null;
  pr_number: number | null;
  head_sha: string | null;
  gates_sha: string | null;
  merge_claimed_at: string | null;
  merge_claim_sha: string | null;
  merge_sha: string | null;
  tag_sha: string | null;
  patch_base_sha: string | null;
  patch_branch: string | null;
  patch_pr_number: number | null;
  patch_head_sha: string | null;
  patch_gates_sha: string | null;
  patch_merge_claimed_at: string | null;
  patch_merge_claim_sha: string | null;
  patch_merge_sha: string | null;
  patch_tag_sha: string | null;
  counts: Record<string, number>;
  /** Writes to the row; every transition increments it and applies only to the revision it read. */
  revision: number;
  last_error: string | null;
  workflow_run_url: string | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
  /** Why an automatic re-pull waits where it is (a {@link REPULL_HOLD_REASONS} word), or null. */
  hold_reason: string | null;
  /** Since when it has waited for that reason; set exactly when `hold_reason` is. */
  hold_since: string | null;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

const isSha = (v: unknown): boolean => typeof v === "string" && SHA_RE.test(v);

/**
 * Why a value is not acceptable for `column`, or null when it is. `counts` is checked against
 * {@link REPULL_COUNT_KEYS}. A branch must be the release branch of the version it carries, so a
 * caller cannot point a row at another branch of the repository.
 */
export function fieldProblem(
  column: string,
  value: unknown,
  row: Pick<RepullRow, "to_version" | "patch_version">,
  siblings: Readonly<Record<string, unknown>> = {},
): string | null {
  switch (column) {
    case "synth_tree":
    case "synth_sha":
    case "base_sha":
    case "head_sha":
    case "gates_sha":
    case "merge_sha":
    case "merge_claim_sha":
    case "tag_sha":
    case "patch_base_sha":
    case "patch_head_sha":
    case "patch_gates_sha":
    case "patch_merge_sha":
    case "patch_merge_claim_sha":
    case "patch_tag_sha":
      return isSha(value) ? null : `${column} must be a 40-character lowercase hex id`;
    case "manifest_digest":
      return typeof value === "string" && DIGEST_RE.test(value)
        ? null
        : "manifest_digest must be sha256: and 64 hex digits";
    case "pr_number":
    case "patch_pr_number":
      return isPositiveInt(value) ? null : `${column} must be a positive integer`;
    case "branch":
      return value === `release/v${row.to_version}`
        ? null
        : `branch must be release/v${row.to_version}`;
    case "patch_version": {
      const expected = patchVersionOf(row.to_version);
      return value === expected ? null : `patch_version must be ${expected}`;
    }
    case "patch_branch": {
      const version = (siblings.patch_version as string | undefined) ?? row.patch_version;
      return typeof version === "string" && value === `release/v${version}`
        ? null
        : "patch_branch must be the release branch of patch_version";
    }
    case "workflow_run_url":
      return typeof value === "string" && value.length <= 500 && /^https:\/\/[^\s]+$/.test(value)
        ? null
        : "workflow_run_url must be an https URL";
    case "counts": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "counts must be an object";
      }
      const keys = REPULL_COUNT_KEYS as readonly string[];
      for (const [k, v] of Object.entries(value)) {
        if (!keys.includes(k)) return `counts holds an unknown key: ${k}`;
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
          return `counts.${k} must be a non-negative integer`;
        }
      }
      return null;
    }
    default:
      return `${column} is not a column a transition writes`;
  }
}

// ----------------------------------------------------------------------------
// The automatic path (epic #1046 phase 7, #1913; ADR 0111, decisions 6 and 7)
// ----------------------------------------------------------------------------

/**
 * A dispatch asks a central workflow run to do one thing: `open` runs a plan to an open pull
 * request (or resumes a row that stalled before it), `finish` walks a merged re-pull to
 * `complete`. Its row is `upstream_repull_dispatches` (migration 0111).
 */
export const DISPATCH_KINDS = ["open", "finish"] as const;
export type DispatchKind = (typeof DISPATCH_KINDS)[number];

/**
 * A dispatch's states. `dispatched` and `started` are live (the run may still report, and the row
 * holds its one-shot nonce); the run ends it with `opened`, `finished`, `refused` or `failed`, and
 * the Worker ends it with `dispatch_failed` (GitHub refused the dispatch, so nothing ran) or
 * `unreported` (the run said nothing within its deadline).
 */
export const DISPATCH_STATUSES = [
  "dispatched",
  "started",
  "opened",
  "finished",
  "refused",
  "failed",
  "unreported",
  "dispatch_failed",
] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

/** The live states: the row holds its nonce, so a run's token still verifies. */
export const DISPATCH_LIVE = ["dispatched", "started"] as const satisfies readonly DispatchStatus[];

/** What a run may report about itself; the Worker writes the other states. */
export const DISPATCH_PHASES = [
  "started",
  "opened",
  "finished",
  "refused",
  "failed",
] as const satisfies readonly DispatchStatus[];
export type DispatchPhase = (typeof DISPATCH_PHASES)[number];

/**
 * The fixed words a dispatch's `code` may hold: why it was refused, why it failed, or why the
 * Worker could not send it. Closed on purpose. A code is shown to administrators and counted in
 * the weekly report, which is filed on a public-facing repository, so it must never be able to
 * carry a path, a key, a subject label or a message; a word that is not here is refused by the
 * callback, and a run reports `no-code` for a refusal whose word this list does not hold, so a new
 * word is added here deliberately. `test/repull-dispatch-words.unit.test.ts` pins that every literal
 * refusal word of the CLI's plan and execution, of the scrub, and of the Worker's re-pull routes
 * is here.
 */
export const DISPATCH_CODES = [
  // The Worker's own, at the automatic create and when it sends or ends a dispatch.
  "auto-production-only",
  "auto-repull-off",
  "auto-on-only",
  "auto-planner-version",
  "auto-not-clean-plan",
  "auto-copy-too-large",
  "dispatch-token",
  "dispatch-mismatch",
  "dispatch-unconfigured",
  "dispatch-refused",
  "dispatch-failed",
  // GitHub turned a resume's send away for a reason about the Worker rather than the dispatch (its
  // credential, its permission, a rate limit): nothing ran, and it spends none of the row's
  // dispatches.
  "dispatch-deferred",
  // The Worker's answers to a run's report, which the run may pass on when it then fails.
  "invalid-token",
  "already-started",
  "kind-mismatch",
  "repull-mismatch",
  "repull-not-ready",
  "stale-dispatch",
  // The unattended run's own words.
  "auto-no-app-token",
  "key-without-pin",
  "head-foreign",
  "finish-not-merged",
  "runner-failed",
  "runner-disk",
  "no-code",
  // The unattended run's own words (Phase 7d): the dispatch the run was handed is not the nine
  // keys the Worker sends; the CLI is not the release the dispatch names; the dispatch token is on
  // the command line, where the public log shows it; output that would print what the run reads
  // is on; an option the automatic mode does not take, or one it needs is missing; a finish that
  // ended short of `complete`; a report the Worker never answered; the runner could not make the
  // short-lived AWS session the copy needs.
  "dispatch-invalid",
  "auto-cli-version",
  "auto-token-on-argv",
  "auto-verbose",
  "auto-option",
  "finish-incomplete",
  "report-unanswered",
  "runner-credentials",
  // The copy would outlast the App token's hour (`automaticCopySeconds` over the budget); and a run
  // that failed while GitHub no longer took its App token, which only a new run's token can carry on.
  "auto-copy-too-long",
  "token-expired",
  // The time already spent since the App token was minted, and what is left to do, would pass the
  // usable hour: refused before the copy or a push rather than failed half way; or the run cannot
  // tell when its token was minted.
  "auto-token-hour",
  "auto-token-clock",
  // The release branch could not be read in the settle's last quiet period, so the run cannot say
  // its head settled.
  "head-unreadable",
  // The API the run would talk to is not production's (an override aimed elsewhere): nothing was
  // sent there, the token included, so this word reaches the Worker only through the backstop.
  "auto-api-not-production",
  // The plan: its preflight checks, its refusals, and why it planned nothing.
  "annex-uuid-mismatch",
  "concept-doi-disagrees",
  "dead-recording-unpinned",
  "fetch-bound",
  "from-tag-disagrees",
  "from-tag-malformed",
  "from-tag-not-recorded",
  "from-tag-unknown",
  "github-error",
  "github-unreachable",
  "gitlink",
  "latest-unknown",
  "ledger-correction-unexplained",
  "ledger-unreadable",
  "mirror-lag",
  "nemar-s3-ambiguous",
  "never-released",
  "no-bucket",
  "no-nemar-s3",
  "no-nemar-s3-remote",
  "no-source-id",
  "no-token",
  "nothing-to-pull",
  "order-unverified",
  "preflight",
  "release-branch-exists",
  "release-pr-open",
  "rows-unavailable",
  "source",
  "source-disagrees",
  "target-names-dead-key",
  "target-unknown",
  "to-tag-malformed",
  "to-tag-unrecordable",
  "too-many-open",
  "version",
  "versions-disagree",
  // Execution: the plan proved, the record, the preparation and what follows it.
  "anonymity-unknown",
  "blob-unavailable",
  "checkpoint-failed",
  "clone-failed",
  "computed-missing",
  "dataset-missing",
  "destination-prefix",
  "execution-locked",
  "git-failed",
  "main-moved",
  "materialize-failed",
  "nemar-owned-moved",
  "not-executable",
  "not-planned",
  "path-conflict",
  "path-unsafe",
  "plan-environment",
  "plan-schema",
  "plan-sources",
  "plan-stale",
  "plan-tampered",
  "plan-unreadable",
  "planner-version",
  "prepare-failed",
  "prepare-not-reproducible",
  "record-refused",
  "synthesis-failed",
  "synthesis-mismatch",
  "target-mismatch",
  "test-base-refused",
  "unannex-content-mismatch",
  "unannex-unreadable",
  "unpinned-key",
  "until-not-built",
  "workdir-busy",
  // Execution past `prepared` (Phase 6d): the copy, the registration, the release branch and its
  // pull request. A run reports the word of the step that refused, as `[copy:<word>]`,
  // `[register:<word>]` or `[pr:<word>]` on the record; `copy-failed`, `register-failed`,
  // `pr-failed` and `s3-failed` are the words of a failure no more specific word names.
  "branch-foreign",
  "branch-unreadable",
  "checkpoint-lost",
  "copy-failed",
  "copy-size-mismatch",
  "copy-source",
  "copy-unverified",
  "declined",
  "held-key-absent",
  "main-unreadable",
  "manifest-mismatch",
  "no-github-token",
  "origin-unreadable",
  "pin-absent",
  "pin-changed",
  "pin-size-mismatch",
  "pin-version-mismatch",
  "pr-create-refused",
  "pr-create-unknown",
  "pr-created-unreadable",
  "pr-failed",
  "pr-foreign",
  "pr-title",
  "pr-unreadable",
  "push-failed",
  "push-refused",
  "register-failed",
  "registration-failed",
  "registration-push-failed",
  "registration-push-refused",
  "registration-push-rejected",
  "registration-unproven",
  "s3-failed",
  "unreadable",
  "until-not-allowed",
  "upstream-tag-moved",
  "upstream-unreadable",
  "write-refused",
  // Past the open pull request (Phase 6f): resume, the re-synthesis onto a moved `main`, the
  // merge gate, the release and the lock. A run reports them as `[gates:<word>]`,
  // `[release:<word>]` or `[lock:<word>]` on the record. `gates-failed`, `release-failed` and
  // `lock-failed` are the words a step records for a failure no more specific word names, and
  // `github-failed` the word of an API call that got no usable answer.
  "branch-moved",
  "gates-failed",
  "github-failed",
  "lock-failed",
  "lock-incomplete",
  "merge-trailers",
  "merge-unreadable",
  "not-built",
  "release-failed",
  "resume-looped",
  "staging-unreadable",
  "use-execute",
  "claim-too-old",
  // N.0.1, abandoning and superseding a record (Phase 6g): a run reports N.0.1's words as
  // `[patch:<word>]` on the record; abandon and supersede record nothing but their end.
  "patch-ledger",
  "patch-plan-mismatch",
  "plan-not-the-record",
  "patch-ours-moved",
  "patch-path-conflict",
  "patch-description-unreadable",
  "patch-key-absent",
  "patch-key-dead",
  "patch-main-moved",
  "patch-tree-mismatch",
  "merge-main-moved",
  "foreign-pull-request-merged",
  "take-ours-invalid",
  "wait-for-release",
  "supersede-automatic",
  "supersede-same-tag",
  "supersede-from-tag",
  "supersede-too-late",
  // The scrub's refusals (`IMPORT_SCRUB_REFUSALS`), which execution passes on as they are.
  "already-imported-unscrubbed",
  "bound-exceeded",
  "content-mismatch",
  "header-unreadable",
  "old-key-still-named",
  "provenance-out-of-scope",
  "retire-failed",
  "scope-incomplete",
  "scrub-failed",
  "scrub-unverified",
  "unsupported-key-backend",
  "upload-failed",
  "upstream-size-mismatch",
  // The Worker's record of a re-pull, as a run meets it (create, transition, screen, merge).
  "invalid-body",
  "invalid-id",
  "env-fence",
  "not-found",
  "not-a-mirror",
  "anonymous-dataset",
  "withdrawn",
  "import-in-flight",
  "repull-in-flight",
  "merge-unreconciled",
  "version-facts-disagree",
  "tag-already-pulled",
  "stale-status",
  "bad-transition",
  "use-verified-route",
  "merge-claim-held",
  "field-not-allowed",
  "field-missing",
  "field-invalid",
  "immutable-field",
  "screen-not-clear",
  "screen-changed",
  "screen-exempt",
  "screen-exists",
  "screen-not-found",
  "screen-blocks",
  "screen-not-acknowledgeable",
  "not-screenable",
  "not-the-head",
  "head-moved",
  "pr-draft",
  "github-unreadable",
  "merge-cap",
  "merge-cap-unreadable",
  "already-acknowledged",
  "already-merged",
  "already-released",
  "claim-mismatch",
  "claim-too-recent",
  "compare-unresolved",
  "no-claim",
  "not-merged",
  "not-released",
  "pull-request-merged",
  "pull-request-mismatch",
  "pull-request-missing",
  "tag-mismatch",
  "tag-missing",
  "lock-unrecorded",
] as const;
export type DispatchCode = (typeof DISPATCH_CODES)[number];

export function isDispatchCode(value: unknown): value is DispatchCode {
  return typeof value === "string" && (DISPATCH_CODES as readonly string[]).includes(value);
}

/**
 * Refusals another run at the same tag would meet again, because they are facts about the tag's
 * plan or about the dataset, or about a run that left a record no later run can take up: a
 * dataset refused for one of these is not dispatched again for that tag (an administrator may
 * still re-pull it by hand). They are of four kinds. Plan content: `auto-not-clean-plan` is the
 * word for a plan whose `unexplained`, `conflicts` and `corrections` counts are not each stated
 * and zero (`automaticPlanRefusal` tests the three separately), and `key-without-pin` for a copy
 * key upstream records no pinned version for, and the ledger, dead-key, concept DOI and gitlink
 * words are the plan's own. Size: `auto-copy-too-large` is a copy whose size is not stated or is
 * over the bound. Dataset: `anonymous-dataset` and `not-a-mirror`. Run: `token-expired` as a run
 * reports it `refused`, once GitHub stopped taking the App token after the run wrote its record
 * (the registration and the pull request use the token, after the copy): a later run would plan
 * again over what the copy wrote and meet a record it cannot take up, so an administrator takes
 * the record on (a token refused at the preparation's clone, before the copy, is taken the same
 * way, the safe direction). A token refused before anything was written is reported `failed`,
 * which this list does not hold.
 */
export const DISPATCH_FINAL_CODES = [
  "auto-not-clean-plan",
  "auto-copy-too-large",
  "auto-copy-too-long",
  "ledger-correction-unexplained",
  "key-without-pin",
  "dead-recording-unpinned",
  "target-names-dead-key",
  "concept-doi-disagrees",
  "gitlink",
  "anonymous-dataset",
  "not-a-mirror",
  "token-expired",
] as const satisfies readonly DispatchCode[];

/**
 * Why an automatic re-pull waits where it is (`upstream_repulls.hold_reason`): the first rule of
 * the machine-clean definition that does not hold (`shared/repull-machine-clean.ts` lists the rules
 * in the order that yields these words, `MACHINE_CLEAN_HOLDS`), or a bound the automatic path
 * reached: `cap-exhausted` (a day's units of a cap are used), `cap-unreadable` (a cap is set to
 * something its reader cannot take, so it reads 0: a fault in the configuration, not a full day),
 * `resume-exhausted` (a row that
 * stalled before its pull request opened was dispatched as often as the automatic path dispatches
 * one), `resume-refused` (its last run refused, so another would refuse again), and the later
 * slices' `finish-exhausted` and `merge-refused`; and `gates-refused`, a row machine clean found
 * clean whose edge into `gates_clear` the record's own transition refused (the refusal's code is in
 * the advance tick's log), which should not happen and is seen when it does. A hold is an
 * observation, never a transition.
 */
export const REPULL_HOLD_REASONS = [
  "not-production",
  "switch-off",
  "merge-switch-off",
  "not-automatic",
  "has-corrections",
  "dataset-anonymous",
  "dataset-withdrawn",
  "import-in-flight",
  "dataset-not-mirror",
  "pr-unreadable",
  "pr-closed",
  "pr-mismatch",
  "pr-draft",
  "pr-not-app",
  "head-moved",
  "main-unreadable",
  "main-moved",
  "checks-unreadable",
  "bids-pending",
  "bids-failed",
  "version-check-pending",
  "version-check-failed",
  "screen-pending",
  "screen-unreported",
  "screen-acknowledge",
  "screen-blocks",
  "screen-unchecked",
  "screen-rerun",
  "screen-error",
  "screen-unreadable",
  "screen-exempt",
  "review-absent",
  "review-running",
  "review-not-pass",
  "review-exempt",
  "review-unreadable",
  "not-clean",
  "gates-refused",
  "cap-exhausted",
  "cap-unreadable",
  "claim-held",
  "resume-exhausted",
  "resume-refused",
  "finish-exhausted",
  "merge-refused",
] as const;
export type HoldReason = (typeof REPULL_HOLD_REASONS)[number];

/**
 * What the scheduler's daily tick concluded (`upstream_repull_scheduler.last_outcome`).
 *
 * Before the scan, in this order: the open switch is off (`switch-off`); the open cap is set to
 * something unreadable (`cap-unreadable`) or to 0 (`cap-zero`); the Worker is not a release
 * build, so a run could not install its CLI (`cli-unreleased`); the Worker has no callback secret,
 * so no dispatch token can be signed (`unconfigured`); the two first re-pulls have not both been
 * run by hand to `complete` (`waiting-for-manual-run`); today's units are used (`cap-reached`).
 *
 * During the scan the dispatch record's claim can end the tick with four of the same words, read
 * at the moment it claims: `switch-off`, `cap-unreadable`, `unconfigured`, and `cap-reached` when
 * the day filled while the tick ran (another tick claimed the last unit). After the scan: it ran,
 * whether or not it dispatched anything (`ran`); GitHub refused a send in a way the next mirror
 * would meet too (a credential it does not take, a rate limit, or a second refusal in one tick),
 * so the tick stopped before that mirror (`send-refused`); OpenNeuro, or every probe of OpenNeuro's
 * GitHub mirror, could not be read, so nothing was dispatched from what could not be seen and the
 * cursor did not move (`blind`); something failed (`error`). A tick outside exact production
 * stores nothing at all.
 */
export const REPULL_SCHEDULER_OUTCOMES = [
  "switch-off",
  "cap-unreadable",
  "cap-zero",
  "cli-unreleased",
  "unconfigured",
  "waiting-for-manual-run",
  "cap-reached",
  "ran",
  "send-refused",
  "blind",
  "error",
] as const;
export type SchedulerOutcome = (typeof REPULL_SCHEDULER_OUTCOMES)[number];

/**
 * The shape of every fixed word the automatic path stores (a dispatch code, a hold reason, the
 * scheduler's outcome): what migration 0111's CHECKs admit, so the database refuses anything a
 * message or a path could look like even from a writer that skips the service.
 */
export const FIXED_WORD_RE = /^[a-z0-9-]{1,64}$/;

/**
 * The planner whose plans the automatic path takes. A plan another planner made was made under
 * other rules, so the Worker refuses it at the automatic create (`auto-planner-version`); the CLI's
 * `PLANNER_VERSION` must equal it.
 */
export const CURRENT_PLANNER_VERSION = 2;

/**
 * The most an automatic plan may copy, in bytes (1 TiB): a larger copy, or one of unknown size, is
 * refused at the automatic create (`auto-copy-too-large`), so one run fits a runner's job. The
 * administrator's path has no such bound.
 */
export const AUTO_MAX_COPY_BYTES = 1024 ** 4;

/** A dispatch token as the Worker signs it: an HMAC-SHA256 digest in lowercase hex. */
export const DISPATCH_TOKEN_RE = /^[0-9a-f]{64}$/;

/**
 * The App token's hour (ADR 0111, the Phase 7d amendment). The central workflow mints the token
 * before it installs anything, an installation token lasts one hour, and everything an automatic
 * run does with it, the registration, the push, the pull request and the settle of its head, must
 * end inside that hour. The run plans for fifty-five minutes of it, measured from when the
 * workflow noted the mint (`NEMAR_REPULL_TOKEN_SINCE`), and keeps five back for the clocks and the
 * last calls.
 */
export const APP_TOKEN_USABLE_SECONDS = 55 * 60;

/**
 * The settle's share of the hour: its five-minute quiet window and a minute for its reads. The
 * settle is cut at the end of the usable hour, whatever `--settle-minutes` asks.
 */
export const AUTO_SETTLE_RESERVE_SECONDS = 6 * 60;

/**
 * What follows the copy and needs the token, before the settle: the registration, the push of the
 * release branch and the pull request. An allowance, not a measurement.
 */
export const AUTO_AFTER_COPY_SECONDS = 5 * 60;

/**
 * Everything else from the mint to the push, not the copy: the install, the two plans, the
 * preparation and the steps after the copy ({@link AUTO_AFTER_COPY_SECONDS} among them). An
 * allowance no measurement here bounds; each run logs how long its steps took, so the first
 * production runs can check it.
 */
export const AUTO_OTHER_STEPS_SECONDS = 29 * 60;

/**
 * The automatic copy's time budget, in seconds: what the usable hour leaves once the settle's
 * share and the other steps' allowance are kept back, twenty minutes. A plan whose copy
 * {@link automaticCopySeconds} puts past it is refused before the copy starts
 * (`auto-copy-too-long`), at the plan and again from the live plan at execute, as a copy over
 * {@link AUTO_MAX_COPY_BYTES} is. Before the copy and before each push the run also checks the time
 * already spent (`auto-token-hour`), and a run that fails with the token expired anyway says so
 * (`token-expired`).
 */
export const AUTO_COPY_BUDGET_SECONDS =
  APP_TOKEN_USABLE_SECONDS - AUTO_SETTLE_RESERVE_SECONDS - AUTO_OTHER_STEPS_SECONDS;

/**
 * The bytes a second the estimate takes: 30 MiB/s, the server-side CopyObject rate ADR 0064 records
 * as measured into NEMAR's bucket, for the whole copy, with no credit for the eight copies in flight.
 */
export const AUTO_COPY_BYTES_PER_SECOND = 30 * 1024 ** 2;

/**
 * The seconds an object adds whatever its size: the copy makes three `aws` calls an object, and one
 * call measured about 0.29 s of process start and request against a local stand-in on 2026-10-25
 * (a real S3 call adds its network time), so a second an object, with no credit for concurrency.
 */
export const AUTO_COPY_SECONDS_PER_OBJECT = 1;

/** How long the estimate says a copy of `bytes` in `objects` objects takes, in seconds. */
export function automaticCopySeconds(c: { bytes: number; objects: number }): number {
  return c.bytes / AUTO_COPY_BYTES_PER_SECOND + c.objects * AUTO_COPY_SECONDS_PER_OBJECT;
}

/**
 * The largest dispatch or re-pull id a dispatch's payload carries, and its shape as a string: one
 * bound for the Worker that sends it, the central workflow that checks it and the CLI that reads
 * it, so none of the three takes an id another refuses. Fifteen digits, inside a safe integer.
 */
export const DISPATCH_ID_MAX = 999_999_999_999_999;
export const DISPATCH_ID_RE = /^[1-9][0-9]{0,14}$/;

/**
 * The unattended run's job bound, in minutes: the `timeout-minutes` of the central
 * `run-upstream-repull` workflow, which `test/repull-workflow.test.ts` pins to this.
 */
export const REPULL_JOB_TIMEOUT_MINUTES = 330;

/** How long a dispatched run is assumed to wait in GitHub's queue before its job starts. */
export const REPULL_DISPATCH_QUEUE_MINUTES = 60;

/**
 * Whether a run dispatched at any minute of the UTC hour `hour` ends, queueing and the whole job
 * bound included, before that UTC day does. The open cap counts the dispatches of a UTC day
 * (ADR 0111's Phase 7b amendment, "The open cap"), so it bounds the pull requests opened in a day
 * only while every dispatch it counts opens its pull request that same day: the daily tick's
 * hour, and the last hour any open dispatch is claimed, must each pass this.
 */
export function opensTheSameUtcDay(hour: number): boolean {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return false;
  return hour * 60 + 59 + REPULL_DISPATCH_QUEUE_MINUTES + REPULL_JOB_TIMEOUT_MINUTES < 24 * 60;
}

/** The one place a run's log may be: a run of the central workflow in `nemarDatasets/.github`. */
export const DISPATCH_RUN_URL_RE =
  /^https:\/\/github\.com\/nemarDatasets\/\.github\/actions\/runs\/\d{1,20}$/;

/**
 * How every error the automatic path records on a re-pull row begins: `[auto:<code>]`. It is not
 * the preparation's prefix (`[prepare:`), so a `prepared` self-edge, which clears an error of the
 * preparation's own, never clears one the automatic path recorded.
 */
export const AUTOMATIC_ERROR_PREFIX = "[auto:";

/** A dispatch row as the Worker reads it. */
export interface DispatchRow {
  id: number;
  kind: DispatchKind;
  dataset_id: string;
  upstream_ds: string;
  from_tag: string;
  to_tag: string;
  repull_id: number | null;
  /** The one-shot secret, set exactly while the dispatch is live. Never leaves the Worker. */
  nonce: string | null;
  status: DispatchStatus;
  code: string | null;
  workflow_run_url: string | null;
  dispatched_at: string;
  reported_at: string | null;
}
