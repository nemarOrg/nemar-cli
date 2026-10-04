/**
 * Shared fixtures for the S3 scrub tests: EDF and BDF files built byte for byte to the layout,
 * a runner that executes the REAL `scripts/scrub/s3/s3-scrub.ts` with the REAL `aws` CLI against
 * the local S3 stand-in, and a builder that carries a dataset through plan, hash and assemble.
 *
 * Every name, date and code below is invented. The headers carry them on purpose, so a test can
 * look for them in whatever a stage printed or wrote and fail if one appears.
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "bun";
import { buildKey } from "../../../scripts/scrub/contract";
import { type S3Ctx, TempArea, createAwsRunner } from "../../../scripts/scrub/s3/s3-lib";
import type { S3Standin } from "../helpers/s3-standin";

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
): void {
  const files: Record<string, { key: string; size: number; checksum: string }> = {};
  for (const f of fixtures) {
    files[f.filePath] = { key: f.oldKey, size: f.bytes.length, checksum: "unused" };
  }
  for (const [p, e] of Object.entries(extra)) files[p] = { ...e, checksum: "unused" };
  const body = JSON.stringify({ dataset_id: dataset, version: tag, files });
  standin.putObject(BUCKET, `${dataset}/version/${tag}.json`, new TextEncoder().encode(body));
}

// ---------------------------------------------------------------------------
// Running the real CLI.
// ---------------------------------------------------------------------------

let isolatedHome: string | undefined;
function home(): string {
  if (!isolatedHome) {
    isolatedHome = mkdtempSync(path.join(tmpdir(), "s3-scrub-test-home-"));
    writeFileSync(path.join(isolatedHome, "config"), "");
    writeFileSync(path.join(isolatedHome, "credentials"), "");
  }
  return isolatedHome;
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
    ...extra,
  };
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
): Promise<RunResult> {
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

// ---------------------------------------------------------------------------
// Working directories and the pipeline.
// ---------------------------------------------------------------------------

export function tempDir(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `s3-scrub-${label}-`));
}

export function readJson<T>(dir: string, name: string): T {
  return JSON.parse(readFileSync(path.join(dir, name), "utf8")) as T;
}

export function writeJson(dir: string, name: string, value: unknown): void {
  writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

export const fileSha256 = (dir: string, name: string): string =>
  sha256(readFileSync(path.join(dir, name)));

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
  const entries: Record<string, { newKey: string; size: number; sourceSha256Verified: boolean }> =
    {};
  for (const f of fixtures) {
    if (f.newKey) {
      entries[f.oldKey] = { newKey: f.newKey, size: f.bytes.length, sourceSha256Verified: true };
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
