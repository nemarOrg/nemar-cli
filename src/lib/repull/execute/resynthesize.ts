/**
 * The re-pull's commit made again on a `main` that moved by enrichment (ADR 0111, decision 2; epic
 * #1046 phase 6). Enrichment commits to `main` (`.nemar/` files, the `.nemar/` line in
 * `.bidsignore`, a placeholder `participants.tsv`), and a pull request whose base moved that way can
 * read `dirty` (the release branch rewrote `.nemar/metadata.json` too) or `behind` (a ruleset that
 * wants an up-to-date branch). The re-synthesized commit is the same tree outside `.nemar/**`,
 * `.nemar/**` from the new `main` except two paths, one parent (the new `main`), and the same
 * message, identity and dates as the commit it replaces:
 *  - `.nemar/metadata.json` is the new `main`'s with the NEMAR-owned edit (its `IsIdenticalTo` names
 *    the new snapshot) applied again, when the re-pull's commit made it;
 *  - the privacy ledger is the re-pull commit's own (the base's, with the scrub's one line when the
 *    scrub changed anything): enrichment never writes it, so the new `main`'s is the base's.
 * Outside `.nemar/**` nothing changes, so the keys it names, their copies and their registration all
 * stand. The commit's trailers are checked as git reads them before anything is pushed, and the
 * push is the write guard's leased form on the release branch only.
 */

import { join } from "node:path";
import type { RepullRow } from "../../../../shared/repull-state.js";
import { trailersProblem } from "../trailers.js";
import { MOVED_REF_FETCH_DEPTH } from "./head.js";
import { NEMAR_METADATA_PATH, rewriteIsIdenticalTo } from "./materialize.js";
import { type OriginScratch, fetchInto } from "./origin.js";
import { releaseRefOf } from "./pull-request.js";
import { guardedPush, pushCauseWords } from "./push.js";
import { ExecuteRefused } from "./verify-plan.js";
import { REPULL_IDENTITY, git } from "./workdir.js";

const LEDGER_PATH = ".nemar/corrections.jsonl";

interface TreeLine {
  mode: string;
  oid: string;
  path: string;
}

async function treeOf(dir: string, commit: string): Promise<TreeLine[]> {
  const r = await git(dir, ["ls-tree", "-r", "-z", "--full-tree", commit], {
    code: "synthesis-failed",
    step: "ls-tree",
  });
  const out: TreeLine[] = [];
  for (const entry of r.stdout.split("\0")) {
    const m = /^(\d{6}) [a-z]+ ([0-9a-f]{40})\t(.+)$/s.exec(entry);
    if (m) out.push({ mode: m[1] as string, oid: m[2] as string, path: m[3] as string });
  }
  return out;
}

async function blobAt(dir: string, commit: string, path: string): Promise<string | null> {
  const r = await git(dir, ["cat-file", "blob", `${commit}:${path}`], { ok: true });
  return r.exitCode === 0 ? r.stdout : null;
}

/** The `IsIdenticalTo` identifier a metadata file names, or undefined when it names none. */
function isIdenticalTo(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    const meta = JSON.parse(raw.replace(/^﻿/, "")) as {
      related_identifiers?: Array<{ relation_type?: string; identifier?: unknown }>;
    };
    return Array.isArray(meta.related_identifiers)
      ? meta.related_identifiers.find((r) => r?.relation_type === "IsIdenticalTo")?.identifier
      : undefined;
  } catch {
    return undefined;
  }
}

function mismatch(what: string): ExecuteRefused {
  return new ExecuteRefused(
    "synthesis-mismatch",
    `The re-synthesized commit is not the re-pull's commit on the new main: ${what}.`,
  );
}

/** The commit's author and committer dates, `<epoch> <zone>`, from its header. */
function datesOf(header: string): { author: string; committer: string } {
  const author = /^author .* (\d+ [+-]\d{4})$/m.exec(header)?.[1];
  const committer = /^committer .* (\d+ [+-]\d{4})$/m.exec(header)?.[1];
  if (!author || !committer) throw mismatch("the commit's dates could not be read");
  return { author, committer };
}

/**
 * Make the re-pull's commit again on `newMain` (an enrichment-shaped descendant of the recorded
 * base, which the caller has checked), push it to the release branch with a lease on `liveHead`,
 * and return the new commit and tree. The scratch repository must hold `newMain` and the base
 * (the caller's `checkMain` fetched them); the recorded commit is fetched here.
 */
export async function resynthesize(args: {
  scratch: OriginScratch;
  row: RepullRow;
  newMain: string;
  liveHead: string;
}): Promise<{ synthSha: string; synthTree: string }> {
  const { scratch, row } = args;
  const dir = scratch.dir;
  const synth = row.synth_sha as string;
  const ref = releaseRefOf(row.to_version);
  if (
    !(await fetchInto(scratch, synth, 1)) &&
    !(await fetchInto(scratch, ref, MOVED_REF_FETCH_DEPTH))
  ) {
    throw new ExecuteRefused(
      "origin-unreadable",
      "The re-pull's commit could not be fetched from NEMAR's repository.",
    );
  }
  for (const commit of [synth, args.newMain, row.base_sha]) {
    const r = await git(dir, ["cat-file", "-e", `${commit}^{commit}`], { ok: true });
    if (r.exitCode !== 0) {
      throw new ExecuteRefused(
        "origin-unreadable",
        "A commit the re-synthesis reads is not in the scratch repository.",
      );
    }
  }

  // The NEMAR-owned edit, read off the commit itself: what the base named and what the commit names.
  const baseMeta = await blobAt(dir, row.base_sha, NEMAR_METADATA_PATH);
  const synthMeta = await blobAt(dir, synth, NEMAR_METADATA_PATH);
  const mainMeta = await blobAt(dir, args.newMain, NEMAR_METADATA_PATH);
  let metadata = mainMeta;
  if (synthMeta !== baseMeta) {
    const from = isIdenticalTo(baseMeta);
    const to = isIdenticalTo(synthMeta);
    if (baseMeta === null || synthMeta === null || from === undefined || to === undefined) {
      throw mismatch("its .nemar/metadata.json edit is not the IsIdenticalTo edit");
    }
    // The commit's edit must be exactly that edit of the base's file, so applying it again to the
    // new main's file is the whole of what the commit did there.
    if (rewriteIsIdenticalTo(baseMeta, from, to, "abandon this re-pull") !== synthMeta) {
      throw mismatch("its .nemar/metadata.json differs from the base's by more than IsIdenticalTo");
    }
    if (mainMeta === null) throw mismatch("the new main has no .nemar/metadata.json");
    metadata = rewriteIsIdenticalTo(
      mainMeta,
      from,
      to,
      "this re-pull cannot be re-synthesized, and its record has to be abandoned",
    );
  }

  const synthEntries = await treeOf(dir, synth);
  const mainEntries = await treeOf(dir, args.newMain);
  const entries: TreeLine[] = synthEntries.filter((e) => !underNemar(e.path));
  for (const e of mainEntries) {
    if (!underNemar(e.path) || e.path === LEDGER_PATH || e.path === NEMAR_METADATA_PATH) {
      continue;
    }
    entries.push(e);
  }
  const ledger = synthEntries.find((e) => e.path === LEDGER_PATH);
  if (ledger) entries.push(ledger);
  if (metadata !== null) {
    const oid = (
      await git(dir, ["hash-object", "-w", "--stdin"], {
        stdin: metadata,
        code: "synthesis-failed",
        step: "hash-object",
      })
    ).stdout.trim();
    const mode = mainEntries.find((e) => e.path === NEMAR_METADATA_PATH)?.mode ?? "100644";
    entries.push({ mode, oid, path: NEMAR_METADATA_PATH });
  }

  const index = join(dir, "resynth.index");
  const env = { GIT_INDEX_FILE: index };
  await git(dir, ["read-tree", "--empty"], { env, code: "synthesis-failed", step: "read-tree" });
  await git(dir, ["update-index", "-z", "--index-info"], {
    env,
    stdin: entries.map((e) => `${e.mode} ${e.oid}\t${e.path}\0`).join(""),
    code: "synthesis-failed",
    step: "update-index",
  });
  const synthTree = (
    await git(dir, ["write-tree"], { env, code: "synthesis-failed", step: "write-tree" })
  ).stdout.trim();

  // Outside `.nemar/**` the tree is the recorded one, entry for entry.
  const outside = (lines: TreeLine[]) =>
    lines
      .filter((e) => !underNemar(e.path))
      .map((e) => `${e.mode} ${e.oid} ${e.path}`)
      .sort()
      .join("\n");
  if (outside(await treeOf(dir, synthTree)) !== outside(synthEntries)) {
    throw mismatch("its tree outside .nemar differs from the recorded commit's");
  }

  const raw = (
    await git(dir, ["cat-file", "commit", synth], { code: "synthesis-failed", step: "cat-file" })
  ).stdout;
  const split = raw.indexOf("\n\n");
  if (split < 0) throw mismatch("the recorded commit has no message");
  const header = raw.slice(0, split);
  const message = raw.slice(split + 2);
  const problem = await trailersProblem(message, row);
  if (problem) throw mismatch(`the recorded commit's message is not the re-pull's (${problem})`);
  const dates = datesOf(header);
  const synthSha = (
    await git(dir, ["commit-tree", "--no-gpg-sign", synthTree, "-p", args.newMain, "-F", "-"], {
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

  const pushed = await guardedPush(
    dir,
    [`${synthSha}:${ref}`],
    { versions: [row.to_version] },
    scratch.env,
    [`--force-with-lease=${ref}:${args.liveHead}`],
  );
  if (pushed.outcome === "rejected") {
    throw new ExecuteRefused(
      "branch-moved",
      `release/v${row.to_version} moved while it was re-synthesized; nothing was replaced. Run resume again.`,
    );
  }
  if (pushed.outcome === "remote-rejected" || pushed.outcome === "failed") {
    throw new ExecuteRefused(
      "push-failed",
      `The re-synthesized release/v${row.to_version} could not be pushed (${pushCauseWords(pushed.cause)}).`,
    );
  }
  return { synthSha, synthTree };
}

/** A path under `.nemar/`, which enrichment writes; `.github/**` is not in it. */
function underNemar(path: string): boolean {
  return path.startsWith(".nemar/");
}
