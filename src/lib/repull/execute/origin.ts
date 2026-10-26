/**
 * A scratch repository that reads NEMAR's origin for the steps past the open pull request (ADR
 * 0111, decisions 2 and 7; epic #1046 phase 6): the release branch's head and `main`, each judged
 * by `enrichmentOnlySince`, the re-synthesis onto a moved `main`, and the tag the release reads.
 *
 * The working clone is gone by then (it is removed at `pr_open`, because it held the delta's
 * unscrubbed originals), so these steps fetch only what they judge, into a bare repository of
 * their own: `$NEMAR_CONFIG_DIR/repull/<id>/<purpose>/<digest8>-<pid>/` (`resume`, `merge`, or
 * `settle` for an automatic run's settle of the release head in `settle.ts`), mode 0700 like every
 * directory of an execution, made empty at the start of a run and removed at its end; the purpose
 * and the process id keep a merge (`nemar admin pr-reviews` too) and a resume of one record, which
 * may run at once, out of each other's way. Its one remote is
 * `origin`, NEMAR's repository, so `checkMain`, `acceptsHead` and the guarded push read and write
 * it exactly as they do the working clone. Every git call reads neither the administrator's
 * global configuration nor the system's, and carries its credentials in the environment.
 */

import { join } from "node:path";
import { fleetCloneEnv } from "../../fleet-key-registration.js";
import { type Env, originUrl } from "../sources.js";
import { digest8, git, privateDir, removeTree } from "./workdir.js";

export interface OriginScratch {
  /** The bare repository, whose remote `origin` is NEMAR's repository. */
  dir: string;
  /** The credential environment of `origin`, for its fetches and its push. */
  env: Record<string, string> | undefined;
  /** Remove the scratch repository. */
  close(): void;
}

/** Where a run's scratch repository lives, under the dataset's own execution directory. */
export function scratchDir(
  configDir: string,
  datasetId: string,
  digest: string,
  purpose: "resume" | "merge" | "settle",
): string {
  return join(configDir, "repull", datasetId, purpose, `${digest8(digest)}-${process.pid}`);
}

/**
 * A fresh, empty bare repository whose `origin` is NEMAR's dataset repository. Whatever a crashed
 * run left at its path is removed first.
 */
export async function openOriginScratch(args: {
  configDir: string;
  datasetId: string;
  digest: string;
  purpose: "resume" | "merge" | "settle";
  env: Env;
  token: string | null;
}): Promise<OriginScratch> {
  const dir = scratchDir(args.configDir, args.datasetId, args.digest, args.purpose);
  removeTree(dir);
  privateDir(dir, join(args.configDir, "repull"));
  const url = originUrl(args.datasetId, args.env);
  await git(dir, ["init", "--quiet", "--bare"], { code: "origin-unreadable", step: "init" });
  // No background gc or maintenance: a writer in the scratch repository would race its removal.
  for (const [key, value] of [
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    ["core.hooksPath", "/dev/null"],
  ] as const) {
    await git(dir, ["config", key, value], { code: "origin-unreadable", step: "config" });
  }
  await git(dir, ["remote", "add", "origin", url], { code: "origin-unreadable", step: "remote" });
  return {
    dir,
    env: fleetCloneEnv(url, args.token),
    close: () => removeTree(dir),
  };
}

/**
 * Fetch one commit, or the commit a ref names, into the scratch repository at `depth`. True when
 * the commit is there afterwards; a fetch that fails is false, never a throw, because the caller
 * decides what an unread commit means (unknown, never a pass).
 */
export async function fetchInto(
  scratch: OriginScratch,
  what: string,
  depth: number,
): Promise<boolean> {
  const local = /^[0-9a-f]{40}$/.test(what)
    ? what
    : `+${what}:${what.replace(/^refs\/(heads|tags)\//, "refs/remotes/origin/$1/")}`;
  const r = await git(
    scratch.dir,
    ["fetch", "--quiet", "--no-tags", `--depth=${depth}`, "origin", local],
    { ...(scratch.env ? { env: scratch.env } : {}), ok: true },
  );
  return r.exitCode === 0;
}

/**
 * The commit each of `refs` names on origin (a tag peeled to its commit), by `git ls-remote`;
 * absent when origin has no such ref. Throws `origin-unreadable` when origin cannot be read.
 */
export async function originRefs(
  scratch: OriginScratch,
  refs: readonly string[],
): Promise<Map<string, string>> {
  const r = await git(scratch.dir, ["ls-remote", "origin", ...refs], {
    ...(scratch.env ? { env: scratch.env } : {}),
    code: "origin-unreadable",
    step: "ls-remote",
  });
  const out = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const [oid, name] = line.split("\t");
    if (!oid || !name || !/^[0-9a-f]{40}$/.test(oid)) continue;
    if (name.endsWith("^{}")) peeled.set(name.slice(0, -3), oid);
    else out.set(name, oid);
  }
  // An annotated tag's own line names the tag object; its peeled line names the commit.
  for (const [name, oid] of peeled) out.set(name, oid);
  return out;
}
