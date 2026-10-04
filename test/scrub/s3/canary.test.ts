/**
 * The canary: proof that the operator can bypass the lock, run against a disposable prefix
 * before anything real is touched. Run as the real CLI against the S3 stand-in.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type S3Standin, startS3Standin } from "../helpers/s3-standin";
import { expectStopped } from "./refusal";
import { BUCKET, DATASET, MIB, SLOW, runScrub } from "./support";

let standin: S3Standin;
afterEach(() => standin?.stop());

const prefix = `${DATASET}/canary-k3x9q2/`;
const canary = (extra: string[] = [], p = prefix) => ["canary", "--prefix", p, ...extra];

describe("canary", () => {
  test(
    "refuses any prefix that is not a canary prefix, with and without --execute",
    async () => {
      standin = startS3Standin();
      for (const bad of [
        `${DATASET}/`,
        `${DATASET}/objects/`,
        `${DATASET}/canary/`,
        `${DATASET}/canary-k3x9q2`,
        `${DATASET}/xcanary-k3x9q2/`,
        `${DATASET}/canary-/`,
        "canary-k3x9q2",
        "../canary-k3x9q2/",
        `${DATASET}/../canary-k3x9q2/`,
        `${DATASET}/canary-k3x9q2/../objects/`,
        "",
      ]) {
        for (const extra of [[], ["--execute"]]) {
          const r = await runScrub(standin, canary(extra, bad));
          expect(r.exitCode, `${JSON.stringify(bad)} ${extra}: ${r.all}`).not.toBe(0);
          expect([2, 3]).toContain(r.exitCode);
        }
      }
      expect(standin.log.length).toBe(0);
    },
    SLOW,
  );

  test(
    "a dry run lists the steps and makes no S3 call",
    async () => {
      standin = startS3Standin();
      const r = await runScrub(standin, canary());
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("dry run");
      expect(r.stdout).toContain("WITHOUT the bypass");
      expect(r.stdout).toContain("WITH the bypass");
      expect(r.stdout).toContain("zero versions");
      expect(standin.log.length).toBe(0);
    },
    SLOW,
  );

  test(
    "proves the lock holds, the bypass works, and nothing is left behind",
    async () => {
      standin = startS3Standin();
      let lockSeen: { mode: string; until: Date } | undefined;
      standin.beforeOp("DeleteObject", () => {
        lockSeen = standin.versions(BUCKET, `${prefix}probe.txt`)[0]?.lock;
      });
      const r = await runScrub(standin, canary(["--execute"]));
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("without the bypass was refused");
      expect(r.stdout).toContain("with the bypass succeeded");
      expect(r.stdout).toContain("zero versions and zero delete markers remain");

      // The probe was locked for about a day when it was put.
      expect(lockSeen?.mode).toBe("GOVERNANCE");
      const hours = ((lockSeen?.until.getTime() ?? 0) - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(22);
      expect(hours).toBeLessThan(25);

      // Without the bypass first (refused), then with it (accepted), both by version id.
      const deletes = standin.calls("DeleteObject");
      expect(deletes.map((d) => [d.bypass, d.status])).toEqual([
        [false, 403],
        [true, 204],
      ]);
      expect(deletes.every((d) => typeof d.versionId === "string")).toBe(true);
      expect(standin.calls("ListObjectVersions").length).toBe(1);
      expect(standin.keys(BUCKET, prefix).length).toBe(0);
    },
    SLOW,
  );

  test(
    "an operator who cannot bypass fails the canary, and the probe is not reported deleted",
    async () => {
      standin = startS3Standin();
      standin.setDenyBypass(true);
      const r = await runScrub(standin, canary(["--execute"]));
      expectStopped(r, 1, "bypass-denied");
      expect(standin.versions(BUCKET, `${prefix}probe.txt`).length).toBe(1);
    },
    SLOW,
  );

  test(
    "a version left under the prefix after the deletes fails the canary",
    async () => {
      standin = startS3Standin();
      // A stray writer adds an object under the prefix while the probe is being removed.
      standin.beforeOp(
        "DeleteObject",
        () => {
          standin.putObject(BUCKET, `${prefix}stray.txt`, new Uint8Array(3));
        },
        2,
      );
      const r = await runScrub(standin, canary(["--execute"]));
      expectStopped(r, 5, "canary-remainder");
      expect(standin.keys(BUCKET, prefix)).toEqual([`${prefix}stray.txt`]);
    },
    SLOW,
  );

  test(
    "--multipart proves the production path: the lock set at create, an upload part, a server-side copy",
    async () => {
      standin = startS3Standin();
      let lockSeen: { mode: string; until: Date } | undefined;
      standin.beforeOp(
        "DeleteObject",
        () => {
          lockSeen = standin.versions(BUCKET, `${prefix}multipart.bin`)[0]?.lock;
        },
        3,
      );
      const r = await runScrub(standin, canary(["--execute", "--multipart"]));
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("multipart object built with the lock set at create");

      expect(standin.calls("CreateMultipartUpload").length).toBe(1);
      const parts = standin.calls("UploadPart");
      expect(parts.length).toBe(1);
      expect(parts[0]?.size).toBe(6 * MIB);
      expect(parts[0]?.checksum).toBe(false);
      expect(standin.calls("UploadPartCopy")[0]?.range).toBe(`bytes=0-${MIB - 1}`);
      expect(standin.calls("CompleteMultipartUpload")[0]?.size).toBe(7 * MIB);
      expect(lockSeen?.mode).toBe("GOVERNANCE");

      // Three objects, each refused without the bypass and then deleted with it.
      expect(standin.calls("DeleteObject").map((d) => [d.bypass, d.status])).toEqual([
        [false, 403],
        [true, 204],
        [false, 403],
        [true, 204],
        [false, 403],
        [true, 204],
      ]);
      expect(standin.keys(BUCKET, prefix).length).toBe(0);
      expect(standin.openUploads()).toBe(0);
    },
    SLOW,
  );
});
