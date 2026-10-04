#!/usr/bin/env bun
/**
 * Build `git-plan.json` for a dataset repository from what its history actually holds.
 *
 *   bun run scripts/scrub/plan/build-git-plan.ts --repo CLONE --dataset nm000348 --out git-plan.json [--date YYYY-MM-DD]
 *
 * Read-only on the clone. It looks at the tip of `main` and at every `v*` tag, so a path or a JSON
 * key that exists only in an old version is found too:
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
import { writeFileSync } from "node:fs";
import { scanJsonKeys, scanPaths } from "../../../shared/identifier-scan";
import { type GitPlanFile, type JsonOp, parseGitPlan } from "../contract";
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

function git(repo: string, args: string[]): string {
  const r = spawnSync("git", ["-C", repo, ...args], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new PlanRefused(`git ${args[0]} failed`);
  return (r.stdout as Buffer).toString("utf8");
}

interface Entry {
  mode: string;
  sha: string;
  size: number;
  path: string;
}

/** Every blob of a ref's tree, with its size. `-z` keeps names with spaces or non-ASCII intact. */
function lsTree(repo: string, ref: string): Entry[] {
  const out = git(repo, ["ls-tree", "-r", "-l", "-z", ref]);
  const entries: Entry[] = [];
  for (const rec of out.split("\0")) {
    if (rec === "") continue;
    const tab = rec.indexOf("\t");
    const [mode, type, sha, size] = rec.slice(0, tab).split(/\s+/);
    if (type !== "blob" || !mode || !sha) continue;
    entries.push({ mode, sha, size: Number(size), path: rec.slice(tab + 1) });
  }
  return entries;
}

export interface PlanReport {
  refs: number;
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
  const refs = ["refs/heads/main", ...tags.map((t) => `refs/tags/${t}`)];

  const allPaths = new Set<string>();
  const jsonBlobs = new Map<string, Set<string>>(); // path -> distinct blob shas
  for (const ref of refs) {
    for (const e of lsTree(repo, ref)) {
      allPaths.add(e.path);
      // Inline JSON only: an annex pointer is a few dozen bytes of `/annex/objects/...`, not JSON.
      if (
        e.path.toLowerCase().endsWith(".json") &&
        e.size <= MAX_JSON_BYTES &&
        e.mode === "100644"
      ) {
        const set = jsonBlobs.get(e.path) ?? new Set<string>();
        set.add(e.sha);
        jsonBlobs.set(e.path, set);
      }
    }
  }

  // Images and documents under sourcedata/ are dropped; elsewhere they are left for a person.
  const dropped: string[] = [];
  for (const path of [...allPaths].sort()) {
    if (!path.startsWith("sourcedata/")) continue;
    if (scanPaths([path]).some((f) => f.kind === "image-or-document-file")) dropped.push(path);
  }

  // Identifier-keyed values in inline JSON, by canonical spelling, over every distinct blob.
  const blankJsonKeys: Record<string, string[]> = {};
  let keysBlanked = 0;
  for (const [path, shas] of [...jsonBlobs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const keys = new Set<string>();
    for (const sha of shas) {
      let doc: unknown;
      try {
        doc = JSON.parse(git(repo, ["cat-file", "blob", sha]));
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
    writeFileSync(out, `${JSON.stringify(plan, null, 1)}\n`);
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(error instanceof PlanRefused ? error.message : "failed");
    process.exit(1);
  }
}
