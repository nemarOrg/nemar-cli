/**
 * Registration (ADR 0111, decision 8; epic #1046 phase 6): before the release branch is pushed,
 * every annexed key the N.0.0 tree names is recorded present at NEMAR's `nemar-s3` on origin's
 * git-annex branch, after a fresh listing of the bucket shows its object at the size the key
 * declares, and every upstream key the scrub replaced is recorded dead.
 *
 * What is pushed is ONE commit on top of origin's git-annex branch, written from those facts, and
 * never the working clone's own git-annex branch. That branch holds what preparation needed and
 * NEMAR must not publish: the holders adopted from upstream's location log for each copied
 * recording, which are presence claims for remotes NEMAR does not control and which stay for a
 * recording the scrub did not re-key; the working clone's own repository, recorded present for the
 * content it annexed, which ceases to exist when the working directory is removed; and its
 * `uuid.log` entry. So the registration commit changes only location logs, and in each it writes
 * only `nemar-s3`'s present line, or, for a replaced key, the dead mark (every repository origin's
 * log already names set to `X`, or `nemar-s3` alone when it names none). No line it adds names a
 * repository origin's log did not already name, other than `nemar-s3`.
 *
 * The gate is the tree against the bucket (#1396, the import's `treeGate`): a key the location log
 * claims and the bucket lacks refuses (`held-key-absent`) before anything is published. The push
 * is a fast-forward through the write guard; a rejection (origin moved) re-reads origin and writes
 * the commit again, three times at most. The result is proved from origin's branch as fetched
 * again: `nemar-s3` present for every tree key, every replaced key dead (`registration-unproven`).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  annexKeyFile,
  hashDirLower,
  isDead,
  presentIn,
  readLocationLogsAt,
} from "../../../../scripts/scrub/git/git-lib.js";
import { treeGate } from "../../import-finalize-gate.js";
import { RECORDING_PATH } from "../../import-scrub.js";
import type { PlanBody } from "../digest.js";
import type { PushContext } from "../write-guard.js";
import { copyItems, planPaths } from "./body.js";
import { guardedPush, pushCauseWords } from "./push.js";
import type { CopyManifest } from "./synthesize.js";
import { ExecuteRefused } from "./verify-plan.js";
import { REPULL_IDENTITY, git } from "./workdir.js";

/** The ref origin's git-annex branch is fetched into. */
export const ORIGIN_ANNEX_REF = "refs/remotes/origin/git-annex";

/** How many times a rejected registration push is written again on top of a moved origin. */
export const REGISTRATION_TRIES = 3;

/** Every annexed path of a commit and the key it names (`git annex find --branch`). */
export async function annexedKeysAt(repo: string, treeish: string): Promise<Map<string, string>> {
  const r = await git(
    repo,
    ["annex", "find", "--include", "*", `--branch=${treeish}`, "--format=${key}\\t${file}\\n"],
    { code: "registration-failed", step: "annex find" },
  );
  const out = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) out.set(line.slice(tab + 1), line.slice(0, tab));
  }
  return out;
}

/**
 * The upstream keys the scrub replaced: a recording the plan copies at a delta path where the
 * N.0.0 tree names another key, one this host uploaded (the re-key), and that no path still names.
 */
export function replacedKeys(
  body: PlanBody,
  tree: ReadonlyMap<string, string>,
  local: ReadonlySet<string>,
): string[] {
  const copied = new Set(
    copyItems(body)
      .filter((i) => i.purpose === "copy")
      .map((i) => i.key),
  );
  const named = new Set(tree.values());
  const out = new Set<string>();
  for (const r of planPaths(body)) {
    if (!r.delta || r.target.kind !== "annex" || !RECORDING_PATH.test(r.path)) continue;
    const key = r.target.key;
    const got = tree.get(r.path);
    if (copied.has(key) && got !== undefined && got !== key && local.has(got) && !named.has(key)) {
      out.add(key);
    }
  }
  return [...out].sort();
}

/** The path a key's location log has on the git-annex branch. */
export function locationLogPath(key: string): string {
  return `${hashDirLower(key)}${annexKeyFile(key)}.log`;
}

interface LogLine {
  ts: number;
  status: string;
  uuid: string;
}

const LINE = /^(\d+(?:\.\d+)?)s (\S+) (\S+)$/;

function parsed(log: string): { lines: LogLine[]; other: string[] } {
  const lines: LogLine[] = [];
  const other: string[] = [];
  for (const raw of log.split("\n")) {
    if (raw === "") continue;
    const m = LINE.exec(raw);
    if (m) lines.push({ ts: Number(m[1]), status: m[2] as string, uuid: m[3] as string });
    else other.push(raw);
  }
  return { lines, other };
}

/** A timestamp newer than every line of the log, in git-annex's `<seconds>s` form. */
function stampAfter(lines: readonly LogLine[], nowSeconds: number): string {
  const newest = lines.reduce((t, l) => Math.max(t, l.ts), 0);
  return `${Math.floor(Math.max(nowSeconds, newest + 1))}s`;
}

/** The log with `uuid` recorded present, every other line kept as it was. */
export function withPresent(log: string, uuid: string, nowSeconds: number): string {
  const ts = stampAfter(parsed(log).lines, nowSeconds);
  const kept = log.split("\n").filter((raw) => raw !== "" && LINE.exec(raw)?.[3] !== uuid);
  return `${[...kept, `${ts} 1 ${uuid}`].join("\n")}\n`;
}

/**
 * The log with the key dead: every repository the log names set to `X` (git-annex's own `dead
 * --key`), or `fallback` (NEMAR's remote) alone when it names none, so no repository is named that
 * the log did not already name, other than NEMAR's.
 */
export function withDead(log: string, fallback: string, nowSeconds: number): string {
  const { lines, other } = parsed(log);
  const ts = stampAfter(lines, nowSeconds);
  const uuids = [...new Set(lines.map((l) => l.uuid))];
  const named = uuids.length > 0 ? uuids : [fallback];
  return `${[...other, ...named.map((u) => `${ts} X ${u}`)].join("\n")}\n`;
}

/**
 * One commit on top of `parent` (origin's git-annex branch) that writes `logs` (path -> text) and
 * nothing else, made with a private index so the working clone's own git-annex branch is untouched.
 */
async function registrationCommit(
  work: string,
  parent: string,
  logs: ReadonlyMap<string, string>,
  message: string,
): Promise<string> {
  const scratch = mkdtempSync(join(work, ".git", "repull-registration-"));
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  try {
    await git(work, ["read-tree", parent], { env, code: "registration-failed", step: "read-tree" });
    const paths = [...logs.keys()].sort();
    const files = paths.map((_p, i) => join(scratch, `log-${i}`));
    paths.forEach((p, i) => writeFileSync(files[i] as string, logs.get(p) as string));
    const hashed = await git(work, ["hash-object", "-w", "--no-filters", "--stdin-paths"], {
      stdin: `${files.join("\n")}\n`,
      code: "registration-failed",
      step: "hash-object",
    });
    const oids = hashed.stdout.split("\n").filter(Boolean);
    if (oids.length !== paths.length) {
      throw new ExecuteRefused("registration-failed", "git hash-object did not hash every log.");
    }
    await git(work, ["update-index", "-z", "--index-info"], {
      env,
      stdin: paths.map((p, i) => `100644 ${oids[i]}\t${p}\0`).join(""),
      code: "registration-failed",
      step: "update-index",
    });
    const tree = (
      await git(work, ["write-tree"], { env, code: "registration-failed", step: "write-tree" })
    ).stdout.trim();
    return (
      await git(work, ["commit-tree", "--no-gpg-sign", tree, "-p", parent, "-F", "-"], {
        stdin: `${message}\n`,
        code: "registration-failed",
        step: "commit-tree",
        env: {
          GIT_AUTHOR_NAME: REPULL_IDENTITY.name,
          GIT_AUTHOR_EMAIL: REPULL_IDENTITY.email,
          GIT_COMMITTER_NAME: REPULL_IDENTITY.name,
          GIT_COMMITTER_EMAIL: REPULL_IDENTITY.email,
        },
      })
    ).stdout.trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function fetchOriginAnnex(work: string, env: Record<string, string> | undefined) {
  await git(
    work,
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--depth=1",
      "origin",
      `+refs/heads/git-annex:${ORIGIN_ANNEX_REF}`,
    ],
    { ...(env ? { env } : {}), code: "registration-failed", step: "fetch of the git-annex branch" },
  );
  return (await git(work, ["rev-parse", "--verify", ORIGIN_ANNEX_REF])).stdout.trim();
}

async function originLogs(work: string, keys: string[]): Promise<Map<string, string>> {
  let texts: string[];
  try {
    texts = await readLocationLogsAt(work, ORIGIN_ANNEX_REF, keys);
  } catch {
    throw new ExecuteRefused("registration-failed", "Origin's git-annex branch could not be read.");
  }
  return new Map(keys.map((k, i) => [k, texts[i] ?? ""]));
}

export interface RegistrationResult {
  /** Tree keys recorded present at `nemar-s3` by this run. */
  registered: number;
  /** Replaced keys recorded dead by this run. */
  retired: number;
  /** Tree keys, all now present at `nemar-s3` on origin. */
  treeKeys: number;
}

/** Gate, register and prove; see the module comment. */
export async function registerCopied(args: {
  work: string;
  synthSha: string;
  body: PlanBody;
  manifest: CopyManifest;
  nemarUuid: string;
  /** A fresh listing of `<id>/objects/`, key -> size. */
  listing: Map<string, number>;
  bucket: string;
  datasetId: string;
  push: PushContext;
  env: Record<string, string> | undefined;
  now?: () => number;
}): Promise<RegistrationResult> {
  const { work } = args;
  const now = args.now ?? (() => Date.now() / 1000);
  const tree = await annexedKeysAt(work, args.synthSha);
  const treeKeys = new Set(tree.values());
  const gate = treeGate(treeKeys, args.listing, {
    bucket: args.bucket,
    datasetId: args.datasetId,
    manifestItems: args.manifest.items.length + args.manifest.local.length,
  });
  if (!gate.ok) {
    throw new ExecuteRefused(
      "held-key-absent",
      `${gate.unbacked.length} of ${treeKeys.size} annexed key(s) the N.0.0 tree names have no object of their declared size in NEMAR's bucket (${(gate.available * 100).toFixed(1)}% available). Nothing was registered or pushed: those keys would be advertised as content no clone can fetch. Recover the content first (nemar admin fleet content-recovery ${args.datasetId}).`,
    );
  }
  const retire = replacedKeys(args.body, tree, new Set(args.manifest.local.map((i) => i.key)));
  const keys = [...new Set([...treeKeys, ...retire])].sort();

  let registered = 0;
  let retired = 0;
  for (let attempt = 1; ; attempt++) {
    const parent = await fetchOriginAnnex(work, args.env);
    const logs = await originLogs(work, keys);
    const writes = new Map<string, string>();
    let present = 0;
    let dead = 0;
    for (const key of treeKeys) {
      const log = logs.get(key) ?? "";
      if (presentIn(log).has(args.nemarUuid)) continue;
      writes.set(locationLogPath(key), withPresent(log, args.nemarUuid, now()));
      present++;
    }
    for (const key of retire) {
      const log = logs.get(key) ?? "";
      if (isDead(log)) continue;
      writes.set(locationLogPath(key), withDead(log, args.nemarUuid, now()));
      dead++;
    }
    if (writes.size === 0) break;
    const commit = await registrationCommit(
      work,
      parent,
      writes,
      `Re-pull registration of ${args.datasetId}: ${present} key(s) at nemar-s3, ${dead} retired`,
    );
    const pushed = await guardedPush(work, [`${commit}:refs/heads/git-annex`], args.push, args.env);
    if (pushed.outcome === "pushed" || pushed.outcome === "up-to-date") {
      registered = present;
      retired = dead;
      break;
    }
    if (pushed.outcome === "remote-rejected") {
      throw new ExecuteRefused(
        "registration-push-refused",
        `NEMAR's repository refused the registration of its git-annex branch (${pushCauseWords(pushed.cause)}); pushing again cannot change it.`,
      );
    }
    if (pushed.outcome === "failed") {
      throw new ExecuteRefused(
        "registration-push-failed",
        `The registration could not be pushed to NEMAR's git-annex branch (${pushCauseWords(pushed.cause)}).`,
      );
    }
    if (attempt >= REGISTRATION_TRIES) {
      throw new ExecuteRefused(
        "registration-push-rejected",
        `NEMAR's git-annex branch moved under ${REGISTRATION_TRIES} registration pushes in a row; run again.`,
      );
    }
  }

  // The proof is origin's branch as fetched again, never what this run meant to write.
  await fetchOriginAnnex(work, args.env);
  const after = await originLogs(work, keys);
  const missing = [...treeKeys].filter(
    (k) => !presentIn(after.get(k) ?? "").has(args.nemarUuid),
  ).length;
  const alive = retire.filter((k) => !isDead(after.get(k) ?? "")).length;
  if (missing > 0 || alive > 0) {
    throw new ExecuteRefused(
      "registration-unproven",
      `Origin's git-annex branch does not record ${missing} tree key(s) at nemar-s3 or ${alive} replaced key(s) dead after the push.`,
    );
  }
  return { registered, retired, treeKeys: treeKeys.size };
}
