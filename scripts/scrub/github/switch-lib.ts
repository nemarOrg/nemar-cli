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
 * - `snapshot` records the live rulesets and, as the lease of every ref to be pushed, the SHA the
 *   CLONE knew before the rewrite (`originTips`, from `git-scrub snapshot`'s before.json). It
 *   refuses unless the remote still holds exactly those heads and tags
 *   (`remote-moved-since-clone`): a push an uploader made while the clone was being hashed and
 *   rewritten would otherwise be erased by the force-push. It also refuses a baseline in which a
 *   ruleset that would block the push is already off (`ruleset-already-lifted`), because the
 *   restore would then restore it OFF.
 * - Before either touches anything, the remote is checked to be the repository named and to hold
 *   nothing the push would strand: the clone's origin names `--repo`, the only remote heads are
 *   `main` and `git-annex`, and every remote tag exists in the clone.
 * - `switchRefs` re-reads both and refuses on any drift (a ruleset changed or created since the
 *   snapshot, a remote ref moved), disables ONLY the rulesets that would block the push (a branch
 *   ruleset the pusher can bypass is left alone), pushes with a lease per ref so it overwrites only
 *   what the clone saw, reporting each ref as it lands, and restores whatever happens, verifying
 *   each ruleset reads back as it was. SIGINT, SIGTERM and SIGHUP restore too, for the whole window
 *   including the restore itself (a second signal is ignored), and any exit that may leave a
 *   ruleset lifted prints {@link RESTORE_ADVICE}. A switch that stopped part way is finished by
 *   running it again: a ref the remote already holds at the rewrite's SHA is neither drift nor
 *   pushed twice, and a run with nothing left to push lifts nothing.
 * - The rulesets are listed page by page, and a ruleset the organization owns that would block the
 *   push is refused at the snapshot (`ruleset-not-repository`): it cannot be lifted through the
 *   repository's endpoint.
 * - `restore` re-applies a snapshot on its own, for the day the process died.
 *
 * It talks to the GitHub REST API with `fetch` (the base URL is a parameter, so tests point it
 * at a local server) and to git with the real `git` binary.
 */

import { spawn } from "node:child_process";
import { githubRepoOf } from "./repo-url";

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
  /**
   * ref name -> the lease: the SHA the clone knew for it before the rewrite (equal to the remote's
   * at snapshot time, or the snapshot is refused), or null when the ref does not exist yet.
   */
  refs: Record<string, string | null>;
  /** Every head and tag the clone knew on the remote before the rewrite (before.json). */
  originTips: Record<string, string>;
}

export class SwitchRefused extends Error {
  constructor(readonly reason: string) {
    super(`switch refused: ${reason}`);
    this.name = "SwitchRefused";
  }
}

/**
 * One or more rulesets could not be put back. It names EVERY one that failed, and the ones that
 * were restored, so nothing is left to be discovered later; `pushFailure` is the fixed reason the
 * push itself failed, when it did, so one error carries both.
 */
export class RestoreFailed extends Error {
  constructor(
    readonly rulesetIds: number[],
    readonly restored: number[] = [],
    readonly pushFailure?: string,
  ) {
    super(
      `restore failed for ruleset ${rulesetIds.join(", ")}${pushFailure ? ` after ${pushFailure}` : ""}`,
    );
    this.name = "RestoreFailed";
  }
}

/**
 * A push that failed part way. `pushed` and `notPushed` are ref names in push order; the CLI prints
 * branch names and only a COUNT of tags. `word` is a fixed class of git's stderr, never the text.
 */
export class PushFailed extends Error {
  constructor(
    readonly word: PushFailure,
    readonly pushed: string[],
    readonly notPushed: string[],
  ) {
    super(`push failed: ${word}`);
    this.name = "PushFailed";
  }
}

export type PushFailure =
  | "non-fast-forward"
  | "hook-declined"
  | "auth"
  | "network"
  | "timeout"
  | "other";

/** The class of a failed `git push` from its stderr, which is never printed or kept. */
export function classifyPushError(stderr: string): PushFailure {
  if (/stale info|non-fast-forward|fetch first|\(rejected\)|Updates were rejected/i.test(stderr)) {
    return "non-fast-forward";
  }
  if (/hook declined|pre-receive|GH0\d\d|protected branch|refusing to/i.test(stderr)) {
    return "hook-declined";
  }
  if (
    /Authentication failed|Permission denied|could not read Username|403|denied to/i.test(stderr)
  ) {
    return "auth";
  }
  if (
    /Could not resolve host|Connection (refused|reset|timed out)|unable to access|timed out|early EOF|unexpected disconnect/i.test(
      stderr,
    )
  ) {
    return "network";
  }
  return "other";
}

/** The one line printed whenever the process may end with a ruleset still lifted. */
export const RESTORE_ADVICE = "RESTORE FAILED: run switch.ts restore --execute now";

/** Exit status of a process ended by each signal the switch restores on: 128 + the number. */
export const SWITCH_SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

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

/** GitHub's page size for the rulesets list is 30 unless asked for more; 100 is its maximum. */
const RULESETS_PER_PAGE = 100;

export async function listRulesets(api: Api, repo: string): Promise<RulesetBody[]> {
  const out: RulesetBody[] = [];
  // Every page: a list cut at the first page would hide a ruleset from the snapshot, and one the
  // snapshot does not know is never restored.
  for (let page = 1; ; page++) {
    const list = (await call(
      api,
      "GET",
      `/repos/${repo}/rulesets?per_page=${RULESETS_PER_PAGE}&page=${page}`,
    )) as { id: number }[];
    for (const r of list) {
      out.push((await call(api, "GET", `/repos/${repo}/rulesets/${r.id}`)) as RulesetBody);
    }
    if (list.length < RULESETS_PER_PAGE) return out;
  }
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

/** `git push`: the exit code and stderr (for {@link classifyPushError} only, never printed). */
function gitPush(
  cwd: string,
  args: string[],
  timeoutMs = 600_000,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["push", ...args], { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? -1 : (code ?? -1), stderr: timedOut ? "timed out" : stderr });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: "" });
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

/**
 * How many heads and tags differ between the remote now and what the clone knew before. A ref the
 * remote already holds at the SHA of the rewrite (`rewritten`) is not drift: it is a ref an earlier
 * run of the switch pushed before it stopped, and counting it would refuse the re-run that finishes
 * the job.
 */
export function originDrift(
  remoteNow: Record<string, string>,
  originTips: Record<string, string>,
  rewritten: Record<string, string> = {},
): number {
  let n = 0;
  for (const ref of new Set([...Object.keys(remoteNow), ...Object.keys(originTips)])) {
    if (remoteNow[ref] === originTips[ref]) continue;
    // `ref in rewritten`: a ref that is gone from the remote and not part of the rewrite is a
    // deletion, and `undefined === undefined` must not read as "already pushed".
    if (ref in rewritten && remoteNow[ref] === rewritten[ref]) continue;
    n++;
  }
  return n;
}

export interface SnapshotOptions {
  now?: () => Date;
  /** Take the snapshot although a ruleset that would block the push is already off. */
  acceptDisabled?: boolean;
}

export async function takeSnapshot(
  api: Api,
  repo: string,
  cloneDir: string,
  remote: string,
  originTips: Record<string, string>,
  opts: SnapshotOptions = {},
): Promise<Snapshot> {
  const remoteNow = await checkRemote(cloneDir, remote, repo);
  const drift = originDrift(remoteNow, originTips);
  if (drift > 0) throw new SwitchRefused(`remote-moved-since-clone (${drift} ref(s))`);
  const rulesets = await listRulesets(api, repo);
  if (!opts.acceptDisabled && rulesets.some((r) => wouldBlock(r) && r.enforcement !== "active")) {
    throw new SwitchRefused("ruleset-already-lifted");
  }
  // The list includes rulesets inherited from the organization. They cannot be lifted through the
  // repository's endpoint, so a PUT on one would fail and the restore would report a ruleset that
  // never changed as unrestorable.
  if (
    rulesets.some(
      (r) => wouldBlock(r) && r.source_type !== undefined && r.source_type !== "Repository",
    )
  ) {
    throw new SwitchRefused("ruleset-not-repository");
  }
  const local = await localRefs(cloneDir);
  const refs: Record<string, string | null> = {};
  for (const ref of Object.keys(local)) refs[ref] = originTips[ref] ?? null;
  return {
    version: 1,
    repo,
    takenAt: (opts.now ?? (() => new Date()))().toISOString(),
    rulesets,
    refs,
    originTips,
  };
}

/** A ruleset of a kind that blocks this push when it is on: tags, or branches the pusher cannot bypass. */
export function wouldBlock(ruleset: RulesetBody): boolean {
  if (ruleset.target === "tag") return true;
  return ruleset.target === "branch" && ruleset.current_user_can_bypass !== "always";
}

/** A ruleset blocks this push unless it is disabled, or it targets branches and the pusher can bypass it. */
export function needsLifting(ruleset: RulesetBody): boolean {
  return ruleset.enforcement === "active" && wouldBlock(ruleset);
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

/**
 * Put back EVERY lifted ruleset, whatever happens to the others: a failure is collected, not
 * thrown, so a ruleset that cannot be restored never leaves a later one disabled. Throws one
 * {@link RestoreFailed} naming all the failures after every ruleset has had its turn.
 */
async function restoreAll(opts: SwitchOptions, lifted: RulesetBody[]): Promise<number[]> {
  const restored: number[] = [];
  const failed: number[] = [];
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
    (ok ? restored : failed).push(r.id);
  }
  if (failed.length > 0) throw new RestoreFailed(failed, restored);
  return restored;
}

/** Whether the process may end with a ruleset lifted, and whether the advice was printed. */
const lifting = { mayBeLifted: false, advised: false, hooked: false };

/**
 * Print {@link RESTORE_ADVICE} once, whichever exit path gets there first (the CLI's catch, the
 * signal path, or the exit hook), with the ruleset ids when known.
 */
export function adviseRestore(detail?: string): void {
  if (lifting.advised) return;
  lifting.advised = true;
  console.error(detail ? `${RESTORE_ADVICE}\n(${detail})` : RESTORE_ADVICE);
}

/**
 * Lift, push, restore. With `execute: false` it reads and plans and changes nothing.
 * Throws {@link SwitchRefused} before touching anything when the repository has drifted from the
 * snapshot, and always restores what it lifted, whatever the push did. A push that fails part way
 * throws {@link PushFailed} naming what was and was not pushed.
 */
export async function switchRefs(opts: SwitchOptions): Promise<SwitchReport> {
  const log = opts.log ?? (() => {});
  const { api, repo, snapshot } = opts;
  if (snapshot.repo !== repo) throw new SwitchRefused("snapshot-other-repository");

  const live = await listRulesets(api, repo);
  for (const s of snapshot.rulesets) {
    const l = live.find((x) => x.id === s.id);
    if (!l || l.enforcement !== s.enforcement)
      throw new SwitchRefused("a ruleset changed since the snapshot");
  }
  // A ruleset created after the snapshot has no "before" to restore it to.
  if (live.some((l) => !snapshot.rulesets.some((s) => s.id === l.id))) {
    throw new SwitchRefused("ruleset-not-in-snapshot");
  }
  const remoteNow = await checkRemote(opts.cloneDir, opts.remote, repo);
  const local = await localRefs(opts.cloneDir);
  const drift = originDrift(remoteNow, snapshot.originTips, local);
  if (drift > 0) throw new SwitchRefused(`remote-moved-since-clone (${drift} ref(s))`);
  for (const ref of Object.keys(local)) {
    // A ref already at the rewrite was pushed by an earlier run that stopped part way; any other
    // SHA than the snapshot's or the rewrite's is somebody else's push.
    if (
      (remoteNow[ref] ?? null) !== (snapshot.refs[ref] ?? null) &&
      remoteNow[ref] !== local[ref]
    ) {
      throw new SwitchRefused("a remote ref moved since the snapshot");
    }
  }
  const refsToPush = Object.keys(local).filter((r) => local[r] !== remoteNow[r]);
  // Nothing to push (an earlier run finished the job): the protection is not touched at all, not
  // lifted and put back for a push that does not happen.
  const toLift = refsToPush.length === 0 ? [] : live.filter(needsLifting);
  log(`plan: lift ${toLift.length} ruleset(s), push ${refsToPush.length} ref(s)`);
  if (!opts.execute)
    return { executed: false, lifted: toLift.map((r) => r.id), pushed: refsToPush, restored: [] };

  const lifted: RulesetBody[] = [];
  const pushed: string[] = [];
  /** The one restore: started by the normal path or by a signal, whichever comes first. */
  let restoring: Promise<number[]> | undefined;
  const restoreOnce = (): Promise<number[]> => {
    restoring ??= restoreAll(opts, lifted).then((ids) => {
      lifting.mayBeLifted = false;
      return ids;
    });
    return restoring;
  };
  // A signal restores first and then exits: 5 when a ruleset could not be put back (act on it
  // now), 128 + the signal number otherwise. Handlers stay for the whole window INCLUDING the
  // restore; a second signal during it is ignored and says so.
  const onSignal = (signal: NodeJS.Signals) => {
    if (restoring) {
      console.error("restore in progress");
      return;
    }
    void (async () => {
      let code: number = SWITCH_SIGNAL_EXIT[signal as keyof typeof SWITCH_SIGNAL_EXIT] ?? 130;
      try {
        await restoreOnce();
        console.error(`switch: interrupted by ${signal}; protection restored`);
      } catch (error) {
        adviseRestore(error instanceof RestoreFailed ? error.message : "restore did not finish");
        code = 5;
      }
      process.exit(code);
    })();
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const sig of signals) process.on(sig, onSignal);
  if (!lifting.hooked) {
    lifting.hooked = true;
    // Any exit while a ruleset may still be lifted, however it happens, says what to do.
    process.on("exit", () => {
      if (lifting.mayBeLifted) adviseRestore();
    });
  }
  let failure: unknown;
  try {
    try {
      for (const r of toLift) {
        lifted.push(r);
        lifting.mayBeLifted = true;
        await setEnforcement(api, repo, r, "disabled");
        const after = (await listRulesets(api, repo)).find((x) => x.id === r.id);
        if (after?.enforcement !== "disabled")
          throw new SwitchRefused("a ruleset did not read back as disabled");
        log(`lifted ruleset ${r.id}`);
      }
      const tagsTotal = refsToPush.filter((r) => r.startsWith("refs/tags/")).length;
      let tagsDone = 0;
      for (const ref of refsToPush) {
        // The lease is what the clone knew before the rewrite, not what the remote says now.
        const lease = snapshot.refs[ref] ?? "";
        const r = await gitPush(opts.cloneDir, [
          `--force-with-lease=${ref}:${lease}`,
          opts.remote,
          `${local[ref]}:${ref}`,
        ]);
        if (r.code !== 0) {
          throw new PushFailed(
            classifyPushError(r.stderr),
            [...pushed],
            refsToPush.filter((x) => !pushed.includes(x)),
          );
        }
        pushed.push(ref);
        if (ref.startsWith("refs/tags/")) {
          tagsDone++;
          log(`pushed tag ${tagsDone} of ${tagsTotal}`);
        } else {
          log(`pushed ${ref}`);
        }
      }
      log(`pushed ${pushed.length} ref(s)`);
    } catch (error) {
      failure = error;
    }
    // The restore runs whatever the push did. When both fail, the restore failure is the one that
    // is thrown (it needs action now) and it carries the push's fixed reason too.
    let restoredIds: number[];
    try {
      restoredIds = await restoreOnce();
    } catch (error) {
      if (error instanceof RestoreFailed && failure !== undefined) {
        throw new RestoreFailed(
          error.rulesetIds,
          error.restored,
          failure instanceof PushFailed
            ? failure.message
            : failure instanceof SwitchRefused
              ? failure.reason
              : "an unexpected error",
        );
      }
      throw error;
    }
    log(`restored ${restoredIds.length} ruleset(s)`);
    if (failure !== undefined) throw failure;
    const after = await remoteRefs(opts.cloneDir, opts.remote, REMOTE_PATTERNS);
    for (const ref of pushed)
      if (after[ref] !== local[ref]) throw new SwitchRefused("a pushed ref does not match");
    return { executed: true, lifted: lifted.map((r) => r.id), pushed, restored: restoredIds };
  } finally {
    // Only once nothing is left to restore: a signal that arrives after this is the CLI's own.
    if (!lifting.mayBeLifted) for (const sig of signals) process.removeListener(sig, onSignal);
  }
}

/**
 * Re-apply a snapshot's enforcement to every ruleset that differs, e.g. after a crash. Every
 * drifted ruleset is tried, and a read-back decides which are restored; those that are not are
 * all named in one {@link RestoreFailed}.
 */
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
  for (const s of drifted) {
    try {
      await setEnforcement(api, repo, s, s.enforcement);
    } catch {
      // the read-back below says whether it took
    }
  }
  let check: RulesetBody[] = [];
  try {
    check = await listRulesets(api, repo);
  } catch {
    // unreadable is not restored: every drifted ruleset is reported
  }
  const done = drifted.filter(
    (s) => check.find((l) => l.id === s.id)?.enforcement === s.enforcement,
  );
  const failed = snapshot.rulesets.filter(
    (s) => check.find((l) => l.id === s.id)?.enforcement !== s.enforcement,
  );
  if (failed.length > 0) {
    throw new RestoreFailed(
      failed.map((s) => s.id),
      done.map((s) => s.id),
    );
  }
  return done.map((s) => s.id);
}
