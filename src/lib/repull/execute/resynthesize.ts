/**
 * The re-pull's commit made again on a `main` that moved by enrichment (ADR 0111, decision 2; epic
 * #1046 phase 6). Enrichment commits to `main` in three shapes (`head.ts`): `.nemar/` files, the
 * `.nemar/` line in `.bidsignore`, and a placeholder root `participants.tsv`. A pull request whose
 * base moved that way can read `dirty` (the release branch rewrote `.nemar/metadata.json` too) or
 * `behind` (a ruleset that wants an up-to-date branch). The re-synthesized commit has one parent
 * (the new `main`) and the message, identity and dates of the commit it replaces, and its tree is
 * the recorded commit's with what enrichment did on `main` applied to it, as enrichment itself
 * would apply it, never undone:
 *  - under `.nemar/**`, the new `main`'s files, except `.nemar/metadata.json`, which is the new
 *    `main`'s with the NEMAR-owned edit (its `IsIdenticalTo` names the new snapshot) applied again
 *    when the re-pull's commit made it, and the privacy ledger, which is the re-pull commit's own
 *    (enrichment never writes it);
 *  - `.bidsignore`, when enrichment changed it on `main`: the recorded commit's with the `.nemar/`
 *    line added (`withBidsignoreEntry`), so upstream's lines stay and enrichment's line is kept;
 *  - root `participants.tsv`, when enrichment added it on `main`: the recorded commit's own when it
 *    has one (N.0.0's, upstream's or the standard edit's), else the placeholder of the recorded
 *    tree's subjects, as enrichment makes it, or none when the tree has no subject;
 *  - every other path, the recorded commit's, entry for entry, so the keys it names, their copies
 *    and their registration all stand.
 * The recorded commit's trailers are checked as git reads them before anything is made, and the
 * push is the write guard's leased form on the release branch only.
 *
 * The commit is a function of the recorded commit, the base and the new `main`, so a run that
 * pushed one and could not record it finds it again on the next run (`recognizeResynthesis`): the
 * head's commit is the one this module makes for its own parent, byte for byte.
 */

import { join } from "node:path";
import type { RepullRow } from "../../../../shared/repull-state.js";
import {
  NEMAR_BIDSIGNORE_ENTRY,
  withBidsignoreEntry,
} from "../../../../shared/standard-edits/bidsignore.js";
import {
  buildPlaceholderParticipantsTsv,
  enumerateBidsSubjects,
} from "../../../../shared/standard-edits/participants.js";
import { trailersProblem } from "../trailers.js";
import { ENRICHMENT_MAX_COMMITS, MOVED_REF_FETCH_DEPTH, enrichmentOnlySince } from "./head.js";
import { NEMAR_METADATA_PATH, rewriteIsIdenticalTo } from "./materialize.js";
import { type OriginScratch, fetchInto } from "./origin.js";
import { releaseRefOf } from "./pull-request.js";
import { guardedPush, pushCauseWords } from "./push.js";
import { ExecuteRefused } from "./verify-plan.js";
import { REPULL_IDENTITY, git } from "./workdir.js";

const LEDGER_PATH = ".nemar/corrections.jsonl";
const BIDSIGNORE = ".bidsignore";
const PARTICIPANTS = "participants.tsv";

/** One entry of `git ls-tree -r`: what a synthesized tree is built from. */
export interface TreeLine {
  mode: string;
  oid: string;
  path: string;
}

/** Every entry of `commit`'s tree, recursively. */
export async function treeOf(dir: string, commit: string): Promise<TreeLine[]> {
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

/** The text of `path` at `commit`, or null when it has none. */
export async function blobAt(dir: string, commit: string, path: string): Promise<string | null> {
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
export function datesOf(header: string): { author: string; committer: string } {
  const author = /^author .* (\d+ [+-]\d{4})$/m.exec(header)?.[1];
  const committer = /^committer .* (\d+ [+-]\d{4})$/m.exec(header)?.[1];
  if (!author || !committer) throw mismatch("the commit's dates could not be read");
  return { author, committer };
}

/** A path under `.nemar/`, which enrichment writes; `.github/**` is not in it. */
function underNemar(path: string): boolean {
  return path.startsWith(".nemar/");
}

/** Write a blob into the scratch repository and return its id. */
export async function hashBlob(dir: string, text: string): Promise<string> {
  return (
    await git(dir, ["hash-object", "-w", "--stdin"], {
      stdin: text,
      code: "synthesis-failed",
      step: "hash-object",
    })
  ).stdout.trim();
}

/** Make sure the scratch repository holds the recorded commit, the base and `newMain`. */
async function ensureCommits(scratch: OriginScratch, row: RepullRow, newMain: string) {
  const synth = row.synth_sha as string;
  if (
    !(await fetchInto(scratch, synth, 1)) &&
    !(await fetchInto(scratch, releaseRefOf(row.to_version), MOVED_REF_FETCH_DEPTH))
  ) {
    throw new ExecuteRefused(
      "origin-unreadable",
      "The re-pull's commit could not be fetched from NEMAR's repository.",
    );
  }
  for (const commit of [synth, newMain, row.base_sha]) {
    const r = await git(scratch.dir, ["cat-file", "-e", `${commit}^{commit}`], { ok: true });
    if (r.exitCode !== 0) {
      throw new ExecuteRefused(
        "origin-unreadable",
        "A commit the re-synthesis reads is not in the scratch repository.",
      );
    }
  }
}

/**
 * The re-synthesized commit for `newMain`, made in the scratch repository and not pushed: the
 * module comment's tree, the recorded commit's message and dates. Deterministic: the same inputs
 * make the same commit id.
 */
export async function resynthesizedCommit(args: {
  scratch: OriginScratch;
  row: RepullRow;
  newMain: string;
}): Promise<{ synthSha: string; synthTree: string }> {
  const { scratch, row, newMain } = args;
  const dir = scratch.dir;
  const synth = row.synth_sha as string;
  await ensureCommits(scratch, row, newMain);

  const raw = (
    await git(dir, ["cat-file", "commit", synth], { code: "synthesis-failed", step: "cat-file" })
  ).stdout;
  const split = raw.indexOf("\n\n");
  if (split < 0) throw mismatch("the recorded commit has no message");
  const header = raw.slice(0, split);
  const message = raw.slice(split + 2);
  const problem = await trailersProblem(message, row);
  if (problem) throw mismatch(`the recorded commit's message is not the re-pull's (${problem})`);

  // The NEMAR-owned edit, read off the commit itself: what the base named and what the commit names.
  const baseMeta = await blobAt(dir, row.base_sha, NEMAR_METADATA_PATH);
  const synthMeta = await blobAt(dir, synth, NEMAR_METADATA_PATH);
  const mainMeta = await blobAt(dir, newMain, NEMAR_METADATA_PATH);
  let metadata = mainMeta;
  if (synthMeta !== baseMeta) {
    const from = isIdenticalTo(baseMeta);
    const to = isIdenticalTo(synthMeta);
    if (baseMeta === null || synthMeta === null || from === undefined || to === undefined) {
      throw mismatch("its .nemar/metadata.json edit is not the IsIdenticalTo edit");
    }
    // The commit's edit must be exactly that edit of the base's file, so applying it again to the
    // new main's file is the whole of what the commit did there. Reading it back cannot fail on the
    // base's own file, which names `from` by construction; if it does, the recorded commit is not
    // one this module can make again.
    let again: string | null;
    try {
      again = rewriteIsIdenticalTo(baseMeta, from, to, "the recorded commit cannot be made again");
    } catch {
      again = null;
    }
    if (again !== synthMeta) {
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
  const mainEntries = await treeOf(dir, newMain);
  const baseEntries = await treeOf(dir, row.base_sha);
  const entryOf = (lines: TreeLine[], path: string) => lines.find((e) => e.path === path);
  const enriched = (path: string) =>
    entryOf(baseEntries, path)?.oid !== entryOf(mainEntries, path)?.oid;

  const entries: TreeLine[] = synthEntries.filter((e) => !underNemar(e.path));
  const replace = (line: TreeLine | null, path: string) => {
    const at = entries.findIndex((e) => e.path === path);
    if (at >= 0) entries.splice(at, 1);
    if (line) entries.push(line);
  };
  // `.bidsignore`, when enrichment changed it on main: enrichment's line, on the recorded file.
  if (enriched(BIDSIGNORE)) {
    const own = entryOf(synthEntries, BIDSIGNORE);
    const before = own ? await blobAt(dir, synth, BIDSIGNORE) : "";
    if (before === null) throw mismatch("the recorded .bidsignore could not be read");
    const after = withBidsignoreEntry(before, NEMAR_BIDSIGNORE_ENTRY);
    if (after.changed || !own) {
      replace(
        { mode: own?.mode ?? "100644", oid: await hashBlob(dir, after.content), path: BIDSIGNORE },
        BIDSIGNORE,
      );
    }
  }
  // A root `participants.tsv` enrichment added on main: N.0.0's own when it has one, else the
  // placeholder of the recorded tree's subjects, as enrichment makes it.
  if (enriched(PARTICIPANTS) && !entryOf(synthEntries, PARTICIPANTS)) {
    const subjects = enumerateBidsSubjects(synthEntries.map((e) => ({ path: e.path })));
    if (subjects.length > 0) {
      replace(
        {
          mode: "100644",
          oid: await hashBlob(dir, buildPlaceholderParticipantsTsv(subjects)),
          path: PARTICIPANTS,
        },
        PARTICIPANTS,
      );
    }
  }
  for (const e of mainEntries) {
    if (!underNemar(e.path) || e.path === LEDGER_PATH || e.path === NEMAR_METADATA_PATH) {
      continue;
    }
    entries.push(e);
  }
  const ledger = entryOf(synthEntries, LEDGER_PATH);
  if (ledger) entries.push(ledger);
  if (metadata !== null) {
    const mode = entryOf(mainEntries, NEMAR_METADATA_PATH)?.mode ?? "100644";
    entries.push({ mode, oid: await hashBlob(dir, metadata), path: NEMAR_METADATA_PATH });
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

  // Outside `.nemar/**` and the two paths enrichment writes there, the tree is the recorded one.
  const outside = (lines: TreeLine[]) =>
    lines
      .filter((e) => !underNemar(e.path) && e.path !== BIDSIGNORE && e.path !== PARTICIPANTS)
      .map((e) => `${e.mode} ${e.oid} ${e.path}`)
      .sort()
      .join("\n");
  if (outside(await treeOf(dir, synthTree)) !== outside(synthEntries)) {
    throw mismatch("its tree outside .nemar differs from the recorded commit's");
  }

  const dates = datesOf(header);
  const synthSha = (
    await git(dir, ["commit-tree", "--no-gpg-sign", synthTree, "-p", newMain, "-F", "-"], {
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
  return { synthSha, synthTree };
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
  const made = await resynthesizedCommit(args);
  const ref = releaseRefOf(row.to_version);
  const pushed = await guardedPush(
    scratch.dir,
    [`${made.synthSha}:${ref}`],
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
  return made;
}

/**
 * Whether `head`, a head that does not descend from the recorded commit, is a re-synthesis of it
 * that a run pushed and could not record: `head`, or an ancestor of it from which `head` moved by
 * enrichment only, is exactly the commit `resynthesizedCommit` makes for that commit's own parent,
 * and that parent is the recorded base or an enrichment-shaped descendant of it. Returns what to
 * record, or null. The scratch repository must hold `head`'s history (the caller fetched the
 * release branch).
 */
export async function recognizeResynthesis(args: {
  scratch: OriginScratch;
  row: RepullRow;
  head: string;
}): Promise<{ synthSha: string; synthTree: string; baseSha: string } | null> {
  const { scratch, row } = args;
  const dir = scratch.dir;
  let candidate = args.head;
  for (let i = 0; i <= ENRICHMENT_MAX_COMMITS; i++) {
    const parents = (
      await git(dir, ["rev-list", "--parents", "-n", "1", candidate], { ok: true })
    ).stdout
      .trim()
      .split(" ");
    if (parents.length !== 2) return null;
    const parent = parents[1] as string;
    const fromBase = await enrichmentOnlySince(dir, row.base_sha, parent);
    if (fromBase.ok) {
      try {
        const made = await resynthesizedCommit({ scratch, row, newMain: parent });
        if (made.synthSha === candidate) {
          const onTop = await enrichmentOnlySince(dir, candidate, args.head);
          return onTop.ok ? { ...made, baseSha: parent } : null;
        }
      } catch (err) {
        if (!(err instanceof ExecuteRefused)) throw err;
      }
    }
    candidate = parent;
  }
  return null;
}
