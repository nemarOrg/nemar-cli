/**
 * What the acceptance of a re-pull merge made without its trailers reads on GitHub, and the one
 * thing it writes there (epic #1046; ADR 0111, the amendment of 2026-10-29; issue #1996): a
 * commit's tree and parents, a tree's own entries, the privacy ledger at a commit or at `main`,
 * GitHub's comparison of two commits, and the leased write of the ledger on `main`. The decisions
 * these answers feed are `upstream-repull-acceptance.ts`'s; the pure rules over them are
 * `shared/repull-merge-acceptance.ts`'s.
 *
 * Every read goes through `githubRead`, so a GitHub that cannot be read is a refusal
 * (`github-unreadable`, 502) and never an answer. The one write is the Contents API's, with the
 * Worker's own credential and the identity every backend commit on a dataset carries.
 */

import {
  ENRICHMENT_MAX_COMMITS,
  LEDGER_REPO_PATH,
  type TreeEntry,
  isEnrichmentPath,
} from "../../../shared/repull-merge-acceptance.js";
import { type RepullRow, SHA_RE } from "../../../shared/repull-state.js";
import type { Bindings } from "../types/bindings.js";
import { getDatasetsTokenWithRefresher } from "./github-auth.js";
import { NEMAR_COMMITTER, isContentsApiShaConflict } from "./github/contents.js";
import { GITHUB_API, ORG_NAME, ghHeaders } from "./github/shared.js";
import { githubFetchWithRetry } from "./github/transport.js";
import { githubRead, isObject, unreadable } from "./upstream-repull-github.js";
import type { RepullRefusal } from "./upstream-repull.js";

/** The attestation commit's message: fixed words, nothing about the dataset. */
export const ATTESTATION_MESSAGE =
  "Record the acceptance of a re-pull merge made without its trailers";

/** GitHub's comparison lists at most this many files: a list this long may not be all of them. */
const COMPARE_FILES_MAX = 300;

/** A read's answer, or the refusal an unread GitHub is. */
export type Read<T> = { ok: true; value: T } | { ok: false; refusal: RepullRefusal };

/** A commit as the Git Data API answers it: its tree and its parents; null when there is none. */
export async function readCommit(
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

/** A tree's own entries (not recursive), as the Git Data API answers them; null when absent. */
export async function readTree(
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
export async function readLedger(
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

/** GitHub's comparison of `base...head` (`head` may be `main`): its fields, or null for a 404. */
async function compare(
  env: Bindings,
  row: RepullRow,
  base: string,
  head: string,
): Promise<Read<Record<string, unknown> | null>> {
  const read = await githubRead(env, row.dataset_id, `/compare/${base}...${head}`);
  if (!read.ok) return read;
  if (read.status !== 200) return { ok: true, value: null };
  return isObject(read.body)
    ? { ok: true, value: read.body }
    : { ok: false, refusal: unreadable("a comparison", "its shape") };
}

/**
 * Whether `to` is `from`, or descends from it with every path GitHub's comparison names one
 * enrichment writes (`isEnrichmentPath`), added or modified, in at most enrichment's bound of
 * commits. The Worker's reading of "moved by enrichment only": GitHub names paths, not what was
 * written, and the CLI reads each commit's content as well. A comparison GitHub cannot make (no
 * common history) is a no; an unread one is a refusal, never a yes.
 */
export async function movedByEnrichmentOnly(
  env: Bindings,
  row: RepullRow,
  from: string,
  to: string,
): Promise<Read<boolean>> {
  if (from === to) return { ok: true, value: true };
  const c = await compare(env, row, from, to);
  if (!c.ok) return c;
  const b = c.value;
  if (b === null || b.status !== "ahead") return { ok: true, value: false };
  const ahead = b.ahead_by;
  const files = b.files;
  if (typeof ahead !== "number" || !Array.isArray(files)) {
    return { ok: false, refusal: unreadable("a comparison", "its shape") };
  }
  if (ahead > ENRICHMENT_MAX_COMMITS || files.length >= COMPARE_FILES_MAX) {
    return { ok: true, value: false };
  }
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
 * Whether `main` holds the merge: GitHub's comparison of the merge with `main` says `identical`
 * or `ahead`. A `main` rewritten or force-pushed past the merge holds it no longer, and a line
 * naming it would name an id the history does not hold, which fails the fresh-clone proof.
 */
export async function mergeOnMain(
  env: Bindings,
  row: RepullRow,
  merge: string,
): Promise<Read<boolean>> {
  const c = await compare(env, row, merge, "main");
  if (!c.ok) return c;
  const status = c.value?.status;
  return { ok: true, value: status === "identical" || status === "ahead" };
}

/**
 * One Contents API write of the ledger on `main`, leased on the blob `sha` it was read at: GitHub
 * refuses it when another writer changed the ledger in between (`isContentsApiShaConflict`, the
 * test every Contents write here shares), so nothing that writer appended is dropped. Sent once; a
 * caller that lost the answer reads the ledger again and finds the line.
 */
export async function putLedger(
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
  if (isContentsApiShaConflict(res.status, answer)) return { kind: "conflict" };
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
