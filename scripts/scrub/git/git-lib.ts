/**
 * The git half of the privacy scrub: snapshot a clone, rewrite its history, verify the
 * rewrite, and retract the old annex keys from the location log.
 *
 * Every function here works on a LOCAL clone and never contacts a remote. **Nothing
 * identifying leaves this module**: a failure is a fixed word and a count, because a file
 * name or a key can be the identifier. A failure's `detail` is the subcommand that failed, from a
 * closed list ({@link DETAIL_WORDS}); raw stderr is kept on the error object for a developer and
 * is never printed by the CLI.
 *
 * `rewrite` runs `rewrite_history.py` (git-filter-repo, driven through its Python API) and
 * leaves the `git-annex` branch alone. `verifyRewrite` is written independently of that
 * script on purpose: it reads the repository with plain git and shares no code with it, so
 * a bug in the rewrite cannot also hide in the check.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ANNEX_KEY,
  ContractError,
  type GitPlanFile,
  type JsonOp,
  type KeymapFile,
  type LedgerEntry,
  type PlanFile,
  parseGitPlan,
  parseKey,
  parseKeymap,
  parsePlan,
} from "../contract";
import { githubRepoOf } from "../github/repo-url";
import { VERSION_TAG, validateLedgerEntry } from "../ledger";

/** Pinned: the rewrite script is written against this release's Python API. */
export const FILTER_REPO_REQUIREMENT = "git-filter-repo==2.47.0";
export const REWRITE_SCRIPT = join(import.meta.dir, "rewrite_history.py");

/**
 * The subcommands this tool runs, as the fixed words a failure may name. A CLOSED list: a detail
 * that is not one of these is printed as `other`, so nothing a caller passes (a path, a key,
 * stderr) can reach the terminal through it.
 */
export const DETAIL_WORDS: ReadonlySet<string> = new Set([
  "git cat-file",
  "git config",
  "git for-each-ref",
  "git log",
  "git ls-tree",
  "git rev-list",
  "git rev-parse",
  "git show",
  "git other",
  "annex examinekey",
  "annex whereis",
  "annex setpresentkey",
  "annex dead",
  "rewrite script",
]);

/** The detail word for a failed `git <args>`: the subcommand, when it is one of {@link DETAIL_WORDS}. */
export function gitDetail(args: readonly string[]): string {
  const word = `git ${args[0] ?? ""}`;
  return DETAIL_WORDS.has(word) ? word : "git other";
}

export class GitScrubError extends Error {
  /** A fixed word from {@link DETAIL_WORDS} saying which command failed; "" when none applies. */
  readonly detail: string;
  /** Raw stderr of the failed command, for a developer in a debugger. Never printed. */
  readonly stderr: string;
  constructor(reason: string, detail = "", stderr = "") {
    super(reason);
    this.name = "GitScrubError";
    this.detail = DETAIL_WORDS.has(detail) ? detail : detail === "" ? "" : "git other";
    this.stderr = stderr;
  }
}

// ---------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------

/** `canon`: the spelling plans use for JSON keys. Lowercase, no space, underscore or hyphen. */
export function canonicalKey(name: string): string {
  return name.toLowerCase().replace(/[ _-]/g, "");
}

/** The ids a dataset repository can have: `nm`, `xx` and `on` followed by six digits. */
const DATASET_ID = /^(nm|xx|on)\d{6}$/;

/** The repository a dataset's history lives in, which a rewrite's clone must have as its origin. */
export function datasetRemote(dataset: string): string {
  if (!DATASET_ID.test(dataset)) throw new ContractError("git-plan.json holds a bad dataset id");
  return `https://github.com/nemarDatasets/${dataset}`;
}

/** What the contract's `parseGitPlan` leaves unchecked: the dataset id and the shape of each entry. */
export function assertGitPlanShape(plan: GitPlanFile): void {
  const bad = (reason: string): never => {
    throw new ContractError(reason);
  };
  if (typeof plan.dataset !== "string" || !DATASET_ID.test(plan.dataset)) {
    bad("git-plan.json holds a bad dataset id");
  }
  const okPath = (p: unknown): p is string =>
    typeof p === "string" && p.length > 0 && !p.includes("\n") && !p.startsWith("/");
  if (!plan.dropPaths.every(okPath)) bad("git-plan.json holds a bad dropPaths entry");
  for (const [path, keys] of Object.entries(plan.blankJsonKeys)) {
    if (!okPath(path) || !Array.isArray(keys) || !keys.every((k) => typeof k === "string")) {
      bad("git-plan.json holds a bad blankJsonKeys entry");
    }
  }
  for (const [path, text] of Object.entries(plan.appendText)) {
    if (!okPath(path) || typeof text !== "string" || text.length === 0) {
      bad("git-plan.json holds a bad appendText entry");
    }
  }
  for (const [path, ops] of Object.entries(plan.jsonOps ?? {})) {
    if (!okPath(path) || !ops.every(validJsonOp)) bad("git-plan.json holds a bad jsonOps entry");
  }
  if (plan.skippedJson !== undefined) {
    const sj = plan.skippedJson as unknown as Record<string, unknown>;
    const list = (x: unknown) => Array.isArray(x) && x.every(okPath);
    if (typeof sj !== "object" || sj === null || !list(sj.oversize) || !list(sj.unparseable)) {
      bad("git-plan.json holds a bad skippedJson entry");
    }
  }
  const dropped = new Set(plan.dropPaths);
  if (
    [...Object.keys(plan.appendText), ...Object.keys(plan.jsonOps ?? {})].some((p) =>
      dropped.has(p),
    )
  ) {
    bad("git-plan.json drops and edits the same path");
  }
}

/** The fields of one jsonOps entry, beyond the op name `parseGitPlan` already checks. */
function validJsonOp(op: JsonOp): boolean {
  const text = (...values: unknown[]): boolean =>
    values.every((v) => typeof v === "string" && v.length > 0);
  if (op.op === "drop-array-entries") {
    return (
      text(op.array, op.matchField) &&
      Array.isArray(op.matchValues) &&
      op.matchValues.every((v) => typeof v === "string")
    );
  }
  if (op.op === "recount") return text(op.array, op.countKey, op.sumKey, op.sumField);
  return text(op.key) && typeof op.value === "string";
}

export interface ScrubInputs {
  keymap: KeymapFile;
  plan: GitPlanFile;
}

export function readKeymap(keymapPath: string): KeymapFile {
  return parseKeymap(readFileSync(keymapPath, "utf8"));
}

/** The S3 stage's `plan.json`, which says which keys are clean and which were scrubbed. */
export function readS3Plan(planPath: string): PlanFile {
  return parsePlan(readFileSync(planPath, "utf8"));
}

/** Read and guard the two stage files. Throws ContractError on anything that does not match. */
export function readInputs(keymapPath: string, planPath: string): ScrubInputs {
  const keymap = readKeymap(keymapPath);
  const plan = parseGitPlan(readFileSync(planPath, "utf8"));
  assertGitPlanShape(plan);
  return { keymap, plan };
}

// ---------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

/** Run `git -C repo args`, binary-safe. Never throws on a non-zero exit. */
export async function gitRaw(
  repo: string,
  args: string[],
  stdin?: string | Uint8Array,
): Promise<GitResult> {
  const input = typeof stdin === "string" ? new TextEncoder().encode(stdin) : stdin;
  const proc = Bun.spawn(["git", "-C", repo, ...args], {
    ...(input === undefined ? {} : { stdin: input as Uint8Array }),
    stdout: "pipe",
    stderr: "pipe",
    env: GIT_ENV,
  });
  const [out, err, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: Buffer.from(out), stderr: err, exitCode };
}

/** Run git and return stdout as text, or throw a fixed-word error. */
export async function git(repo: string, args: string[], stdin?: string): Promise<string> {
  const r = await gitRaw(repo, args, stdin);
  if (r.exitCode !== 0) throw new GitScrubError("git-command-failed", gitDetail(args), r.stderr);
  return r.stdout.toString("utf8");
}

/** Refs, with their object ids and the type of the object each names (commit or tag). */
export async function listRefs(
  repo: string,
): Promise<{ name: string; sha: string; type: string }[]> {
  const out = await git(repo, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)%09%(objecttype)",
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, sha, type] = line.split("\t") as [string, string, string];
      return { name, sha, type };
    });
}

export function isAnnexRef(name: string): boolean {
  return name.split("/").pop() === "git-annex";
}

/** The refs a rewrite covers: heads, remote-tracking heads and tags; never git-annex. */
export function isRewriteRef(name: string): boolean {
  if (isAnnexRef(name)) return false;
  if (name.startsWith("refs/heads/") || name.startsWith("refs/tags/")) return true;
  const parts = name.split("/");
  return (
    name.startsWith("refs/remotes/") && parts.length >= 4 && parts[parts.length - 1] !== "HEAD"
  );
}

// ---------------------------------------------------------------------------------------
// The raw log: every entry of every commit
// ---------------------------------------------------------------------------------------

/**
 * Arguments of the one walk that sees every path and blob of every commit reachable from the
 * refs given on stdin, one name per line. `-m` diffs a merge against each parent, a root commit
 * lists all its files, and `--no-renames` keeps each entry a single path, so every blob in any
 * tree is the new side of some entry (or the old side of a deletion that appeared earlier).
 */
export const RAW_LOG_ARGS = [
  "log",
  "--stdin",
  "-m",
  "--raw",
  "-z",
  "--no-renames",
  "--no-abbrev",
  "--format=",
];

export interface RawEntry {
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
  /** A added, M modified, D deleted, T type change. */
  status: string;
  path: string;
}

/** True for the all-zero object id git uses for "no object on this side". */
export function isZeroSha(sha: string): boolean {
  return /^0+$/.test(sha);
}

/** Parse `git log --raw -z --format=` output: `:om nm os ns S` NUL path NUL, repeated. */
export function parseRawLog(text: string): RawEntry[] {
  const out: RawEntry[] = [];
  const tokens = text.split("\0");
  for (let i = 0; i < tokens.length; ) {
    const meta = (tokens[i] as string).replace(/^\n+/, "");
    if (meta === "") {
      i++;
      continue;
    }
    const path = tokens[i + 1];
    const f = meta.split(" ");
    if (!meta.startsWith(":") || path === undefined || f.length !== 5) {
      throw new GitScrubError("git-log-not-understood");
    }
    i += 2;
    out.push({
      oldMode: (f[0] as string).slice(1),
      newMode: f[1] as string,
      oldSha: f[2] as string,
      newSha: f[3] as string,
      status: f[4] as string,
      path,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Streaming `git cat-file`
// ---------------------------------------------------------------------------------------

export interface ObjectInfo {
  oid: string;
  type: string;
  size: number;
}

interface CatHandlers {
  /** `info` is null for a spec git reports as missing or ambiguous. */
  header(index: number, info: ObjectInfo | null): void;
  chunk?(index: number, chunk: Uint8Array): void;
  end?(index: number): void;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Feed object names to ONE `git cat-file` process and parse its answers as a stream, so a
 * large inline blob never has to be held whole. `mode` "batch" yields bodies, "check" only
 * headers. Answers come back in the order the names went in.
 */
export async function catBatch(
  repo: string,
  specs: string[],
  mode: "batch" | "check",
  on: CatHandlers,
): Promise<void> {
  if (specs.length === 0) return;
  const proc = Bun.spawn(
    ["git", "-C", repo, "cat-file", mode === "batch" ? "--batch" : "--batch-check"],
    {
      stdin: new TextEncoder().encode(`${specs.join("\n")}\n`) as Uint8Array,
      stdout: "pipe",
      stderr: "pipe",
      env: GIT_ENV,
    },
  );
  const errText = new Response(proc.stderr).text();
  let state: "header" | "body" | "newline" = "header";
  let carry: Uint8Array = new Uint8Array(0);
  let remaining = 0;
  let index = -1;
  let answers = 0;

  for await (const part of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
    let buf: Uint8Array = part;
    while (buf.length > 0) {
      if (state === "header") {
        const nl = buf.indexOf(10);
        if (nl < 0) {
          carry = concat(carry, buf);
          break;
        }
        const line = Buffer.from(concat(carry, buf.subarray(0, nl))).toString("utf8");
        carry = new Uint8Array(0);
        buf = buf.subarray(nl + 1);
        index++;
        answers++;
        const tokens = line.split(" ");
        const last = tokens[tokens.length - 1];
        if (last === "missing" || last === "ambiguous") {
          on.header(index, null);
          continue;
        }
        const [oid, type, size] = tokens as [string, string, string];
        on.header(index, { oid, type, size: Number(size) });
        if (mode === "check") continue;
        remaining = Number(size);
        state = remaining > 0 ? "body" : "newline";
      } else if (state === "body") {
        const take = Math.min(remaining, buf.length);
        on.chunk?.(index, buf.subarray(0, take));
        remaining -= take;
        buf = buf.subarray(take);
        if (remaining === 0) state = "newline";
      } else {
        buf = buf.subarray(1);
        on.end?.(index);
        state = "header";
      }
    }
  }
  const exitCode = await proc.exited;
  const err = await errText;
  if (exitCode !== 0 || answers !== specs.length) {
    throw new GitScrubError("git-command-failed", "git cat-file", err);
  }
}

/** The whole content of each spec, or null for a missing one. Small objects only. */
async function readObjects(repo: string, specs: string[]): Promise<(Buffer | null)[]> {
  const parts: Buffer[][] = specs.map(() => []);
  const present: boolean[] = specs.map(() => false);
  await catBatch(repo, specs, "batch", {
    header: (i, info) => {
      present[i] = info !== null;
    },
    chunk: (i, chunk) => {
      parts[i]?.push(Buffer.from(chunk));
    },
  });
  return specs.map((_s, i) => (present[i] ? Buffer.concat(parts[i] ?? []) : null));
}

// ---------------------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------------------

export interface RefSnapshot {
  commits: number;
  /** Paths of the tip tree, sorted. Names can identify, so this file is private. */
  tipPaths: string[];
}

export interface Snapshot {
  version: 1;
  refs: Record<string, RefSnapshot>;
  /** Tag name -> the type of the object the tag ref names ("tag" annotated, "commit" light). */
  tags: Record<string, string>;
  /** git-annex refs -> commit id: the rewrite must not move them. */
  annexRefs: Record<string, string>;
  /**
   * What the clone knew of `origin` before any rewrite, as the REMOTE names its refs: every head
   * (`refs/heads/<b>`, from `refs/remotes/origin/<b>`) and every tag (`refs/tags/<t>`, the object
   * the tag ref names, as `ls-remote` shows it). The switch refuses unless the remote still
   * holds exactly these (`remote-moved-since-clone`) and pushes with them as its leases, so a push
   * an uploader made after the clone is never erased by the force-push.
   */
  originTips: Record<string, string>;
}

async function tipPaths(repo: string, ref: string): Promise<string[]> {
  const out = await gitRaw(repo, ["ls-tree", "-r", "-z", "--name-only", `${ref}^{tree}`]);
  if (out.exitCode !== 0) throw new GitScrubError("git-command-failed", "git ls-tree", out.stderr);
  return out.stdout.toString("utf8").split("\0").filter(Boolean).sort();
}

/** True when filter-repo has already rewritten this clone (its commit map is there). */
async function alreadyRewritten(repo: string): Promise<boolean> {
  const gitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"])).trim();
  return existsSync(join(gitDir, "filter-repo", "commit-map"));
}

/**
 * Per ref: commit count and tip path list; the tag names; the git-annex refs; the origin tips the
 * clone knew. No contents. Refused in a clone the rewrite already ran in
 * (`refused: snapshot-after-rewrite`): its remote-tracking refs and tags are rewritten ones, so
 * they would say nothing about what the remote held, and the switch leases on them.
 */
export async function takeSnapshot(repo: string): Promise<Snapshot> {
  if (await alreadyRewritten(repo)) throw new GitScrubError("refused: snapshot-after-rewrite");
  const snapshot: Snapshot = { version: 1, refs: {}, tags: {}, annexRefs: {}, originTips: {} };
  for (const ref of await listRefs(repo)) {
    const remoteHead = /^refs\/remotes\/origin\/(.+)$/.exec(ref.name)?.[1];
    if (remoteHead !== undefined && remoteHead !== "HEAD") {
      snapshot.originTips[`refs/heads/${remoteHead}`] = ref.sha;
    }
    if (ref.name.startsWith("refs/tags/")) snapshot.originTips[ref.name] = ref.sha;
    if (isAnnexRef(ref.name)) {
      snapshot.annexRefs[ref.name] = ref.sha;
      continue;
    }
    if (!isRewriteRef(ref.name)) continue;
    const count = Number((await git(repo, ["rev-list", "--count", ref.name])).trim());
    snapshot.refs[ref.name] = { commits: count, tipPaths: await tipPaths(repo, ref.name) };
    if (ref.name.startsWith("refs/tags/")) {
      snapshot.tags[ref.name.slice("refs/tags/".length)] = ref.type;
    }
  }
  return snapshot;
}

/**
 * Write a file the scrub leaves in a working directory. A snapshot lists tip paths and a path can
 * be the identifier, so the file is owner-only, even over an existing file with looser modes.
 */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readSnapshot(path: string): Snapshot {
  const x = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  const isMap = (m: unknown) => typeof m === "object" && m !== null && !Array.isArray(m);
  if (
    x.version !== 1 ||
    !isMap(x.refs) ||
    !isMap(x.tags) ||
    !isMap(x.annexRefs) ||
    !isMap(x.originTips) ||
    !Object.entries(x.originTips).every(
      ([ref, sha]) => /^refs\/(heads|tags)\/./.test(ref) && /^[0-9a-f]{40,64}$/.test(String(sha)),
    )
  ) {
    throw new ContractError("snapshot does not match the contract");
  }
  return x;
}

// ---------------------------------------------------------------------------------------
// rewrite
// ---------------------------------------------------------------------------------------

export interface RewriteOptions {
  repo: string;
  keymapPath: string;
  planPath: string;
  /**
   * Optional, and never a way out of the check: the clone's origin must be
   * `nemarDatasets/<plan.dataset>` whether or not this is given, and a value given here must name
   * that same repository.
   */
  expectRemote?: string;
  refs?: string[];
  reportPath?: string;
}

export interface RewriteResult {
  counts: Record<string, number>;
  commitMap: string;
  reportPath: string;
}

/**
 * Rewrite a fresh clone. The python side refuses, before it changes anything, a clone that is not
 * fresh, whose origin is not `nemarDatasets/<plan.dataset>`, or whose history does not hold the
 * keymap (another dataset's); those arrive here as GitScrubError("refused: <word>").
 */
export async function rewriteHistory(opts: RewriteOptions): Promise<RewriteResult> {
  const { plan } = readInputs(opts.keymapPath, opts.planPath);
  // The target is derived from the plan, so omitting the flag cannot skip the check; a flag that
  // names anything else is a mistake worth stopping for.
  const remote = datasetRemote(plan.dataset);
  if (opts.expectRemote !== undefined && githubRepoOf(opts.expectRemote) !== githubRepoOf(remote)) {
    throw new GitScrubError("refused: expect-remote-mismatch");
  }
  const cmd = [
    "uv",
    "run",
    "--quiet",
    "--with",
    FILTER_REPO_REQUIREMENT,
    "python",
    REWRITE_SCRIPT,
    "--repo",
    opts.repo,
    "--keymap",
    opts.keymapPath,
    "--plan",
    opts.planPath,
  ];
  cmd.push("--expect-remote", remote);
  if (opts.reportPath) cmd.push("--report", opts.reportPath);
  if (opts.refs && opts.refs.length > 0) cmd.push("--refs", ...opts.refs);

  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: GIT_ENV });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    // The word is on stdout ("refused: ...", "bad-input: ...", "failed: ..."); stderr is
    // filter-repo's own output and may name a file, so it is kept for a developer only.
    throw new GitScrubError(
      stdout.trim().split("\n").pop() || "failed: no-output",
      "rewrite script",
      stderr,
    );
  }
  const line = stdout.trim().split("\n").pop() ?? "";
  const parsed = JSON.parse(line) as {
    counts: Record<string, number>;
    commitMap: string;
    reportPath: string;
  };
  return parsed;
}

// ---------------------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------------------

export type VerifyReason =
  | "refs-missing"
  | "tag-names-changed"
  | "tag-kind-changed"
  | "commit-count-changed"
  | "old-key-present"
  | "old-key-in-message"
  | "dropped-path-present"
  | "blank-key-not-empty"
  | "json-ops-not-applied"
  | "json-unparseable"
  | "append-missing"
  | "append-duplicated"
  | "tip-paths-mismatch"
  | "annex-branch-changed"
  | "edf-key-unaccounted"
  | "edf-path-not-a-pointer"
  | "provenance-unannotated"
  | "provenance-too-large"
  // fresh-clone mode only:
  | "tag-names-not-plan"
  | "allowed-tag-missing"
  | "ledger-commit-not-alone"
  | "ledger-invalid"
  | "annex-branch-missing"
  | "annex-old-key-held"
  | "annex-old-key-not-dead"
  | "annex-new-key-unregistered";

/** The one path a commit made after the rewrite may add, and the only one it may touch. */
export const LEDGER_PATH = ".nemar/corrections.jsonl";

/**
 * The provenance file of a dataset that mirrors upstream recordings under `sourcedata/`: a JSON
 * object whose top-level `files` array lists each mirrored file, with the `sha256` of the ORIGINAL
 * upstream file. Those checksums are kept as provenance (ADR 0085), so they are the one place an
 * old key's hash may remain, under the rule of {@link provenanceHashUse}.
 */
export const PROVENANCE_PATH = "sourcedata/sourcedata_provenance.json";

/** The top-level key whose sentence says the checksums describe the files before the correction. */
export const PROVENANCE_NOTE_KEY = "privacy_correction";

/**
 * `local`: the clone the rewrite ran in, compared with the snapshot taken before it.
 * `fresh-clone`: a new clone of the PUSHED repository; every invariant that does not depend on the
 * snapshot, plus the pushed `git-annex` branch (read from `refs/remotes/origin/git-annex`).
 */
export type VerifyMode = "local" | "fresh-clone";

export interface VerifyFailure {
  reason: VerifyReason;
  count: number;
}

export interface VerifyResult {
  ok: boolean;
  failures: VerifyFailure[];
  counts: Record<string, number>;
}

export interface VerifyOptions {
  repo: string;
  keymap: KeymapFile;
  plan: GitPlanFile;
  /** The S3 stage's plan: its clean keys, with the keymap's new keys, are the only EDF/BDF keys allowed. */
  s3Plan: PlanFile;
  /** Default `local`. */
  mode?: VerifyMode;
  /** The snapshot from before the rewrite: required in `local` mode, refused in `fresh-clone`. */
  before?: Snapshot;
  /**
   * Accept a plan path whose content in some commit is not UTF-8 JSON. Off by default: a
   * file the rewrite could not parse is a file whose named keys may still hold a value.
   */
  allowUnparseableJson?: boolean;
  /**
   * `fresh-clone` only: version tags (`vX.Y.Z[-pre]`) the repository may have although the S3
   * plan does not list them, because they were never a published version (no manifest in S3). The
   * allowance is for the tag NAME check alone: the tag's tree is scanned like every other ref's.
   * One the repository does not have is `allowed-tag-missing`.
   */
  allowTags?: readonly string[];
}

/**
 * Count the non-empty values of target keys in JSON text, at any depth, counting every
 * duplicate of a key (a parser that keeps the last duplicate would hide the others).
 * Returns null when the text is not UTF-8 JSON.
 */
export function nonEmptyTargetValues(raw: Uint8Array, targets: ReadonlySet<string>): number | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    JSON.parse(text);
  } catch {
    return null;
  }
  let bad = 0;
  const ws = (i: number): number => {
    let j = i;
    while (j < text.length && " \t\n\r".includes(text[j] as string)) j++;
    return j;
  };
  const str = (i: number): number => {
    let j = i + 1;
    while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    return j + 1;
  };
  const value = (i: number): number => {
    const c = text[i];
    if (c === "{") {
      let j = ws(i + 1);
      if (text[j] === "}") return j + 1;
      for (;;) {
        const keyEnd = str(j);
        const key = JSON.parse(text.slice(j, keyEnd)) as string;
        const start = ws(ws(keyEnd) + 1);
        const end = value(start);
        if (targets.has(canonicalKey(key)) && text.slice(start, end) !== '""') bad++;
        j = ws(end);
        if (text[j] === ",") {
          j = ws(j + 1);
          continue;
        }
        return j + 1;
      }
    }
    if (c === "[") {
      let j = ws(i + 1);
      if (text[j] === "]") return j + 1;
      for (;;) {
        j = ws(value(j));
        if (text[j] === ",") {
          j = ws(j + 1);
          continue;
        }
        return j + 1;
      }
    }
    if (c === '"') return str(i);
    let j = i;
    while (j < text.length && !",]} \t\n\r".includes(text[j] as string)) j++;
    return j;
  };
  try {
    value(ws(0));
  } catch {
    return null;
  }
  return bad;
}

/**
 * How many of the plan's structural edits a JSON object's current state contradicts: an array
 * entry that should have been dropped, a count or sum that does not match the array, a key that
 * is not the constant. Returns null when the text is not a UTF-8 JSON object or a sum cannot be
 * computed.
 */
export function jsonOpViolations(raw: Uint8Array, ops: readonly JsonOp[]): number | null {
  let obj: Record<string, unknown>;
  try {
    let text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  let bad = 0;
  for (const op of ops) {
    if (op.op === "set") {
      if (obj[op.key] !== op.value) bad++;
      continue;
    }
    const arr = obj[op.array];
    if (!Array.isArray(arr)) continue;
    if (op.op === "drop-array-entries") {
      for (const entry of arr as unknown[]) {
        const field = (entry as Record<string, unknown> | null)?.[op.matchField];
        if (typeof field === "string" && op.matchValues.includes(field)) bad++;
      }
      continue;
    }
    let sum = 0;
    for (const entry of arr as unknown[]) {
      const v = (entry as Record<string, unknown> | null)?.[op.sumField];
      if (typeof v !== "number") return null;
      sum += v;
    }
    if (op.countKey in obj && obj[op.countKey] !== arr.length) bad++;
    if (op.sumKey in obj && obj[op.sumKey] !== sum) bad++;
  }
  return bad;
}

function countOccurrences(haystack: Buffer, needle: Buffer): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return n;
    n++;
    from = at + needle.length;
  }
}

/**
 * Scans a stream of bytes for any of a set of 64-hex-digit tokens, across chunk borders.
 *
 * Every 64-digit window of every hex run is tried, in either letter case, so a hash that sits
 * inside a longer run of hex digits (a concatenation, a hex dump) is still found. The usual
 * case, a run of exactly 64, costs one set lookup.
 */
export class HashScanner {
  private tail = "";
  found = false;
  constructor(private readonly hashes: ReadonlySet<string>) {}
  push(chunk: Uint8Array): void {
    const window = this.tail + Buffer.from(chunk).toString("latin1");
    if (!this.found) {
      for (const m of window.matchAll(/[0-9a-fA-F]{64,}/g)) {
        const run = m[0].toLowerCase();
        for (let i = 0; i + 64 <= run.length; i++) {
          if (this.hashes.has(run.slice(i, i + 64))) {
            this.found = true;
            break;
          }
        }
        if (this.found) break;
      }
    }
    this.tail = window.slice(-63);
  }
}

/** What an old key's hash is doing in a provenance blob; see {@link provenanceHashUse}. */
export type ProvenanceUse =
  /** Every old hash is the `sha256` of a `files` entry, and the file says the checksums are upstream's. */
  | { use: "kept"; hashes: Set<string> }
  /** Every old hash is the `sha256` of a `files` entry, but nothing says the copies now differ. */
  | { use: "unannotated"; hashes: Set<string> }
  /** An old hash somewhere else in the file, or the file is not a UTF-8 JSON object. */
  | { use: "elsewhere" };

const SHA256_VALUE = /^"([0-9a-fA-F]{64})"$/;

/**
 * Where the old hashes in one blob of {@link PROVENANCE_PATH} sit.
 *
 * An old hash may stay only as the whole string value of a `sha256` member of an object in the
 * top-level `files` array, written without escapes. The blob is walked as text, so every
 * occurrence is placed, a duplicated key included; the bytes of those values are masked, and the
 * same scan `old-key-present` runs then reads the rest: a hash anywhere else (in another field, in
 * the note, nested deeper, as a key) makes the blob `elsewhere`. When nothing else holds one, the
 * blob is `kept` only if it carries a non-empty string {@link PROVENANCE_NOTE_KEY}, and
 * `unannotated` otherwise.
 */
export function provenanceHashUse(raw: Uint8Array, oldHashes: ReadonlySet<string>): ProvenanceUse {
  let text: string;
  let doc: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    doc = JSON.parse(text);
  } catch {
    return { use: "elsewhere" };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { use: "elsewhere" };

  // The text is valid JSON from here; the only way the walk can throw is nesting deeper than its
  // stack, which JSON.parse accepts (measured: 50,000 levels), and then nothing is placed.
  const ws = (i: number): number => {
    let j = i;
    while (j < text.length && " \t\n\r".includes(text[j] as string)) j++;
    return j;
  };
  const str = (i: number): number => {
    let j = i + 1;
    while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    return j + 1;
  };
  const members = (i: number, on: (key: string, at: number) => number): number => {
    let j = ws(i + 1);
    if (text[j] === "}") return j + 1;
    for (;;) {
      const keyEnd = str(j);
      const key = JSON.parse(text.slice(j, keyEnd)) as string;
      j = ws(on(key, ws(ws(keyEnd) + 1)));
      if (text[j] !== ",") return j + 1;
      j = ws(j + 1);
    }
  };
  const elements = (i: number, on: (at: number) => number): number => {
    let j = ws(i + 1);
    if (text[j] === "]") return j + 1;
    for (;;) {
      j = ws(on(j));
      if (text[j] !== ",") return j + 1;
      j = ws(j + 1);
    }
  };
  const skip = (i: number): number => {
    const c = text[i];
    if (c === "{") return members(i, (_key, at) => skip(at));
    if (c === "[") return elements(i, skip);
    if (c === '"') return str(i);
    let j = i;
    while (j < text.length && !",]} \t\n\r".includes(text[j] as string)) j++;
    return j;
  };

  const spans: [number, number][] = [];
  const kept = new Set<string>();
  try {
    members(ws(0), (key, at) => {
      if (key !== "files" || text[at] !== "[") return skip(at);
      return elements(at, (entry) => {
        if (text[entry] !== "{") return skip(entry);
        return members(entry, (field, value) => {
          const end = skip(value);
          if (field !== "sha256") return end;
          const hash = SHA256_VALUE.exec(text.slice(value, end))?.[1]?.toLowerCase();
          if (hash !== undefined && oldHashes.has(hash)) {
            spans.push([value + 1, end - 1]);
            kept.add(hash);
          }
          return end;
        });
      });
    });
  } catch {
    return { use: "elsewhere" };
  }

  let rest = "";
  let from = 0;
  for (const [a, b] of spans) {
    rest += `${text.slice(from, a)}${"-".repeat(b - a)}`;
    from = b;
  }
  rest += text.slice(from);
  const scanner = new HashScanner(oldHashes);
  scanner.push(Buffer.from(rest, "utf8"));
  if (scanner.found || kept.size === 0) return { use: "elsewhere" };
  const note = (doc as Record<string, unknown>)[PROVENANCE_NOTE_KEY];
  return typeof note === "string" && note.trim() !== ""
    ? { use: "kept", hashes: kept }
    : { use: "unannotated", hashes: kept };
}

function setDiffSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const x of a) if (!b.has(x)) n++;
  for (const x of b) if (!a.has(x)) n++;
  return n;
}

const EDF_PATH = /\.(edf|bdf)$/i;
/** Regular files and symlinks: the modes an annex pointer or an annexed link can have. */
const POINTER_MODES = new Set(["100644", "100755", "120000"]);
/** A pointer file or a symlink target is a line long; a bigger blob at an EDF path is content. */
const POINTER_MAX_BYTES = 1024;
/** The modes a provenance blob may have to keep its checksums: a regular file, never a symlink. */
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

/**
 * The largest provenance blob verify reads whole to place its old hashes: 16 MiB, about 100,000
 * `files` entries (one is about 150 bytes), where a mirror of a few hundred recordings is tens of
 * KiB. A bigger blob is not read, and its old hashes are `provenance-too-large`.
 */
export const PROVENANCE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The key an annex pointer file (`/annex/objects/KEY`) or an annex symlink target
 * (`.../annex/objects/xx/yy/KEY/KEY`) names, or null when the content is neither.
 */
export function annexKeyOfBlob(content: Uint8Array): string | null {
  const text = Buffer.from(content).toString("latin1");
  const prefix = "/annex/objects/";
  let key: string | undefined;
  if (text.startsWith(prefix)) key = text.slice(prefix.length).split(/\s/)[0];
  else if (text.includes(prefix)) key = text.trim().split("/").pop();
  return key ? key : null;
}

/**
 * Prove a rewrite, over EVERY ref and EVERY commit, using plain git only.
 *
 * In both modes:
 * - no object reachable from any non-git-annex ref holds an old key's sha256 (every blob,
 *   plus commit and annotated-tag messages), not only the tips; the one exception is the
 *   upstream checksums of {@link PROVENANCE_PATH} (ADR 0085): a blob that is that file as a
 *   regular file (`100644` or `100755`), and nothing else, in every commit of every ref and every
 *   tree a ref names, where every old hash is a `sha256` of a `files` entry
 *   ({@link provenanceHashUse}), is not a hit when it carries {@link PROVENANCE_NOTE_KEY}, and is
 *   `provenance-unannotated` when it does not; one over {@link PROVENANCE_MAX_BYTES} is not read
 *   and is `provenance-too-large`. The hashes kept are counted (`provenanceHashesKept`, distinct,
 *   and `provenanceBlobsKept`). The exception is off while any ref names a blob, or anything but
 *   a commit or a tree, because such a blob has no path to check;
 * - no dropped path in any commit's tree;
 * - every blanked key is empty in every commit that has the file, and every structural edit holds;
 * - the appended text is in every commit exactly once, at the end of the file;
 * - every EDF or BDF path, in every commit of every ref, is an annex pointer or link whose key
 *   is a NEW key of the keymap or a key the S3 plan marked clean: no key goes unaccounted for.
 *
 * `local` mode, against the snapshot taken before the rewrite:
 * - every ref keeps its commit count and every tag its name and kind;
 * - each ref's tip paths equal the snapshot's, minus dropped, plus appended;
 * - the git-annex branch is where it was.
 *
 * `fresh-clone` mode, against the plans and the pushed git-annex branch instead:
 * - the tag names are the S3 plan's tags, plus the names `allowTags` accepts (by name, for the
 *   name check only; an accepted name the repository lacks is `allowed-tag-missing`);
 * - a commit that touches {@link LEDGER_PATH} touches nothing else, and the ledger at every head
 *   tip is a valid ledger of this dataset (the ledger commit on top of the rewrite is the one
 *   extra path and the only extra commits it tolerates; nothing else is compared with a before);
 * - in `refs/remotes/origin/git-annex`: no repository holds an old key, every old key is dead,
 *   and every new key is recorded present somewhere.
 */
export async function verifyRewrite(opts: VerifyOptions): Promise<VerifyResult> {
  const { repo, keymap, plan, s3Plan } = opts;
  const mode = opts.mode ?? "local";
  // A plan from another dataset would vouch for keys that are not this repository's.
  if (s3Plan.dataset !== plan.dataset) throw new GitScrubError("refused: s3-plan-dataset-mismatch");
  if (mode === "local" && !opts.before) throw new GitScrubError("refused: before-required");
  if (mode === "fresh-clone" && opts.before) {
    throw new GitScrubError("refused: before-not-for-fresh-clone");
  }
  // A name the git plan would not accept is no tag of this scrub, and the local comparison is
  // against the snapshot, where an allowance would mean nothing: refuse both, never ignore them.
  const allowTags = new Set(opts.allowTags ?? []);
  if (allowTags.size > 0 && mode !== "fresh-clone") {
    throw new GitScrubError("refused: allow-tag-not-for-local");
  }
  if ([...allowTags].some((t) => !VERSION_TAG.test(t))) {
    throw new GitScrubError("bad-input: allow-tag-not-semver");
  }
  const failures: VerifyFailure[] = [];
  const counts: Record<string, number> = {};
  const fail = (reason: VerifyReason, count: number): void => {
    if (count > 0) failures.push({ reason, count });
  };

  const refs = await listRefs(repo);
  const byName = new Map(refs.map((r) => [r.name, r]));
  const scanRefs = refs.filter((r) => !isAnnexRef(r.name)).map((r) => r.name);
  if (scanRefs.length === 0) throw new GitScrubError("no-refs");
  const nowTags = new Set(
    refs.filter((r) => r.name.startsWith("refs/tags/")).map((r) => r.name.slice(10)),
  );

  // Refs, tags, commit counts.
  const before = opts.before;
  const beforeRefs = before ? Object.keys(before.refs) : [];
  if (before) {
    fail("refs-missing", beforeRefs.filter((r) => !byName.has(r)).length);
    fail("tag-names-changed", setDiffSize(nowTags, new Set(Object.keys(before.tags))));
    let kindChanges = 0;
    for (const [name, type] of Object.entries(before.tags)) {
      const now = byName.get(`refs/tags/${name}`);
      if (now && now.type !== type) kindChanges++;
    }
    fail("tag-kind-changed", kindChanges);
    let countChanges = 0;
    for (const ref of beforeRefs) {
      if (!byName.has(ref)) continue;
      const n = Number((await git(repo, ["rev-list", "--count", ref])).trim());
      if (n !== before.refs[ref]?.commits) countChanges++;
    }
    fail("commit-count-changed", countChanges);
    counts.refs = beforeRefs.length;
  } else {
    // An allowed name the repository has is expected; one it lacks is its own failure, so the
    // name check is not also charged for it.
    const expected = new Set(s3Plan.tags);
    for (const t of allowTags) if (nowTags.has(t)) expected.add(t);
    fail("tag-names-not-plan", setDiffSize(nowTags, expected));
    fail("allowed-tag-missing", [...allowTags].filter((t) => !nowTags.has(t)).length);
    counts.refs = scanRefs.length;
  }

  // Every entry of every commit of every ref, in one walk: the EDF/BDF check below reads it, and
  // so does the provenance exception, which needs EVERY path a blob has in any commit; the one
  // path `rev-list --objects` prints for a blob is only the first it met, and is one of these.
  const rawEntries = parseRawLog(await git(repo, RAW_LOG_ARGS, `${scanRefs.join("\n")}\n`));
  /** Every place a blob is, as `<mode> <path>`: in any commit, and in any tree a ref names. */
  const blobPlaces = new Map<string, Set<string>>();
  const place = (oid: string, mode: string, path: string): void => {
    const places = blobPlaces.get(oid) ?? new Set<string>();
    places.add(`${mode} ${path}`);
    blobPlaces.set(oid, places);
  };
  for (const e of rawEntries) if (!isZeroSha(e.newSha)) place(e.newSha, e.newMode, e.path);
  // A ref to a tree (git-annex's `refs/annex/last-index` is one) names its blobs under the
  // tree's own paths, which the commit walk never sees, so they are listed too. A ref to a blob,
  // or to anything but a commit or a tree, gives its blob no path at all: then nothing is exempt.
  const peeled: { ref: string; type: string }[] = [];
  await catBatch(
    repo,
    scanRefs.map((r) => `${r}^{}`),
    "check",
    {
      header: (i, info) =>
        peeled.push({ ref: scanRefs[i] as string, type: info?.type ?? "missing" }),
    },
  );
  let exemptionOn = true;
  for (const { ref, type } of peeled) {
    if (type === "commit") continue;
    if (type !== "tree") {
      exemptionOn = false;
      continue;
    }
    const listing = await gitRaw(repo, ["ls-tree", "-r", "-z", "--full-tree", `${ref}^{}`]);
    if (listing.exitCode !== 0) {
      throw new GitScrubError("git-command-failed", "git ls-tree", listing.stderr);
    }
    for (const entry of listing.stdout.toString("utf8").split("\0")) {
      const tab = entry.indexOf("\t");
      const [mode, kind, oid] = entry.slice(0, tab).split(" ");
      if (tab > 0 && kind === "blob" && mode && oid) place(oid, mode, entry.slice(tab + 1));
    }
  }

  // Old keys in every object reachable from any non-annex ref.
  const oldHashes = new Set(Object.keys(keymap).map((k) => parseKey(k).sha256));
  const objects = (await git(repo, ["rev-list", "--objects", ...scanRefs]))
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ")[0] as string);
  /** A blob that is the provenance file as a regular file, and nothing else, wherever it is. */
  const onlyProvenance = (oid: string): boolean => {
    const places = blobPlaces.get(oid);
    if (!exemptionOn || places === undefined || places.size === 0) return false;
    return [...places].every((p) => {
      const space = p.indexOf(" ");
      return REGULAR_FILE_MODES.has(p.slice(0, space)) && p.slice(space + 1) === PROVENANCE_PATH;
    });
  };
  let blobHits = 0;
  let messageHits = 0;
  let blobsScanned = 0;
  const provenanceHits: string[] = [];
  let provenanceTooLarge = 0;
  const scanners = new Map<number, HashScanner>();
  const kinds = new Map<number, string>();
  const sizes = new Map<number, number>();
  await catBatch(repo, objects, "batch", {
    header: (i, info) => {
      if (info && (info.type === "blob" || info.type === "commit" || info.type === "tag")) {
        kinds.set(i, info.type);
        sizes.set(i, info.size);
        scanners.set(i, new HashScanner(oldHashes));
        if (info.type === "blob") blobsScanned++;
      }
    },
    chunk: (i, chunk) => scanners.get(i)?.push(chunk),
    end: (i) => {
      const scanner = scanners.get(i);
      const kind = kinds.get(i);
      const size = sizes.get(i) ?? 0;
      scanners.delete(i);
      kinds.delete(i);
      sizes.delete(i);
      if (!scanner?.found) return;
      if (kind !== "blob") messageHits++;
      else if (!onlyProvenance(objects[i] as string)) blobHits++;
      else if (size > PROVENANCE_MAX_BYTES) provenanceTooLarge++;
      else provenanceHits.push(objects[i] as string);
    },
  });
  // The upstream checksums a provenance file keeps (ADR 0085): only where the rule allows them.
  let unannotated = 0;
  let provenanceBlobsKept = 0;
  const provenanceHashesKept = new Set<string>();
  for (const content of await readObjects(repo, provenanceHits)) {
    const verdict: ProvenanceUse = content
      ? provenanceHashUse(content, oldHashes)
      : { use: "elsewhere" };
    if (verdict.use === "elsewhere") blobHits++;
    else if (verdict.use === "unannotated") unannotated++;
    else {
      provenanceBlobsKept++;
      for (const hash of verdict.hashes) provenanceHashesKept.add(hash);
    }
  }
  fail("old-key-present", blobHits);
  fail("old-key-in-message", messageHits);
  fail("provenance-unannotated", unannotated);
  fail("provenance-too-large", provenanceTooLarge);
  counts.objectsScanned = objects.length;
  counts.blobsScanned = blobsScanned;
  counts.provenanceHashesKept = provenanceHashesKept.size;
  counts.provenanceBlobsKept = provenanceBlobsKept;

  // Per commit: dropped paths, blanked keys, appended text.
  const commits = (await git(repo, ["rev-list", ...scanRefs])).split("\n").filter(Boolean);
  counts.commits = commits.length;
  const perCommitSpecs = (paths: string[]): string[] =>
    commits.flatMap((c) => paths.map((p) => `${c}:${p}`));

  let dropHits = 0;
  await catBatch(repo, perCommitSpecs(plan.dropPaths), "check", {
    header: (_i, info) => {
      if (info) dropHits++;
    },
  });
  fail("dropped-path-present", dropHits);

  const blankPaths = Object.keys(plan.blankJsonKeys);
  const blankSpecs = perCommitSpecs(blankPaths);
  const blankContents = await readObjects(repo, blankSpecs);
  const targets = blankPaths.map((p) => new Set((plan.blankJsonKeys[p] ?? []).map(canonicalKey)));
  let notEmpty = 0;
  let unparseable = 0;
  let jsonChecked = 0;
  blankContents.forEach((content, i) => {
    if (!content) return;
    const result = nonEmptyTargetValues(content, targets[i % blankPaths.length] as Set<string>);
    jsonChecked++;
    if (result === null) unparseable++;
    else notEmpty += result;
  });
  fail("blank-key-not-empty", notEmpty);

  const opPaths = Object.keys(plan.jsonOps ?? {});
  let opViolations = 0;
  if (opPaths.length > 0) {
    const opContents = await readObjects(repo, perCommitSpecs(opPaths));
    opContents.forEach((content, i) => {
      if (!content) return;
      const ops = plan.jsonOps?.[opPaths[i % opPaths.length] as string] ?? [];
      const result = jsonOpViolations(content, ops);
      jsonChecked++;
      if (result === null) unparseable++;
      else opViolations += result;
    });
  }
  fail("json-ops-not-applied", opViolations);

  if (!opts.allowUnparseableJson) fail("json-unparseable", unparseable);
  counts.jsonChecked = jsonChecked;
  counts.jsonUnparseable = unparseable;

  const appendPaths = Object.keys(plan.appendText);
  const appendContents = await readObjects(repo, perCommitSpecs(appendPaths));
  let appendMissing = 0;
  let appendDuplicated = 0;
  appendContents.forEach((content, i) => {
    const text = Buffer.from(plan.appendText[appendPaths[i % appendPaths.length] as string] ?? "");
    if (!content) {
      appendMissing++;
      return;
    }
    const n = countOccurrences(content, text);
    if (n === 0 || !content.subarray(content.length - text.length).equals(text)) appendMissing++;
    else if (n > 1) appendDuplicated++;
  });
  fail("append-missing", appendMissing);
  fail("append-duplicated", appendDuplicated);

  // Tip paths.
  if (before) {
    const dropped = new Set(plan.dropPaths);
    let pathDiffs = 0;
    for (const ref of beforeRefs) {
      if (!byName.has(ref)) continue;
      const expected = new Set((before.refs[ref]?.tipPaths ?? []).filter((p) => !dropped.has(p)));
      for (const p of appendPaths) expected.add(p);
      pathDiffs += setDiffSize(expected, new Set(await tipPaths(repo, ref)));
    }
    fail("tip-paths-mismatch", pathDiffs);
  }

  // Every EDF/BDF key in every commit of every ref is accounted for. A key counts when it is a
  // NEW key, or the S3 plan READ its header and found nothing to scrub; an old key, a key the
  // plan never saw and one it could not read all fail, and so does an EDF path that is content.
  const accounted = new Set([
    ...Object.values(keymap),
    ...s3Plan.keys.filter((k) => !k.needsScrub && k.status === "read").map((k) => k.oldKey),
  ]);
  const edfBlobs = new Set<string>();
  for (const e of rawEntries) {
    if (!EDF_PATH.test(e.path) || isZeroSha(e.newSha)) continue;
    if (e.status !== "D" && POINTER_MODES.has(e.newMode)) edfBlobs.add(e.newSha);
  }
  const edfShas = [...edfBlobs];
  const edfSizes: (number | null)[] = [];
  await catBatch(repo, edfShas, "check", {
    header: (i, info) => edfSizes.push(info?.size ?? null),
  });
  const pointerShas = edfShas.filter(
    (_sha, i) => (edfSizes[i] ?? Number.POSITIVE_INFINITY) <= POINTER_MAX_BYTES,
  );
  const edfKeys = new Set<string>();
  let notPointers = edfShas.length - pointerShas.length;
  for (const content of await readObjects(repo, pointerShas)) {
    const key = content ? annexKeyOfBlob(content) : null;
    if (key === null) notPointers++;
    else edfKeys.add(key);
  }
  fail("edf-path-not-a-pointer", notPointers);
  fail("edf-key-unaccounted", [...edfKeys].filter((k) => !accounted.has(k)).length);
  counts.edfKeys = edfKeys.size;

  if (before) {
    // The git-annex branch is not ours to move.
    let annexMoved = 0;
    for (const [name, sha] of Object.entries(before.annexRefs)) {
      if (byName.get(name)?.sha !== sha) annexMoved++;
    }
    fail("annex-branch-changed", annexMoved);
  } else {
    const ledger = await ledgerChecks(repo, scanRefs, plan.dataset);
    fail("ledger-commit-not-alone", ledger.notAlone);
    fail("ledger-invalid", ledger.invalid);
    counts.ledgerCommits = ledger.commits;
    const annexRef = "refs/remotes/origin/git-annex";
    if (!byName.has(annexRef)) {
      fail("annex-branch-missing", 1);
    } else {
      const pushed = await pushedRegistration(repo, annexRef, keymap);
      fail("annex-old-key-held", pushed.oldHeld);
      fail("annex-old-key-not-dead", pushed.oldNotDead);
      fail("annex-new-key-unregistered", pushed.newUnregistered);
    }
  }

  return { ok: failures.length === 0, failures, counts };
}

/**
 * The commits that touch {@link LEDGER_PATH}: how many there are, how many touch anything else
 * too, and at how many head tips the ledger is not a valid ledger of `dataset`.
 */
async function ledgerChecks(
  repo: string,
  scanRefs: string[],
  dataset: string,
): Promise<{ commits: number; notAlone: number; invalid: number }> {
  const out = await git(
    repo,
    ["log", "--stdin", "--no-renames", "--format=%x00%H", "--name-only", "-m", "--first-parent"],
    `${scanRefs.join("\n")}\n`,
  );
  let commits = 0;
  let notAlone = 0;
  const seen = new Set<string>();
  for (const block of out.split("\0").slice(1)) {
    const [sha, ...rest] = block.split("\n");
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);
    const paths = rest.filter((p) => p !== "");
    if (!paths.includes(LEDGER_PATH)) continue;
    commits++;
    if (paths.some((p) => p !== LEDGER_PATH)) notAlone++;
  }
  let invalid = 0;
  for (const ref of scanRefs.filter(
    (r) => r.startsWith("refs/heads/") || r.startsWith("refs/remotes/"),
  )) {
    const r = await gitRaw(repo, ["cat-file", "blob", `${ref}:${LEDGER_PATH}`]);
    if (r.exitCode !== 0) continue; // no ledger at this tip
    try {
      const lines = r.stdout
        .toString("utf8")
        .split("\n")
        .filter((l) => l.trim() !== "");
      for (const line of lines) {
        const entry = validateLedgerEntry(JSON.parse(line) as LedgerEntry);
        if (entry.dataset !== dataset) throw new Error("other dataset");
      }
    } catch {
      invalid++;
    }
  }
  return { commits, notAlone, invalid };
}

/** git-annex's `hashdirlower` for a key: the `abc/def/` its location log lives under. */
export function hashDirLower(key: string): string {
  const h = createHash("md5").update(key).digest("hex");
  return `${h.slice(0, 3)}/${h.slice(3, 6)}/`;
}

/**
 * What the PUSHED git-annex branch says about the keymap: old keys some repository still holds,
 * old keys not marked dead, and new keys no repository is recorded holding. Read from the ref
 * itself with plain git (no journal exists in a fresh clone, and nothing is merged).
 */
async function pushedRegistration(
  repo: string,
  annexRef: string,
  keymap: KeymapFile,
): Promise<{ oldHeld: number; oldNotDead: number; newUnregistered: number }> {
  const oldKeys = [...new Set(Object.keys(keymap))];
  const newKeys = [...new Set(Object.values(keymap))];
  const logs = await readObjects(
    repo,
    [...oldKeys, ...newKeys].map((k) => `${annexRef}:${hashDirLower(k)}${k}.log`),
  );
  const text = (i: number) => logs[i]?.toString("utf8") ?? "";
  let oldHeld = 0;
  let oldNotDead = 0;
  oldKeys.forEach((_k, i) => {
    if (presentIn(text(i)).size > 0) oldHeld++;
    else if (!isDead(text(i))) oldNotDead++;
  });
  let newUnregistered = 0;
  newKeys.forEach((_k, j) => {
    if (presentIn(text(oldKeys.length + j)).size === 0) newUnregistered++;
  });
  return { oldHeld, oldNotDead, newUnregistered };
}

// ---------------------------------------------------------------------------------------
// annex-registry
// ---------------------------------------------------------------------------------------

export interface AnnexRegistryOptions {
  repo: string;
  keymap: KeymapFile;
  /**
   * The only repositories a NEW key is recorded present at (the S3 special remote). Empty: the
   * uuid of the special remote named {@link S3_REMOTE_NAME} in this clone's `remote.log`. Every
   * uuid, given or derived, must be a special remote of THIS clone (`remote-uuid-unknown`):
   * `initremote` gives each repository's remote its own uuid, so one pasted from another dataset
   * would record the new keys at a remote this repository does not have.
   */
  remoteUuids: string[];
  execute: boolean;
}

/** The name NEMAR's S3 special remote has in every dataset repository (`buildS3RemoteArgs`). */
export const S3_REMOTE_NAME = "nemar-s3";

/**
 * The special remotes `git-annex:remote.log` records, uuid -> name (the newest line per uuid).
 * Read the way `resolveRemoteUuid` (src/lib/fleet-key-registration.ts) reads it: `name=` as an
 * exact field, never a substring, because `nemar-s3` and `nemar-s3-dev` sit side by side.
 */
export async function remoteLogNames(repo: string): Promise<Map<string, string>> {
  const r = await gitRaw(repo, ["cat-file", "blob", "git-annex:remote.log"]);
  const names = new Map<string, { at: number; name: string }>();
  if (r.exitCode !== 0) return new Map();
  for (const line of r.stdout.toString("utf8").split("\n")) {
    const fields = line.trim().split(/\s+/);
    const uuid = fields[0];
    if (!uuid || !UUID.test(uuid)) continue;
    const name = fields.find((f) => f.startsWith("name="))?.slice("name=".length) ?? "";
    const stamp = fields.find((f) => f.startsWith("timestamp="))?.slice("timestamp=".length) ?? "0";
    const at = Number.parseFloat(stamp);
    const prior = names.get(uuid);
    if (!prior || at >= prior.at) names.set(uuid, { at: Number.isFinite(at) ? at : 0, name });
  }
  return new Map([...names].map(([uuid, v]) => [uuid, v.name]));
}

/**
 * The uuids an annex-registry run records new keys at: the ones given, or the one special remote
 * named {@link S3_REMOTE_NAME} (from `remote.log`, else `git config remote.nemar-s3.annex-uuid`).
 * Every one must be a special remote in this clone's `remote.log`.
 */
export async function resolveRegistryUuids(repo: string, given: string[]): Promise<string[]> {
  const known = await remoteLogNames(repo);
  let uuids = given;
  if (uuids.length === 0) {
    const named = [...known].filter(([, name]) => name === S3_REMOTE_NAME).map(([u]) => u);
    if (named.length > 1) throw new GitScrubError("refused: remote-uuid-ambiguous");
    if (named.length === 1) uuids = named;
    else {
      const r = await gitRaw(repo, ["config", "--get", `remote.${S3_REMOTE_NAME}.annex-uuid`]);
      const fromConfig = r.exitCode === 0 ? r.stdout.toString("utf8").trim() : "";
      if (!fromConfig) throw new GitScrubError("refused: no-nemar-s3-remote");
      uuids = [fromConfig];
    }
  }
  if (!uuids.every((u) => UUID.test(u))) throw new ContractError("remote uuid is not a uuid");
  if (!uuids.every((u) => known.has(u))) throw new GitScrubError("refused: remote-uuid-unknown");
  return uuids;
}

export interface AnnexRegistryResult {
  executed: boolean;
  oldKeys: number;
  newKeys: number;
  /**
   * (old key, repository) pairs the location log records as present. In a dry run these are
   * the retractions that would be made; after `execute`, the ones that were.
   */
  holders: number;
  /** (new key, named remote) pairs not yet recorded present: to record, or recorded. */
  newToRegister: number;
  /** After `execute` only, from the log read back. All zero in a dry run. */
  oldStillHeld: number;
  oldDead: number;
  newPresent: number;
  /** (new key, repository) pairs present at a repository that was NOT named. Must be 0. */
  newForeignHolders: number;
  /**
   * Old keys `git annex dead` refused. It refuses while any repository still records the key,
   * and `--force` does not lift that; retracting every holder first is what avoids it.
   */
  deadRefused: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function annex(repo: string, args: string[], stdin?: string): Promise<GitResult> {
  return gitRaw(repo, ["annex", ...args], stdin);
}

/** The newest `status uuid` pair per uuid in a location log's text. */
function newestStatuses(log: string): Map<string, string> {
  const newest = new Map<string, { at: number; status: string }>();
  for (const line of log.split("\n")) {
    const m = /^(\d+(?:\.\d+)?)s (\S+) (\S+)/.exec(line);
    if (!m) continue;
    const at = Number(m[1]);
    const prior = newest.get(m[3] as string);
    if (!prior || at >= prior.at) newest.set(m[3] as string, { at, status: m[2] as string });
  }
  return new Map([...newest].map(([uuid, v]) => [uuid, v.status]));
}

/** Location-log text for each key, read from the git-annex branch; "" when there is none. */
async function locationLogs(repo: string, keys: string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const paths = await annex(
    repo,
    ["examinekey", "--batch", "--format=${hashdirlower}${key}.log\\n"],
    `${keys.join("\n")}\n`,
  );
  if (paths.exitCode !== 0) {
    throw new GitScrubError("annex-command-failed", "annex examinekey", paths.stderr);
  }
  const lines = paths.stdout.toString("utf8").split("\n").filter(Boolean);
  if (lines.length !== keys.length)
    throw new GitScrubError("annex-command-failed", "annex examinekey");
  const contents = await readObjects(
    repo,
    lines.map((p) => `git-annex:${p}`),
  );
  return contents.map((c) => (c ? c.toString("utf8") : ""));
}

/** The uuids git-annex itself says hold each key (trusted and untrusted), by key. */
async function whereisHolders(repo: string, keys: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (keys.length === 0) return out;
  // `whereis` exits 1 for a key with no copies, so its JSON is read, never its exit code. It
  // also reads the journal, which a raw read of the git-annex branch does not see, and it
  // merges remote git-annex branches first, as every git-annex command does.
  const r = await annex(repo, ["whereis", "--batch-keys", "--json"], `${keys.join("\n")}\n`);
  for (const line of r.stdout.toString("utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    const j = JSON.parse(line) as {
      key: string;
      whereis?: { uuid: string }[];
      untrusted?: { uuid: string }[];
    };
    out.set(j.key, new Set([...(j.whereis ?? []), ...(j.untrusted ?? [])].map((w) => w.uuid)));
  }
  // A run that answered for fewer keys than it was asked about did not answer: "no holders"
  // for a key it never examined is the dangerous reading.
  if (!keys.every((k) => out.has(k))) {
    throw new GitScrubError("annex-command-failed", "annex whereis", r.stderr);
  }
  return out;
}

function presentIn(log: string): Set<string> {
  return new Set([...newestStatuses(log)].filter(([, status]) => status === "1").map(([u]) => u));
}

/** Dead: some repository's newest line is `X` and none is present. */
function isDead(log: string): boolean {
  const statuses = [...newestStatuses(log).values()];
  return statuses.includes("X") && !statuses.includes("1");
}

/**
 * Retire the old keys everywhere and register the new keys at the named remote(s) only, in a
 * clone with git-annex initialized. A dry run (the default) only counts.
 *
 * For every OLD key it finds every repository the location log records as present (the S3
 * remote and any uploader's own clone alike), retracts each, and only then marks the key dead:
 * git-annex refuses `dead` while any holder remains. For every NEW key it records presence at
 * the `remoteUuids` and nowhere else. It writes only what is missing, so a second run changes
 * nothing.
 *
 * A keymap this repository does not hold is refused up front (`old-key-unknown`): an old key with
 * no location log and no holder was never recorded here, which is another dataset's keymap and
 * not a key that is already dead (a dead key keeps its log).
 *
 * One `setpresentkey --batch` process per direction, never one per key: parallel writers lose
 * each other's updates in the git-annex journal. `dead` runs one key at a time for the same
 * reason. The result is read back (holders from `whereis`, which sees the journal; death from
 * the location log, which `dead` commits), and an exit code is not evidence.
 */
export async function annexRegistry(opts: AnnexRegistryOptions): Promise<AnnexRegistryResult> {
  const { repo, keymap } = opts;
  if (!opts.remoteUuids.every((u) => UUID.test(u))) {
    throw new ContractError("remote uuid is not a uuid");
  }
  for (const [a, b] of Object.entries(keymap)) {
    if (!ANNEX_KEY.test(a) || !ANNEX_KEY.test(b)) throw new ContractError("keymap holds a bad key");
  }
  const own = await git(repo, ["config", "--get", "annex.uuid"]).catch(() => "");
  if (!own.trim()) throw new GitScrubError("refused: annex-not-initialized");
  const remoteUuids = await resolveRegistryUuids(repo, opts.remoteUuids);

  const named = new Set(remoteUuids);
  const oldKeys = [...new Set(Object.keys(keymap))];
  const newKeys = [...new Set(Object.values(keymap))];

  // What the log says now. `whereis` first: it merges remote git-annex branches, so the raw
  // logs read after it are current. Holders are the union of both views, which also catches a
  // repository marked dead-trust that `whereis` leaves out and that still blocks `dead`.
  const asked = await whereisHolders(repo, [...oldKeys, ...newKeys]);
  const oldLogs = await locationLogs(repo, oldKeys);
  const holdersOf = oldKeys.map((k, i) => [
    ...new Set([...(asked.get(k) ?? []), ...presentIn(oldLogs[i] ?? "")]),
  ]);
  // A key this repository has no location log for, and no holder of, was never recorded here:
  // another dataset's keymap, not a key that is already dead. A dead key keeps its log.
  if (oldKeys.some((_k, i) => (oldLogs[i] ?? "") === "" && (holdersOf[i] ?? []).length === 0)) {
    throw new GitScrubError("refused: old-key-unknown");
  }
  const retractions = oldKeys.flatMap((k, i) => (holdersOf[i] ?? []).map((u) => `${k} ${u} 0`));
  const registrations = newKeys.flatMap((k) =>
    remoteUuids.filter((u) => !asked.get(k)?.has(u)).map((u) => `${k} ${u} 1`),
  );
  const result: AnnexRegistryResult = {
    executed: opts.execute,
    oldKeys: oldKeys.length,
    newKeys: newKeys.length,
    holders: retractions.length,
    newToRegister: registrations.length,
    oldStillHeld: 0,
    oldDead: 0,
    newPresent: 0,
    newForeignHolders: 0,
    deadRefused: 0,
  };
  if (!opts.execute) return result;

  const batch = async (lines: string[]): Promise<void> => {
    if (lines.length === 0) return;
    const r = await annex(repo, ["setpresentkey", "--batch"], `${lines.join("\n")}\n`);
    if (r.exitCode !== 0) {
      throw new GitScrubError("annex-command-failed", "annex setpresentkey", r.stderr);
    }
  };
  await batch(registrations);
  await batch(retractions);
  for (let i = 0; i < oldKeys.length; i++) {
    const log = oldLogs[i] ?? "";
    if (isDead(log) && (holdersOf[i] ?? []).length === 0) continue;
    const r = await annex(repo, ["dead", "--quiet", "--key", oldKeys[i] as string]);
    // A refusal is counted, not thrown: the other keys still need their turn, and the
    // read-back below is what says how many are dead.
    if (r.exitCode !== 0) result.deadRefused++;
  }

  const after = await whereisHolders(repo, [...oldKeys, ...newKeys]);
  const afterLogs = await locationLogs(repo, oldKeys);
  oldKeys.forEach((k, i) => {
    const log = afterLogs[i] ?? "";
    const held = (after.get(k)?.size ?? 0) > 0 || presentIn(log).size > 0;
    if (held) result.oldStillHeld++;
    else if (isDead(log)) result.oldDead++;
  });
  for (const k of newKeys) {
    const holders = after.get(k) ?? new Set<string>();
    if (remoteUuids.every((u) => holders.has(u))) result.newPresent++;
    result.newForeignHolders += [...holders].filter((u) => !named.has(u)).length;
  }
  return result;
}
