/**
 * The scrub hash stage (`scripts/scrub/hash/hash_stage.py`), run as the real program.
 *
 * Every test spawns `python3 hash_stage.py ...` and reads back the files it wrote. The source of
 * objects is a real shell command over real files (`--source-cmd 'cat <dir>/{key}'`), so the
 * program's own subprocess, pipe, chunking, retry and timeout code all run. The one test that
 * uses the program's DEFAULT source runs the real `aws` CLI against a local S3 stand-in, the
 * pattern of test/rename-archives-tagging.test.ts, and is skipped when `aws` is absent.
 *
 * The expected new key is computed here, independently, with node:crypto:
 * `SHA256E-s<size>--sha256(patch + original[256:])<ext>`. The test never calls the program's own
 * helpers to compute it, so a transposed rule in the program cannot also be in the expectation.
 *
 * The objects are EDF-shaped (a 256-byte ASCII header, invented values) followed by a
 * deterministic payload, and the header carries an invented name that no output may contain.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "bun";
import {
  type AssembledFile,
  type HashesFile,
  type PlanFile,
  type PlanKey,
  parseAssembled,
  parseHashes,
} from "../../../scripts/scrub/contract";
import { toolOrFail } from "../helpers/require-tools";
import { startS3Standin } from "../helpers/s3-standin";

const SCRIPT = join(import.meta.dir, "..", "..", "..", "scripts", "scrub", "hash", "hash_stage.py");
const SCRIPT_DIR = join(import.meta.dir, "..", "..", "..", "scripts", "scrub", "hash");
const CHUNK = 8 * 1024 * 1024;
const DATASET = "nm099999";
const NAME = "Zorblat_Quimby";
const TIMEOUT_MS = 60_000;

// --- fixtures -----------------------------------------------------------------------------------

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function shq(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Deterministic bytes: xorshift32, so a few MiB cost nothing and every seed differs. */
function payload(size: number, seed: number): Buffer {
  const words = new Uint32Array(Math.ceil(size / 4));
  let x = Math.imul(seed + 1, 2654435761) >>> 0 || 1;
  for (let i = 0; i < words.length; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    words[i] = x;
  }
  return Buffer.from(words.buffer, 0, size);
}

function field(text: string, width: number): string {
  return text.padEnd(width, " ").slice(0, width);
}

/** The 256-byte EDF fixed header: 8+80+80+8+8+8+44+8+8+4. */
function edfHeader(patient: string, recording: string): Buffer {
  const text =
    field("0", 8) +
    field(patient, 80) +
    field(recording, 80) +
    field("01.01.90", 8) +
    field("12.00.00", 8) +
    field("256", 8) +
    field("", 44) +
    field("12", 8) +
    field("1", 8) +
    field("2", 4);
  const header = Buffer.from(text, "latin1");
  if (header.length !== 256) throw new Error("fixture header is not 256 bytes");
  return header;
}

const ORIGINAL_HEADER = edfHeader(
  `X F 01-JAN-1990 ${NAME}`,
  `Startdate 01-JAN-2020 X ${NAME} BioSemi`,
);
const SCRUBBED_HEADER = edfHeader("X X X X", "Startdate X X X X");

interface Obj {
  oldKey: string;
  size: number;
  ext: string;
  content: Buffer;
  patch: Buffer;
  /** What the new key must be, computed here from the bytes alone. */
  newKey: string;
  /** The scrubbed object's bytes, as the assemble stage would have stored them. */
  newContent: Buffer;
}

let seedCounter = 0;

function makeObject(size: number, ext = ".edf", patch: Buffer = SCRUBBED_HEADER): Obj {
  const content =
    size >= 256
      ? Buffer.concat([ORIGINAL_HEADER, payload(size - 256, ++seedCounter)])
      : ORIGINAL_HEADER.subarray(0, size);
  const newContent =
    size >= 256 ? Buffer.concat([patch, content.subarray(256)]) : Buffer.from(content);
  return {
    oldKey: `SHA256E-s${size}--${sha256(content)}${ext}`,
    size,
    ext,
    content,
    patch,
    newKey: `SHA256E-s${size}--${sha256(newContent)}${ext}`,
    newContent,
  };
}

/** The same original, scrubbed with another patch: its new key is for other bytes. */
function repatch(o: Obj, patch: Buffer): Obj {
  const newContent = Buffer.concat([patch, o.content.subarray(256)]);
  return {
    ...o,
    patch,
    newContent,
    newKey: `SHA256E-s${o.size}--${sha256(newContent)}${o.ext}`,
  };
}

interface Workspace {
  dir: string;
  objects: string;
  plan: string;
  patches: string;
  hashes: string;
  log: string;
  sourceCmd: string;
}

function workspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "hash-stage-"));
  roots.push(dir);
  const objects = join(dir, "objects");
  mkdirSync(objects);
  return {
    dir,
    objects,
    plan: join(dir, "plan.json"),
    patches: join(dir, "patches.json"),
    hashes: join(dir, "hashes.json"),
    log: join(dir, "invocations.log"),
    sourceCmd: `cat ${shq(objects)}/{key}`,
  };
}

/** Store an object's bytes under a key; `bytes` defaults to the object's own content. */
function store(ws: Workspace, key: string, bytes: Uint8Array): void {
  writeFileSync(join(ws.objects, key), bytes);
}

/**
 * A source script. It sees $KEY, $VERSION, $LOG, $OBJECTS and $HASHES; `body` is its text and
 * `args` what the template passes it (verify-new must name `{version}`).
 */
function installSource(ws: Workspace, body: string, args = "{key}"): void {
  const script = join(ws.dir, "src.sh");
  writeFileSync(
    script,
    `#!/bin/sh\nLOG=${shq(ws.log)}\nOBJECTS=${shq(ws.objects)}\nHASHES=${shq(ws.hashes)}\nKEY="$1"\nVERSION="$2"\n${body}\n`,
  );
  ws.sourceCmd = `sh ${shq(script)} ${args}`;
}

const LOGGING_SOURCE = 'echo "$KEY" >> "$LOG"\ncat "$OBJECTS/$KEY"';

function readLog(ws: Workspace): string[] {
  return existsSync(ws.log)
    ? readFileSync(ws.log, "utf8")
        .split("\n")
        .filter((l) => l !== "")
    : [];
}

interface Staged {
  obj: Obj;
  needsScrub?: boolean;
  status?: PlanKey["status"];
  /** False leaves the key out of patches.json. */
  patched?: boolean;
  /** Skip writing the object's file: a key the program must never ask for. */
  absent?: boolean;
}

/** Write plan.json and patches.json (and the objects) for the given keys. */
function stage(ws: Workspace, items: Staged[], opts: { bucket?: string } = {}): void {
  const keys: PlanKey[] = items.map((i) => ({
    oldKey: i.obj.oldKey,
    size: i.obj.size,
    needsScrub: i.needsScrub ?? true,
    versionIds: ["v1"],
    reasons: i.needsScrub === false ? [] : ["edf-patient-id"],
    status: i.status ?? "read",
  }));
  const plan: PlanFile = {
    version: 1,
    dataset: DATASET,
    bucket: opts.bucket ?? "nemar",
    tags: ["v1.0.0"],
    createdAt: "2026-10-04T00:00:00Z",
    keys,
    totals: {
      keys: keys.length,
      needScrub: keys.filter((k) => k.needsScrub).length,
      bytesToHash: keys.filter((k) => k.needsScrub).reduce((n, k) => n + k.size, 0),
      unreadable: keys.filter((k) => k.status !== "read").length,
    },
  };
  writeFileSync(ws.plan, JSON.stringify(plan));
  const patches: Record<string, string> = {};
  for (const i of items) {
    if (i.patched !== false) patches[i.obj.oldKey] = i.obj.patch.toString("hex");
    if (!i.absent) store(ws, i.obj.oldKey, i.obj.content);
  }
  writePatches(ws, JSON.stringify(patches));
}

/**
 * Write patches.json and bind plan.json to its exact bytes, as the plan stage does, so a test that
 * changes the patches reaches the check it is about rather than `patches-stale`.
 */
function writePatches(ws: Workspace, text: string): void {
  writeFileSync(ws.patches, text);
  let plan: PlanFile;
  try {
    plan = JSON.parse(readFileSync(ws.plan, "utf8")) as PlanFile;
  } catch {
    return;
  }
  plan.patchesSha256 = sha256(Buffer.from(text, "utf8"));
  writeFileSync(ws.plan, JSON.stringify(plan));
}

/** What an entry must name for a patch: the sha256 of its 512 hex characters, computed here. */
const patchBinding = (patch: Buffer): string => sha256(Buffer.from(patch.toString("hex"), "utf8"));

function expectedHashes(objs: Obj[]): HashesFile {
  const entries: HashesFile["entries"] = {};
  for (const o of objs) {
    entries[o.oldKey] = {
      newKey: o.newKey,
      size: o.size,
      sourceSha256Verified: true,
      patchSha256: patchBinding(o.patch),
    };
  }
  return { version: 1, dataset: DATASET, entries };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// --- running the program ------------------------------------------------------------------------

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

async function py(args: string[], env: Record<string, string> = {}): Promise<Run> {
  const started = Date.now();
  const proc = Bun.spawn(["python3", SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr, ms: Date.now() - started };
}

function computeArgs(ws: Workspace, extra: string[] = []): string[] {
  return [
    "compute",
    "--plan",
    ws.plan,
    "--patches",
    ws.patches,
    "--out",
    ws.hashes,
    "--source-cmd",
    ws.sourceCmd,
    "--retries",
    "0",
    "--retry-backoff",
    "0",
    ...extra,
  ];
}

// --- compute ------------------------------------------------------------------------------------

describe("compute: the new key", () => {
  test(
    "is SHA256E-s<size>--sha256(patch + original[256:]) with the extension kept, at every size",
    async () => {
      const ws = workspace();
      const objs = [
        makeObject(1024 * 1024 + 17, ".edf"),
        makeObject(256, ".bdf"), // exactly the header: the new content IS the patch
        makeObject(CHUNK, ".edf"), // exactly one chunk
        makeObject(CHUNK + 300, ".bdf"), // one chunk and a little
        makeObject(2 * CHUNK + 5000, ".fif.gz"), // three chunks
        makeObject(4096, ""), // no extension at all
      ];
      stage(
        ws,
        objs.map((obj) => ({ obj })),
      );

      const run = await py(computeArgs(ws, ["--workers", "4"]));
      expect(run.code, run.stderr).toBe(0);

      const written = readJson<HashesFile>(ws.hashes);
      expect(written).toEqual(expectedHashes(objs));
      // The contract's own reader accepts the file and finds the size and extension kept.
      const parsed = parseHashes(readFileSync(ws.hashes, "utf8"));
      for (const o of objs) {
        expect(parsed.entries[o.oldKey]?.newKey).toBe(o.newKey);
        expect(o.newKey).not.toBe(o.oldKey);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "the patched stream is the original with its first 256 bytes replaced, not 255 and not 257",
    async () => {
      // A patch that is one byte off the header it replaces: a boundary at 255 or 257 changes it.
      const odd = Buffer.from(SCRUBBED_HEADER);
      odd[255] = 0x5a;
      const objs = [makeObject(5000, ".edf", odd)];
      const ws = workspace();
      stage(
        ws,
        objs.map((obj) => ({ obj })),
      );
      expect((await py(computeArgs(ws))).code).toBe(0);
      expect(readJson<HashesFile>(ws.hashes).entries[objs[0]?.oldKey ?? ""]?.newKey).toBe(
        objs[0]?.newKey,
      );
    },
    TIMEOUT_MS,
  );

  test(
    "a header spread across short reads is still patched at byte 256",
    async () => {
      // A pipe may hand over fewer bytes than asked for. The real function, a real byte source
      // that returns 100 bytes per read, in the real module imported without running main.
      const code = `
import io, json, sys
sys.path.insert(0, ${JSON.stringify(SCRIPT_DIR)})
import hash_stage as h
class Trickle:
    def __init__(self, data):
        self.f = io.BytesIO(data)
    def read(self, n):
        return self.f.read(min(n, 100))
patch = bytes.fromhex(sys.argv[1])
out = []
for size in (255, 256, 257, 700):
    data = bytes((i * 7 + 3) % 251 for i in range(size))
    d = h.digest_stream(Trickle(data), size, patch)
    out.append([d.total, d.original, d.patched])
print(json.dumps(out))
`;
      const proc = Bun.spawn(["python3", "-c", code, SCRUBBED_HEADER.toString("hex")], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      });
      const [out, err, status] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(status, err).toBe(0);
      const expected = [255, 256, 257, 700].map((size) => {
        const data = Buffer.from(Array.from({ length: size }, (_, i) => (i * 7 + 3) % 251));
        const patched =
          size >= 256 ? sha256(Buffer.concat([SCRUBBED_HEADER, data.subarray(256)])) : null;
        return [size, sha256(data), patched];
      });
      expect(JSON.parse(out)).toEqual(expected);
    },
    TIMEOUT_MS,
  );
});

describe("compute: the original must be what its key says", () => {
  test(
    "bytes that do not hash to the key are reported by key, never written, and fail the run",
    async () => {
      const ws = workspace();
      const good = makeObject(4000);
      const bad = makeObject(4000);
      stage(ws, [{ obj: good }, { obj: bad }]);
      // Same size, one byte different: only the hash can tell.
      const wrong = Buffer.from(bad.content);
      wrong[2000] = (wrong[2000] ?? 0) ^ 0xff;
      store(ws, bad.oldKey, wrong);

      const run = await py(computeArgs(ws));
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(`FAIL ${bad.oldKey}`);
      expect(run.stderr).toContain("does not hash to its key");
      expect(run.stderr).not.toContain(`FAIL ${good.oldKey}`);
      const written = readJson<HashesFile>(ws.hashes);
      expect(Object.keys(written.entries)).toEqual([good.oldKey]);
      expect(readFileSync(ws.hashes, "utf8")).not.toContain(bad.oldKey);
    },
    TIMEOUT_MS,
  );

  test(
    "a size that disagrees with the key fails even when the hash agrees, in both directions",
    async () => {
      const ws = workspace();
      const good = makeObject(4000);
      const base = makeObject(4000);
      // The key's hash is right for the bytes, the key's size is not.
      const tooBig = `SHA256E-s4001--${sha256(base.content)}.edf`;
      const tooSmall = `SHA256E-s3999--${sha256(base.content)}.edf`;
      const items: Staged[] = [
        { obj: good },
        { obj: { ...base, oldKey: tooBig, size: 4001 } },
        { obj: { ...base, oldKey: tooSmall, size: 3999 } },
      ];
      stage(ws, items);
      store(ws, tooBig, base.content);
      store(ws, tooSmall, base.content);

      const run = await py(computeArgs(ws));
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(`FAIL ${tooBig}: read 4000 bytes but the key says 4001`);
      expect(run.stderr).toContain(`FAIL ${tooSmall}: object is longer than its key says`);
      expect(Object.keys(readJson<HashesFile>(ws.hashes).entries)).toEqual([good.oldKey]);
    },
    TIMEOUT_MS,
  );

  test(
    "an object shorter than the header is refused cleanly, with no traceback and no entry",
    async () => {
      const ws = workspace();
      const good = makeObject(4000);
      const tiny = makeObject(100);
      stage(ws, [{ obj: good }, { obj: tiny }]);

      const run = await py(computeArgs(ws));
      expect(run.code).toBe(1);
      expect(run.stderr).not.toContain("Traceback");
      expect(run.stderr).toContain(
        `FAIL ${tiny.oldKey}: object is shorter than the 256-byte header`,
      );
      expect(Object.keys(readJson<HashesFile>(ws.hashes).entries)).toEqual([good.oldKey]);
    },
    TIMEOUT_MS,
  );

  test(
    "a patch that leaves the object unchanged is refused: the contract forbids new key == old key",
    async () => {
      const ws = workspace();
      const same = makeObject(4000, ".edf", ORIGINAL_HEADER);
      stage(ws, [{ obj: same }]);

      const run = await py(computeArgs(ws));
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(`FAIL ${same.oldKey}: the patch leaves the object unchanged`);
      expect(readJson<HashesFile>(ws.hashes).entries).toEqual({});
    },
    TIMEOUT_MS,
  );

  test(
    "a needed key with no patch fails the run and is never read",
    async () => {
      const ws = workspace();
      const good = makeObject(4000);
      const orphan = makeObject(4000);
      stage(ws, [{ obj: good }, { obj: orphan, patched: false }]);
      installSource(ws, LOGGING_SOURCE);

      const run = await py(computeArgs(ws));
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(`FAIL ${orphan.oldKey}: no patch for this key`);
      expect(readLog(ws)).toEqual([good.oldKey]);
    },
    TIMEOUT_MS,
  );
});

describe("compute: which keys are read", () => {
  test(
    "keys that need no scrub are never read",
    async () => {
      const ws = workspace();
      const needed = makeObject(4000);
      const clean = makeObject(4000);
      stage(ws, [{ obj: needed }, { obj: clean, needsScrub: false, absent: true }]);
      installSource(ws, LOGGING_SOURCE);

      const run = await py(computeArgs(ws));
      expect(run.code, run.stderr).toBe(0);
      expect(readLog(ws)).toEqual([needed.oldKey]);
      expect(readJson<HashesFile>(ws.hashes)).toEqual(expectedHashes([needed]));
    },
    TIMEOUT_MS,
  );

  test(
    "a plan with a key it could not read, or a partial plan, is refused: nothing read or written",
    async () => {
      const ws = workspace();
      const needed = makeObject(4000);
      const unread = makeObject(4000);
      stage(ws, [{ obj: needed }, { obj: unread, needsScrub: false, status: "unreadable" }]);
      installSource(ws, LOGGING_SOURCE);
      const run = await py(computeArgs(ws));
      expect(run.code, run.stderr).toBe(3);
      expect(run.stderr).toContain("the plan is incomplete");
      expect(readLog(ws)).toEqual([]);
      expect(existsSync(ws.hashes)).toBe(false);

      stage(ws, [{ obj: needed }]);
      writeFileSync(ws.plan, JSON.stringify({ ...readJson<PlanFile>(ws.plan), partial: true }));
      const partial = await py(computeArgs(ws));
      expect(partial.code, partial.stderr).toBe(3);
      expect(partial.stderr).toContain("partial");
      expect(readLog(ws)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "a plan whose totals disagree with its keys, or that names no bucket, is refused",
    async () => {
      const ws = workspace();
      const o = makeObject(4000);
      stage(ws, [{ obj: o }]);
      const plan = readJson<PlanFile>(ws.plan);
      const key = plan.keys[0] as PlanKey;
      const other: PlanKey = {
        ...key,
        oldKey: `SHA256E-s9--${"e".repeat(64)}.edf`,
        size: 9,
        needsScrub: false,
        status: "unreadable",
      };
      const cases: Array<[string, unknown]> = [
        // Hiding an unreadable key, or shrinking the bytes to hash: the TS parser refuses both.
        ["unreadable hidden", { ...plan, keys: [key, other], totals: { ...plan.totals, keys: 2 } }],
        ["bytes shrunk", { ...plan, totals: { ...plan.totals, bytesToHash: 1 } }],
        ["needScrub wrong", { ...plan, totals: { ...plan.totals, needScrub: 0 } }],
        ["keys wrong", { ...plan, totals: { ...plan.totals, keys: 5 } }],
        ["size disagrees with the key", { ...plan, keys: [{ ...key, size: 3999 }] }],
        [
          "needsScrub on an unread key",
          {
            ...plan,
            keys: [{ ...key, status: "unreadable" }],
            totals: { ...plan.totals, unreadable: 1 },
          },
        ],
        [
          "the same key twice",
          {
            ...plan,
            keys: [key, key],
            totals: { ...plan.totals, keys: 2, needScrub: 2, bytesToHash: 8000 },
          },
        ],
        ["no bucket", { ...plan, bucket: undefined }],
        ["empty dataset", { ...plan, dataset: "" }],
      ];
      for (const [label, edited] of cases) {
        writeFileSync(ws.plan, JSON.stringify(edited));
        const run = await py(computeArgs(ws));
        expect(run.code, label).toBe(3);
        expect(existsSync(ws.hashes), label).toBe(false);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a recording kept inline in git is carried only as an unreadable entry, so the plan is refused",
    async () => {
      const ws = workspace();
      const o = makeObject(4000);
      stage(ws, [{ obj: o }]);
      const plan = readJson<PlanFile>(ws.plan);
      const inline: PlanKey = {
        oldKey: `git:${"b".repeat(40)}`,
        size: 0,
        needsScrub: false,
        versionIds: [],
        reasons: ["git-inline-recording"],
        status: "unreadable",
      };
      const withEntry = (entry: PlanKey) => {
        const keys = [...plan.keys, entry];
        const totals = {
          ...plan.totals,
          keys: keys.length,
          unreadable: keys.filter((k) => k.status === "unreadable").length,
        };
        writeFileSync(ws.plan, JSON.stringify({ ...plan, keys, totals }));
      };
      installSource(ws, LOGGING_SOURCE);
      // A well-formed inline entry: the plan parses, and is incomplete, so nothing is read.
      withEntry(inline);
      const incomplete = await py(computeArgs(ws));
      expect(incomplete.code, incomplete.stderr).toBe(3);
      expect(incomplete.stderr).toContain("the plan is incomplete");
      expect(readLog(ws)).toEqual([]);

      // The same key on an entry the plan says it READ, or not a blob sha at all: refused.
      for (const entry of [
        { ...inline, status: "read" as const },
        { ...inline, oldKey: "git:zzzz" },
        { ...inline, oldKey: `git:${"B".repeat(40)}` },
        { ...inline, oldKey: `git:${"b".repeat(41)}` },
      ]) {
        withEntry(entry);
        rmSync(ws.hashes, { force: true });
        const refused = await py(computeArgs(ws));
        expect(refused.code, JSON.stringify(entry)).toBe(3);
        expect(existsSync(ws.hashes)).toBe(false);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "an empty plan writes an empty hashes file and succeeds",
    async () => {
      const ws = workspace();
      stage(ws, []);
      const run = await py(computeArgs(ws));
      expect(run.code, run.stderr).toBe(0);
      expect(readJson<HashesFile>(ws.hashes)).toEqual({
        version: 1,
        dataset: DATASET,
        entries: {},
      });
    },
    TIMEOUT_MS,
  );
});

describe("compute: resuming and parallelism", () => {
  test(
    "a resumed run skips the keys already hashed and a finished run reads nothing",
    async () => {
      const ws = workspace();
      const objs = [1, 2, 3, 4, 5].map((n) => makeObject(3000 + n));
      stage(
        ws,
        objs.map((obj) => ({ obj })),
      );
      installSource(ws, LOGGING_SOURCE);

      const first = await py(computeArgs(ws, ["--workers", "1", "--limit", "2"]));
      expect(first.code, first.stderr).toBe(4); // stopped by --limit with keys left
      expect(Object.keys(readJson<HashesFile>(ws.hashes).entries)).toHaveLength(2);
      expect(readLog(ws)).toHaveLength(2);

      const second = await py(computeArgs(ws, ["--workers", "2"]));
      expect(second.code, second.stderr).toBe(0);
      const log = readLog(ws);
      expect(log).toHaveLength(5);
      expect(new Set(log).size).toBe(5); // no key was read twice
      expect(readJson<HashesFile>(ws.hashes)).toEqual(expectedHashes(objs));

      const before = readFileSync(ws.hashes, "utf8");
      const third = await py(computeArgs(ws));
      expect(third.code, third.stderr).toBe(0);
      expect(readLog(ws)).toHaveLength(5);
      expect(readFileSync(ws.hashes, "utf8")).toBe(before);
    },
    TIMEOUT_MS,
  );

  test(
    "an entry is reused only for the patch it was computed for; any other patch is recomputed",
    async () => {
      const ws = workspace();
      const a = makeObject(3000);
      const b = makeObject(3001);
      stage(ws, [{ obj: a }, { obj: b }]);
      installSource(ws, LOGGING_SOURCE);
      expect((await py(computeArgs(ws))).code).toBe(0);
      expect(readJson<HashesFile>(ws.hashes)).toEqual(expectedHashes([a, b]));

      // The patch for A changes (a different scrub), the one for B does not: only A is read again,
      // and its new key is for the new patch.
      const a2 = repatch(a, edfHeader("Y Y Y Y", "Startdate Y Y Y Y"));
      expect(a2.newKey).not.toBe(a.newKey);
      writePatches(
        ws,
        JSON.stringify({
          [a.oldKey]: a2.patch.toString("hex"),
          [b.oldKey]: b.patch.toString("hex"),
        }),
      );
      rmSync(ws.log);
      const second = await py(computeArgs(ws));
      expect(second.code, second.stderr).toBe(0);
      expect(second.stderr).toContain("1 entries were made for another patch");
      expect(readLog(ws)).toEqual([a.oldKey]);
      expect(readJson<HashesFile>(ws.hashes)).toEqual(expectedHashes([a2, b]));

      // An entry from before entries named their patch is not trusted: both are read again.
      const old = readJson<HashesFile>(ws.hashes);
      for (const e of Object.values(old.entries)) {
        (e as { patchSha256?: string }).patchSha256 = undefined;
      }
      writeFileSync(ws.hashes, JSON.stringify(old));
      rmSync(ws.log);
      const third = await py(computeArgs(ws));
      expect(third.code, third.stderr).toBe(0);
      expect(readLog(ws).sort()).toEqual([a.oldKey, b.oldKey].sort());
      expect(readJson<HashesFile>(ws.hashes)).toEqual(expectedHashes([a2, b]));

      // A key whose patch is gone cannot keep its entry: it is dropped and reported.
      writePatches(ws, JSON.stringify({ [b.oldKey]: b.patch.toString("hex") }));
      const fourth = await py(computeArgs(ws));
      expect(fourth.code, fourth.stderr).toBe(1);
      expect(fourth.stderr).toContain("no patch for this key");
      expect(Object.keys(readJson<HashesFile>(ws.hashes).entries)).toEqual([b.oldKey]);

      // A binding that is not a sha256 is a file this program would not have written.
      const bad = expectedHashes([b]);
      (bad.entries[b.oldKey] as { patchSha256: string }).patchSha256 = "nope";
      writeFileSync(ws.hashes, JSON.stringify(bad));
      expect((await py(computeArgs(ws))).code).toBe(3);
    },
    TIMEOUT_MS,
  );

  test(
    "a key whose size is written in non-ASCII digits is refused wherever a key is read",
    async () => {
      const ws = workspace();
      const o = makeObject(3000);
      stage(ws, [{ obj: o }]);
      const goodPlan = readJson<PlanFile>(ws.plan);
      const patchHex = o.patch.toString("hex");
      for (const digits of ["\u0663\u0660\u0660\u0660", "\uFF13\uFF10\uFF10\uFF10"]) {
        // Python's int() reads these as 3000, which no other reader of the key would.
        const bad = o.oldKey.replace("s3000", `s${digits}`);
        expect(bad).not.toBe(o.oldKey);
        const plan = structuredClone(goodPlan);
        (plan.keys[0] as PlanKey).oldKey = bad;
        writeFileSync(ws.plan, JSON.stringify(plan));
        expect((await py(computeArgs(ws))).code, "plan").toBe(3);

        writeFileSync(ws.plan, JSON.stringify(goodPlan));
        writePatches(ws, JSON.stringify({ [bad]: patchHex }));
        expect((await py(computeArgs(ws))).code, "patches").toBe(3);
        writePatches(ws, JSON.stringify({ [o.oldKey]: patchHex }));

        const assembled = join(ws.dir, "assembled.json");
        writeFileSync(
          assembled,
          JSON.stringify({
            version: 1,
            dataset: DATASET,
            bucket: "nemar",
            entries: { [o.oldKey]: { newKey: bad } },
          }),
        );
        const verify = await py([
          "verify-new",
          "--assembled",
          assembled,
          "--out",
          join(ws.dir, "proof.json"),
          "--source-cmd",
          ws.sourceCmd,
        ]);
        expect(verify.code, "assembled").toBe(3);
      }
      expect(existsSync(ws.hashes)).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "a hashes file from another dataset, or naming keys the plan does not need, is refused untouched",
    async () => {
      const ws = workspace();
      const objs = [makeObject(3000), makeObject(3001)];
      stage(
        ws,
        objs.map((obj) => ({ obj })),
      );

      const foreign = { ...expectedHashes([objs[0] as Obj]), dataset: "nm000001" };
      writeFileSync(ws.hashes, JSON.stringify(foreign));
      const a = await py(computeArgs(ws));
      expect(a.code).toBe(3);
      expect(JSON.parse(readFileSync(ws.hashes, "utf8"))).toEqual(foreign);

      const stranger = makeObject(3002);
      const extra = expectedHashes([stranger]);
      writeFileSync(ws.hashes, JSON.stringify(extra));
      const b = await py(computeArgs(ws));
      expect(b.code).toBe(3);
      expect(b.stderr).toContain("keys this plan does not need");
      expect(JSON.parse(readFileSync(ws.hashes, "utf8"))).toEqual(extra);
    },
    TIMEOUT_MS,
  );

  test(
    "one worker and eight workers write byte-identical files",
    async () => {
      const ws = workspace();
      const objs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => makeObject(1000 * n + 300));
      stage(
        ws,
        objs.map((obj) => ({ obj })),
      );
      const serial = await py(computeArgs(ws, ["--workers", "1"]));
      expect(serial.code, serial.stderr).toBe(0);
      const serialText = readFileSync(ws.hashes, "utf8");
      rmSync(ws.hashes);
      const parallel = await py(computeArgs(ws, ["--workers", "8"]));
      expect(parallel.code, parallel.stderr).toBe(0);
      expect(readFileSync(ws.hashes, "utf8")).toBe(serialText);
      expect(JSON.parse(serialText)).toEqual(expectedHashes(objs));
    },
    TIMEOUT_MS,
  );

  test(
    "hashes.json is rewritten as keys finish, atomically: always whole, a new file each time",
    async () => {
      const ws = workspace();
      const objs = [1, 2, 3, 4, 5].map((n) => makeObject(2000 + n));
      stage(
        ws,
        objs.map((obj) => ({ obj })),
      );
      // Before each read, record hashes.json's inode and entry count. A rename-into-place gives a
      // new inode every time; an in-place rewrite keeps one. The sleep lets the previous key's
      // checkpoint land first.
      installSource(
        ws,
        `sleep 0.4
if [ -f "$HASHES" ]; then
  ino=$(ls -i "$HASHES" | awk '{print $1}')
  n=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["entries"]))' "$HASHES" 2>/dev/null) || n=corrupt
else
  ino=none; n=absent
fi
echo "$ino $n" >> "$LOG"
cat "$OBJECTS/$KEY"`,
      );

      const run = await py(computeArgs(ws, ["--workers", "1", "--checkpoint-every", "1"]));
      expect(run.code, run.stderr).toBe(0);

      const samples = readLog(ws).map((l) => l.split(" ") as [string, string]);
      expect(samples.map((s) => s[1])).toEqual(["absent", "1", "2", "3", "4"]);
      const inodes = samples.slice(1).map((s) => s[0]);
      for (let i = 1; i < inodes.length; i++) expect(inodes[i]).not.toBe(inodes[i - 1]);
      expect(readJson<HashesFile>(ws.hashes)).toEqual(expectedHashes(objs));
    },
    TIMEOUT_MS,
  );
});

describe("compute: a source that misbehaves", () => {
  test(
    "a failed read is retried up to three times, and each attempt is a fresh read",
    async () => {
      const ws = workspace();
      const flaky = makeObject(3000);
      const dead = makeObject(3001);
      stage(ws, [{ obj: flaky }, { obj: dead }]);
      installSource(
        ws,
        `echo "$KEY" >> "$LOG"
if [ "$KEY" = ${shq(dead.oldKey)} ]; then
  echo "AccessDenied while reading" >&2
  exit 7
fi
count=$(grep -c "^$KEY$" "$LOG")
if [ "$count" -lt 3 ]; then exit 1; fi
cat "$OBJECTS/$KEY"`,
      );

      const run = await py(computeArgs(ws, ["--retries", "3"]));
      expect(run.code).toBe(1);
      const log = readLog(ws);
      expect(log.filter((k) => k === flaky.oldKey)).toHaveLength(3); // fails twice, then reads
      expect(log.filter((k) => k === dead.oldKey)).toHaveLength(4); // 1 attempt + 3 retries
      const written = readJson<HashesFile>(ws.hashes);
      expect(Object.keys(written.entries)).toEqual([flaky.oldKey]);
      expect(run.stderr).toContain(`FAIL ${dead.oldKey}: read failed after 4 attempts`);
      expect(run.stderr).toContain("status 7");
      expect(run.stderr).toContain("AccessDenied while reading");
    },
    TIMEOUT_MS,
  );

  test(
    "with no retries a failed read is attempted once",
    async () => {
      const ws = workspace();
      const dead = makeObject(3000);
      stage(ws, [{ obj: dead }]);
      installSource(ws, 'echo "$KEY" >> "$LOG"\nexit 1');
      const run = await py(computeArgs(ws, ["--retries", "0"]));
      expect(run.code).toBe(1);
      expect(readLog(ws)).toEqual([dead.oldKey]);
    },
    TIMEOUT_MS,
  );

  test(
    "a source that outlives --timeout is killed, and the other keys still hash",
    async () => {
      const ws = workspace();
      const hung = makeObject(3000);
      const fine = makeObject(3001);
      stage(ws, [{ obj: hung }, { obj: fine }]);
      installSource(
        ws,
        `if [ "$KEY" = ${shq(hung.oldKey)} ]; then sleep 120; fi\ncat "$OBJECTS/$KEY"`,
      );

      // 5 s per attempt: enough for a `cat` of 3 KB on a loaded machine, far less than the
      // two minutes the hung source wants.
      const run = await py(computeArgs(ws, ["--timeout", "5", "--workers", "2"]));
      expect(run.code).toBe(1);
      expect(run.ms).toBeLessThan(90_000); // not the 120 s the source wanted
      expect(run.stderr).toContain(`FAIL ${hung.oldKey}`);
      expect(run.stderr).toContain("no complete read within 5 seconds");
      expect(Object.keys(readJson<HashesFile>(ws.hashes).entries)).toEqual([fine.oldKey]);
    },
    TIMEOUT_MS,
  );

  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const) {
    test(
      `${signal} stops the running source commands and keeps the keys already hashed`,
      async () => {
        const ws = workspace();
        const fast = makeObject(3000);
        const slow = makeObject(3001);
        stage(ws, [{ obj: fast }, { obj: slow }]);
        const pidFile = join(ws.dir, "slow.pid");
        installSource(
          ws,
          `if [ "$KEY" = ${shq(slow.oldKey)} ]; then echo $$ > ${shq(pidFile)}; exec sleep 60; fi\ncat "$OBJECTS/$KEY"`,
        );

        const args = computeArgs(ws, ["--workers", "2", "--checkpoint-every", "1"]);
        const proc = Bun.spawn(["python3", SCRIPT, ...args], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        });
        const done = Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        for (let i = 0; i < 300 && !existsSync(pidFile); i++) await Bun.sleep(100);
        expect(existsSync(pidFile)).toBe(true);
        // The fast key is done once hashes.json names it; wait for that, not for a guessed time.
        for (let i = 0; i < 300; i++) {
          if (existsSync(ws.hashes) && fast.oldKey in readJson<HashesFile>(ws.hashes).entries)
            break;
          await Bun.sleep(100);
        }
        proc.kill(signal);
        const [, stderr, exit] = await done;
        expect(exit, stderr).toBe(code);
        expect(stderr).toContain(`interrupted by ${signal}`);

        // The source command (an `aws` in production) was killed with its process group.
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        let alive = true;
        for (let i = 0; i < 100 && alive; i++) {
          try {
            process.kill(pid, 0);
            await Bun.sleep(100);
          } catch {
            alive = false;
          }
        }
        if (alive) process.kill(pid, "SIGKILL");
        expect(alive).toBe(false);
        expect(readJson<HashesFile>(ws.hashes)).toEqual(expectedHashes([fast]));
      },
      TIMEOUT_MS,
    );
  }
});

// --- verify-new ---------------------------------------------------------------------------------

interface AssembledSetup {
  ws: Workspace;
  objs: Obj[];
  assembled: string;
  proof: string;
  assembledBytes: Buffer;
}

/** New objects stored under their new keys, and an assembled.json formatted with TABS so that its
 * exact bytes differ from any re-serialization a careless program might hash instead. */
/** The version assembly recorded for every new object in these fixtures. */
const NEW_VERSION = "v-new";

/** Store bytes as the recorded version of a new object: verify-new reads `<key>@<version>`. */
const storeNew = (ws: Workspace, key: string, bytes: Uint8Array) =>
  store(ws, `${key}@${NEW_VERSION}`, bytes);

function assembledSetup(count = 4): AssembledSetup {
  const ws = workspace();
  // verify-new must name the version; this source reads exactly that version's file.
  ws.sourceCmd = `cat ${shq(ws.objects)}/{key}@{version}`;
  const objs = Array.from({ length: count }, (_, n) => makeObject(5000 + n * 777));
  for (const o of objs) storeNew(ws, o.newKey, o.newContent);
  const file: AssembledFile = {
    version: 1,
    dataset: DATASET,
    bucket: "nemar",
    entries: Object.fromEntries(
      objs.map((o) => [
        o.oldKey,
        {
          newKey: o.newKey,
          newVersionId: NEW_VERSION,
          retainUntil: "2027-01-01T00:00:00Z",
          mode: "GOVERNANCE" as const,
        },
      ]),
    ),
  };
  const assembled = join(ws.dir, "assembled.json");
  const text = `${JSON.stringify(file, null, "\t")}\n`;
  writeFileSync(assembled, text);
  parseAssembled(text); // the fixture is a valid assembled.json
  return {
    ws,
    objs,
    assembled,
    proof: join(ws.dir, "new-hash-verified.json"),
    assembledBytes: Buffer.from(text),
  };
}

function verifyArgs(s: AssembledSetup, extra: string[] = []): string[] {
  return [
    "verify-new",
    "--assembled",
    s.assembled,
    "--out",
    s.proof,
    "--source-cmd",
    s.ws.sourceCmd,
    "--retries",
    "0",
    "--retry-backoff",
    "0",
    ...extra,
  ];
}

describe("verify-new", () => {
  test(
    "correct objects write a proof naming the sha256 of the exact bytes of assembled.json",
    async () => {
      const s = assembledSetup();
      installSource(s.ws, 'echo "$KEY" >> "$LOG"\ncat "$OBJECTS/$KEY@$VERSION"', "{key} {version}");
      const reserialized = JSON.stringify(JSON.parse(s.assembledBytes.toString("utf8")), null, 2);
      expect(sha256(Buffer.from(`${reserialized}\n`))).not.toBe(sha256(s.assembledBytes));

      const run = await py(verifyArgs(s, ["--workers", "3"]));
      expect(run.code, run.stderr).toBe(0);
      expect(readJson<unknown>(s.proof)).toEqual({
        version: 1,
        dataset: DATASET,
        assembledSha256: sha256(s.assembledBytes),
        count: s.objs.length,
      });
      // Every new object was streamed, once.
      expect(readLog(s.ws).sort()).toEqual(s.objs.map((o) => o.newKey).sort());
    },
    TIMEOUT_MS,
  );

  test(
    "one flipped byte in the middle of one new object: nonzero, key reported, no proof",
    async () => {
      const s = assembledSetup();
      const victim = s.objs[2] as Obj;
      const flipped = Buffer.from(victim.newContent);
      const mid = Math.floor(flipped.length / 2);
      flipped[mid] = (flipped[mid] ?? 0) ^ 0x01;
      storeNew(s.ws, victim.newKey, flipped);
      // A proof left by an earlier, successful run must not survive a failing one.
      writeFileSync(s.proof, JSON.stringify({ stale: true }));

      const run = await py(verifyArgs(s));
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(`FAIL ${victim.newKey}: the object does not hash to its key`);
      for (const o of s.objs) {
        if (o !== victim) expect(run.stderr).not.toContain(`FAIL ${o.newKey}`);
      }
      expect(existsSync(s.proof)).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "a short, a long and a missing new object each fail the run and leave no proof",
    async () => {
      const cases: Array<[string, (o: Obj) => Uint8Array | null, string]> = [
        ["short", (o) => o.newContent.subarray(0, o.size - 1), "read 4999 bytes but the key says"],
        [
          "long",
          (o) => Buffer.concat([o.newContent, Buffer.from("x")]),
          "longer than its key says",
        ],
        ["missing", () => null, "source exited with status"],
      ];
      for (const [label, damage, message] of cases) {
        const s = assembledSetup(2);
        const victim = s.objs[0] as Obj;
        const damaged = damage(victim);
        if (damaged) storeNew(s.ws, victim.newKey, damaged);
        else rmSync(join(s.ws.objects, `${victim.newKey}@${NEW_VERSION}`));

        const run = await py(verifyArgs(s));
        expect(run.code, label).toBe(1);
        expect(run.stderr, label).toContain(`FAIL ${victim.newKey}`);
        expect(run.stderr, label).toContain(message);
        expect(existsSync(s.proof), label).toBe(false);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "an unscrubbed object stored under the new key is caught: the hash is of what is there",
    async () => {
      const s = assembledSetup(2);
      const victim = s.objs[1] as Obj;
      storeNew(s.ws, victim.newKey, victim.content); // the old bytes, same size, wrong hash
      const run = await py(verifyArgs(s));
      expect(run.code).toBe(1);
      expect(existsSync(s.proof)).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "a malformed assembled.json is refused with status 2 and no proof",
    async () => {
      const s = assembledSetup(1);
      writeFileSync(
        s.assembled,
        JSON.stringify({ version: 1, dataset: DATASET, entries: { a: 1 } }),
      );
      const run = await py(verifyArgs(s));
      expect(run.code).toBe(3);
      expect(existsSync(s.proof)).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "one worker and four workers write the same proof",
    async () => {
      const s = assembledSetup(6);
      expect((await py(verifyArgs(s, ["--workers", "1"]))).code).toBe(0);
      const serial = readFileSync(s.proof, "utf8");
      rmSync(s.proof);
      expect((await py(verifyArgs(s, ["--workers", "4"]))).code).toBe(0);
      expect(readFileSync(s.proof, "utf8")).toBe(serial);
    },
    TIMEOUT_MS,
  );
});

describe("verify-new: the recorded version", () => {
  test(
    "reads the version assembly recorded, not whatever is current at the key",
    async () => {
      const s = assembledSetup(2);
      const victim = s.objs[0] as Obj;
      // The recorded version is damaged; a later, correct write sits beside it under another id.
      const flipped = Buffer.from(victim.newContent);
      flipped[100] = (flipped[100] ?? 0) ^ 0x01;
      storeNew(s.ws, victim.newKey, flipped);
      store(s.ws, `${victim.newKey}@v-later`, victim.newContent);
      const run = await py(verifyArgs(s));
      expect(run.code).toBe(1);
      expect(run.stderr).toContain(`FAIL ${victim.newKey}: the object does not hash to its key`);
      expect(existsSync(s.proof)).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "a source that does not name the version, or an entry without one, is refused",
    async () => {
      const s = assembledSetup(1);
      const run = await py(verifyArgs(s, ["--source-cmd", `cat ${shq(s.ws.objects)}/{key}`]));
      expect(run.code).toBe(3);
      expect(run.stderr).toContain("names {version}");
      const doc = readJson<AssembledFile>(s.assembled);
      (Object.values(doc.entries)[0] as { newVersionId?: string }).newVersionId = undefined;
      writeFileSync(s.assembled, JSON.stringify(doc));
      expect((await py(verifyArgs(s))).code).toBe(3);
      expect(existsSync(s.proof)).toBe(false);
    },
    TIMEOUT_MS,
  );
});

describe("file modes", () => {
  test(
    "hashes.json and the proof are owner-only, whatever umask the program was started with",
    async () => {
      const ws = workspace();
      const o = makeObject(4000);
      stage(ws, [{ obj: o }]);
      const run = async (args: string[]) => {
        const proc = Bun.spawn(
          ["sh", "-c", `umask 022; exec python3 ${[SCRIPT, ...args].map(shq).join(" ")}`],
          {
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
          },
        );
        const err = await new Response(proc.stderr).text();
        return { code: await proc.exited, err };
      };
      const compute = await run(computeArgs(ws));
      expect(compute.code, compute.err).toBe(0);
      expect(statSync(ws.hashes).mode & 0o777).toBe(0o600);
      const s = assembledSetup(1);
      const verify = await run(verifyArgs(s));
      expect(verify.code, verify.err).toBe(0);
      expect(statSync(s.proof).mode & 0o777).toBe(0o600);

      // The umask reaches the source command too: a file it creates is owner-only.
      const marker = join(ws.dir, "made-by-source");
      rmSync(ws.hashes);
      ws.sourceCmd = `touch ${shq(marker)}; cat ${shq(ws.objects)}/{key}`;
      const withChild = await run(computeArgs(ws));
      expect(withChild.code, withChild.err).toBe(0);
      expect(statSync(marker).mode & 0o777).toBe(0o600);
    },
    TIMEOUT_MS,
  );

  test(
    "write_atomic makes the file and its .tmp owner-only on its own, under any umask",
    async () => {
      const ws = workspace();
      const target = join(ws.dir, "out.json");
      const code = `
import os, sys
sys.path.insert(0, ${JSON.stringify(SCRIPT_DIR)})
import hash_stage
os.umask(0o022)
hash_stage.write_atomic(${JSON.stringify(target)}, "{}\\n")
print(oct(os.stat(${JSON.stringify(target)}).st_mode & 0o777))
`;
      const proc = Bun.spawn(["python3", "-c", code], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      });
      const [out, err, status] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(status, err).toBe(0);
      expect(out.trim()).toBe("0o600");
    },
    TIMEOUT_MS,
  );
});

// --- privacy ------------------------------------------------------------------------------------

describe("no participant value leaves the program", () => {
  test(
    "no output, success or failure, holds the name, the original header or the patch",
    async () => {
      const ws = workspace();
      const good = makeObject(6000);
      const wrongHash = makeObject(6001);
      const tiny = makeObject(100); // its 100 bytes are the start of the identifying header
      const missingPatch = makeObject(6002);
      stage(ws, [
        { obj: good },
        { obj: wrongHash },
        { obj: tiny },
        { obj: missingPatch, patched: false },
      ]);
      const altered = Buffer.from(wrongHash.content);
      altered[3000] = (altered[3000] ?? 0) ^ 0xff;
      store(ws, wrongHash.oldKey, altered);

      const failing = await py(computeArgs(ws));
      expect(failing.code).toBe(1);
      const clean = workspace();
      stage(clean, [{ obj: good }]);
      const passing = await py(computeArgs(clean));
      expect(passing.code).toBe(0);

      // verify-new: one good run and one whose new object still carries the original header.
      const ok = assembledSetup(2);
      const okRun = await py(verifyArgs(ok));
      const bad = assembledSetup(2);
      storeNew(bad.ws, (bad.objs[0] as Obj).newKey, (bad.objs[0] as Obj).content);
      const badRun = await py(verifyArgs(bad));
      expect(okRun.code).toBe(0);
      expect(badRun.code).toBe(1);

      const outputs = [
        failing.stdout,
        failing.stderr,
        passing.stdout,
        passing.stderr,
        okRun.stdout,
        okRun.stderr,
        badRun.stdout,
        badRun.stderr,
        readFileSync(ws.hashes, "utf8"),
        readFileSync(clean.hashes, "utf8"),
        readFileSync(ok.proof, "utf8"),
      ].join("\n");
      expect(outputs.length).toBeGreaterThan(500); // the grep below has something to search

      const secrets = [
        NAME,
        Buffer.from(NAME).toString("hex"),
        Buffer.from(NAME).toString("base64"),
        ORIGINAL_HEADER.toString("hex"),
        ORIGINAL_HEADER.subarray(8, 48).toString("hex"),
        ORIGINAL_HEADER.toString("latin1").trim(),
        SCRUBBED_HEADER.toString("hex"),
        SCRUBBED_HEADER.subarray(8, 48).toString("hex"),
        "Startdate",
        "BioSemi",
      ];
      for (const secret of secrets) expect(outputs).not.toContain(secret);
    },
    TIMEOUT_MS,
  );
});

// --- command line -------------------------------------------------------------------------------

describe("command line", () => {
  test(
    "--help works for the program and both modes",
    async () => {
      const top = await py(["--help"]);
      expect(top.code).toBe(0);
      expect(top.stdout).toContain("compute");
      expect(top.stdout).toContain("verify-new");
      const compute = await py(["compute", "--help"]);
      expect(compute.code).toBe(0);
      for (const flag of [
        "--plan",
        "--patches",
        "--out",
        "--workers",
        "--source-cmd",
        "--dataset-bucket",
        "--timeout",
        "--limit",
      ]) {
        expect(compute.stdout).toContain(flag);
      }
      const verify = await py(["verify-new", "--help"]);
      expect(verify.code).toBe(0);
      for (const flag of ["--assembled", "--out", "--workers", "--source-cmd"]) {
        expect(verify.stdout).toContain(flag);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "unknown arguments, abbreviations, a missing mode and bad numbers are refused",
    async () => {
      const ws = workspace();
      stage(ws, [{ obj: makeObject(3000) }]);
      const base = computeArgs(ws);
      for (const extra of [
        ["--bogus"],
        ["--bogus", "1"],
        ["--work", "2"],
        ["--workers", "0"],
        ["--workers", "x"],
        ["--timeout", "0"],
        ["stray"],
      ]) {
        const run = await py([...base, ...extra]);
        expect(run.code, extra.join(" ")).toBe(2);
        expect(existsSync(ws.hashes), extra.join(" ")).toBe(false);
      }
      expect((await py(["verify-new", "--assembled", "a", "--out", "b", "--bogus"])).code).toBe(2);
      expect((await py([])).code).toBe(2);
      expect((await py(["frobnicate"])).code).toBe(2);
      expect((await py(["compute", "--plan", ws.plan])).code).toBe(2); // required options missing
    },
    TIMEOUT_MS,
  );

  test(
    "a patches.json that is not the one written with plan.json is refused (patches-stale)",
    async () => {
      const ws = workspace();
      const o = makeObject(3000);
      stage(ws, [{ obj: o }]);
      // Valid patches, but not the bytes the plan names: another plan's file.
      writeFileSync(ws.patches, `${readFileSync(ws.patches, "utf8")}\n`);
      const run = await py(computeArgs(ws));
      expect(run.code, run.stderr).toBe(3);
      expect(run.stderr).toContain("patches-stale");
      expect(existsSync(ws.hashes)).toBe(false);
      // A plan that names no patches.json at all is refused the same way.
      const plan = readJson<PlanFile>(ws.plan);
      plan.patchesSha256 = undefined;
      writeFileSync(ws.plan, JSON.stringify(plan));
      const unnamed = await py(computeArgs(ws));
      expect(unnamed.code, unnamed.stderr).toBe(3);
      expect(unnamed.stderr).toContain("patches-stale");
      // Bound again, the same files hash.
      writePatches(ws, readFileSync(ws.patches, "utf8"));
      const named = await py(computeArgs(ws));
      expect(named.code, named.stderr).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "inputs that do not match the contract are refused with status 3 and write nothing",
    async () => {
      const ws = workspace();
      const o = makeObject(3000);
      stage(ws, [{ obj: o }]);
      const goodPlan = readFileSync(ws.plan, "utf8");

      writePatches(ws, JSON.stringify({ [o.oldKey]: "ab".repeat(255) })); // 255 bytes
      expect((await py(computeArgs(ws))).code).toBe(3);
      writePatches(ws, JSON.stringify({ [o.oldKey]: `${"ab".repeat(256)}\n` }));
      expect((await py(computeArgs(ws))).code).toBe(3);
      writePatches(ws, "{not json");
      expect((await py(computeArgs(ws))).code).toBe(3);

      writePatches(ws, JSON.stringify({ [o.oldKey]: o.patch.toString("hex") }));
      writeFileSync(
        ws.plan,
        JSON.stringify({ version: 1, dataset: DATASET, keys: [{ oldKey: "nope" }] }),
      );
      expect((await py(computeArgs(ws))).code).toBe(3);
      // A key a shell must never see: a newline after an otherwise valid key.
      writeFileSync(
        ws.plan,
        JSON.stringify({ version: 1, dataset: DATASET, keys: [{ oldKey: `${o.oldKey}\n` }] }),
      );
      expect((await py(computeArgs(ws))).code).toBe(3);
      // A dataset name that is not a name.
      writeFileSync(ws.plan, goodPlan.replace(DATASET, "nm099999; touch pwned"));
      expect((await py(computeArgs(ws))).code).toBe(3);
      expect(existsSync(join(ws.dir, "pwned"))).toBe(false);

      writeFileSync(ws.plan, goodPlan);
      expect(
        (await py(computeArgs(ws, ["--out", join(ws.dir, "missing-dir", "h.json")]))).code,
      ).toBe(3);
      expect(existsSync(ws.hashes)).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "the module imports without running main, and without touching files or the network",
    async () => {
      const code = `
import sys
sys.path.insert(0, ${JSON.stringify(SCRIPT_DIR)})
import hash_stage
print(hash_stage.CHUNK_SIZE, hash_stage.HEADER_LEN, callable(hash_stage.main))
`;
      const proc = Bun.spawn(["python3", "-c", code], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      });
      const [out, err, status] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(status, err).toBe(0);
      expect(err).toBe("");
      expect(out.trim()).toBe(`${CHUNK} 256 True`);
    },
    TIMEOUT_MS,
  );
});

// --- the default source: the real aws CLI against a local S3 stand-in ---------------------------

const awsInstalled = toolOrFail("aws", which("aws") !== null);

describe.skipIf(!awsInstalled)("default source: the real aws CLI, stand-in S3", () => {
  function startS3(objects: Map<string, Uint8Array>) {
    const log: string[] = [];
    const server = Bun.serve({
      port: 0,
      // 127.0.0.1, not the default: a wildcard bind (`*:port`, IPv6 dual-stack) lets another
      // process on the machine bind 127.0.0.1:<same port> and take every connection the test makes
      // to 127.0.0.1 (measured on macOS: the "404 in 2 ms" and "401" flakes were other local
      // servers answering). A specific bind refuses that second bind (EADDRINUSE).
      hostname: "127.0.0.1",
      fetch(req) {
        const path = decodeURI(new URL(req.url).pathname);
        log.push(`${req.method} ${path}`);
        const body = objects.get(path);
        if (!body) {
          return new Response(
            '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>',
            { status: 404, headers: { "Content-Type": "application/xml" } },
          );
        }
        const headers: Record<string, string> = {
          "Content-Type": "binary/octet-stream",
          ETag: `"${sha256(body).slice(0, 32)}"`,
          "Last-Modified": new Date("2026-01-01T00:00:00Z").toUTCString(),
          "Accept-Ranges": "bytes",
        };
        if (req.method === "HEAD") {
          return new Response(null, {
            headers: { ...headers, "Content-Length": String(body.length) },
          });
        }
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") ?? "");
        if (range) {
          const start = Number(range[1]);
          const end = Math.min(range[2] ? Number(range[2]) : body.length - 1, body.length - 1);
          return new Response(body.subarray(start, end + 1), {
            status: 206,
            headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${body.length}` },
          });
        }
        return new Response(body, { headers });
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, log, stop: () => server.stop(true) };
  }

  async function runWithAws(args: string[], url: string): Promise<Run> {
    const home = mkdtempSync(join(tmpdir(), "hash-stage-aws-"));
    roots.push(home);
    writeFileSync(join(home, "config"), "");
    writeFileSync(join(home, "credentials"), "");
    const started = Date.now();
    const proc = Bun.spawn(["python3", SCRIPT, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        // The child's temp files land in this run's directory, which the file removes.
        TMPDIR: home,
        PYTHONDONTWRITEBYTECODE: "1",
        AWS_ACCESS_KEY_ID: "ASIATESTDUMMY000001",
        AWS_SECRET_ACCESS_KEY: "dummySecretAccessKeyForHashStageTest",
        AWS_CONFIG_FILE: join(home, "config"),
        AWS_SHARED_CREDENTIALS_FILE: join(home, "credentials"),
        AWS_EC2_METADATA_DISABLED: "true",
        AWS_MAX_ATTEMPTS: "1",
        AWS_DEFAULT_REGION: "us-east-1",
        AWS_ENDPOINT_URL_S3: url,
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, ms: Date.now() - started };
  }

  const small = makeObject(300_000, ".edf");
  // Past aws's 8 MiB multipart threshold, so aws reads it in ranged GETs.
  const large = makeObject(CHUNK + 123_456, ".bdf");

  function serve(bucket: string, pick: (o: Obj) => [string, Uint8Array]): Map<string, Uint8Array> {
    const served = new Map<string, Uint8Array>();
    for (const o of [small, large]) {
      const [key, bytes] = pick(o);
      served.set(`/${bucket}/${DATASET}/objects/${key}`, bytes);
    }
    return served;
  }

  test(
    "compute with no --source-cmd streams <plan bucket>/<dataset>/objects/<oldKey> through aws",
    async () => {
      const s3 = startS3(serve("plan-bucket", (o) => [o.oldKey, o.content]));
      try {
        const ws = workspace();
        stage(ws, [{ obj: small }, { obj: large }], { bucket: "plan-bucket" });
        const run = await runWithAws(
          ["compute", "--plan", ws.plan, "--patches", ws.patches, "--out", ws.hashes],
          s3.url,
        );
        expect(run.code, run.stderr).toBe(0);
        expect(readJson<HashesFile>(ws.hashes)).toEqual(expectedHashes([small, large]));
        expect(s3.log).toContain(`GET /plan-bucket/${DATASET}/objects/${small.oldKey}`);
        expect(
          s3.log.some((l) => l.startsWith(`GET /plan-bucket/${DATASET}/objects/${large.oldKey}`)),
        ).toBe(true);
      } finally {
        s3.stop();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "--dataset-bucket overrides the bucket the plan names",
    async () => {
      const s3 = startS3(serve("flag-bucket", (o) => [o.oldKey, o.content]));
      try {
        const ws = workspace();
        stage(ws, [{ obj: small }], { bucket: "plan-bucket" });
        const run = await runWithAws(
          [
            "compute",
            "--plan",
            ws.plan,
            "--patches",
            ws.patches,
            "--out",
            ws.hashes,
            "--dataset-bucket",
            "flag-bucket",
            "--retries",
            "0",
          ],
          s3.url,
        );
        expect(run.code, run.stderr).toBe(0);
        expect(readJson<HashesFile>(ws.hashes)).toEqual(expectedHashes([small]));
        expect(s3.log.some((l) => l.includes("/plan-bucket/"))).toBe(false);
      } finally {
        s3.stop();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "verify-new with no --source-cmd streams <assembled bucket>/<dataset>/objects/<newKey>",
    async () => {
      const s3 = startS3(serve("nemar", (o) => [o.newKey, o.newContent]));
      try {
        const ws = workspace();
        const assembled = join(ws.dir, "assembled.json");
        const proof = join(ws.dir, "new-hash-verified.json");
        const file: AssembledFile = {
          version: 1,
          dataset: DATASET,
          bucket: "nemar",
          entries: Object.fromEntries(
            [small, large].map((o) => [
              o.oldKey,
              {
                newKey: o.newKey,
                newVersionId: "v",
                retainUntil: "2027-01-01T00:00:00Z",
                mode: "GOVERNANCE" as const,
              },
            ]),
          ),
        };
        writeFileSync(assembled, JSON.stringify(file));
        const run = await runWithAws(
          ["verify-new", "--assembled", assembled, "--out", proof, "--retries", "0"],
          s3.url,
        );
        expect(run.code, run.stderr).toBe(0);
        expect(readJson<{ count: number }>(proof).count).toBe(2);
        expect(s3.log).toContain(`GET /nemar/${DATASET}/objects/${small.newKey}`);
      } finally {
        s3.stop();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "verify-new with no --source-cmd reads the recorded version through aws, not the current one",
    async () => {
      // The real stand-in keeps versions; the small server above does not.
      const standin = startS3Standin();
      try {
        const key = `${DATASET}/objects/${small.newKey}`;
        const damaged = Buffer.from(small.newContent);
        damaged[200] = (damaged[200] ?? 0) ^ 0x01;
        const recordedGood = standin.putObject("nemar", key, small.newContent);
        const laterBad = standin.putObject("nemar", key, damaged);
        const ws = workspace();
        const assembled = join(ws.dir, "assembled.json");
        const proof = join(ws.dir, "new-hash-verified.json");
        const write = (versionId: string) =>
          writeFileSync(
            assembled,
            JSON.stringify({
              version: 1,
              dataset: DATASET,
              bucket: "nemar",
              entries: {
                [small.oldKey]: {
                  newKey: small.newKey,
                  newVersionId: versionId,
                  retainUntil: "2127-01-01T00:00:00Z",
                  mode: "GOVERNANCE",
                },
              },
            }),
          );
        const args = ["verify-new", "--assembled", assembled, "--out", proof, "--retries", "0"];
        // The recorded version is good and a damaged one is current: the proof is written.
        write(recordedGood);
        const good = await runWithAws(args, standin.url);
        expect(good.code, good.stderr).toBe(0);
        expect(existsSync(proof)).toBe(true);
        // The recorded version is the damaged one, though a good one is current: no proof.
        write(laterBad);
        standin.putObject("nemar", key, small.newContent);
        const bad = await runWithAws(args, standin.url);
        expect(bad.code, bad.stderr).toBe(1);
        expect(bad.stderr).toContain("the object does not hash to its key");
        expect(existsSync(proof)).toBe(false);
      } finally {
        standin.stop();
      }
    },
    TIMEOUT_MS,
  );
});
