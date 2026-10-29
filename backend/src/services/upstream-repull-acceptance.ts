/**
 * An administrator's acceptance of a re-pull's squash merge made without its trailers (epic #1046;
 * ADR 0111, the amendment of 2026-10-29; issue #1996), and the one ledger line NEMAR writes for it.
 *
 *   POST /admin/repulls/:id/merge-trailers/accept   { pr, merge_sha, reason? }
 *
 * NEMAR's merge gate writes a re-pull's squash message so that its last paragraph is the re-pull
 * commit's trailers; the privacy ledger's fresh-clone proof (ADR 0085) reads the merge as the
 * re-pull's own commit only then. A merge made outside the gate (GitHub's merge button) has none,
 * `resume` refuses its release (`merge-trailers`), and rewriting `main` is no repair: the tag, a
 * minted DOI and public clones name the commit. So an administrator may accept the merge, and the
 * acceptance is earned by what the Worker reads on GitHub with its own credential, never by the
 * reason or by the caller's word. In this order, the first that does not hold refuses with its
 * word and writes nothing:
 *  1. The record at `merged` (`n0`) or `patch_merged` (`n1`), its merge commit the one named
 *     (`merge-mismatch`); a record an administrator opened (`accept-automatic`: the automatic
 *     path's merges are the Worker's, written with the trailers), and opened by this administrator
 *     (`accept-not-yours`).
 *  2. The recorded pull request, read on GitHub: the record's number, its release branch into
 *     `main` of the dataset's own repository (`readRecordedPullRequest`), merged, with GitHub's
 *     merge commit the record's (`merge-mismatch`), at the recorded head or one GitHub's comparison
 *     shows moved from it only on paths enrichment writes (`merge-head-foreign`).
 *  3. The merge commit, read on GitHub: one parent (`merge-not-squash`), which is the record's base
 *     or a descendant of it moved only on paths enrichment writes (`merge-parent-foreign`).
 *  4. Its tree, the same as the record's commit outside `.nemar/**` and `.github/**`: N.0.0's
 *     synthesized tree, N.0.1's gated head (`merge-tree-mismatch`; `tree-anchor-missing` for an
 *     N.0.1 merged before its gates were recorded, which the release cannot compare either), the
 *     comparison the release makes for the tag, read from the two root trees.
 *  5. What it did to the privacy ledger: nothing, or appended scrub lines and edited none before
 *     them (`merge-ledger-foreign` otherwise, which the proof refuses whatever is accepted).
 * Then the acceptance is recorded with its reason (one row, `upstream_repull_merge_acceptances`,
 * and an audit row, `repull_merge_trailers_accepted`), once: a second request for the same merge
 * replays it and writes no second row, its reason not needed.
 *
 * THE ATTESTATION. When the merge appended a `repull-scrubbed` line beside other files, the one
 * shape the proof needs it for, the Worker appends to the ledger on `main` one line naming the
 * merge commit (`shared/repull-merge-acceptance.ts`), in a commit of its own through the Contents
 * API, leased on the ledger blob it read, so a line another writer appended in between is never
 * dropped: GitHub refuses the write and it is read again. The line is a function of the stored
 * acceptance, so a write whose answer was lost is found on the next request and not written twice.
 * The release is refused until the line is seen on `main` (`acceptance-unattested`, in
 * `upstream-repull-verified.ts`). A line on `main` naming this merge that is not NEMAR's bytes is
 * `attestation-conflict`, never overwritten.
 *
 * Nothing here moves the record, merges, tags or mails anyone. The reason never leaves NEMAR's
 * database: the ledger refuses free text by design (ADR 0085, ADR 0036).
 */

import { z } from "zod";
import {
  ACKNOWLEDGMENT_MAX_LENGTH,
  ACKNOWLEDGMENT_MIN_LENGTH,
} from "../../../shared/publication-limits.js";
import {
  LEDGER_REPO_PATH,
  type TreeEntry,
  acceptedMergesOf,
  isEnrichmentPath,
  ledgerChange,
  ledgerLines,
  ledgerTimeOf,
  mergeAcceptanceLine,
  sameOutsideNemar,
} from "../../../shared/repull-merge-acceptance.js";
import {
  PULL_REQUEST_COLUMNS,
  REPULL_PULL_REQUESTS,
  type RepullPullRequest,
  type RepullRow,
  SHA_RE,
} from "../../../shared/repull-state.js";
import { AUDIT_IF_PREVIOUS_CHANGED_SQL, auditLogParams } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { getDatasetsTokenWithRefresher } from "./github-auth.js";
import { GITHUB_API, ORG_NAME, ghHeaders } from "./github/shared.js";
import { githubFetchWithRetry } from "./github/transport.js";
import {
  githubRead,
  isObject,
  readRecordedPullRequest,
  unreadable,
} from "./upstream-repull-github.js";
import { type RepullRefusal, envFenceRefusal, getRepull } from "./upstream-repull.js";

/** The most commits enrichment makes between two of NEMAR's own writes (`execute/head.ts`). */
const ENRICHMENT_MAX_COMMITS = 20;

/** The identity of the attestation's commit: the one every backend commit on a dataset carries. */
const NEMAR_COMMITTER = { name: "nemarAdmin", email: "nemarAdmin@osc.earth" };

/** The attestation commit's message: fixed words, nothing about the dataset. */
export const ATTESTATION_MESSAGE =
  "Record the acceptance of a re-pull merge made without its trailers";

export const acceptMergeSchema = z
  .object({
    pr: z.enum(REPULL_PULL_REQUESTS),
    merge_sha: z.string().regex(SHA_RE, "merge_sha must be a 40-character lowercase hex id"),
    // The publication path's rule for a reason (ADR 0086); needed only for a first acceptance.
    reason: z
      .string()
      .trim()
      .min(
        ACKNOWLEDGMENT_MIN_LENGTH,
        `The reason needs at least ${ACKNOWLEDGMENT_MIN_LENGTH} characters`,
      )
      .max(
        ACKNOWLEDGMENT_MAX_LENGTH,
        `The reason is limited to ${ACKNOWLEDGMENT_MAX_LENGTH} characters`,
      )
      .optional(),
  })
  .strict();

export type AcceptMergeBody = z.infer<typeof acceptMergeSchema>;

/** The acceptance as the API shows it. */
export interface MergeAcceptance {
  repull_id: number;
  pr: RepullPullRequest;
  merge_sha: string;
  reason: string;
  accepted_by: number;
  accepted_at: string;
  attestation_needed: 0 | 1;
  scanner: string | null;
  attestation_sha: string | null;
  attested_at: string | null;
}

/** What the Worker read before it accepted; the CLI prints it. */
export interface AcceptanceEvidence {
  pull_request: number;
  merged_head: string;
  head_moved_by_enrichment: boolean;
  parent: string;
  parent_moved_by_enrichment: boolean;
  tree: string;
  ledger: "untouched" | "scrub-lines" | "repull-scrub-lines";
}

export interface AcceptResult {
  acceptance: MergeAcceptance;
  /** Null on a replay: this request read nothing new, and the first request's answer said it. */
  evidence: AcceptanceEvidence | null;
  /** The ledger line on `main`, when one is needed; null when the proof needs none. */
  attestation_line: string | null;
  replayed: boolean;
}

export const ACCEPTANCE_SQL =
  "SELECT * FROM upstream_repull_merge_acceptances WHERE repull_id = ? AND pr = ?";

/**
 * The acceptance, inserted only while the record is as it was read (`?1` repull, `?2` status,
 * `?3` revision, `?4` merge column's value), so a record that moved in between gets no row.
 */
const INSERT_ACCEPTANCE_SQL = (
  mergeColumn: string,
) => `INSERT INTO upstream_repull_merge_acceptances
   (repull_id, pr, merge_sha, reason, accepted_by, attestation_needed, scanner)
   SELECT ?1, ?5, ?4, ?6, ?7, ?8, ?9
    WHERE EXISTS (SELECT 1 FROM upstream_repulls
                   WHERE id = ?1 AND status = ?2 AND revision = ?3 AND ${mergeColumn} = ?4)
      AND NOT EXISTS (SELECT 1 FROM upstream_repull_merge_acceptances WHERE repull_id = ?1 AND pr = ?5)`;

export async function readAcceptance(
  db: D1Database,
  repullId: number,
  pr: RepullPullRequest,
): Promise<MergeAcceptance | null> {
  return db.prepare(ACCEPTANCE_SQL).bind(repullId, pr).first<MergeAcceptance>();
}

// ----------------------------------------------------------------------------
// GitHub reads
// ----------------------------------------------------------------------------

type Read<T> = { ok: true; value: T } | { ok: false; refusal: RepullRefusal };

/** A commit as the Git Data API answers it: its tree and its parents. */
async function readCommit(
  env: Bindings,
  row: RepullRow,
  sha: string,
): Promise<Read<{ tree: string; parents: string[] } | null>> {
  const read = await githubRead(env, row.dataset_id, `/git/commits/${sha}`);
  if (!read.ok) return read;
  if (read.status !== 200) return { ok: true, value: null };
  const b = read.body;
  const tree = isObject(b) && isObject(b.tree) ? b.tree.sha : null;
  const parents = isObject(b) && Array.isArray(b.parents) ? b.parents : null;
  if (typeof tree !== "string" || !SHA_RE.test(tree) || parents === null) {
    return { ok: false, refusal: unreadable(`commit ${sha.slice(0, 12)}`, "its shape") };
  }
  const ids = parents.map((p) => (isObject(p) ? p.sha : null));
  if (!ids.every((p): p is string => typeof p === "string" && SHA_RE.test(p))) {
    return { ok: false, refusal: unreadable(`commit ${sha.slice(0, 12)}`, "its parents") };
  }
  return { ok: true, value: { tree, parents: ids } };
}

/** A tree's own entries (not recursive), as the Git Data API answers them. */
async function readTree(
  env: Bindings,
  row: RepullRow,
  sha: string,
): Promise<Read<TreeEntry[] | null>> {
  const read = await githubRead(env, row.dataset_id, `/git/trees/${sha}`);
  if (!read.ok) return read;
  if (read.status !== 200) return { ok: true, value: null };
  const b = read.body;
  if (!isObject(b) || !Array.isArray(b.tree) || b.truncated === true) {
    return { ok: false, refusal: unreadable(`tree ${sha.slice(0, 12)}`, "its shape") };
  }
  const entries: TreeEntry[] = [];
  for (const e of b.tree) {
    if (
      !isObject(e) ||
      typeof e.path !== "string" ||
      typeof e.mode !== "string" ||
      typeof e.type !== "string" ||
      typeof e.sha !== "string"
    ) {
      return { ok: false, refusal: unreadable(`tree ${sha.slice(0, 12)}`, "an entry") };
    }
    entries.push({ path: e.path, mode: e.mode, type: e.type, sha: e.sha });
  }
  return { ok: true, value: entries };
}

/** The ledger at `ref` (a commit id or `main`): its text and blob id, or null when there is none. */
async function readLedger(
  env: Bindings,
  row: RepullRow,
  ref: string,
): Promise<Read<{ text: string; sha: string } | null>> {
  const read = await githubRead(
    env,
    row.dataset_id,
    `/contents/${LEDGER_REPO_PATH}?ref=${encodeURIComponent(ref)}`,
  );
  if (!read.ok) return read;
  if (read.status === 404) return { ok: true, value: null };
  const b = read.body;
  if (
    read.status !== 200 ||
    !isObject(b) ||
    b.type !== "file" ||
    b.encoding !== "base64" ||
    typeof b.content !== "string" ||
    typeof b.sha !== "string"
  ) {
    return { ok: false, refusal: unreadable(`the ledger at ${ref.slice(0, 12)}`, "its shape") };
  }
  const bytes = Uint8Array.from(atob(b.content.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  let text: string;
  try {
    // `ignoreBOM: true` keeps a byte-order mark in the text, so the bytes compared and extended
    // are the bytes on `main`.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, refusal: unreadable(`the ledger at ${ref.slice(0, 12)}`, "not UTF-8") };
  }
  return { ok: true, value: { text, sha: b.sha } };
}

/**
 * Whether `to` is `from`, or descends from it with every path GitHub's comparison names one
 * enrichment writes (`isEnrichmentPath`), added or modified, in at most enrichment's bound of
 * commits. The Worker's reading of "moved by enrichment only": GitHub names paths, not what was
 * written, and the CLI reads each commit's content as well. Unread is a refusal, never a yes.
 */
async function movedByEnrichmentOnly(
  env: Bindings,
  row: RepullRow,
  from: string,
  to: string,
): Promise<Read<boolean>> {
  if (from === to) return { ok: true, value: true };
  const read = await githubRead(env, row.dataset_id, `/compare/${from}...${to}`);
  if (!read.ok) return read;
  if (read.status !== 200) return { ok: true, value: false };
  const b = read.body;
  if (!isObject(b) || b.status !== "ahead") return { ok: true, value: false };
  const ahead = b.ahead_by;
  const files = b.files;
  if (typeof ahead !== "number" || !Array.isArray(files)) {
    return { ok: false, refusal: unreadable("a comparison", "its shape") };
  }
  // GitHub lists at most 300 files: a longer list is not all of them, and is not enrichment.
  if (ahead > ENRICHMENT_MAX_COMMITS || files.length >= 300) return { ok: true, value: false };
  return {
    ok: true,
    value: files.every(
      (f) =>
        isObject(f) &&
        typeof f.filename === "string" &&
        (f.status === "added" || f.status === "modified") &&
        isEnrichmentPath(f.filename),
    ),
  };
}

/**
 * Whether the merge changed any path but the ledger against its parent: the root trees outside
 * `.nemar`, then, when only `.nemar` differs, its entries but the ledger.
 */
async function changesBesideLedger(
  env: Bindings,
  row: RepullRow,
  parentTree: TreeEntry[],
  mergeTree: TreeEntry[],
): Promise<Read<boolean>> {
  const key = (e: TreeEntry) => `${e.mode} ${e.type} ${e.sha} ${e.path}`;
  const rest = (t: TreeEntry[], skip: string) =>
    t
      .filter((e) => e.path !== skip)
      .map(key)
      .sort()
      .join("\n");
  if (rest(parentTree, ".nemar") !== rest(mergeTree, ".nemar")) return { ok: true, value: true };
  const sub = (t: TreeEntry[]) => t.find((e) => e.path === ".nemar" && e.type === "tree")?.sha;
  const a = sub(parentTree);
  const b = sub(mergeTree);
  if (a === b) return { ok: true, value: false };
  if (a === undefined || b === undefined) return { ok: true, value: true };
  const left = await readTree(env, row, a);
  if (!left.ok) return left;
  const right = await readTree(env, row, b);
  if (!right.ok) return right;
  if (left.value === null || right.value === null) {
    return { ok: false, refusal: unreadable("the .nemar tree", "not found") };
  }
  const ledgerName = LEDGER_REPO_PATH.slice(".nemar/".length);
  return { ok: true, value: rest(left.value, ledgerName) !== rest(right.value, ledgerName) };
}

// ----------------------------------------------------------------------------
// The acceptance
// ----------------------------------------------------------------------------

function refusal(code: string, message: string, row?: RepullRow): RepullRefusal {
  return { status: 409, code, message, ...(row ? { row } : {}) };
}

/** Accept the merge (see the module comment), or replay an acceptance already recorded. */
export async function acceptRepullMerge(
  env: Bindings,
  admin: { id: number },
  id: number,
  body: AcceptMergeBody,
): Promise<AcceptResult | RepullRefusal> {
  const db = env.DB;
  const row = await getRepull(db, id);
  if (!row) return { status: 404, code: "not-found", message: `No re-pull #${id}.` };
  const fence = envFenceRefusal(env, row.dataset_id);
  if (fence) return fence;
  const cols = PULL_REQUEST_COLUMNS[body.pr];

  const stored = await readAcceptance(db, id, body.pr);
  if (stored) {
    if (stored.merge_sha !== body.merge_sha) {
      return refusal(
        "merge-mismatch",
        `Re-pull #${id} accepted the merge ${stored.merge_sha.slice(0, 12)}, not ${body.merge_sha.slice(0, 12)}.`,
        row,
      );
    }
    return attest(env, row, body.pr, stored, null, true);
  }
  if (body.reason === undefined) {
    return refusal(
      "merge-trailers-not-accepted",
      `No acceptance of the merge of the ${body.pr} pull request is recorded for re-pull #${id}; accepting it needs a reason.`,
      row,
    );
  }
  if (row.status !== cols.merged) {
    return refusal(
      "bad-transition",
      `A merge made without its trailers is accepted while the record is ${cols.merged}; re-pull #${id} is ${row.status}.`,
      row,
    );
  }
  if (row[cols.mergeSha] !== body.merge_sha) {
    return refusal(
      "merge-mismatch",
      `Re-pull #${id} records the merge ${String(row[cols.mergeSha]).slice(0, 12)}, not ${body.merge_sha.slice(0, 12)}.`,
      row,
    );
  }
  if (row.origin !== "administrator") {
    return refusal(
      "accept-automatic",
      `Re-pull #${id} was opened by the automatic path, whose merges the Worker sends with the trailers; a merge of it without them is not accepted.`,
      row,
    );
  }
  if (row.actor_user_id !== admin.id) {
    return refusal(
      "accept-not-yours",
      `Re-pull #${id} was opened by another administrator; only the administrator who opened a re-pull accepts its merge.`,
      row,
    );
  }

  // 2. The pull request, on GitHub.
  const pull = await readRecordedPullRequest(env, row, body.pr);
  if (!pull.ok) return { ...pull.refusal, row };
  const facts = pull.facts;
  const number = row[cols.number] as number;
  if (!facts.merged || facts.mergeCommitSha !== body.merge_sha) {
    return refusal(
      "merge-mismatch",
      facts.merged
        ? `GitHub says pull request #${number} merged as ${String(facts.mergeCommitSha).slice(0, 12)}, not ${body.merge_sha.slice(0, 12)}.`
        : `GitHub says pull request #${number} is not merged.`,
      row,
    );
  }
  const recordedHead = row[cols.head] as string;
  const head = await movedByEnrichmentOnly(env, row, recordedHead, facts.headSha);
  if (!head.ok) return { ...head.refusal, row };
  if (!head.value) {
    return refusal(
      "merge-head-foreign",
      `Pull request #${number} merged at ${facts.headSha.slice(0, 12)}, which is not the recorded head ${recordedHead.slice(0, 12)} or a commit enrichment moved it to.`,
      row,
    );
  }

  // 3. The merge commit: one parent, the base or an enrichment-moved descendant of it.
  const merge = await readCommit(env, row, body.merge_sha);
  if (!merge.ok) return { ...merge.refusal, row };
  if (merge.value === null) {
    return { ...unreadable(`commit ${body.merge_sha.slice(0, 12)}`, "not found"), row };
  }
  if (merge.value.parents.length !== 1) {
    return refusal(
      "merge-not-squash",
      `The merge commit ${body.merge_sha.slice(0, 12)} has ${merge.value.parents.length} parents; a squash merge has one.`,
      row,
    );
  }
  const parent = merge.value.parents[0] as string;
  const base = (body.pr === "n0" ? row.base_sha : row.patch_base_sha) as string;
  const parentOk = await movedByEnrichmentOnly(env, row, base, parent);
  if (!parentOk.ok) return { ...parentOk.refusal, row };
  if (!parentOk.value) {
    return refusal(
      "merge-parent-foreign",
      `The merge commit's parent ${parent.slice(0, 12)} is not the record's base ${base.slice(0, 12)} or a commit enrichment moved it to.`,
      row,
    );
  }

  // 4. The tree, outside NEMAR's own paths.
  let anchorTree: string | null;
  if (body.pr === "n0") {
    anchorTree = row.synth_tree;
  } else if (row.patch_gates_sha === null) {
    anchorTree = null;
  } else {
    const gated = await readCommit(env, row, row.patch_gates_sha);
    if (!gated.ok) return { ...gated.refusal, row };
    anchorTree = gated.value?.tree ?? null;
  }
  if (anchorTree === null) {
    return refusal(
      "tree-anchor-missing",
      `Re-pull #${id} records no gated head of its N.0.1 pull request, so the merged tree has nothing to be compared with.`,
      row,
    );
  }
  const mergedTree = await readTree(env, row, merge.value.tree);
  if (!mergedTree.ok) return { ...mergedTree.refusal, row };
  const recordedTree = await readTree(env, row, anchorTree);
  if (!recordedTree.ok) return { ...recordedTree.refusal, row };
  if (mergedTree.value === null || recordedTree.value === null) {
    return { ...unreadable("a tree", "not found"), row };
  }
  if (!sameOutsideNemar(mergedTree.value, recordedTree.value)) {
    return refusal(
      "merge-tree-mismatch",
      `The merge commit's tree is not the re-pull's ${body.pr === "n0" ? "commit" : "gated N.0.1 head"} outside .nemar/ and .github/.`,
      row,
    );
  }

  // 5. The ledger: what the merge did to it decides whether the proof needs an attestation.
  const before = await readLedger(env, row, parent);
  if (!before.ok) return { ...before.refusal, row };
  const after = await readLedger(env, row, body.merge_sha);
  if (!after.ok) return { ...after.refusal, row };
  const change = ledgerChange(before.value?.text ?? null, after.value?.text ?? null);
  if (change.kind === "other") {
    return refusal(
      "merge-ledger-foreign",
      "The merge commit changes the privacy ledger other than by appending a scrub's lines, which the fresh-clone proof refuses whatever is accepted.",
      row,
    );
  }
  let needed = false;
  if (change.kind === "scrub-append" && change.repull) {
    const parentTree = await readCommit(env, row, parent);
    if (!parentTree.ok) return { ...parentTree.refusal, row };
    const parentEntries = parentTree.value
      ? await readTree(env, row, parentTree.value.tree)
      : ({ ok: true, value: null } as const);
    if (!parentEntries.ok) return { ...parentEntries.refusal, row };
    if (parentEntries.value === null)
      return { ...unreadable("the parent's tree", "not found"), row };
    const beside = await changesBesideLedger(env, row, parentEntries.value, mergedTree.value);
    if (!beside.ok) return { ...beside.refusal, row };
    needed = beside.value;
  }
  if (needed && (change.kind !== "scrub-append" || change.scanner === null)) {
    return refusal(
      "merge-ledger-foreign",
      "The merge commit's repull-scrubbed line names no scanner.",
      row,
    );
  }
  const scanner = needed && change.kind === "scrub-append" ? change.scanner : null;

  const results = await db.batch([
    db
      .prepare(INSERT_ACCEPTANCE_SQL(cols.mergeSha))
      .bind(
        id,
        row.status,
        row.revision,
        body.merge_sha,
        body.pr,
        body.reason,
        admin.id,
        needed ? 1 : 0,
        scanner,
      ),
    db.prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL).bind(
      ...auditLogParams({
        userId: admin.id,
        action: "repull_merge_trailers_accepted",
        resourceType: "upstream_repull",
        resourceId: String(id),
        details: JSON.stringify({
          dataset_id: row.dataset_id,
          pr: body.pr,
          merge_sha: body.merge_sha,
          merged_head: facts.headSha,
          parent,
          attestation_needed: needed,
          reason: body.reason,
        }),
      }),
    ),
  ]);
  const recorded = await readAcceptance(db, id, body.pr);
  if ((results[0]?.meta?.changes ?? 0) === 0 || !recorded) {
    if (recorded && recorded.merge_sha === body.merge_sha) {
      return attest(env, row, body.pr, recorded, null, true);
    }
    const now = (await getRepull(db, id)) ?? row;
    return refusal(
      "stale-status",
      `Re-pull #${id} moved before the acceptance was recorded; it is ${now.status}.`,
      now,
    );
  }
  return attest(
    env,
    row,
    body.pr,
    recorded,
    {
      pull_request: number,
      merged_head: facts.headSha,
      head_moved_by_enrichment: facts.headSha !== recordedHead,
      parent,
      parent_moved_by_enrichment: parent !== base,
      tree: merge.value.tree,
      ledger:
        change.kind === "none"
          ? "untouched"
          : change.kind === "scrub-append" && change.repull
            ? "repull-scrub-lines"
            : "scrub-lines",
    },
    false,
  );
}

// ----------------------------------------------------------------------------
// The attestation
// ----------------------------------------------------------------------------

/** The line the stored acceptance asks for, or null when the proof needs none. */
export function attestationLineOf(row: RepullRow, a: MergeAcceptance): string | null {
  if (a.attestation_needed !== 1 || a.scanner === null) return null;
  return mergeAcceptanceLine({
    dataset: row.dataset_id,
    version: row[PULL_REQUEST_COLUMNS[a.pr].version] as string,
    mergeSha: a.merge_sha,
    planDigest: row.plan_digest,
    scanner: a.scanner,
    at: ledgerTimeOf(a.accepted_at),
  });
}

const MARK_ATTESTED_SQL = `UPDATE upstream_repull_merge_acceptances
   SET attestation_sha = ?3, attested_at = datetime('now')
 WHERE repull_id = ?1 AND pr = ?2 AND attestation_needed = 1 AND attested_at IS NULL`;

/** The ledger line on `main`, written when it is not there yet; then the acceptance's answer. */
async function attest(
  env: Bindings,
  row: RepullRow,
  pr: RepullPullRequest,
  acceptance: MergeAcceptance,
  evidence: AcceptanceEvidence | null,
  replayed: boolean,
): Promise<AcceptResult | RepullRefusal> {
  const line = attestationLineOf(row, acceptance);
  const done = async (sha: string | null): Promise<AcceptResult> => {
    if (acceptance.attested_at === null && line !== null) {
      await env.DB.prepare(MARK_ATTESTED_SQL).bind(row.id, pr, sha).run();
    }
    return {
      acceptance: (await readAcceptance(env.DB, row.id, pr)) ?? acceptance,
      evidence,
      attestation_line: line,
      replayed,
    };
  };
  if (line === null || acceptance.attested_at !== null) return done(acceptance.attestation_sha);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const current = await readLedger(env, row, "main");
    if (!current.ok) return { ...current.refusal, row };
    if (current.value === null) {
      return refusal(
        "ledger-missing-on-main",
        "The privacy ledger is not on main, so the acceptance has no ledger to extend; nothing was written.",
        row,
      );
    }
    const { text, sha } = current.value;
    if (acceptedMergesOf(text).includes(acceptance.merge_sha)) {
      if (ledgerLines(text).includes(line)) return done(null);
      return refusal(
        "attestation-conflict",
        "The ledger on main already names this merge in a line that is not NEMAR's acceptance as recorded; nothing was written, and an administrator looks.",
        row,
      );
    }
    const next = `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`;
    const written = await putLedger(env, row, next, sha);
    if (written.kind === "written") return done(written.commit);
    if (written.kind === "conflict") continue;
    return {
      status: 502,
      code: "attestation-unwritten",
      message: `The acceptance is recorded, and its ledger line could not be written to main (${written.why}); ask again, which writes it once.`,
      row,
    };
  }
  return {
    status: 409,
    code: "attestation-unwritten",
    message:
      "The ledger on main kept moving while the acceptance's line was written; ask again, which writes it once.",
    row,
  };
}

/**
 * One Contents API write of the ledger on `main`, leased on the blob `sha` it was read at: GitHub
 * refuses it (409, or a 422 saying the sha does not match) when another writer changed the ledger
 * in between, so nothing that writer appended is dropped. Sent once; a caller that lost the
 * answer reads the ledger again and finds the line.
 */
async function putLedger(
  env: Bindings,
  row: RepullRow,
  text: string,
  sha: string,
): Promise<
  { kind: "written"; commit: string } | { kind: "conflict" } | { kind: "failed"; why: string }
> {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  let res: Response;
  try {
    const { token, refresh } = await getDatasetsTokenWithRefresher(env);
    res = await githubFetchWithRetry(
      `${GITHUB_API()}/repos/${ORG_NAME}/${row.dataset_id}/contents/${LEDGER_REPO_PATH}`,
      {
        method: "PUT",
        headers: { ...ghHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({
          message: ATTESTATION_MESSAGE,
          content: btoa(binary),
          sha,
          branch: "main",
          committer: NEMAR_COMMITTER,
          author: NEMAR_COMMITTER,
        }),
        signal: AbortSignal.timeout(10_000),
      },
      { kind: "interactive", maxAttempts: 1, refreshTokenOn401: refresh },
    );
  } catch (err) {
    return { kind: "failed", why: err instanceof Error ? err.name : "no answer" };
  }
  const answer = await res.text().catch(() => "");
  if (res.status === 409 || (res.status === 422 && /does not match/i.test(answer))) {
    return { kind: "conflict" };
  }
  if (res.status !== 200 && res.status !== 201)
    return { kind: "failed", why: `HTTP ${res.status}` };
  let commit: unknown = null;
  try {
    const body = JSON.parse(answer) as unknown;
    commit = isObject(body) && isObject(body.commit) ? body.commit.sha : null;
  } catch {
    commit = null;
  }
  return typeof commit === "string" && SHA_RE.test(commit)
    ? { kind: "written", commit }
    : { kind: "failed", why: "an answer that names no commit" };
}
