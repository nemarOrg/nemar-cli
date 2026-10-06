/**
 * Raw copies under `<id>/objects/` (ADR 0085, amendment of 2026-10-06; runbook steps 1, 5b and
 * 15b), run as the real programs against the S3 stand-in: the TypeScript plan records them, the
 * REAL Python `raw-hash` streams every raw version through the real `aws` CLI, `raw-verify`
 * compares, and `delete-old` deletes them behind that proof.
 *
 * One dataset is built once, the way nm000112 and nm000114 hold theirs: annex keys A and B (each
 * needs a scrub) and D (clean), plus raw copies stored by their paths: two raw recordings behind a
 * delete marker (one with two versions), raw text locked like the recordings (a TSV, a JSON whose
 * value the git rewrite would blank, an AppleDouble `._` file, a file whose path holds an invented
 * name), a zero-byte "folder" key, a name that is only a delete marker, and the special remote's
 * `annex-uuid`, which stays. Each test restores that state and a pristine working directory.
 *
 * The digests the tests expect are computed here, independently, with node:crypto: a raw
 * recording's bytes ARE an annex fixture's bytes, and a git blob id is SHA-1 over
 * `blob <size>\0` and the bytes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type PlanFile,
  type RawCopy,
  type RawHashesFile,
  type RawVerifiedFile,
  parsePlan,
  parseRawHashes,
  parseRawVerified,
} from "../../../scripts/scrub/contract";
import type { DeletedFile } from "../../../scripts/scrub/s3/s3-stages";
import { type S3Standin, type Snapshot, startS3Standin } from "../helpers/s3-standin";
import { expectStopped } from "./refusal";
import {
  BUCKET,
  DATASET,
  NAMES,
  type PublicEndpoint,
  SLOW,
  batchDeleted,
  buildAssembled,
  centuryFromNow,
  copyDir,
  deleteRequests,
  edfFile,
  edfHeader,
  fileSha256,
  fixtureA,
  fixtureB,
  fixtureD,
  has,
  leaksAName,
  makeFixture,
  objectPath,
  readJson,
  runHashStage,
  runScrub,
  seedManifest,
  sha256,
  startPublicEndpoint,
  tempDir,
  verifyArgs,
  writeGitVerified,
  writeJson,
} from "./support";

let standin: S3Standin;
let pub: PublicEndpoint;
let snap: Snapshot;
let built: string;
let dir: string;

const [a, b, d] = [fixtureA(), fixtureB(), fixtureD()];
const enc = (s: string) => new TextEncoder().encode(s);
/** What git calls a blob with these bytes, computed here and nowhere in the code under test. */
const gitBlob = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.length}\u0000`).update(bytes).digest("hex");

const REC1 = "sub-01/eeg/sub-01_task-rest_eeg.edf";
const REC2 = "sub-02/eeg/sub-02_task-rest_eeg.BDF";
const TSV = "participants.tsv";
const JSONF = "sub-01/eeg/sub-01_task-rest_eeg.json";
const APPLE = "._README.md";
const NOTES = "sourcedata/Wilhelmina_notes.txt";
const FOLDER = "code/";
const MARKED = "CHANGES";
const UUID = "annex-uuid";

interface RawSeed {
  name: string;
  versions: Array<{ bytes: Uint8Array; lock?: boolean }>;
  marker?: boolean;
}

/** The raw copies, in the order they are written. Text is locked, as nm000112's is. */
const RAW: RawSeed[] = [
  { name: REC1, versions: [{ bytes: a.bytes }], marker: true },
  // Two versions under one name, each the bytes of an annex key (one scrubbed, one clean).
  { name: REC2, versions: [{ bytes: b.bytes }, { bytes: d.bytes }], marker: true },
  {
    name: TSV,
    versions: [{ bytes: enc("participant_id\tsex\nsub-01\tF\nsub-02\tM\n"), lock: true }],
  },
  {
    name: JSONF,
    versions: [{ bytes: enc('{"TaskName": "rest", "Operator": "Thistlewood"}\n'), lock: true }],
  },
  { name: APPLE, versions: [{ bytes: enc("\u0000\u0005\u0016\u0007 Mac OS X  "), lock: true }] },
  { name: NOTES, versions: [{ bytes: enc("notes\n"), lock: true }] },
  { name: FOLDER, versions: [{ bytes: new Uint8Array(0) }] },
  { name: MARKED, versions: [], marker: true },
];
const RAW_NAMES = RAW.map((r) => r.name);
const OTHER_TEXT = RAW.filter((r) => !/\.(edf|bdf)$/i.test(r.name)).flatMap((r) =>
  r.versions.map((v) => v.bytes),
);
const UUID_BYTES = enc("6a1b7c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d");

/** The raw copies as the stand-in holds them now, in the plan's shape (versions newest first). */
function rawAsStored(): RawCopy[] {
  return [...RAW_NAMES].sort().map((name) => {
    const stored = [...standin.versions(BUCKET, objectPath(name))].reverse();
    return {
      name,
      kind: /\.(edf|bdf)$/i.test(name) ? "recording" : "other",
      versions: stored
        .filter((v) => !v.deleteMarker)
        .map((v) => ({ id: v.versionId, size: v.data.length })),
      markers: stored.filter((v) => v.deleteMarker).map((v) => v.versionId),
    } as RawCopy;
  });
}

const rawVersionIds = () =>
  RAW_NAMES.flatMap((n) =>
    standin
      .versions(BUCKET, objectPath(n))
      .filter((v) => !v.deleteMarker)
      .map((v) => v.versionId),
  );
const rawMarkerIds = () =>
  RAW_NAMES.flatMap((n) =>
    standin
      .versions(BUCKET, objectPath(n))
      .filter((v) => v.deleteMarker)
      .map((v) => v.versionId),
  );

/** The blob list as step 0 takes it: every text version's blob, and other blobs of the history. */
const BLOBS = [...OTHER_TEXT.map(gitBlob), "1".repeat(40), "2".repeat(40)].sort();
const writeBlobs = (lines: string[]) =>
  writeFileSync(path.join(dir, "git-blobs.txt"), `${lines.join("\n")}\n`);

const rawHashArgs = (extra: string[] = []) => [
  "raw-hash",
  "--plan",
  path.join(dir, "plan.json"),
  "--out",
  path.join(dir, "raw-hashes.json"),
  "--workers",
  "4",
  ...extra,
];
const rawVerify = (extra: string[] = []) =>
  runScrub(standin, ["raw-verify", "--dir", dir, ...extra]);

const assembledSha = () => sha256(readFileSync(path.join(dir, "assembled.json")));
function writeProofs(count = 2) {
  writeJson(dir, "verified.json", {
    version: 1,
    dataset: DATASET,
    verifiedAt: new Date().toISOString(),
    assembledSha256: assembledSha(),
    counts: { keys: count, headersChecked: count, rangesCompared: 0 },
  });
  writeJson(dir, "new-hash-verified.json", {
    version: 1,
    dataset: DATASET,
    assembledSha256: assembledSha(),
    count,
  });
}

const deleteArgs = (extra: string[] = []) => [
  "delete-old",
  "--dir",
  dir,
  "--confirm-dataset",
  DATASET,
  "--public-base",
  pub.url,
  "--concurrency",
  "8",
  ...extra,
];
const executeArgs = (extra: string[] = []) => deleteArgs(["--execute", ...extra]);
const refusedLines = (stdout: string) =>
  stdout.split("\n").filter((l) => l.startsWith("delete-old: refused "));

/** No raw name and no invented name in what a program printed: names are file paths. */
function expectNoName(text: string, label = "output") {
  for (const n of RAW_NAMES) expect(text, `${label} names ${n}`).not.toContain(n);
  expect(leaksAName(text), label).toBeNull();
}

/** Nothing under a raw name was deleted, and annex-uuid is untouched. */
function expectRawIntact(before: RawCopy[]) {
  expect(rawAsStored()).toEqual(before);
  expect(standin.versions(BUCKET, objectPath(UUID)).length).toBe(1);
}

let rawBefore: RawCopy[];

beforeAll(async () => {
  standin = startS3Standin();
  pub = startPublicEndpoint();
  // The raw copies and the special remote's marker are in the bucket before the plan, as on the
  // real bucket: a legacy import wrote them long before any scrub.
  for (const r of RAW) {
    for (const v of r.versions) {
      standin.putObject(
        BUCKET,
        objectPath(r.name),
        v.bytes,
        v.lock ? { lockUntil: centuryFromNow() } : {},
      );
    }
    if (r.marker) standin.putDeleteMarker(BUCKET, objectPath(r.name));
  }
  standin.putObject(BUCKET, objectPath(UUID), UUID_BYTES);
  const assembled = await buildAssembled(standin, [a, b, d]);
  built = assembled.dir;
  dir = built;
  const v = await runScrub(standin, verifyArgs(built));
  if (v.exitCode !== 0) throw new Error(`verify failed: ${v.all}`);
  // Runbook step 12: the manifest names the new keys; its older version is dropped here.
  const manifestKey = `${DATASET}/version/v1.0.0.json`;
  const original = standin.versions(BUCKET, manifestKey)[0]?.versionId as string;
  seedManifest(standin, "v1.0.0", [a, b, d], {}, DATASET, true);
  standin.dropVersion(BUCKET, manifestKey, original);
  writeProofs();
  writeGitVerified(built);
  // Runbook step 0: the blob list of the clone before the rewrite. Step 5b: raw-hash on the hash
  // host (the real program, through the real aws CLI) and raw-verify.
  writeBlobs(BLOBS);
  const hashed = await runHashStage(standin, rawHashArgs());
  if (hashed.exitCode !== 0) throw new Error(`raw-hash failed: ${hashed.all}`);
  const verified = await rawVerify();
  if (verified.exitCode !== 0) throw new Error(`raw-verify failed: ${verified.all}`);
  rawBefore = rawAsStored();
  snap = standin.snapshot();
}, SLOW);

afterAll(() => {
  standin?.stop();
  pub?.stop();
});

beforeEach(() => {
  standin.restore(snap);
  pub.reset();
  dir = copyDir(built);
});

describe("plan: raw copies", () => {
  test(
    "records every raw name with every version and marker, ignores annex-uuid, and says so in counts",
    async () => {
      const out = tempDir("raw-plan");
      const r = await runScrub(standin, ["plan", "--dataset", DATASET, "--out", out]);
      expect(r.exitCode, r.all).toBe(0);
      const plan = parsePlan(readFileSync(path.join(out, "plan.json"), "utf8"));
      // Exactly what the bucket holds, read from the stand-in itself: names sorted, each version
      // with its size, newest first, and each marker; the zero-byte folder key and the name that
      // is only a marker included.
      expect(plan.rawCopies).toEqual(rawBefore);
      expect(plan.rawCopies?.map((c) => c.name)).toEqual([...RAW_NAMES].sort());
      expect(plan.rawCopies?.find((c) => c.name === FOLDER)?.versions.map((v) => v.size)).toEqual([
        0,
      ]);
      expect(plan.rawCopies?.find((c) => c.name === REC2)?.versions.length).toBe(2);
      expect(plan.rawCopies?.find((c) => c.name === MARKED)).toMatchObject({
        versions: [],
        kind: "other",
      });
      expect(plan.rawCopies?.map((c) => c.name)).not.toContain(UUID);
      expect(plan.totals).toMatchObject({ rawCopyNames: 8, rawCopyVersions: 8, rawCopyMarkers: 3 });
      // The raw copies change nothing about the keys: the annex recordings under objects/ (the
      // three originals and, after the assembly, the two new keys), all read, as without them.
      expect(plan.keys.map((k) => k.oldKey).sort()).toEqual(
        [a.oldKey, b.oldKey, d.oldKey, a.newKey as string, b.newKey as string].sort(),
      );
      expect(plan.totals).toMatchObject({ keys: 5, needScrub: 2, unreadable: 0 });
      expect(r.stdout).toContain(
        "unreadable=0 rawCopies=8 versions=8 markers=3\nplan: raw copies under objects/ by kind: recording=2 other=6",
      );
      // Counts only: no raw name and no invented name on the terminal.
      expectNoName(r.all);
    },
    SLOW,
  );

  test(
    "after the deletion the screen from inside reads rawCopies=0 versions=0 markers=0",
    async () => {
      const del = await runScrub(standin, executeArgs());
      expect(del.exitCode, del.all).toBe(0);
      const post = path.join(dir, "post");
      const r = await runScrub(standin, ["plan", "--dataset", DATASET, "--out", post]);
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout.trim()).toMatch(
        /^plan: tags=1 keys=3 needScrub=0 bytesToHash=0 unreadable=0 rawCopies=0 versions=0 markers=0$/,
      );
      expect(Object.keys(readJson<Record<string, unknown>>(post, "plan.json"))).not.toContain(
        "rawCopies",
      );
      // annex-uuid stayed, and is still not a raw copy.
      expect(standin.current(BUCKET, objectPath(UUID))?.data).toEqual(UUID_BYTES);
    },
    SLOW,
  );
});

describe("raw-hash and raw-verify: every raw version is proven to be a duplicate", () => {
  test(
    "raw-hash records each version's sha256 and git blob id; raw-verify writes a bound proof",
    async () => {
      // The run in beforeAll, read back: one entry per version, by version id, digests computed
      // here from the bytes seeded.
      const hashes = parseRawHashes(readFileSync(path.join(dir, "raw-hashes.json"), "utf8"));
      expect(hashes.planSha256).toBe(fileSha256(dir, "plan.json"));
      const want = RAW.flatMap((r) => {
        const ids = standin
          .versions(BUCKET, objectPath(r.name))
          .filter((v) => !v.deleteMarker)
          .map((v) => v.versionId);
        return r.versions.map((v, i) => ({
          name: r.name,
          versionId: ids[i] as string,
          size: v.bytes.length,
          sha256: sha256(v.bytes),
          gitBlobSha1: gitBlob(v.bytes),
        }));
      });
      const key = (e: { name: string; versionId: string }) => `${e.name} ${e.versionId}`;
      expect([...hashes.entries].sort((x, y) => key(x).localeCompare(key(y)))).toEqual(
        want.sort((x, y) => key(x).localeCompare(key(y))),
      );
      // The empty blob is git's, byte for byte.
      expect(gitBlob(new Uint8Array(0))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");

      const r = await rawVerify();
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout.trim()).toBe(
        "raw-verify: ok names=8 versions=8 markers=3 matchedRecordings=3 matchedOther=5",
      );
      const proof = parseRawVerified(readFileSync(path.join(dir, "raw-verified.json"), "utf8"));
      expect(proof).toMatchObject({
        dataset: DATASET,
        planSha256: fileSha256(dir, "plan.json"),
        rawHashesSha256: fileSha256(dir, "raw-hashes.json"),
        gitBlobsSha256: fileSha256(dir, "git-blobs.txt"),
        counts: { names: 8, versions: 8, markers: 3, matchedRecordings: 3, matchedOther: 5 },
      });
      expect(statSync(path.join(dir, "raw-verified.json")).mode & 0o777).toBe(0o600);
      expect(has(dir, "raw-unmatched.json")).toBe(false);
      expectNoName(r.all);
      expect(JSON.stringify(proof)).not.toContain("sub-");
    },
    SLOW,
  );

  test(
    "a raw recording whose bytes are no annex key's fails, even with its git blob in the list",
    async () => {
      // One byte of REC1's only version, as stored: its sha256 now names no key of the plan.
      const v = standin.versions(BUCKET, objectPath(REC1)).find((x) => !x.deleteMarker);
      standin.corruptByte(BUCKET, objectPath(REC1), v?.versionId as string, 5000);
      rmSync(path.join(dir, "raw-hashes.json"));
      const hashed = await runHashStage(standin, rawHashArgs());
      expect(hashed.exitCode, hashed.all).toBe(0);
      // A recording is compared with the annex keys only: a blob id in the list does not pass it.
      const corrupted = standin.versions(BUCKET, objectPath(REC1)).find((x) => !x.deleteMarker);
      writeBlobs([...BLOBS, gitBlob(corrupted?.data as Uint8Array)].sort());
      const r = await rawVerify();
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("(raw-recording-unmatched=1)");
      expect(r.stdout).toContain("raw-verified.json NOT written");
      // The proof beforeAll wrote did not survive the failing run.
      expect(has(dir, "raw-verified.json")).toBe(false);
      // The name is in the private file, and only there.
      const unmatched = readJson<{ unmatched: Record<string, unknown> }>(dir, "raw-unmatched.json");
      expect(unmatched.unmatched).toEqual({
        "raw-recording-unmatched": [{ name: REC1, versionId: v?.versionId }],
      });
      expect(statSync(path.join(dir, "raw-unmatched.json")).mode & 0o777).toBe(0o600);
      expectNoName(`${r.all}\n${hashed.all}`);
    },
    SLOW,
  );

  test(
    "a raw text file whose blob is not in the history fails; one blob of the right bytes passes it",
    async () => {
      const tsv = RAW.find((r) => r.name === TSV)?.versions[0]?.bytes as Uint8Array;
      writeBlobs(BLOBS.filter((x) => x !== gitBlob(tsv)));
      const r = await rawVerify();
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("matchedRecordings=3 matchedOther=4 (raw-other-unmatched=1)");
      expect(
        Object.keys(readJson<{ unmatched: object }>(dir, "raw-unmatched.json").unmatched),
      ).toEqual(["raw-other-unmatched"]);
      expect(has(dir, "raw-verified.json")).toBe(false);
      expectNoName(r.all);
      // A text file is compared with the blob list only: its sha256 matching nothing is no failure,
      // so with the blob back the run passes and leaves no list of names behind.
      writeBlobs(BLOBS);
      const ok = await rawVerify();
      expect(ok.exitCode, ok.all).toBe(0);
      expect(has(dir, "raw-unmatched.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "a byte count that is not the plan's size is recorded as size-differs by raw-hash and fails raw-verify",
    async () => {
      // The plan says TSV's version is one byte longer than it is: raw-hash reads it and records
      // the failure word, never a digest of bytes that are not the version the plan describes.
      const plan = readJson<PlanFile>(dir, "plan.json");
      const tsv = plan.rawCopies?.find((c) => c.name === TSV) as RawCopy;
      (tsv.versions[0] as { size: number }).size += 1;
      writeJson(dir, "plan.json", plan);
      rmSync(path.join(dir, "raw-hashes.json"));
      const hashed = await runHashStage(standin, rawHashArgs());
      expect(hashed.exitCode, hashed.all).toBe(1);
      expect(hashed.stderr).toContain("failed by reason: size-differs=1");
      const entry = readJson<RawHashesFile>(dir, "raw-hashes.json").entries.find(
        (e) => e.name === TSV,
      );
      expect(entry).toEqual({ name: TSV, versionId: tsv.versions[0]?.id, failure: "size-differs" });
      const r = await rawVerify();
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("(raw-size-differs=1)");

      // A hand-edited entry that names another size is the same failure.
      standin.restore(snap);
      dir = copyDir(built);
      const hashes = readJson<RawHashesFile>(dir, "raw-hashes.json");
      const e = hashes.entries.find((x) => x.name === JSONF) as { size: number };
      e.size += 1;
      writeJson(dir, "raw-hashes.json", hashes);
      const edited = await rawVerify();
      expect(edited.exitCode, edited.all).toBe(1);
      expect(edited.stdout).toContain("(raw-size-differs=1)");
      expectNoName(`${hashed.all}\n${r.all}\n${edited.all}`);
    },
    SLOW,
  );

  test(
    "a version with no digest, and a digest of a version the plan does not record, both fail",
    async () => {
      const hashes = readJson<RawHashesFile>(dir, "raw-hashes.json");
      const dropped = { ...hashes, entries: hashes.entries.filter((e) => e.name !== NOTES) };
      writeJson(dir, "raw-hashes.json", dropped);
      const missing = await rawVerify();
      expect(missing.exitCode, missing.all).toBe(1);
      expect(missing.stdout).toContain("(raw-hash-missing=1)");

      const extra = {
        ...hashes,
        entries: [
          ...hashes.entries,
          {
            name: NOTES,
            versionId: "standin-v-not-recorded",
            size: 6,
            sha256: "0".repeat(64),
            gitBlobSha1: "0".repeat(40),
          },
        ],
      };
      writeJson(dir, "raw-hashes.json", extra);
      const notInPlan = await rawVerify();
      expect(notInPlan.exitCode, notInPlan.all).toBe(1);
      expect(notInPlan.stdout).toContain("(raw-hash-not-in-plan=1)");
      expect(has(dir, "raw-verified.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "refuses digests made for another plan or dataset, and a missing, unreadable or malformed input",
    async () => {
      const proofGone = () => expect(has(dir, "raw-verified.json")).toBe(false);
      // Another plan.json: one byte more is another file, so its versions are not these.
      const planPath = path.join(dir, "plan.json");
      const planText = readFileSync(planPath, "utf8");
      writeFileSync(planPath, `${planText}\n`);
      expectStopped(await rawVerify(), 3, "raw-hashes-stale");
      proofGone();
      writeFileSync(planPath, planText);

      const hashesText = readFileSync(path.join(dir, "raw-hashes.json"), "utf8");
      const hashes = JSON.parse(hashesText) as RawHashesFile;
      writeJson(dir, "raw-hashes.json", { ...hashes, dataset: "xx090999" });
      expectStopped(await rawVerify(), 3, "raw-hashes-wrong-dataset");
      writeJson(dir, "raw-hashes.json", { ...hashes, more: 1 });
      expectStopped(await rawVerify(), 3, "raw-hashes.json-invalid");
      rmSync(path.join(dir, "raw-hashes.json"));
      expectStopped(await rawVerify(), 3, "raw-hashes.json-missing");
      writeFileSync(path.join(dir, "raw-hashes.json"), hashesText);

      // The blob list: missing, there but unreadable (a failure, not absence), and malformed.
      const blobs = path.join(dir, "git-blobs.txt");
      rmSync(blobs);
      expectStopped(await rawVerify(), 3, "git-blobs-missing");
      writeBlobs(BLOBS);
      chmodSync(blobs, 0o000);
      try {
        expectStopped(await rawVerify(), 1, "git-blobs-unreadable");
      } finally {
        chmodSync(blobs, 0o600);
      }
      for (const text of [
        "",
        "\n",
        `${BLOBS[0]}\n\n${BLOBS[1]}\n`,
        `${"a".repeat(64)}\n`,
        `${gitBlob(new Uint8Array(0)).toUpperCase()}\n`,
        `${BLOBS[0]} blob\n`,
      ]) {
        writeFileSync(blobs, text);
        expectStopped(await rawVerify(), 3, "git-blobs-invalid", JSON.stringify(text));
      }
      // --git-blobs names another file, relative to the working directory.
      writeFileSync(path.join(dir, "other-blobs.txt"), `${BLOBS.join("\n")}\n`);
      const named = await rawVerify(["--git-blobs", "other-blobs.txt"]);
      expect(named.exitCode, named.all).toBe(0);
      expect(readJson<RawVerifiedFile>(dir, "raw-verified.json").gitBlobsSha256).toBe(
        fileSha256(dir, "other-blobs.txt"),
      );
    },
    SLOW,
  );

  test(
    "a plan without raw copies has nothing to prove and gets no proof",
    async () => {
      const plan = readJson<PlanFile>(dir, "plan.json");
      const { rawCopies: _, ...rest } = plan;
      const { rawCopyNames, rawCopyVersions, rawCopyMarkers, ...totals } = plan.totals;
      expect([rawCopyNames, rawCopyVersions, rawCopyMarkers]).toEqual([8, 8, 3]);
      writeJson(dir, "plan.json", { ...rest, totals });
      const r = await rawVerify();
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("no raw copies; nothing to verify, no proof written");
      expect(has(dir, "raw-verified.json")).toBe(false);
    },
    SLOW,
  );
});

describe("delete-old: raw copies", () => {
  test(
    "a dry run counts the raw copies, covers them in planRecorded, and deletes nothing",
    async () => {
      const r = await runScrub(standin, deleteArgs());
      expect(r.exitCode, r.all).toBe(0);
      // Two old keys of one version each, plus 8 raw versions and 3 raw markers.
      expect(r.stdout).toContain(
        "delete-old: keys=2 versions=2 markers=0 planRecorded=13 limit=13",
      );
      expect(r.stdout).toContain("delete-old: raw copies names=8 versions=8 markers=3");
      expect(r.stdout).toContain(
        "delete-old dry run: would delete raw copies versions=8 markers=3 across 8 names",
      );
      expect(deleteRequests(standin)).toBe(0);
      expectRawIntact(rawBefore);
      expectNoName(r.all);
    },
    SLOW,
  );

  test(
    "deletes every raw version with the bypass, then every raw marker, and leaves annex-uuid",
    async () => {
      const versions = new Set(rawVersionIds());
      const markers = new Set(rawMarkerIds());
      const r = await runScrub(standin, executeArgs());
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain(
        "delete-old: deleted raw copies versions=8 markers=3; zero versions and zero markers remain under the 8 raw names, and no object under objects/ but annex keys and annex-uuid",
      );
      // Nothing is left under any raw name, and the special remote's marker is as it was.
      for (const n of RAW_NAMES) expect(standin.versions(BUCKET, objectPath(n)), n).toEqual([]);
      expect(standin.versions(BUCKET, objectPath(UUID)).map((v) => v.data)).toEqual([UUID_BYTES]);

      // Every raw version went in a request with the bypass; every raw marker in a LATER request
      // that carried no version, so no marker went while a raw version could still be there.
      const requests = standin.calls("DeleteObjects").map((c, i) => ({ i, c }));
      const holding = (ids: Set<string>) =>
        requests.filter(({ c }) => c.items?.some((it) => ids.has(it.versionId as string)));
      const versionRequests = holding(versions);
      const markerRequests = holding(markers);
      expect(versionRequests.length).toBeGreaterThan(0);
      expect(markerRequests.length).toBeGreaterThan(0);
      for (const { c } of versionRequests) expect(c.bypass, "raw versions bypass").toBe(true);
      for (const { c } of markerRequests) {
        expect(c.bypass, "a marker needs no bypass").toBe(false);
        expect(c.items?.every((it) => markers.has(it.versionId as string))).toBe(true);
      }
      const lastVersion = Math.max(...versionRequests.map(({ i }) => i));
      expect(Math.min(...markerRequests.map(({ i }) => i))).toBeGreaterThan(lastVersion);
      const named = batchDeleted(standin).map((x) => x.versionId);
      expect(named.filter((id) => versions.has(id as string)).length).toBe(8);
      expect(named.filter((id) => markers.has(id as string)).length).toBe(3);

      const done = readJson<DeletedFile>(dir, "deleted.json");
      expect(done.counts).toEqual({
        keys: 2,
        versions: 2,
        markers: 0,
        prunedVersions: 0,
        prunedMarkers: 0,
        rawVersions: 8,
        rawMarkers: 3,
      });
      expect(JSON.stringify(done)).not.toContain("sub-");
      expectNoName(r.all);

      // A re-run finds nothing raw left and finishes, its proof counting what it removed: none.
      rmSync(path.join(dir, "deleted.json"));
      const again = await runScrub(standin, executeArgs());
      expect(again.exitCode, again.all).toBe(0);
      expect(again.stdout).toContain("delete-old: raw copies names=8 versions=0 markers=0");
      expect(readJson<DeletedFile>(dir, "deleted.json").counts).toMatchObject({
        rawVersions: 0,
        rawMarkers: 0,
      });
    },
    SLOW,
  );

  test(
    "locked raw text goes only with the bypass: without the permission it stays and nothing is claimed",
    async () => {
      // The operator lacks s3:BypassGovernanceRetention: the locked text is refused per item.
      standin.setDenyBypass(true);
      const r = await runScrub(standin, executeArgs());
      expect(r.exitCode, r.all).toBe(5);
      expect(r.stdout).toContain("DeleteObjects:access-denied");
      // The four locked text versions stay; the unlocked recordings, the folder key and every
      // marker went (markers are never locked, and no recording version is left under one).
      expect(r.stdout).toContain(
        "versions and markers remain: rawCopies=4 versions=4 markers=0 badKeys=0",
      );
      for (const n of [TSV, JSONF, APPLE, NOTES]) {
        expect(standin.versions(BUCKET, objectPath(n)).length, n).toBe(1);
      }
      for (const n of [REC1, REC2, FOLDER, MARKED]) {
        expect(standin.versions(BUCKET, objectPath(n)), n).toEqual([]);
      }
      expect(has(dir, "deleted.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "a raw marker over a raw recording that cannot go is kept, so the original never becomes current",
    async () => {
      const rec = standin.versions(BUCKET, objectPath(REC1)).find((v) => !v.deleteMarker);
      standin.setLock(
        BUCKET,
        objectPath(REC1),
        rec?.versionId as string,
        "GOVERNANCE",
        centuryFromNow(),
      );
      standin.setDenyBypass(true);
      const r = await runScrub(standin, executeArgs());
      expect(r.exitCode, r.all).toBe(5);
      // The original is still there, and still hidden by its marker.
      expect(standin.versions(BUCKET, objectPath(REC1)).map((v) => v.deleteMarker)).toEqual([
        false,
        true,
      ]);
      expect(standin.current(BUCKET, objectPath(REC1))).toBeUndefined();
      // REC2's versions went, so its marker went too.
      expect(standin.versions(BUCKET, objectPath(REC2))).toEqual([]);
      expect(has(dir, "deleted.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "--max-delete covers the raw versions and markers: the plan's count passes, one less refuses",
    async () => {
      const exact = await runScrub(standin, deleteArgs(["--max-delete", "13"]));
      expect(exact.exitCode, exact.all).toBe(0);
      const tight = await runScrub(standin, executeArgs(["--max-delete", "12"]));
      expectStopped(tight, 3, "over-max-delete");
      expect(refusedLines(tight.stdout)).toEqual([
        "delete-old: refused over-max-delete: versions+markers=13 over limit=12",
      ]);
      expect(deleteRequests(standin)).toBe(0);
      expectRawIntact(rawBefore);
    },
    SLOW,
  );

  test(
    "refuses without a raw proof for this plan, in the dry run too, and deletes nothing",
    async () => {
      const proofPath = path.join(dir, "raw-verified.json");
      const proof = readJson<RawVerifiedFile>(dir, "raw-verified.json");
      const cases: Array<[string, () => void, string]> = [
        ["missing", () => rmSync(proofPath), "raw-verified.json missing"],
        [
          "invalid",
          () => writeJson(dir, "raw-verified.json", { ...proof, more: 1 }),
          "raw-verified.json invalid",
        ],
        [
          "another plan",
          () => writeJson(dir, "raw-verified.json", { ...proof, planSha256: "0".repeat(64) }),
          "for another plan.json",
        ],
        [
          "another dataset",
          () => writeJson(dir, "raw-verified.json", { ...proof, dataset: "xx090999" }),
          "for another dataset",
        ],
        [
          "other counts",
          () =>
            writeJson(dir, "raw-verified.json", {
              ...proof,
              counts: { ...proof.counts, versions: 7, matchedOther: 4 },
            }),
          "counts names=8 versions=7 markers=3, the plan has names=8 versions=8 markers=3",
        ],
      ];
      for (const [label, damage, detail] of cases) {
        writeJson(dir, "raw-verified.json", proof);
        damage();
        for (const flag of [[], ["--execute"]]) {
          const r = await runScrub(standin, deleteArgs(flag));
          expectStopped(r, 3, "raw-copies-unverified", `${label} ${flag.join("")}`);
          expect(refusedLines(r.stdout), label).toEqual([
            `delete-old: refused raw-copies-unverified: ${detail}`,
          ]);
        }
      }
      expect(deleteRequests(standin)).toBe(0);
      expectRawIntact(rawBefore);
      expect(has(dir, "deleted.json")).toBe(false);

      // A proof that is there and cannot be read is a failure, not a missing proof.
      writeJson(dir, "raw-verified.json", proof);
      chmodSync(proofPath, 0o000);
      try {
        expectStopped(await runScrub(standin, deleteArgs()), 1, "raw-verified.json-unreadable");
      } finally {
        chmodSync(proofPath, 0o600);
      }
    },
    SLOW,
  );

  test(
    "refuses any raw version, marker or name the plan did not record, and a raw recording as unplanned",
    async () => {
      const refused = async (word: string, label: string) => {
        for (const flag of [[], ["--execute"]]) {
          const r = await runScrub(standin, deleteArgs(flag));
          expectStopped(r, 3, word, label);
          expectNoName(r.all, label);
        }
        expect(deleteRequests(standin), label).toBe(0);
      };
      // A new version under a raw name the plan recorded.
      standin.putObject(BUCKET, objectPath(TSV), enc("participant_id\n"), {
        lockUntil: centuryFromNow(),
      });
      await refused("raw-copy-not-in-plan", "a new version");
      const r = await runScrub(standin, deleteArgs());
      expect(refusedLines(r.stdout)).toEqual([
        "delete-old: refused raw-copy-not-in-plan: 1 versions or markers of raw copies under objects/ are not in the plan",
      ]);
      // A new delete marker on one.
      standin.restore(snap);
      standin.putDeleteMarker(BUCKET, objectPath(NOTES));
      await refused("raw-copy-not-in-plan", "a new marker");
      // A raw name the plan never listed, a zero-byte folder key included.
      standin.restore(snap);
      standin.putObject(BUCKET, objectPath("sub-03/sub-03_scans.tsv"), enc("filename\n"));
      await refused("raw-copy-not-in-plan", "a new name");
      standin.restore(snap);
      standin.putObject(BUCKET, objectPath("derivatives/"), new Uint8Array(0));
      await refused("raw-copy-not-in-plan", "a new folder key");
      // A raw RECORDING the plan never listed is a recording nobody read: unplanned-recording.
      standin.restore(snap);
      standin.putObject(BUCKET, objectPath("sub-03/eeg/sub-03_eeg.edf"), a.bytes);
      await refused("unplanned-recording", "a new raw recording");
      // A name in the annex key space that is not a key is where the plan would have stopped.
      standin.restore(snap);
      standin.putObject(BUCKET, objectPath(`SHA256E-s1--${"z".repeat(64)}.json`), enc("x"));
      await refused("objects-bad-key", "a bad key");
      // A second version of annex-uuid is still the special remote's, not a raw copy.
      standin.restore(snap);
      standin.putObject(BUCKET, objectPath(UUID), UUID_BYTES);
      const ok = await runScrub(standin, deleteArgs());
      expect(ok.exitCode, ok.all).toBe(0);

      // A recorded version id whose listed size is not the size recorded is not that version: no
      // S3 version changes size, so only a plan edited after the fact gets here, and the proofs
      // are rebound to that plan so this check is the one that answers.
      standin.restore(snap);
      const plan = readJson<PlanFile>(dir, "plan.json");
      const tsv = plan.rawCopies?.find((c) => c.name === TSV) as RawCopy;
      (tsv.versions[0] as { size: number }).size += 1;
      writeJson(dir, "plan.json", plan);
      writeGitVerified(dir);
      writeJson(dir, "raw-verified.json", {
        ...readJson<RawVerifiedFile>(dir, "raw-verified.json"),
        planSha256: fileSha256(dir, "plan.json"),
      });
      await refused("raw-copy-not-in-plan", "a version of another size");
    },
    SLOW,
  );

  test(
    "every refusal at once: the raw proof and a raw name beside the archives, in a fixed order",
    async () => {
      standin.putObject(
        BUCKET,
        `${DATASET}/archives/${DATASET}_v1.0.0.zip`,
        new TextEncoder().encode("zip"),
      );
      rmSync(path.join(dir, "raw-verified.json"));
      standin.putObject(BUCKET, objectPath("late.tsv"), enc("x\n"));
      const words = "archives-not-dropped+raw-copies-unverified+raw-copy-not-in-plan";
      for (const flag of [[], ["--execute"]]) {
        const r = await runScrub(standin, deleteArgs(flag));
        expectStopped(r, 3, words);
        expect(refusedLines(r.stdout)).toEqual([
          "delete-old: refused archives-not-dropped: versions and markers=1 under archives/",
          "delete-old: refused raw-copies-unverified: raw-verified.json missing",
          "delete-old: refused raw-copy-not-in-plan: 1 versions or markers of raw copies under objects/ are not in the plan",
        ]);
        expect(r.stdout).toContain("delete-old: raw copies names=8 versions=8 markers=3");
      }
      expect(deleteRequests(standin)).toBe(0);
    },
    SLOW,
  );

  test(
    "a raw object that appears during the run is found by the final listing: exit 5, no deleted.json",
    async () => {
      standin.beforeOp("DeleteObjects", () => {
        standin.putObject(BUCKET, objectPath("sub-04/late_events.tsv"), enc("onset\n"));
      });
      const r = await runScrub(standin, executeArgs());
      expect(r.exitCode, r.all).toBe(5);
      expect(r.stdout).toContain(
        "versions and markers remain: rawCopies=1 versions=1 markers=0 badKeys=0",
      );
      expect(r.stdout).toContain("deleted.json NOT written");
      expect(has(dir, "deleted.json")).toBe(false);
      // Everything the plan recorded did go.
      for (const n of RAW_NAMES) expect(standin.versions(BUCKET, objectPath(n)), n).toEqual([]);
    },
    SLOW,
  );
});

describe("the recording a raw copy duplicates", () => {
  test(
    "a fixture check: each raw recording's bytes are an annex key's, so the proof is about bytes",
    () => {
      // If a fixture change made a raw recording differ from every key, the passing tests above
      // would prove nothing about the match rule; this keeps the premise visible.
      const keys = new Set([a, b, d].map((f) => f.oldKey.split("--")[1]?.split(".")[0]));
      for (const r of RAW.filter((x) => /\.(edf|bdf)$/i.test(x.name))) {
        for (const v of r.versions) expect(keys.has(sha256(v.bytes)), r.name).toBe(true);
      }
      // And a recording that is not one of them hashes to no key.
      const other = makeFixture(
        "Z",
        ".edf",
        "x.edf",
        edfFile(edfHeader({ patient: NAMES[0] as string, recording: "x" }), 4096, 7),
        null,
      );
      expect(keys.has(sha256(other.bytes))).toBe(false);
    },
    SLOW,
  );
});
