/**
 * The drop-archives stage, run as the real CLI against the S3 stand-in. It deletes, so most of
 * what is tested is what it must not do: touch anything outside the archive prefix, use the
 * governance bypass, name a delete without a version id, or call itself done while a version
 * remains.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import path from "node:path";
import type { ArchivesDroppedFile } from "../../../scripts/scrub/s3/archives-stage";
import { type S3Standin, startS3Standin } from "../helpers/s3-standin";
import { expectStopped } from "./refusal";
import {
  BUCKET,
  DATASET,
  SLOW,
  addUnreadableKey,
  centuryFromNow,
  fixtureD,
  has,
  planArgs,
  readJson,
  runScrub,
  seedManifest,
  seedObject,
  tempDir,
} from "./support";

let standin: S3Standin;
afterEach(() => standin?.stop());

const body = (s: string) => new TextEncoder().encode(s);
const arch = (name: string) => `${DATASET}/archives/${name}`;
const A = arch(`${DATASET}_v1.0.0.zip`);
const B = arch(`${DATASET}_v1.0.1.zip`);
const C = arch(`${DATASET}_v1.0.2.zip`);

const dropArgs = (dir: string, extra: string[] = []) => [
  "drop-archives",
  "--dir",
  dir,
  "--confirm-dataset",
  DATASET,
  "--concurrency",
  "4",
  ...extra,
];

/** Outside the archive prefix: it must all still be there, untouched, afterwards. */
const BYSTANDERS = [
  `${DATASET}/archives-old/${DATASET}_v0.zip`,
  `${DATASET}/archivesX`,
  `${DATASET}/version/v1.0.0.json`,
  "xx090999/archives/other.zip",
];

interface Seeded {
  dir: string;
  /** Every version id and marker under the archive prefix: A has 2 versions, B a version hidden
   * by a marker, C a version, a marker and a re-upload. */
  ids: string[];
  bystanders: Record<string, string[]>;
}

async function seeded(): Promise<Seeded> {
  standin = startS3Standin();
  const d = fixtureD();
  seedObject(standin, d);
  seedManifest(standin, "v1.0.0", [d]);
  const dir = tempDir("archives");
  const plan = await runScrub(standin, planArgs(dir));
  expect(plan.exitCode, plan.all).toBe(0);

  const ids = [
    standin.putObject(BUCKET, A, body("zip one")),
    standin.putObject(BUCKET, A, body("zip two")),
    standin.putObject(BUCKET, B, body("zip b")),
    standin.putDeleteMarker(BUCKET, B),
    standin.putObject(BUCKET, C, body("zip c1")),
    standin.putDeleteMarker(BUCKET, C),
    standin.putObject(BUCKET, C, body("zip c2")),
  ];
  for (const k of BYSTANDERS.slice(0, 2)) standin.putObject(BUCKET, k, body("not an archive"));
  standin.putObject(BUCKET, BYSTANDERS[3] as string, body("another dataset"));
  const bystanders: Record<string, string[]> = {};
  for (const k of BYSTANDERS) {
    bystanders[k] = standin.versions(BUCKET, k).map((v) => v.versionId);
  }
  standin.log.length = 0;
  return { dir, ids, bystanders };
}

const bystanderIds = (key: string) => standin.versions(BUCKET, key).map((v) => v.versionId);

describe("drop-archives", () => {
  test(
    "needs the dataset id typed again, before any S3 call, in both modes",
    async () => {
      const { dir } = await seeded();
      for (const flag of [[], ["--execute"]]) {
        const missing = await runScrub(standin, ["drop-archives", "--dir", dir, ...flag]);
        expect(missing.exitCode, missing.all).toBe(2);
        expect(missing.stderr).toContain("missing-confirm-dataset");
        const wrong = await runScrub(standin, [
          "drop-archives",
          "--dir",
          dir,
          "--confirm-dataset",
          "xx090999",
          ...flag,
        ]);
        expectStopped(wrong, 3, "confirm-dataset-mismatch");
      }
      expect(standin.log.length).toBe(0);
      expect(has(dir, "archives-dropped.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "refuses a plan with a key nobody read, before any S3 call",
    async () => {
      const { dir } = await seeded();
      addUnreadableKey(dir);
      for (const flag of [[], ["--execute"]]) {
        expectStopped(await runScrub(standin, dropArgs(dir, flag)), 3, "plan-has-unreadable");
      }
      expect(standin.log.length).toBe(0);
    },
    SLOW,
  );

  test(
    "a dry run counts what it would delete and deletes nothing",
    async () => {
      const { dir, ids } = await seeded();
      const r = await runScrub(standin, dropArgs(dir));
      expect(r.exitCode, r.all).toBe(0);
      // A: two versions. B: a version and a marker. C: two versions and a marker.
      expect(r.stdout).toContain("keys=3 versions=5 markers=2");
      expect(r.stdout).toContain("would delete versions=5 markers=2 across 3 keys");
      expect(standin.calls("DeleteObject").length).toBe(0);
      expect(
        [A, B, C].flatMap((k) => standin.versions(BUCKET, k).map((v) => v.versionId)).sort(),
      ).toEqual([...ids].sort());
      expect(has(dir, "archives-dropped.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "deletes every version and marker by id, never with the bypass, and nothing else",
    async () => {
      const { dir, ids, bystanders } = await seeded();
      const r = await runScrub(standin, dropArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("zero versions and zero markers remain");

      // Seven deletes: five versions and two markers, each by its own id, none with the bypass.
      const deletes = standin.calls("DeleteObject");
      expect(deletes.length).toBe(7);
      for (const d of deletes) {
        expect(d.versionId, "version id").toBeTruthy();
        expect(d.bypass, "bypass header").toBe(false);
        expect(d.status).toBe(204);
      }
      expect(deletes.map((d) => d.versionId).sort()).toEqual([...ids].sort());
      // Gone from the stand-in, key by key, and the final listing was a fresh one.
      expect(standin.keys(BUCKET, `${DATASET}/archives/`)).toEqual([]);
      expect(standin.calls("ListObjectVersions").length).toBe(2);

      // Everything outside the prefix, including a sibling that merely starts alike, is as it was.
      for (const k of BYSTANDERS) expect(bystanderIds(k), k).toEqual(bystanders[k] as string[]);

      const done = readJson<ArchivesDroppedFile>(dir, "archives-dropped.json");
      expect(done.dataset).toBe(DATASET);
      expect(done.counts).toEqual({ keys: 3, versions: 5, markers: 2 });
      expect(JSON.stringify(done)).not.toContain(".zip");
      expect(statSync(path.join(dir, "archives-dropped.json")).mode & 0o777).toBe(0o600);

      // Run again: nothing left, and it says so.
      const again = await runScrub(standin, dropArgs(dir, ["--execute"]));
      expect(again.exitCode, again.all).toBe(0);
      expect(readJson<ArchivesDroppedFile>(dir, "archives-dropped.json").counts).toEqual({
        keys: 0,
        versions: 0,
        markers: 0,
      });
    },
    SLOW,
  );

  test(
    "a locked version is reported and fails the stage; the lock is never forced",
    async () => {
      const { dir } = await seeded();
      const locked = standin.putObject(BUCKET, arch("locked.zip"), body("locked"), {
        lockUntil: centuryFromNow(),
      });
      standin.log.length = 0;
      const r = await runScrub(standin, dropArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(5);
      expect(r.stdout).toContain("DeleteObject:access-denied=1");
      expect(r.stdout).toContain("versions and markers remain: 1");
      expect(has(dir, "archives-dropped.json")).toBe(false);
      // Only the locked version stands, and every attempt, including that one, was without bypass.
      expect(standin.keys(BUCKET, `${DATASET}/archives/`)).toEqual([arch("locked.zip")]);
      expect(bystanderIds(arch("locked.zip"))).toEqual([locked]);
      expect(standin.calls("DeleteObject").every((d) => d.bypass === false)).toBe(true);
    },
    SLOW,
  );

  test(
    "an archive that appears while deleting is found by the final listing and fails the stage",
    async () => {
      const { dir } = await seeded();
      let newcomer = "";
      standin.beforeOp("DeleteObject", () => {
        newcomer = standin.putObject(BUCKET, arch("late.zip"), body("a workflow rebuilt it"));
      });
      const r = await runScrub(standin, dropArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(5);
      expect(r.stdout).toContain("versions and markers remain: 1");
      expect(has(dir, "archives-dropped.json")).toBe(false);
      expect(bystanderIds(arch("late.zip"))).toEqual([newcomer]);
    },
    SLOW,
  );

  test(
    "a dataset with no archive is dropped vacuously",
    async () => {
      standin = startS3Standin();
      const d = fixtureD();
      seedObject(standin, d);
      seedManifest(standin, "v1.0.0", [d]);
      const dir = tempDir("archives-none");
      expect((await runScrub(standin, planArgs(dir))).exitCode).toBe(0);
      const r = await runScrub(standin, dropArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(0);
      expect(readJson<ArchivesDroppedFile>(dir, "archives-dropped.json").counts).toEqual({
        keys: 0,
        versions: 0,
        markers: 0,
      });
      expect(standin.calls("DeleteObject").length).toBe(0);
    },
    SLOW,
  );
});
