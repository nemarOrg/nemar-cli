/**
 * The delete-old stage, run as the real CLI against the S3 stand-in. It is the one irreversible
 * stage, so most of what is tested here is the ways it must refuse, and that when it does run it
 * removes every version AND delete marker by id with the governance bypass, leaves the new keys
 * alone, and proves the result with a fresh listing.
 *
 * One dataset is carried through plan, hash, assemble and verify once. Each test restores that
 * state and a pristine working directory.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type AssembledFile,
  type PlanFile,
  type ZarrPlanFile,
  type ZarrVerifiedFile,
  parseKey,
} from "../../../scripts/scrub/contract";
import { AwsCliError, StageError, deleteVersion } from "../../../scripts/scrub/s3/s3-lib";
import {
  DEFAULT_PUBLIC_BASE,
  type DeletedFile,
  TEST_LOOPBACK_PUBLIC_BASE_ENV,
  checkPublicBase,
} from "../../../scripts/scrub/s3/s3-stages";
import { type S3Standin, type Snapshot, startS3Standin } from "../helpers/s3-standin";
import { expectStopped, expectUsage } from "./refusal";
import {
  type Assembled,
  BUCKET,
  DATASET,
  type PublicEndpoint,
  SLOW,
  addUnreadableKey,
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
  makeFixture,
  objectPath,
  readJson,
  removeTempDirs,
  runScrub,
  seedManifest,
  sha256,
  startPublicEndpoint,
  verifyArgs,
  withCtx,
  writeGitVerified,
  writeJson,
} from "./support";

afterAll(removeTempDirs);

let standin: S3Standin;
let pub: PublicEndpoint;
let snap: Snapshot;
let built: Assembled;
let dir: string;

const [a, b, d] = [fixtureA(), fixtureB(), fixtureD()];

/** Every version id, and delete marker, of one old key as seeded. */
let oldIds: Record<string, string[]>;

const assembledSha = () => sha256(readFileSync(path.join(dir, "assembled.json")));

/** Write both proofs for the assembled.json in `dir` as it is now. */
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

/**
 * The proof the `zarr` stage leaves, made by the REAL stage over whatever Zarr objects the test
 * put in the stand-in, so the binding it checks is the binding the stage writes. `over` then
 * replaces fields of the proof, to make it stale.
 */
async function proveZarr(over: Partial<ZarrVerifiedFile> = {}) {
  const r = await runScrub(standin, ["zarr", "--dir", dir, "--execute"]);
  if (r.exitCode !== 0) throw new Error(`the zarr stage failed: ${r.all}`);
  if (Object.keys(over).length > 0) {
    writeJson(dir, "zarr-verified.json", {
      ...readJson<ZarrVerifiedFile>(dir, "zarr-verified.json"),
      ...over,
    });
  }
}

/** A store root with an identifier key in it: the zarr stage rewrites it before it proves it. */
const dirtyStore = JSON.stringify({
  zarr_format: 3,
  node_type: "group",
  attributes: { recording_metadata: { patientcode: "P0042", startdate: "02.02.20" } },
});
const cleanStore = JSON.stringify({
  zarr_format: 3,
  node_type: "group",
  attributes: { recording_metadata: { startdate: "02.02.20" } },
});

const deleteArgs = (extra: string[] = [], publicBase: string = pub.url) => [
  "delete-old",
  "--dir",
  dir,
  "--confirm-dataset",
  DATASET,
  "--public-base",
  publicBase,
  "--concurrency",
  "8",
  ...extra,
];
const executeArgs = (extra: string[] = []) => deleteArgs(["--execute", ...extra]);

const versionIdsOf = (key: string) =>
  standin.versions(BUCKET, objectPath(key)).map((v) => v.versionId);

/** The new key the privacy probe asks about: the first of the assembled new keys, sorted. */
const firstNewKey = () => [a.newKey as string, b.newKey as string].sort()[0] as string;

/** Nothing was deleted: every old version and marker is still there. */
function expectOldIntact() {
  expect(deleteRequests(standin)).toBe(0);
  for (const f of [a, b]) {
    expect(versionIdsOf(f.oldKey).sort()).toEqual([...(oldIds[f.oldKey] as string[])].sort());
  }
}

beforeAll(async () => {
  standin = startS3Standin();
  pub = startPublicEndpoint();
  built = await buildAssembled(standin, [a, b, d], {
    // Older versions and a delete marker: more than one thing to delete per key.
    A: { olderVersions: 2, marker: true },
    B: { marker: true },
  });
  oldIds = {
    [a.oldKey]: versionIdsOf(a.oldKey),
    [b.oldKey]: versionIdsOf(b.oldKey),
  };
  const v = await runScrub(standin, verifyArgs(built.dir));
  if (v.exitCode !== 0) throw new Error(`verify failed: ${v.all}`);
  // Runbook step 12 has run: the manifest now names each scrubbed file by its new key. Its older
  // version (naming the old keys) is dropped here so the shared state has no history; the tests of
  // history put it back on purpose.
  const manifestKey = `${DATASET}/version/v1.0.0.json`;
  const original = standin.versions(BUCKET, manifestKey)[0]?.versionId as string;
  seedManifest(standin, "v1.0.0", [a, b, d], {}, DATASET, true);
  standin.dropVersion(BUCKET, manifestKey, original);
  const sha = sha256(readFileSync(path.join(built.dir, "assembled.json")));
  writeJson(built.dir, "new-hash-verified.json", {
    version: 1,
    dataset: DATASET,
    assembledSha256: sha,
    count: 2,
  });
  // Runbook step 14 has run: a fresh clone of the pushed repository verified.
  writeGitVerified(built.dir);
  snap = standin.snapshot();
}, SLOW);

afterAll(() => {
  standin?.stop();
  pub?.stop();
});

beforeEach(() => {
  standin.restore(snap);
  pub.reset();
  dir = copyDir(built.dir);
});

describe("delete-old: refusals", () => {
  test(
    "refuses unless both proofs exist",
    async () => {
      rmSync(path.join(dir, "verified.json"));
      const noVerified = await runScrub(standin, executeArgs());
      expectStopped(noVerified, 3, "verified.json-missing");
      expectOldIntact();

      writeProofs();
      rmSync(path.join(dir, "new-hash-verified.json"));
      const noHash = await runScrub(standin, executeArgs());
      expectStopped(noHash, 3, "new-hash-verified.json-missing");
      expectOldIntact();
      expect(has(dir, "deleted.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "refuses a proof that vouches for other bytes than the current assembled.json",
    async () => {
      // One byte of whitespace changes the file; both proofs now describe a different file, and
      // both are reported.
      writeFileSync(
        path.join(dir, "assembled.json"),
        `${readFileSync(path.join(dir, "assembled.json"), "utf8")}\n`,
      );
      const stale = await runScrub(standin, executeArgs());
      expectStopped(stale, 3, "verified-stale+new-hash-verified-stale");
      expectOldIntact();

      // The re-hash proof current, verified.json alone stale.
      writeProofs();
      const staleVerified = readJson<{ assembledSha256: string }>(dir, "verified.json");
      staleVerified.assembledSha256 = "0".repeat(64);
      writeJson(dir, "verified.json", staleVerified);
      expectStopped(await runScrub(standin, executeArgs()), 3, "verified-stale", "verified alone");

      // verified.json current, the re-hash proof stale.
      writeProofs();
      const hv = readJson<{ assembledSha256: string }>(dir, "new-hash-verified.json");
      hv.assembledSha256 = "0".repeat(64);
      writeJson(dir, "new-hash-verified.json", hv);
      const staleHash = await runScrub(standin, executeArgs());
      expectStopped(staleHash, 3, "new-hash-verified-stale");

      // Right bytes, wrong dataset; right bytes, wrong count.
      writeProofs();
      const wrongDataset = readJson<Record<string, unknown>>(dir, "verified.json");
      wrongDataset.dataset = "xx090999";
      writeJson(dir, "verified.json", wrongDataset);
      const dataset = await runScrub(standin, executeArgs());
      expectStopped(dataset, 3, "proof-wrong-dataset");

      writeProofs(5);
      const count = await runScrub(standin, executeArgs());
      expectStopped(count, 3, "proof-count-mismatch");
      expectOldIntact();
    },
    SLOW,
  );

  test(
    "refuses a plan with a key nobody read, even when its totals agree, in both modes",
    async () => {
      writeProofs();
      addUnreadableKey(dir);
      for (const flag of [[], ["--execute"]]) {
        expectStopped(await runScrub(standin, deleteArgs(flag)), 3, "plan-has-unreadable");
      }
      expect(standin.log.length).toBe(0);
      expectOldIntact();
      expect(has(dir, "deleted.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "refuses when more would be deleted than --max-delete allows",
    async () => {
      writeProofs();
      const tight = await runScrub(standin, executeArgs(["--max-delete", "3"]));
      expectStopped(tight, 3, "over-max-delete");
      expectOldIntact();
      expect(has(dir, "deleted.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "a version written to an old key after the plan is refused, and no --max-delete waives it",
    async () => {
      writeProofs();
      // A version appeared on an old key after the plan recorded its ids: bytes nobody read.
      const extra = standin.putObject(BUCKET, objectPath(a.oldKey), a.bytes, {
        lockUntil: centuryFromNow(),
      });
      // The plan recorded the ids of the two keys being replaced (D, the clean file, is not one).
      const recorded = readJson<PlanFile>(dir, "plan.json")
        .keys.filter((k) => k.oldKey === a.oldKey || k.oldKey === b.oldKey)
        .reduce((n, k) => n + k.versionIds.length, 0);
      expect(recorded).toBe(6);
      // The extra version also takes the count past the plan's own, so the cap refuses as well.
      const both = "version-not-in-plan+over-max-delete";
      for (const flag of [[], ["--execute"]]) {
        expectStopped(await runScrub(standin, deleteArgs(flag)), 3, both);
        // Naming a larger number used to be the way past this; it is only a cap now.
        const raised = await runScrub(
          standin,
          deleteArgs([...flag, "--max-delete", String(recorded + 100)]),
        );
        expectStopped(raised, 3, both, "with --max-delete raised");
        expect(raised.stdout).toContain("1 versions or markers of old keys are not in the plan");
        expect(raised.stdout).toContain("refused over-max-delete: versions+markers=7 over limit=6");
      }
      expect(deleteRequests(standin)).toBe(0);
      expect(versionIdsOf(a.oldKey)).toContain(extra);

      // Swapping a recorded id for an unrecorded one keeps the count and is refused all the same.
      standin.restore(snap);
      const plan = readJson<PlanFile>(dir, "plan.json");
      const entry = plan.keys.find((k) => k.oldKey === a.oldKey) as PlanFile["keys"][number];
      entry.versionIds = [...entry.versionIds.slice(1), "standin-v-not-a-real-id"];
      writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
      writeGitVerified(dir); // the git proof names the plan's bytes
      expectStopped(await runScrub(standin, deleteArgs()), 3, "version-not-in-plan", "swapped");
      expectOldIntact();
    },
    SLOW,
  );

  test(
    "refuses an assembly in which an old key is, or becomes, a new key",
    async () => {
      const full = readJson<AssembledFile>(dir, "assembled.json");
      const withEntries = (mutate: (e: AssembledFile["entries"]) => void, count = 2) => {
        const copy = structuredClone(full);
        mutate(copy.entries);
        writeJson(dir, "assembled.json", copy);
        writeProofs(count);
      };
      const entryOf = (newKey: string) => ({
        ...(full.entries[a.oldKey] as AssembledFile["entries"][string]),
        newKey,
      });

      // An entry whose replacement is itself, or another entry's original of another size: the
      // contract refuses both before the stage looks at the set.
      withEntries((e) => {
        (e[a.oldKey] as { newKey: string }).newKey = a.oldKey;
      });
      expectStopped(await runScrub(standin, executeArgs()), 3, "assembled.json-invalid");
      withEntries((e) => {
        (e[a.oldKey] as { newKey: string }).newKey = b.oldKey;
      });
      expectStopped(await runScrub(standin, executeArgs()), 3, "assembled.json-invalid");

      // Keys of one size and extension, so each entry is well formed and only the set is wrong.
      // The two added entries are also outside the plan and the keymap, which is reported too.
      const k = (c: string) => `SHA256E-s500--${c.repeat(64)}.edf`;
      // One entry's replacement is another entry's original.
      withEntries((e) => {
        e[k("1")] = entryOf(k("2"));
        e[k("2")] = entryOf(k("3"));
      }, 4);
      const chained = await runScrub(standin, executeArgs());
      expectStopped(chained, 3, "old-key-is-a-new-key+assembled-not-in-plan+keymap-mismatch");

      // Two originals share one replacement.
      withEntries((e) => {
        e[k("1")] = entryOf(k("3"));
        e[k("2")] = entryOf(k("3"));
      }, 4);
      const shared = await runScrub(standin, executeArgs());
      expectStopped(shared, 3, "duplicate-new-key+assembled-not-in-plan+keymap-mismatch");
      expectOldIntact();
    },
    SLOW,
  );

  test(
    "refuses an entry that names no new version, in both modes, before any S3 call",
    async () => {
      // Reviewer probe T4: without a version id the HEAD would check whatever is current.
      const copy = readJson<AssembledFile>(dir, "assembled.json");
      (copy.entries[a.oldKey] as { newVersionId?: string }).newVersionId = undefined;
      writeJson(dir, "assembled.json", copy);
      writeProofs();
      for (const flag of [[], ["--execute"]]) {
        expectStopped(await runScrub(standin, deleteArgs(flag)), 3, "assembled.json-invalid");
      }
      expect(standin.log.length).toBe(0);
      expectOldIntact();
    },
    SLOW,
  );

  test(
    "refuses when a replacement object is no longer there",
    async () => {
      writeProofs();
      const entry = (
        readJson<AssembledFile>(dir, "assembled.json").entries[a.oldKey] as {
          newVersionId: string;
        }
      ).newVersionId;
      standin.dropVersion(BUCKET, objectPath(a.newKey as string), entry);
      const r = await runScrub(standin, executeArgs());
      expectStopped(r, 3, "new-object-missing");
      expectOldIntact();
    },
    SLOW,
  );

  test(
    "refuses a key outside the plan, and a prune prefix that is not a dataset's own",
    async () => {
      writeProofs();
      const planPath = path.join(dir, "plan.json");
      const plan = readJson<PlanFile>(dir, "plan.json");
      const entry = plan.keys.find((k) => k.oldKey === a.oldKey) as PlanFile["keys"][number];
      // The plan's totals must keep agreeing with its keys, or the plan is refused on its own
      // account and the guard under test is never reached.
      const setNeedsScrub = (on: boolean) => {
        entry.needsScrub = on;
        plan.totals.needScrub = plan.keys.filter((k) => k.needsScrub).length;
        plan.totals.bytesToHash = plan.keys
          .filter((k) => k.needsScrub)
          .reduce((n, k) => n + k.size, 0);
        writeFileSync(planPath, JSON.stringify(plan));
        writeGitVerified(dir); // the git proof names the plan's bytes
      };
      setNeedsScrub(false);
      const notPlanned = await runScrub(standin, executeArgs());
      expectStopped(notPlanned, 3, "assembled-not-in-plan");

      setNeedsScrub(true);
      for (const prefix of [
        `${DATASET}/objects/`,
        // The dataset root covers objects/, and an empty segment is not a safe spelling of it.
        `${DATASET}/`,
        `${DATASET}//objects/`,
        `${DATASET}//`,
        "xx090999/version/",
        `${DATASET}/version`,
        `${DATASET}/../x/`,
      ]) {
        const r = await runScrub(standin, executeArgs(["--prune-noncurrent", prefix]));
        expectStopped(r, 3, "bad-prune-prefix");
      }
      expectOldIntact();
    },
    SLOW,
  );
});

describe("delete-old: deleting", () => {
  test(
    "the stand-in enforces the lock, so a delete without the bypass is refused",
    async () => {
      // This is what makes the tests below meaningful: if the stand-in let this through, a
      // stage that forgot the bypass header would pass them all.
      const id = (oldIds[b.oldKey] as string[])[1] as string;
      let refused: unknown;
      await withCtx(standin, (ctx) =>
        deleteVersion(ctx, objectPath(b.oldKey), id, false).catch((e) => {
          refused = e;
        }),
      );
      expect(refused).toBeInstanceOf(AwsCliError);
      expect((refused as AwsCliError).code).toBe("access-denied");
      expect(versionIdsOf(b.oldKey)).toContain(id);
    },
    SLOW,
  );

  test(
    "a dry run reports what it would delete and deletes nothing",
    async () => {
      writeProofs();
      const r = await runScrub(standin, deleteArgs());
      expect(r.exitCode, r.all).toBe(0);
      // A: two older versions and the current one, plus a marker. B: current plus a marker.
      expect(r.stdout).toContain("keys=2 versions=4 markers=2");
      expect(r.stdout).toContain("would delete versions=4 markers=2 across 2 keys");
      expectOldIntact();
      expect(has(dir, "deleted.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "a git proof that names an allowed tag is a proof like any other",
    async () => {
      // `git-scrub verify --fresh-clone --allow-tag` records the names; the stage that reads the
      // proof binds it by hash and mode and asks nothing of the field.
      writeProofs();
      writeGitVerified(dir, { allowedTags: ["v1.1.1"] });
      const r = await runScrub(standin, deleteArgs());
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("would delete versions=4 markers=2 across 2 keys");
      expect(r.stdout).not.toContain("git-proof");
      expectOldIntact();
    },
    SLOW,
  );

  test(
    "removes every version and delete marker by id with the bypass, leaves the new keys alone",
    async () => {
      writeProofs();
      const newBefore = [a, b].map((f) => ({
        key: f.newKey as string,
        versions: standin.versions(BUCKET, objectPath(f.newKey as string)).map((v) => v.versionId),
        data: sha256(
          (standin.current(BUCKET, objectPath(f.newKey as string)) as { data: Uint8Array }).data,
        ),
      }));
      const cleanBefore = versionIdsOf(d.oldKey);

      const r = await runScrub(standin, executeArgs());
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("zero versions and zero markers remain for 2 keys");

      // Every old version and marker is gone, authoritatively: nothing under either old key.
      for (const f of [a, b]) {
        expect(standin.versions(BUCKET, objectPath(f.oldKey)).length, f.label).toBe(0);
      }
      // Each version was named by id in a batch that carried the bypass; none was a bare delete,
      // and the six went in ONE request (no single-object delete at all).
      const deletes = batchDeleted(standin);
      expect(deletes.length).toBe(6);
      expect(standin.calls("DeleteObjects").length).toBe(1);
      expect(standin.calls("DeleteObject").length).toBe(0);
      for (const del of deletes) {
        expect(del.versionId, "version id").toBeTruthy();
        expect(del.bypass, "bypass header").toBe(true);
      }
      // Counts only on the progress line: no key, no version id anywhere in what it printed.
      expect(r.stdout).toContain("delete-old: deleted 6 of 6 in this group");
      expect(r.stdout).not.toContain("SHA256E");
      for (const del of deletes) expect(r.stdout).not.toContain(del.versionId as string);
      const deletedIds = deletes.map((x) => x.versionId).sort();
      expect(deletedIds).toEqual(
        [...(oldIds[a.oldKey] as string[]), ...(oldIds[b.oldKey] as string[])].sort(),
      );

      // The new keys and the untouched clean file are exactly as they were.
      for (const n of newBefore) {
        const at = objectPath(n.key);
        expect(standin.versions(BUCKET, at).map((v) => v.versionId)).toEqual(n.versions);
        expect(sha256((standin.current(BUCKET, at) as { data: Uint8Array }).data)).toBe(n.data);
        expect(parseKey(n.key).size).toBeGreaterThan(0);
      }
      expect(versionIdsOf(d.oldKey)).toEqual(cleanBefore);

      const done = readJson<DeletedFile>(dir, "deleted.json");
      expect(done.counts).toEqual({
        keys: 2,
        versions: 4,
        markers: 2,
        prunedVersions: 0,
        prunedMarkers: 0,
      });
      expect(done.assembledSha256).toBe(assembledSha());
      // Counts only: no key and no name in the record of what was done.
      expect(JSON.stringify(done)).not.toContain("SHA256E");
    },
    SLOW,
  );

  test(
    "a version that appears while deleting is found by the final listing and fails the stage",
    async () => {
      writeProofs();
      let newcomer = "";
      standin.beforeOp("DeleteObjects", () => {
        // A writer re-adds the original to B just as the deletes begin.
        newcomer = standin.putObject(BUCKET, objectPath(b.oldKey), b.bytes, {
          lockUntil: centuryFromNow(),
        });
      });
      const r = await runScrub(standin, executeArgs());
      expect(r.exitCode, r.all).toBe(5);
      expect(r.stdout).toContain("versions and markers remain: oldKeys=1");
      expect(has(dir, "deleted.json")).toBe(false);
      expect(versionIdsOf(b.oldKey)).toEqual([newcomer]);
      expect(standin.versions(BUCKET, objectPath(a.oldKey)).length).toBe(0);
    },
    SLOW,
  );

  test(
    "a delete the operator may not make is not reported as done",
    async () => {
      writeProofs();
      // The operator lacks s3:BypassGovernanceRetention: S3 refuses the bypass header too.
      standin.setDenyBypass(true);
      const r = await runScrub(standin, executeArgs());
      expect(r.exitCode, r.all).toBe(5);
      expect(r.stdout).toContain("DeleteObjects:access-denied");
      expect(has(dir, "deleted.json")).toBe(false);
      // Delete markers are not locked, so those went; the locked versions stayed.
      for (const f of [a, b]) {
        expect(standin.versions(BUCKET, objectPath(f.oldKey)).every((v) => !v.deleteMarker)).toBe(
          true,
        );
        expect(standin.versions(BUCKET, objectPath(f.oldKey)).length).toBeGreaterThan(0);
      }
    },
    SLOW,
  );
});

describe("delete-old: pruning noncurrent versions", () => {
  const manifest = `${DATASET}/version/v1.0.0.json`;
  const zarrJson = `${DATASET}/zarr/sub-01/x.zarr/zarr.json`;
  const body = (s: string) => new TextEncoder().encode(s);
  /** A manifest that names no EDF file: the preflight reads the current one, so it must parse. */
  const manifestBody = () =>
    body(JSON.stringify({ dataset_id: DATASET, version: "v1.0.0", files: {} }));

  test(
    "deletes only noncurrent versions and markers, by id, without the bypass; never a current one",
    async () => {
      writeProofs();
      // Manifest: seeded, regenerated, then one more version and a marker below the newest.
      standin.putObject(BUCKET, manifest, manifestBody());
      standin.putDeleteMarker(BUCKET, manifest);
      standin.putObject(BUCKET, manifest, manifestBody());
      // A Zarr store root: an older version and a current one, which the zarr stage has proven.
      standin.putObject(BUCKET, zarrJson, body("an older zarr.json"));
      standin.putObject(BUCKET, zarrJson, body(cleanStore));
      await proveZarr();
      const currentManifest = standin.current(BUCKET, manifest)?.versionId as string;
      const currentZarr = standin.current(BUCKET, zarrJson)?.versionId as string;

      const r = await runScrub(
        standin,
        executeArgs([
          "--prune-noncurrent",
          `${DATASET}/version/`,
          "--prune-noncurrent",
          `${DATASET}/zarr/`,
        ]),
      );
      expect(r.exitCode, r.all).toBe(0);
      // Manifest: the regenerated version and one more below the newest, and a marker; Zarr: one.
      expect(r.stdout).toContain("prune noncurrent versions=3 markers=1");

      expect(standin.versions(BUCKET, manifest).map((v) => v.versionId)).toEqual([currentManifest]);
      expect(standin.versions(BUCKET, zarrJson).map((v) => v.versionId)).toEqual([currentZarr]);
      expect(standin.current(BUCKET, manifest)?.deleteMarker).toBe(false);

      // The pruning deletes are by id and never carry the bypass.
      const prunes = batchDeleted(standin).filter((x) => !x.key.startsWith(`${DATASET}/objects/`));
      expect(prunes.length).toBe(4);
      for (const p of prunes) {
        expect(p.versionId).toBeTruthy();
        expect(p.bypass).toBe(false);
      }
      const done = readJson<DeletedFile>(dir, "deleted.json");
      expect(done.counts.prunedVersions).toBe(3);
      expect(done.counts.prunedMarkers).toBe(1);
      expect(r.stdout).toContain("no history under archives/, version/, zarr/");
    },
    SLOW,
  );

  test(
    "never forces a lock: a locked noncurrent version stays and the stage fails",
    async () => {
      writeProofs();
      standin.putObject(BUCKET, zarrJson, body("locked"), { lockUntil: centuryFromNow() });
      standin.putObject(BUCKET, zarrJson, body(cleanStore));
      await proveZarr();
      const r = await runScrub(standin, executeArgs(["--prune-noncurrent", `${DATASET}/zarr/`]));
      expect(r.exitCode, r.all).toBe(5);
      expect(r.stdout).toContain("DeleteObjects:access-denied");
      expect(standin.versions(BUCKET, zarrJson).length).toBe(2);
      expect(has(dir, "deleted.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "refuses history it was not told to prune, before the first delete, and counts it per prefix",
    async () => {
      writeProofs();
      // Probe T3's shape: the manifests were regenerated and the Zarr roots rewritten, so both
      // prefixes hold old versions naming old keys and old metadata.
      standin.putObject(BUCKET, manifest, manifestBody());
      standin.putObject(BUCKET, manifest, manifestBody());
      standin.putObject(BUCKET, zarrJson, body(dirtyStore));
      await proveZarr();
      for (const flag of [[], ["--execute"]]) {
        const none = await runScrub(standin, deleteArgs(flag));
        expectStopped(none, 3, "history-remains");
        expect(none.stdout).toContain(
          "refused history-remains: version=2 zarr=1 not named by --prune-noncurrent",
        );
        const half = await runScrub(
          standin,
          deleteArgs([...flag, "--prune-noncurrent", `${DATASET}/version/`]),
        );
        expectStopped(half, 3, "history-remains", "version/ only");
        expect(half.stdout).toContain(
          "refused history-remains: zarr=1 not named by --prune-noncurrent",
        );
      }
      expectOldIntact();
      expect(has(dir, "deleted.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "history that appears during the run fails it with no deleted.json, and a re-run finishes",
    async () => {
      writeProofs();
      // The first delete is when a writer regenerates the manifest once more: the version that
      // was current becomes history after the preflight has looked.
      standin.beforeOp("DeleteObjects", () => {
        standin.putObject(BUCKET, manifest, manifestBody());
      });
      const pruneVersion = ["--prune-noncurrent", `${DATASET}/version/`];
      const r = await runScrub(standin, executeArgs(pruneVersion));
      expectStopped(r, 5, "history-remains");
      expect(r.stdout).toContain("history-remains archives=0 version=1 zarr=0");
      expect(has(dir, "deleted.json")).toBe(false);
      // The old keys did go; only the history is left.
      for (const f of [a, b]) expect(standin.versions(BUCKET, objectPath(f.oldKey)).length).toBe(0);

      // A re-run has no old object left to ask about, so it asks about a new one, and finishes.
      pub.requests.length = 0;
      const again = await runScrub(standin, executeArgs(pruneVersion));
      expect(again.exitCode, again.all).toBe(0);
      expect(pub.requests.map((q) => q.path)).toEqual([`/${DATASET}/objects/${firstNewKey()}`]);
      expect(standin.versions(BUCKET, manifest).length).toBe(1);
      const done = readJson<DeletedFile>(dir, "deleted.json");
      expect(done.counts).toEqual({
        keys: 2,
        versions: 0,
        markers: 0,
        prunedVersions: 1,
        prunedMarkers: 0,
      });
    },
    SLOW,
  );

  test(
    "a key that is only history, a version under a delete marker, is pruned whole",
    async () => {
      writeProofs();
      const oldVersion = standin.putObject(BUCKET, zarrJson, body(dirtyStore));
      const oldMarker = standin.putDeleteMarker(BUCKET, zarrJson);
      const r = await runScrub(standin, executeArgs(["--prune-noncurrent", `${DATASET}/zarr/`]));
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("prune noncurrent versions=1 markers=1");
      expect(standin.versions(BUCKET, zarrJson)).toEqual([]);
      // The version went first; the marker only once nothing was left under it: the marker is in
      // a LATER request than the version, never beside it.
      const requestOf = (id: string) =>
        standin.calls("DeleteObjects").findIndex((c) => c.items?.some((i) => i.versionId === id));
      const [version, marker] = [oldVersion, oldMarker].map(requestOf) as [number, number];
      expect(version).toBeGreaterThanOrEqual(0);
      expect(marker).toBeGreaterThan(version);
    },
    SLOW,
  );

  test(
    "a delete marker over a version that cannot go is kept, so no old version becomes current",
    async () => {
      writeProofs();
      standin.putObject(BUCKET, zarrJson, body(dirtyStore), { lockUntil: centuryFromNow() });
      standin.putDeleteMarker(BUCKET, zarrJson);
      const r = await runScrub(standin, executeArgs(["--prune-noncurrent", `${DATASET}/zarr/`]));
      expectStopped(r, 5, "history-remains");
      expect(r.stdout).toContain("DeleteObjects:access-denied");
      expect(standin.current(BUCKET, zarrJson)).toBeUndefined();
      expect(standin.versions(BUCKET, zarrJson).map((v) => v.deleteMarker)).toEqual([false, true]);
      expect(has(dir, "deleted.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "refuses to prune more than --max-prune",
    async () => {
      writeProofs();
      standin.putObject(BUCKET, manifest, manifestBody());
      standin.putObject(BUCKET, manifest, manifestBody());
      const r = await runScrub(
        standin,
        executeArgs(["--prune-noncurrent", `${DATASET}/version/`, "--max-prune", "1"]),
      );
      expectStopped(r, 3, "over-max-prune");
      expectOldIntact();
    },
    SLOW,
  );
});

describe("delete-old: what must be true before an old key may go", () => {
  const body = (s: string) => new TextEncoder().encode(s);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);
  const zarrJson = `${DATASET}/zarr/sub-01/x.zarr/zarr.json`;
  const [firstKey, secondKey] = [a.oldKey, b.oldKey].sort() as [string, string];

  /**
   * The stage refuses with `word`, in the dry run and, when `execute` is set, with --execute too,
   * and nothing was deleted either way.
   */
  async function refused(
    word: string,
    opts: { execute?: boolean; base?: string; intact?: boolean; extra?: string[] } = {},
  ) {
    const modes = opts.execute === false ? [[]] : [[], ["--execute"]];
    for (const flag of modes) {
      const r = await runScrub(standin, deleteArgs([...flag, ...(opts.extra ?? [])], opts.base));
      expectStopped(r, 3, word, `${flag.length ? "execute" : "dry run"}: ${word}`);
      expect(deleteRequests(standin), word).toBe(0);
      expect(has(dir, "deleted.json"), word).toBe(false);
    }
    if (opts.intact !== false) expectOldIntact();
  }

  test(
    "--confirm-dataset is required and must equal the plan's dataset, before any S3 call",
    async () => {
      writeProofs();
      const base = ["--dir", dir, "--public-base", pub.url];
      for (const flag of [[], ["--execute"]]) {
        const missing = await runScrub(standin, ["delete-old", ...base, ...flag]);
        expect(missing.exitCode, missing.all).toBe(2);
        expect(missing.stderr).toContain("s3-scrub: missing-confirm-dataset");
        for (const typed of ["xx090999", DATASET.toUpperCase(), `${DATASET} `, "nm099999"]) {
          const wrong = await runScrub(standin, [
            "delete-old",
            ...base,
            "--confirm-dataset",
            typed,
            ...flag,
          ]);
          expectStopped(wrong, 3, "confirm-dataset-mismatch", `typed ${JSON.stringify(typed)}`);
        }
      }
      // Refused before the first request to S3 or to the public endpoint.
      expect(standin.log.length).toBe(0);
      expect(pub.requests.length).toBe(0);
    },
    SLOW,
  );

  test(
    "refuses while a current manifest, of any tag, still names an old key",
    async () => {
      writeProofs();
      // The manifest as it was before runbook step 12 regenerated it: it names the old keys. The
      // regenerated one becomes its history, named here so the manifest is the only refusal.
      seedManifest(standin, "v1.0.0", [a, b, d]);
      await refused("manifest-names-old-key", {
        extra: ["--prune-noncurrent", `${DATASET}/version/`],
      });

      // v1.0.0 is regenerated; a second tag, found by listing, is not.
      standin.restore(snap);
      seedManifest(standin, "v1.0.1", [b]);
      await refused("manifest-names-old-key");
    },
    SLOW,
  );

  test(
    "reads every current manifest, and refuses one it cannot read or cannot account for",
    async () => {
      writeProofs();
      // A second tag that is clean is read as well as the first, and passes.
      seedManifest(standin, "v1.0.1", [a, b, d], {}, DATASET, true);
      const ok = await runScrub(standin, deleteArgs());
      expect(ok.exitCode, ok.all).toBe(0);
      const fetched = standin.calls("GetObject").map((c) => c.key);
      expect(fetched).toContain(`${DATASET}/version/v1.0.0.json`);
      expect(fetched).toContain(`${DATASET}/version/v1.0.1.json`);

      standin.restore(snap);
      standin.putObject(BUCKET, `${DATASET}/version/v1.0.2.json`, body("not json at all"));
      await refused("manifest-malformed", { execute: false });

      standin.restore(snap);
      standin.putObject(BUCKET, `${DATASET}/version/notes.json`, body("{}"));
      await refused("version-dir-unknown-file", { execute: false });
    },
    SLOW,
  );

  test(
    "the dataset must be private: an anonymous HEAD of a new and an old object answers exactly 403",
    async () => {
      writeProofs();
      // 403 passes, in the dry run: two requests, HEADs, anonymous, a new key and an old key.
      const ok = await runScrub(standin, deleteArgs());
      expect(ok.exitCode, ok.all).toBe(0);
      expect(pub.requests.map((q) => [q.method, q.path])).toEqual([
        ["HEAD", `/${DATASET}/objects/${firstNewKey()}`],
        ["HEAD", `/${DATASET}/objects/${firstKey}`],
      ]);
      for (const req of pub.requests) {
        expect(req.headers.authorization).toBeUndefined();
        expect(req.headers.cookie).toBeUndefined();
        expect(Object.keys(req.headers).filter((h) => h.startsWith("x-amz"))).toEqual([]);
      }

      // 200 is a public dataset, in either mode.
      pub.status = 200;
      await refused("dataset-is-public");

      // Anything else proves nothing: this bucket denies anonymous listing, so a 404 or a
      // redirect does not say the dataset is private, and an error says nothing at all.
      for (const status of [404, 500, 503, 301, 206, 204]) {
        pub.status = status;
        await refused("privacy-unproven", { execute: false });
      }
      // Nothing listening is no answer either.
      const dead = startPublicEndpoint();
      const deadUrl = dead.url;
      dead.stop();
      await refused("privacy-unproven", { base: deadUrl });
    },
    SLOW,
  );

  test(
    "the probes are objects that exist: a key hidden by a delete marker is skipped",
    async () => {
      writeProofs();
      // A marker on an old key, recorded by the plan (so the delete may remove it).
      const recordMarker = (key: string) => {
        const id = standin.putDeleteMarker(BUCKET, objectPath(key));
        const plan = readJson<PlanFile>(dir, "plan.json");
        (plan.keys.find((k) => k.oldKey === key) as PlanFile["keys"][number]).versionIds.push(id);
        writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
        writeGitVerified(dir); // the git proof names the plan's bytes
      };
      recordMarker(firstKey);
      const ok = await runScrub(standin, deleteArgs());
      expect(ok.exitCode, ok.all).toBe(0);
      expect(pub.requests.map((r) => r.path)).toEqual([
        `/${DATASET}/objects/${firstNewKey()}`,
        `/${DATASET}/objects/${secondKey}`,
      ]);

      // Every old key hidden: the new key alone proves it, as on a re-run after the delete.
      recordMarker(secondKey);
      pub.requests.length = 0;
      const newOnly = await runScrub(standin, deleteArgs());
      expect(newOnly.exitCode, newOnly.all).toBe(0);
      expect(pub.requests.map((r) => r.path)).toEqual([`/${DATASET}/objects/${firstNewKey()}`]);

      // And no new object current either: nothing to ask about, nothing proven, nothing asked.
      for (const f of [a, b]) standin.putDeleteMarker(BUCKET, objectPath(f.newKey as string));
      pub.requests.length = 0;
      await refused("privacy-unproven", { execute: false, intact: false });
      expect(pub.requests.length).toBe(0);
    },
    SLOW,
  );

  test(
    "a delete that finished can be run again: the new keys prove privacy, and nothing is left",
    async () => {
      writeProofs();
      const first = await runScrub(standin, executeArgs());
      expect(first.exitCode, first.all).toBe(0);
      rmSync(path.join(dir, "deleted.json"));
      // Reviewer probe T1: the old keys are gone, so a re-run used to stop at privacy-unproven.
      for (const flag of [[], ["--execute"]]) {
        pub.requests.length = 0;
        const again = await runScrub(standin, deleteArgs(flag));
        expect(again.exitCode, again.all).toBe(0);
        expect(again.stdout).toContain("keys=2 versions=0 markers=0");
        expect(pub.requests.map((q) => q.path)).toEqual([`/${DATASET}/objects/${firstNewKey()}`]);
      }
      expect(readJson<DeletedFile>(dir, "deleted.json").counts.versions).toBe(0);
      // And the public answer still decides: a re-run against a public dataset is refused.
      pub.status = 200;
      expectStopped(await runScrub(standin, deleteArgs()), 3, "dataset-is-public");
    },
    SLOW,
  );

  test(
    "the default public base is the production bucket's anonymous URL",
    () => {
      expect(DEFAULT_PUBLIC_BASE).toBe("https://nemar.s3.us-east-2.amazonaws.com");
    },
    SLOW,
  );

  test(
    "refuses while the dataset has any archive version or marker, current or not",
    async () => {
      writeProofs();
      standin.putObject(BUCKET, `${DATASET}/archives/${DATASET}_v1.0.0.zip`, body("zip"));
      await refused("archives-not-dropped");

      // Reviewer probe T3: an archive hidden by a delete marker is not current, and it is still
      // the original recordings.
      standin.restore(snap);
      const hidden = `${DATASET}/archives/${DATASET}_v1.0.1.zip`;
      standin.putObject(BUCKET, hidden, body("zip"));
      standin.putDeleteMarker(BUCKET, hidden);
      await refused("archives-not-dropped");
      // A marker alone, with nothing under it, is refused too: drop-archives leaves none.
      standin.restore(snap);
      standin.putDeleteMarker(BUCKET, hidden);
      await refused("archives-not-dropped", { execute: false });

      // A sibling prefix that merely starts the same way is not the archive prefix.
      standin.restore(snap);
      standin.putObject(BUCKET, `${DATASET}/archives-old/x.zip`, body("zip"));
      const ok = await runScrub(standin, deleteArgs());
      expect(ok.exitCode, ok.all).toBe(0);
    },
    SLOW,
  );

  test(
    "refuses a current Zarr object until the zarr stage has proven this plan",
    async () => {
      writeProofs();
      standin.putObject(BUCKET, zarrJson, body(dirtyStore));
      await refused("zarr-not-scrubbed");

      // The stage's own proof is what the check accepts, and it removed the identifier key first.
      // Its rewrite left the dirty version as history, which this run must be told to prune.
      await proveZarr();
      expect(JSON.parse(dec(standin.current(BUCKET, zarrJson)?.data as Uint8Array))).toEqual(
        JSON.parse(cleanStore),
      );
      const ok = await runScrub(standin, deleteArgs(["--prune-noncurrent", `${DATASET}/zarr/`]));
      expect(ok.exitCode, ok.all).toBe(0);

      // A proof for another dataset, another plan, another zarr plan, or of another shape. The
      // rewrite's history is named for the prune, so the Zarr proof is the only refusal.
      const only = { execute: false, extra: ["--prune-noncurrent", `${DATASET}/zarr/`] };
      await proveZarr({ dataset: "xx090999" });
      await refused("zarr-not-scrubbed", only);
      await proveZarr({ planSha256: "0".repeat(64) });
      await refused("zarr-not-scrubbed", only);
      await proveZarr({ zarrPlanSha256: "0".repeat(64) });
      await refused("zarr-not-scrubbed", only);
      await proveZarr({ counts: { stores: 5, docs: 5, rewritten: 1, untouched: 1 } });
      await refused("zarr-not-scrubbed", only);
      // A well-formed proof that the prefix was empty says nothing about the objects there now.
      await proveZarr({
        found: "no-zarr",
        stores: [],
        counts: { stores: 0, docs: 0, rewritten: 0, untouched: 0 },
      });
      await refused("zarr-not-scrubbed", only);
      writeJson(dir, "zarr-verified.json", { version: 1 });
      await refused("zarr-not-scrubbed", only);
      // The proof without the zarr-plan.json it names, and a zarr-plan.json that was changed.
      await proveZarr();
      writeJson(dir, "zarr-plan.json", {
        ...readJson<ZarrPlanFile>(dir, "zarr-plan.json"),
        executed: false,
      });
      await refused("zarr-not-scrubbed", only);
      await proveZarr();
      rmSync(path.join(dir, "zarr-plan.json"));
      await refused("zarr-not-scrubbed", only);
      // Without the prune the history is a second refusal, and both are reported.
      await proveZarr({ planSha256: "0".repeat(64) });
      await refused("zarr-not-scrubbed+history-remains", { execute: false });
    },
    SLOW,
  );

  test(
    "a Zarr copy that is only history needs no proof, and is pruned",
    async () => {
      writeProofs();
      standin.putObject(BUCKET, zarrJson, body("{}"));
      standin.putDeleteMarker(BUCKET, zarrJson);
      expectStopped(await runScrub(standin, deleteArgs()), 3, "history-remains");
      const ok = await runScrub(standin, deleteArgs(["--prune-noncurrent", `${DATASET}/zarr/`]));
      expect(ok.exitCode, ok.all).toBe(0);
      expect(has(dir, "zarr-verified.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "refuses a recording under objects/ that the plan never read, in any letter case",
    async () => {
      writeProofs();
      // An upload after the plan: an EDF the scrub never saw, so its header was never checked.
      const late = makeFixture(
        "L",
        ".EDF",
        "sub-09/eeg/late.EDF",
        edfFile(edfHeader({ patient: "Quillfeather", recording: "x" }), 4096, 99),
        null,
      );
      standin.putObject(BUCKET, objectPath(late.oldKey), late.bytes, {
        lockUntil: centuryFromNow(),
      });
      await refused("unplanned-recording");
      // A name that looks like a recording but is not an annex key is not accounted for either.
      standin.restore(snap);
      standin.putObject(BUCKET, `${DATASET}/objects/not-a-key.bdf`, body("x"));
      await refused("unplanned-recording", { execute: false });
      // A recording whose current entry is a delete marker is still bytes in a locked version:
      // the listing is of versions and markers, so it is seen too (C3).
      standin.restore(snap);
      standin.putObject(BUCKET, objectPath(late.oldKey), late.bytes, {
        lockUntil: centuryFromNow(),
      });
      standin.putDeleteMarker(BUCKET, objectPath(late.oldKey));
      expect(standin.current(BUCKET, objectPath(late.oldKey))).toBeUndefined();
      await refused("unplanned-recording");
      // Not a recording: not this check's business.
      standin.restore(snap);
      standin.putObject(BUCKET, `${DATASET}/objects/SHA256E-s1--${"9".repeat(64)}.json`, body("x"));
      const ok = await runScrub(standin, deleteArgs());
      expect(ok.exitCode, ok.all).toBe(0);
    },
    SLOW,
  );

  test(
    "a plan without raw copies ignores annex-uuid and refuses any raw object written since",
    async () => {
      writeProofs();
      // The special remote's marker is in every dataset: never a raw copy, never deleted.
      standin.putObject(
        BUCKET,
        objectPath("annex-uuid"),
        body("6a1b7c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d"),
      );
      const ok = await runScrub(standin, deleteArgs());
      expect(ok.exitCode, ok.all).toBe(0);
      // No raw line for a plan that has none.
      expect(ok.stdout).not.toContain("raw copies");
      // A raw text object, and a zero-byte folder key, written after the plan.
      for (const name of ["participants.tsv", "code/"]) {
        standin.restore(snap);
        standin.putObject(BUCKET, objectPath(name), body(name === "code/" ? "" : "x\n"));
        await refused("raw-copy-not-in-plan", { execute: name === "code/" });
      }
      // One that appears while deleting is found by the final listing, and annex-uuid is kept.
      standin.restore(snap);
      standin.putObject(
        BUCKET,
        objectPath("annex-uuid"),
        body("6a1b7c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d"),
      );
      standin.beforeOp("DeleteObjects", () => {
        standin.putObject(BUCKET, objectPath("late.json"), body("{}"));
      });
      const r = await runScrub(standin, executeArgs());
      expect(r.exitCode, r.all).toBe(5);
      expect(r.stdout).toContain("versions and markers remain: rawCopies=1 versions=1 markers=0");
      expect(has(dir, "deleted.json")).toBe(false);
      expect(standin.versions(BUCKET, objectPath("annex-uuid")).length).toBe(1);
    },
    SLOW,
  );

  test(
    "refuses a current manifest that names a recording the scrub did not account for",
    async () => {
      writeProofs();
      const late = `SHA256E-s4096--${"7".repeat(64)}.edf`;
      seedManifest(
        standin,
        "v1.0.1",
        [a, b, d],
        { "sub-09/eeg/late.edf": { key: late, size: 4096 } },
        DATASET,
        true,
      );
      await refused("manifest-names-unplanned-key");
      // A recording kept inline in git, and a recording keyed by another backend.
      standin.restore(snap);
      seedManifest(
        standin,
        "v1.0.1",
        [a, b, d],
        { "sub-09/eeg/inline.edf": { key: `git:${"c".repeat(40)}`, size: 10 } },
        DATASET,
        true,
      );
      await refused("manifest-names-unplanned-key", { execute: false });
      standin.restore(snap);
      seedManifest(
        standin,
        "v1.0.1",
        [a, b, d],
        { "sub-09/eeg/md5.bdf": { key: "MD5E-s10--abc.bdf", size: 10 } },
        DATASET,
        true,
      );
      await refused("manifest-names-unplanned-key", { execute: false });
    },
    SLOW,
  );

  test(
    "refuses a plan whose dataset is not a dataset id, before any S3 call",
    async () => {
      writeProofs();
      const plan = readJson<PlanFile>(dir, "plan.json");
      writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ ...plan, dataset: "nm1" }));
      const r = await runScrub(standin, [
        "delete-old",
        "--dir",
        dir,
        "--confirm-dataset",
        "nm1",
        "--public-base",
        pub.url,
      ]);
      expectUsage(r, "bad-dataset-id");
      expect(standin.log.length).toBe(0);
      expect(pub.requests.length).toBe(0);
    },
    SLOW,
  );

  test(
    "the public base must be the plan's bucket on S3 over https, outside a test",
    async () => {
      writeProofs();
      // The variable that admits a loopback server is the tests' alone; unset, it is refused.
      // Through the CLI only hosts no request can reach, so a regression cannot send one to the
      // real bucket; the rest of the rule is checked on the function itself below.
      const outside = { [TEST_LOOPBACK_PUBLIC_BASE_ENV]: "" };
      for (const base of [
        pub.url,
        "https://evil.example",
        "https://nemar.s3.us-east-2.amazonaws.com.evil.example",
      ]) {
        const r = await runScrub(standin, deleteArgs([], base), outside, { anyPublicBase: true });
        expectUsage(r, "bad-public-base", base);
      }
      expect(standin.log.length).toBe(0);
      expect(pub.requests.length).toBe(0);
      for (const base of [
        "http://nemar.s3.us-east-2.amazonaws.com",
        "https://xnemar.s3.us-east-2.amazonaws.com",
        "https://s3.us-east-2.amazonaws.com/other",
        "https://nemar.s3.us-east-2.amazonaws.com:8443",
        "https://nemar.s3.us-east-2.amazonaws.com/?x=1",
        "https://nemar.s3.us-east-2.amazonaws.com/sub",
        "https://user@nemar.s3.us-east-2.amazonaws.com",
      ]) {
        expect(() => checkPublicBase(base, "nemar"), base).toThrow(StageError);
      }
      // What is accepted, checked without a request to it.
      for (const base of [
        DEFAULT_PUBLIC_BASE,
        `${DEFAULT_PUBLIC_BASE}/`,
        "https://nemar.s3.amazonaws.com",
        "https://s3.us-east-2.amazonaws.com/nemar",
      ]) {
        expect(() => checkPublicBase(base, "nemar"), base).not.toThrow();
      }
      expect(() => checkPublicBase(DEFAULT_PUBLIC_BASE, "other")).toThrow(StageError);
    },
    SLOW,
  );
});

describe("delete-old: every file names the same dataset, bucket and bytes (I11, T4)", () => {
  const body = (text: string) => new TextEncoder().encode(text);

  test(
    "refuses without a git proof of a fresh clone, or with one that is stale",
    async () => {
      writeProofs();
      rmSync(path.join(dir, "git-verified.json"));
      expectStopped(await runScrub(standin, executeArgs()), 3, "git-proof-missing");
      // Strict parser: an extra field is not the file git-scrub writes.
      writeGitVerified(dir);
      const extra = { ...readJson<Record<string, unknown>>(dir, "git-verified.json"), more: 1 };
      writeJson(dir, "git-verified.json", extra);
      expectStopped(await runScrub(standin, executeArgs()), 3, "git-proof-invalid");
      // A local verify is not a verify of what was pushed.
      writeGitVerified(dir, { mode: "local" });
      expectStopped(await runScrub(standin, executeArgs()), 3, "git-proof-stale");
      // Another keymap, another plan.
      writeGitVerified(dir, { keymapSha256: "b".repeat(64) });
      expectStopped(await runScrub(standin, executeArgs()), 3, "git-proof-stale", "keymap");
      writeGitVerified(dir, { s3PlanSha256: "c".repeat(64) });
      expectStopped(await runScrub(standin, executeArgs()), 3, "git-proof-stale", "plan");
      writeGitVerified(dir, { dataset: "xx090412" });
      expectStopped(await runScrub(standin, executeArgs()), 3, "proof-wrong-dataset", "dataset");
      // Another git plan, when one is in the working directory (none is anywhere above).
      const gitPlan = path.join(dir, "git-plan.json");
      writeFileSync(gitPlan, '{"version":1}\n');
      writeGitVerified(dir);
      const otherGitPlan = await runScrub(standin, executeArgs());
      expectStopped(otherGitPlan, 3, "git-proof-stale", "git plan");
      expect(otherGitPlan.stdout).toContain("names another git-plan.json");
      // The keymap the proof names must be this assembly's.
      const keymap = readJson<Record<string, string>>(dir, "keymap.json");
      writeJson(dir, "keymap.json", { ...keymap, [a.oldKey]: b.newKey });
      // ...with the git plan the proof names in the directory, which is no refusal of its own.
      writeGitVerified(dir, { gitPlanSha256: sha256(readFileSync(gitPlan)) });
      const sameGitPlan = await runScrub(standin, executeArgs());
      expectStopped(sameGitPlan, 3, "keymap-mismatch");
      expect(sameGitPlan.all).not.toContain("git-proof-stale");
      rmSync(gitPlan);
      expectOldIntact();
      expect(standin.log.length).toBe(0);
    },
    SLOW,
  );

  test(
    "the plan's dataset and bucket are compared with assembled.json and each proof, pair by pair",
    async () => {
      const assembled = readJson<AssembledFile>(dir, "assembled.json");
      const refuse = async (word: string, label: string) => {
        writeProofs();
        writeGitVerified(dir);
        expectStopped(await runScrub(standin, executeArgs()), 3, word, label);
        writeJson(dir, "assembled.json", assembled);
      };
      writeJson(dir, "assembled.json", { ...assembled, dataset: "xx090412" });
      await refuse("assembled-wrong-dataset", "assembled dataset");
      writeJson(dir, "assembled.json", { ...assembled, bucket: "other-bucket" });
      await refuse("assembled-wrong-bucket", "assembled bucket");
      // Each proof's dataset on its own, with everything else right.
      writeProofs();
      writeJson(dir, "verified.json", {
        ...readJson<Record<string, unknown>>(dir, "verified.json"),
        dataset: "xx090412",
      });
      expectStopped(await runScrub(standin, executeArgs()), 3, "proof-wrong-dataset", "verified");
      writeProofs();
      writeJson(dir, "new-hash-verified.json", {
        ...readJson<Record<string, unknown>>(dir, "new-hash-verified.json"),
        dataset: "xx090412",
      });
      expectStopped(await runScrub(standin, executeArgs()), 3, "proof-wrong-dataset", "hash");
      expectOldIntact();
      expect(standin.log.length).toBe(0);
    },
    SLOW,
  );

  test(
    "a current manifest that cannot be read, and no manifest at all, are refusals (T1)",
    async () => {
      writeProofs();
      const manifest = `${DATASET}/version/v1.0.0.json`;
      standin.inject("GetObject", { code: "InternalError", status: 500, key: manifest });
      expectStopped(await runScrub(standin, deleteArgs()), 3, "manifest-unreadable");
      standin.restore(snap);
      standin.putDeleteMarker(BUCKET, manifest);
      // The hidden manifest is history too, and both refusals are reported.
      expectStopped(await runScrub(standin, deleteArgs()), 3, "no-manifests+history-remains");
      const named = await runScrub(
        standin,
        deleteArgs(["--prune-noncurrent", `${DATASET}/version/`]),
      );
      expectStopped(named, 3, "no-manifests");
      expectOldIntact();
    },
    SLOW,
  );

  test(
    "an older version of an old key that is not the key's size is refused (T10)",
    async () => {
      writeProofs();
      // Recorded by the plan (so version-not-in-plan does not fire first), and the wrong size.
      const odd = standin.putObject(BUCKET, objectPath(a.oldKey), new Uint8Array(1234), {
        lockUntil: centuryFromNow(),
      });
      const plan = readJson<PlanFile>(dir, "plan.json");
      (plan.keys.find((k) => k.oldKey === a.oldKey) as PlanFile["keys"][number]).versionIds.push(
        odd,
      );
      writeJson(dir, "plan.json", plan);
      writeGitVerified(dir);
      // The odd version is now current; put a right-sized one on top so only an OLDER one is odd.
      standin.putObject(BUCKET, objectPath(a.oldKey), a.bytes, { lockUntil: centuryFromNow() });
      const top = standin.versions(BUCKET, objectPath(a.oldKey)).at(-1)?.versionId as string;
      const plan2 = readJson<PlanFile>(dir, "plan.json");
      (plan2.keys.find((k) => k.oldKey === a.oldKey) as PlanFile["keys"][number]).versionIds.push(
        top,
      );
      writeJson(dir, "plan.json", plan2);
      writeGitVerified(dir);
      const r = await runScrub(standin, executeArgs());
      expectStopped(r, 3, "version-size-differs");
      expect(r.stdout).toContain("1 versions of old keys are not the size their key declares");
      expect(deleteRequests(standin)).toBe(0);
    },
    SLOW,
  );

  test(
    "an archive that appears during the run is found by the final listing: no deleted.json (T5)",
    async () => {
      writeProofs();
      // Between the last precondition and the final listing: while the deletes run.
      standin.beforeOp("DeleteObjects", () => {
        standin.putObject(BUCKET, `${DATASET}/archives/${DATASET}.zip`, body("zip"));
      });
      const r = await runScrub(standin, executeArgs());
      expect(r.exitCode, r.all).toBe(5);
      expect(r.stdout).toContain("history-remains");
      expect(r.stdout).toContain("archives=1");
      expect(has(dir, "deleted.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "a deleted.json from an earlier run does not outlive a run that refuses",
    async () => {
      writeProofs();
      writeJson(dir, "deleted.json", { stale: true });
      rmSync(path.join(dir, "verified.json"));
      expectStopped(await runScrub(standin, executeArgs()), 3, "verified.json-missing");
      expect(has(dir, "deleted.json")).toBe(false);
    },
    SLOW,
  );
});

describe("delete-old: every refusal is evaluated, and all are reported together", () => {
  const body = (s: string) => new TextEncoder().encode(s);
  const manifest = `${DATASET}/version/v1.0.0.json`;
  const zarrJson = `${DATASET}/zarr/sub-01/x.zarr/zarr.json`;
  const manifestBody = () =>
    body(JSON.stringify({ dataset_id: DATASET, version: "v1.0.0", files: {} }));
  const refusedLines = (stdout: string) =>
    stdout.split("\n").filter((l) => l.startsWith("delete-old: refused "));

  test(
    "before step 15a the dry run shows what else refuses, not only archives-not-dropped",
    async () => {
      writeProofs();
      // The archives are there (step 15a has not run), and the operator forgot to name the
      // manifests' history: both are reported by the one dry run.
      standin.putObject(BUCKET, `${DATASET}/archives/${DATASET}_v1.0.0.zip`, body("zip"));
      standin.putObject(BUCKET, manifest, manifestBody());
      standin.putObject(BUCKET, manifest, manifestBody());
      const r = await runScrub(standin, deleteArgs());
      expectStopped(r, 3, "archives-not-dropped+history-remains");
      expect(refusedLines(r.stdout)).toEqual([
        "delete-old: refused archives-not-dropped: versions and markers=1 under archives/",
        "delete-old: refused history-remains: version=2 not named by --prune-noncurrent",
      ]);
      // The counts the operator needs for --max-delete are printed before the archives go.
      expect(r.stdout).toContain("delete-old: keys=2 versions=4 markers=2 planRecorded=6 limit=6");

      // Named, the history is counted for --max-prune, and only the archives are left.
      const named = await runScrub(
        standin,
        deleteArgs(["--prune-noncurrent", `${DATASET}/version/`]),
      );
      expectStopped(named, 3, "archives-not-dropped");
      expect(named.stdout).toContain("delete-old: prune noncurrent versions=2 markers=0");
      expectOldIntact();
      expect(has(dir, "deleted.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "every refusal at once, in a fixed order, each with what triggered it, and nothing deleted",
    async () => {
      writeProofs();
      // new-object-missing: one replacement is gone.
      const newVersion = (
        readJson<AssembledFile>(dir, "assembled.json").entries[a.oldKey] as {
          newVersionId: string;
        }
      ).newVersionId;
      standin.dropVersion(BUCKET, objectPath(a.newKey as string), newVersion);
      // manifest-names-old-key: a second tag whose manifest was never regenerated.
      seedManifest(standin, "v1.0.1", [b]);
      // unplanned-recording: an EDF uploaded after the plan.
      const late = makeFixture(
        "L",
        ".EDF",
        "sub-09/eeg/late.EDF",
        edfFile(edfHeader({ patient: "Quillfeather", recording: "x" }), 4096, 99),
        null,
      );
      standin.putObject(BUCKET, objectPath(late.oldKey), late.bytes, {
        lockUntil: centuryFromNow(),
      });
      // archives-not-dropped.
      standin.putObject(BUCKET, `${DATASET}/archives/${DATASET}_v1.0.0.zip`, body("zip"));
      // zarr-not-scrubbed, and its older version is history nobody named (history-remains).
      standin.putObject(BUCKET, zarrJson, body(dirtyStore));
      standin.putObject(BUCKET, zarrJson, body(dirtyStore));
      // privacy-unproven: the public endpoint answers neither 403 nor 200.
      pub.status = 404;
      // version-size-differs, version-not-in-plan and over-max-delete: one version of an old key,
      // of the wrong size, written after the plan.
      standin.putObject(BUCKET, objectPath(a.oldKey), new Uint8Array(1234), {
        lockUntil: centuryFromNow(),
      });
      // over-max-prune: the manifests' history is named, with a cap below it.
      standin.putObject(BUCKET, manifest, manifestBody());
      standin.putObject(BUCKET, manifest, manifestBody());
      const extra = ["--prune-noncurrent", `${DATASET}/version/`, "--max-prune", "1"];

      const words = [
        "new-object-missing",
        "manifest-names-old-key",
        "unplanned-recording",
        "archives-not-dropped",
        "zarr-not-scrubbed",
        "privacy-unproven",
        "version-size-differs",
        "version-not-in-plan",
        "over-max-delete",
        "history-remains",
        "over-max-prune",
      ];
      for (const flag of [[], ["--execute"]]) {
        const r = await runScrub(standin, deleteArgs([...flag, ...extra]));
        expectStopped(r, 3, words.join("+"), flag.length ? "execute" : "dry run");
        expect(refusedLines(r.stdout)).toEqual([
          "delete-old: refused new-object-missing: 1 of 2 new objects are not at the version assembly recorded",
          "delete-old: refused manifest-names-old-key: v1.0.1 names 1",
          "delete-old: refused unplanned-recording: 1 recordings under objects/ are not in the plan or the assembly",
          "delete-old: refused archives-not-dropped: versions and markers=1 under archives/",
          "delete-old: refused zarr-not-scrubbed: zarr-verified.json missing",
          "delete-old: refused privacy-unproven: a new object answered 404; an old object answered 404",
          "delete-old: refused version-size-differs: 1 versions of old keys are not the size their key declares",
          "delete-old: refused version-not-in-plan: 1 versions or markers of old keys are not in the plan",
          "delete-old: refused over-max-delete: versions+markers=7 over limit=6",
          "delete-old: refused history-remains: zarr=1 not named by --prune-noncurrent",
          "delete-old: refused over-max-prune: noncurrent versions and markers=2 over --max-prune 1",
        ]);
        expect(r.stdout).toContain(
          "delete-old: keys=2 versions=5 markers=2 planRecorded=6 limit=6",
        );
        expect(r.stdout).toContain("delete-old: prune noncurrent versions=2 markers=0");
        expect(deleteRequests(standin)).toBe(0);
        expect(has(dir, "deleted.json")).toBe(false);
      }
    },
    SLOW,
  );

  test(
    "working files that disagree are all reported, and the bucket is not read on their account",
    async () => {
      writeProofs();
      rmSync(path.join(dir, "verified.json"));
      writeGitVerified(dir, { mode: "local" });
      for (const flag of [[], ["--execute"]]) {
        const r = await runScrub(
          standin,
          deleteArgs([...flag, "--prune-noncurrent", `${DATASET}/objects/`]),
        );
        expectStopped(r, 3, "verified.json-missing+git-proof-stale+bad-prune-prefix");
        expect(refusedLines(r.stdout)).toEqual([
          "delete-old: refused verified.json-missing",
          "delete-old: refused git-proof-stale: mode local, not fresh-clone",
          "delete-old: refused bad-prune-prefix: a --prune-noncurrent prefix is not <id>/version/, <id>/archives/ or <id>/zarr/",
        ]);
        expect(r.stdout).toContain("the bucket was not read");
      }
      expect(standin.log.length).toBe(0);
      expect(pub.requests.length).toBe(0);
      expectOldIntact();
    },
    SLOW,
  );
});
