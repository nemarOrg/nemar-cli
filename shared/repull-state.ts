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
const BEFORE_MERGE: readonly RepullStatus[] = [
  "planned",
  "prepared",
  "copied",
  "registered",
  "pr_open",
  "gates_clear",
];

/** The states that may end `patch_declined`: N.0.0 released, N.0.1 not yet merged. */
const PATCH_OPEN: readonly RepullStatus[] = ["released", "patch_synthesized", "patch_gates_clear"];

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
    ["copied", "registered"],
    ["registered", "pr_open"],
    ["pr_open", "pr_open"],
    ["pr_open", "gates_clear"],
    ["gates_clear", "pr_open"],
    ["gates_clear", "gates_clear"],
    ["gates_clear", "merged"],
    ["merged", "released"],
    ["released", "released"],
    ["released", "complete"],
    ["released", "patch_synthesized"],
    ["patch_synthesized", "patch_synthesized"],
    ["patch_synthesized", "patch_gates_clear"],
    ["patch_gates_clear", "patch_synthesized"],
    ["patch_gates_clear", "patch_gates_clear"],
    ["patch_gates_clear", "patch_merged"],
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
 *  - `planned`: record why a step could not finish (the error is the whole write);
 *  - `released`: record the count of locked objects once the lock has been applied;
 *  - `gates_clear` and `patch_gates_clear`: record the claim to merge, before the merge is sent.
 *    The caller names the screened head; the Worker stamps the time with its own clock, because a
 *    caller-stated time could be backdated or set ahead and defeat the sweep for stuck claims.
 */
export const SELF_EDGE_FIELDS: Readonly<Partial<Record<RepullStatus, TransitionFields>>> = {
  planned: { may: NONE, must: NONE, reset: NONE, requiresError: true },
  released: { may: ["counts"], must: ["counts"], reset: NONE },
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
 * `prepared` row found intact, restored from its checkpoint, prepared again to the same commit, or
 * prepared again onto a moved base takes this edge. The other self-edges write one thing beside
 * the stage and keep the error.
 */
export const CLEARING_SELF_EDGES = ["prepared"] as const satisfies readonly RepullStatus[];

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
