/**
 * Regenerate the pipeline-owned files of a mirror on a new snapshot (ADR 0111, the amendment of
 * 2026-11-19; iEEG geometry plan, ruling 28): the bridge from N.0.1 to the Python package
 * `scripts/ieeg_geometry`.
 *
 * It runs `python -m ieeg_geometry run <id> --apply` as a subprocess, on a private clone of the new
 * `main`, and takes exactly what the report's `changes` name: the files to add or change, the files
 * to remove, and the ownership record when its bytes differ. It writes nothing to any dataset
 * repository, the data plane or NEMAR's API; its only product is bytes, which `patch.ts` puts into
 * N.0.1's tree. The package fetches annexed inputs itself, read-only, from the data plane at the
 * version it is given.
 *
 * Determinism (N.0.1 is re-derived on resume and must be the same commit): the outputs are a
 * function of the snapshot (the commit the clone is made at) and the pipeline version, so the report
 * must name that version (`IEEG_GEOMETRY_PIPELINE_VERSION`) and that commit, or the regeneration
 * fails. Every file it returns is a small git file (never annexed), and nothing else in the clone
 * may have changed; a run that wrote anything it did not declare fails too.
 *
 * A failure never throws: it is a {@link Regeneration} with `ok: false`, a code and fixed words (the
 * package's own messages name paths and are never repeated), and N.0.1 then carries none of the
 * previous pipeline files (the amendment's item 4).
 *
 * The central workflow installs only the npm package, so a run needs a checkout of nemar-cli at the
 * same release and `uv` (`.context/plans/ieeg-geometry/workflow-patches/`). A test points the run at
 * a stand-in program with `NEMAR_IEEG_GEOMETRY_RUNNER`, honored only as an absolute path and only
 * beside the test remote base (the `NEMAR_GITHUB_API_URL` rule), and the project at another
 * checkout with `NEMAR_IEEG_GEOMETRY_DIR`.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldAnnex } from "../git-annex/policy.js";
import { runCommand } from "../git-annex/run-command.js";
import { treeOf } from "./execute/resynthesize.js";
import { ISOLATED_GIT_ENV, git } from "./execute/workdir.js";
import {
  IEEG_GEOMETRY_PIPELINE_VERSION,
  OWNERSHIP_PATH,
  isPipelineOutputPath,
  withoutOwnedPaths,
} from "./pipeline-owned.js";
import type { Env } from "./sources.js";

/** What a regeneration changes in the tree: file contents to write, and paths to remove. */
export interface PipelineFiles {
  /** Path to text (UTF-8, small, never annexed): added or changed outputs, and the ownership record. */
  write: Map<string, string>;
  /** Owned paths the new run does not produce. */
  remove: string[];
  /** The report's count of files it kept (hand-edited or blocked), for the record's words. */
  kept: number;
}

export type Regeneration =
  | { ok: true; files: PipelineFiles }
  | { ok: false; code: string; message: string };

/** No change at all: the new run produces what the tree already holds. */
export function isEmptyRegeneration(r: PipelineFiles): boolean {
  return r.write.size === 0 && r.remove.length === 0;
}

/** The longest a run may take, a fetch of annexed inputs included. */
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
/** The largest output the bridge takes (the annex policy's own small-file bound is 1 MiB). */
const MAX_OUTPUT_BYTES = 1024 * 1024;

class Failure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RegenerateArgs {
  datasetId: string;
  /** The dataset version the new snapshot was released as (`N.0.0`): the data plane's key. */
  version: string;
  /** The new `main` the clone is made at; the report must name it. */
  commit: string;
  /** A bare repository that holds `commit`. */
  repo: string;
  /** The paths the ownership record listed at the re-pull's base. */
  owned: ReadonlySet<string>;
  /** Owned paths upstream's new snapshot holds a file at: upstream wins, they leave ownership. */
  upstreamWins: ReadonlySet<string>;
  /** Every listed path that is not owned (hand edited, or upstream's): never written or removed. */
  unowned?: ReadonlySet<string>;
  /**
   * Hand-edited pipeline files N.0.1 replays, by path to text: put in the clone before the run, so
   * the package finds them as they are and keeps them, and never regenerates over them.
   */
  preserve?: ReadonlyMap<string, string>;
  env: Env;
  /** Where the private clone goes; the system temp directory by default. */
  tempRoot?: string;
}

function projectDirOf(env: Env): string {
  const set = env.NEMAR_IEEG_GEOMETRY_DIR?.trim();
  if (set) {
    if (!isAbsolute(set)) {
      throw new Failure(
        "pipeline-unavailable",
        "NEMAR_IEEG_GEOMETRY_DIR is set but is not an absolute path.",
      );
    }
    return set;
  }
  return fileURLToPath(new URL("../../../scripts/ieeg_geometry", import.meta.url));
}

function runnerOf(env: Env): string[] {
  const override = env.NEMAR_IEEG_GEOMETRY_RUNNER?.trim();
  if (override) {
    if (!isAbsolute(override) || !env.NEMAR_REPULL_ORIGIN_BASE) {
      throw new Failure(
        "pipeline-unavailable",
        "NEMAR_IEEG_GEOMETRY_RUNNER is set but is not an absolute path beside the test remote base. It is only for tests, so it is refused rather than ignored.",
      );
    }
    return [override];
  }
  const project = projectDirOf(env);
  if (!existsSync(join(project, "pyproject.toml"))) {
    throw new Failure(
      "pipeline-unavailable",
      "The iEEG geometry package is not in this checkout (scripts/ieeg_geometry); a run needs a nemar-cli checkout at the CLI's release.",
    );
  }
  return [
    "uv",
    "run",
    "--frozen",
    "--no-dev",
    "--project",
    project,
    "python",
    "-m",
    "ieeg_geometry",
  ];
}

/**
 * The environment the child may inherit: the search path, the home and cache directories, the
 * language runtime's and `uv`'s own variables, and the locale and TLS settings it needs to run and
 * to read the data plane. Never a credential: no `AWS_*`, `GH_TOKEN`, `NEMAR_API_KEY` or any other
 * token reaches it, because it runs code from a checkout, not the CLI. A test's stand-in also gets
 * the `STANDIN_*` variables that steer it (beside the test remote base only).
 */
const CHILD_ENV =
  /^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TEMP|TMP|LANG|LC_[A-Z]+|TZ|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|XDG_(?:CACHE|DATA|CONFIG)_HOME|UV_[A-Z_]+|PYTHON[A-Z_]*|VIRTUAL_ENV|NEMAR_IEEG_GEOMETRY_DIR)$/;

function childMayHave(name: string, env: Env): boolean {
  if (/(?:TOKEN|SECRET|KEY|PASSWORD)/i.test(name) && !/^UV_[A-Z_]*CACHE/.test(name)) return false;
  if (CHILD_ENV.test(name)) return true;
  return name.startsWith("STANDIN_") && !!env.NEMAR_REPULL_ORIGIN_BASE;
}

interface Report {
  schema: string;
  version: number;
  dataset: string;
  mode: string;
  pipeline_version: string;
  source_commit: string;
  changes: { add: string[]; change: string[]; remove: string[]; kept: string[] };
}

function stringList(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

function parseReport(stdout: string): Report {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Failure("pipeline-report", "The pipeline printed no JSON report.");
  }
  const changes = (doc.changes ?? {}) as Record<string, unknown>;
  const lists = ["add", "change", "remove", "kept"].map((k) => stringList(changes[k]));
  if (
    doc.schema !== "nemar-ieeg-geometry-report" ||
    doc.version !== 1 ||
    typeof doc.dataset !== "string" ||
    typeof doc.mode !== "string" ||
    typeof doc.pipeline_version !== "string" ||
    typeof doc.source_commit !== "string" ||
    lists.some((l) => l === null)
  ) {
    throw new Failure("pipeline-report", "The pipeline's report does not have its schema.");
  }
  const [add, change, remove, kept] = lists as string[][];
  return {
    schema: doc.schema,
    version: doc.version,
    dataset: doc.dataset,
    mode: doc.mode,
    pipeline_version: doc.pipeline_version,
    source_commit: doc.source_commit,
    changes: {
      add: add as string[],
      change: change as string[],
      remove: remove as string[],
      kept: kept as string[],
    },
  };
}

/** What git says differs in the clone since it was made, by path (a path is a name, never a verdict). */
async function observedChanges(clone: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const flag of ["--others", "--modified", "--deleted"]) {
    const r = await git(clone, ["ls-files", "-z", flag], { ok: true });
    if (r.exitCode !== 0)
      throw new Failure("pipeline-undeclared-write", "The clone is unreadable.");
    for (const p of r.stdout.split("\0")) if (p) out.add(p);
  }
  return out;
}

async function run(root: string, args: RegenerateArgs): Promise<PipelineFiles> {
  const runner = runnerOf(args.env);
  const clone = join(root, args.datasetId);
  mkdirSync(clone, { recursive: true });
  for (const step of [
    ["init", "--quiet"],
    ["config", "core.autocrlf", "false"],
    ["config", "core.hooksPath", "/dev/null"],
    ["config", "core.attributesFile", "/dev/null"],
    ["config", "gc.auto", "0"],
  ]) {
    if ((await git(clone, step, { ok: true })).exitCode !== 0) {
      throw new Failure("pipeline-snapshot", "The private clone could not be made.");
    }
  }
  const fetched = await git(clone, ["fetch", "--quiet", "--no-tags", args.repo, args.commit], {
    ok: true,
  });
  const point = await git(clone, ["update-ref", "refs/heads/regenerate", args.commit], {
    ok: true,
  });
  const head = await git(clone, ["symbolic-ref", "HEAD", "refs/heads/regenerate"], { ok: true });
  if (fetched.exitCode !== 0 || point.exitCode !== 0 || head.exitCode !== 0) {
    throw new Failure("pipeline-snapshot", "The new main could not be read into the clone.");
  }

  const atCommit = await git(clone, ["cat-file", "blob", `${args.commit}:${OWNERSHIP_PATH}`], {
    ok: true,
  });
  const ownershipAt = atCommit.exitCode === 0 ? atCommit.stdout : null;
  const dropped = new Set([...args.upstreamWins, ...(args.unowned ?? [])]);
  for (const [path, text] of args.preserve ?? []) {
    mkdirSync(dirname(join(clone, path)), { recursive: true });
    await Bun.write(join(clone, path), text);
  }
  if (ownershipAt !== null && dropped.size > 0) {
    // Upstream's file at an owned path wins: the path leaves the list before the run reads it.
    mkdirSync(join(clone, ".nemar"), { recursive: true });
    const pruned = withoutOwnedPaths(Buffer.from(ownershipAt, "utf8"), dropped);
    await Bun.write(join(clone, OWNERSHIP_PATH), pruned);
  }

  let result: Awaited<ReturnType<typeof runCommand>>;
  try {
    result = await runCommand(
      [...runner, "run", args.datasetId, "--workdir", root, "--version", args.version, "--apply"],
      {
        cwd: root,
        env: { ...ISOLATED_GIT_ENV },
        unsetEnv: Object.keys(process.env).filter((k) => !childMayHave(k, args.env)),
        timeout: RUN_TIMEOUT_MS,
      },
    );
  } catch {
    throw new Failure("pipeline-unavailable", "The pipeline could not be started.");
  }
  if (result.timedOut) throw new Failure("pipeline-run-failed", "The pipeline timed out.");
  if (result.exitCode !== 0) {
    throw new Failure("pipeline-run-failed", `The pipeline exited with status ${result.exitCode}.`);
  }
  const report = parseReport(result.stdout);
  if (report.pipeline_version !== IEEG_GEOMETRY_PIPELINE_VERSION) {
    throw new Failure(
      "pipeline-version",
      `The pipeline is not the version this release of the CLI runs (${IEEG_GEOMETRY_PIPELINE_VERSION}); the outputs are only the same for the same version.`,
    );
  }
  if (
    report.dataset !== args.datasetId ||
    report.mode !== "apply" ||
    report.source_commit !== args.commit
  ) {
    throw new Failure("pipeline-report", "The report is not of this snapshot, applied.");
  }

  const tree = new Map((await treeOf(args.repo, args.commit)).map((e) => [e.path, e]));
  const { add, change, remove } = report.changes;
  const declared = new Set<string>();
  const write = new Map<string, string>();
  const gone: string[] = [];
  const invalid = (what: string) =>
    new Failure("pipeline-output-invalid", `The pipeline reported ${what}.`);
  for (const [kind, paths] of [
    ["add", add],
    ["change", change],
    ["remove", remove],
  ] as const) {
    for (const p of paths) {
      declared.add(p);
      if (p === OWNERSHIP_PATH) continue;
      if (!isPipelineOutputPath(p)) throw invalid("a path that is not one of its outputs");
      if (dropped.has(p)) throw invalid("a path that is not the pipeline's to write");
      if (kind === "add" && tree.has(p)) throw invalid("an added path the tree already holds");
      if (kind !== "add" && !args.owned.has(p)) throw invalid("a path the ownership record lacks");
    }
  }
  for (const p of [...add, ...change]) {
    if (p === OWNERSHIP_PATH) continue;
    write.set(p, readOutput(clone, p));
  }
  for (const p of remove) {
    if (p === OWNERSHIP_PATH) throw invalid("the ownership record removed");
    if (existsSync(join(clone, p))) throw invalid("a removed path that is still there");
    gone.push(p);
  }
  // Everything the run changed in the clone is something it declared, and the ownership record.
  declared.add(OWNERSHIP_PATH);
  for (const p of args.preserve?.keys() ?? []) declared.add(p);
  for (const p of await observedChanges(clone)) {
    if (!declared.has(p)) {
      throw new Failure(
        "pipeline-undeclared-write",
        "The pipeline changed a file it did not report.",
      );
    }
  }
  const ownershipNow = existsSync(join(clone, OWNERSHIP_PATH))
    ? readOutput(clone, OWNERSHIP_PATH)
    : null;
  if (ownershipNow === null && ownershipAt !== null) {
    throw invalid("the ownership record removed");
  }
  if (ownershipNow !== null && ownershipNow !== ownershipAt)
    write.set(OWNERSHIP_PATH, ownershipNow);
  return { write, remove: gone.sort(), kept: report.changes.kept.length };
}

/** A file the run wrote, as text: a regular file, small, UTF-8, and one the annex policy keeps in git. */
function readOutput(clone: string, path: string): string {
  const file = join(clone, path);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch {
    throw new Failure("pipeline-output-invalid", "A file the pipeline reported is not there.");
  }
  if (!stat.isFile() || stat.size > MAX_OUTPUT_BYTES || shouldAnnex(path, stat.size)) {
    throw new Failure(
      "pipeline-output-invalid",
      "A file the pipeline wrote is not a small file git holds.",
    );
  }
  const bytes = readFileSync(file);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Failure("pipeline-output-invalid", "A file the pipeline wrote is not UTF-8 text.");
  }
  return text;
}

/**
 * Run the pipeline on `commit` and return what N.0.1 changes, or why it could not. The private
 * clone is removed on every path out.
 */
export async function regenerate(args: RegenerateArgs): Promise<Regeneration> {
  const root = mkdtempSync(join(args.tempRoot ?? tmpdir(), "nemar-ieeg-geometry-"));
  try {
    return { ok: true, files: await run(root, args) };
  } catch (err) {
    if (err instanceof Failure) return { ok: false, code: err.code, message: err.message };
    throw err;
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
