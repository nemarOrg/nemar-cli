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
import { type AssembledFile, type PlanFile, parseKey } from "../../../scripts/scrub/contract";
import { AwsCliError, deleteVersion } from "../../../scripts/scrub/s3/s3-lib";
import type { DeletedFile } from "../../../scripts/scrub/s3/s3-stages";
import { type S3Standin, type Snapshot, startS3Standin } from "../helpers/s3-standin";
import { expectStopped } from "./refusal";
import {
  type Assembled,
  BUCKET,
  DATASET,
  SLOW,
  buildAssembled,
  centuryFromNow,
  copyDir,
  fixtureA,
  fixtureB,
  fixtureD,
  has,
  objectPath,
  readJson,
  runScrub,
  sha256,
  verifyArgs,
  withCtx,
  writeJson,
} from "./support";

let standin: S3Standin;
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

const deleteArgs = (extra: string[] = []) => [
  "delete-old",
  "--dir",
  dir,
  "--concurrency",
  "8",
  ...extra,
];
const executeArgs = (extra: string[] = []) => deleteArgs(["--execute", ...extra]);

const versionIdsOf = (key: string) =>
  standin.versions(BUCKET, objectPath(key)).map((v) => v.versionId);

/** Nothing was deleted: every old version and marker is still there. */
function expectOldIntact() {
  expect(standin.calls("DeleteObject").length).toBe(0);
  for (const f of [a, b]) {
    expect(versionIdsOf(f.oldKey).sort()).toEqual([...(oldIds[f.oldKey] as string[])].sort());
  }
}

beforeAll(async () => {
  standin = startS3Standin();
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
  const sha = sha256(readFileSync(path.join(built.dir, "assembled.json")));
  writeJson(built.dir, "new-hash-verified.json", {
    version: 1,
    dataset: DATASET,
    assembledSha256: sha,
    count: 2,
  });
  snap = standin.snapshot();
}, SLOW);

afterAll(() => standin?.stop());

beforeEach(() => {
  standin.restore(snap);
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
      // One byte of whitespace changes the file; both proofs now describe a different file.
      writeFileSync(
        path.join(dir, "assembled.json"),
        `${readFileSync(path.join(dir, "assembled.json"), "utf8")}\n`,
      );
      const stale = await runScrub(standin, executeArgs());
      expectStopped(stale, 3, "verified-stale");
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
    "a plan that went stale cannot widen: a newer version needs a deliberate --max-delete",
    async () => {
      writeProofs();
      // A version appeared on an old key after the plan recorded its ids.
      const extra = standin.putObject(BUCKET, objectPath(a.oldKey), a.bytes, {
        lockUntil: centuryFromNow(),
      });
      // The plan recorded the ids of the two keys being replaced (D, the clean file, is not one).
      const recorded = readJson<PlanFile>(dir, "plan.json")
        .keys.filter((k) => k.oldKey === a.oldKey || k.oldKey === b.oldKey)
        .reduce((n, k) => n + k.versionIds.length, 0);
      expect(recorded).toBe(6);
      const refused = await runScrub(standin, executeArgs());
      expectStopped(refused, 3, "over-max-delete");
      expect(refused.stdout).toContain(`planRecorded=${recorded}`);
      expect(standin.calls("DeleteObject").length).toBe(0);
      expect(versionIdsOf(a.oldKey)).toContain(extra);

      // Naming the larger number is the deliberate step; a dry run shows it is then accepted.
      const accepted = await runScrub(standin, deleteArgs(["--max-delete", String(recorded + 1)]));
      expect(accepted.exitCode, accepted.all).toBe(0);
      expect(standin.calls("DeleteObject").length).toBe(0);
    },
    SLOW,
  );

  test(
    "refuses an assembly in which an old key is, or becomes, a new key",
    async () => {
      const full = readJson<AssembledFile>(dir, "assembled.json");
      const withEntries = (mutate: (e: AssembledFile["entries"]) => void) => {
        const copy = structuredClone(full);
        mutate(copy.entries);
        writeJson(dir, "assembled.json", copy);
        writeProofs();
      };

      // An entry whose replacement is itself.
      withEntries((e) => {
        (e[a.oldKey] as { newKey: string }).newKey = a.oldKey;
      });
      const same = await runScrub(standin, executeArgs());
      expectStopped(same, 3, "new-key-equals-old-key");

      // One entry's replacement is another entry's original.
      withEntries((e) => {
        (e[a.oldKey] as { newKey: string }).newKey = b.oldKey;
      });
      const chained = await runScrub(standin, executeArgs());
      expectStopped(chained, 3, "old-key-is-a-new-key");

      // Two originals share one replacement.
      withEntries((e) => {
        (e[a.oldKey] as { newKey: string }).newKey = (e[b.oldKey] as { newKey: string }).newKey;
      });
      const shared = await runScrub(standin, executeArgs());
      expectStopped(shared, 3, "duplicate-new-key");
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
      const entry = plan.keys.find((k) => k.oldKey === a.oldKey) as { needsScrub: boolean };
      entry.needsScrub = false;
      writeFileSync(planPath, JSON.stringify(plan));
      const notPlanned = await runScrub(standin, executeArgs());
      expectStopped(notPlanned, 3, "assembled-not-in-plan");

      entry.needsScrub = true;
      writeFileSync(planPath, JSON.stringify(plan));
      for (const prefix of [
        `${DATASET}/objects/`,
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
      // Each delete named a version id and carried the bypass; none was a bare delete.
      const deletes = standin.calls("DeleteObject");
      expect(deletes.length).toBe(6);
      for (const del of deletes) {
        expect(del.versionId, "version id").toBeTruthy();
        expect(del.bypass, "bypass header").toBe(true);
        expect(del.status).toBe(204);
      }
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
      standin.beforeOp("DeleteObject", () => {
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
      expect(r.stdout).toContain("DeleteObject:access-denied");
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
  const archive = `${DATASET}/archives/${DATASET}_v1.0.0.zip`;
  const body = (s: string) => new TextEncoder().encode(s);

  test(
    "deletes only noncurrent versions and markers, by id, without the bypass; never a current one",
    async () => {
      writeProofs();
      // Manifest: seeded once, now two more versions and a marker below the newest.
      standin.putObject(BUCKET, manifest, body("second"));
      standin.putDeleteMarker(BUCKET, manifest);
      standin.putObject(BUCKET, manifest, body("third"));
      // Archive: two versions.
      standin.putObject(BUCKET, archive, body("zip one"));
      standin.putObject(BUCKET, archive, body("zip two"));
      const currentManifest = standin.current(BUCKET, manifest)?.versionId as string;
      const currentArchive = standin.current(BUCKET, archive)?.versionId as string;

      const r = await runScrub(
        standin,
        executeArgs([
          "--prune-noncurrent",
          `${DATASET}/version/`,
          "--prune-noncurrent",
          `${DATASET}/archives/`,
        ]),
      );
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("prune noncurrent versions=3 markers=1");

      expect(standin.versions(BUCKET, manifest).map((v) => v.versionId)).toEqual([currentManifest]);
      expect(standin.versions(BUCKET, archive).map((v) => v.versionId)).toEqual([currentArchive]);
      expect(standin.current(BUCKET, manifest)?.deleteMarker).toBe(false);

      // The pruning deletes are by id and never carry the bypass.
      const prunes = standin
        .calls("DeleteObject")
        .filter((x) => !x.key.startsWith(`${DATASET}/objects/`));
      expect(prunes.length).toBe(4);
      for (const p of prunes) {
        expect(p.versionId).toBeTruthy();
        expect(p.bypass).toBe(false);
      }
      const done = readJson<DeletedFile>(dir, "deleted.json");
      expect(done.counts.prunedVersions).toBe(3);
      expect(done.counts.prunedMarkers).toBe(1);
    },
    SLOW,
  );

  test(
    "never forces a lock: a locked noncurrent version stays and the stage fails",
    async () => {
      writeProofs();
      standin.putObject(BUCKET, archive, body("locked"), { lockUntil: centuryFromNow() });
      standin.putObject(BUCKET, archive, body("current"));
      const r = await runScrub(
        standin,
        executeArgs(["--prune-noncurrent", `${DATASET}/archives/`]),
      );
      expect(r.exitCode, r.all).toBe(5);
      expect(r.stdout).toContain("DeleteObject:access-denied");
      expect(standin.versions(BUCKET, archive).length).toBe(2);
      expect(has(dir, "deleted.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "refuses to prune more than --max-prune",
    async () => {
      writeProofs();
      standin.putObject(BUCKET, manifest, body("second"));
      standin.putObject(BUCKET, manifest, body("third"));
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
