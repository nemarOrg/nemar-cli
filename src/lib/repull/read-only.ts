/**
 * The re-pull planner's guarded ways out of the process (ADR 0111, epic #1046 phase 5; the
 * amendment for #1911).
 *
 * `nemar admin repull plan` writes nothing to GitHub, S3, D1 or the NEMAR API. That is enforced
 * here rather than promised by each caller, for the calls that could write:
 *
 * - every git subprocess the planner starts goes through {@link readOnlyGit}, including the
 *   git-annex branch reads (`readLocationLogsAt` takes this runner), and each subcommand may carry
 *   only the options listed in {@link GIT_SPECS}, in the exact spelling the planner uses; anything
 *   else, attached or separated (`-ccore.hooksPath=x`, `-u evil`, `--upload-pack=x`), throws;
 * - `clone` and `ls-remote` take only a `https://github.com/<org>/<repo>` or `file:///` URL, and
 *   `fetch` only the remote `origin`, so no transport helper can be named;
 * - the one `aws` call, when a bucket listing is asked for, is `s3api list-objects-v2` with four
 *   named options ({@link readOnlyAws});
 * - the HTTP requests the planner makes itself (the open pull requests, the bucket's anonymous
 *   `annex-uuid` marker) go through {@link readOnlyFetch}, GET and HEAD only.
 *
 * Outside this guard, and read-only by what they are: OpenNeuro's snapshot query
 * (`fetchOpenNeuroSnapshots`, a GraphQL POST that asks: the latest an import pins its tag to, and
 * the snapshot list with creation times the staleness report orders by);
 * the NEMAR API's two GETs (the dataset row and its version rows), which the command makes through
 * the API client before planning; `gh auth token`, which reads the administrator's stored GitHub
 * token; reads of the test bases' local directories; and the planner's own scratch directory and
 * plan file. `clone` and `fetch` write only into the scratch directory.
 *
 * `GIT_NO_LAZY_FETCH=1` is set on every git call, so a partial clone never fetches a missing blob
 * on its own (git 2.44 and later honor it; an older git ignores it, and nothing here depends on it,
 * because only blobs the clone holds are read and the missing ones are listed by
 * `rev-list --missing=print`, which never fetches). The explicit blob fetch is the one way bytes
 * beyond the filter arrive, under the plan's bound.
 */

/** One subcommand's permitted options: flags spelled exactly, and options that take one value. */
interface GitSpec {
  flags: readonly string[];
  valued?: readonly string[];
  /** `--` may end the options; everything after it is a path. */
  endOfOptions?: boolean;
  /** The first positional argument is a remote URL. */
  url?: boolean;
  /** The first positional argument must be this remote name. */
  remote?: string;
}

/** The git subcommands the planner may run, and the options each may carry. */
export const GIT_SPECS: Readonly<Record<string, GitSpec>> = {
  clone: {
    flags: ["--bare", "--quiet", "--filter=blob:limit=1m", "--depth=1", "--no-tags"],
    valued: ["--branch"],
    url: true,
  },
  fetch: {
    flags: [
      "--quiet",
      "--depth=1",
      "--no-tags",
      "--no-write-fetch-head",
      "--recurse-submodules=no",
      "--filter=blob:none",
      "--stdin",
    ],
    remote: "origin",
  },
  "ls-remote": { flags: ["--refs"], url: true },
  "cat-file": { flags: ["--batch"] },
  "ls-tree": { flags: ["-r", "-z", "--full-tree"], endOfOptions: true },
  "rev-parse": { flags: ["--verify", "--quiet", "--show-object-format"] },
  "rev-list": { flags: ["--objects", "--missing=print", "--no-object-names"] },
};

/** The one `-c key=value` a planner command may pass, before its subcommand, as two arguments. */
const ALLOWED_CONFIG = new Set(["fetch.negotiationAlgorithm=noop"]);

/** A clone or ls-remote URL: a GitHub repository over HTTPS, or a local test base. */
const ALLOWED_URL = /^(?:https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|file:\/\/\/\S+)$/;

export class ReadOnlyViolation extends Error {
  constructor(what: string) {
    super(`refused by the re-pull planner's read-only guard: ${what}`);
    this.name = "ReadOnlyViolation";
  }
}

export interface GitRun {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export interface ReadOnlyGitOptions {
  /** The repository (`git -C`); omitted for `clone` and `ls-remote`. */
  cwd?: string;
  /** Extra environment (credential helpers), merged over the process environment. */
  env?: Record<string, string | undefined>;
  stdin?: string | Uint8Array;
}

/** Check one argv against the guard; throws {@link ReadOnlyViolation}. Exported for its test. */
export function assertReadOnlyGit(args: readonly string[]): void {
  let i = 0;
  while (args[i]?.startsWith("-")) {
    if (args[i] !== "-c" || !ALLOWED_CONFIG.has(args[i + 1] ?? "")) {
      throw new ReadOnlyViolation(`git ${args[i]} ${args[i + 1] ?? ""}`.trim());
    }
    i += 2;
  }
  const sub = args[i];
  const spec = sub === undefined ? undefined : GIT_SPECS[sub];
  if (sub === undefined || !spec) throw new ReadOnlyViolation(`git ${sub ?? "(nothing)"}`);
  const positionals: string[] = [];
  let ended = false;
  for (let j = i + 1; j < args.length; j++) {
    const arg = args[j] as string;
    if (ended) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--" && spec.endOfOptions) {
      ended = true;
      continue;
    }
    if (spec.flags.includes(arg)) continue;
    if (spec.valued?.includes(arg)) {
      const value = args[j + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new ReadOnlyViolation(`git ${sub} ${arg} without a value`);
      }
      j++;
      continue;
    }
    if (arg.startsWith("-")) throw new ReadOnlyViolation(`git ${sub} ${arg}`);
    positionals.push(arg);
  }
  const first = positionals[0];
  if (spec.url && (first === undefined || !ALLOWED_URL.test(first))) {
    throw new ReadOnlyViolation(`git ${sub} of a URL that is not GitHub or a local path`);
  }
  if (spec.remote !== undefined && first !== spec.remote) {
    throw new ReadOnlyViolation(`git ${sub} from a remote other than ${spec.remote}`);
  }
}

/** The git processes the planner has running, so a signal handler can stop them first. */
const liveGit = new Set<{ kill(signal?: number | NodeJS.Signals): void }>();

/**
 * Stop every git process the planner started that is still running. The scratch directory's
 * signal handler calls this before it removes the directory: a clone still writing would
 * otherwise recreate parts of it after the removal.
 */
export function killLiveGit(): void {
  for (const proc of liveGit) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  liveGit.clear();
}

/** Run one read-only git command. Never throws on a non-zero exit; the caller reads `exitCode`. */
export async function readOnlyGit(args: string[], opts: ReadOnlyGitOptions = {}): Promise<GitRun> {
  assertReadOnlyGit(args);
  const input = typeof opts.stdin === "string" ? new TextEncoder().encode(opts.stdin) : opts.stdin;
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    GIT_NO_LAZY_FETCH: "1",
    ...opts.env,
  };
  const proc = Bun.spawn(["git", ...(opts.cwd ? ["-C", opts.cwd] : []), ...args], {
    ...(input === undefined ? {} : { stdin: input as Uint8Array }),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  liveGit.add(proc);
  try {
    const [out, err, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout: Buffer.from(out), stderr: err, exitCode };
  } finally {
    liveGit.delete(proc);
  }
}

/**
 * {@link readOnlyGit} in the shape `readLocationLogsAt` (scripts/scrub/git/git-lib.ts) takes as
 * its runner, so the git-annex branch reads go through the guard as well.
 */
export function guardedGitRunner(
  env?: Record<string, string | undefined>,
): (repo: string, args: string[], stdin?: string | Uint8Array) => Promise<GitRun> {
  return (repo, args, stdin) => readOnlyGit(args, { cwd: repo, env, stdin });
}

/** Run one read-only git command and return its stdout as text, or throw with its stderr. */
export async function readOnlyGitText(
  args: string[],
  opts: ReadOnlyGitOptions = {},
): Promise<string> {
  const r = await readOnlyGit(args, opts);
  if (r.exitCode !== 0) {
    throw new Error(
      `git ${args[0]} failed: ${r.stderr.trim().split("\n")[0] || `exit ${r.exitCode}`}`,
    );
  }
  return r.stdout.toString("utf8");
}

/** The options `aws s3api list-objects-v2` may carry, each with one value. */
const AWS_VALUED = new Set(["--bucket", "--prefix", "--region", "--output"]);

/**
 * Check one `aws` argv: `s3api list-objects-v2` with `--bucket`, `--prefix`, `--region` and
 * `--output json`, and nothing else. Exported for its test.
 */
export function assertReadOnlyAws(args: readonly string[]): void {
  if (args[0] !== "s3api" || args[1] !== "list-objects-v2") {
    throw new ReadOnlyViolation(`aws ${args.slice(0, 2).join(" ")}`);
  }
  for (let j = 2; j < args.length; j += 2) {
    const option = args[j] as string;
    const value = args[j + 1];
    if (!AWS_VALUED.has(option) || value === undefined || value.startsWith("-")) {
      throw new ReadOnlyViolation(`aws s3api list-objects-v2 ${option}`);
    }
    if (option === "--output" && value !== "json") {
      throw new ReadOnlyViolation(`aws s3api list-objects-v2 --output ${value}`);
    }
  }
}

/** Run `aws s3api list-objects-v2`, with the ambient credentials. Never throws on a non-zero exit. */
export async function readOnlyAws(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<GitRun> {
  assertReadOnlyAws(args);
  const proc = Bun.spawn(["aws", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AWS_PAGER: "", ...env },
  });
  const [out, err, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: Buffer.from(out), stderr: err, exitCode };
}

/** The planner's own HTTP requests: GET and HEAD only. */
export async function readOnlyFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") throw new ReadOnlyViolation(`HTTP ${method}`);
  return fetch(url, { ...init, method });
}
