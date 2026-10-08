/**
 * The publication-time identifier screen (`scripts/identifier-screen-ci.ts` and its library).
 *
 * Every screening test runs the REAL script as a subprocess against a REAL git repository built
 * in a temp directory, with two `Bun.serve` stand-ins: an S3 endpoint that verifies the SigV4
 * signature of every presigned URL it is sent (a wrong signature is a 403, so a signer that
 * drifted fails here, not in production) and serves `Range` the way S3 does, and the Worker's
 * callback. Nothing is mocked: a header is read from real bytes by the real scanner.
 *
 * Each flagged case has a clean twin that differs in one thing, because a screen that flags (or
 * passes) everything also passes a one-sided test. The privacy test captures ALL output of a run
 * over a dataset whose header, paths and sidecars carry a distinctive name and asserts the name,
 * the tokens and the signatures appear nowhere.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type FleetContext,
  ReadFailure,
  createContext,
  scanDatasetFromManifest,
} from "../scripts/identifier-fleet-lib";
import {
  GitBlobReader,
  type HistoryWalk,
  OTHER_FORMAT,
  type ScreenConfig,
  ScreenUsageError,
  type Tree,
  cloneMetadata,
  deliverReport,
  finalizeScanReport,
  findSuperseded,
  foldOddFailures,
  foldOddFormats,
  listTree,
  objectSizes,
  parseAnnexPointer,
  parseScreenConfig,
  prefetchBlobs,
  runScreen,
  walkHistory,
} from "../scripts/identifier-screen-ci-lib";
import {
  type DatasetRecord,
  type ScreenReport,
  parseScreenReport,
} from "../shared/identifier-screen-report";

// ---------------------------------------------------------------------------------------
// EDF and BDF headers, built byte for byte from INVENTED values
// ---------------------------------------------------------------------------------------

function put(out: Uint8Array, text: string, start: number, width: number): void {
  out.fill(0x20, start, start + width);
  out.set(new TextEncoder().encode(text).subarray(0, width), start);
}

function edfHeader(patient = "P01 F X X", family: "edf" | "bdf" = "edf"): Uint8Array {
  const out = new Uint8Array(256).fill(0x20);
  if (family === "bdf") {
    out[0] = 0xff;
    out.set(new TextEncoder().encode("BIOSEMI"), 1);
  } else {
    put(out, "0", 0, 8);
  }
  put(out, patient, 8, 80);
  put(out, "Startdate X X X X", 88, 80);
  put(out, "01.01.85", 168, 8);
  put(out, "00.00.00", 176, 8);
  put(out, "256", 184, 8);
  put(out, "-1", 236, 8);
  put(out, "1", 244, 8);
  put(out, "0", 252, 4);
  return out;
}

/** A recording: a header and then signal bytes, so it is bigger than any pointer file. */
function recording(patient?: string, family: "edf" | "bdf" = "edf"): Uint8Array {
  const out = new Uint8Array(2000);
  out.set(edfHeader(patient, family));
  return out;
}

const CLEAN = "P01 F X X";
const named = (n: number) => `P0${n} F X Quillfeather`;
const NAME = "Quillfeather";

// ---------------------------------------------------------------------------------------
// A real git repository
// ---------------------------------------------------------------------------------------

const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  LC_ALL: "C",
};

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.toString().slice(0, 200)}`);
  }
  return result.stdout.toString().trim();
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const scratch: string[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `screen-${label}-`));
  scratch.push(dir);
  return dir;
}

class Repo {
  readonly dir = tempDir("repo");

  constructor() {
    git(this.dir, "init", "-q", "-b", "main");
    git(this.dir, "config", "user.name", "Test");
    git(this.dir, "config", "user.email", "test@example.invalid");
    git(this.dir, "config", "uploadpack.allowFilter", "true");
    git(this.dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  }

  get origin(): string {
    return `file://${this.dir}`;
  }

  file(path: string, content: string | Uint8Array): this {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return this;
  }

  /** A symlink committed as a symlink: how a locked git-annex stores its files. */
  link(path: string, target: string): this {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    symlinkSync(target, full);
    return this;
  }

  /**
   * An annexed file: its bytes go to the S3 stand-in under `<id>/objects/<key>`, and the tree
   * holds a symlink (locked) or a pointer file (unlocked). `keyExt` is the key's extension,
   * which a rename after `git annex add` leaves different from the path's.
   */
  annexed(
    path: string,
    bytes: Uint8Array,
    s3: S3StandIn,
    how: "symlink" | "pointer" = "symlink",
    keyExt?: string,
    declaredSize?: number,
  ): string {
    const ext = keyExt ?? path.slice(path.lastIndexOf("."));
    const key = `SHA256E-s${declaredSize ?? bytes.length}--${sha256(bytes)}${ext}`;
    s3.objects.set(`${ID}/objects/${key}`, { bytes });
    if (how === "symlink") {
      const depth = path.split("/").length - 1;
      this.link(path, `${"../".repeat(depth)}.git/annex/objects/Xz/Qk/${key}/${key}`);
    } else {
      this.file(path, `/annex/objects/${key}\n`);
    }
    return key;
  }

  remove(path: string): this {
    rmSync(join(this.dir, path), { force: true });
    return this;
  }

  commit(message = "c"): string {
    git(this.dir, "add", "-A");
    git(this.dir, "commit", "-q", "--allow-empty", "-m", message);
    return git(this.dir, "rev-parse", "HEAD");
  }

  /** Commit one file on a new root branch, then return to `main`. */
  orphanBranch(name: string, path: string, content: string): void {
    git(this.dir, "checkout", "-q", "--orphan", name);
    git(this.dir, "rm", "-rqf", "--ignore-unmatch", ".");
    this.file(path, content);
    this.commit(`on ${name}`);
    git(this.dir, "checkout", "-q", "main");
  }
}

// ---------------------------------------------------------------------------------------
// The S3 stand-in: verifies every presigned URL, serves Range like S3
// ---------------------------------------------------------------------------------------

const ID = "nm000186";
const ACCESS_KEY = "AKIATESTEXAMPLE00000";
const SECRET_KEY = "test-secret-access-key-0123456789abcdef";

interface S3Object {
  bytes: Uint8Array;
  /** Answer with this status and no body. */
  status?: number;
  delayMs?: number;
  /** Answer the first `n` requests with `status`, then serve normally. */
  failFirst?: { n: number; status: number };
}

const uriEncode = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const hmac = (key: string | Uint8Array, data: string) =>
  createHmac("sha256", key).update(data).digest();

class S3StandIn {
  readonly objects = new Map<string, S3Object>();
  readonly requests: { key: string; range: string | null; signed: boolean; expires: number }[] = [];
  readonly signatures = new Set<string>();
  maxInflight = 0;
  private inflight = 0;
  private readonly hits = new Map<string, number>();
  private readonly server: ReturnType<typeof Bun.serve>;
  readonly url: string;

  constructor(private secret = SECRET_KEY) {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => this.handle(req) });
    this.url = `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  reset(): void {
    this.objects.clear();
    this.requests.length = 0;
    this.signatures.clear();
    this.hits.clear();
    this.maxInflight = 0;
  }

  /** SigV4 query authentication, checked the way S3 checks it. */
  private verify(req: Request, url: URL): boolean {
    const q = url.searchParams;
    const claimed = q.get("X-Amz-Signature");
    const credential = q.get("X-Amz-Credential");
    const amzDate = q.get("X-Amz-Date");
    const signedHeaders = q.get("X-Amz-SignedHeaders");
    if (!claimed || !credential || !amzDate || !signedHeaders) return false;
    if (q.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256") return false;
    const [accessKey, day, region, service, term] = credential.split("/");
    if (accessKey !== ACCESS_KEY || service !== "s3" || term !== "aws4_request") return false;
    const issued = Date.parse(
      `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T` +
        `${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
    );
    const lifetime = Number(q.get("X-Amz-Expires")) * 1000;
    if (!(Date.now() >= issued - 60_000 && Date.now() <= issued + lifetime)) return false;
    const params = [...q.entries()]
      .filter(([k]) => k !== "X-Amz-Signature")
      .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const canonicalHeaders = signedHeaders
      .split(";")
      .map((h) => `${h}:${(req.headers.get(h) ?? "").trim()}\n`)
      .join("");
    const canonical = [
      "GET",
      url.pathname,
      params.map(([k, v]) => `${k}=${v}`).join("&"),
      canonicalHeaders,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const scope = `${day}/${region}/${service}/${term}`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.secret}`, day as string), region as string), service),
      term,
    );
    return createHmac("sha256", signingKey).update(toSign).digest("hex") === claimed;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
    const signed = this.verify(req, url);
    this.requests.push({
      key,
      range: req.headers.get("range"),
      signed,
      expires: Number(url.searchParams.get("X-Amz-Expires")),
    });
    const signature = url.searchParams.get("X-Amz-Signature");
    if (signature) this.signatures.add(signature);
    if (!signed) return new Response("SignatureDoesNotMatch", { status: 403 });
    const object = this.objects.get(key);
    if (!object) return new Response("NoSuchKey", { status: 404 });
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      if (object.delayMs) await Bun.sleep(object.delayMs);
      const seen = (this.hits.get(key) ?? 0) + 1;
      this.hits.set(key, seen);
      if (object.failFirst && seen <= object.failFirst.n) {
        return new Response("", { status: object.failFirst.status });
      }
      if (object.status) return new Response("AccessDenied", { status: object.status });
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "");
      if (!range) return new Response(object.bytes, { status: 200 });
      if (object.bytes.length === 0) return new Response("", { status: 416 });
      const [from, to] = [Number(range[1]), Number(range[2])];
      const slice = object.bytes.slice(from, to + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${from}-${from + slice.length - 1}/${object.bytes.length}`,
        },
      });
    } finally {
      this.inflight--;
    }
  }
}

// ---------------------------------------------------------------------------------------
// The callback stand-in
// ---------------------------------------------------------------------------------------

interface Posted {
  token: string | null;
  body: { dataset_id: string; request_id: number; workflow_run_id: string; report: ScreenReport };
}

class CallbackStandIn {
  readonly posted: Posted[] = [];
  statuses: number[] = [];
  private readonly server: ReturnType<typeof Bun.serve>;
  readonly url: string;

  constructor() {
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        this.posted.push({
          token: req.headers.get("x-webhook-token"),
          body: (await req.json()) as Posted["body"],
        });
        return new Response("{}", { status: this.statuses.shift() ?? 200 });
      },
    });
    this.url = `http://127.0.0.1:${this.server.port}/webhooks/identifier-screen`;
  }

  stop(): void {
    this.server.stop(true);
  }

  reset(): void {
    this.posted.length = 0;
    this.statuses = [];
  }
}

// ---------------------------------------------------------------------------------------
// Running the real script
// ---------------------------------------------------------------------------------------

const SCRIPT = join(import.meta.dir, "..", "scripts", "identifier-screen-ci.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const TOKEN = "cb-token-5f8a1c9e77d04b3aa6e2";
const GH_TOKEN = "ghs_ExampleInstallationToken0123456789";
const T = 90_000;

const s3 = new S3StandIn();
const callback = new CallbackStandIn();
const outDir = tempDir("out");
let runs = 0;

afterAll(() => {
  s3.stop();
  callback.stop();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

interface RunOver {
  env?: Record<string, string | undefined>;
  args?: string[];
  origin?: string;
  s3Url?: string;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  report: ScreenReport | null;
  posted: Posted[];
  outFile: string;
}

async function runScript(repo: Repo | null, over: RunOver = {}): Promise<RunResult> {
  const outFile = join(outDir, `report-${runs++}.json`);
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DATASET_ID: ID,
    REF: "main",
    REQUEST_ID: "42",
    CALLBACK_URL: callback.url,
    CALLBACK_TOKEN: TOKEN,
    GH_TOKEN,
    AWS_ACCESS_KEY_ID: ACCESS_KEY,
    AWS_SECRET_ACCESS_KEY: SECRET_KEY,
    WORKFLOW_RUN_ID: "123456",
    ...over.env,
  };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      SCRIPT,
      "--clone-origin",
      over.origin ?? (repo as Repo).origin,
      "--s3-endpoint",
      over.s3Url ?? s3.url,
      "--out",
      outFile,
      "--concurrency",
      "4",
      "--callback-backoff-ms",
      "10",
      "--blob-limit",
      "1k",
      ...(over.args ?? []),
    ],
    { env: clean, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let report: ScreenReport | null = null;
  try {
    report = JSON.parse(readFileSync(outFile, "utf8")) as ScreenReport;
  } catch {
    report = null;
  }
  return { code, stdout, stderr, report, posted: [...callback.posted], outFile };
}

function fresh(): void {
  s3.reset();
  callback.reset();
}

/** The scan inside a report that must be a scan. */
function scanOf(result: RunResult): DatasetRecord {
  expect(result.report?.error).toBeUndefined();
  return (result.report as ScreenReport).scan as DatasetRecord;
}

/** A small dataset every case starts from: three storage forms, all clean. */
function cleanDataset(): Repo {
  const repo = new Repo();
  repo
    .file("dataset_description.json", '{"Name":"Example","BIDSVersion":"1.9.0"}')
    .file("participants.tsv", "participant_id\tsex\nsub-01\tF\nsub-02\tM\nsub-03\tF\nsub-04\tM\n")
    .file("README", "An example dataset.\n");
  repo.annexed("sub-01/eeg/sub-01_task-rest_eeg.edf", recording("P01 F X X"), s3, "symlink");
  repo.annexed("sub-02/eeg/sub-02_task-rest_eeg.edf", recording("P02 F X X"), s3, "pointer");
  repo.file("sub-03/eeg/sub-03_task-rest_eeg.edf", recording("P03 F X X"));
  repo.annexed("sub-04/eeg/sub-04_task-rest_eeg.bdf", recording("P04 F X X", "bdf"), s3, "symlink");
  repo.commit("data");
  return repo;
}

// ---------------------------------------------------------------------------------------
// The screen end to end
// ---------------------------------------------------------------------------------------

describe("the screen: what a run reports", () => {
  test(
    "a clean dataset in every storage form is clean, and the callback carries the contract",
    async () => {
      fresh();
      const repo = cleanDataset();
      const head = git(repo.dir, "rev-parse", "HEAD");
      const result = await runScript(repo);

      expect(result.code).toBe(0);
      const scan = scanOf(result);
      expect(scan.status).toBe("clean");
      expect(scan.incomplete).toBe(false);
      expect(scan.incomplete_reasons).toEqual([]);
      expect(scan.manifest_source).toBe("clone");
      expect(scan.id).toBe(ID);
      expect(scan.version).toBeNull();
      expect(scan.files).toEqual({ total: 7, edf_bdf: 4, header_read: 4, header_read_failed: 0 });
      expect(scan.findings_by_kind ?? {}).toEqual({});
      expect(result.report?.head).toBe(head);
      expect(result.report?.scanner).toBe(
        `identifier-scan@${git(REPO_ROOT, "rev-parse", "--short=7", "HEAD")}`,
      );

      // The three annexed files were read in S3 by a verified presigned URL, 256 bytes each;
      // the inline one never left git.
      expect(s3.requests).toHaveLength(3);
      expect(s3.requests.every((r) => r.signed)).toBe(true);
      expect(new Set(s3.requests.map((r) => r.range))).toEqual(new Set(["bytes=0-255"]));
      // Each URL is minted for one read, so it lives 15 minutes and no longer.
      expect(new Set(s3.requests.map((r) => r.expires))).toEqual(new Set([900]));

      // What the Worker receives is the envelope the contract names, with the token header.
      expect(result.posted).toHaveLength(1);
      const [posted] = result.posted as [Posted];
      expect(posted.token).toBe(TOKEN);
      expect(Object.keys(posted.body).sort()).toEqual([
        "dataset_id",
        "report",
        "request_id",
        "workflow_run_id",
      ]);
      expect(posted.body.dataset_id).toBe(ID);
      expect(posted.body.request_id).toBe(42);
      expect(posted.body.workflow_run_id).toBe("123456");
      expect(posted.body.report).toEqual(result.report as ScreenReport);
      expect(parseScreenReport(posted.body.report)).toEqual(posted.body.report);
    },
    T,
  );

  test(
    "a name in a header is found in every storage form, and the clean twin shows none",
    async () => {
      fresh();
      const repo = new Repo();
      repo.annexed("sub-01/eeg/sub-01_task-rest_eeg.edf", recording(named(1)), s3, "symlink");
      repo.annexed("sub-02/eeg/sub-02_task-rest_eeg.edf", recording(named(2)), s3, "pointer");
      // 2000 bytes against a 1 KB clone bound: this blob is left behind by the clone and must
      // be fetched, in a batch, before it can be read.
      repo.file("sub-03/eeg/sub-03_task-rest_eeg.edf", recording(named(3)));
      repo.annexed(
        "sub-04/eeg/sub-04_task-rest_eeg.bdf",
        recording(named(4), "bdf"),
        s3,
        "symlink",
      );
      repo.commit("named");
      const result = await runScript(repo);

      const scan = scanOf(result);
      expect(scan.status).toBe("direct-identifiers");
      expect(scan.files?.header_read).toBe(4);
      expect(scan.edf_bdf_files_flagged).toBe(4);
      expect(scan.findings_by_kind?.["edf-patient-name"]).toBe(4);
      expect(scan.edf_bdf_files_by_kind?.["edf-patient-name"]).toBe(4);
      expect(scan.distinct_subjects_with_edf_bdf).toBe(4);
      expect(JSON.stringify(result.report)).not.toContain(NAME);
    },
    T,
  );

  test(
    "a recording format the scanner cannot parse keeps the dataset out of clean",
    async () => {
      fresh();
      const withEdf = cleanDataset();
      withEdf.file("sub-05/eeg/sub-05_task-rest_eeg.set", "not parsed");
      withEdf.commit("set");
      const first = scanOf(await runScript(withEdf));
      expect(first.status).toBe("clean-edf-only-others-unscreened");
      expect(first.unscreened_formats).toEqual({ ".set": 1 });

      fresh();
      const onlySet = new Repo();
      onlySet.file("sub-01/eeg/sub-01_task-rest_eeg.set", "not parsed").commit("set only");
      const second = scanOf(await runScript(onlySet));
      expect(second.status).toBe("not-screened");
    },
    T,
  );

  test(
    "an unreadable object is unchecked, never clean, and says how it failed",
    async () => {
      fresh();
      const repo = cleanDataset();
      const key = [...s3.objects.keys()][0] as string;
      for (const failure of [403, 404]) {
        s3.objects.set(key, { bytes: new Uint8Array(), status: failure });
        if (failure === 404) s3.objects.delete(key);
        callback.reset();
        const scan = scanOf(await runScript(repo));
        expect(scan.status).toBe("unchecked");
        expect(scan.incomplete).toBe(true);
        expect(scan.incomplete_reasons).toContain("edf-headers-unread");
        expect(scan.files?.header_read).toBe(3);
        expect(scan.files?.header_read_failed).toBe(1);
        expect(scan.read_failures).toEqual({ [`edf/http-${failure}`]: 1 });
      }
      // The same dataset with every object readable is clean: the failure was the cause.
      fresh();
      expect(scanOf(await runScript(cleanDataset())).status).toBe("clean");
    },
    T,
  );

  test(
    "an empty object, a short object and a wrong signature are each unread",
    async () => {
      fresh();
      const repo = new Repo();
      repo.annexed("sub-01/eeg/sub-01_task-rest_eeg.edf", new Uint8Array(), s3, "symlink");
      repo.annexed("sub-02/eeg/sub-02_task-rest_eeg.edf", new Uint8Array(100), s3, "symlink");
      repo.commit("odd objects");
      const scan = scanOf(await runScript(repo));
      expect(scan.status).toBe("unchecked");
      expect(scan.files?.header_read).toBe(0);
      expect(scan.read_failures).toEqual({ "edf/http-416": 1, "edf/short-body": 1 });

      // The stand-in rejects a signature made with another secret, so a green run above is
      // evidence the signer is right and not that the stand-in accepts anything.
      fresh();
      const good = cleanDataset();
      const bad = scanOf(
        await runScript(good, { env: { AWS_SECRET_ACCESS_KEY: "another-secret-entirely-0000" } }),
      );
      expect(bad.status).toBe("unchecked");
      expect(bad.read_failures).toEqual({ "edf/http-403": 3 });
    },
    T,
  );

  test(
    "a transient 503 is retried and the header is read",
    async () => {
      fresh();
      const repo = new Repo();
      repo.annexed("sub-01/eeg/sub-01_task-rest_eeg.edf", recording(CLEAN), s3, "symlink");
      repo.commit("one");
      const key = [...s3.objects.keys()][0] as string;
      (s3.objects.get(key) as S3Object).failFirst = { n: 1, status: 503 };
      const scan = scanOf(await runScript(repo));
      expect(scan.status).toBe("clean");
      expect(scan.files?.header_read).toBe(1);
      expect(s3.requests).toHaveLength(2);
    },
    T,
  );

  test(
    "a key whose extension says EDF is an EDF whatever the path says, in any letter case",
    async () => {
      fresh();
      const repo = new Repo();
      // Renamed after `git annex add`: the path no longer ends .edf but the key does.
      repo.annexed("sub-01/eeg/recording.dat", recording(named(1)), s3, "symlink", ".EDF");
      // And the other way: the path is upper case.
      repo.annexed("sub-02/eeg/RECORDING.EDF", recording(named(2)), s3, "pointer", ".edf");
      repo.commit("renamed");
      const scan = scanOf(await runScript(repo));
      expect(scan.files?.edf_bdf).toBe(2);
      expect(scan.files?.header_read).toBe(2);
      expect(scan.edf_bdf_files_flagged).toBe(2);
      expect(scan.status).toBe("direct-identifiers");
    },
    T,
  );

  test(
    "a key that declares size 0 is not proof the file is empty: it is read",
    async () => {
      fresh();
      const repo = cleanDataset();
      // The key is whatever the uploader wrote; the object holds a table with an identifier column.
      repo.annexed(
        "participants.tsv",
        new TextEncoder().encode(`participant_id\tname\nsub-01\t${NAME}\n`),
        s3,
        "pointer",
        ".tsv",
        0,
      );
      repo.commit("participants with a lying key");
      const scan = scanOf(await runScript(repo));
      expect(scan.status).toBe("direct-identifiers");
      expect(scan.findings_by_kind?.["participants-identifier-column"]).toBe(1);

      // Twin: the same key size on a file that really is what it says changes nothing.
      fresh();
      const clean = cleanDataset();
      clean.annexed(
        "participants.tsv",
        new TextEncoder().encode("participant_id\nsub-01\n"),
        s3,
        "pointer",
        ".tsv",
        0,
      );
      clean.commit("participants, clean");
      const twin = scanOf(await runScript(clean));
      expect(twin.status).toBe("clean");
      expect(twin.incomplete).toBe(false);
    },
    T,
  );

  test(
    "a symlink that points outside the annex is an unread file, not a skipped one",
    async () => {
      fresh();
      const repo = new Repo();
      repo.file("sub-01/eeg/real.txt", "x");
      repo.link("sub-01/eeg/sub-01_task-rest_eeg.edf", "real.txt");
      repo.commit("plain symlink");
      const scan = scanOf(await runScript(repo));
      expect(scan.status).toBe("unchecked");
      expect(scan.files?.edf_bdf).toBe(1);
      expect(scan.files?.header_read).toBe(0);
      expect(scan.read_failures).toEqual({ "edf/unreadable-entry": 1 });
    },
    T,
  );

  test(
    "sidecars are read from git: identifier columns, keys and local paths are found",
    async () => {
      fresh();
      const repo = cleanDataset();
      repo
        .file("participants.tsv", "participant_id\tname\nsub-01\tA\n")
        .file("sourcedata/export.json", `{"patient_name":"${NAME}"}\n`)
        // Larger than the 1 KB clone bound, so it must be fetched in the batch.
        .file("sourcedata/bulk.json", `{"pad":"${"x".repeat(3000)}","patient_name":"q"}\n`)
        .file("code/run.py", "path = '/Users/someone/data'\n")
        .commit("sidecars");
      const scan = scanOf(await runScript(repo));
      expect(scan.status).toBe("direct-identifiers");
      expect(scan.findings_by_kind?.["participants-identifier-column"]).toBe(1);
      expect(scan.findings_by_kind?.["json-identifier-key"]).toBe(2);
      expect(scan.findings_by_kind?.["local-user-path"]).toBe(1);
      expect(scan.sampling?.json_files).toEqual({
        candidates: 2,
        oversize: 0,
        selected: 2,
        scanned: 2,
      });
    },
    T,
  );

  test(
    "an unexpected throw in one sidecar is a counted failure, and does not drop the header findings",
    async () => {
      fresh();
      const repo = new Repo();
      repo.annexed("sub-01/eeg/sub-01_task-rest_eeg.edf", recording(named(1)), s3, "symlink");
      // Parses, and overflows the scanner's stack: a RangeError that is not a ReadFailure.
      repo.file("sourcedata/nested.json", "[".repeat(100_000) + "]".repeat(100_000));
      repo.commit("nested");
      const result = await runScript(repo);
      const scan = scanOf(result);
      expect(scan.status).toBe("direct-identifiers");
      expect(scan.findings_by_kind?.["edf-patient-name"]).toBe(1);
      expect(scan.read_failures).toEqual({ "json/error-rangeerror": 1 });
      expect(scan.incomplete).toBe(true);
      expect(scan.incomplete_reasons).toContain("json-unread");
      expect(result.posted).toHaveLength(1);

      // The twin without the nested file is the same verdict and nothing was lost.
      fresh();
      const plain = new Repo();
      plain.annexed("sub-01/eeg/sub-01_task-rest_eeg.edf", recording(named(1)), s3, "symlink");
      plain.commit("plain");
      expect(scanOf(await runScript(plain)).status).toBe("direct-identifiers");
    },
    T,
  );

  test(
    "an extension that is not shaped like one is counted under .other, not refused",
    async () => {
      fresh();
      const repo = cleanDataset();
      repo.file("sourcedata/raw/recording.dat_backup", "x").file("sourcedata/raw/b.set", "y");
      repo.commit("odd formats");
      const result = await runScript(repo);
      const scan = scanOf(result);
      expect(scan.unscreened_formats).toEqual({ ".set": 1, [OTHER_FORMAT]: 1 });
      expect(scan.status).toBe("clean-edf-only-others-unscreened");
      expect(result.posted).toHaveLength(1);
    },
    T,
  );
});

describe("the screen: history", () => {
  /** The same HEAD tree twice; only whether the path ever existed differs. */
  function twin(historical: string | null): Repo {
    const repo = cleanDataset();
    if (historical) {
      repo.file(historical, "x").commit("add");
      repo.remove(historical).commit("remove");
    } else {
      repo.commit("noop");
    }
    return repo;
  }

  test(
    "a file that was removed still counts, and the twin that never had it does not",
    async () => {
      fresh();
      const removed = await runScript(twin("sub-01/anat/photo.jpg"));
      const kept = scanOf(removed);
      expect(kept.findings_by_kind?.["image-or-document-file"]).toBe(1);
      // History paths are screened by the path rules only: they are not files of the tree.
      expect(kept.files?.total).toBe(7);

      fresh();
      const never = scanOf(await runScript(twin(null)));
      expect(never.findings_by_kind?.["image-or-document-file"]).toBeUndefined();
    },
    T,
  );

  test(
    "a path on another branch counts, a path on the git-annex branch does not",
    async () => {
      fresh();
      const other = twin(null);
      other.orphanBranch("scratch", "notes/consent.pdf", "x");
      expect(scanOf(await runScript(other)).findings_by_kind?.["image-or-document-file"]).toBe(1);

      fresh();
      const annex = twin(null);
      // git-annex keeps location logs named by key on this branch; they are not dataset files.
      annex.orphanBranch("git-annex", "aaa/bbb/consent.pdf", "x");
      expect(
        scanOf(await runScript(annex)).findings_by_kind?.["image-or-document-file"],
      ).toBeUndefined();
    },
    T,
  );
});

describe("the screen: a history walk that failed", () => {
  test(
    "is unchecked with its own reason, never a clean dataset with no history",
    async () => {
      fresh();
      const repo = cleanDataset();
      const config = inProcessConfig(repo);
      const failed = await runScreen(config, {
        scannerRevision: "abcdef1",
        history: async () => null,
      });
      expect(failed.report.scan?.status).toBe("unchecked");
      expect(failed.report.scan?.incomplete).toBe(true);
      expect(failed.report.scan?.incomplete_reasons).toEqual(["history-unread"]);
      const walked = await runScreen(config, { scannerRevision: "abcdef1" });
      expect(walked.report.scan?.status).toBe("clean");
    },
    T,
  );

  const PATH = "sub-01/eeg/sub-01_task-rest_eeg.edf";

  /** Commit 1 holds `before`, commit 2 replaces it with `after`; returns the first key. */
  function replaced(
    before: string,
    after: string,
    how: "symlink" | "pointer",
  ): { repo: Repo; oldKey: string; newKey: string } {
    const repo = new Repo();
    repo.file("README", "x");
    const oldKey = repo.annexed(PATH, recording(before), s3, how);
    repo.commit("first recording");
    repo.remove(PATH);
    const newKey = repo.annexed(PATH, recording(after), s3, how);
    repo.commit("replace the recording");
    return { repo, oldKey, newKey };
  }

  for (const how of ["symlink", "pointer"] as const) {
    test(
      `a header fixed in a later commit is still screened: ${how}, names in commit 1 only`,
      async () => {
        fresh();
        const { repo } = replaced(named(1), CLEAN, how);
        const result = await runScript(repo);
        const scan = scanOf(result);
        // The tree holds only the clean recording; the old one is in history and in S3.
        expect(scan.status).toBe("direct-identifiers");
        expect(scan.files?.edf_bdf).toBe(2);
        expect(scan.files?.header_read).toBe(2);
        expect(scan.edf_bdf_files_flagged).toBe(1);
        expect(scan.findings_by_kind?.["edf-patient-name"]).toBe(1);
        expect(s3.requests).toHaveLength(2);
        expect(result.stdout).toContain("superseded=1");
        expect(JSON.stringify(result.report)).not.toContain(NAME);

        // Twin: the same two commits, clean in both, are clean and cost the same two reads.
        fresh();
        const clean = replaced(CLEAN, "P09 F X X", how);
        const twin = scanOf(await runScript(clean.repo));
        expect(twin.status).toBe("clean");
        expect(twin.files?.edf_bdf).toBe(2);
        expect(twin.incomplete).toBe(false);
        expect(s3.requests).toHaveLength(2);
      },
      T,
    );
  }

  test(
    "a superseded recording whose object is gone leaks nothing: counted as absent, still clean",
    async () => {
      fresh();
      const { repo, oldKey } = replaced(named(1), CLEAN, "symlink");
      s3.objects.delete(`${ID}/objects/${oldKey}`);
      const scan = scanOf(await runScript(repo));
      expect(scan.status).toBe("clean");
      expect(scan.incomplete).toBe(false);
      expect(scan.incomplete_reasons).toEqual([]);
      expect(scan.read_failures).toEqual({ "edf/superseded-absent": 1 });
      expect(scan.files).toMatchObject({ edf_bdf: 1, header_read: 1, header_read_failed: 0 });
      expect(s3.requests).toHaveLength(2);
    },
    T,
  );

  test(
    "a superseded recording the store refuses (403) or times out on is unread, so unchecked",
    async () => {
      fresh();
      const { repo, oldKey } = replaced(named(1), CLEAN, "symlink");
      (s3.objects.get(`${ID}/objects/${oldKey}`) as S3Object).status = 403;
      const scan = scanOf(await runScript(repo));
      expect(scan.status).toBe("unchecked");
      expect(scan.incomplete_reasons).toContain("edf-headers-unread");
      expect(scan.read_failures).toEqual({ "edf/http-403": 1 });
      expect(scan.files).toMatchObject({ edf_bdf: 2, header_read: 1, header_read_failed: 1 });

      // Only a 404 is absence. A 500 is the store failing, not the object being gone.
      fresh();
      const failing = replaced(named(1), CLEAN, "symlink");
      (s3.objects.get(`${ID}/objects/${failing.oldKey}`) as S3Object).status = 500;
      const server = scanOf(await runScript(failing.repo));
      expect(server.status).toBe("unchecked");
      expect(server.read_failures?.["edf/superseded-absent"]).toBeUndefined();
    },
    T,
  );

  test(
    "a recording that was only moved keeps its key and costs no extra read; a deleted one counts",
    async () => {
      fresh();
      const moved = new Repo();
      const key = moved.annexed(PATH, recording(CLEAN), s3, "symlink");
      moved.commit("first");
      moved.remove(PATH);
      // One directory up, so the symlink text (and its blob) differs while the key is the same.
      moved.link("sub-01/moved_eeg.edf", `../.git/annex/objects/Xz/Qk/${key}/${key}`);
      moved.commit("move");
      const scan = scanOf(await runScript(moved));
      expect(scan.status).toBe("clean");
      expect(scan.files?.edf_bdf).toBe(1);
      expect(s3.requests).toHaveLength(1);

      fresh();
      const deleted = new Repo();
      deleted.annexed(PATH, recording(named(1)), s3, "symlink");
      deleted.annexed("sub-02/eeg/sub-02_task-rest_eeg.edf", recording("P02 F X X"), s3, "symlink");
      deleted.commit("two");
      deleted.remove(PATH).commit("delete the named one");
      const gone = scanOf(await runScript(deleted));
      expect(gone.status).toBe("direct-identifiers");
      expect(gone.files?.edf_bdf).toBe(2);
    },
    T,
  );

  test(
    "a recording committed to git directly and replaced is read from its old blob",
    async () => {
      fresh();
      const repo = new Repo();
      // 2000 bytes against a 1 KB clone bound: the old blob is left behind and must be fetched.
      repo.file(PATH, recording(named(1))).commit("inline, named");
      repo.file(PATH, recording(CLEAN)).commit("inline, fixed");
      const scan = scanOf(await runScript(repo));
      expect(scan.status).toBe("direct-identifiers");
      expect(scan.files).toMatchObject({ edf_bdf: 2, header_read: 2 });

      fresh();
      const twin = new Repo();
      twin.file(PATH, recording(CLEAN)).commit("inline");
      twin.file(PATH, recording("P09 F X X")).commit("inline, changed");
      expect(scanOf(await runScript(twin)).status).toBe("clean");
    },
    T,
  );

  test(
    "an old annexed recording needs credentials just as a current one does",
    async () => {
      fresh();
      const repo = new Repo();
      repo.annexed(PATH, recording(named(1)), s3, "symlink");
      repo.commit("annexed");
      repo.remove(PATH);
      repo.file(PATH, recording(CLEAN)).commit("inline replacement");
      const result = await runScript(repo, {
        env: { AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined },
      });
      expect(result.report?.error).toBe("credentials-missing");
      expect(s3.requests).toHaveLength(0);
    },
    T,
  );

  test(
    "historic blobs that cannot be examined make the walk incomplete, never empty",
    async () => {
      fresh();
      const { repo } = replaced(named(1), CLEAN, "symlink");
      const walk = (await walkHistory(repo.dir, Date.now() + 30_000)) as HistoryWalk;
      const head = git(repo.dir, "rev-parse", "HEAD");
      const tree = (await listTree(repo.dir, head)) as Tree;
      const reader = new GitBlobReader(repo.dir);
      await reader.close();
      const resolved = {
        entries: [],
        annexed: 0,
        inline: 0,
        unresolved: 0,
        annexedEdf: 0,
      };
      const found = await findSuperseded(
        repo.dir,
        walk,
        resolved,
        new Set(tree.entries.map((t) => t.oid)),
        reader,
      );
      expect(found.unreadable).toBeGreaterThan(0);
    },
    T,
  );

  test(
    "walkHistory says null for a directory git cannot read and for a deadline already past",
    async () => {
      const notRepo = tempDir("not-a-repo");
      expect(await walkHistory(notRepo, Date.now() + 10_000)).toBeNull();
      const repo = cleanDataset();
      expect(await walkHistory(repo.dir, Date.now() - 1)).toBeNull();
      const walk = await walkHistory(repo.dir, Date.now() + 10_000);
      expect(walk?.paths.has("participants.tsv")).toBe(true);
      // Every blob a path held, with full object ids: the symlinks and pointers among them.
      const recordings = [...(walk?.blobs.values() ?? [])].filter((b) =>
        /\.(edf|bdf)$/.test(b.path),
      );
      expect(recordings.map((b) => b.mode).sort()).toEqual([
        "100644",
        "100644",
        "120000",
        "120000",
      ]);
      expect([...(walk?.blobs.keys() ?? [])].every((oid) => /^[0-9a-f]{40}$/.test(oid))).toBe(true);
    },
    T,
  );
});

describe("the screen: when it cannot produce a verdict", () => {
  test(
    "annexed recordings and no credentials is its own error, posted, with no S3 request",
    async () => {
      fresh();
      const repo = cleanDataset();
      const result = await runScript(repo, {
        env: { AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined },
      });
      expect(result.code).toBe(0);
      expect(result.report?.error).toBe("credentials-missing");
      expect(result.report?.scan).toBeUndefined();
      expect(result.report?.head).toBe(git(repo.dir, "rev-parse", "HEAD"));
      expect(result.posted).toHaveLength(1);
      expect(result.posted[0]?.body.report.error).toBe("credentials-missing");
      expect(s3.requests).toHaveLength(0);

      // Twin: no annexed recordings, so no credentials are needed and the screen completes.
      fresh();
      const inline = new Repo();
      inline.file("sub-01/eeg/sub-01_task-rest_eeg.edf", recording(CLEAN)).commit("inline");
      const done = scanOf(
        await runScript(inline, {
          env: { AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined },
        }),
      );
      expect(done.status).toBe("clean");
    },
    T,
  );

  test(
    "a repository that cannot be cloned, or a ref that does not exist, is clone-failed and posted",
    async () => {
      fresh();
      const gone = await runScript(null, { origin: "file:///nonexistent/never/there" });
      expect(gone.code).toBe(0);
      expect(gone.report).toMatchObject({ error: "clone-failed", head: null });
      expect(gone.posted).toHaveLength(1);

      fresh();
      const repo = cleanDataset();
      const noRef = await runScript(repo, { env: { REF: "no-such-branch" } });
      expect(noRef.report?.error).toBe("clone-failed");
      expect(noRef.posted).toHaveLength(1);
    },
    T,
  );

  test(
    "a scratch directory that cannot be made is a workflow-failed report, and its path is not printed",
    async () => {
      fresh();
      const repo = cleanDataset();
      // The runtime's own message for a failed mkdtemp names the directory it tried.
      const result = await runScript(repo, { env: { TMPDIR: join(outDir, "no-such-dir", "tmp") } });
      expect(result.code).toBe(0);
      expect(result.report).toMatchObject({ error: "workflow-failed", head: null });
      expect(result.posted).toHaveLength(1);
      expect(result.posted[0]?.body.report.error).toBe("workflow-failed");
      const printed = result.stdout + result.stderr;
      expect(printed).not.toContain("no-such-dir");
      expect(printed).not.toContain("ENOENT");
      expect(printed).not.toContain(" at ");
    },
    T,
  );

  test(
    "a submodule is a path the screen cannot read: unchecked, never no-recordings or clean",
    async () => {
      /** A gitlink committed from the index: `git add -A` would drop it, there is no checkout. */
      const withSubmodule = (repo: Repo): Repo => {
        git(
          repo.dir,
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${"1".repeat(40)},vendor/tool`,
        );
        git(repo.dir, "commit", "-q", "-m", "add a submodule");
        return repo;
      };

      fresh();
      const readme = (): Repo => {
        const repo = new Repo().file("README", "x");
        repo.commit("readme");
        return repo;
      };
      const only = withSubmodule(readme());
      const result = await runScript(only);
      const scan = scanOf(result);
      expect(scan.status).toBe("unchecked");
      expect(scan.incomplete).toBe(true);
      expect(scan.incomplete_reasons).toEqual(["submodule-unread"]);
      expect(scan.files?.total).toBe(1);
      expect(result.stdout).toContain("submodules=1");

      // A dataset whose every recording was read is still not clean beside a submodule.
      fresh();
      const beside = scanOf(await runScript(withSubmodule(cleanDataset())));
      expect(beside.status).toBe("unchecked");
      expect(beside.incomplete_reasons).toEqual(["submodule-unread"]);
      expect(beside.files?.header_read).toBe(4);

      // Twin: without the submodule the same tree has no recordings and says so.
      fresh();
      const none = scanOf(await runScript(readme()));
      expect(none.status).toBe("no-recordings");
      expect(none.incomplete).toBe(false);
    },
    T,
  );

  test(
    "a deadline that passes mid-read stops starting reads: unchecked, posted, nothing more requested",
    async () => {
      fresh();
      const repo = new Repo();
      repo.file("participants.tsv", "participant_id\nsub-01\n");
      for (const n of [1, 2, 3, 4, 5]) {
        repo.annexed(`sub-0${n}/eeg/sub-0${n}_task-rest_eeg.edf`, recording(`P0${n} F X X`), s3);
      }
      repo.commit("five");
      // The second object takes longer than the whole budget to answer. With one reader, the
      // third to fifth are never requested.
      const keys = [...s3.objects.keys()];
      (s3.objects.get(keys[1] as string) as S3Object).delayMs = 3500;

      const result = await runScript(repo, {
        env: { SCREEN_DEADLINE_MS: "3000" },
        args: ["--concurrency", "1"],
      });
      expect(result.code).toBe(0);
      const scan = scanOf(result);
      expect(scan.status).toBe("unchecked");
      expect(scan.incomplete).toBe(true);
      expect(scan.files?.edf_bdf).toBe(5);
      expect(scan.files?.header_read).toBe(2);
      expect(scan.read_failures?.["edf/deadline"]).toBe(3);
      expect(scan.incomplete_reasons).toContain("edf-headers-unread");
      expect(s3.requests).toHaveLength(2);
      expect(result.posted).toHaveLength(1);
    },
    T,
  );

  test(
    "a deadline that passes during the clone is the deadline error, posted",
    async () => {
      fresh();
      const result = await runScript(cleanDataset(), { env: { SCREEN_DEADLINE_MS: "1" } });
      expect(result.report?.error).toBe("deadline");
      expect(result.posted).toHaveLength(1);
      expect(s3.requests).toHaveLength(0);
    },
    T,
  );
});

describe("the callback: retry rules", () => {
  async function post(statuses: number[], over: RunOver = {}) {
    fresh();
    callback.statuses = [...statuses];
    const repo = new Repo();
    repo.file("README", "x").commit("tiny");
    const result = await runScript(repo, over);
    return { result, attempts: callback.posted.length };
  }

  test(
    "a 5xx is retried and the next 2xx delivers",
    async () => {
      const { result, attempts } = await post([500, 200]);
      expect(attempts).toBe(2);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("callback attempt 1: HTTP 500");
      expect(result.stdout).toContain("callback attempt 2: HTTP 200");
    },
    T,
  );

  test(
    "401, 408 and 429 are retried (a rotation race, a timeout, a rate limit)",
    async () => {
      for (const status of [401, 408, 429]) {
        const retried = await post([status, 200]);
        expect(retried.attempts).toBe(2);
        expect(retried.result.code).toBe(0);
      }
    },
    T,
  );

  test(
    "any other 4xx and any redirect are final",
    async () => {
      for (const status of [400, 403, 404, 409, 422, 301, 302, 307, 308]) {
        const final = await post([status, 200]);
        expect(final.attempts).toBe(1);
        expect(final.result.code).toBe(1);
      }
    },
    T,
  );

  test(
    "a Worker that comes back on the sixth attempt is delivered; six failures are not",
    async () => {
      const late = await post([500, 502, 503, 504, 500, 200]);
      expect(late.attempts).toBe(6);
      expect(late.result.code).toBe(0);
    },
    T,
  );

  test(
    "six failures are undelivered and exit 1; the token header is on every attempt",
    async () => {
      const { result, attempts } = await post([500, 502, 503, 504, 500, 502, 200]);
      expect(attempts).toBe(6);
      expect(result.code).toBe(1);
      expect(callback.posted.every((p) => p.token === TOKEN)).toBe(true);
      // The report is still on disk for whoever reads the run.
      expect(result.report).not.toBeNull();
    },
    T,
  );

  test(
    "a callback nobody listens on is six attempts and exit 1, not a hang",
    async () => {
      const { result } = await post([], {
        env: { CALLBACK_URL: "http://127.0.0.1:9/webhooks/identifier-screen" },
      });
      expect(result.code).toBe(1);
      expect(result.stdout.match(/callback attempt \d: HTTP 0/g)).toHaveLength(6);
    },
    T,
  );

  test("the waits between attempts are 5, 10, 20, 30 and 45 seconds", async () => {
    fresh();
    callback.statuses = [500, 500, 500, 500, 500, 500];
    const waits: number[] = [];
    const delivered = await deliverReport({
      url: callback.url,
      token: TOKEN,
      body: {},
      backoffMs: 5000,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(delivered).toBe(false);
    expect(callback.posted).toHaveLength(6);
    expect(waits).toEqual([5000, 10_000, 20_000, 30_000, 45_000]);
  });

  test(
    "--no-callback and an empty CALLBACK_URL post nothing and exit 0",
    async () => {
      const flagged = await post([], { args: ["--no-callback"] });
      expect(flagged.attempts).toBe(0);
      expect(flagged.result.code).toBe(0);
      const manual = await post([], { env: { CALLBACK_URL: "", CALLBACK_TOKEN: undefined } });
      expect(manual.attempts).toBe(0);
      expect(manual.result.code).toBe(0);
      expect(manual.result.report?.scan).toBeDefined();
    },
    T,
  );
});

// ---------------------------------------------------------------------------------------
// What the log and the argument list must never hold
// ---------------------------------------------------------------------------------------

describe("log discipline: the Actions log is public", () => {
  function leakyDataset(): Repo {
    const repo = new Repo();
    repo
      .file("participants.tsv", `participant_id\tname\nsub-01\t${NAME}\n`)
      .file(`sub-${NAME}/anat/${NAME}_face.jpg`, "x")
      .file(`sourcedata/${NAME}_consent.pdf`, "x")
      .file("sourcedata/export.json", `{"patient_name":"${NAME}"}\n`)
      .file("code/run.py", `path = '/Users/${NAME.toLowerCase()}/data'\n`)
      .file("old/removed.txt", "x");
    repo.annexed("sub-01/eeg/sub-01_task-rest_eeg.edf", recording(named(1)), s3, "symlink");
    repo.annexed("sub-02/eeg/sub-02_task-rest_eeg.edf", recording(named(2)), s3, "pointer");
    repo.file("sub-03/eeg/sub-03_task-rest_eeg.edf", recording(named(3)));
    repo.commit("leaky");
    repo.file(`old/${NAME}_scan.jpg`, "x").commit("add history only");
    repo.remove(`old/${NAME}_scan.jpg`).commit("remove");
    return repo;
  }

  test(
    "no name, token, signature, key, path or clone URL appears in anything the run printed or posted",
    async () => {
      fresh();
      const repo = leakyDataset();
      const result = await runScript(repo);
      const everything = [
        result.stdout,
        result.stderr,
        readFileSync(result.outFile, "utf8"),
        JSON.stringify(result.posted.map((p) => p.body)),
      ].join("\n");

      // The run saw all of it: this is a real scan of a real name, not an empty run.
      const scan = scanOf(result);
      expect(scan.status).toBe("direct-identifiers");
      expect(scan.findings_by_kind?.["edf-patient-name"]).toBe(3);
      expect(scan.findings_by_kind?.["participants-identifier-column"]).toBe(1);
      expect(scan.findings_by_kind?.["json-identifier-key"]).toBe(1);
      expect(scan.findings_by_kind?.["local-user-path"]).toBe(1);
      expect(scan.findings_by_kind?.["image-or-document-file"]).toBeGreaterThanOrEqual(3);
      expect(s3.signatures.size).toBe(2);

      expect(everything.toLowerCase()).not.toContain(NAME.toLowerCase());
      expect(everything).not.toContain(TOKEN.slice(0, 8));
      expect(result.stdout + result.stderr).not.toContain(TOKEN);
      expect(everything).not.toContain(GH_TOKEN);
      expect(everything).not.toContain(btoa(`x-access-token:${GH_TOKEN}`));
      expect(everything).not.toContain(SECRET_KEY);
      for (const signature of s3.signatures) expect(everything).not.toContain(signature);
      expect(everything).not.toContain(repo.dir);
      expect(everything).not.toContain("X-Amz");
      expect(everything).not.toContain("file://");
      expect(everything).not.toContain("SHA256E");
    },
    T,
  );

  test(
    "every line the run prints is a count or a fixed word, and the verdict is not among them",
    async () => {
      fresh();
      const result = await runScript(leakyDataset());
      const lines = result.stdout.split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      const allowed = [
        /^screen: head [0-9a-f]{7}$/,
        /^screen: tree files=\d+ annexed=\d+ inline=\d+ unresolved=\d+ submodules=\d+$/,
        /^screen: prefetch blobs=\d+ (ok|incomplete)$/,
        /^screen: history (paths=\d+ superseded=\d+|unread)$/,
        /^screen: done files=\d+ edf_bdf=\d+ header_read=\d+ header_unread=\d+$/,
        /^screen: error=[a-z-]+$/,
        /^callback attempt \d: HTTP \d+$/,
        /^callback: skipped$/,
      ];
      for (const line of lines) expect(allowed.some((re) => re.test(line))).toBe(true);
      expect(result.stdout).not.toMatch(/direct-identifiers|edf-patient|clean|unchecked/);
      expect(result.stderr).toBe("");
    },
    T,
  );
});

// ---------------------------------------------------------------------------------------
// The clone authenticates over HTTP with the token, or fails
// ---------------------------------------------------------------------------------------

/** A `git` first on PATH that records every argument it is given, then runs the real one. */
function gitArgvShim(): { dir: string; log: string } {
  const dir = tempDir("shim");
  const log = join(dir, "argv.log");
  const real = Bun.which("git") as string;
  writeFileSync(
    join(dir, "git"),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> "${log}"\nprintf -- '--\\n' >> "${log}"\nexec "${real}" "$@"\n`,
  );
  chmodSync(join(dir, "git"), 0o755);
  return { dir, log };
}

/**
 * The argument list of every process on the machine, sampled while `during` runs. Async on
 * purpose: the stand-ins live on this event loop, so a blocking `ps` would stall the run.
 */
async function sampleProcessArgv<T>(during: () => Promise<T>): Promise<{ value: T; argv: string }> {
  let running = true;
  const samples: string[] = [];
  const poller = (async () => {
    while (running) {
      const proc = Bun.spawn(["ps", "axww", "-o", "args="], { stdout: "pipe", stderr: "ignore" });
      samples.push(await new Response(proc.stdout).text());
      await Bun.sleep(25);
    }
  })();
  try {
    return { value: await during(), argv: samples.join("\n") };
  } finally {
    running = false;
    await poller;
  }
}

class GitHttpServer {
  authenticated = 0;
  refused = 0;
  /** POSTs to git-upload-pack: the clone's fetch, then each by-object-id fetch of a blob. */
  uploadPackPosts = 0;
  private readonly server: ReturnType<typeof Bun.serve>;
  readonly base: string;

  constructor(
    private readonly root: string,
    private readonly token: string,
  ) {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => this.handle(req) });
    this.base = `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  private async handle(req: Request): Promise<Response> {
    const [scheme, value] = (req.headers.get("authorization") ?? "").split(" ");
    if (scheme?.toLowerCase() !== "basic" || value !== btoa(`x-access-token:${this.token}`)) {
      this.refused++;
      return new Response("denied", { status: 401, headers: { "WWW-Authenticate": "Basic" } });
    }
    this.authenticated++;
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname.endsWith("/git-upload-pack")) this.uploadPackPosts++;
    const body = Buffer.from(await req.arrayBuffer());
    const env: Record<string, string> = {
      ...GIT_ENV,
      GIT_PROJECT_ROOT: this.root,
      GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: req.method,
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers.get("content-type") ?? "",
      CONTENT_LENGTH: String(body.length),
      REMOTE_ADDR: "127.0.0.1",
      GATEWAY_INTERFACE: "CGI/1.1",
      SERVER_PROTOCOL: "HTTP/1.1",
    };
    const encoding = req.headers.get("content-encoding");
    if (encoding) env.HTTP_CONTENT_ENCODING = encoding;
    const protocol = req.headers.get("git-protocol");
    if (protocol) env.HTTP_GIT_PROTOCOL = protocol;
    const proc = Bun.spawn(["git", "http-backend"], {
      env,
      stdin: body,
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    const split = Buffer.from(out).indexOf("\r\n\r\n");
    const headerText = Buffer.from(out.subarray(0, split)).toString("utf8");
    const headers = new Headers();
    let status = 200;
    for (const line of headerText.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const name = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
      else headers.set(name, value);
    }
    return new Response(out.subarray(split + 4), { status, headers });
  }
}

describe("the clone authenticates through the environment", () => {
  function served(files: (repo: Repo) => void): {
    repo: Repo;
    server: GitHttpServer;
    origin: string;
  } {
    const repo = cleanDataset();
    files(repo);
    const root = tempDir("http-root");
    git(root, "clone", "-q", "--bare", repo.origin, `${ID}.git`);
    git(join(root, `${ID}.git`), "config", "uploadpack.allowFilter", "true");
    git(join(root, `${ID}.git`), "config", "uploadpack.allowAnySHA1InWant", "true");
    const server = new GitHttpServer(root, GH_TOKEN);
    return { repo, server, origin: `${server.base}/${ID}.git` };
  }

  test(
    "the token authenticates the clone and the by-object-id fetch over HTTP and is in no argv or output",
    async () => {
      fresh();
      // A blob over the 1 KB clone bound, so a second authenticated fetch must bring it.
      const { server, origin } = served((repo) => {
        repo
          .file("sourcedata/bulk.json", `{"pad":"${"x".repeat(3000)}","patient_name":"q"}\n`)
          .commit("bulk");
      });
      const shim = gitArgvShim();
      try {
        const { value: ok, argv: processes } = await sampleProcessArgv(() =>
          runScript(null, { origin, env: { PATH: `${shim.dir}:${process.env.PATH}` } }),
        );

        // The network path ran for real: the server only answers a request that carries the
        // header, and the finding can only come from the blob the second fetch brought.
        const scan = scanOf(ok);
        expect(scan.status).toBe("direct-identifiers");
        expect(scan.findings_by_kind?.["json-identifier-key"]).toBe(1);
        expect(server.refused).toBe(0);
        expect(server.authenticated).toBeGreaterThan(0);
        expect(server.uploadPackPosts).toBeGreaterThanOrEqual(2);

        // Every git command the script ran, as git received it.
        const argv = readFileSync(shim.log, "utf8");
        expect(argv).toContain("clone");
        expect(argv).toContain("fetch");
        expect(argv).toContain("--stdin");
        // Every process on the machine while it ran: the script itself is among them.
        expect(processes.includes(SCRIPT)).toBe(true);

        const b64 = btoa(`x-access-token:${GH_TOKEN}`);
        const secrets = [GH_TOKEN, b64];
        // Machine-wide, so only what is unique to this test can be asserted about it. The
        // comparison is on booleans: a failure must not print every process on the machine.
        const sources: Record<string, string> = {
          "git argv": argv,
          "process list": processes,
          stdout: ok.stdout,
          stderr: ok.stderr,
          "report file": readFileSync(ok.outFile, "utf8"),
          callback: JSON.stringify(ok.posted.map((p) => p.body)),
        };
        for (const [name, text] of Object.entries(sources)) {
          for (const secret of secrets)
            expect([name, text.includes(secret)]).toEqual([name, false]);
        }
        // And of git's own arguments, which are only the script's: no config or header either.
        expect(argv).not.toContain("extraheader");
        expect(argv.toLowerCase()).not.toContain("authorization");
      } finally {
        server.stop();
      }
    },
    T,
  );

  test(
    "a wrong token, or none, is clone-failed",
    async () => {
      fresh();
      const { server, origin } = served(() => undefined);
      try {
        const refused = await runScript(null, { origin, env: { GH_TOKEN: "ghs_WrongToken" } });
        expect(refused.report?.error).toBe("clone-failed");
        expect(server.refused).toBeGreaterThan(0);
        expect(refused.posted).toHaveLength(1);

        fresh();
        const anonymous = await runScript(null, { origin, env: { GH_TOKEN: undefined } });
        expect(anonymous.report?.error).toBe("clone-failed");
      } finally {
        server.stop();
      }
    },
    T,
  );
});

describe("the screen: concurrency", () => {
  test(
    "no more header reads are in flight than --concurrency allows, and more than one is used",
    async () => {
      fresh();
      const repo = new Repo();
      for (let n = 1; n <= 12; n++) {
        const label = String(n).padStart(2, "0");
        repo.annexed(
          `sub-${label}/eeg/sub-${label}_task-rest_eeg.edf`,
          recording(`P${label} F X X`),
          s3,
        );
      }
      repo.commit("twelve");
      for (const object of s3.objects.values()) object.delayMs = 60;
      const scan = scanOf(await runScript(repo, { args: ["--concurrency", "3"] }));
      expect(scan.files?.header_read).toBe(12);
      expect(s3.maxInflight).toBeLessThanOrEqual(3);
      expect(s3.maxInflight).toBeGreaterThan(1);
    },
    T,
  );
});

// ---------------------------------------------------------------------------------------
// The report door, with a hostile scan result
// ---------------------------------------------------------------------------------------

function inProcessConfig(repo: Repo, over: Partial<ScreenConfig> = {}): ScreenConfig {
  return {
    ...parseScreenConfig(["--clone-origin", repo.origin, "--s3-endpoint", s3.url], {
      DATASET_ID: ID,
      AWS_ACCESS_KEY_ID: ACCESS_KEY,
      AWS_SECRET_ACCESS_KEY: SECRET_KEY,
    }),
    ...over,
  };
}

describe("a report is never posted with anything the contract does not declare", () => {
  const hostile: [string, (real: DatasetRecord) => unknown][] = [
    ["an undeclared field", (r) => ({ ...r, patient_name: NAME })],
    ["a value as a kind", (r) => ({ ...r, findings_by_kind: { [NAME]: 1 } })],
    ["a value as a reason", (r) => ({ ...r, incomplete_reasons: [NAME] })],
    ["a string where a count belongs", (r) => ({ ...r, edf_bdf_files_flagged: NAME })],
  ];

  for (const [label, corrupt] of hostile) {
    test(
      `${label} becomes workflow-failed, and nothing of it reaches the Worker`,
      async () => {
        fresh();
        const repo = cleanDataset();
        const outcome = await runScreen(
          inProcessConfig(repo, {
            callbackUrl: callback.url,
            callbackToken: TOKEN,
            callbackBackoffMs: 1,
          }),
          {
            scannerRevision: "abcdef1",
            scan: async (...args) =>
              corrupt(await scanDatasetFromManifest(...args)) as DatasetRecord,
          },
        );
        expect(outcome.delivered).toBe(true);
        expect(outcome.report.error).toBe("workflow-failed");
        expect(outcome.report.scan).toBeUndefined();
        expect(outcome.report.head).toBe(git(repo.dir, "rev-parse", "HEAD"));
        expect(callback.posted).toHaveLength(1);
        expect(JSON.stringify(callback.posted)).not.toContain(NAME);
        // The twin: the real scan, same path, is delivered as a scan.
        callback.reset();
        const real = await runScreen(
          inProcessConfig(repo, { callbackUrl: callback.url, callbackToken: TOKEN }),
          { scannerRevision: "abcdef1" },
        );
        expect(real.report.scan?.status).toBe("clean");
      },
      T,
    );
  }

  test(
    "a value used as a format name is folded into .other and never leaves the machine",
    async () => {
      fresh();
      const repo = cleanDataset();
      const outcome = await runScreen(
        inProcessConfig(repo, {
          callbackUrl: callback.url,
          callbackToken: TOKEN,
          callbackBackoffMs: 1,
        }),
        {
          scannerRevision: "abcdef1",
          scan: async (...args) => {
            const real = await scanDatasetFromManifest(...args);
            return {
              ...real,
              status: "clean-edf-only-others-unscreened" as const,
              unscreened_formats: { [`.${NAME}`]: 2 },
            };
          },
        },
      );
      expect(outcome.delivered).toBe(true);
      expect(outcome.report.scan?.unscreened_formats).toEqual({ [OTHER_FORMAT]: 2 });
      expect(JSON.stringify(callback.posted)).not.toContain(NAME);
    },
    T,
  );

  test("the fleet scan's finding_fields never reaches a report", () => {
    const record = {
      id: ID,
      version: null,
      scanned_at: "2026-10-05T12:00:00.000Z",
      status: "clean",
      incomplete: false,
      incomplete_reasons: [],
      files: { total: 4, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
      finding_fields: [`edf-patient-name:${NAME}`],
    };
    const report = finalizeScanReport(record, "identifier-scan@abcdef1", "a".repeat(40));
    expect(report.error).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain(NAME);
    expect(report.scan && "finding_fields" in report.scan).toBe(false);
  });

  test("finalizeScanReport returns the parser's object, so an extra key cannot ride along", () => {
    const record = {
      id: ID,
      version: null,
      scanned_at: "2026-10-05T12:00:00.000Z",
      status: "clean",
      incomplete: false,
      incomplete_reasons: [],
      files: { total: 4, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
    };
    const report = finalizeScanReport(record, "identifier-scan@abcdef1", "a".repeat(40));
    expect(report.scan).toEqual(record as unknown as DatasetRecord);
    expect(report.scan).not.toBe(record);
    expect(
      finalizeScanReport({ ...record, extra: 1 }, "identifier-scan@abcdef1", "a".repeat(40)),
    ).toEqual({
      version: 1,
      scanner: "identifier-scan@abcdef1",
      head: "a".repeat(40),
      error: "workflow-failed",
    });
  });
});

describe("foldOddFormats keeps the contract's pattern and the dataset's honesty", () => {
  const record = (formats: Record<string, number>): DatasetRecord => ({
    id: ID,
    version: null,
    scanned_at: "2026-10-05T12:00:00.000Z",
    status: "not-screened",
    incomplete: false,
    incomplete_reasons: [],
    unscreened_formats: formats,
  });
  const accepted = (formats: Record<string, number>): boolean => {
    try {
      parseScreenReport({
        version: 1,
        scanner: "identifier-scan@abcdef1",
        head: "a".repeat(40),
        scan: record(formats),
      });
      return true;
    } catch {
      return false;
    }
  };

  test("a key survives folding exactly when the contract's parser accepts it", () => {
    const samples = [
      ".set",
      ".nii.gz",
      ".ds/",
      "(no extension)",
      ".dat_backup",
      ".a-b",
      ".thirteenletters1",
      ".12345678901234",
      "john.smith.edf",
      "",
      ".",
      ".x y",
      ".A",
      "set",
      ".tar.gz.bak",
    ];
    for (const key of samples) {
      const folded = foldOddFormats(record({ [key]: 2 })).unscreened_formats as Record<
        string,
        number
      >;
      const kept = Object.keys(folded).includes(key);
      expect(kept).toBe(accepted({ [key]: 2 }));
      // Whatever came out, the contract accepts it and the count is conserved.
      expect(accepted(folded)).toBe(true);
      expect(Object.values(folded).reduce((a, b) => a + b, 0)).toBe(2);
    }
  });

  test("more distinct formats than the contract's limit are folded, with every count kept", () => {
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`.f${i}`, i + 1]));
    const folded = foldOddFormats(record(many)).unscreened_formats as Record<string, number>;
    expect(Object.keys(folded).length).toBeLessThanOrEqual(60);
    expect(accepted(folded)).toBe(true);
    const total = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    expect(total(folded)).toBe(total(many));
    expect(folded[".f79"]).toBe(80);
  });
});

// ---------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------

describe("foldOddFailures keeps the contract's pattern and the failure counted", () => {
  const record = (failures: Record<string, number>): DatasetRecord => ({
    id: ID,
    version: null,
    scanned_at: "2026-10-05T12:00:00.000Z",
    status: "unchecked",
    incomplete: true,
    incomplete_reasons: ["json-unread"],
    read_failures: failures,
  });
  const accepted = (failures: Record<string, number>): boolean => {
    try {
      parseScreenReport({
        version: 1,
        scanner: "identifier-scan@abcdef1",
        head: "a".repeat(40),
        scan: record(failures),
      });
      return true;
    } catch {
      return false;
    }
  };

  test("what the fleet scan names after an error is lowercased; anything else is internal", () => {
    const folded = (key: string) =>
      Object.keys(foldOddFailures(record({ [key]: 2 })).read_failures as object);
    expect(folded("json/error-RangeError")).toEqual(["json/error-rangeerror"]);
    expect(folded("edf/http-403")).toEqual(["edf/http-403"]);
    expect(folded("text/error-Some$Class")).toEqual(["text/internal"]);
    expect(folded("Bad Prefix/error-X")).toEqual(["internal/internal"]);
    expect(folded("no-slash")).toEqual(["internal/internal"]);
    expect(folded(`json/${"x".repeat(60)}`)).toEqual(["json/internal"]);
  });

  test("a key survives exactly when the contract's parser accepts it, and counts are conserved", () => {
    const samples = [
      "edf/http-403",
      "json/error-RangeError",
      "json/error-rangeerror",
      "participants/deadline",
      "text/Has Space",
      "scans/",
      "/class",
      "edf/a/b",
      `${"x".repeat(20)}/class`,
      "edf/é",
    ];
    for (const key of samples) {
      const folded = foldOddFailures(record({ [key]: 3 })).read_failures as Record<string, number>;
      expect(accepted(folded)).toBe(true);
      expect(Object.values(folded).reduce((a, b) => a + b, 0)).toBe(3);
    }
    // Same class under two spellings is one key with both counts.
    const merged = foldOddFailures(
      record({ "json/error-RangeError": 1, "json/error-rangeerror": 2 }),
    ).read_failures;
    expect(merged).toEqual({ "json/error-rangeerror": 3 });
  });

  test("more distinct classes than the contract's limit share one key, every count kept", () => {
    const many = Object.fromEntries(
      Array.from({ length: 90 }, (_, i) => [`json/error-e${i}`, i + 1]),
    );
    const folded = foldOddFailures(record(many)).read_failures as Record<string, number>;
    expect(Object.keys(folded).length).toBeLessThanOrEqual(60);
    expect(accepted(folded)).toBe(true);
    const total = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    expect(total(folded)).toBe(total(many));
  });
});

describe("configuration is checked before anything runs, and never echoed", () => {
  const base = { DATASET_ID: "nm000186" };
  const code = (env: Record<string, string>, argv: string[] = []): string => {
    try {
      parseScreenConfig(argv, env);
    } catch (error) {
      expect(error).toBeInstanceOf(ScreenUsageError);
      return (error as ScreenUsageError).code;
    }
    throw new Error("accepted a configuration it should have refused");
  };

  test("only nm and on datasets are screened; a sandbox dataset is refused by name", () => {
    expect(parseScreenConfig([], base).datasetId).toBe("nm000186");
    expect(parseScreenConfig([], { DATASET_ID: "on005207" }).datasetId).toBe("on005207");
    expect(code({ DATASET_ID: "xx099999" })).toBe("dataset-id-sandbox");
    for (const bad of [
      "",
      "nm12",
      "nm0001860",
      "NM000186",
      "ds000001",
      "nm000186; id",
      "../nm000186",
    ]) {
      expect(code({ DATASET_ID: bad })).toBe("dataset-id");
    }
  });

  test("a ref cannot be an option, a range or a path escape", () => {
    expect(parseScreenConfig([], { ...base, REF: "feature/x-1.2" }).ref).toBe("feature/x-1.2");
    for (const bad of ["-x", "a..b", "a//b", "a/", "x.lock", "a b", "a;b", "$(id)"]) {
      expect(code({ ...base, REF: bad })).toBe("ref");
    }
  });

  test("the callback is https anywhere or http to this machine, and needs its token", () => {
    const ok = { ...base, CALLBACK_TOKEN: "t0ken" };
    expect(
      parseScreenConfig([], { ...ok, CALLBACK_URL: "https://api.nemar.org/x" }).callbackUrl,
    ).toBe("https://api.nemar.org/x");
    expect(
      parseScreenConfig([], { ...ok, CALLBACK_URL: "http://127.0.0.1:8787/x" }).callbackUrl,
    ).not.toBeNull();
    for (const url of [
      "http://api.nemar.org/x",
      "file:///etc/passwd",
      "ftp://x/y",
      "nope",
      "https://u:p@x/y",
    ]) {
      expect(code({ ...ok, CALLBACK_URL: url })).toBe("callback-url");
    }
    expect(code({ ...base, CALLBACK_URL: "https://api.nemar.org/x" })).toBe("callback-token");
    expect(
      parseScreenConfig(["--no-callback"], { ...base, CALLBACK_URL: "https://api.nemar.org/x" })
        .noCallback,
    ).toBe(true);
    expect(code({ ...base, CALLBACK_TOKEN: "has space" })).toBe("callback-token");
  });

  test("numbers and flags are strict", () => {
    expect(code({ ...base, SCREEN_DEADLINE_MS: "0" })).toBe("deadline");
    expect(code({ ...base, SCREEN_DEADLINE_MS: "soon" })).toBe("deadline");
    expect(code(base, ["--concurrency", "0"])).toBe("concurrency");
    expect(code(base, ["--concurrency"])).toBe("flag");
    expect(code(base, ["--out"])).toBe("flag");
    expect(code(base, ["--unknown"])).toBe("flag");
    expect(code({ ...base, REQUEST_ID: "-1" })).toBe("request-id");
    expect(code({ ...base, S3_BUCKET: "Bad_Bucket" })).toBe("bucket");
    expect(parseScreenConfig([], base).deadlineMs).toBe(35 * 60 * 1000);
    expect(parseScreenConfig([], base).region).toBe("us-east-2");
    expect(parseScreenConfig([], base).bucket).toBe("nemar");
  });

  test(
    "the script exits 2 on a bad configuration and prints the code, not the input",
    async () => {
      const poison = "xx099999; echo pwned-by-env";
      const proc = Bun.spawn(["bun", "run", SCRIPT], {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATASET_ID: poison },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exit).toBe(2);
      expect(out + err).toContain("bad configuration (dataset-id-sandbox)");
      expect(out + err).not.toContain("pwned");
    },
    T,
  );
});

// ---------------------------------------------------------------------------------------
// Pieces with their own contracts
// ---------------------------------------------------------------------------------------

describe("annex pointers", () => {
  const key = `SHA256E-s2000--${"a".repeat(64)}.edf`;

  test("a locked symlink at any depth and an unlocked pointer file name their key", () => {
    for (const target of [
      `../../.git/annex/objects/Xz/Qk/${key}/${key}`,
      `../../../../.git/annex/objects/Xz/Qk/${key}/${key}`,
      `../.git/annex/objects/Xz/Qk/${key}/${key}\n`,
    ]) {
      expect(parseAnnexPointer(target, true)).toEqual({ key, size: 2000 });
    }
    expect(parseAnnexPointer(`/annex/objects/${key}\n`, false)).toEqual({ key, size: 2000 });
    expect(parseAnnexPointer(`/annex/objects/${key}`, false)).toEqual({ key, size: 2000 });
  });

  test("anything else is not a pointer: prose that mentions one, a bad key, an escape", () => {
    expect(parseAnnexPointer(`see /annex/objects/${key} for details\n`, false)).toBeNull();
    expect(parseAnnexPointer(`# README\n/annex/objects/${key}\n`, false)).toBeNull();
    expect(parseAnnexPointer("/annex/objects/not-a-key\n", false)).toBeNull();
    expect(
      parseAnnexPointer(`/annex/objects/SHA256E-sNaN--${"a".repeat(64)}.edf\n`, false),
    ).toBeNull();
    expect(parseAnnexPointer("/annex/objects/SHA256E-s9--XYZ.edf\n", false)).toBeNull();
    expect(parseAnnexPointer("real.txt", true)).toBeNull();
    expect(parseAnnexPointer("../other/sub-01.edf", true)).toBeNull();
    // A key is a single path segment: this one would reach outside the dataset's objects.
    expect(parseAnnexPointer(`/annex/objects/../${key}\n`, false)).toBeNull();
  });
});

describe("GitBlobReader: one process, in order, only what was asked for", () => {
  test("pipelined reads of tiny, large and missing blobs each get their own answer", async () => {
    const repo = new Repo();
    const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
    repo.file("small.txt", "hello\n").file("big.bin", big).file("empty", "");
    repo.commit("blobs");
    const oid = (path: string) => git(repo.dir, "rev-parse", `HEAD:${path}`);
    const reader = new GitBlobReader(repo.dir);
    try {
      const [small, large, empty, missing, again] = await Promise.all([
        reader.read(oid("small.txt"), 100),
        reader.read(oid("big.bin"), 256),
        reader.read(oid("empty"), 100),
        reader.read("0".repeat(40), 100),
        reader.read(oid("small.txt"), 3),
      ]);
      expect(small).toMatchObject({ ok: true, size: 6 });
      expect(new TextDecoder().decode((small as { bytes: Uint8Array }).bytes)).toBe("hello\n");
      // Only the first 256 bytes of 3 MB are kept, and they are the right ones.
      expect(large).toMatchObject({ ok: true, size: big.length });
      expect([...(large as { bytes: Uint8Array }).bytes]).toEqual([...big.subarray(0, 256)]);
      expect(empty).toMatchObject({ ok: true, size: 0 });
      expect(missing).toEqual({ ok: false, reason: "missing" });
      expect(new TextDecoder().decode((again as { bytes: Uint8Array }).bytes)).toBe("hel");
      // And the stream is still in step after the large one.
      const last = await reader.read(oid("small.txt"), 100);
      expect(new TextDecoder().decode((last as { bytes: Uint8Array }).bytes)).toBe("hello\n");
    } finally {
      await reader.close();
    }
    expect(await reader.read(oid("small.txt"), 10)).toEqual({ ok: false, reason: "closed" });
  });
});

describe("the prefetch of blobs the clone left behind", () => {
  test(
    "stops when the bytes that arrived pass the budget, and says so; a larger budget fetches all",
    async () => {
      fresh();
      const repo = new Repo();
      for (const n of [1, 2, 3]) {
        repo.file(`sourcedata/s${n}.json`, JSON.stringify({ n, pad: "x".repeat(3000) }));
      }
      const head = repo.commit("three large blobs");
      const config = { ...inProcessConfig(repo), blobLimit: "1k" };
      const clone = join(tempDir("clone"), "repo");
      expect((await cloneMetadata(config, clone, 60_000)).ok).toBe(true);
      const oids = (await listTree(clone, head))?.entries.map((t) => t.oid) as string[];
      expect(oids).toHaveLength(3);
      // The clone's bound left all three behind: none is here.
      expect([
        ...((await objectSizes(clone, oids)) as Map<string, number | null>).values(),
      ]).toEqual([null, null, null]);

      const deadlineAt = Date.now() + 60_000;
      expect(
        await prefetchBlobs(config, clone, oids, { deadlineAt, chunk: 1, budgetBytes: 4000 }),
      ).toBe(false);
      const after = (await objectSizes(clone, oids)) as Map<string, number | null>;
      expect(oids.map((oid) => after.get(oid) !== null)).toEqual([true, true, false]);

      expect(
        await prefetchBlobs(config, clone, oids, { deadlineAt, chunk: 1, budgetBytes: 1 << 30 }),
      ).toBe(true);
      const all = (await objectSizes(clone, oids)) as Map<string, number | null>;
      expect(oids.every((oid) => all.get(oid) !== null)).toBe(true);

      // One batch that itself passes the budget is reported too: false means "not within it".
      const second = join(tempDir("clone"), "repo");
      await cloneMetadata(config, second, 60_000);
      expect(
        await prefetchBlobs(config, second, oids, { deadlineAt, chunk: 10, budgetBytes: 4000 }),
      ).toBe(false);
    },
    T,
  );

  test(
    "a deadline already past fetches nothing",
    async () => {
      fresh();
      const repo = new Repo();
      repo.file("sourcedata/s.json", JSON.stringify({ pad: "x".repeat(3000) }));
      const head = repo.commit("one large blob");
      const config = { ...inProcessConfig(repo), blobLimit: "1k" };
      const clone = join(tempDir("clone"), "repo");
      await cloneMetadata(config, clone, 60_000);
      const oids = (await listTree(clone, head))?.entries.map((t) => t.oid) as string[];
      expect(
        await prefetchBlobs(config, clone, oids, {
          deadlineAt: Date.now() - 1,
          chunk: 10,
          budgetBytes: 1 << 30,
        }),
      ).toBe(false);
      expect((await objectSizes(clone, oids))?.get(oids[0] as string)).toBeNull();
    },
    T,
  );
});

describe("deliverReport", () => {
  test("does not follow a redirect, so the token goes where it was sent and nowhere else", async () => {
    let followed = false;
    let asked = 0;
    const target = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        followed = true;
        return new Response("{}");
      },
    });
    const redirector = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        asked++;
        return new Response("", {
          status: 307,
          headers: { Location: `http://127.0.0.1:${target.port}/x` },
        });
      },
    });
    try {
      const delivered = await deliverReport({
        url: `http://127.0.0.1:${redirector.port}/x`,
        token: TOKEN,
        body: {},
        backoffMs: 1,
      });
      expect(delivered).toBe(false);
      expect(followed).toBe(false);
      // A redirect is final: asked once, not retried against a URL that will not change its mind.
      expect(asked).toBe(1);
    } finally {
      redirector.stop(true);
      target.stop(true);
    }
  });
});
