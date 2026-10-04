/**
 * The plan stage, run as the real CLI against the S3 stand-in: which keys it finds, what it
 * reads, what it writes, and that it stops (exit 4) rather than plan over data it could not read.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { parsePatches, parsePlan } from "../../../scripts/scrub/contract";
import { buildKey } from "../../../scripts/scrub/contract";
import type { PlanFile } from "../../../scripts/scrub/contract";
import { type S3Standin, startS3Standin } from "../helpers/s3-standin";
import { expectStopped } from "./refusal";
import {
  BUCKET,
  DATASET,
  SLOW,
  assembleArgs,
  dirText,
  fixtureA,
  fixtureB,
  fixtureD,
  fixtureE,
  has,
  leaksAName,
  objectPath,
  planArgs,
  readJson,
  runScrub,
  seedManifest,
  seedObject,
  sha256,
  tempDir,
  writeHashes,
  writeJson,
} from "./support";

let standin: S3Standin;
afterEach(() => standin?.stop());

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("plan", () => {
  test(
    "finds only the EDF and BDF keys of the manifests, reads headers, writes no value",
    async () => {
      standin = startS3Standin();
      // Two entries per page: the CLI must follow every page of every listing.
      standin.setPageSize(2);
      const a = fixtureA();
      const b = fixtureB();
      const d = fixtureD();
      const e = fixtureE();
      // A has an older version, a delete marker and a current version: three ids to record.
      const aIds = seedObject(standin, a, { olderVersions: 1, marker: true });
      seedObject(standin, b);
      seedObject(standin, d);
      seedManifest(standin, "v1.0.0", [a, d], {
        // A file the scrub does not read, and a file kept inline in git.
        "sub-01/eeg/sub-01_photo.fif": { key: `SHA256E-s10--${"a".repeat(64)}.fif`, size: 10 },
        "sub-06/eeg/sub-06_task-rest_eeg.edf": { key: `git:${"b".repeat(40)}`, size: 5 },
      });
      seedManifest(standin, "v1.0.1", [a, b]);
      // The summary file is not a manifest: its key must never reach the plan.
      seedManifest(standin, "v1.0.0-summary", [e]);
      // So is the records file the enrichment job writes: a JSON array, which parses as no manifest.
      standin.putObject(
        BUCKET,
        `${DATASET}/version/v1.0.0-records.json`,
        new TextEncoder().encode(JSON.stringify([{ doc_type: "recording" }])),
      );

      const dir = tempDir("plan");
      const r = await runScrub(standin, planArgs(dir));
      expect(r.exitCode, r.all).toBe(0);

      const plan = parsePlan(JSON.stringify(readJson(dir, "plan.json")));
      expect(plan.tags).toEqual(["v1.0.0", "v1.0.1"]);
      expect(plan.dataset).toBe(DATASET);
      expect(plan.bucket).toBe(BUCKET);
      expect(plan.keys.map((k) => k.oldKey).sort()).toEqual([a.oldKey, b.oldKey, d.oldKey].sort());
      expect(plan.keys.map((k) => k.oldKey)).not.toContain(e.oldKey);

      const byKey = Object.fromEntries(plan.keys.map((k) => [k.oldKey, k]));
      const pa = byKey[a.oldKey];
      const pb = byKey[b.oldKey];
      const pd = byKey[d.oldKey];
      expect(pa?.needsScrub).toBe(true);
      expect(pb?.needsScrub).toBe(true);
      expect(pd?.needsScrub).toBe(false);
      expect(pd?.reasons).toEqual([]);
      expect([pa?.status, pb?.status, pd?.status]).toEqual(["read", "read", "read"]);
      // Reasons are fixed finding kinds, never text from a header.
      for (const k of [pa, pb]) {
        expect(k?.reasons.length).toBeGreaterThan(0);
        for (const reason of k?.reasons ?? []) expect(reason).toMatch(/^[a-z]+(-[a-z]+)+$/);
      }
      // Every version id and the marker, for the delete stage.
      expect([...(pa?.versionIds ?? [])].sort()).toEqual([...aIds].sort());
      expect(pb?.versionIds.length).toBe(1);
      expect(pa?.size).toBe(a.bytes.length);

      expect(plan.totals).toEqual({
        keys: 3,
        needScrub: 2,
        bytesToHash: a.bytes.length + b.bytes.length,
        unreadable: 0,
      });
      expect(r.stdout.trim()).toBe(
        `plan: tags=2 keys=3 needScrub=2 bytesToHash=${a.bytes.length + b.bytes.length} unreadable=0`,
      );

      // Patches: the scrubbed header as hex, only for the keys that need one.
      const patches = parsePatches(JSON.stringify(readJson(dir, "patches.json")));
      expect(Object.keys(patches).sort()).toEqual([a.oldKey, b.oldKey].sort());
      expect(patches[a.oldKey]).toBe(toHex((a.expected as Uint8Array).subarray(0, 256)));
      expect(patches[b.oldKey]).toBe(toHex((b.expected as Uint8Array).subarray(0, 256)));

      // No participant value anywhere it could have been printed or written.
      expect(leaksAName(`${r.all}\n${dirText(dir)}`)).toBeNull();

      // Read-only: lists, heads and reads, and each header read asked for exactly 8192 bytes.
      const ops = new Set<string>(standin.log.map((x) => x.op));
      expect([...ops].sort()).toEqual(
        ["GetObject", "HeadObject", "ListObjectVersions", "ListObjectsV2"].sort(),
      );
      const ranged = standin.calls("GetObject").filter((x) => x.range !== undefined);
      expect(ranged.length).toBe(3);
      for (const c of ranged) expect(c.range).toBe("bytes=0-8191");
      // Neither sibling was ever fetched.
      for (const sibling of ["v1.0.0-summary.json", "v1.0.0-records.json"]) {
        expect(
          standin.calls("GetObject").some((x) => x.key === `${DATASET}/version/${sibling}`),
          sibling,
        ).toBe(false);
      }
    },
    SLOW,
  );

  test(
    "--tags plans over the tags named and nothing else",
    async () => {
      standin = startS3Standin();
      const a = fixtureA();
      const b = fixtureB();
      const d = fixtureD();
      for (const f of [a, b, d]) seedObject(standin, f);
      seedManifest(standin, "v1.0.0", [a, d]);
      seedManifest(standin, "v1.0.1", [a, b]);
      const dir = tempDir("plan-tags");
      const r = await runScrub(standin, planArgs(dir, ["--tags", "v1.0.1"]));
      expect(r.exitCode, r.all).toBe(0);
      const plan = readJson<PlanFile>(dir, "plan.json");
      expect(plan.tags).toEqual(["v1.0.1"]);
      expect(plan.keys.map((k) => k.oldKey).sort()).toEqual([a.oldKey, b.oldKey].sort());
      // Naming tags skips discovery: no prefix listing of the manifests.
      expect(standin.calls("ListObjectsV2").length).toBe(0);
    },
    SLOW,
  );

  test(
    "a file under version/ that is neither a manifest nor a known sibling stops the plan, never skipped",
    async () => {
      for (const name of [
        "v1.0.0-final.json",
        "notes.json",
        "v1.0.0.json.bak",
        "v1.0.0-beta.1.json",
      ]) {
        standin = startS3Standin();
        const a = fixtureA();
        seedObject(standin, a);
        seedManifest(standin, "v1.0.0", [a]);
        standin.putObject(BUCKET, `${DATASET}/version/${name}`, new TextEncoder().encode("{}"));
        const dir = tempDir("plan-unknown");
        const r = await runScrub(standin, planArgs(dir));
        expectStopped(r, 4, "version-dir-unknown-file");
        // Stopped before reading any object, so no header was read and no plan was written.
        expect(standin.calls("GetObject").length, name).toBe(0);
        expect(existsSync(`${dir}/plan.json`), name).toBe(false);
        standin.stop();
      }
    },
    SLOW,
  );

  test(
    "a key that cannot be read, or whose size disagrees, exits 4 and is counted, never skipped",
    async () => {
      standin = startS3Standin();
      const good = fixtureA();
      seedObject(standin, good);

      // Listed in a manifest, no object at all.
      const missing = fixtureD();
      // The object is one byte longer than its key says.
      const wrongSize = fixtureB();
      const longer = new Uint8Array(wrongSize.bytes.length + 1);
      longer.set(wrongSize.bytes);
      standin.putObject(BUCKET, objectPath(wrongSize.oldKey), longer);
      // A file named .edf whose header is not an EDF header.
      const junk = new Uint8Array(2000).fill(0x41);
      const junkKey = buildKey(junk.length, sha256(junk), ".edf");
      standin.putObject(BUCKET, objectPath(junkKey), junk);

      seedManifest(standin, "v1.0.0", [good, missing, wrongSize], {
        "sub-09/eeg/sub-09_task-rest_eeg.edf": { key: junkKey, size: junk.length },
      });
      const dir = tempDir("plan-unreadable");
      const r = await runScrub(standin, planArgs(dir));
      expect(r.exitCode, r.all).toBe(4);

      const plan = readJson<PlanFile>(dir, "plan.json");
      expect(plan.totals.unreadable).toBe(3);
      expect(plan.totals.keys).toBe(4);
      expect(plan.totals.needScrub).toBe(1);
      const status = Object.fromEntries(plan.keys.map((k) => [k.oldKey, k]));
      expect(status[missing.oldKey]?.status).toBe("unreadable");
      expect(status[missing.oldKey]?.reasons).toEqual(["HeadObject:not-found"]);
      expect(status[wrongSize.oldKey]?.status).toBe("unreadable");
      expect(status[wrongSize.oldKey]?.reasons).toEqual(["size-mismatch"]);
      expect(status[junkKey]?.status).toBe("unreadable");
      expect(status[junkKey]?.reasons).toEqual(["not-edf"]);
      expect(status[good.oldKey]?.status).toBe("read");
      expect(r.stdout).toContain("unreadable=3");
      expect(r.stdout).toContain("incomplete");
      expect(leaksAName(`${r.all}\n${dirText(dir)}`)).toBeNull();

      // No later stage runs on this plan, even with hashes supplied.
      writeHashes(dir, [good]);
      const asm = await runScrub(standin, assembleArgs(dir));
      expectStopped(asm, 3, "plan-has-unreadable");
    },
    SLOW,
  );

  test(
    "refuses to plan from a manifest it cannot account for",
    async () => {
      standin = startS3Standin();
      const a = fixtureA();
      seedObject(standin, a);

      // A key the contract cannot carry.
      seedManifest(standin, "v1.0.0", [a], {
        "sub-07/eeg/sub-07_task-rest_eeg.edf": { key: "MD5E-s5--abcdef.edf", size: 5 },
      });
      const dirBad = tempDir("plan-badkey");
      const bad = await runScrub(standin, planArgs(dirBad));
      expectStopped(bad, 4, "manifest-bad-key");
      expect(has(dirBad, "plan.json")).toBe(false);

      // A tag that was asked for and does not exist.
      const dirMissing = tempDir("plan-missing");
      const missing = await runScrub(standin, planArgs(dirMissing, ["--tags", "v9.9.9"]));
      expectStopped(missing, 4, "manifest-missing");

      // A dataset with no manifests at all.
      const dirNone = tempDir("plan-none");
      const none = await runScrub(standin, ["plan", "--dataset", "xx090412", "--out", dirNone]);
      expectStopped(none, 4, "no-manifests");

      // A manifest that is not JSON must not echo what it holds.
      standin.putObject(
        BUCKET,
        `${DATASET}/version/v2.0.0.json`,
        new TextEncoder().encode("Marigold Thistlewood is not json"),
      );
      const dirJunk = tempDir("plan-junk");
      const junk = await runScrub(standin, planArgs(dirJunk, ["--tags", "v2.0.0"]));
      expectStopped(junk, 4, "manifest-malformed");
      expect(leaksAName(junk.all)).toBeNull();
    },
    SLOW,
  );

  test(
    "a manifest of another dataset, and an existing assembly, are refused",
    async () => {
      standin = startS3Standin();
      const a = fixtureA();
      seedObject(standin, a);
      standin.putObject(
        BUCKET,
        `${DATASET}/version/v1.0.0.json`,
        new TextEncoder().encode(JSON.stringify({ dataset_id: "xx090999", files: {} })),
      );
      const dir = tempDir("plan-wrong");
      const wrong = await runScrub(standin, planArgs(dir));
      expectStopped(wrong, 4, "manifest-wrong-dataset");

      seedManifest(standin, "v1.0.0", [a]);
      writeJson(dir, "assembled.json", {
        version: 1,
        dataset: DATASET,
        bucket: BUCKET,
        entries: {},
      });
      const again = await runScrub(standin, planArgs(dir));
      expectStopped(again, 3, "assembled-exists");
      expect(has(dir, "plan.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "usage errors and a long-lived key in the environment are refused before any S3 call",
    async () => {
      standin = startS3Standin();
      const dir = tempDir("plan-usage");
      const noDataset = await runScrub(standin, ["plan", "--out", dir]);
      expect(noDataset.exitCode).toBe(2);
      const badId = await runScrub(standin, ["plan", "--dataset", "nm1", "--out", dir]);
      expect(badId.exitCode).toBe(2);
      const unknown = await runScrub(standin, ["frobnicate"]);
      expect(unknown.exitCode).toBe(2);
      const akia = await runScrub(standin, planArgs(dir), {
        AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKE0001",
      });
      expectStopped(akia, 3, "long-lived-key-in-environment");
      expect(standin.log.length).toBe(0);
    },
    SLOW,
  );
});
