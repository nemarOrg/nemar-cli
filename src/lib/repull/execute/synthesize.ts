/**
 * The re-pull's one commit (ADR 0111, decision 2): the prepared index, written as a tree and
 * committed onto the base, with the trailers that name the snapshot and the plan.
 *
 * It is synthesized with `git commit-tree`, so its only parent is the base: the local commits made
 * on the way (the materialized delta's and the scrub's) are never an ancestor, and nothing they
 * held is reachable from it. Its
 * identity is fixed and its dates are the row's `created_at`, so preparing twice from the same
 * plan gives the same tree and the same commit, which is what lets a lost working directory be
 * prepared again and compared with the recorded `synth_tree`.
 *
 * Before the commit is accepted, {@link assertSynthesized} checks the tree against the plan, and
 * after it, the originals of what the scrub changed in git are shown unreachable from it. Every
 * refusal is `synthesis-mismatch` and names counts only.
 */

import { createHash } from "node:crypto";
import {
  type CanonicalJsonValue,
  canonicalJson,
} from "../../../../shared/neurobagel/canonical-json.js";
import {
  PROVENANCE_PATH,
  PROVENANCE_README_PATH,
} from "../../../../shared/privacy-correction-text.js";
import { listAnnexedKeys } from "../../git-annex/transfer.js";
import {
  type ImportScrubResult,
  JSON_PATH,
  RECORDING_PATH,
  SCANS_TABLE_PATH,
} from "../../import-scrub.js";
import { type ImportManifestItem, isLocallyUploaded } from "../../s3-server-copy.js";
import type { PlanBody } from "../digest.js";
import { keyDigest } from "../edits.js";
import { isNemarOwnedPath } from "../overlay.js";
import { copyItems, planFacts } from "./body.js";
import { ExecuteRefused } from "./verify-plan.js";
import { REPULL_IDENTITY, WORK_BRANCH, git } from "./workdir.js";

export const COPY_MANIFEST_SCHEMA = "nemar.repull-copy";

/**
 * What the copy must bring into NEMAR's bucket for N.0.0, and what this host uploaded already: the
 * copy manifest. It is a function of the synthesized tree and the plan, so a later step can rebuild
 * it from the commit and compare its digest with the recorded one.
 */
export interface CopyManifest {
  schema: typeof COPY_MANIFEST_SCHEMA;
  version: 1;
  dataset: string;
  to_tag: string;
  plan_digest: string;
  /** Keys copied from upstream, each from the version the plan pinned. Sorted by key. */
  items: Array<{
    key: string;
    bucket: string;
    object: string;
    version: string;
    size: number | null;
  }>;
  /** Keys this host uploaded (scrubbed recordings, git-held data annexed). Sorted by key. */
  local: Array<{ key: string; size: number | null }>;
}

/** An index or tree entry with the annex key it names, when it names one. */
export interface Entry {
  mode: string;
  oid: string;
  key: string | null;
}

export function identityOf(e: Entry | undefined): string {
  if (!e) return "absent";
  return e.key ? `A:${e.key}` : `G:${e.mode}:${e.oid}`;
}

/** `sha256:<hex>` of the manifest's canonical JSON. */
export function manifestDigest(m: CopyManifest): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(m as unknown as CanonicalJsonValue))
    .digest("hex")}`;
}

/** The copy manifest of a tree: its named keys the plan copies, and those neither copied nor held. */
export function buildCopyManifest(args: {
  named: ReadonlySet<string>;
  body: PlanBody;
  digest: string;
  held: ReadonlySet<string>;
}): CopyManifest {
  const facts = planFacts(args.body);
  const copied = new Map(
    copyItems(args.body)
      .filter((i) => i.purpose === "copy" && i.pin)
      .map((i) => [i.key, i]),
  );
  const keys = [...args.named].sort();
  return {
    schema: COPY_MANIFEST_SCHEMA,
    version: 1,
    dataset: facts.datasetId,
    to_tag: facts.toTag,
    plan_digest: args.digest,
    items: keys
      .filter((k) => copied.has(k))
      .map((k) => {
        const i = copied.get(k) as NonNullable<ReturnType<typeof copied.get>>;
        const pin = i.pin as NonNullable<typeof i.pin>;
        return {
          key: k,
          bucket: pin.bucket,
          object: pin.object,
          version: pin.version,
          size: i.size,
        };
      }),
    local: keys
      .filter((k) => !copied.has(k) && !args.held.has(k))
      .map((k) => ({ key: k, size: keyDigest(k)?.size ?? null })),
  };
}

/** Every index entry (`git ls-files -s`) with the annex key it names, by path. */
export async function readIndex(work: string): Promise<Map<string, Entry>> {
  const r = await git(work, ["ls-files", "-s", "-z"], {
    code: "synthesis-failed",
    step: "ls-files",
  });
  const keys = await listAnnexedKeys(work);
  const out = new Map<string, Entry>();
  for (const line of r.stdout.split("\0")) {
    if (line === "") continue;
    const m = /^([0-7]{6}) ([0-9a-f]{40}) (\d)\t([\s\S]+)$/.exec(line);
    if (!m || m[3] !== "0") {
      throw new ExecuteRefused(
        "synthesis-failed",
        "The index holds an entry a re-pull does not write.",
      );
    }
    const path = m[4] as string;
    out.set(path, { mode: m[1] as string, oid: m[2] as string, key: keys.get(path) ?? null });
  }
  return out;
}

/** A tree's entries (`git ls-tree -r`), with the keys `keysByPath` says its paths name. */
export async function readTree(
  work: string,
  treeish: string,
  keysByPath: ReadonlyMap<string, string>,
): Promise<Map<string, Entry>> {
  const r = await git(work, ["ls-tree", "-r", "-z", "--full-tree", treeish], {
    code: "synthesis-failed",
    step: "ls-tree",
  });
  const out = new Map<string, Entry>();
  for (const line of r.stdout.split("\0")) {
    if (line === "") continue;
    const m = /^([0-7]{6}) (\S+) ([0-9a-f]{40})\t([\s\S]+)$/.exec(line);
    if (!m) throw new ExecuteRefused("synthesis-failed", "git ls-tree printed an unexpected line.");
    const path = m[4] as string;
    out.set(path, { mode: m[1] as string, oid: m[3] as string, key: keysByPath.get(path) ?? null });
  }
  return out;
}

function mismatch(what: string, n: number): ExecuteRefused {
  return new ExecuteRefused(
    "synthesis-mismatch",
    `The synthesized tree does not match the plan: ${n} ${what}.`,
  );
}

const PROVENANCE = new Set([PROVENANCE_PATH, PROVENANCE_README_PATH]);

/**
 * Refuse unless the synthesized tree is the plan's N.0.0 with the scrub's changes and nothing else:
 *  1. every path outside `.nemar/**` and `.github/**` has the plan's target (or, for a path the
 *     plan does not list, NEMAR's side as it was), except a recording the scrub re-keyed (its old
 *     key replaced, its new one uploaded), a git-held data file annexed (its key uploaded), a JSON
 *     the scrub blanked, a scans table whose dates it set, and a provenance file it annotated;
 *  2. no key the scrub replaced is named;
 *  3. every named key is one the plan counted held, one it copies, or one this host uploaded;
 *  4. the copy manifest is a subset of the plan's copy keys, and its local part only what this host
 *     uploaded, every upload being a local one that the tree names.
 */
export function assertSynthesized(args: {
  tree: ReadonlyMap<string, Entry>;
  base: ReadonlyMap<string, Entry>;
  expected: ReadonlyMap<string, string>;
  preScrub: ReadonlyMap<string, Entry>;
  scope: ReadonlySet<string>;
  body: PlanBody;
  scrub: ImportScrubResult;
  uploaded: readonly ImportManifestItem[];
  held: ReadonlySet<string>;
  manifest: CopyManifest;
}): void {
  const { tree, base, expected, preScrub, scope, scrub } = args;
  const localKeys = new Set(args.uploaded.map((i) => i.key));

  // 1. Path by path.
  let wrong = 0;
  const paths = new Set([...tree.keys(), ...base.keys(), ...expected.keys()]);
  for (const p of paths) {
    if (isNemarOwnedPath(p)) continue;
    const got = tree.get(p);
    const gotId = identityOf(got);
    const want = expected.get(p);
    // A git blob the scrub rewrote in place (a JSON blanked, a scans table dated, a provenance file
    // annotated): what was staged before the scrub is what the plan wanted.
    const scrubbedInPlace = (wantId: string) =>
      scope.has(p) &&
      got !== undefined &&
      got.key === null &&
      identityOf(preScrub.get(p)) === wantId &&
      gotId !== wantId &&
      (JSON_PATH.test(p) || SCANS_TABLE_PATH.test(p) || PROVENANCE.has(p));
    if (want === undefined) {
      const baseId = identityOf(base.get(p));
      if (gotId !== baseId && !(PROVENANCE.has(p) && scrubbedInPlace(baseId))) wrong++;
      continue;
    }
    if (want === "absent") {
      if (got) wrong++;
      continue;
    }
    if (want.startsWith("A:")) {
      const key = want.slice(2);
      const rekeyed =
        RECORDING_PATH.test(p) &&
        scrub.replacedKeys.has(key) &&
        got?.key != null &&
        localKeys.has(got.key);
      if (gotId !== want && !rekeyed) wrong++;
      continue;
    }
    if (want.startsWith("L:")) {
      // A git-held data file NEMAR's policy annexes: annexed, and its content uploaded from here.
      if (!got?.key || !localKeys.has(got.key)) wrong++;
      continue;
    }
    if (gotId !== want && !scrubbedInPlace(want)) wrong++;
  }
  if (wrong > 0) throw mismatch("path(s) differ from their target", wrong);

  // 2 and 3. The keys the tree names.
  const named = new Set<string>();
  for (const [p, e] of tree) if (e.key && !isNemarOwnedPath(p)) named.add(e.key);
  const replaced = [...named].filter((k) => scrub.replacedKeys.has(k)).length;
  if (replaced > 0) throw mismatch("key(s) the scrub replaced are still named", replaced);
  const copied = new Set(
    copyItems(args.body)
      .filter((i) => i.purpose === "copy")
      .map((i) => i.key),
  );
  const unaccounted = [...named].filter(
    (k) => !args.held.has(k) && !copied.has(k) && !localKeys.has(k),
  ).length;
  if (unaccounted > 0) {
    throw mismatch("named key(s) are neither held, copied by the plan, nor uploaded", unaccounted);
  }

  // 4. The manifest: a subset of the plan's copy keys, plus what this host uploaded.
  const outside = args.manifest.items.filter((i) => !copied.has(i.key)).length;
  if (outside > 0) throw mismatch("copy key(s) are outside the plan", outside);
  const strayLocal = args.manifest.local.filter((i) => !localKeys.has(i.key)).length;
  if (strayLocal > 0) throw mismatch("local key(s) were not uploaded by this run", strayLocal);
  const strayUploads = args.uploaded.filter(
    (i) => !isLocallyUploaded(i) || !named.has(i.key),
  ).length;
  if (strayUploads > 0) {
    throw mismatch("upload(s) are not a local upload the tree names", strayUploads);
  }
}

/** Every object reachable from `sha` (`git rev-list --objects`), by id. */
async function reachableObjects(work: string, sha: string): Promise<Set<string>> {
  const r = await git(work, ["rev-list", "--objects", sha], {
    code: "synthesis-failed",
    step: "rev-list",
  });
  const out = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    const id = line.slice(0, 40);
    if (/^[0-9a-f]{40}$/.test(id)) out.add(id);
  }
  return out;
}

/** `created_at` as D1 writes it (`YYYY-MM-DD HH:MM:SS`, UTC), or an ISO time, as a Date. */
export function rowTime(createdAt: string): Date {
  const iso = /[zZ]|[+-]\d\d:\d\d$/.test(createdAt) ? createdAt : `${createdAt.replace(" ", "T")}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new ExecuteRefused(
      "synthesis-failed",
      "The re-pull record's creation time does not parse.",
    );
  }
  return d;
}

export interface SynthesisCounts {
  written: number;
  deleted: number;
}

/**
 * Write the index as a tree, check it ({@link assertSynthesized}), commit it onto `baseSha` with
 * the fixed identity, the row's time and both trailers, check the scrubbed originals are not
 * reachable, and move {@link WORK_BRANCH} to it.
 */
export async function synthesizeCommit(args: {
  work: string;
  baseSha: string;
  createdAt: string;
  body: PlanBody;
  digest: string;
  scrub: ImportScrubResult;
  uploaded: readonly ImportManifestItem[];
  held: ReadonlySet<string>;
  base: ReadonlyMap<string, Entry>;
  expected: ReadonlyMap<string, string>;
  preScrub: ReadonlyMap<string, Entry>;
  scope: ReadonlySet<string>;
  counts: SynthesisCounts;
}): Promise<{
  synthSha: string;
  synthTree: string;
  manifest: CopyManifest;
  manifestDigest: string;
}> {
  const { work } = args;
  const facts = planFacts(args.body);
  const synthTree = (
    await git(work, ["write-tree"], { code: "synthesis-failed", step: "write-tree" })
  ).stdout.trim();
  const tree = await readIndex(work);
  const named = new Set<string>();
  for (const [p, e] of tree) if (e.key && !isNemarOwnedPath(p)) named.add(e.key);
  const manifest = buildCopyManifest({
    named,
    body: args.body,
    digest: args.digest,
    held: args.held,
  });
  assertSynthesized({
    tree,
    base: args.base,
    expected: args.expected,
    preScrub: args.preScrub,
    scope: args.scope,
    body: args.body,
    scrub: args.scrub,
    uploaded: args.uploaded,
    held: args.held,
    manifest,
  });

  const c = args.scrub.counts;
  const message = [
    `Re-pull ${facts.ds} ${facts.fromTag} to ${facts.toTag} as v${facts.toVersion}`,
    "",
    [
      `Upstream's snapshot ${facts.toTag} of ${facts.ds}, replayed onto NEMAR's main as one commit (ADR 0111).`,
      `Paths written: ${args.counts.written}; deleted: ${args.counts.deleted}.`,
      `Keys copied from upstream by version: ${manifest.items.length}; uploaded from this host: ${manifest.local.length}.`,
      `Recording headers scrubbed: ${c.headers_scrubbed}; acquisition dates set: ${c.headers_dates_normalized}; JSON values blanked: ${c.json_values_blanked}.`,
    ].join("\n"),
    "",
    `Upstream-Snapshot: ${facts.ds}@${facts.toTag}`,
    `Repull-Plan: ${args.digest}`,
    "",
  ].join("\n");
  const when = `${Math.floor(rowTime(args.createdAt).getTime() / 1000)} +0000`;
  const synthSha = (
    await git(work, ["commit-tree", "--no-gpg-sign", synthTree, "-p", args.baseSha, "-F", "-"], {
      stdin: message,
      code: "synthesis-failed",
      step: "commit-tree",
      env: {
        GIT_AUTHOR_NAME: REPULL_IDENTITY.name,
        GIT_AUTHOR_EMAIL: REPULL_IDENTITY.email,
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_NAME: REPULL_IDENTITY.name,
        GIT_COMMITTER_EMAIL: REPULL_IDENTITY.email,
        GIT_COMMITTER_DATE: when,
      },
    })
  ).stdout.trim();

  // The original bytes of every git blob the scrub changed are not reachable from the commit: not
  // through its tree, and not through its parent, because the scrub's own commits are not one.
  const originals = new Set<string>();
  for (const p of args.scope) {
    const before = args.preScrub.get(p);
    const after = tree.get(p);
    if (!before || before.key !== null || before.mode === "120000") continue;
    if (PROVENANCE.has(p)) continue;
    if (identityOf(before) !== identityOf(after)) originals.add(before.oid);
  }
  if (originals.size > 0) {
    const reachable = await reachableObjects(work, synthSha);
    const leaked = [...originals].filter((o) => reachable.has(o)).length;
    if (leaked > 0) throw mismatch("scrubbed original(s) are reachable from the commit", leaked);
  }

  await git(work, ["update-ref", `refs/heads/${WORK_BRANCH}`, synthSha], {
    code: "synthesis-failed",
    step: "update-ref",
  });
  return { synthSha, synthTree, manifest, manifestDigest: manifestDigest(manifest) };
}
