#!/usr/bin/env bun
/**
 * Build `git-plan.json` for a dataset repository from what its history actually holds.
 *
 *   bun run scripts/scrub/plan/build-git-plan.ts --repo CLONE --dataset nm000348 --out git-plan.json [--date YYYY-MM-DD]
 *
 * Read-only on the clone. It reads EVERY commit reachable from every ref the rewrite covers (local
 * and remote-tracking heads and tags, never `git-annex`), not just `main` and the `v*` tips, because
 * the rewrite changes all of them: a path or a JSON key that exists only in a commit between two
 * tags, or only on an unreleased branch, is found too:
 *
 * - images and documents under `sourcedata/` (outside the BIDS photo convention) are dropped from
 *   every commit: a screenshot can show a name on screen and nobody can verify its pixels;
 * - an inline JSON file with an identifier-keyed value has those keys blanked, by canonical spelling;
 * - a provenance file that lists the dropped files (`sourcedata/sourcedata_provenance.json`, an array
 *   `files` of `{file, bytes, ...}`) loses those entries and its counts are recomputed;
 * - a change-log sentence is appended to `CHANGES`, and a note to the provenance README.
 *
 * The plan holds file NAMES, which can be the identifier, so it is private and deleted with the rest
 * of the working directory. The report on stdout is counts only.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { scanJsonKeys, scanPaths } from "../../../shared/identifier-scan";
import { type GitPlanFile, type JsonOp, parseGitPlan } from "../contract";
import { isRewriteRef } from "../git/git-lib";
import { changeLogEntry } from "../ledger";

const PROVENANCE = "sourcedata/sourcedata_provenance.json";
const PROVENANCE_README = "sourcedata/README_sourcedata_provenance.md";
const MAX_JSON_BYTES = 1024 * 1024;

export class PlanRefused extends Error {
  constructor(readonly reason: string) {
    super(`git plan refused: ${reason}`);
    this.name = "PlanRefused";
  }
}

function gitBuffer(repo: string, args: string[], input?: string): Buffer {
  const r = spawnSync("git", ["-C", repo, ...args], {
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 1024,
    ...(input === undefined ? {} : { input: Buffer.from(input) }),
  });
  if (r.status !== 0) throw new PlanRefused(`git ${args[0]} failed`);
  return r.stdout as Buffer;
}

function git(repo: string, args: string[], input?: string): string {
  return gitBuffer(repo, args, input).toString("utf8");
}

const ZERO_SHA = /^0+$/;

interface History {
  commits: number;
  /** Every path that appears in any commit's tree, as a name git recorded it. */
  paths: Set<string>;
  /** Inline-JSON candidates: path -> the distinct blob ids it ever had. */
  jsonBlobs: Map<string, Set<string>>;
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
  const log = git(
    repo,
    ["log", "--stdin", "-m", "--raw", "-z", "--no-renames", "--no-abbrev", "--format="],
    stdin,
  );
  const paths = new Set<string>();
  const jsonBlobs = new Map<string, Set<string>>();
  const tokens = log.split("\0");
  // `:<old mode> <new mode> <old sha> <new sha> <status>` NUL `<path>` NUL, repeated.
  for (let i = 0; i < tokens.length; ) {
    const meta = (tokens[i] as string).replace(/^\n+/, "");
    if (meta === "") {
      i++;
      continue;
    }
    const path = tokens[i + 1];
    const fields = meta.split(" ");
    if (!meta.startsWith(":") || path === undefined || fields.length !== 5) {
      throw new PlanRefused("git log output not understood");
    }
    i += 2;
    const [, newMode, , newSha, status] = fields as [string, string, string, string, string];
    paths.add(path);
    // Inline JSON only: an annex pointer is a few dozen bytes of `/annex/objects/...`, not JSON.
    if (
      path.toLowerCase().endsWith(".json") &&
      newMode === "100644" &&
      !ZERO_SHA.test(newSha) &&
      (status === "A" || status === "M" || status === "T")
    ) {
      const set = jsonBlobs.get(path) ?? new Set<string>();
      set.add(newSha);
      jsonBlobs.set(path, set);
    }
  }
  return { commits, paths, jsonBlobs };
}

/** Read at most this many bytes of blob content in one `cat-file` process. */
const BATCH_BYTES = 64 * 1024 * 1024;

/** The content of each blob that is at most `limit` bytes, a bounded batch at a time. */
function readSmallBlobs(repo: string, shas: string[], limit: number): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (shas.length === 0) return out;
  const sizes = git(repo, ["cat-file", "--batch-check"], `${shas.join("\n")}\n`).split("\n");
  const batches: string[][] = [[]];
  let batchBytes = 0;
  shas.forEach((sha, i) => {
    const size = Number((sizes[i] ?? "").split(" ")[2]);
    if (!Number.isFinite(size) || size > limit) return;
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
      if (type !== "blob" || size === undefined) throw new PlanRefused("git cat-file failed");
      const start = nl + 1;
      out.set(sha, raw.subarray(start, start + Number(size)));
      at = start + Number(size) + 1;
    }
  }
  return out;
}

export interface PlanReport {
  refs: number;
  /** Commits whose trees were read: every commit reachable from the rewritten refs. */
  commits: number;
  dropPaths: number;
  jsonFilesBlanked: number;
  jsonKeysBlanked: number;
  provenanceEntriesDropped: number;
  versions: string[];
}

export function buildGitPlan(
  repo: string,
  dataset: string,
  date: string,
): { plan: GitPlanFile; report: PlanReport } {
  const tags = git(repo, ["tag", "--list", "v*"])
    .split("\n")
    .filter((t) => t !== "")
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (tags.length === 0) throw new PlanRefused("the repository has no v* tags");
  const refs = git(repo, ["for-each-ref", "--format=%(refname)"])
    .split("\n")
    .filter((r) => r !== "" && isRewriteRef(r));
  if (!refs.includes("refs/heads/main")) throw new PlanRefused("the repository has no main branch");
  const { commits, paths: allPaths, jsonBlobs } = readHistory(repo, refs);

  // Images and documents under sourcedata/ are dropped; elsewhere they are left for a person.
  const dropped: string[] = [];
  for (const path of [...allPaths].sort()) {
    if (!path.startsWith("sourcedata/")) continue;
    if (scanPaths([path]).some((f) => f.kind === "image-or-document-file")) dropped.push(path);
  }

  // Identifier-keyed values in inline JSON, by canonical spelling, over every distinct blob.
  const contents = readSmallBlobs(
    repo,
    [...new Set([...jsonBlobs.values()].flatMap((shas) => [...shas]))],
    MAX_JSON_BYTES,
  );
  const blankJsonKeys: Record<string, string[]> = {};
  let keysBlanked = 0;
  for (const [path, shas] of [...jsonBlobs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const keys = new Set<string>();
    for (const sha of shas) {
      const bytes = contents.get(sha);
      if (!bytes) continue;
      let doc: unknown;
      try {
        const text = bytes.toString("utf8");
        doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      } catch {
        continue;
      }
      for (const f of scanJsonKeys(doc)) if (f.severity === "identifier") keys.add(f.field);
    }
    if (keys.size > 0) {
      blankJsonKeys[path] = [...keys].sort();
      keysBlanked += keys.size;
    }
  }

  // The provenance file lists every file; drop the entries of the files being removed.
  const jsonOps: Record<string, JsonOp[]> = {};
  let provenanceDropped = 0;
  if (dropped.length > 0 && allPaths.has(PROVENANCE)) {
    const rel = dropped.map((p) => p.slice("sourcedata/".length));
    jsonOps[PROVENANCE] = [
      { op: "drop-array-entries", array: "files", matchField: "file", matchValues: rel },
      {
        op: "recount",
        array: "files",
        countKey: "n_files",
        sumKey: "total_bytes",
        sumField: "bytes",
      },
      {
        op: "set",
        key: "privacy_correction",
        value: `${date}: files whose names or contents identify a person were removed, and identification fields in recording headers were scrubbed in place; checksums above describe the original upstream files.`,
      },
    ];
    provenanceDropped = rel.length;
  }

  const appendText: Record<string, string> = { CHANGES: `\n${changeLogEntry(date, tags)}\n` };
  if (allPaths.has(PROVENANCE_README)) {
    appendText[PROVENANCE_README] =
      `\nPrivacy correction ${date}: identification fields in the headers of the recording files were removed in place, and files that identify a person were removed. The checksums in the provenance file describe the original upstream files, not the scrubbed copies.\n`;
  }

  const plan: GitPlanFile = {
    version: 1,
    dataset,
    dropPaths: dropped,
    blankJsonKeys,
    appendText,
    ...(Object.keys(jsonOps).length > 0 ? { jsonOps } : {}),
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
      versions: tags,
    },
  };
}

if (import.meta.main) {
  const arg = (n: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const repo = arg("repo");
  const dataset = arg("dataset");
  const out = arg("out");
  if (!repo || !dataset || !out) {
    console.error(
      "usage: build-git-plan.ts --repo CLONE --dataset ID --out FILE [--date YYYY-MM-DD]",
    );
    process.exit(2);
  }
  try {
    const { plan, report } = buildGitPlan(
      repo,
      dataset,
      arg("date") ?? new Date().toISOString().slice(0, 10),
    );
    // File names in the plan can be the identifier: owner-only, even over a looser existing file.
    writeFileSync(out, `${JSON.stringify(plan, null, 1)}\n`, { mode: 0o600 });
    chmodSync(out, 0o600);
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(error instanceof PlanRefused ? error.message : "failed");
    process.exit(1);
  }
}
