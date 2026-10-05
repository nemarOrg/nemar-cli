/**
 * Move a rewritten history onto a GitHub repository, and put the protection back.
 *
 * A scrub rewrites every commit and moves every version tag. The repository's rulesets are what
 * stop that: `Protect version tags` forbids moving a tag and has no bypass actor, and the branch
 * ruleset forbids a non-fast-forward unless the pusher can bypass it. So the rewrite needs the
 * rulesets lifted for the length of one push and restored after it, and this module is the whole
 * of that: nothing about it is clever, and each step is built so that a failure leaves the
 * protection ON.
 *
 * - `snapshot` records the live rulesets and the remote SHA of every ref to be pushed.
 * - Before either touches anything, the remote is checked to be the repository named and to hold
 *   nothing the push would strand: the clone's origin names `--repo`, the only remote heads are
 *   `main` and `git-annex`, and every remote tag exists in the clone.
 * - `switchRefs` re-reads both and refuses on any drift, disables ONLY the rulesets that would
 *   block the push (a branch ruleset the pusher can bypass is left alone), pushes with a lease
 *   per ref so it overwrites only what the snapshot saw, and restores in a `finally`, verifying
 *   each ruleset reads back as it was. A signal during the push restores too.
 * - `restore` re-applies a snapshot on its own, for the day the process died.
 *
 * It talks to the GitHub REST API with `fetch` (the base URL is a parameter, so tests point it
 * at a local server) and to git with the real `git` binary.
 */

import { spawn } from "node:child_process";

export interface RulesetBody {
  id: number;
  name: string;
  target: string;
  enforcement: "active" | "disabled" | "evaluate";
  bypass_actors?: unknown[];
  conditions?: unknown;
  rules?: unknown[];
  current_user_can_bypass?: string;
  [extra: string]: unknown;
}

export interface Snapshot {
  version: 1;
  repo: string;
  takenAt: string;
  rulesets: RulesetBody[];
  /** ref name -> remote SHA at snapshot time, or null when the ref does not exist yet. */
  refs: Record<string, string | null>;
}

export class SwitchRefused extends Error {
  constructor(readonly reason: string) {
    super(`switch refused: ${reason}`);
    this.name = "SwitchRefused";
  }
}

export class RestoreFailed extends Error {
  constructor(readonly rulesetId: number) {
    super(`restore failed for ruleset ${rulesetId}`);
    this.name = "RestoreFailed";
  }
}

export interface Api {
  base: string;
  token: string;
}

const READ_ONLY_FIELDS = [
  "id",
  "node_id",
  "source",
  "source_type",
  "created_at",
  "updated_at",
  "_links",
  "current_user_can_bypass",
];

async function call(api: Api, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${api.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${api.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "nemar-scrub",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new SwitchRefused(`github ${method} answered HTTP ${res.status}`);
  }
  return res.json();
}

export async function listRulesets(api: Api, repo: string): Promise<RulesetBody[]> {
  const list = (await call(api, "GET", `/repos/${repo}/rulesets`)) as { id: number }[];
  const out: RulesetBody[] = [];
  for (const r of list)
    out.push((await call(api, "GET", `/repos/${repo}/rulesets/${r.id}`)) as RulesetBody);
  return out;
}

export async function setEnforcement(
  api: Api,
  repo: string,
  ruleset: RulesetBody,
  enforcement: RulesetBody["enforcement"],
): Promise<void> {
  const body: Record<string, unknown> = { ...ruleset, enforcement };
  for (const f of READ_ONLY_FIELDS) delete body[f];
  await call(api, "PUT", `/repos/${repo}/rulesets/${ruleset.id}`, body);
}

/** Run git; resolves with stdout, rejects with a fixed-word error carrying no output. */
export function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new SwitchRefused(`git ${args[0]} exited ${code}`));
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new SwitchRefused("git could not run"));
    });
  });
}

/** Remote SHAs for the given patterns, from `git ls-remote`. */
export async function remoteRefs(
  cloneDir: string,
  remote: string,
  patterns: string[],
): Promise<Record<string, string>> {
  const out = await git(cloneDir, ["ls-remote", remote, ...patterns]);
  const refs: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (sha && ref && !ref.endsWith("^{}")) refs[ref] = sha;
  }
  return refs;
}

/** Local SHAs of the refs a rewrite produced: the default branch and every tag. */
export async function localRefs(cloneDir: string): Promise<Record<string, string>> {
  const out = await git(cloneDir, [
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    "refs/heads/main",
    "refs/tags",
  ]);
  const refs: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const [sha, ref] = line.split(" ");
    if (sha && ref) refs[ref] = sha;
  }
  return refs;
}

/** Heads the remote may hold: the branch a rewrite moves, and the annex's own. */
const ALLOWED_REMOTE_HEADS = new Set(["refs/heads/main", "refs/heads/git-annex"]);
/** Every ref the switch compares: all heads (so a stray one is seen) and all tags. */
const REMOTE_PATTERNS = ["refs/heads/*", "refs/tags/*"];

/** `owner/name`, lowercased, of a GitHub remote URL in https, ssh:// or scp form; else null. */
export function githubRepoOf(url: string): string | null {
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/:]+@)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** git exit code 1 from `config --get-all` means "no such key", which is an answer, not a failure. */
async function configValues(cloneDir: string, key: string): Promise<string[]> {
  try {
    return (await git(cloneDir, ["config", "--get-all", key])).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Refuse unless every URL the clone would fetch from or push to for `remote` names `repo`. A clone
 * of another dataset, or a remote renamed by hand, would otherwise take this dataset's rulesets
 * and push another repository's history under them.
 */
export async function assertOriginIsRepo(
  cloneDir: string,
  remote: string,
  repo: string,
): Promise<void> {
  const urls = await configValues(cloneDir, `remote.${remote}.url`);
  const pushUrls = await configValues(cloneDir, `remote.${remote}.pushurl`);
  // A bare URL given instead of a remote name stands for itself.
  const all = urls.length > 0 ? [...urls, ...pushUrls] : /[:/]/.test(remote) ? [remote] : [];
  const want = repo.toLowerCase();
  if (all.length === 0 || !all.every((u) => githubRepoOf(u) === want)) {
    throw new SwitchRefused("origin-mismatch");
  }
}

/**
 * The remote's heads and tags, after refusing a remote that is not the repository named, that
 * holds a head the push would leave behind, or that has a tag the clone lacks (the rewrite would
 * leave that tag on the old history). Read-only; runs before anything is lifted.
 */
export async function checkRemote(
  cloneDir: string,
  remote: string,
  repo: string,
): Promise<Record<string, string>> {
  await assertOriginIsRepo(cloneDir, remote, repo);
  const remoteNow = await remoteRefs(cloneDir, remote, REMOTE_PATTERNS);
  if (
    Object.keys(remoteNow).some((r) => r.startsWith("refs/heads/") && !ALLOWED_REMOTE_HEADS.has(r))
  ) {
    throw new SwitchRefused("unexpected-remote-head");
  }
  const local = await localRefs(cloneDir);
  if (Object.keys(remoteNow).some((r) => r.startsWith("refs/tags/") && !(r in local))) {
    throw new SwitchRefused("remote-only-tag");
  }
  return remoteNow;
}

export async function takeSnapshot(
  api: Api,
  repo: string,
  cloneDir: string,
  remote: string,
  now: () => Date = () => new Date(),
): Promise<Snapshot> {
  const remoteNow = await checkRemote(cloneDir, remote, repo);
  const local = await localRefs(cloneDir);
  const refs: Record<string, string | null> = {};
  for (const ref of Object.keys(local)) refs[ref] = remoteNow[ref] ?? null;
  return {
    version: 1,
    repo,
    takenAt: now().toISOString(),
    rulesets: await listRulesets(api, repo),
    refs,
  };
}

/** A ruleset blocks this push unless it is disabled, or it targets branches and the pusher can bypass it. */
export function needsLifting(ruleset: RulesetBody): boolean {
  if (ruleset.enforcement !== "active") return false;
  if (ruleset.target === "branch" && ruleset.current_user_can_bypass === "always") return false;
  return ruleset.target === "branch" || ruleset.target === "tag";
}

export interface SwitchOptions {
  api: Api;
  repo: string;
  cloneDir: string;
  remote: string;
  snapshot: Snapshot;
  execute: boolean;
  /** Called with a fixed-word line for each step; never any value. */
  log?: (line: string) => void;
}

export interface SwitchReport {
  executed: boolean;
  lifted: number[];
  pushed: string[];
  restored: number[];
}

async function restoreAll(opts: SwitchOptions, lifted: RulesetBody[]): Promise<number[]> {
  const restored: number[] = [];
  for (const r of lifted) {
    const original = opts.snapshot.rulesets.find((s) => s.id === r.id) as RulesetBody;
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        await setEnforcement(opts.api, opts.repo, original, original.enforcement);
        const live = (await listRulesets(opts.api, opts.repo)).find((l) => l.id === r.id);
        ok = live?.enforcement === original.enforcement;
      } catch {
        ok = false;
      }
    }
    if (!ok) throw new RestoreFailed(r.id);
    restored.push(r.id);
  }
  return restored;
}

/**
 * Lift, push, restore. With `execute: false` it reads and plans and changes nothing.
 * Throws {@link SwitchRefused} before touching anything when the repository has drifted from the
 * snapshot, and always restores what it lifted, whatever the push did.
 */
export async function switchRefs(opts: SwitchOptions): Promise<SwitchReport> {
  const log = opts.log ?? (() => {});
  const { api, repo, snapshot } = opts;
  if (snapshot.repo !== repo) throw new SwitchRefused("snapshot is for another repository");

  const live = await listRulesets(api, repo);
  for (const s of snapshot.rulesets) {
    const l = live.find((x) => x.id === s.id);
    if (!l || l.enforcement !== s.enforcement)
      throw new SwitchRefused("a ruleset changed since the snapshot");
  }
  const remoteNow = await checkRemote(opts.cloneDir, opts.remote, repo);
  const local = await localRefs(opts.cloneDir);
  for (const ref of Object.keys(local)) {
    if ((remoteNow[ref] ?? null) !== (snapshot.refs[ref] ?? null)) {
      throw new SwitchRefused("a remote ref moved since the snapshot");
    }
  }
  const toLift = live.filter(needsLifting);
  const refsToPush = Object.keys(local).filter((r) => local[r] !== remoteNow[r]);
  log(`plan: lift ${toLift.length} ruleset(s), push ${refsToPush.length} ref(s)`);
  if (!opts.execute)
    return { executed: false, lifted: toLift.map((r) => r.id), pushed: refsToPush, restored: [] };

  const lifted: RulesetBody[] = [];
  const pushed: string[] = [];
  let restoredIds: number[] = [];
  const onSignal = () => {
    void restoreAll(opts, lifted).finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    for (const r of toLift) {
      lifted.push(r);
      await setEnforcement(api, repo, r, "disabled");
      const after = (await listRulesets(api, repo)).find((x) => x.id === r.id);
      if (after?.enforcement !== "disabled")
        throw new SwitchRefused("a ruleset did not read back as disabled");
      log(`lifted ruleset ${r.id}`);
    }
    for (const ref of refsToPush) {
      const lease = remoteNow[ref] ?? "";
      await git(opts.cloneDir, [
        "push",
        `--force-with-lease=${ref}:${lease}`,
        opts.remote,
        `${local[ref]}:${ref}`,
      ]);
      pushed.push(ref);
    }
    log(`pushed ${pushed.length} ref(s)`);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    restoredIds = await restoreAll(opts, lifted);
    log(`restored ${restoredIds.length} ruleset(s)`);
  }
  const after = await remoteRefs(opts.cloneDir, opts.remote, REMOTE_PATTERNS);
  for (const ref of pushed)
    if (after[ref] !== local[ref]) throw new SwitchRefused("a pushed ref does not match");
  return { executed: true, lifted: lifted.map((r) => r.id), pushed, restored: restoredIds };
}

/** Re-apply a snapshot's enforcement to every ruleset that differs, e.g. after a crash. */
export async function restoreSnapshot(
  api: Api,
  repo: string,
  snapshot: Snapshot,
  execute: boolean,
): Promise<number[]> {
  const live = await listRulesets(api, repo);
  const drifted = snapshot.rulesets.filter(
    (s) => live.find((l) => l.id === s.id)?.enforcement !== s.enforcement,
  );
  if (!execute) return drifted.map((r) => r.id);
  const done: number[] = [];
  for (const s of drifted) {
    await setEnforcement(api, repo, s, s.enforcement);
    done.push(s.id);
  }
  const check = await listRulesets(api, repo);
  for (const s of snapshot.rulesets) {
    if (check.find((l) => l.id === s.id)?.enforcement !== s.enforcement)
      throw new RestoreFailed(s.id);
  }
  return done;
}
