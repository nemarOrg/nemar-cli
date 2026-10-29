/**
 * N.0.1: NEMAR's corrections replayed onto the released N.0.0 (ADR 0111, decisions 1 and 3; epic
 * #1046 phase 6). N.0.0 took upstream's side of every path; once it is merged, tagged, minted and
 * its objects locked, this makes one commit on the new `main` that puts back NEMAR's own side of
 * each correction the plan listed, and of each conflict an administrator resolved to NEMAR's side
 * (`--take-ours`), for a second pull request into `main`.
 *
 * What it replays, per path, is the plan's `ours` identity, read from NEMAR's `main` as N.0.0 was
 * based on it (the record's `base_sha`, in NEMAR's own history): `absent` is a deletion, `A:<key>`
 * the annexed entry NEMAR had (its symlink or pointer, byte for byte; the key's object must be in
 * NEMAR's bucket and its location log must hold it at `nemar-s3`), `G:<mode>:<oid>` the blob NEMAR
 * had. The entry at the base must still be what the plan read, or nothing is made
 * (`patch-ours-moved`). The README family is replayed as a unit: a correction or a resolution of
 * one member takes every member of the family. `dataset_description.json` is N.0.0's, as `main`
 * holds it, with each corrected key (and each key resolved with
 * `--take-ours dataset_description.json#<Key>`) set to NEMAR's value, or removed where NEMAR had
 * none, and `Version` N.0.1.
 *
 * No scrub and no copy: every replayed byte is in a version NEMAR already published, which ADR 0091
 * leaves as it is; the identifier screen still reads the head before the merge (ADR 0111: the
 * merge waits for a clean screen of the head). A dataset whose privacy ledger records a correction
 * never reaches here (the plan refuses any unexplained path for it), and this refuses one all the
 * same (`patch-ledger`), from the plan and from `main`.
 *
 * The commit is a function of NEMAR's `main` at the base, the new `main`, the plan, the resolutions
 * and the N.0.0 merge commit (whose committer time it carries, with the fixed re-pull identity), so
 * it is made the same every time; a run that pushed it and could not record it finds it again by
 * making it once more for the branch's own parent. Its message ends with the re-pull's two trailers
 * and `Repull-Patch: corrections=<n>`.
 */

import { join } from "node:path";
import { isDead, presentIn, readLocationLogsAt } from "../../../scripts/scrub/git/git-lib.js";
import { LEDGER_REPO_PATH, TOOL_ACTIONS, parseLedgerText } from "../../../scripts/scrub/ledger.js";
import { isKeyPresentAtDeclaredSize } from "../../../shared/annex-key.js";
import {
  type CanonicalJsonValue,
  canonicalJson,
} from "../../../shared/neurobagel/canonical-json.js";
import { REPULL_PATCH_TRAILER, repullPatchTrailerLine } from "../../../shared/repull-squash.js";
import { type RepullRow, patchVersionOf } from "../../../shared/repull-state.js";
import { DESCRIPTION_PATH } from "./description.js";
import type { PlanBody } from "./digest.js";
import { annexKeyOfEntry, stripBom } from "./edits.js";
import { ENRICHMENT_MAX_COMMITS, enrichmentOnlySince } from "./execute/head.js";
import { type OriginScratch, fetchInto } from "./execute/origin.js";
import { type TreeLine, blobAt, datesOf, hashBlob, treeOf } from "./execute/resynthesize.js";
import { ExecuteRefused } from "./execute/verify-plan.js";
import { REPULL_IDENTITY, git } from "./execute/workdir.js";
import { repullTrailerLines, trailersProblem } from "./trailers.js";

/** The trailer N.0.1's commit carries beside the re-pull's two (one definition, in `shared/`). */
export const PATCH_TRAILER = REPULL_PATCH_TRAILER;

/** `--take-ours` names a description key as `dataset_description.json#<Key>`. */
const KEY_SEPARATOR = "#";

/** One path N.0.1 replays: the plan's identity of NEMAR's side. */
export interface PatchPath {
  path: string;
  ours: string;
}

/** What N.0.1 replays, from the plan and the administrator's resolutions. */
export interface PatchSelection {
  paths: PatchPath[];
  /** Description keys set to NEMAR's value; `ours` null removes the key. */
  keys: Array<{ key: string; ours: string | null }>;
  /** The plan's own count of corrections (path decisions), the trailer's number. */
  corrections: number;
  /** Conflicts resolved to NEMAR's side (`--take-ours`), each counted once. */
  resolutions: number;
  /**
   * Conflicts the plan lists that no resolution took (a path, the README family counted by member,
   * or a description key): they stay on upstream's side, which only `--keep-upstream` decides.
   */
  unresolved: number;
}

function refuse(code: string, message: string): ExecuteRefused {
  return new ExecuteRefused(code, message);
}

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

interface PlanRow {
  path: string;
  group: string | null;
  ours: string;
  cls: string;
}

function planRows(body: PlanBody): PlanRow[] {
  if (!Array.isArray(body.paths)) throw refuse("plan-schema", "The plan has no path list.");
  return body.paths.map((raw) => {
    const r = record(raw);
    if (
      !r ||
      typeof r.path !== "string" ||
      typeof r.ours !== "string" ||
      typeof r.class !== "string" ||
      (r.group !== null && typeof r.group !== "string")
    ) {
      throw refuse("plan-schema", "The plan's path list does not have the planner's shape.");
    }
    return { path: r.path, group: r.group as string | null, ours: r.ours, cls: r.class };
  });
}

function descriptionKeys(body: PlanBody): Array<{ key: string; cls: string; ours: string | null }> {
  const description = record(body.description);
  if (!description || !Array.isArray(description.keys)) {
    throw refuse(
      "plan-schema",
      "The plan's description section does not have the planner's shape.",
    );
  }
  return description.keys.map((raw) => {
    const r = record(raw);
    if (
      !r ||
      typeof r.key !== "string" ||
      typeof r.class !== "string" ||
      (r.ours !== null && typeof r.ours !== "string")
    ) {
      throw refuse("plan-schema", "The plan's description keys do not have the planner's shape.");
    }
    return { key: r.key, cls: r.class, ours: r.ours as string | null };
  });
}

/**
 * The plan's count of recorded privacy corrections (ADR 0085). N.0.1 exists only when the ledger
 * records none: the plan refuses any unexplained path otherwise, so a non-zero count here is a plan
 * that should never have been executed (`patch-ledger`).
 */
export function assertPatchLedger(body: PlanBody): void {
  const ledger = record(body.ledger);
  if (!ledger || ledger.recorded_corrections !== 0) {
    throw refuse(
      "patch-ledger",
      "The plan does not say the privacy ledger records no correction, and N.0.1 replays corrections only for a dataset whose ledger records none.",
    );
  }
}

/**
 * What N.0.1 replays: every correction of the plan, and every conflict `takeOurs` names (a path, or
 * `dataset_description.json#<Key>`). A name that is not a conflict of the plan refuses
 * (`take-ours-invalid`), before anything is read or written.
 */
export function patchSelection(body: PlanBody, takeOurs: readonly string[]): PatchSelection {
  const rows = planRows(body);
  const keys = descriptionKeys(body);
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const chosen = new Map<string, PatchPath>();
  const take = (r: PlanRow) => {
    // The README family replays as a unit: every member, NEMAR's side of each.
    const unit = r.group === "readme" ? rows.filter((m) => m.group === "readme") : [r];
    for (const m of unit) chosen.set(m.path, { path: m.path, ours: m.ours });
  };
  for (const r of rows) {
    if (r.cls === "correction" && r.path !== DESCRIPTION_PATH) take(r);
  }
  const chosenKeys = new Map<string, string | null>();
  for (const k of keys) if (k.cls === "correction") chosenKeys.set(k.key, k.ours);

  const named = [...new Set(takeOurs)];
  for (const name of named) {
    const at = name.indexOf(KEY_SEPARATOR);
    if (at >= 0 && name.slice(0, at) === DESCRIPTION_PATH) {
      const key = name.slice(at + 1);
      const k = keys.find((x) => x.key === key);
      if (!k || k.cls !== "conflict") {
        throw refuse(
          "take-ours-invalid",
          `--take-ours ${DESCRIPTION_PATH}${KEY_SEPARATOR}<Key> names a key the plan does not list as a conflict.`,
        );
      }
      chosenKeys.set(k.key, k.ours);
      continue;
    }
    const r = byPath.get(name);
    if (!r || r.cls !== "conflict" || r.path === DESCRIPTION_PATH) {
      throw refuse(
        "take-ours-invalid",
        `A --take-ours path is not one the plan lists as a conflict (a conflict of ${DESCRIPTION_PATH} is named by its key, ${DESCRIPTION_PATH}${KEY_SEPARATOR}<Key>).`,
      );
    }
    take(r);
  }
  const counts = record(body.counts);
  const corrections = counts?.corrections;
  if (typeof corrections !== "number" || !Number.isSafeInteger(corrections) || corrections < 0) {
    throw refuse("plan-schema", "The plan does not state how many corrections it has.");
  }
  const unresolved =
    rows.filter((r) => r.cls === "conflict" && r.path !== DESCRIPTION_PATH && !chosen.has(r.path))
      .length + keys.filter((k) => k.cls === "conflict" && !chosenKeys.has(k.key)).length;
  return {
    paths: [...chosen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    keys: [...chosenKeys]
      .map(([key, ours]) => ({ key, ours }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    corrections,
    resolutions: named.length,
    unresolved,
  };
}

/** Whether there is anything to replay. */
export function hasReplay(s: PatchSelection): boolean {
  return s.paths.length > 0 || s.keys.length > 0;
}

/**
 * The privacy ledger on `main`, read in the scratch repository: its recorded corrections (every
 * line that is not a tool's own: a scrub's, or the acceptance of a merge made without its
 * trailers) must be none, as the plan said (`patch-ledger`). A ledger that
 * does not parse refuses the same way: unknown is never none.
 */
async function assertLedgerOnMain(dir: string, main: string): Promise<void> {
  const text = await blobAt(dir, main, LEDGER_REPO_PATH);
  if (text === null) return;
  let recorded: number;
  try {
    recorded = parseLedgerText(text).filter((l) => !TOOL_ACTIONS.has(l.action)).length;
  } catch {
    recorded = -1;
  }
  if (recorded !== 0) {
    throw refuse(
      "patch-ledger",
      recorded < 0
        ? "The privacy ledger on NEMAR's main does not parse, so whether it records a correction is not known; N.0.1 is not made."
        : `The privacy ledger on NEMAR's main records ${recorded} correction(s), and N.0.1 replays corrections only for a dataset whose ledger records none.`,
    );
  }
}

/** The annex key an entry names, read from its blob, or null when it names none. */
async function keyOfEntry(dir: string, e: TreeLine): Promise<string | null> {
  if (e.mode !== "120000" && e.mode !== "100644" && e.mode !== "100755") return null;
  const r = await git(dir, ["cat-file", "blob", e.oid], { ok: true });
  if (r.exitCode !== 0) return null;
  return annexKeyOfEntry(e.mode, Buffer.from(r.stdout, "latin1"));
}

/** The entry `ours` names at the base, proved: what the plan read is still what the base holds. */
async function oursEntry(
  dir: string,
  base: Map<string, TreeLine>,
  p: PatchPath,
): Promise<{ entry: TreeLine | null; key: string | null }> {
  const e = base.get(p.path) ?? null;
  const moved = () =>
    refuse(
      "patch-ours-moved",
      "A path N.0.1 replays is no longer, on NEMAR's main as N.0.0 was based on it, what the plan read; plan again.",
    );
  if (p.ours === "absent") {
    if (e) throw moved();
    return { entry: null, key: null };
  }
  if (!e) throw moved();
  const g = /^G:(\d{6}):([0-9a-f]{40})$/.exec(p.ours);
  if (g) {
    if (e.mode !== g[1] || e.oid !== g[2]) throw moved();
    return { entry: e, key: null };
  }
  if (p.ours.startsWith("A:")) {
    const key = p.ours.slice(2);
    if ((await keyOfEntry(dir, e)) !== key) throw moved();
    return { entry: e, key };
  }
  throw refuse("plan-schema", "A replayed path's identity does not have the planner's shape.");
}

/** N.0.0's description with the replayed keys set to NEMAR's values and `Version` N.0.1. */
function patchedDescription(raw: string, keys: PatchSelection["keys"], version: string): string {
  let desc: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stripBom(raw));
    if (!record(parsed)) throw new Error("not an object");
    desc = parsed as Record<string, unknown>;
  } catch {
    throw refuse(
      "patch-description-unreadable",
      `N.0.0's ${DESCRIPTION_PATH} on NEMAR's main does not parse as a JSON object.`,
    );
  }
  for (const { key, ours } of keys) {
    // `__proto__` assigned would set the object's prototype, not a key, and the key would be lost.
    if (key === "__proto__") {
      throw refuse(
        "patch-description-unreadable",
        `A ${DESCRIPTION_PATH} key N.0.1 replays is named __proto__, which is not written as a key.`,
      );
    }
    if (ours === null) {
      delete desc[key];
      continue;
    }
    try {
      desc[key] = JSON.parse(ours);
    } catch {
      throw refuse(
        "patch-description-unreadable",
        `NEMAR's value of a ${DESCRIPTION_PATH} key N.0.1 replays, as the plan records it, does not parse as JSON.`,
      );
    }
  }
  desc.Version = version;
  return canonicalJson(desc as CanonicalJsonValue);
}

/** The commit's message: a subject, counts, and the trailers as its last paragraph. */
export function patchMessage(row: RepullRow, s: PatchSelection, version: string): string {
  const [snapshot, plan] = repullTrailerLines(row);
  return [
    `Replay NEMAR's corrections onto ${row.upstream_ds} ${row.to_tag} as v${version}`,
    "",
    `Corrections the plan listed: ${s.corrections}; conflicts resolved to NEMAR's side: ${s.resolutions}; paths replayed: ${s.paths.length}; description keys replayed: ${s.keys.length}.`,
    "",
    snapshot,
    plan,
    repullPatchTrailerLine(s.corrections),
    "",
  ].join("\n");
}

/** What a made N.0.1 commit holds, for the caller's checks and the record. */
export interface PatchCommit {
  sha: string;
  tree: string;
  /** Every annex key a replayed path names: in NEMAR's bucket and at `nemar-s3`, checked by the caller. */
  keys: string[];
}

/** Write `entries` as a tree in the scratch repository, through a private index. */
async function writeTree(dir: string, entries: TreeLine[], name: string): Promise<string> {
  const env = { GIT_INDEX_FILE: join(dir, name) };
  await git(dir, ["read-tree", "--empty"], { env, code: "synthesis-failed", step: "read-tree" });
  await git(dir, ["update-index", "-z", "--index-info"], {
    env,
    stdin: entries.map((e) => `${e.mode} ${e.oid}\t${e.path}\0`).join(""),
    code: "synthesis-failed",
    step: "update-index",
  });
  return (
    await git(dir, ["write-tree"], { env, code: "synthesis-failed", step: "write-tree" })
  ).stdout.trim();
}

async function commitTree(
  dir: string,
  tree: string,
  parent: string,
  message: string,
  dates: { author: string; committer: string },
): Promise<string> {
  return (
    await git(dir, ["commit-tree", "--no-gpg-sign", tree, "-p", parent, "-F", "-"], {
      stdin: message,
      code: "synthesis-failed",
      step: "commit-tree",
      env: {
        GIT_AUTHOR_NAME: REPULL_IDENTITY.name,
        GIT_AUTHOR_EMAIL: REPULL_IDENTITY.email,
        GIT_AUTHOR_DATE: dates.author,
        GIT_COMMITTER_NAME: REPULL_IDENTITY.name,
        GIT_COMMITTER_EMAIL: REPULL_IDENTITY.email,
        GIT_COMMITTER_DATE: dates.committer,
      },
    })
  ).stdout.trim();
}

/** The N.0.0 merge commit's committer time, `<epoch> <zone>`: the date N.0.1's commit carries. */
async function mergeTime(dir: string, mergeSha: string): Promise<string> {
  const r = await git(dir, ["cat-file", "commit", mergeSha], { ok: true });
  const committer = /^committer .* (\d+ [+-]\d{4})$/m.exec(r.stdout)?.[1];
  if (r.exitCode !== 0 || !committer) {
    throw refuse(
      "origin-unreadable",
      "N.0.0's merge commit could not be read from NEMAR's repository.",
    );
  }
  return committer;
}

/**
 * Make N.0.1's commit on `parent` (the new `main`), in the scratch repository, which must hold
 * `parent`, the record's base and the merge commit. Deterministic; nothing is pushed. A replayed path
 * whose entry on `parent` is not the merge commit's refuses (`patch-main-moved`): enrichment wrote
 * it after the merge, and what enrichment wrote is never undone.
 */
export async function patchCommit(args: {
  scratch: OriginScratch;
  row: RepullRow;
  selection: PatchSelection;
  parent: string;
}): Promise<PatchCommit> {
  const { scratch, row, selection, parent } = args;
  const dir = scratch.dir;
  const version = patchVersionOf(row.to_version);
  if (!version) throw refuse("plan-schema", "The record's version has no patch version.");
  for (const commit of [parent, row.base_sha, row.merge_sha as string]) {
    if (!(await hasCommit(dir, commit)) && !(await fetchInto(scratch, commit, 1))) {
      throw refuse(
        "origin-unreadable",
        "A commit N.0.1 is made from could not be fetched from NEMAR's repository.",
      );
    }
  }
  await assertLedgerOnMain(dir, parent);
  const base = new Map((await treeOf(dir, row.base_sha)).map((e) => [e.path, e]));
  const entries = new Map((await treeOf(dir, parent)).map((e) => [e.path, e]));
  if (parent !== row.merge_sha) {
    const merged = new Map((await treeOf(dir, row.merge_sha as string)).map((e) => [e.path, e]));
    for (const p of selection.paths) {
      const a = entries.get(p.path);
      const b = merged.get(p.path);
      if (a?.mode !== b?.mode || a?.oid !== b?.oid) {
        throw refuse(
          "patch-main-moved",
          "NEMAR's main moved by enrichment on a path N.0.1 replays, so N.0.1 is not made on it; decline N.0.1 (nemar admin repull abandon) and correct the dataset by hand.",
        );
      }
    }
  }
  const keys = new Set<string>();
  for (const p of selection.paths) {
    const { entry, key } = await oursEntry(dir, base, p);
    entries.delete(p.path);
    if (entry) entries.set(p.path, entry);
    if (key) keys.add(key);
  }
  // A replayed file where the new tree holds a directory, or under a path it holds as a file.
  for (const p of selection.paths) {
    if (!entries.has(p.path)) continue;
    const dirPrefix = `${p.path}/`;
    const parents = p.path.split("/").slice(0, -1);
    const clash =
      [...entries.keys()].some((q) => q.startsWith(dirPrefix)) ||
      parents.some((_, i) => entries.has(parents.slice(0, i + 1).join("/")));
    if (clash) {
      throw refuse(
        "patch-path-conflict",
        "A path N.0.1 replays is a directory in N.0.0, or lies under a file N.0.0 holds.",
      );
    }
  }
  const desc = entries.get(DESCRIPTION_PATH);
  const raw = desc ? await blobAt(dir, parent, DESCRIPTION_PATH) : null;
  if (!desc || raw === null) {
    throw refuse(
      "patch-description-unreadable",
      `NEMAR's main holds no ${DESCRIPTION_PATH} to set N.0.1's version in.`,
    );
  }
  entries.set(DESCRIPTION_PATH, {
    mode: desc.mode,
    oid: await hashBlob(dir, patchedDescription(raw, selection.keys, version)),
    path: DESCRIPTION_PATH,
  });
  const tree = await writeTree(dir, [...entries.values()], "patch.index");
  const when = await mergeTime(dir, row.merge_sha as string);
  const message = patchMessage(row, selection, version);
  const problem = await trailersProblem(message, row);
  if (problem)
    throw refuse(
      "synthesis-mismatch",
      `N.0.1's message would not carry the trailers (${problem}).`,
    );
  const sha = await commitTree(dir, tree, parent, message, { author: when, committer: when });
  return { sha, tree, keys: [...keys].sort() };
}

async function hasCommit(dir: string, sha: string): Promise<boolean> {
  return (await git(dir, ["cat-file", "-e", `${sha}^{commit}`], { ok: true })).exitCode === 0;
}

/**
 * Every annex key N.0.1 replays must be NEMAR's: its object in NEMAR's bucket at the size the key
 * declares (`listing`, the prefix's objects by relative key), and NEMAR's git-annex branch holding
 * it at `nemar-s3` and not dead (`patch-key-absent`, `patch-key-dead`). N.0.1 copies nothing, so a
 * key that fails either would be named by `main` with no content behind it.
 */
export async function assertReplayedKeys(args: {
  dir: string;
  annexRef: string;
  keys: string[];
  nemarUuid: string;
  listing: Map<string, number>;
}): Promise<void> {
  if (args.keys.length === 0) return;
  const absent = args.keys.filter((k) => !isKeyPresentAtDeclaredSize(k, args.listing)).length;
  if (absent > 0) {
    throw refuse(
      "patch-key-absent",
      `${absent} of the ${args.keys.length} annexed key(s) N.0.1 replays are not in NEMAR's bucket at their declared size; N.0.1 copies nothing, so it is not made.`,
    );
  }
  let logs: string[];
  try {
    logs = await readLocationLogsAt(args.dir, args.annexRef, args.keys);
  } catch {
    throw refuse(
      "origin-unreadable",
      "NEMAR's git-annex branch could not be read for the keys N.0.1 replays.",
    );
  }
  const dead = logs.filter((l) => isDead(l)).length;
  if (dead > 0) {
    throw refuse(
      "patch-key-dead",
      `${dead} annexed key(s) N.0.1 replays are marked dead on NEMAR's git-annex branch.`,
    );
  }
  const unheld = logs.filter((l) => !presentIn(l).has(args.nemarUuid)).length;
  if (unheld > 0) {
    throw refuse(
      "patch-key-absent",
      `${unheld} annexed key(s) N.0.1 replays are not recorded at nemar-s3 on NEMAR's git-annex branch.`,
    );
  }
}

/** The commit's parent, when it has exactly one. */
async function onlyParent(dir: string, commit: string): Promise<string | null> {
  const parents = (
    await git(dir, ["rev-list", "--parents", "-n", "1", commit], { ok: true })
  ).stdout
    .trim()
    .split(" ");
  return parents.length === 2 ? (parents[1] as string) : null;
}

/**
 * The N.0.1 commit in `head`'s history: the first commit, walking back from `head` past
 * enrichment-shaped commits, whose parent is the N.0.0 merge or an enrichment-shaped descendant of
 * it and whose message carries the re-pull's trailers and {@link PATCH_TRAILER}. Null when there is
 * none within enrichment's bound. The scratch repository must hold `head`'s history.
 */
export async function findPatchCommit(args: {
  dir: string;
  row: RepullRow;
  head: string;
}): Promise<{ commit: string; parent: string } | null> {
  const { dir, row } = args;
  let candidate = args.head;
  for (let i = 0; i <= ENRICHMENT_MAX_COMMITS; i++) {
    const parent = await onlyParent(dir, candidate);
    if (!parent) return null;
    const message = await commitMessage(dir, candidate);
    if (
      message !== null &&
      new RegExp(`^${PATCH_TRAILER}: corrections=\\d+$`, "m").test(message) &&
      (await trailersProblem(message, row)) === null &&
      (await enrichmentOnlySince(dir, row.merge_sha as string, parent)).ok &&
      (await enrichmentOnlySince(dir, candidate, args.head)).ok
    ) {
      return { commit: candidate, parent };
    }
    candidate = parent;
  }
  return null;
}

async function commitMessage(dir: string, commit: string): Promise<string | null> {
  const raw = await git(dir, ["cat-file", "commit", commit], { ok: true });
  const split = raw.stdout.indexOf("\n\n");
  return raw.exitCode === 0 && split >= 0 ? raw.stdout.slice(split + 2) : null;
}

/**
 * N.0.1's commit made again on a `main` that moved by enrichment (`newMain`, an enrichment-shaped
 * descendant of the commit's own parent, which the caller has checked): the same changes, applied
 * to the new `main`'s tree, with the commit's message, identity and dates. A path the commit
 * changes that enrichment changed too refuses (`patch-main-moved`): what enrichment did is never
 * undone, and the replay is not merged by hand.
 */
export async function patchResynthesizedCommit(args: {
  dir: string;
  commit: string;
  newMain: string;
}): Promise<{ sha: string; tree: string }> {
  const { dir, commit, newMain } = args;
  const parent = await onlyParent(dir, commit);
  if (!parent) throw refuse("synthesis-mismatch", "N.0.1's commit does not have one parent.");
  const raw = (
    await git(dir, ["cat-file", "commit", commit], { code: "synthesis-failed", step: "cat-file" })
  ).stdout;
  const split = raw.indexOf("\n\n");
  if (split < 0) throw refuse("synthesis-mismatch", "N.0.1's commit has no message.");
  const dates = datesOf(raw.slice(0, split));
  const message = raw.slice(split + 2);
  const before = new Map((await treeOf(dir, parent)).map((e) => [e.path, e]));
  const after = new Map((await treeOf(dir, commit)).map((e) => [e.path, e]));
  const main = new Map((await treeOf(dir, newMain)).map((e) => [e.path, e]));
  const same = (a: TreeLine | undefined, b: TreeLine | undefined) =>
    a?.mode === b?.mode && a?.oid === b?.oid;
  const changed = new Set<string>();
  for (const p of new Set([...before.keys(), ...after.keys()])) {
    if (!same(before.get(p), after.get(p))) changed.add(p);
  }
  for (const p of changed) {
    if (!same(before.get(p), main.get(p))) {
      throw refuse(
        "patch-main-moved",
        "NEMAR's main moved by enrichment on a path N.0.1 replays, so N.0.1 is not made again on it; decline N.0.1 (nemar admin repull abandon) and correct the dataset by hand.",
      );
    }
    const e = after.get(p);
    if (e) main.set(p, e);
    else main.delete(p);
  }
  const tree = await writeTree(dir, [...main.values()], "patch-again.index");
  const sha = await commitTree(dir, tree, newMain, message, dates);
  return { sha, tree };
}

/**
 * Whether `head`, a head of N.0.1's release branch that does not descend from the recorded head, is
 * N.0.1's commit made again on a moved `main` by a run that pushed it and could not record it: it,
 * or an ancestor of it from which it moved by enrichment only, is exactly what
 * {@link patchResynthesizedCommit} makes of the recorded commit for that ancestor's own parent, an
 * enrichment-shaped descendant of the recorded base. Returns what to record (the commit, its tree and
 * its parent), or null.
 */
export async function recognizePatchResynthesis(args: {
  dir: string;
  row: RepullRow;
  recorded: string;
  head: string;
}): Promise<{ sha: string; tree: string; baseSha: string } | null> {
  const { dir, row } = args;
  let candidate = args.head;
  for (let i = 0; i <= ENRICHMENT_MAX_COMMITS; i++) {
    const parent = await onlyParent(dir, candidate);
    if (!parent) return null;
    if ((await enrichmentOnlySince(dir, row.patch_base_sha as string, parent)).ok) {
      try {
        const made = await patchResynthesizedCommit({
          dir,
          commit: args.recorded,
          newMain: parent,
        });
        if (made.sha === candidate) {
          return (await enrichmentOnlySince(dir, candidate, args.head)).ok
            ? { sha: candidate, tree: made.tree, baseSha: parent }
            : null;
        }
      } catch (err) {
        if (!(err instanceof ExecuteRefused)) throw err;
      }
    }
    candidate = parent;
  }
  return null;
}
