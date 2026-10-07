#!/usr/bin/env bun
/**
 * Build `git-plan.json` for a dataset repository from what its history actually holds.
 *
 *   bun run scripts/scrub/plan/build-git-plan.ts --repo CLONE --dataset nm000348 --out git-plan.json \
 *        [--date YYYY-MM-DD] [--s3-plan plan.json] [--allow-skipped-json]
 *
 * Read-only on the clone. It reads EVERY commit reachable from every ref the rewrite covers (local
 * and remote-tracking heads and tags, never `git-annex`), not just `main` and the `v*` tips, because
 * the rewrite changes all of them: a path or a JSON key that exists only in a commit between two
 * tags, or only on an unreleased branch, is found too:
 *
 * - images and documents under `sourcedata/` (outside the BIDS photo convention) are dropped from
 *   every commit: a screenshot can show a name on screen and nobody can verify its pixels;
 * - an inline JSON file with an identifier-keyed value has those keys blanked, by canonical spelling;
 * - a provenance file (`sourcedata/sourcedata_provenance.json`, an array `files` of
 *   `{file, bytes, sha256, ...}` whose checksums are the ORIGINAL upstream files') gets a
 *   `privacy_correction` sentence whenever the scrub changes anything it describes: the S3 plan
 *   scrubs a recording in place, or a file is dropped. It says what changed and that the checksums
 *   describe the upstream files, not the scrubbed copies; the checksums stay (ADR 0085), and
 *   `git-scrub verify` keeps them only in a file that carries the sentence. Only when files are
 *   dropped does it also lose their entries and have its counts recomputed;
 * - a change-log sentence is appended to `CHANGES`, and, on the same condition as the provenance
 *   sentence, a note to the provenance README.
 *
 * Whether the S3 plan scrubs anything is known only with `--s3-plan`, so a history that has the
 * provenance file or its README is refused without one (`s3-plan-required`).
 *
 * The plan holds file NAMES, which can be the identifier, so it is private and deleted with the rest
 * of the working directory. The report on stdout is counts only.
 *
 * It refuses, and says why with a fixed word and a count, rather than leave something unread:
 * - an inline JSON file it could not read in some commit, because it is over
 *   {@link MAX_JSON_BYTES} or not UTF-8 JSON (`skipped-json`): its identifier keys would never be
 *   blanked. The paths go to `<out>.skipped.json` (0600) and no plan is written, unless
 *   `--allow-skipped-json` says a person looked; the plan then lists them under `skippedJson`;
 * - a `v*` tag that is not `vX.Y.Z[-pre]` (`tag-not-semver`): the change-log sentence and the
 *   ledger take only those;
 * - with `--s3-plan`, a key the S3 plan scrubs that no commit of the history names
 *   (`orphan-key`): the history rewrite would refuse its keymap entry (`keymap-key-never-seen`);
 * - without `--s3-plan`, a history that has the provenance file or its README
 *   (`s3-plan-required`): the sentence would not know whether headers were scrubbed in place.
 *
 * Exit: 0 plan written, 1 failed, 2 usage, 3 refused.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { scanJsonKeys, scanPaths } from "../../../shared/identifier-scan";
import {
  PROVENANCE_README_PATH,
  type ProvenanceChange,
  provenanceNote,
  provenanceReadmeNote,
} from "../../../shared/privacy-correction-text";
import { type GitPlanFile, type JsonOp, parseGitPlan, parsePlan } from "../contract";
import {
  PROVENANCE_NOTE_KEY,
  PROVENANCE_PATH,
  RAW_LOG_ARGS,
  type RawEntry,
  isRewriteRef,
  isZeroSha,
  parseRawLog,
} from "../git/git-lib";
import { VERSION_TAG, changeLogEntry } from "../ledger";

const PROVENANCE_README = PROVENANCE_README_PATH;
const MAX_JSON_BYTES = 1024 * 1024;

// The provenance sentences are shared with the importer's scrub (ADR 0089), so both writers say the
// same thing; re-exported here for the callers and tests that import them from the plan.
export { type ProvenanceChange, provenanceNote, provenanceReadmeNote };

export class PlanRefused extends Error {
  constructor(readonly reason: string) {
    super(`git plan refused: ${reason}`);
    this.name = "PlanRefused";
  }
}

/** git itself failed (not a refusal): exit 1. The reason names the command, never its output. */
export class PlanFailed extends Error {
  constructor(readonly reason: string) {
    super(`git plan failed: ${reason}`);
    this.name = "PlanFailed";
  }
}

function gitBuffer(repo: string, args: string[], input?: string): Buffer {
  const r = spawnSync("git", ["-C", repo, ...args], {
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 1024,
    ...(input === undefined ? {} : { input: Buffer.from(input) }),
  });
  if (r.status !== 0) throw new PlanFailed(`git ${args[0]}`);
  return r.stdout as Buffer;
}

function git(repo: string, args: string[], input?: string): string {
  return gitBuffer(repo, args, input).toString("utf8");
}

interface History {
  commits: number;
  /** Every path that appears in any commit's tree, as a name git recorded it. */
  paths: Set<string>;
  /** Inline-JSON candidates: path -> the distinct blob ids it ever had. */
  jsonBlobs: Map<string, Set<string>>;
  /** Every blob a regular file or a symlink ever held: where annex pointers are. */
  fileBlobs: Set<string>;
}

/**
 * Every path and every distinct JSON blob of every commit reachable from `refs`.
 *
 * One `git log -m --raw` walk reports, per commit and per parent, the entries that differ, so the
 * cost follows what CHANGED rather than the size of each tree times the number of commits (on a
 * synthetic 300-commit, 3,000-file repository: 0.14 s against 3.9 s for `ls-tree -r` per commit,
 * which also hands back 74 MB to parse). It still sees everything: a root commit lists all its
 * files, and `-m` diffs a merge against each parent, so a blob that exists in any tree is the
 * "new" side of some entry (or the old side of a deletion, which appeared earlier).
 */
function readHistory(repo: string, refs: string[]): History {
  const stdin = `${refs.join("\n")}\n`;
  const commits = Number(git(repo, ["rev-list", "--count", "--stdin"], stdin).trim());
  const log = git(repo, RAW_LOG_ARGS, stdin);
  const paths = new Set<string>();
  const jsonBlobs = new Map<string, Set<string>>();
  const fileBlobs = new Set<string>();
  let entries: RawEntry[];
  try {
    entries = parseRawLog(log);
  } catch {
    throw new PlanFailed("git log output not understood");
  }
  for (const { path, newMode, newSha, status } of entries) {
    paths.add(path);
    if (!isZeroSha(newSha) && /^(100644|100755|120000)$/.test(newMode)) fileBlobs.add(newSha);
    // Inline JSON only: an annex pointer is a few dozen bytes of `/annex/objects/...`, not JSON.
    if (
      path.toLowerCase().endsWith(".json") &&
      newMode === "100644" &&
      !isZeroSha(newSha) &&
      (status === "A" || status === "M" || status === "T")
    ) {
      const set = jsonBlobs.get(path) ?? new Set<string>();
      set.add(newSha);
      jsonBlobs.set(path, set);
    }
  }
  return { commits, paths, jsonBlobs, fileBlobs };
}

/** Read at most this many bytes of blob content in one `cat-file` process. */
const BATCH_BYTES = 64 * 1024 * 1024;

/**
 * The content of each blob that is at most `limit` bytes, a bounded batch at a time. A blob over
 * the limit is not read: it is in `oversize`, so the caller can say so instead of skipping it.
 */
function readSmallBlobs(
  repo: string,
  shas: string[],
  limit: number,
): { contents: Map<string, Buffer>; oversize: Set<string> } {
  const out = new Map<string, Buffer>();
  const oversize = new Set<string>();
  if (shas.length === 0) return { contents: out, oversize };
  const sizes = git(repo, ["cat-file", "--batch-check"], `${shas.join("\n")}\n`).split("\n");
  const batches: string[][] = [[]];
  let batchBytes = 0;
  shas.forEach((sha, i) => {
    const size = Number((sizes[i] ?? "").split(" ")[2]);
    if (!Number.isFinite(size)) throw new PlanFailed("git cat-file");
    if (size > limit) {
      oversize.add(sha);
      return;
    }
    if (batchBytes + size > BATCH_BYTES) {
      batches.push([]);
      batchBytes = 0;
    }
    (batches[batches.length - 1] as string[]).push(sha);
    batchBytes += size;
  });
  for (const batch of batches) {
    if (batch.length === 0) continue;
    const raw = gitBuffer(repo, ["cat-file", "--batch"], `${batch.join("\n")}\n`);
    let at = 0;
    for (const sha of batch) {
      const nl = raw.indexOf(10, at);
      const [, type, size] = raw.subarray(at, nl).toString("latin1").split(" ");
      if (type !== "blob" || size === undefined) throw new PlanFailed("git cat-file");
      const start = nl + 1;
      out.set(sha, raw.subarray(start, start + Number(size)));
      at = start + Number(size) + 1;
    }
  }
  return { contents: out, oversize };
}

export interface PlanReport {
  refs: number;
  /** Commits whose trees were read: every commit reachable from the rewritten refs. */
  commits: number;
  dropPaths: number;
  jsonFilesBlanked: number;
  jsonKeysBlanked: number;
  provenanceEntriesDropped: number;
  /** 1 when the provenance file gets the `privacy_correction` sentence, else 0. */
  provenanceAnnotated: number;
  /** 1 when the provenance README gets the privacy-correction note, else 0. */
  provenanceReadmeAnnotated: number;
  /** With an S3 plan: the keys it scrubs in place. -1 without one (no provenance file then). */
  s3KeysScrubbed: number;
  /** Inline JSON paths with a blob over {@link MAX_JSON_BYTES} in some commit: not read. */
  skippedOversizeJson: number;
  /** Inline JSON paths with a blob that is not UTF-8 JSON in some commit: not read. */
  skippedUnparseableJson: number;
  /** With an S3 plan: keys it scrubs that no commit names (`orphan-key`). -1 without one. */
  orphanKeys: number;
  versions: string[];
}

export interface BuildOptions {
  /** Accept inline JSON that could not be read; the plan lists the paths under `skippedJson`. */
  allowSkippedJson?: boolean;
  /** The S3 stage's plan, to find keys it scrubs that the history never names. */
  s3PlanPath?: string;
}

/** A refusal that also carries what a person needs to look at (paths, which are private). */
export class SkippedJsonRefused extends PlanRefused {
  constructor(
    readonly oversize: string[],
    readonly unparseable: string[],
  ) {
    super(`skipped-json (oversize=${oversize.length} unparseable=${unparseable.length})`);
  }
}

const ANNEX_KEY_IN_TEXT = /SHA256E-s\d+--[0-9a-f]{64}(?:\.[A-Za-z0-9.+]*)?/g;
/** A pointer file or a symlink target is a line long. */
const POINTER_MAX_BYTES = 1024;

export function buildGitPlan(
  repo: string,
  dataset: string,
  date: string,
  opts: BuildOptions = {},
): { plan: GitPlanFile; report: PlanReport } {
  const tags = git(repo, ["tag", "--list", "v*"])
    .split("\n")
    .filter((t) => t !== "")
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (tags.length === 0) throw new PlanRefused("the repository has no v* tags");
  // The change-log sentence and the ledger take only vX.Y.Z[-pre]; say so, never filter.
  const notSemver = tags.filter((t) => !VERSION_TAG.test(t)).length;
  if (notSemver > 0) throw new PlanRefused(`tag-not-semver (${notSemver})`);
  const refs = git(repo, ["for-each-ref", "--format=%(refname)"])
    .split("\n")
    .filter((r) => r !== "" && isRewriteRef(r));
  if (!refs.includes("refs/heads/main")) throw new PlanRefused("the repository has no main branch");
  const { commits, paths: allPaths, jsonBlobs, fileBlobs } = readHistory(repo, refs);

  // Images and documents under sourcedata/ are dropped; elsewhere they are left for a person.
  const dropped: string[] = [];
  for (const path of [...allPaths].sort()) {
    if (!path.startsWith("sourcedata/")) continue;
    if (scanPaths([path]).some((f) => f.kind === "image-or-document-file")) dropped.push(path);
  }

  // Identifier-keyed values in inline JSON, by canonical spelling, over every distinct blob.
  const { contents, oversize } = readSmallBlobs(
    repo,
    [...new Set([...jsonBlobs.values()].flatMap((shas) => [...shas]))],
    MAX_JSON_BYTES,
  );
  const blankJsonKeys: Record<string, string[]> = {};
  const skippedOversize = new Set<string>();
  const skippedUnparseable = new Set<string>();
  let keysBlanked = 0;
  for (const [path, shas] of [...jsonBlobs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const keys = new Set<string>();
    for (const sha of shas) {
      if (oversize.has(sha)) {
        skippedOversize.add(path);
        continue;
      }
      const bytes = contents.get(sha);
      if (!bytes) throw new PlanFailed("git cat-file");
      let doc: unknown;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      } catch {
        skippedUnparseable.add(path);
        continue;
      }
      for (const f of scanJsonKeys(doc)) if (f.severity === "identifier") keys.add(f.field);
    }
    if (keys.size > 0) {
      blankJsonKeys[path] = [...keys].sort();
      keysBlanked += keys.size;
    }
  }

  // The S3 plan says whether recordings are scrubbed in place. Without it the provenance file's
  // sentence could not say so, so a history that has the file, or its README, needs one.
  const s3Plan = opts.s3PlanPath ? parsePlan(readFileSync(opts.s3PlanPath, "utf8")) : undefined;
  if (s3Plan && s3Plan.dataset !== dataset) throw new PlanRefused("s3-plan-dataset-mismatch");
  if (!s3Plan && (allPaths.has(PROVENANCE_PATH) || allPaths.has(PROVENANCE_README))) {
    throw new PlanRefused("s3-plan-required");
  }
  const s3KeysScrubbed = s3Plan ? s3Plan.keys.filter((k) => k.needsScrub).length : -1;
  const headersScrubbed = s3KeysScrubbed > 0;
  const filesRemoved = dropped.length > 0;
  const change: ProvenanceChange | undefined = headersScrubbed
    ? filesRemoved
      ? "both"
      : "scrubbed-in-place"
    : filesRemoved
      ? "files-removed"
      : undefined;

  // The provenance file keeps its upstream checksums (ADR 0085), so whenever the scrub changes a
  // file it describes, it says so; only removed files also lose their entries and the counts.
  const jsonOps: Record<string, JsonOp[]> = {};
  let provenanceDropped = 0;
  let provenanceAnnotated = 0;
  if (change && allPaths.has(PROVENANCE_PATH)) {
    const ops: JsonOp[] = [];
    if (filesRemoved) {
      const rel = dropped.map((p) => p.slice("sourcedata/".length));
      ops.push(
        { op: "drop-array-entries", array: "files", matchField: "file", matchValues: rel },
        {
          op: "recount",
          array: "files",
          countKey: "n_files",
          sumKey: "total_bytes",
          sumField: "bytes",
        },
      );
      provenanceDropped = rel.length;
    }
    ops.push({
      op: "set",
      key: PROVENANCE_NOTE_KEY,
      value: provenanceNote(date, change),
    });
    jsonOps[PROVENANCE_PATH] = ops;
    provenanceAnnotated = 1;
  }

  const appendText: Record<string, string> = { CHANGES: `\n${changeLogEntry(date, tags)}\n` };
  let provenanceReadmeAnnotated = 0;
  if (change && allPaths.has(PROVENANCE_README)) {
    appendText[PROVENANCE_README] = provenanceReadmeNote(date, change);
    provenanceReadmeAnnotated = 1;
  }

  // With the S3 plan: every key it scrubs must be named by some commit, or the rewrite cannot
  // map it (it refuses a keymap entry the history never held).
  let orphanKeys = -1;
  if (s3Plan) {
    const named = new Set<string>();
    const small = readSmallBlobs(repo, [...fileBlobs], POINTER_MAX_BYTES).contents;
    for (const bytes of small.values()) {
      for (const m of bytes.toString("latin1").matchAll(ANNEX_KEY_IN_TEXT)) named.add(m[0]);
    }
    orphanKeys = s3Plan.keys.filter((k) => k.needsScrub && !named.has(k.oldKey)).length;
    if (orphanKeys > 0) throw new PlanRefused(`orphan-key (${orphanKeys})`);
  }

  const oversizePaths = [...skippedOversize].sort();
  const unparseablePaths = [...skippedUnparseable].sort();
  if ((oversizePaths.length > 0 || unparseablePaths.length > 0) && !opts.allowSkippedJson) {
    throw new SkippedJsonRefused(oversizePaths, unparseablePaths);
  }

  const plan: GitPlanFile = {
    version: 1,
    dataset,
    dropPaths: dropped,
    blankJsonKeys,
    appendText,
    ...(Object.keys(jsonOps).length > 0 ? { jsonOps } : {}),
    ...(oversizePaths.length > 0 || unparseablePaths.length > 0
      ? { skippedJson: { oversize: oversizePaths, unparseable: unparseablePaths } }
      : {}),
  };
  parseGitPlan(JSON.stringify(plan));
  return {
    plan,
    report: {
      refs: refs.length,
      commits,
      dropPaths: dropped.length,
      jsonFilesBlanked: Object.keys(blankJsonKeys).length,
      jsonKeysBlanked: keysBlanked,
      provenanceEntriesDropped: provenanceDropped,
      provenanceAnnotated,
      provenanceReadmeAnnotated,
      s3KeysScrubbed,
      skippedOversizeJson: oversizePaths.length,
      skippedUnparseableJson: unparseablePaths.length,
      orphanKeys,
      versions: tags,
    },
  };
}

/** Owner-only, even over a looser existing file: names in it can be the identifier. */
function writePrivate(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

if (import.meta.main) {
  // Owner-only for every file this process creates: the git plan holds paths that may be
  // identifying.
  process.umask(0o077);
  const arg = (n: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const repo = arg("repo");
  const dataset = arg("dataset");
  const out = arg("out");
  if (!repo || !dataset || !out) {
    console.error(
      "usage: build-git-plan.ts --repo CLONE --dataset ID --out FILE [--date YYYY-MM-DD] [--s3-plan plan.json] [--allow-skipped-json]",
    );
    process.exit(2);
  }
  const skippedFile = `${out}.skipped.json`;
  try {
    rmSync(skippedFile, { force: true });
    const { plan, report } = buildGitPlan(
      repo,
      dataset,
      arg("date") ?? new Date().toISOString().slice(0, 10),
      {
        allowSkippedJson: process.argv.includes("--allow-skipped-json"),
        ...(arg("s3-plan") ? { s3PlanPath: arg("s3-plan") as string } : {}),
      },
    );
    writePrivate(out, plan);
    console.log(JSON.stringify(report));
  } catch (error) {
    if (error instanceof SkippedJsonRefused) {
      // The paths, for a person, in a private file beside where the plan would have gone; no plan.
      writePrivate(skippedFile, {
        version: 1,
        dataset,
        oversize: error.oversize,
        unparseable: error.unparseable,
      });
      rmSync(out, { force: true });
      console.error(`${error.message}; the paths are in ${skippedFile}; no plan written`);
      console.error("look at them, then pass --allow-skipped-json to plan with them unread");
      process.exit(3);
    }
    if (error instanceof PlanRefused) {
      console.error(error.message);
      process.exit(3);
    }
    console.error(error instanceof PlanFailed ? error.message : "failed");
    process.exit(1);
  }
}
