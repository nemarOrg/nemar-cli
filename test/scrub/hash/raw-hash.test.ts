/**
 * `hash_stage.py raw-hash`, run as the real program: for every VERSION of every raw copy a plan
 * records (`rawCopies`, an object under `<id>/objects/` stored by its path), it streams the object
 * at that version id and records its sha256 and its git blob id in `raw-hashes.json`.
 *
 * The source is a real shell command over real files: `objects/<hex of the name>@<version id>`,
 * because a raw name is a path with slashes. The one test that uses the DEFAULT source runs the
 * real `aws` CLI against the S3 stand-in. Expected digests are computed here with node:crypto, and
 * the git blob id is checked against `git hash-object` itself, so a transposed rule in the program
 * cannot also be in the expectation.
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
import { spawnSync, which } from "bun";
import {
  type PlanFile,
  type RawCopy,
  type RawHashesFile,
  parsePlan,
  parseRawHashes,
} from "../../../scripts/scrub/contract";
import { toolOrFail } from "../helpers/require-tools";
import { startS3Standin } from "../helpers/s3-standin";

const SCRIPT = join(import.meta.dir, "..", "..", "..", "scripts", "scrub", "hash", "hash_stage.py");
const CHUNK = 8 * 1024 * 1024;
const DATASET = "nm099999";
/** An invented name, in a raw path and in a file's bytes: neither may ever be printed. */
const NAME = "Zorblat_Quimby";
const TIMEOUT_MS = 120_000;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const shq = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const gitBlob = (data: Uint8Array) =>
  createHash("sha1").update(`blob ${data.length}\u0000`).update(data).digest("hex");
const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");
const enc = (s: string) => Buffer.from(s, "utf8");

/** Deterministic bytes, so a multi-chunk object costs nothing to build. */
function payload(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

interface Version {
  id: string;
  bytes: Buffer;
}
interface Seed {
  name: string;
  versions: Version[];
  markers?: string[];
}

const REC = "sub-01/eeg/sub-01_task-rest_eeg.edf";
const TSV = "participants.tsv";
const NOTES = `sourcedata/${NAME}_notes.txt`;
const FOLDER = "code/";
const MARKED = "CHANGES";

/** Two recording versions (one past a chunk, so the blob id is computed across reads), text, a
 * zero-byte folder key and a name that is only a marker. */
function seeds(): Seed[] {
  return [
    {
      name: REC,
      versions: [
        { id: "v-rec-1", bytes: payload(3000, 1) },
        { id: "v-rec-2", bytes: payload(CHUNK + 1234, 2) },
      ],
      markers: ["m-rec"],
    },
    { name: TSV, versions: [{ id: "v-tsv", bytes: enc("participant_id\tsex\nsub-01\tF\n") }] },
    { name: NOTES, versions: [{ id: "v-notes", bytes: enc(`operator ${NAME}\n`) }] },
    { name: FOLDER, versions: [{ id: "v-folder", bytes: Buffer.alloc(0) }] },
    { name: MARKED, versions: [], markers: ["m-changes"] },
  ];
}

interface Workspace {
  dir: string;
  objects: string;
  plan: string;
  out: string;
  log: string;
  sourceCmd: string;
}

function workspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "raw-hash-"));
  roots.push(dir);
  const objects = join(dir, "objects");
  mkdirSync(objects);
  const ws: Workspace = {
    dir,
    objects,
    plan: join(dir, "plan.json"),
    out: join(dir, "raw-hashes.json"),
    log: join(dir, "invocations.log"),
    sourceCmd: "",
  };
  installSource(ws, "");
  return ws;
}

/**
 * The source: logs `<name> <version>` and writes `objects/<hex of the name>@<version>`. `body`
 * runs first and may exit; it sees $KEY, $VERSION and $OBJECTS.
 */
function installSource(ws: Workspace, body: string): void {
  const script = join(ws.dir, "src.sh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `LOG=${shq(ws.log)}`,
      `OBJECTS=${shq(ws.objects)}`,
      'KEY="$1"',
      'VERSION="$2"',
      'printf "%s %s\\n" "$KEY" "$VERSION" >> "$LOG"',
      body,
      `cat "$OBJECTS/$(printf '%s' "$KEY" | od -An -tx1 | tr -d ' \\n')@$VERSION"`,
      "",
    ].join("\n"),
  );
  ws.sourceCmd = `sh ${shq(script)} {key} {version}`;
}

const store = (ws: Workspace, name: string, id: string, bytes: Uint8Array) =>
  writeFileSync(join(ws.objects, `${hex(name)}@${id}`), bytes);

/** plan.json for these raw copies (and no annex key), and their bytes as the source serves them. */
function stage(ws: Workspace, list: Seed[], over: Partial<PlanFile> = {}): PlanFile {
  const rawCopies: RawCopy[] = [...list]
    .sort((x, y) => (x.name < y.name ? -1 : 1))
    .map((s) => ({
      name: s.name,
      kind: /\.(edf|bdf)$/i.test(s.name) ? "recording" : "other",
      versions: s.versions.map((v) => ({ id: v.id, size: v.bytes.length })),
      markers: s.markers ?? [],
    }));
  const plan: PlanFile = {
    version: 1,
    dataset: DATASET,
    bucket: "nemar",
    tags: ["v1.0.0"],
    createdAt: "2026-10-06T00:00:00Z",
    keys: [],
    rawCopies,
    totals: {
      keys: 0,
      needScrub: 0,
      bytesToHash: 0,
      unreadable: 0,
      rawCopyNames: rawCopies.length,
      rawCopyVersions: rawCopies.reduce((n, r) => n + r.versions.length, 0),
      rawCopyMarkers: rawCopies.reduce((n, r) => n + r.markers.length, 0),
    },
    ...over,
  };
  writeFileSync(ws.plan, JSON.stringify(plan));
  for (const s of list) for (const v of s.versions) store(ws, s.name, v.id, v.bytes);
  return plan;
}

const planSha = (ws: Workspace) => sha256(readFileSync(ws.plan));

function expected(list: Seed[]): RawHashesFile["entries"] {
  return list
    .flatMap((s) =>
      s.versions.map((v) => ({
        name: s.name,
        versionId: v.id,
        size: v.bytes.length,
        sha256: sha256(v.bytes),
        gitBlobSha1: gitBlob(v.bytes),
      })),
    )
    .sort((x, y) =>
      x.name === y.name ? (x.versionId < y.versionId ? -1 : 1) : x.name < y.name ? -1 : 1,
    );
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the program. `clean` gives it only PATH and `env`, so no real AWS setting reaches it. */
async function py(args: string[], env: Record<string, string> = {}, clean = false): Promise<Run> {
  const base = clean ? { PATH: process.env.PATH ?? "" } : process.env;
  const proc = Bun.spawn(["python3", SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...base, PYTHONDONTWRITEBYTECODE: "1", ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

const rawArgs = (ws: Workspace, extra: string[] = []) => [
  "raw-hash",
  "--plan",
  ws.plan,
  "--out",
  ws.out,
  "--source-cmd",
  ws.sourceCmd,
  "--retries",
  "0",
  "--retry-backoff",
  "0",
  ...extra,
];

const readLog = (ws: Workspace) =>
  existsSync(ws.log)
    ? readFileSync(ws.log, "utf8")
        .split("\n")
        .filter((l) => l !== "")
    : [];

const readOut = (ws: Workspace) => parseRawHashes(readFileSync(ws.out, "utf8"));

/** No raw name, no invented name, no byte of a file in anything the program printed. */
function expectNoName(text: string) {
  for (const n of [REC, TSV, NOTES, FOLDER, MARKED, NAME, "participant_id"]) {
    expect(text, n).not.toContain(n);
  }
}

describe("raw-hash: the digests", () => {
  test(
    "records the sha256 and git's own blob id of every raw version, by version id, and reads no marker",
    async () => {
      const ws = workspace();
      const list = seeds();
      stage(ws, list);
      const run = await py(rawArgs(ws, ["--workers", "3"]));
      expect(run.code, run.stderr).toBe(0);
      const out = readOut(ws);
      expect(out.dataset).toBe(DATASET);
      expect(out.planSha256).toBe(planSha(ws));
      expect(out.entries).toEqual(expected(list));
      // git itself agrees on every blob id, the multi-chunk one and the empty one included.
      for (const s of list) {
        for (const v of s.versions) {
          const r = spawnSync(["git", "hash-object", "--stdin"], { stdin: v.bytes });
          expect(new TextDecoder().decode(r.stdout).trim(), `${s.name} ${v.id}`).toBe(
            gitBlob(v.bytes),
          );
        }
      }
      // Each version read once, by its id; a delete marker holds no bytes and is never asked for.
      expect(readLog(ws).sort()).toEqual(
        list.flatMap((s) => s.versions.map((v) => `${s.name} ${v.id}`)).sort(),
      );
      expect(statSync(ws.out).mode & 0o777).toBe(0o600);
      expect(run.stderr).toContain("5 raw versions, 0 already done, 5 to read now");
      expect(run.stderr).toContain("5/5 raw versions hashed, 0 failed, 0 not attempted");
      expectNoName(`${run.stdout}\n${run.stderr}`);
    },
    TIMEOUT_MS,
  );

  test(
    "one worker and four write the same file, sorted by name and version id",
    async () => {
      const ws = workspace();
      stage(ws, seeds());
      expect((await py(rawArgs(ws, ["--workers", "1"]))).code).toBe(0);
      const serial = readFileSync(ws.out, "utf8");
      rmSync(ws.out);
      expect((await py(rawArgs(ws, ["--workers", "4"]))).code).toBe(0);
      expect(readFileSync(ws.out, "utf8")).toBe(serial);
      const names = (JSON.parse(serial) as RawHashesFile).entries.map(
        (e) => `${e.name}\u0000${e.versionId}`,
      );
      expect(names).toEqual([...names].sort());
    },
    TIMEOUT_MS,
  );

  test(
    "a byte count that is not the plan's size is recorded as size-differs, never with a digest",
    async () => {
      const ws = workspace();
      const list = seeds();
      stage(ws, list);
      const tsv = list[1]?.versions[0] as Version;
      const rec = list[0]?.versions[1] as Version;
      store(ws, TSV, tsv.id, tsv.bytes.subarray(0, tsv.bytes.length - 1)); // short
      store(ws, REC, rec.id, Buffer.concat([rec.bytes, enc("x")])); // long, past a chunk
      const run = await py(rawArgs(ws));
      expect(run.code, run.stderr).toBe(1);
      expect(run.stderr).toContain("failed by reason: size-differs=2");
      const out = readOut(ws);
      expect(out.entries.filter((e) => "failure" in e)).toEqual([
        // In the file's order, by name.
        { name: TSV, versionId: tsv.id, failure: "size-differs" },
        { name: REC, versionId: rec.id, failure: "size-differs" },
      ]);
      expect(out.entries.filter((e) => !("failure" in e)).length).toBe(3);
      expectNoName(`${run.stdout}\n${run.stderr}`);

      // A re-run reads exactly those two again, and with the right bytes finishes.
      store(ws, TSV, tsv.id, tsv.bytes);
      store(ws, REC, rec.id, rec.bytes);
      rmSync(ws.log);
      const again = await py(rawArgs(ws));
      expect(again.code, again.stderr).toBe(0);
      expect(readLog(ws).sort()).toEqual([`${REC} ${rec.id}`, `${TSV} ${tsv.id}`].sort());
      expect(readOut(ws).entries).toEqual(expected(list));
    },
    TIMEOUT_MS,
  );

  test(
    "a failed read is read-failed, recorded nowhere, and the source's own text is never printed",
    async () => {
      const ws = workspace();
      const list = seeds();
      stage(ws, list);
      // An aws error names the key: this source does too, on its standard error, then fails.
      installSource(
        ws,
        `if [ "$KEY" = ${shq(NOTES)} ]; then echo "An error occurred (NoSuchVersion) for $KEY" >&2; exit 1; fi`,
      );
      const run = await py(rawArgs(ws));
      expect(run.code, run.stderr).toBe(1);
      expect(run.stderr).toContain("FAILED read-failed");
      expect(run.stderr).toContain("failed by reason: read-failed=1");
      expect(readOut(ws).entries.some((e) => e.name === NOTES)).toBe(false);
      expectNoName(`${run.stdout}\n${run.stderr}`);
    },
    TIMEOUT_MS,
  );
});

describe("raw-hash: resuming, limits and refusals", () => {
  test(
    "resumes: a second run reads nothing; --limit stops with exit 4 and keeps what it read",
    async () => {
      const ws = workspace();
      const list = seeds();
      stage(ws, list);
      const first = await py(rawArgs(ws, ["--limit", "2", "--checkpoint-every", "1"]));
      expect(first.code, first.stderr).toBe(4);
      expect(readOut(ws).entries.length).toBe(2);
      expect(first.stderr).toContain("2/5 raw versions hashed, 0 failed, 3 not attempted");
      const second = await py(rawArgs(ws));
      expect(second.code, second.stderr).toBe(0);
      expect(second.stderr).toContain("5 raw versions, 2 already done, 3 to read now");
      rmSync(ws.log);
      const third = await py(rawArgs(ws));
      expect(third.code, third.stderr).toBe(0);
      expect(readLog(ws)).toEqual([]);
      expect(readOut(ws).entries).toEqual(expected(list));
    },
    TIMEOUT_MS,
  );

  test(
    "rewrites raw-hashes.json every --checkpoint-every versions, while the run is still going",
    async () => {
      const ws = workspace();
      stage(ws, seeds());
      // NOTES waits for a release; with one worker the versions before it (in name order:
      // code/ and participants.tsv) are hashed first, and one checkpoint each is on disk.
      const release = join(ws.dir, "release");
      const waiting = join(ws.dir, "waiting");
      installSource(
        ws,
        `if [ "$KEY" = ${shq(NOTES)} ]; then : > ${shq(waiting)}; while [ ! -e ${shq(release)} ]; do sleep 0.05; done; fi`,
      );
      const proc = Bun.spawn(
        ["python3", SCRIPT, ...rawArgs(ws, ["--workers", "1", "--checkpoint-every", "1"])],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
      );
      const done = Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      try {
        for (let i = 0; i < 300 && !existsSync(waiting); i++) await Bun.sleep(100);
        expect(existsSync(waiting)).toBe(true);
        // The run is blocked on NOTES: what is on disk now was written by a checkpoint.
        const during = readOut(ws).entries;
        expect(during.map((e) => e.name).sort()).toEqual([FOLDER, TSV].sort());
        expect(during.every((e) => !("failure" in e))).toBe(true);
      } finally {
        writeFileSync(release, "");
      }
      const [, stderr, exit] = await done;
      expect(exit, stderr).toBe(0);
      expect(readOut(ws).entries).toEqual(expected(seeds()));
    },
    TIMEOUT_MS,
  );

  test(
    "an existing file of another plan, another dataset, or a version the plan does not record is refused",
    async () => {
      const ws = workspace();
      stage(ws, seeds());
      expect((await py(rawArgs(ws))).code).toBe(0);
      const good = readFileSync(ws.out, "utf8");
      const doc = JSON.parse(good) as RawHashesFile;
      const cases: Array<[string, unknown, string]> = [
        ["plan", { ...doc, planSha256: "0".repeat(64) }, "made for another plan.json"],
        ["dataset", { ...doc, dataset: "nm099998" }, "is not this dataset's"],
        [
          "version",
          { ...doc, entries: [...doc.entries, { ...doc.entries[0], versionId: "v-unrecorded" }] },
          "versions this plan does not record",
        ],
        [
          "shape",
          { ...doc, entries: [{ ...doc.entries[0], sha256: "x" }, ...doc.entries.slice(1)] },
          "would not write",
        ],
        ["twice", { ...doc, entries: [doc.entries[0], ...doc.entries] }, "would not write"],
        ["a member more", { ...doc, more: 1 }, "is not this dataset's"],
        ["version 2", { ...doc, version: 2 }, "is not this dataset's"],
        ["entries an object", { ...doc, entries: {} }, "is not this dataset's"],
        ["not an object", [doc], "is not this dataset's"],
        [
          "an entry not an object",
          { ...doc, entries: ["x", ...doc.entries.slice(1)] },
          "would not write",
        ],
        [
          "another size",
          {
            ...doc,
            entries: [
              { ...doc.entries[0], size: (doc.entries[0] as { size: number }).size + 1 },
              ...doc.entries.slice(1),
            ],
          },
          "would not write",
        ],
        [
          "a blob id of SHA-256 length",
          {
            ...doc,
            entries: [{ ...doc.entries[0], gitBlobSha1: "a".repeat(64) }, ...doc.entries.slice(1)],
          },
          "would not write",
        ],
        [
          "an entry with more",
          { ...doc, entries: [{ ...doc.entries[0], more: 1 }, ...doc.entries.slice(1)] },
          "would not write",
        ],
        [
          "another failure word",
          {
            ...doc,
            entries: [
              {
                name: (doc.entries[0] as { name: string }).name,
                versionId: (doc.entries[0] as { versionId: string }).versionId,
                failure: "read-failed",
              },
              ...doc.entries.slice(1),
            ],
          },
          "would not write",
        ],
      ];
      for (const [label, file, message] of cases) {
        const text = JSON.stringify(file);
        writeFileSync(ws.out, text);
        const run = await py(rawArgs(ws));
        expect(run.code, label).toBe(3);
        expect(run.stderr, label).toContain(message);
        expect(readFileSync(ws.out, "utf8"), label).toBe(text);
      }
      // A plan.json one byte longer is another plan: its old file is refused, not reused.
      writeFileSync(ws.out, good);
      writeFileSync(ws.plan, `${readFileSync(ws.plan, "utf8")}\n`);
      expect((await py(rawArgs(ws))).code).toBe(3);
    },
    TIMEOUT_MS,
  );

  test(
    "refuses a source without {version}, a plan that is not complete, and raw copies off the contract",
    async () => {
      const ws = workspace();
      const list = seeds();
      const plan = stage(ws, list);
      const noVersion = await py(rawArgs(ws, ["--source-cmd", "cat /dev/null {key}"]));
      expect(noVersion.code).toBe(3);
      expect(noVersion.stderr).toContain("names {version}");

      const refused = async (doc: unknown, label: string, parser = true) => {
        const text = JSON.stringify(doc);
        writeFileSync(ws.plan, text);
        // The TypeScript reader refuses each shape too, so the two readers agree; a partial or
        // incomplete plan parses, and is refused by every stage that acts on it.
        let tsRefused = false;
        try {
          parsePlan(text);
        } catch {
          tsRefused = true;
        }
        expect(tsRefused, `contract.ts: ${label}`).toBe(parser);
        const run = await py(rawArgs(ws));
        expect(run.code, `${label}: ${run.stderr}`).toBe(3);
        expect(existsSync(ws.out), label).toBe(false);
      };
      const raw = plan.rawCopies as RawCopy[];
      const rec = raw.findIndex((r) => r.name === REC);
      /** The raw copies with REC's entry replaced. */
      const replaceRec = (entry: unknown) => raw.map((r, i) => (i === rec ? entry : r));
      const withRaw = (r: unknown[], totals: Partial<PlanFile["totals"]> = {}) => ({
        ...plan,
        rawCopies: r,
        totals: { ...plan.totals, ...totals },
      });
      await refused({ ...plan, partial: true }, "partial", false);
      await refused(withRaw(replaceRec({ ...raw[rec], more: 1 })), "extra member");
      await refused(withRaw(replaceRec({ ...raw[rec], kind: "other" })), "wrong kind");
      await refused(withRaw([...raw, { ...raw[rec] }], { rawCopyNames: 6 }), "a name twice");
      await refused(
        withRaw(
          [
            { name: "annex-uuid", kind: "other", versions: [{ id: "u", size: 36 }], markers: [] },
            ...raw,
          ],
          {
            rawCopyNames: 6,
            rawCopyVersions: 6,
          },
        ),
        "annex-uuid",
      );
      await refused(
        withRaw(
          [
            {
              name: "SHA256E-s5--x.edf",
              kind: "recording",
              versions: [{ id: "k", size: 5 }],
              markers: [],
            },
            ...raw,
          ],
          {
            rawCopyNames: 6,
            rawCopyVersions: 6,
          },
        ),
        "an annex-key name",
      );
      await refused(
        withRaw(replaceRec({ ...raw[rec], markers: [(raw[rec] as RawCopy).versions[0]?.id] }), {
          rawCopyMarkers: plan.totals.rawCopyMarkers as number,
        }),
        "an id twice",
      );
      await refused(
        withRaw([{ name: "x.tsv", kind: "other", versions: [], markers: [] }, ...raw], {
          rawCopyNames: 6,
        }),
        "nothing under a name",
      );
      await refused(withRaw(raw, { rawCopyVersions: 99 }), "totals that disagree");
      await refused({ ...plan, rawCopies: {} }, "rawCopies an object");
      await refused(withRaw(["x", ...raw.slice(1)]), "an entry not an object");
      const tsvAt = raw.findIndex((r) => r.name === TSV);
      const replaceTsv = (entry: unknown) => raw.map((r, i) => (i === tsvAt ? entry : r));
      const tsvEntry = raw[tsvAt] as RawCopy;
      await refused(withRaw(replaceTsv({ ...tsvEntry, versions: {} })), "versions an object");
      for (const [label, v] of [
        ["a version with more", { id: "v-tsv", size: 1, x: 1 }],
        ["an empty version id", { id: "", size: 1 }],
        ["a negative size", { id: "v-tsv", size: -1 }],
        ["a fractional size", { id: "v-tsv", size: 1.5 }],
        ["a size a string", { id: "v-tsv", size: "1" }],
      ] as Array<[string, unknown]>) {
        await refused(withRaw(replaceTsv({ ...tsvEntry, versions: [v] })), label);
      }
      await refused(withRaw(replaceTsv({ ...tsvEntry, markers: [""] })), "an empty marker");
      // A name no call can carry: empty, a NUL, a lone surrogate, or a control character
      // (contract.ts hasControlCharacter), placed where it sorts, so only the name is wrong.
      for (const name of [
        "",
        "\u0000x",
        "\ud800x",
        "\rx.tsv",
        "\tx.tsv",
        "\nx.tsv",
        "\u0001x.tsv",
        "\u007fx.tsv",
        "\u0085x.tsv",
        "\uffffx.tsv",
      ]) {
        const entry = { name, kind: "other", versions: [{ id: "c", size: 1 }], markers: [] };
        await refused(
          withRaw(
            [...raw, entry].sort((x, y) => (x.name < y.name ? -1 : 1)),
            {
              rawCopyNames: raw.length + 1,
              rawCopyVersions: (plan.totals.rawCopyVersions as number) + 1,
            },
          ),
          `the name ${JSON.stringify(name)}`,
        );
      }
      const { rawCopies: _, ...bare } = plan;
      await refused(bare, "raw totals without raw copies");
      // A key nobody read makes a plan incomplete, raw copies or not.
      await refused(
        {
          ...plan,
          keys: [
            {
              oldKey: `SHA256E-s9--${"a".repeat(64)}.edf`,
              size: 9,
              needsScrub: false,
              versionIds: [],
              reasons: ["HeadObject:access-denied"],
              status: "unreadable",
            },
          ],
          totals: { ...plan.totals, keys: 1, unreadable: 1 },
        },
        "a plan with an unreadable key",
        false,
      );
    },
    TIMEOUT_MS,
  );

  test(
    "a plan without raw copies has nothing to read: an empty file and exit 0",
    async () => {
      const ws = workspace();
      const plan = stage(ws, []);
      const { rawCopies: _, ...rest } = plan;
      const { rawCopyNames, rawCopyVersions, rawCopyMarkers, ...totals } = plan.totals;
      expect([rawCopyNames, rawCopyVersions, rawCopyMarkers]).toEqual([0, 0, 0]);
      writeFileSync(ws.plan, JSON.stringify({ ...rest, totals }));
      const run = await py(rawArgs(ws));
      expect(run.code, run.stderr).toBe(0);
      expect(readOut(ws)).toEqual({
        version: 1,
        dataset: DATASET,
        planSha256: planSha(ws),
        entries: [],
      });
      expect(readLog(ws)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    "SIGTERM stops the running source commands and keeps the versions already hashed",
    async () => {
      const ws = workspace();
      const list = seeds();
      stage(ws, list);
      const pidFile = join(ws.dir, "slow.pid");
      installSource(
        ws,
        `if [ "$KEY" = ${shq(NOTES)} ]; then echo $$ > ${shq(pidFile)}; exec sleep 60; fi`,
      );
      const proc = Bun.spawn(
        ["python3", SCRIPT, ...rawArgs(ws, ["--workers", "1", "--checkpoint-every", "1"])],
        { stdout: "pipe", stderr: "pipe", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
      );
      const done = Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      for (let i = 0; i < 300 && !existsSync(pidFile); i++) await Bun.sleep(100);
      expect(existsSync(pidFile)).toBe(true);
      proc.kill("SIGTERM");
      const [, stderr, exit] = await done;
      expect(exit, stderr).toBe(143);
      expect(stderr).toContain("interrupted by SIGTERM");
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
      // With one worker the versions before NOTES (in plan order) were hashed and saved.
      const kept = readOut(ws).entries;
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.every((e) => !("failure" in e))).toBe(true);
      expect(kept.some((e) => e.name === NOTES)).toBe(false);
      expectNoName(stderr);
    },
    TIMEOUT_MS,
  );
});

const awsInstalled = toolOrFail("aws", which("aws") !== null);

describe.skipIf(!awsInstalled)("raw-hash: the default source, the real aws CLI", () => {
  test(
    "reads each recorded version by its id, though the current entry is a delete marker",
    async () => {
      const standin = startS3Standin();
      try {
        const key = `${DATASET}/objects/${REC}`;
        const older = payload(4000, 7);
        const newer = payload(5000, 8);
        const v1 = standin.putObject("nemar", key, older);
        const v2 = standin.putObject("nemar", key, newer);
        const marker = standin.putDeleteMarker("nemar", key);
        const ws = workspace();
        stage(ws, [
          {
            name: REC,
            versions: [
              { id: v2, bytes: newer },
              { id: v1, bytes: older },
            ],
            markers: [marker],
          },
        ]);
        const home = mkdtempSync(join(tmpdir(), "raw-hash-aws-"));
        roots.push(home);
        writeFileSync(join(home, "config"), "");
        writeFileSync(join(home, "credentials"), "");
        const run = await py(
          ["raw-hash", "--plan", ws.plan, "--out", ws.out, "--retries", "0", "--workers", "2"],
          {
            HOME: home,
            // The child's temp files land in this run's directory, which the file removes.
            TMPDIR: home,
            AWS_ACCESS_KEY_ID: "ASIATESTDUMMY000001",
            AWS_SECRET_ACCESS_KEY: "dummySecretAccessKeyForRawHashTest",
            AWS_SESSION_TOKEN: "dummySessionTokenForRawHashTest",
            AWS_CONFIG_FILE: join(home, "config"),
            AWS_SHARED_CREDENTIALS_FILE: join(home, "credentials"),
            AWS_EC2_METADATA_DISABLED: "true",
            AWS_MAX_ATTEMPTS: "1",
            AWS_DEFAULT_REGION: "us-east-2",
            AWS_ENDPOINT_URL_S3: standin.url,
          },
          true,
        );
        expect(run.code, run.stderr).toBe(0);
        const byId = Object.fromEntries(readOut(ws).entries.map((e) => [e.versionId, e]));
        expect(byId[v1]).toMatchObject({ sha256: sha256(older), gitBlobSha1: gitBlob(older) });
        expect(byId[v2]).toMatchObject({ sha256: sha256(newer), gitBlobSha1: gitBlob(newer) });
        // Each read named its version; the marker was never asked for.
        const gets = standin.calls("GetObject").map((c) => c.versionId);
        expect(gets.sort()).toEqual([v1, v2].sort());
        expectNoName(`${run.stdout}\n${run.stderr}`);
      } finally {
        standin.stop();
      }
    },
    TIMEOUT_MS,
  );
});
