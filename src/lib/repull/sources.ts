/**
 * Where the re-pull planner reads from, and how (ADR 0111, epic #1046 phase 5).
 *
 * Three remotes: NEMAR's dataset repository (`nemarDatasets/<id>`), upstream's GitHub mirror
 * (`OpenNeuroDatasets/<ds>`), and NEMAR's bucket. From the bucket the planner reads the
 * `annex-uuid` marker anonymously (one GET through `readOnlyFetch`) and, only when the
 * administrator asks for it, a listing of `nemar-s3`'s prefix with the ambient AWS credentials
 * (`aws s3api list-objects-v2` through `readOnlyAws`).
 *
 * Each clone is bare, depth 1 and blob-filtered at 1 MiB (`--filter=blob:limit=1m`): the planner
 * compares trees by object id, reads small blobs (sidecars, annex pointers, the git-annex branch's
 * logs) whole, and fetches a larger blob only when a check needs its bytes, under the
 * `--max-fetch-gb` bound ({@link BlobStore}). Nothing is checked out, so a README name that differs
 * only in case or Unicode normalization is never folded by a filesystem. `ls-remote`, the clones
 * and their fetches all carry the same credential environment ({@link remoteEnv}), never a token
 * in the argv or the URL.
 *
 * A test points the three remotes at local paths through `NEMAR_REPULL_ORIGIN_BASE`,
 * `NEMAR_REPULL_UPSTREAM_BASE` and `NEMAR_REPULL_BUCKET_BASE`. Each is honored only as an absolute
 * local path, the same rule as the loopback-only `NEMAR_GITHUB_API_URL`: a value that is set and is
 * not one refuses, because a typo must not turn a rehearsal into a read of the real dataset. A plan
 * made with any of them active says so in its file (`sources: "test-bases"`).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { annexKeyFile, hashDirLower } from "../../../scripts/scrub/git/git-lib.js";
import { type PinnedSource, parseRemoteLog, parseRmet } from "../content-recovery.js";
import { fleetCloneEnv } from "../fleet-key-registration.js";
import {
  type GitRun,
  readOnlyAws,
  readOnlyFetch,
  readOnlyGit,
  readOnlyGitText,
} from "./read-only.js";

export const NEMAR_ORG = "nemarDatasets";
export const UPSTREAM_ORG = "OpenNeuroDatasets";

/** The environment variables a test may set, and what each one replaces. */
export const BASE_ENV = {
  origin: "NEMAR_REPULL_ORIGIN_BASE",
  upstream: "NEMAR_REPULL_UPSTREAM_BASE",
  bucket: "NEMAR_REPULL_BUCKET_BASE",
} as const;

export type Env = Record<string, string | undefined>;

/** A test base, or null for the real remote; a set value that is not an absolute path refuses. */
export function localBase(env: Env, which: keyof typeof BASE_ENV): string | null {
  const name = BASE_ENV[which];
  const value = env[name]?.trim();
  if (!value) return null;
  if (!isAbsolute(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new Error(
      `${name} is set but is not an absolute local path. It is only for tests, so it is refused rather than ignored; unset it to read the real remote.`,
    );
  }
  return value.replace(/\/+$/, "");
}

/**
 * OpenNeuro's GraphQL endpoint for the latest-snapshot query: the real one, or a test's stand-in
 * through `NEMAR_REPULL_OPENNEURO_URL`, honored only for a loopback http address (the
 * `NEMAR_GITHUB_API_URL` rule); a set value that is not one refuses.
 */
export function openNeuroGraphqlUrl(env: Env): string | undefined {
  const value = env.NEMAR_REPULL_OPENNEURO_URL?.trim();
  if (!value) return undefined;
  try {
    const u = new URL(value);
    if (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
      return value;
    }
  } catch {
    // refused below
  }
  throw new Error(
    "NEMAR_REPULL_OPENNEURO_URL is set but is not an http://127.0.0.1, http://localhost or http://[::1] address. It is only for tests, so it is refused rather than ignored.",
  );
}

/** True when any test base redirects a remote; the plan file records it. */
export function usesTestBases(env: Env): boolean {
  return (
    (Object.keys(BASE_ENV) as Array<keyof typeof BASE_ENV>).some(
      (k) => localBase(env, k) !== null,
    ) || openNeuroGraphqlUrl(env) !== undefined
  );
}

/** The clone URL of NEMAR's dataset repository. */
export function originUrl(datasetId: string, env: Env): string {
  const base = localBase(env, "origin");
  return base ? `file://${base}/${datasetId}` : `https://github.com/${NEMAR_ORG}/${datasetId}.git`;
}

/** The clone URL of upstream's GitHub mirror. */
export function upstreamUrl(ds: string, env: Env): string {
  const base = localBase(env, "upstream");
  return base ? `file://${base}/${ds}` : `https://github.com/${UPSTREAM_ORG}/${ds}.git`;
}

// ---------------------------------------------------------------------------------------
// ls-remote
// ---------------------------------------------------------------------------------------

/**
 * The credential environment for one remote: for a GitHub URL the empty helper reset and, with a
 * token, the token's helper ({@link fleetCloneEnv}); for anything else, nothing, so a token is never
 * offered to a host that is not GitHub. `ls-remote` and the clone of one remote use the same one.
 */
export function remoteEnv(url: string, token: string | null): Env | undefined {
  return fleetCloneEnv(url, token);
}

/** `refname -> oid`, from `git ls-remote`, peeled lines (`^{}`) dropped. */
export async function lsRemote(
  url: string,
  patterns: string[],
  env: Env | undefined,
): Promise<Map<string, string>> {
  const out = await readOnlyGitText(["ls-remote", "--refs", url, ...patterns], { env });
  const refs = new Map<string, string>();
  for (const line of out.split("\n")) {
    const [oid, name] = line.split("\t");
    if (oid && name && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(oid)) refs.set(name, oid);
  }
  return refs;
}

// ---------------------------------------------------------------------------------------
// Clones
// ---------------------------------------------------------------------------------------

/** The filter every planner clone uses: blobs of 1 MiB or more stay on the remote. */
export const BLOB_FILTER = "blob:limit=1m";

export interface Clone {
  path: string;
  url: string;
  env: Env | undefined;
}

/**
 * A bare, depth-1, blob-filtered clone at `branch` (a branch or a tag), with `extra` refs fetched
 * at depth 1 into the same names. Credentials travel in the environment ({@link fleetCloneEnv}),
 * never in the argv or the URL.
 */
export async function cloneAt(args: {
  url: string;
  dest: string;
  branch: string;
  extra: string[];
  token?: string | null;
}): Promise<Clone> {
  const env = remoteEnv(args.url, args.token ?? null);
  const clone = await readOnlyGit(
    [
      "clone",
      "--bare",
      "--quiet",
      `--filter=${BLOB_FILTER}`,
      "--depth=1",
      "--no-tags",
      "--branch",
      args.branch,
      args.url,
      args.dest,
    ],
    { env },
  );
  if (clone.exitCode !== 0) throw new Error(`git clone failed: ${firstLine(clone)}`);
  if (args.extra.length > 0) {
    const fetch = await readOnlyGit(
      [
        "fetch",
        "--quiet",
        "--depth=1",
        "--no-tags",
        "origin",
        ...args.extra.map((ref) => `+${ref}:${ref}`),
      ],
      { cwd: args.dest, env },
    );
    if (fetch.exitCode !== 0) throw new Error(`git fetch failed: ${firstLine(fetch)}`);
  }
  return { path: args.dest, url: args.url, env };
}

function firstLine(r: GitRun): string {
  return r.stderr.trim().split("\n")[0] || `exit ${r.exitCode}`;
}

/** A ref's commit and tree. */
export async function commitAndTree(
  repo: string,
  ref: string,
): Promise<{ commit: string; tree: string }> {
  const resolve = async (spec: string) =>
    (await readOnlyGitText(["rev-parse", "--verify", "--quiet", spec], { cwd: repo })).trim();
  const commit = await resolve(`${ref}^{commit}`);
  const tree = await resolve(`${ref}^{tree}`);
  if (!commit || !tree) throw new Error(`could not resolve ${ref}`);
  return { commit, tree };
}

/** The repository's object format; the planner computes blob ids for SHA-1 only. */
export async function objectFormat(repo: string): Promise<string> {
  return (await readOnlyGitText(["rev-parse", "--show-object-format"], { cwd: repo })).trim();
}

// ---------------------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  /** `blob`, or `commit` for a gitlink. */
  type: string;
  oid: string;
}

/** Every entry of a commit's tree, recursively, by path. Never `-l`: that fetches blobs. */
export async function listTree(repo: string, commit: string): Promise<Map<string, TreeEntry>> {
  const r = await readOnlyGit(["ls-tree", "-r", "-z", "--full-tree", commit], { cwd: repo });
  if (r.exitCode !== 0) throw new Error(`git ls-tree failed: ${firstLine(r)}`);
  const out = new Map<string, TreeEntry>();
  for (const entry of r.stdout.toString("utf8").split("\0")) {
    if (entry === "") continue;
    const m = /^([0-7]{6}) (\S+) ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t([\s\S]+)$/.exec(entry);
    if (!m) throw new Error("git ls-tree printed a line the planner does not understand");
    out.set(m[4] as string, { mode: m[1] as string, type: m[2] as string, oid: m[3] as string });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------------------

/** The blob ids a partial clone lacks under these commits, without fetching any of them. */
export async function missingBlobs(repo: string, commits: string[]): Promise<Set<string>> {
  const r = await readOnlyGit(
    ["rev-list", "--objects", "--missing=print", "--no-object-names", ...commits],
    {
      cwd: repo,
    },
  );
  if (r.exitCode !== 0) throw new Error(`git rev-list failed: ${firstLine(r)}`);
  const missing = new Set<string>();
  for (const line of r.stdout.toString("utf8").split("\n")) {
    if (line.startsWith("?")) missing.add(line.slice(1).trim());
  }
  return missing;
}

/** Whole contents of present blobs (`cat-file --batch`), by id. A missing id is absent. */
export async function readBlobs(repo: string, oids: string[]): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>();
  const unique = [...new Set(oids)];
  if (unique.length === 0) return found;
  const r = await readOnlyGit(["cat-file", "--batch"], {
    cwd: repo,
    stdin: `${unique.join("\n")}\n`,
  });
  if (r.exitCode !== 0) throw new Error(`git cat-file --batch failed: ${firstLine(r)}`);
  const out = r.stdout;
  let cursor = 0;
  for (const oid of unique) {
    const newline = out.indexOf(0x0a, cursor);
    if (newline < 0) throw new Error("git cat-file --batch ended early");
    const header = out.subarray(cursor, newline).toString("utf8").split(" ");
    if (header[1] === "missing") {
      cursor = newline + 1;
      continue;
    }
    const size = Number(header[2]);
    if (!Number.isFinite(size) || size < 0) throw new Error("git cat-file --batch: bad header");
    const start = newline + 1;
    found.set(oid, Buffer.from(out.subarray(start, start + size)));
    cursor = start + size + 1;
  }
  return found;
}

/**
 * The blobs one clone holds or can fetch, under one shared byte bound.
 *
 * A blob under 1 MiB is in the clone already. A larger one is fetched only when a check names it
 * WITH the size it expects (the size an annex key declares for the same content), and only while
 * the bytes fetched so far plus that size stay within the bound. A blob the bound refuses, or that
 * a fetch which exited 0 did not deliver, is refused: its path is classed `unchecked` and the plan
 * refuses (`fetch-bound`), so it is never executable on a guess. A blob whose size is not known in
 * advance is never fetched. The bound is shared by every clone of one plan.
 */
export class BlobStore {
  private readonly bytes = new Map<string, Buffer>();
  /** Blob ids a check needed and could not have: over the bound, or not delivered. */
  readonly refused = new Set<string>();
  constructor(
    readonly clone: Clone,
    readonly missing: Set<string>,
    private readonly budget: FetchBudget,
  ) {}

  isMissing(oid: string): boolean {
    return this.missing.has(oid);
  }

  /** Read present blobs into memory. */
  async load(oids: string[]): Promise<void> {
    const wanted = oids.filter((o) => !this.bytes.has(o) && !this.missing.has(o));
    for (const [oid, body] of await readBlobs(this.clone.path, wanted)) this.bytes.set(oid, body);
  }

  /** A loaded blob, or null when it is missing or was not loaded. */
  get(oid: string): Buffer | null {
    return this.bytes.get(oid) ?? null;
  }

  /**
   * Fetch missing blobs whose sizes are known in advance, in the order given, while the bound
   * allows; returns the ids refused for the bound. One `git fetch` for all of them.
   */
  async fetch(wants: Array<{ oid: string; expected: number }>): Promise<Set<string>> {
    const refused = new Set<string>();
    const take: string[] = [];
    const claimed = new Map<string, number>();
    for (const w of wants) {
      if (!this.missing.has(w.oid) || claimed.has(w.oid) || refused.has(w.oid)) continue;
      if (!this.budget.claim(w.expected)) {
        refused.add(w.oid);
        this.refused.add(w.oid);
        continue;
      }
      claimed.set(w.oid, w.expected);
      take.push(w.oid);
    }
    if (take.length === 0) return refused;
    const r = await readOnlyGit(
      [
        "-c",
        "fetch.negotiationAlgorithm=noop",
        "fetch",
        "--quiet",
        "origin",
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        "--filter=blob:none",
        "--stdin",
      ],
      { cwd: this.clone.path, env: this.clone.env, stdin: `${take.join("\n")}\n` },
    );
    if (r.exitCode !== 0)
      throw new Error(`git fetch of ${take.length} blob(s) failed: ${firstLine(r)}`);
    const arrived = await readBlobs(this.clone.path, take);
    for (const oid of take) {
      const body = arrived.get(oid);
      if (!body) {
        // The fetch exited 0 and did not deliver it: as unread as a refused one.
        refused.add(oid);
        this.refused.add(oid);
        this.budget.used -= claimed.get(oid) ?? 0;
        continue;
      }
      this.bytes.set(oid, body);
      this.missing.delete(oid);
      // The bound counts what arrived; a blob that is not the size it was expected to be (it is
      // then not the key's content, which the check will find) is counted at its own size.
      this.budget.used += body.length - (claimed.get(oid) ?? 0);
    }
    return refused;
  }
}

/** The byte bound on lazily fetched blobs, shared by one plan's clones. */
export class FetchBudget {
  used = 0;
  refused = 0;
  constructor(readonly max: number) {}
  claim(bytes: number): boolean {
    if (this.used + bytes > this.max) {
      this.refused++;
      return false;
    }
    this.used += bytes;
    return true;
  }
}

// ---------------------------------------------------------------------------------------
// The bucket's annex-uuid marker
// ---------------------------------------------------------------------------------------

export type MarkerRead =
  | { status: "ok"; uuid: string }
  | { status: "absent" | "forbidden" | "error"; detail: string };

/**
 * The `annex-uuid` object git-annex's S3 remote writes at its prefix (#1320), read anonymously.
 * A 404 or 403 is reported as such and never read as a value: S3 answers 403 for a missing
 * object when listing is denied, so neither proves anything.
 */
export async function readAnnexUuidMarker(args: {
  bucket: string;
  region: string;
  prefix: string;
  env: Env;
}): Promise<MarkerRead> {
  const base = localBase(args.env, "bucket");
  if (base) {
    try {
      const text = readFileSync(join(base, `${args.prefix}annex-uuid`), "utf8");
      return { status: "ok", uuid: text.trim() };
    } catch (err) {
      // A local store answers like S3 does: no object is absent, a refused read is forbidden.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { status: "absent", detail: "no annex-uuid object" };
      if (code === "EACCES" || code === "EPERM") return { status: "forbidden", detail: code };
      return { status: "error", detail: code ?? "read failed" };
    }
  }
  const path = `${args.prefix}annex-uuid`.split("/").map(encodeURIComponent).join("/");
  const url = `https://${args.bucket}.s3.${args.region}.amazonaws.com/${path}`;
  try {
    const res = await readOnlyFetch(url, {
      headers: { "User-Agent": "nemar-cli-repull-plan" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return { status: "absent", detail: "HTTP 404" };
    if (res.status === 403) return { status: "forbidden", detail: "HTTP 403" };
    if (!res.ok) return { status: "error", detail: `HTTP ${res.status}` };
    return { status: "ok", uuid: (await res.text()).trim() };
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.name : "fetch failed" };
  }
}

// ---------------------------------------------------------------------------------------
// The bucket listing (optional presence basis)
// ---------------------------------------------------------------------------------------

/**
 * The objects under `nemar-s3`'s prefix, name -> size, with the ambient AWS credentials: the
 * presence basis an administrator may ask for instead of the location log, which can say NEMAR
 * holds content the bucket never received (#1396).
 *
 * An empty or short listing would read as "NEMAR holds nothing" and inflate the copy, so the
 * listing must contain the prefix's own `annex-uuid` object, which every `nemar-s3` prefix has, as
 * its control; without it this throws. The AWS CLI v2 follows every page itself.
 */
export async function listBucketObjects(args: {
  bucket: string;
  region: string;
  prefix: string;
  env: Env;
}): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const base = localBase(args.env, "bucket");
  if (base) {
    const dir = join(base, args.prefix);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    for (const name of names) {
      const st = statSync(join(dir, name));
      if (st.isFile()) out.set(name, st.size);
    }
    return withControl(out, args.prefix);
  }
  const r = await readOnlyAws(
    [
      "s3api",
      "list-objects-v2",
      "--bucket",
      args.bucket,
      "--prefix",
      args.prefix,
      "--region",
      args.region,
      "--output",
      "json",
    ],
    args.env,
  );
  if (r.exitCode !== 0) {
    throw new Error(`aws s3api list-objects-v2 failed: ${firstLine(r)}`);
  }
  const text = r.stdout.toString("utf8").trim();
  const parsed = (text ? JSON.parse(text) : {}) as {
    Contents?: Array<{ Key?: string; Size?: number }>;
  };
  for (const obj of parsed.Contents ?? []) {
    if (typeof obj.Key !== "string" || !obj.Key.startsWith(args.prefix)) continue;
    const name = obj.Key.slice(args.prefix.length);
    if (name) out.set(name, typeof obj.Size === "number" ? obj.Size : -1);
  }
  return withControl(out, args.prefix);
}

/** The listing, once it is shown to hold the prefix's `annex-uuid` marker. */
function withControl(listing: Map<string, number>, prefix: string): Map<string, number> {
  if (!listing.has("annex-uuid")) {
    throw new Error(
      `the listing of ${prefix} holds no annex-uuid object, so it cannot be told from an empty or partial one`,
    );
  }
  return listing;
}

// ---------------------------------------------------------------------------------------
// The git-annex branch: remote.log and version pins
// ---------------------------------------------------------------------------------------

/** `remote.log` of a clone's git-annex branch; "" when the branch has none. */
export async function readRemoteLog(repo: string): Promise<string> {
  const spec = "refs/heads/git-annex:remote.log";
  return (await readBlobs(repo, [spec])).get(spec)?.toString("utf8") ?? "";
}

/**
 * The S3 version pins upstream's git-annex branch records for each key (`<key>.log.rmet`), parsed
 * by `parseRmet` against its `remote.log`, as `readPinnedSources` parses them; read by computed
 * path through the guard, so a key whose log name git-annex escapes is found too. A key whose
 * record is absent, or whose blob the clone lacks, has no pin, which refuses the plan as unpinned.
 */
export async function readPinsAt(
  repo: string,
  keys: string[],
): Promise<Map<string, PinnedSource[]>> {
  const pins = new Map<string, PinnedSource[]>();
  if (keys.length === 0) return pins;
  const remotes = parseRemoteLog(await readRemoteLog(repo));
  const specOf = (k: string) =>
    `refs/heads/git-annex:${hashDirLower(k)}${annexKeyFile(k)}.log.rmet`;
  const bodies = await readBlobs(repo, keys.map(specOf));
  for (const key of keys) {
    const body = bodies.get(specOf(key));
    if (!body) continue;
    const parsed = parseRmet(body.toString("utf8"), remotes);
    if (parsed.length > 0) pins.set(key, parsed);
  }
  return pins;
}
