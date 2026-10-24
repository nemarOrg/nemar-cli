/**
 * The re-pull planner's only ways out of the process (ADR 0111, epic #1046 phase 5).
 *
 * `nemar admin repull plan` is read-only on GitHub, S3 and the NEMAR API. Read-only is enforced
 * here rather than promised by each caller: every git subprocess the planner starts goes through
 * {@link readOnlyGit}, which refuses any subcommand outside a short list of reads, and every HTTP
 * request goes through {@link readOnlyFetch}, which refuses any method but GET and HEAD. A future
 * edit that reaches for `git push`, `git annex` or a POST fails loudly in the first test that
 * runs it, instead of writing to a dataset somebody else is reading.
 *
 * `clone` and `fetch` write only into the planner's own scratch directory; neither changes the
 * remote. `rev-list` is here for `--missing=print`, the one listing of which blobs a partial clone
 * lacks that never fetches them. The one `aws` call the planner may make, when asked to read
 * presence from a bucket listing, is `s3api list-objects-v2` ({@link readOnlyAws}).
 */

/** The git subcommands the planner may run. Nothing here writes to a remote. */
export const READ_ONLY_GIT = new Set([
  "clone",
  "fetch",
  "ls-remote",
  "cat-file",
  "ls-tree",
  "rev-parse",
  "rev-list",
  "for-each-ref",
]);

/** The `-c key=value` settings a planner command may pass before its subcommand. */
const ALLOWED_CONFIG = new Set(["fetch.negotiationAlgorithm"]);

/** Options that would let a clone or fetch run a program or a hook the planner did not choose. */
const FORBIDDEN_OPTIONS = /^(?:--upload-pack|-u$|-c$|--config|--template|--exec|--receive-pack)/;

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
  /**
   * Let git fetch a missing object of a partial clone on its own. Off by default
   * (`GIT_NO_LAZY_FETCH=1`), so the only bytes the planner downloads are the ones it decided to,
   * under its bound; the explicit blob fetch is the one caller that turns it on, for itself.
   */
  lazyFetch?: boolean;
}

/** Check one argv against the guard; throws {@link ReadOnlyViolation}. Exported for its test. */
export function assertReadOnlyGit(args: readonly string[]): void {
  let i = 0;
  while (args[i] === "-c") {
    const setting = args[i + 1] ?? "";
    const key = setting.split("=")[0] ?? "";
    if (!ALLOWED_CONFIG.has(key)) throw new ReadOnlyViolation(`git -c ${key}`);
    i += 2;
  }
  const sub = args[i];
  if (sub === undefined || !READ_ONLY_GIT.has(sub)) {
    throw new ReadOnlyViolation(`git ${sub ?? "(nothing)"}`);
  }
  for (const arg of args.slice(i + 1)) {
    if (FORBIDDEN_OPTIONS.test(arg)) throw new ReadOnlyViolation(`git ${sub} ${arg}`);
  }
}

/** Run one read-only git command. Never throws on a non-zero exit; the caller reads `exitCode`. */
export async function readOnlyGit(args: string[], opts: ReadOnlyGitOptions = {}): Promise<GitRun> {
  assertReadOnlyGit(args);
  const input = typeof opts.stdin === "string" ? new TextEncoder().encode(opts.stdin) : opts.stdin;
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...(opts.lazyFetch ? {} : { GIT_NO_LAZY_FETCH: "1" }),
    ...opts.env,
  };
  const proc = Bun.spawn(["git", ...(opts.cwd ? ["-C", opts.cwd] : []), ...args], {
    ...(input === undefined ? {} : { stdin: input as Uint8Array }),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [out, err, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: Buffer.from(out), stderr: err, exitCode };
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

/** Check one `aws` argv: `s3api list-objects-v2` and nothing else. Exported for its test. */
export function assertReadOnlyAws(args: readonly string[]): void {
  if (args[0] !== "s3api" || args[1] !== "list-objects-v2") {
    throw new ReadOnlyViolation(`aws ${args.slice(0, 2).join(" ")}`);
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

/** The one HTTP path out of the planner: GET and HEAD only. */
export async function readOnlyFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") throw new ReadOnlyViolation(`HTTP ${method}`);
  return fetch(url, { ...init, method });
}
