/**
 * The importer's identifier scrub (ADR 0089), driven through `prepareImportedTreeForCopy`, the
 * one call `prepareImport` makes for its step 5b.
 *
 * Nothing here is a stand-in for business logic. The trees are real git-annex repositories built
 * the way an OpenNeuro clone arrives: upstream's own `.gitattributes`, recordings over a size bar
 * annexed and their content absent (dropped, as in a fresh clone), each annexed key carrying the
 * public S3 URL upstream records, small recordings and every sidecar kept in git. The upstream
 * bucket is a local HTTP server serving those bytes by path with ranged reads (the only part of the
 * world replaced), `nemar-s3` is a real `type=directory` special remote, and git-annex itself is
 * the oracle for keys, location logs and dead marks.
 *
 * Every name, date and code in a header or sidecar below is invented. Each of them is also checked
 * NOT to appear in anything the scrub writes or returns, because the import's log is public.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DETERMINISTIC_SCRUB_REFUSALS,
  IMPORT_IDENTIFIER_SCRUB_MARKER_FOR_CLASSIFY,
  classifyImportFailure,
  isDeterministicScrubRefusal,
} from "../backend/src/services/import-failure-cause";
import { isDead, locationLogs } from "../scripts/scrub/git/git-lib";
import { readLedger } from "../scripts/scrub/ledger";
import { EDF_HEADER_BYTES, scanEdfHeader } from "../shared/identifier-scan";
import { scrubEdfHeader } from "../shared/identifier-scrub";
import { PROVENANCE_NOTE_KEY, provenanceNote } from "../shared/privacy-correction-text";
import { runCommand } from "../src/lib/git-annex/run-command";
import { getAnnexWhereisAll, listAnnexedKeys } from "../src/lib/git-annex/transfer";
import { IMPORT_SCRUB_MARKER, OPENNEURO_UPSTREAM_MARKER } from "../src/lib/import-markers";
import { annexCopyUpload } from "../src/lib/import-normalize";
import { buildManifestItems } from "../src/lib/import-openneuro";
import {
  IMPORT_SCANNER_ID,
  IMPORT_SCRUB_REFUSALS,
  ImportScrubRefused,
  httpUpstreamReader,
  prepareImportedTreeForCopy,
  restrictManifestToTree,
  setTopLevelString,
} from "../src/lib/import-scrub";
import type { ImportManifestItem } from "../src/lib/s3-server-copy";

const NEMAR_ID = "on999999";
const UPSTREAM_ID = "ds999999";
const BUCKET_PATH = `openneuro.org/${UPSTREAM_ID}`;

/** Invented identifiers. None may appear in anything the scrub returns or writes. */
const SURNAME = "Qwfixturelast";
const GIVEN = "Zxfixturename";
const BIRTH = "14-MAR-1993";
const FLAGGED_PATIENT = `${SURNAME} M ${BIRTH} ${GIVEN}`;
const SECRETS = [SURNAME, GIVEN, BIRTH, "sub-0"];

/**
 * Upstream's attributes, in OpenNeuro's shape: SHA256E keys, a size bar for recordings (here 2 kB
 * so fixtures stay small; OpenNeuro's is about 1 MB), sidecars and tables in git.
 */
const UPSTREAM_GITATTRIBUTES = `* annex.backend=SHA256E
**/.git* annex.largefiles=nothing
*.json text eol=lf annex.largefiles=nothing
*.tsv text eol=lf annex.largefiles=nothing
*.md annex.largefiles=nothing
*.png annex.largefiles=nothing
*.edf annex.largefiles=largerthan=2kb
`;

interface Fixture {
  path: string;
  bytes: Uint8Array;
}

function edfBytes(patient: string, payloadBytes: number, seed: number): Uint8Array {
  const out = new Uint8Array(EDF_HEADER_BYTES + payloadBytes);
  out.fill(0x20, 0, EDF_HEADER_BYTES);
  const put = (text: string, start: number, width: number) => {
    for (let i = 0; i < Math.min(text.length, width); i++) out[start + i] = text.charCodeAt(i);
  };
  put("0", 0, 8);
  put(patient, 8, 80);
  put("Startdate 14-MAR-2023 X X X", 88, 80);
  put("14.03.23", 168, 8);
  let x = seed >>> 0 || 1;
  for (let i = EDF_HEADER_BYTES; i < out.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

const text = (s: string) => new TextEncoder().encode(s);

const FLAGGED_ANNEXED = "sub-01/eeg/sub-01_task-rest_eeg.edf";
const CLEAN_ANNEXED = "sub-02/eeg/sub-02_task-rest_eeg.edf";
const FLAGGED_GIT = "sub-03/eeg/sub-03_task-short_eeg.edf";
const SIDECAR = "sub-01/eeg/sub-01_task-rest_eeg.json";
const IMAGE = "sourcedata/consent-scan.png";
const BIDS_PHOTO = "sub-01/eeg/sub-01_photo.png";

function baseFixtures(): Fixture[] {
  return [
    {
      path: "dataset_description.json",
      bytes: text(`{"Name": "fixture", "BIDSVersion": "1.9.0"}\n`),
    },
    { path: "participants.tsv", bytes: text("participant_id\tage\nsub-01\t30\nsub-02\t31\n") },
    { path: FLAGGED_ANNEXED, bytes: edfBytes(FLAGGED_PATIENT, 4000, 1) },
    { path: CLEAN_ANNEXED, bytes: edfBytes("X X X X", 4000, 2) },
    {
      path: SIDECAR,
      bytes: text(
        `{\n  "TaskName": "rest",\n  "SamplingFrequency": 256,\n  "Acq": {\n    "PatientName": "${GIVEN} ${SURNAME}"\n  }\n}\n`,
      ),
    },
    { path: IMAGE, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
    { path: BIDS_PHOTO, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]) },
  ];
}

// ---------------------------------------------------------------------------------------
// The upstream bucket: a local server serving fixture bytes by path, with ranged reads.
// ---------------------------------------------------------------------------------------

interface Served {
  bytes: Uint8Array;
  /** Answer every request for this object with this status. */
  status?: number;
  /** Claim this total size in Content-Range. */
  total?: number;
  /** Serve these bytes for a full GET (a ranged read still gets `bytes`). */
  fullBody?: Uint8Array;
  /** Answer a ranged read with only this many bytes, while claiming the whole range. */
  shortRange?: number;
  /** Answer a ranged read without a Content-Range header. */
  noLength?: boolean;
}

const served = new Map<string, Served>();
const requests: Array<{ path: string; range: string | null }> = [];
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname.slice(1));
      const range = req.headers.get("range");
      requests.push({ path, range });
      const obj = served.get(path);
      if (!obj) return new Response("NoSuchKey", { status: 404 });
      if (obj.status) return new Response("refused", { status: obj.status });
      const total = obj.total ?? obj.bytes.length;
      const m = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
      if (m) {
        const start = Number(m[1]);
        const end = Math.min(Number(m[2]), obj.bytes.length - 1);
        const body = obj.bytes.slice(start, start + (obj.shortRange ?? end - start + 1));
        return new Response(body, {
          status: 206,
          headers: obj.noLength ? {} : { "Content-Range": `bytes ${start}-${end}/${total}` },
        });
      }
      return new Response(obj.fullBody ?? obj.bytes, { status: 200 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

// ---------------------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------------------

const scratch: string[] = [];

function chmodTreeWritable(dir: string): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        chmodSync(full, 0o755);
      } catch {}
      chmodTreeWritable(full);
    } else {
      try {
        chmodSync(full, 0o644);
      } catch {}
    }
  }
}

afterEach(() => {
  served.clear();
  requests.length = 0;
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (!dir || !existsSync(dir)) continue;
    chmodTreeWritable(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

async function run(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr, exitCode } = await runCommand(args, { cwd });
  if (exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  return stdout;
}

async function identity(dir: string, description: string): Promise<void> {
  await run(["git", "config", "user.email", "test@nemar.test"], dir);
  await run(["git", "config", "user.name", "NEMAR Test"], dir);
  await run(["git", "annex", "init", "--quiet", description], dir);
}

/**
 * An upstream repository: the fixtures committed under upstream's attributes, every annexed key
 * registered at its public S3 URL (which is what OpenNeuro's whereis reports), the bytes served by
 * the local bucket, and the content dropped, as it is in a fresh clone.
 */
async function buildUpstream(
  files: Fixture[],
  opts: {
    /** The public URL to register for a path; default its S3 URL. A test may name a plain web URL. */
    urlFor?: (path: string) => string;
    attributes?: string;
  } = {},
): Promise<string> {
  const dir = scratchDir("nemar-scrub-upstream-");
  await run(["git", "init", "-q", "--initial-branch", "main", "."], dir);
  await identity(dir, "upstream");
  writeFileSync(join(dir, ".gitattributes"), opts.attributes ?? UPSTREAM_GITATTRIBUTES);
  for (const f of files) {
    const abs = join(dir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.bytes);
    served.set(`${BUCKET_PATH}/${f.path}`, { bytes: f.bytes });
  }
  await run(["git", "annex", "add", "--quiet", "."], dir);
  await run(["git", "commit", "-qm", "upstream snapshot"], dir);
  for (const [path, key] of await listAnnexedKeys(dir)) {
    const url = opts.urlFor?.(path) ?? `https://s3.amazonaws.com/${BUCKET_PATH}/${path}`;
    await run(["git", "annex", "registerurl", key, url], dir);
  }
  await run(["git", "annex", "drop", "--force", "--quiet", "."], dir);
  return dir;
}

/** A fresh clone of upstream with `nemar-s3` configured: what prepare holds before step 5b. */
async function cloneForImport(upstream: string): Promise<{ clone: string; store: string }> {
  const parent = scratchDir("nemar-scrub-clone-");
  const clone = join(parent, NEMAR_ID);
  await run(["git", "clone", "-q", upstream, clone], parent);
  await identity(clone, "import clone");
  const store = scratchDir("nemar-scrub-remote-");
  await run(
    [
      "git",
      "annex",
      "initremote",
      "nemar-s3",
      "type=directory",
      `directory=${store}`,
      "encryption=none",
    ],
    clone,
  );
  return { clone, store };
}

/** What `prepareImport` derives before step 5b: the whereis map and the upstream items. */
async function upstreamView(clone: string) {
  const { urlMap } = await getAnnexWhereisAll(clone);
  return { keyUrlMap: urlMap, upstreamItems: buildManifestItems(urlMap, NEMAR_ID).items };
}

const inheritUpload = annexCopyUpload({ credentials: "inherit" });
const FIXED_NOW = new Date("2026-10-06T12:00:00.000Z");

async function prepare(
  clone: string,
  view: { keyUrlMap: Map<string, string>; upstreamItems: ImportManifestItem[] },
  overrides: Partial<Parameters<typeof prepareImportedTreeForCopy>[0]> = {},
) {
  return prepareImportedTreeForCopy({
    datasetPath: clone,
    nemarId: NEMAR_ID,
    bucket: "nemar",
    remoteName: "nemar-s3",
    keyUrlMap: view.keyUrlMap,
    upstreamItems: view.upstreamItems,
    unannexedData: [],
    reimport: false,
    skipData: false,
    reader: httpUpstreamReader({ baseUrl, retryDelayMs: 1 }),
    upload: inheritUpload,
    now: FIXED_NOW,
    actor: "fixture-actor",
    ...overrides,
  });
}

async function keyAt(clone: string, path: string): Promise<string> {
  const key = (await listAnnexedKeys(clone)).get(path);
  if (!key) throw new Error("path is not annexed");
  return key;
}

/** The bytes the directory remote holds for a key. */
function storedBytes(store: string, key: string): Uint8Array {
  const find = (dir: string): string | null => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        const hit = find(full);
        if (hit) return hit;
      } else if (name === key) {
        return full;
      }
    }
    return null;
  };
  const file = find(store);
  if (!file) throw new Error("key not at the remote");
  return new Uint8Array(readFileSync(file));
}

function expectNoSecret(haystack: string): void {
  for (const secret of SECRETS) expect(haystack).not.toContain(secret);
}

async function headCommit(clone: string): Promise<string> {
  return run(["git", "log", "-1", "--format=%B"], clone);
}

const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------------------------------
// A first import
// ---------------------------------------------------------------------------------------

describe("a first import of a tree with identifiers", () => {
  test("scrubs the flagged recording, blanks the sidecar, and the copy never sees the original", async () => {
    const files = baseFixtures();
    const upstream = await buildUpstream(files);
    const { clone, store } = await cloneForImport(upstream);
    const view = await upstreamView(clone);
    const oldKey = await keyAt(clone, FLAGGED_ANNEXED);
    const cleanKey = await keyAt(clone, CLEAN_ANNEXED);
    expect(view.keyUrlMap.has(oldKey)).toBe(true);
    // Prepare has staged root metadata of its own by step 5b (ensureRootMetadataUnannexed); it
    // belongs to a later commit, not to the privacy correction.
    writeFileSync(join(clone, "dataset_description.json"), `{"Name": "fixture, restaged"}\n`);
    await run(["git", "-c", "annex.largefiles=nothing", "add", "dataset_description.json"], clone);

    const result = await prepare(clone, view);

    // The recording: a new SHA256E key, content at the remote, header scrubbed, payload identical.
    const newKey = await keyAt(clone, FLAGGED_ANNEXED);
    expect(newKey).not.toBe(oldKey);
    expect(newKey).toMatch(/^SHA256E-s4256--[0-9a-f]{64}\.edf$/);
    const original = files.find((f) => f.path === FLAGGED_ANNEXED)?.bytes as Uint8Array;
    const stored = storedBytes(store, newKey);
    expect(stored.length).toBe(original.length);
    expect(Buffer.from(stored.subarray(EDF_HEADER_BYTES))).toEqual(
      Buffer.from(original.subarray(EDF_HEADER_BYTES)),
    );
    const direct = scanEdfHeader(stored.subarray(0, EDF_HEADER_BYTES)).filter(
      (f) => f.severity === "identifier",
    );
    expect(direct).toEqual([]);
    expectNoSecret(Buffer.from(stored.subarray(0, EDF_HEADER_BYTES)).toString("latin1"));

    // The copy manifest: the clean upstream key and the new local key; never the replaced one.
    const keys = result.manifest.items.map((it) => it.key).sort();
    expect(keys).toEqual([cleanKey, newKey].sort());
    expect(result.manifest.items.find((it) => it.key === newKey)?.origin).toBe("local");
    expect(result.manifest.items.find((it) => it.key === cleanKey)?.origin).toBeUndefined();
    expect(result.scrub.replacedKeys).toEqual(new Set([oldKey]));

    // The replaced key is dead in the git-annex branch the push carries.
    const [oldLog] = await locationLogs(clone, [oldKey]);
    expect(isDead(oldLog ?? "")).toBe(true);

    // The sidecar's value is blanked and nothing else in it moved.
    expect(readFileSync(join(clone, SIDECAR), "utf8")).toBe(
      `{\n  "TaskName": "rest",\n  "SamplingFrequency": 256,\n  "Acq": {\n    "PatientName": ""\n  }\n}\n`,
    );

    // Counts. The BIDS photo is an accepted image use and is not counted; the scan is.
    expect(result.scrub.counts).toMatchObject({
      recordings: 2,
      headers_read: 2,
      headers_scrubbed: 1,
      upstream_keys_replaced: 1,
      json_values_blanked: 1,
      json_files_blanked: 1,
      images_or_documents_held: 1,
      bytes_downloaded: original.length,
    });
    // A JSON value was blanked: the pushed history still holds it, so a person decides.
    expect(result.privacy).toEqual({ version: 1, historyHoldsOriginals: true });

    // One ledger line, valid under the ledger's own guard, with no value and no path in it.
    const ledgerPath = join(clone, ".nemar/corrections.jsonl");
    const ledger = readLedger(ledgerPath);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      dataset: NEMAR_ID,
      action: "import-scrubbed",
      versions: [],
      scanner: IMPORT_SCANNER_ID,
      verification: "scanner-clean+payload-identical",
      actor: "fixture-actor",
      at: FIXED_NOW.toISOString(),
    });
    expect(ledger[0]?.counts.headers_scrubbed).toBe(1);
    expectNoSecret(readFileSync(ledgerPath, "utf8"));

    // The scrub is its own commit, with counts only, and the ledger is in it.
    const log = await run(["git", "log", "--format=%s%n%b", "-3"], clone);
    expect(log).toContain("Privacy correction on import (ADR 0089)");
    expectNoSecret(log);
    const committed = await run(["git", "show", "--name-only", "--format=", "HEAD~1"], clone);
    // HEAD is the annex-policy commit (it strips upstream's largefiles), HEAD~1 the scrub.
    expect(await run(["git", "log", "-1", "--format=%s", "HEAD~1"], clone)).toContain(
      "Privacy correction on import",
    );
    expect(committed).toContain(".nemar/corrections.jsonl");
    expect(committed).toContain(SIDECAR);
    expect(committed).toContain(FLAGGED_ANNEXED);
    expect(committed).not.toContain("dataset_description.json");
    expect(await headCommit(clone)).toContain("Apply NEMAR annex policy");
    // The staged metadata still landed, in the commit after the scrub.
    expect(await run(["git", "show", "HEAD:dataset_description.json"], clone)).toContain(
      "restaged",
    );

    // Nothing the scrub returns carries a value.
    expectNoSecret(JSON.stringify(result.scrub.counts));

    // The upstream original was downloaded once, whole; the clean one was only ever range-read.
    const full = requests.filter((r) => r.range === null).map((r) => r.path);
    expect(full).toEqual([`${BUCKET_PATH}/${FLAGGED_ANNEXED}`]);
  }, 120_000);

  test("the new key is the one ADR 0085's tools produce from the same upstream bytes", async () => {
    // Determinism is what lets a later re-pull reproduce a correction without a declaration: the
    // same upstream bytes, the same patch (`scrubEdfHeader`), the same SHA256E key. ADR 0085's hash
    // stage names the new key `SHA256E-s<size>--<sha256 of the patched bytes><ext>`.
    const files = baseFixtures();
    const upstream = await buildUpstream(files);
    const { clone } = await cloneForImport(upstream);
    await prepare(clone, await upstreamView(clone));
    const original = files.find((f) => f.path === FLAGGED_ANNEXED)?.bytes as Uint8Array;
    const patched = original.slice();
    patched.set(scrubEdfHeader(original.subarray(0, EDF_HEADER_BYTES)).header, 0);
    expect(await keyAt(clone, FLAGGED_ANNEXED)).toBe(
      `SHA256E-s${patched.length}--${sha256Hex(patched)}.edf`,
    );
  }, 120_000);

  test("the new key is SHA256E even when the tree's attributes now name another backend", async () => {
    // A dataset whose attributes changed after its recordings were annexed: the old keys are
    // SHA256E, and a plain re-add would follow the newer attribute. ADR 0085's tools follow only
    // SHA256E keys, so the scrub names its backend rather than inheriting one.
    const upstream = await buildUpstream(baseFixtures());
    const { clone } = await cloneForImport(upstream);
    writeFileSync(
      join(clone, ".gitattributes"),
      UPSTREAM_GITATTRIBUTES.replace("* annex.backend=SHA256E", "* annex.backend=MD5E"),
    );
    await run(["git", "commit", "-qam", "backend changed"], clone);
    await prepare(clone, await upstreamView(clone));
    expect(await keyAt(clone, FLAGGED_ANNEXED)).toMatch(/^SHA256E-/);
  }, 120_000);

  test("a clean tree is left alone: no commit, no ledger, the manifest is upstream's", async () => {
    const files = baseFixtures().filter((f) => f.path !== FLAGGED_ANNEXED && f.path !== SIDECAR);
    const upstream = await buildUpstream(files);
    const { clone } = await cloneForImport(upstream);
    const view = await upstreamView(clone);
    const before = (await run(["git", "rev-parse", "HEAD"], clone)).trim();

    const result = await prepare(clone, view);

    expect(result.scrub.committed).toBe(false);
    expect(existsSync(join(clone, ".nemar/corrections.jsonl"))).toBe(false);
    expect(result.scrub.counts.headers_read).toBe(1);
    expect(result.scrub.counts.headers_scrubbed).toBe(0);
    expect(result.manifest.items.map((it) => it.key)).toEqual(view.upstreamItems.map((i) => i.key));
    expect(result.privacy.historyHoldsOriginals).toBe(false);
    // The only commit on top is the annex policy's.
    expect((await run(["git", "rev-parse", "HEAD~1"], clone)).trim()).toBe(before);
    expect(requests.every((r) => r.range !== null)).toBe(true);
  }, 120_000);

  test("a recording git holds is patched in the clone, annexed, uploaded, and held for a person", async () => {
    const small = edfBytes(FLAGGED_PATIENT, 500, 3);
    // No sidecar to blank: the git-held recording alone must be what holds the publication.
    const files = [
      ...baseFixtures().filter((f) => f.path !== SIDECAR),
      { path: FLAGGED_GIT, bytes: small },
    ];
    const upstream = await buildUpstream(files);
    const { clone, store } = await cloneForImport(upstream);
    expect((await listAnnexedKeys(clone)).has(FLAGGED_GIT)).toBe(false);
    const view = await upstreamView(clone);

    const result = await prepare(clone, view, {
      unannexedData: [{ path: FLAGGED_GIT, size: small.length }],
    });

    const key = await keyAt(clone, FLAGGED_GIT);
    const stored = storedBytes(store, key);
    expect(Buffer.from(stored.subarray(EDF_HEADER_BYTES))).toEqual(
      Buffer.from(small.subarray(EDF_HEADER_BYTES)),
    );
    expectNoSecret(Buffer.from(stored.subarray(0, EDF_HEADER_BYTES)).toString("latin1"));
    expect(result.scrub.handledPaths).toEqual(new Set([FLAGGED_GIT]));
    expect(result.scrub.counts.git_held_recordings_scrubbed).toBe(1);
    expect(result.scrub.counts.headers_scrubbed).toBe(2);
    // The annex-policy leg did not annex it a second time.
    expect(result.normalized.data).toBeNull();
    expect(result.manifest.items.find((it) => it.key === key)?.origin).toBe("local");
    // The original stays in the pushed history as a git blob: never approved automatically.
    expect(result.scrub.counts.json_values_blanked).toBe(0);
    expect(result.privacy.historyHoldsOriginals).toBe(true);
  }, 120_000);

  test("a forward fix of an annexed recording alone does not hold the publication", async () => {
    // The replaced key is never copied and is dead, so the history names a pointer to bytes NEMAR
    // does not hold. Only git-tracked content (JSON, a git-held recording) keeps a value in history.
    const files = baseFixtures().filter((f) => f.path !== SIDECAR);
    const upstream = await buildUpstream(files);
    const { clone } = await cloneForImport(upstream);
    const result = await prepare(clone, await upstreamView(clone));
    expect(result.scrub.counts.headers_scrubbed).toBe(1);
    expect(result.privacy.historyHoldsOriginals).toBe(false);
  }, 120_000);

  test("the provenance file and its README say the headers were scrubbed", async () => {
    const provenance = `{\n  "source": "upstream",\n  "files": [\n    {"file": "x.edf", "bytes": 1, "sha256": "${"a".repeat(64)}"}\n  ]\n}\n`;
    const readme = "# Provenance\n\nThe files are byte-for-byte unmodified.\n";
    const files = [
      ...baseFixtures(),
      { path: "sourcedata/sourcedata_provenance.json", bytes: text(provenance) },
      { path: "sourcedata/README_sourcedata_provenance.md", bytes: text(readme) },
    ];
    const upstream = await buildUpstream(files);
    const { clone } = await cloneForImport(upstream);
    const result = await prepare(clone, await upstreamView(clone));

    const doc = JSON.parse(
      readFileSync(join(clone, "sourcedata/sourcedata_provenance.json"), "utf8"),
    );
    expect(doc[PROVENANCE_NOTE_KEY]).toBe(provenanceNote("2026-10-06", "scrubbed-in-place"));
    expect(doc.files[0].sha256).toBe("a".repeat(64));
    expect(
      readFileSync(join(clone, "sourcedata/README_sourcedata_provenance.md"), "utf8"),
    ).toContain(
      "Privacy correction 2026-10-06: identification fields in the headers of the recording files were scrubbed in place.",
    );
    expect(result.scrub.counts.provenance_annotated).toBe(1);
    expect(result.scrub.counts.provenance_readme_annotated).toBe(1);
  }, 120_000);

  test("--skip-data reads no annexed header, still blanks JSON, and keeps a git-held recording in git", async () => {
    const small = edfBytes(FLAGGED_PATIENT, 500, 4);
    const files = [...baseFixtures(), { path: FLAGGED_GIT, bytes: small }];
    const upstream = await buildUpstream(files);
    const { clone } = await cloneForImport(upstream);

    const result = await prepare(
      clone,
      { keyUrlMap: new Map(), upstreamItems: [] },
      { skipData: true },
    );

    expect(requests).toEqual([]);
    expect(result.scrub.counts.headers_not_read_skip_data).toBe(2);
    expect(result.scrub.counts.json_values_blanked).toBe(1);
    expect(result.scrub.counts.git_held_recordings_scrubbed).toBe(1);
    expect((await listAnnexedKeys(clone)).has(FLAGGED_GIT)).toBe(false);
    const committed = await run(["git", "show", `HEAD~1:${FLAGGED_GIT}`], clone);
    expectNoSecret(committed.slice(0, EDF_HEADER_BYTES));
    expect(result.manifest.items).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------

async function refusal(promise: Promise<unknown>): Promise<ImportScrubRefused> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ImportScrubRefused) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("what the scrub refuses, before anything is pushed or copied", () => {
  test("an upstream header that answers 403 refuses with both markers and changes nothing", async () => {
    const upstream = await buildUpstream(baseFixtures());
    const { clone } = await cloneForImport(upstream);
    const view = await upstreamView(clone);
    (served.get(`${BUCKET_PATH}/${CLEAN_ANNEXED}`) as Served).status = 403;
    const head = (await run(["git", "rev-parse", "HEAD"], clone)).trim();

    const err = await refusal(prepare(clone, view));
    expect(err.code).toBe("header-unreadable");
    expect(err.message.startsWith(`${OPENNEURO_UPSTREAM_MARKER} ${IMPORT_SCRUB_MARKER}`)).toBe(
      true,
    );
    expect(err.message).toContain("http-403 x1");
    expectNoSecret(err.message);
    expect((await run(["git", "rev-parse", "HEAD"], clone)).trim()).toBe(head);
    expect(requests.some((r) => r.range === null)).toBe(false);
  }, 120_000);

  test("a recording whose only source is a plain web URL is read there and scrubbed", async () => {
    // The copy phase's curl fallback copies an item whose whereis URL is not an S3 endpoint, so
    // its header must be read at that URL too, never skipped as "no source".
    const files = baseFixtures();
    const webPath = (p: string) => `web/${UPSTREAM_ID}/${p}`;
    const upstream = await buildUpstream(files, {
      urlFor: (p) =>
        p === FLAGGED_ANNEXED
          ? `${baseUrl}/${webPath(p)}`
          : `https://s3.amazonaws.com/${BUCKET_PATH}/${p}`,
    });
    const original = files.find((f) => f.path === FLAGGED_ANNEXED)?.bytes as Uint8Array;
    served.set(webPath(FLAGGED_ANNEXED), { bytes: original });
    const { clone, store } = await cloneForImport(upstream);
    const view = await upstreamView(clone);
    const oldKey = await keyAt(clone, FLAGGED_ANNEXED);
    expect(view.upstreamItems.find((it) => it.key === oldKey)?.source).toBeNull();

    const result = await prepare(clone, view);
    const newKey = await keyAt(clone, FLAGGED_ANNEXED);
    expect(newKey).not.toBe(oldKey);
    expect(result.manifest.items.map((it) => it.key)).not.toContain(oldKey);
    expectNoSecret(
      Buffer.from(storedBytes(store, newKey).subarray(0, EDF_HEADER_BYTES)).toString("latin1"),
    );
    expect(requests.some((r) => r.path === webPath(FLAGGED_ANNEXED) && r.range === null)).toBe(
      true,
    );
    expect(result.scrub.counts.headers_not_read_no_source).toBe(0);
  }, 120_000);

  test("a header read that ends early is a failure, never a short header", async () => {
    // A short body would read as "not an EDF" and let the recording through unread.
    const upstream = await buildUpstream(baseFixtures());
    const { clone } = await cloneForImport(upstream);
    const view = await upstreamView(clone);
    (served.get(`${BUCKET_PATH}/${FLAGGED_ANNEXED}`) as Served).shortRange = 100;
    const err = await refusal(prepare(clone, view));
    expect(err.code).toBe("header-unreadable");
    expect(err.message).toContain("short-read x1");
  }, 120_000);

  test("a header read that does not say the object's size is a failure", async () => {
    const upstream = await buildUpstream(baseFixtures());
    const { clone } = await cloneForImport(upstream);
    const view = await upstreamView(clone);
    (served.get(`${BUCKET_PATH}/${CLEAN_ANNEXED}`) as Served).noLength = true;
    const err = await refusal(prepare(clone, view));
    expect(err.code).toBe("header-unreadable");
    expect(err.message).toContain("no-length x1");
  }, 120_000);

  test("a 403 beside a 500 is not OpenNeuro refusing its bytes: the scrub's marker only", async () => {
    const upstream = await buildUpstream(baseFixtures());
    const { clone } = await cloneForImport(upstream);
    const view = await upstreamView(clone);
    (served.get(`${BUCKET_PATH}/${CLEAN_ANNEXED}`) as Served).status = 403;
    (served.get(`${BUCKET_PATH}/${FLAGGED_ANNEXED}`) as Served).status = 500;
    const err = await refusal(prepare(clone, view));
    expect(err.message.startsWith(IMPORT_SCRUB_MARKER)).toBe(true);
    expect(err.message).not.toContain(OPENNEURO_UPSTREAM_MARKER);
  }, 120_000);

  test("a recording git holds that cannot be read refuses, with the scrub's marker only", async () => {
    const small = edfBytes(FLAGGED_PATIENT, 500, 5);
    const upstream = await buildUpstream([...baseFixtures(), { path: FLAGGED_GIT, bytes: small }]);
    const { clone } = await cloneForImport(upstream);
    const view = await upstreamView(clone);
    chmodSync(join(clone, FLAGGED_GIT), 0o000);
    const err = await refusal(prepare(clone, view));
    expect(err.code).toBe("header-unreadable");
    expect(err.message).toContain("local-unreadable x1");
    expect(err.message).not.toContain(OPENNEURO_UPSTREAM_MARKER);
  }, 120_000);

  test("an empty recording is not read and does not refuse", async () => {
    const files = [
      ...baseFixtures(),
      { path: "sub-05/eeg/sub-05_task-rest_eeg.edf", bytes: new Uint8Array() },
    ];
    // Annexed although empty, as an upstream rule of `anything` would annex it.
    const upstream = await buildUpstream(files, {
      attributes: UPSTREAM_GITATTRIBUTES.replace(
        "*.edf annex.largefiles=largerthan=2kb",
        "*.edf annex.largefiles=anything",
      ),
    });
    const { clone } = await cloneForImport(upstream);
    const result = await prepare(clone, await upstreamView(clone));
    expect(result.scrub.counts.headers_not_edf).toBe(1);
    expect(requests.some((r) => r.path.endsWith("sub-05_task-rest_eeg.edf"))).toBe(false);
  }, 120_000);

  test("a recording to replace whose key is not SHA256E refuses before any download", async () => {
    const upstream = await buildUpstream(baseFixtures(), {
      attributes: UPSTREAM_GITATTRIBUTES.replace("* annex.backend=SHA256E", "* annex.backend=MD5E"),
    });
    const { clone } = await cloneForImport(upstream);
    expect(await keyAt(clone, FLAGGED_ANNEXED)).toMatch(/^MD5E-/);
    const err = await refusal(prepare(clone, await upstreamView(clone)));
    expect(err.code).toBe("unsupported-key-backend");
    expect(requests.some((r) => r.range === null)).toBe(false);
  }, 120_000);

  test("an error with a path in it is reported by its class alone", async () => {
    // A Node fs error's message embeds the absolute path, and a path can be the identifier.
    const secretJson = `sub-01/eeg/${SURNAME}_notes.json`;
    const upstream = await buildUpstream([
      ...baseFixtures(),
      { path: secretJson, bytes: text(`{"TaskName": "rest"}`) },
    ]);
    const { clone } = await cloneForImport(upstream);
    chmodSync(join(clone, secretJson), 0o000);
    const err = await refusal(prepare(clone, await upstreamView(clone)));
    expect(err.code).toBe("scrub-failed");
    expect(err.message).toContain("EACCES");
    expectNoSecret(err.message);
    expect(err.message).not.toContain(clone);
  }, 120_000);

  test("an upload that fails is reported without the paths git-annex names", async () => {
    const upstream = await buildUpstream(baseFixtures());
    const { clone, store } = await cloneForImport(upstream);
    const view = await upstreamView(clone);
    // The remote's directory is gone: git-annex's copy fails, and its stderr names the file.
    rmSync(store, { recursive: true, force: true });
    const err = await refusal(prepare(clone, view));
    expect(err.code).toBe("upload-failed");
    expectNoSecret(err.message);
    expect(err.message).not.toContain(clone);
  }, 120_000);

  test("the Worker's classifier reads each refusal the way it was meant", async () => {
    // The CLI's failure line becomes `import_jobs.last_error`; the classifier keeps its own copy
    // of the marker, so the two are pinned here, through a refusal the scrub really raised.
    expect(IMPORT_IDENTIFIER_SCRUB_MARKER_FOR_CLASSIFY).toBe(IMPORT_SCRUB_MARKER);
    expect(IMPORT_SCRUB_MARKER).toBe("[nemar-identifier-scrub]");
    const upstream = await buildUpstream(baseFixtures());
    const { clone } = await cloneForImport(upstream);
    const view = await upstreamView(clone);
    const bound = await refusal(prepare(clone, view, { maxBytes: 1 }));
    expect(classifyImportFailure({ stage: "prepare", lastError: bound.message }).cause).toBe(
      "identifier_scrub",
    );
    // The retry engine parks the words a retry cannot clear; each must be one the scrub can say.
    for (const word of DETERMINISTIC_SCRUB_REFUSALS) {
      expect(IMPORT_SCRUB_REFUSALS as readonly string[]).toContain(word);
    }
    expect(isDeterministicScrubRefusal(bound.message)).toBe(true);
    (served.get(`${BUCKET_PATH}/${CLEAN_ANNEXED}`) as Served).status = 403;
    const denied = await refusal(prepare(clone, view));
    // OpenNeuro refusing its own bytes is the more specific claim, and it keeps the dataset
    // retryable by the upstream rule (#808).
    expect(classifyImportFailure({ stage: "prepare", lastError: denied.message }).cause).toBe(
      "upstream_inaccessible",
    );
    expect(isDeterministicScrubRefusal(denied.message)).toBe(false);
  }, 120_000);

  test("a 500 that persists refuses with the scrub's marker only", async () => {
    const upstream = await buildUpstream(baseFixtures());
    const { clone } = await cloneForImport(upstream);
    const view = await upstreamView(clone);
    (served.get(`${BUCKET_PATH}/${CLEAN_ANNEXED}`) as Served).status = 500;
    const err = await refusal(prepare(clone, view));
    expect(err.code).toBe("header-unreadable");
    expect(err.message.startsWith(IMPORT_SCRUB_MARKER)).toBe(true);
    expect(err.message).not.toContain(OPENNEURO_UPSTREAM_MARKER);
    // Retried: three attempts for the failing object.
    expect(requests.filter((r) => r.path.endsWith(CLEAN_ANNEXED)).length).toBe(3);
  }, 120_000);

  test("an upstream object that is not the size its key declares refuses", async () => {
    const upstream = await buildUpstream(baseFixtures());
    const { clone } = await cloneForImport(upstream);
    const view = await upstreamView(clone);
    (served.get(`${BUCKET_PATH}/${CLEAN_ANNEXED}`) as Served).total = 999;
    const err = await refusal(prepare(clone, view));
    expect(err.code).toBe("upstream-size-mismatch");
  }, 120_000);

  test("recordings to scrub over the bound refuse before a byte is downloaded", async () => {
    const upstream = await buildUpstream(baseFixtures());
    const { clone } = await cloneForImport(upstream);
    const view = await upstreamView(clone);
    const err = await refusal(prepare(clone, view, { maxBytes: 4255 }));
    expect(err.code).toBe("bound-exceeded");
    expect(err.message).toContain("--normalize-max-gb");
    expect(requests.some((r) => r.range === null)).toBe(false);
    // One byte more and it goes through: the bound is the bytes to move, not a guess.
    const ok = await prepare(clone, view, { maxBytes: 4256 });
    expect(ok.scrub.counts.headers_scrubbed).toBe(1);
  }, 120_000);

  test("git-held data counts against the same bound as the downloads", async () => {
    const upstream = await buildUpstream(baseFixtures());
    const { clone } = await cloneForImport(upstream);
    const view = await upstreamView(clone);
    const err = await refusal(
      prepare(clone, view, {
        maxBytes: 5000,
        unannexedData: [{ path: "participants.tsv", size: 1000 }],
      }),
    );
    expect(err.code).toBe("bound-exceeded");
  }, 120_000);

  test("a download that does not hash to its key refuses and leaves the pointer in place", async () => {
    const upstream = await buildUpstream(baseFixtures());
    const { clone } = await cloneForImport(upstream);
    const view = await upstreamView(clone);
    const obj = served.get(`${BUCKET_PATH}/${FLAGGED_ANNEXED}`) as Served;
    const tampered = obj.bytes.slice();
    tampered[tampered.length - 1] ^= 0xff;
    obj.fullBody = tampered;
    const oldKey = await keyAt(clone, FLAGGED_ANNEXED);

    const err = await refusal(prepare(clone, view));
    expect(err.code).toBe("content-mismatch");
    expect(await keyAt(clone, FLAGGED_ANNEXED)).toBe(oldKey);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------
// Re-imports
// ---------------------------------------------------------------------------------------

/**
 * A re-import as prepare performs it: a fresh clone of upstream, whose whereis still names the
 * original key, pointed at the dataset's own repository (steps 4, 4b and 4c).
 */
async function reimportClone(upstream: string, nemarRepo: string) {
  const { clone } = await cloneForImport(upstream);
  // Step 3 runs on upstream's tree, before the reset: its whereis still has the original key.
  const view = await upstreamView(clone);
  await run(["git", "remote", "remove", "origin"], clone);
  await run(["git", "remote", "add", "origin", nemarRepo], clone);
  await run(["git", "fetch", "-q", "origin", "git-annex"], clone);
  await run(["git", "annex", "merge"], clone);
  await run(["git", "fetch", "-q", "origin", "main"], clone);
  await run(["git", "reset", "-q", "--hard", "origin/main"], clone);
  return { clone, view };
}

async function bareRepo(): Promise<string> {
  const dir = join(scratchDir("nemar-scrub-origin-"), `${NEMAR_ID}.git`);
  await run(["git", "init", "-q", "--bare", dir], tmpdir());
  return dir;
}

describe("a re-import never copies back what a correction replaced", () => {
  test("of a scrubbed dataset: the replaced key is dropped from the manifest and nothing is redone", async () => {
    const upstream = await buildUpstream(baseFixtures());
    const nemarRepo = await bareRepo();
    const first = await cloneForImport(upstream);
    const firstView = await upstreamView(first.clone);
    const oldKey = await keyAt(first.clone, FLAGGED_ANNEXED);
    await prepare(first.clone, firstView);
    const newKey = await keyAt(first.clone, FLAGGED_ANNEXED);
    await run(["git", "remote", "add", "nemar", nemarRepo], first.clone);
    await run(["git", "push", "-q", "nemar", "main", "git-annex"], first.clone);
    requests.length = 0;

    const { clone, view } = await reimportClone(upstream, nemarRepo);
    // The premise: what the copy phase would copy if nothing cut the manifest.
    expect(view.upstreamItems.map((it) => it.key)).toContain(oldKey);

    const result = await prepare(clone, view, { reimport: true });

    const keys = result.manifest.items.map((it) => it.key);
    expect(keys).not.toContain(oldKey);
    expect(keys).toContain(newKey);
    expect(result.manifest.droppedNotInTree).toBe(1);
    // The purge record survives the re-import's merge of upstream's git-annex branch.
    const [oldLog] = await locationLogs(clone, [oldKey]);
    expect(isDead(oldLog ?? "")).toBe(true);
    // Nothing to scrub again: the tree is the corrected one, and its own key is not re-read.
    expect(result.scrub.committed).toBe(false);
    expect(result.scrub.counts.headers_not_read_nemar_held).toBe(1);
    expect(readLedger(join(clone, ".nemar/corrections.jsonl"))).toHaveLength(1);
    // The first import blanked a sidecar, and the history this tree carries still holds the value:
    // nothing was blanked THIS run, and the hold is carried from the ledger, not forgotten.
    expect(result.scrub.counts.json_values_blanked).toBe(0);
    expect(result.privacy).toEqual({ version: 1, historyHoldsOriginals: true });
    expect(requests.some((r) => r.range === null)).toBe(false);
  }, 180_000);

  test("a later history rewrite clears the hold, and a ledger that cannot be read keeps it", async () => {
    const upstream = await buildUpstream(baseFixtures());
    const nemarRepo = await bareRepo();
    const first = await cloneForImport(upstream);
    await prepare(first.clone, await upstreamView(first.clone));
    await run(["git", "remote", "add", "nemar", nemarRepo], first.clone);
    const ledger = join(first.clone, ".nemar/corrections.jsonl");
    // ADR 0085's history rewrite ran after the import: the originals are gone from history.
    const rewritten = {
      ...readLedger(ledger)[0],
      action: "history-rewritten",
      versions: [],
      counts: { commits: 3 },
      verification: "scanner-clean",
    };
    writeFileSync(ledger, `${readFileSync(ledger, "utf8")}${JSON.stringify(rewritten)}\n`);
    await run(
      ["git", "-c", "annex.largefiles=nothing", "add", ".nemar/corrections.jsonl"],
      first.clone,
    );
    await run(["git", "commit", "-qm", "rewritten"], first.clone);
    await run(["git", "push", "-q", "nemar", "main", "git-annex"], first.clone);
    const cleared = await reimportClone(upstream, nemarRepo);
    const after = await prepare(cleared.clone, cleared.view, { reimport: true });
    expect(after.privacy.historyHoldsOriginals).toBe(false);

    // A line the ledger's own guard refuses: whether history holds is unknown, so it holds.
    writeFileSync(ledger, `${readFileSync(ledger, "utf8")}{"version": 1, "action": "free text"}\n`);
    await run(
      ["git", "-c", "annex.largefiles=nothing", "add", ".nemar/corrections.jsonl"],
      first.clone,
    );
    await run(["git", "commit", "-qm", "bad line"], first.clone);
    await run(["git", "push", "-q", "nemar", "main"], first.clone);
    const corrupt = await reimportClone(upstream, nemarRepo);
    const held = await prepare(corrupt.clone, corrupt.view, { reimport: true });
    expect(held.privacy.historyHoldsOriginals).toBe(true);
  }, 240_000);

  test("an upstream recording the dataset's own tree does not name is never copied", async () => {
    // Re-pull is not built (ADR 0006): a re-import keeps the dataset's own tree. A recording
    // upstream added since is in upstream's whereis but in no tree this prepare pushes, nobody read
    // its header, and nothing but the cut to the tree keeps it out of the bucket: it is not dead.
    const upstream = await buildUpstream(baseFixtures().filter((f) => f.path !== FLAGGED_ANNEXED));
    const nemarRepo = await bareRepo();
    const first = await cloneForImport(upstream);
    await prepare(first.clone, await upstreamView(first.clone));
    await run(["git", "remote", "add", "nemar", nemarRepo], first.clone);
    await run(["git", "push", "-q", "nemar", "main", "git-annex"], first.clone);

    const added = "sub-04/eeg/sub-04_task-rest_eeg.edf";
    const addedBytes = edfBytes(FLAGGED_PATIENT, 4000, 9);
    mkdirSync(join(upstream, dirname(added)), { recursive: true });
    writeFileSync(join(upstream, added), addedBytes);
    await run(["git", "annex", "add", "--quiet", added], upstream);
    await run(["git", "commit", "-qm", "upstream adds a recording"], upstream);
    const addedKey = await keyAt(upstream, added);
    await run(
      ["git", "annex", "registerurl", addedKey, `https://s3.amazonaws.com/${BUCKET_PATH}/${added}`],
      upstream,
    );
    await run(["git", "annex", "drop", "--force", "--quiet", added], upstream);
    served.set(`${BUCKET_PATH}/${added}`, { bytes: addedBytes });

    const { clone, view } = await reimportClone(upstream, nemarRepo);
    expect(view.upstreamItems.map((it) => it.key)).toContain(addedKey);
    const result = await prepare(clone, view, { reimport: true });
    expect(result.manifest.items.map((it) => it.key)).not.toContain(addedKey);
    expect(result.manifest.droppedNotInTree).toBe(1);
    expect(result.manifest.droppedDead).toBe(0);
  }, 180_000);

  test("of a dataset imported before the scrub existed: refuses, it is ADR 0085's to correct", async () => {
    const upstream = await buildUpstream(baseFixtures());
    const nemarRepo = await bareRepo();
    // An earlier import that pushed upstream's tree unscrubbed.
    const first = await cloneForImport(upstream);
    await run(["git", "remote", "add", "nemar", nemarRepo], first.clone);
    await run(["git", "push", "-q", "nemar", "main", "git-annex"], first.clone);

    const { clone, view } = await reimportClone(upstream, nemarRepo);
    const err = await refusal(prepare(clone, view, { reimport: true }));
    expect(err.code).toBe("already-imported-unscrubbed");
    expect(requests.some((r) => r.range === null)).toBe(false);
  }, 180_000);

  test("a key the git-annex branch records as dead is never copied, even if the tree names it", async () => {
    // The purge list's reader: ADR 0085's annex-registry and this importer mark a purged key dead.
    const files = baseFixtures().filter((f) => f.path !== FLAGGED_ANNEXED);
    const upstream = await buildUpstream(files);
    const { clone } = await cloneForImport(upstream);
    const view = await upstreamView(clone);
    const cleanKey = await keyAt(clone, CLEAN_ANNEXED);
    await run(
      ["git", "annex", "setpresentkey", cleanKey, "00000000-0000-0000-0000-000000000001", "0"],
      clone,
    );
    await run(["git", "annex", "dead", "--quiet", "--key", cleanKey], clone);

    const result = await prepare(clone, view);
    expect(result.manifest.items.map((it) => it.key)).not.toContain(cleanKey);
    expect(result.manifest.droppedDead).toBe(1);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------
// Small pieces with their own rules
// ---------------------------------------------------------------------------------------

describe("restrictManifestToTree", () => {
  test("refuses when the tree still names a key the scrub replaced", async () => {
    // Defensive: the scrub replaces every path that names a flagged key, so no fixture reaches
    // this through prepare. Driven directly, because the refusal is what keeps a replaced key out
    // of the copy if that ever stops being true.
    const upstream = await buildUpstream(baseFixtures());
    const { clone } = await cloneForImport(upstream);
    const { upstreamItems } = await upstreamView(clone);
    const named = await keyAt(clone, CLEAN_ANNEXED);
    const err = await refusal(restrictManifestToTree(clone, upstreamItems, new Set([named])));
    expect(err.code).toBe("old-key-still-named");
  }, 120_000);
});

describe("setTopLevelString", () => {
  test("appends a member in the file's own indentation and keeps every other byte", () => {
    const before = `{\n  "a": 1,\n  "files": [{"x": "}"}]\n}\n`;
    expect(setTopLevelString(before, "k", "v")).toBe(
      `{\n  "a": 1,\n  "files": [{"x": "}"}],\n  "k": "v"\n}\n`,
    );
  });

  test("replaces an existing member where it is", () => {
    expect(setTopLevelString(`{"k": "old", "z": 2}`, "k", "new")).toBe(`{"k": "new", "z": 2}`);
  });

  test("a nested member of the same name is not the top-level one", () => {
    expect(setTopLevelString(`{"o": {"k": "inner"}}`, "k", "v")).toBe(
      `{"o": {"k": "inner"}, "k": "v"}`,
    );
  });

  test("an empty object gets its first member; a non-object is refused", () => {
    expect(setTopLevelString("{}", "k", "v")).toBe(`{"k": "v"}`);
    expect(setTopLevelString("[1]", "k", "v")).toBeNull();
    expect(setTopLevelString("{", "k", "v")).toBeNull();
  });
});

describe("the ledger names the rules it ran under", () => {
  test("the scanner id is the digest of the rule files as they are now", () => {
    const hash = createHash("sha256");
    for (const rel of ["shared/identifier-scan.ts", "shared/identifier-scrub.ts"]) {
      hash.update(`${rel}\0`);
      hash.update(readFileSync(join(import.meta.dir, "..", rel)));
      hash.update("\0");
    }
    expect(IMPORT_SCANNER_ID).toBe(`identifier-scan@${hash.digest("hex").slice(0, 16)}`);
  });
});
