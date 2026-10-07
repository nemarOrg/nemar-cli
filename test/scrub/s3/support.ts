/**
 * Shared fixtures for the S3 scrub tests: EDF and BDF files built byte for byte to the layout,
 * a runner that executes the REAL `scripts/scrub/s3/s3-scrub.ts` with the REAL `aws` CLI against
 * the local S3 stand-in, and a builder that carries a dataset through plan, hash and assemble.
 *
 * Every name, date and code below is invented. The headers carry them on purpose, so a test can
 * look for them in whatever a stage printed or wrote and fail if one appears.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "bun";
import {
  type HashesFile,
  type PlanFile,
  buildKey,
  parseGitVerified,
} from "../../../scripts/scrub/contract";
import { type S3Ctx, TempArea, createAwsRunner } from "../../../scripts/scrub/s3/s3-lib";
import {
  TEST_LOOPBACK_PUBLIC_BASE_ENV,
  parseHashVerified,
} from "../../../scripts/scrub/s3/s3-stages";
import type { S3Standin } from "../helpers/s3-standin";
import { makeTempDir, removeTempDirs } from "../helpers/temp-dirs";

/**
 * Every directory this module makes is recorded in one registry; a test file that uses it calls
 * `afterAll(removeTempDirs)` so its directories are removed when it ends (helpers/temp-dirs.ts).
 */
export { removeTempDirs };

export const BUCKET = "nemar";
export const DATASET = "xx090411";
export const SCRIPT = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "scripts",
  "scrub",
  "s3",
  "s3-scrub.ts",
);
export const REPO_ROOT = path.join(import.meta.dir, "..", "..", "..");

/** bun:test gives a test five seconds unless it is told otherwise; these spawn the real CLI. */
export const SLOW = 240_000;

export const MIB = 1024 * 1024;

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------
// EDF and BDF bytes.
// ---------------------------------------------------------------------------

export interface HeaderSpec {
  family?: "edf" | "bdf";
  patient: string;
  recording: string;
  startdate?: string;
}

function put(out: Uint8Array, start: number, width: number, text: string): void {
  out.fill(0x20, start, start + width);
  for (let i = 0; i < Math.min(text.length, width); i++) out[start + i] = text.charCodeAt(i);
}

/** A 256-byte EDF or BDF header laid out field by field. */
export function edfHeader(spec: HeaderSpec): Uint8Array {
  const h = new Uint8Array(256).fill(0x20);
  if (spec.family === "bdf") {
    h[0] = 0xff;
    put(h, 1, 7, "BIOSEMI");
  } else {
    put(h, 0, 8, "0");
  }
  put(h, 8, 80, spec.patient);
  put(h, 88, 80, spec.recording);
  put(h, 168, 8, spec.startdate ?? "02.02.20");
  put(h, 176, 8, "10.30.00");
  put(h, 184, 8, "256");
  put(h, 192, 44, spec.family === "bdf" ? "24BIT" : "EDF+C");
  put(h, 236, 8, "-1");
  put(h, 244, 8, "1");
  put(h, 252, 4, "1");
  return h;
}

/** The header, then a deterministic xorshift payload up to `size` bytes. */
export function edfFile(header: Uint8Array, size: number, seed: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set(header, 0);
  let x = seed >>> 0 || 1;
  for (let i = header.length; i < size; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = (x >>> 8) & 0xff;
  }
  return out;
}

/** The original with fields 8..88 and 88..168 replaced by plain text: built without the scrub. */
export function withFields(
  original: Uint8Array,
  fields: { patient?: string; recording?: string },
): Uint8Array {
  const out = original.slice();
  if (fields.patient !== undefined) put(out, 8, 80, fields.patient);
  if (fields.recording !== undefined) put(out, 88, 80, fields.recording);
  return out;
}

export const NAMES = [
  "Marigold",
  "Thistlewood",
  "Hieronymus",
  "Bellweather",
  "Wilhelmina",
  "Fairweather",
  "Cornelius",
  "Ashworth",
  "Persephone",
  "Quillfeather",
];

export interface Fixture {
  label: string;
  ext: string;
  /** The path a manifest lists the file under. */
  filePath: string;
  bytes: Uint8Array;
  oldKey: string;
  /** What the scrub must produce, built independently; null when the file is already clean. */
  expected: Uint8Array | null;
  newKey: string | null;
}

export function makeFixture(
  label: string,
  ext: string,
  filePath: string,
  bytes: Uint8Array,
  scrubbed: { patient?: string; recording?: string } | null,
): Fixture {
  const expected = scrubbed ? withFields(bytes, scrubbed) : null;
  return {
    label,
    ext,
    filePath,
    bytes,
    oldKey: buildKey(bytes.length, sha256(bytes), ext),
    expected,
    newKey: expected ? buildKey(bytes.length, sha256(expected), ext) : null,
  };
}

const OLD_RECORDING_OK = "Startdate 02-FEB-2020 X X X";

/** A: small EDF, a name in the patient field. Single put-object. */
export const fixtureA = () =>
  makeFixture(
    "A",
    ".edf",
    "sub-01/eeg/sub-01_task-rest_eeg.edf",
    edfFile(
      edfHeader({
        patient: "P0042 F 03-JUL-1971 Marigold_Thistlewood",
        recording: OLD_RECORDING_OK,
      }),
      300 * 1024 + 17,
      11,
    ),
    { patient: "X X X X" },
  );

/** B: BDF with the patient and the recording technician named; the upper-case path suffix. */
export const fixtureB = () =>
  makeFixture(
    "B",
    ".bdf",
    "sub-02/eeg/sub-02_task-rest_eeg.BDF",
    edfFile(
      edfHeader({
        family: "bdf",
        patient: "Hieronymus Bellweather",
        recording: "Startdate 14-MAR-2021 EMG1234 Wilhelmina_Fairweather BIOSEMI",
        startdate: "14.03.21",
      }),
      700 * 1024 + 5,
      22,
    ),
    { patient: "X X X X", recording: "Startdate 14-MAR-2021 X X X" },
  );

/** C: EDF of about 20 MiB. Multipart: an 8 MiB patched part and a server-side copy of the rest. */
export const fixtureC = () =>
  makeFixture(
    "C",
    ".edf",
    "sub-03/eeg/sub-03_task-rest_eeg.edf",
    edfFile(
      edfHeader({ patient: "P0077 M 21-NOV-1966 Cornelius_Ashworth", recording: OLD_RECORDING_OK }),
      20 * MIB + 123,
      33,
    ),
    { patient: "X X X X" },
  );

/** D: already clean. Nothing to scrub. */
export const fixtureD = () =>
  makeFixture(
    "D",
    ".edf",
    "sub-04/eeg/sub-04_task-rest_eeg.edf",
    edfFile(edfHeader({ patient: "X X X X", recording: "Startdate X X X X" }), 200 * 1024 + 3, 44),
    null,
  );

/** E: 9 MiB, between the single-put limit and 13 MiB: a multipart upload that is one part. */
export const fixtureE = () =>
  makeFixture(
    "E",
    ".edf",
    "sub-05/eeg/sub-05_task-rest_eeg.edf",
    edfFile(
      edfHeader({
        patient: "P0101 F 09-SEP-1980 Persephone_Quillfeather",
        recording: OLD_RECORDING_OK,
      }),
      9 * MIB + 5,
      55,
    ),
    { patient: "X X X X" },
  );

// ---------------------------------------------------------------------------
// Seeding a stand-in the way production looks.
// ---------------------------------------------------------------------------

/** 100 years out: the retention every real object carries. */
export const centuryFromNow = () => new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000);

export const objectPath = (key: string, dataset = DATASET) => `${dataset}/objects/${key}`;

export interface SeedOptions {
  contentType?: string;
  sse?: string;
  /** Extra older versions of the same key before the current one. */
  olderVersions?: number;
  /** A delete marker on top, then a re-upload on top of that (so the key ends current). */
  marker?: boolean;
}

export function seedObject(
  standin: S3Standin,
  f: Fixture,
  opts: SeedOptions = {},
  dataset = DATASET,
): string[] {
  const key = objectPath(f.oldKey, dataset);
  const ids: string[] = [];
  const put = () =>
    standin.putObject(BUCKET, key, f.bytes, {
      lockUntil: centuryFromNow(),
      contentType: opts.contentType,
      sse: opts.sse,
    });
  for (let i = 0; i < (opts.olderVersions ?? 0); i++) ids.push(put());
  if (opts.marker) ids.push(standin.putDeleteMarker(BUCKET, key));
  ids.push(put());
  return ids;
}

export function seedManifest(
  standin: S3Standin,
  tag: string,
  fixtures: Fixture[],
  extra: Record<string, { key: string; size: number }> = {},
  dataset = DATASET,
  /** Name each scrubbed file by its NEW key, as a regenerated manifest does (runbook step 12). */
  afterScrub = false,
): void {
  const files: Record<string, { key: string; size: number; checksum: string }> = {};
  for (const f of fixtures) {
    const key = afterScrub && f.newKey ? f.newKey : f.oldKey;
    files[f.filePath] = { key, size: f.bytes.length, checksum: "unused" };
  }
  for (const [p, e] of Object.entries(extra)) files[p] = { ...e, checksum: "unused" };
  const body = JSON.stringify({ dataset_id: dataset, version: tag, files });
  standin.putObject(BUCKET, `${dataset}/version/${tag}.json`, new TextEncoder().encode(body));
}

// ---------------------------------------------------------------------------
// Running the real CLI.
// ---------------------------------------------------------------------------

// Shared by every file of the run (the module is evaluated once), and made again after a file's
// `removeTempDirs` removed it.
let isolatedHome: string | undefined;
function home(): string {
  if (!isolatedHome || !existsSync(isolatedHome)) {
    isolatedHome = makeTempDir("s3-scrub-test-home-");
    writeFileSync(path.join(isolatedHome, "config"), "");
    writeFileSync(path.join(isolatedHome, "credentials"), "");
  }
  return isolatedHome;
}

// The children's TMPDIR: a recorded directory under the run's own temp directory, so what a
// child leaves there (a stage's temp area when a test kills it, Python's or the aws CLI's temp
// files) follows a run pointed at another disk with TMPDIR, and is removed with the file's.
let childTmp: string | undefined;
function childTmpDir(): string {
  if (!childTmp || !existsSync(childTmp)) childTmp = makeTempDir("s3-scrub-child-tmp-");
  return childTmp;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr together, for "no value anywhere" checks and failure messages. */
  all: string;
}

/**
 * The whole environment a child gets: dummy short-lived credentials, a private HOME and config,
 * and the stand-in as the only endpoint. Bun's spawn `env` REPLACES the environment, so nothing
 * of the developer's real AWS setup can reach the child. `AWS_DEFAULT_REGION` is deliberately
 * unset, so the code under test must pass `--region` itself.
 */
export function awsTestEnv(
  standin: S3Standin,
  extra: Record<string, string> = {},
): Record<string, string> {
  const h = home();
  return {
    PATH: process.env.PATH ?? "",
    HOME: h,
    AWS_ACCESS_KEY_ID: "ASIATESTDUMMY000001",
    AWS_SECRET_ACCESS_KEY: "dummySecretAccessKeyForScrubS3Test",
    AWS_SESSION_TOKEN: "dummySessionTokenForScrubS3Test",
    AWS_CONFIG_FILE: path.join(h, "config"),
    AWS_SHARED_CREDENTIALS_FILE: path.join(h, "credentials"),
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    AWS_ENDPOINT_URL_S3: standin.url,
    TMPDIR: childTmpDir(),
    // The anonymous requests of delete-old and zarr-public go to a loopback server in every test
    // (`startPublicEndpoint`); outside a test the stages accept only the bucket's S3 endpoint.
    [TEST_LOOPBACK_PUBLIC_BASE_ENV]: "1",
    ...extra,
  };
}

/**
 * The last requests the stand-in answered, as `op status key` lines (no body, no header): what a
 * failing assertion prints next to the CLI's own output, so a failure that happens once in a
 * hundred runs says what the server saw.
 */
export function logTail(standin: S3Standin, n = 15): string {
  return standin.log
    .slice(-n)
    .map((e) => `${e.op} ${e.status} ${e.key}${e.versionId ? ` v=${e.versionId}` : ""}`)
    .join("\n");
}

/** A CLI result and the stand-in's log tail, for an assertion's message. */
export const diag = (r: RunResult, standin: S3Standin): string =>
  `${r.all}\n--- stand-in log tail ---\n${logTail(standin)}`;

/** Every delete request the stand-in has seen, single or batch: what a read-only stage must not send. */
export function deleteRequests(standin: S3Standin): number {
  return standin.calls("DeleteObject").length + standin.calls("DeleteObjects").length;
}

/**
 * What the DeleteObjects requests named, in order, one row per version, with whether the request
 * carried the governance bypass. The batch stages send these; `calls("DeleteObject")` is empty
 * for them.
 */
export function batchDeleted(
  standin: S3Standin,
): Array<{ key: string; versionId: string | null; bypass: boolean }> {
  return standin
    .calls("DeleteObjects")
    .flatMap((c) => (c.items ?? []).map((it) => ({ ...it, bypass: c.bypass === true })));
}

/** A library context (runner and temp area) wired to a stand-in, for tests of the operations. */
export async function withCtx<T>(
  standin: S3Standin,
  fn: (ctx: S3Ctx) => Promise<T>,
  bucket = BUCKET,
  timeoutMs = 60_000,
): Promise<T> {
  const tmp = await TempArea.create();
  try {
    const aws = createAwsRunner({
      region: "us-east-2",
      endpointUrl: standin.url,
      timeoutMs,
      env: awsTestEnv(standin),
    });
    return await fn({ aws, bucket, tmp });
  } finally {
    await tmp.dispose();
  }
}

/**
 * Run `bun scripts/scrub/s3/s3-scrub.ts <args>` against a stand-in. The child is spawned async:
 * the stand-in lives on this process's event loop, and a synchronous spawn would deadlock it.
 */
export async function runScrub(
  standin: S3Standin,
  args: string[],
  extraEnv: Record<string, string> = {},
  opts: { anyPublicBase?: boolean } = {},
): Promise<RunResult> {
  // delete-old and zarr-public make anonymous requests to a public base URL. A test that forgot
  // to point one at a local server would reach the real network, so the runner refuses to start
  // it, unless the test says the stage must refuse that base before any request
  // (`anyPublicBase`, for the tests of that refusal).
  if ((args[0] === "delete-old" || args[0] === "zarr-public") && !opts.anyPublicBase) {
    const base = args[args.indexOf("--public-base") + 1] ?? "";
    if (!/^http:\/\/127\.0\.0\.1:\d+/.test(base)) {
      throw new Error("a delete-old test must pass --public-base with a local server");
    }
  }
  const proc = spawn({
    cmd: ["bun", SCRIPT, ...args],
    cwd: REPO_ROOT,
    env: awsTestEnv(standin, extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr, all: `${stdout}\n${stderr}` };
}

export const HASH_STAGE = path.join(REPO_ROOT, "scripts", "scrub", "hash", "hash_stage.py");

/**
 * The REAL Python hash stage with its default source (the real `aws` CLI) pointed at the
 * stand-in, with no retries, so a failing read fails at once.
 */
export async function runHashStage(
  standin: S3Standin,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  const proc = spawn({
    cmd: ["python3", HASH_STAGE, ...args, "--retries", "0", "--retry-backoff", "0"],
    env: awsTestEnv(standin, {
      AWS_DEFAULT_REGION: "us-east-2",
      PYTHONDONTWRITEBYTECODE: "1",
      ...extraEnv,
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr, all: `${stdout}\n${stderr}` };
}

// ---------------------------------------------------------------------------
// A stand-in for what an anonymous reader reaches.
// ---------------------------------------------------------------------------

export interface PublicRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
}

export interface PublicEndpoint {
  /** Value for `--public-base`. */
  url: string;
  /** The status every request is answered with; 403 is a private dataset. */
  status: number;
  /**
   * When set, a GET is answered as the public bucket answers an anonymous reader of a PUBLIC
   * dataset: 200 with the current bytes of the key the path names, or 403 when there are none
   * (the bucket denies anonymous listing, so a missing key is 403, not 404).
   */
  serve: ((key: string) => Uint8Array | undefined) | null;
  requests: PublicRequest[];
  reset(): void;
  stop(): void;
}

/**
 * A tiny real HTTP server standing in for the public bucket URL. It answers every request with
 * `status` and keeps what it was sent, so a test can check the request was an anonymous HEAD of
 * the right key and that the stage acted on the answer.
 */
export function startPublicEndpoint(): PublicEndpoint {
  const ep: PublicEndpoint = {
    url: "",
    status: 403,
    serve: null,
    requests: [],
    reset() {
      ep.status = 403;
      ep.serve = null;
      ep.requests.length = 0;
    },
    stop() {
      server.stop(true);
    },
  };
  const server = Bun.serve({
    port: 0,
    // 127.0.0.1, not the default: a wildcard bind (`*:port`, IPv6 dual-stack) lets another
    // process on the machine bind 127.0.0.1:<same port> and take every connection the test makes
    // to 127.0.0.1 (measured on macOS: the "404 in 2 ms" and "401" flakes were other local
    // servers answering). A specific bind refuses that second bind (EADDRINUSE).
    hostname: "127.0.0.1",
    fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const pathname = new URL(req.url).pathname;
      ep.requests.push({ method: req.method, path: pathname, headers });
      if (ep.serve && req.method === "GET") {
        const bytes = ep.serve(decodeURIComponent(pathname.slice(1)));
        return bytes ? new Response(bytes, { status: 200 }) : new Response(null, { status: 403 });
      }
      return new Response(null, { status: ep.status });
    },
  });
  ep.url = `http://127.0.0.1:${server.port}`;
  return ep;
}

// ---------------------------------------------------------------------------
// Working directories and the pipeline.
// ---------------------------------------------------------------------------

export function tempDir(label: string): string {
  return makeTempDir(`s3-scrub-${label}-`);
}

export function readJson<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(path.join(dir, name), "utf8")) as T;
}

export function writeJson(dir: string, name: string, value: unknown): void {
  writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Reviewer probe T2: add to plan.json one key the plan could not read, with totals that agree, so
 * the file still parses and only the rule that a plan must be complete can refuse it. The key is
 * not one any other file names, so no later cross-check refuses the plan for another reason.
 */
export function addUnreadableKey(dir: string): void {
  const plan = readJson<PlanFile>(dir, "plan.json");
  plan.keys.push({
    oldKey: buildKey(4096, "f".repeat(64), ".edf"),
    size: 4096,
    needsScrub: false,
    versionIds: [],
    reasons: ["HeadObject:access-denied"],
    status: "unreadable",
  });
  plan.totals.keys += 1;
  plan.totals.unreadable += 1;
  writeJson(dir, "plan.json", plan);
}

export const fileSha256 = (dir: string, name: string): string =>
  sha256(readFileSync(path.join(dir, name)));

/**
 * Bind plan.json to the patches.json in `dir` as the plan stage does (`patchesSha256`), for a
 * test that rewrote patches.json on purpose and means to reach the check after that binding.
 */
export function rebindPatches(dir: string): void {
  const plan = readJson<PlanFile>(dir, "plan.json");
  plan.patchesSha256 = fileSha256(dir, "patches.json");
  writeJson(dir, "plan.json", plan);
}

/**
 * The proof `git-scrub verify --fresh-clone` leaves (`git-verified.json`), for the keymap.json
 * and plan.json in `dir` as they are now. The git tests produce the real one with the real tool;
 * the S3 tests stand in for that run here, through the contract's own parser.
 */
export function writeGitVerified(
  dir: string,
  over: Partial<{
    mode: string;
    keymapSha256: string;
    gitPlanSha256: string;
    s3PlanSha256: string;
    dataset: string;
    allowedTags: string[];
  }> = {},
): void {
  const proof = {
    version: 1,
    dataset: readJson<PlanFile>(dir, "plan.json").dataset,
    mode: "fresh-clone",
    verifiedAt: new Date().toISOString(),
    keymapSha256: fileSha256(dir, "keymap.json"),
    gitPlanSha256: "a".repeat(64),
    s3PlanSha256: fileSha256(dir, "plan.json"),
    counts: { refs: 3, commits: 3 },
    ...over,
  };
  parseGitVerified(JSON.stringify(proof));
  writeJson(dir, "git-verified.json", proof);
}

/**
 * The proof `hash_stage.py verify-new` leaves on the hash host (`new-hash-verified.json`), for the
 * assembled.json in `dir` as it is now. The pipeline test produces the real one with the real
 * stage; the S3 tests stand in for that run here, through the contract's own parser.
 */
export function writeHashVerified(
  dir: string,
  over: Partial<{ assembledSha256: string; dataset: string; count: number }> = {},
): void {
  const assembled = readJson<{ dataset: string; entries: Record<string, unknown> }>(
    dir,
    "assembled.json",
  );
  const proof = {
    version: 1,
    dataset: assembled.dataset,
    assembledSha256: fileSha256(dir, "assembled.json"),
    count: Object.keys(assembled.entries).length,
    ...over,
  };
  parseHashVerified(JSON.stringify(proof));
  writeJson(dir, "new-hash-verified.json", proof);
}

export function copyDir(from: string): string {
  const to = tempDir("copy");
  cpSync(from, to, { recursive: true });
  return to;
}

export const has = (dir: string, name: string): boolean => existsSync(path.join(dir, name));

/** Every file in a directory, as text, for scanning. */
export function dirText(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return readdirSync(dir)
    .map((n) => readFileSync(path.join(dir, n), "utf8"))
    .join("\n");
}

/** True when any invented name appears in `text`, as text or as hex. */
export function leaksAName(text: string): string | null {
  const lower = text.toLowerCase();
  for (const n of NAMES) {
    if (lower.includes(n.toLowerCase())) return n;
    if (lower.includes(Buffer.from(n).toString("hex"))) return n;
  }
  return null;
}

/** The test standing in for the hashing host: the key each scrubbed file gets. */
export function writeHashes(dir: string, fixtures: Fixture[], dataset = DATASET): void {
  const entries: HashesFile["entries"] = {};
  for (const f of fixtures) {
    if (f.newKey && f.expected) {
      entries[f.oldKey] = {
        newKey: f.newKey,
        size: f.bytes.length,
        sourceSha256Verified: true,
        // The binding to the patch, computed here from the independently built expected header.
        patchSha256: sha256(Buffer.from(Buffer.from(f.expected.subarray(0, 256)).toString("hex"))),
      };
    }
  }
  writeJson(dir, "hashes.json", { version: 1, dataset, entries });
}

export const planArgs = (dir: string, extra: string[] = []) => [
  "plan",
  "--dataset",
  DATASET,
  "--out",
  dir,
  "--concurrency",
  "8",
  ...extra,
];

export const assembleArgs = (dir: string, extra: string[] = []) => [
  "assemble",
  "--dir",
  dir,
  "--execute",
  "--concurrency",
  "8",
  ...extra,
];

export const verifyArgs = (dir: string, extra: string[] = []) => [
  "verify",
  "--dir",
  dir,
  "--concurrency",
  "8",
  ...extra,
];

export interface Assembled {
  dir: string;
  fixtures: Fixture[];
}

/** Seed `fixtures`, then run plan, write hashes, and assemble through the real CLI. */
export async function buildAssembled(
  standin: S3Standin,
  fixtures: Fixture[],
  seed: Record<string, SeedOptions> = {},
  assembleExtra: string[] = [],
): Promise<Assembled> {
  for (const f of fixtures) seedObject(standin, f, seed[f.label] ?? {});
  seedManifest(standin, "v1.0.0", fixtures);
  const dir = tempDir("pipeline");
  const plan = await runScrub(standin, planArgs(dir));
  if (plan.exitCode !== 0) throw new Error(`plan failed: ${plan.all}`);
  writeHashes(dir, fixtures);
  const assemble = await runScrub(standin, assembleArgs(dir, assembleExtra));
  if (assemble.exitCode !== 0) throw new Error(`assemble failed: ${assemble.all}`);
  return { dir, fixtures };
}
