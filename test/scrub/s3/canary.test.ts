/**
 * The canary: proof that the operator can bypass the lock, run against a disposable prefix
 * before anything real is touched. Run as the real CLI against the S3 stand-in.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createAwsRunner, isoSeconds, putObjectLocked } from "../../../scripts/scrub/s3/s3-lib";
import { type S3Standin, startS3Standin } from "../helpers/s3-standin";
import { expectStopped } from "./refusal";
import { BUCKET, DATASET, MIB, SLOW, awsTestEnv, runScrub, tempDir, withCtx } from "./support";

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
        // A live dataset, a standing fixture, the id live tests rely on never resolving, and a
        // mirror: none is a place to write a locked object and delete it with the bypass.
        "nm000103/canary-k3x9q2/",
        "nm000348/canary-k3x9q2/",
        "nm099998/canary-k3x9q2/",
        "nm099997/canary-k3x9q2/",
        "nm099900/canary-k3x9q2/",
        "nm099999x/canary-k3x9q2/",
        "on000001/canary-k3x9q2/",
        // An id outside the sandbox band, a malformed id, and a prefix nested deeper.
        "xx100000/canary-k3x9q2/",
        "xx09041/canary-k3x9q2/",
        "xx0904111/canary-k3x9q2/",
        `${DATASET}/sub/canary-k3x9q2/`,
        `nm099999/sub/canary-k3x9q2/`,
        `${DATASET}/canary-k3x9q2/x/`,
        `${DATASET}/canary-k3x9.q2/`,
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
    "the end-to-end fixture's id and any sandbox id are accepted",
    async () => {
      standin = startS3Standin();
      for (const ok of [
        "nm099999/canary-abc/",
        "xx090411/canary-k3x9q2/",
        "xx000001/canary-1/",
        "xx099899/canary-A_b-9/",
      ]) {
        const r = await runScrub(standin, canary([], ok));
        expect(r.exitCode, `${ok}: ${r.all}`).toBe(0);
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
    "--multipart still sends a part checksum when the operator's environment asks for none",
    async () => {
      standin = startS3Standin();
      const r = await runScrub(standin, canary(["--execute", "--multipart"]), {
        AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
      });
      expect(r.exitCode, r.all).toBe(0);
      const parts = standin.calls("UploadPart");
      expect(parts.length).toBe(1);
      expect(parts[0]?.status).toBe(200);
      expect(parts[0]?.checksum).toBe(true);
    },
    SLOW,
  );

  test(
    "the stand-in refuses a part of a lock-created upload that has no checksum, as real S3 does",
    async () => {
      standin = startS3Standin();
      const create = await fetch(`${standin.url}/${BUCKET}/${prefix}raw.bin?uploads`, {
        method: "POST",
        headers: {
          "x-amz-object-lock-mode": "GOVERNANCE",
          "x-amz-object-lock-retain-until-date": new Date(Date.now() + 86_400_000).toISOString(),
        },
      });
      const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await create.text())?.[1];
      expect(uploadId).toBeTruthy();
      const part = (headers: Record<string, string>) =>
        fetch(
          `${standin.url}/${BUCKET}/${prefix}raw.bin?partNumber=1&uploadId=${encodeURIComponent(uploadId as string)}`,
          { method: "PUT", headers, body: new Uint8Array(16) },
        );
      const bare = await part({});
      expect(bare.status).toBe(400);
      expect(await bare.text()).toContain("InvalidRequest");
      const withChecksum = await part({ "x-amz-checksum-crc64nvme": "AAAAAAAAAAA=" });
      expect(withChecksum.status).toBe(200);
    },
    SLOW,
  );

  test(
    "the stand-in refuses a put with lock parameters and no checksum, and the bare CLI sends none",
    async () => {
      standin = startS3Standin();
      const lock = {
        "x-amz-object-lock-mode": "GOVERNANCE",
        "x-amz-object-lock-retain-until-date": new Date(Date.now() + 86_400_000).toISOString(),
      };
      const put = (headers: Record<string, string>) =>
        fetch(`${standin.url}/${BUCKET}/${prefix}raw.txt`, {
          method: "PUT",
          headers,
          body: new Uint8Array(16),
        });
      const bare = await put(lock);
      expect(bare.status).toBe(400);
      expect(await bare.text()).toContain("InvalidRequest");
      expect((await put({ ...lock, "x-amz-checksum-crc64nvme": "AAAAAAAAAAA=" })).status).toBe(200);
      // No lock, no requirement.
      expect((await put({})).status).toBe(200);

      // The control that makes the pin worth testing: with the operator's setting left alone,
      // the REAL CLI sends no checksum on a locked put-object, and is refused.
      const dir = tempDir("canary-raw");
      const file = path.join(dir, "body");
      writeFileSync(file, "x");
      const proc = Bun.spawn(
        [
          "aws",
          "s3api",
          "put-object",
          "--bucket",
          BUCKET,
          "--key",
          `${prefix}cli.txt`,
          "--body",
          file,
          "--object-lock-mode",
          "GOVERNANCE",
          "--object-lock-retain-until-date",
          isoSeconds(new Date(Date.now() + 86_400_000)),
          "--region",
          "us-east-2",
        ],
        {
          env: awsTestEnv(standin, { AWS_REQUEST_CHECKSUM_CALCULATION: "when_required" }),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await proc.exited).not.toBe(0);
      const refused = standin.calls("PutObject").filter((c) => c.key === `${prefix}cli.txt`);
      expect(refused.map((c) => [c.status, c.checksum])).toEqual([[400, false]]);
    },
    SLOW,
  );

  test(
    "a locked put-object sends a checksum whatever the operator's environment asks for",
    async () => {
      standin = startS3Standin();
      const r = await runScrub(standin, canary(["--execute"]), {
        AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
      });
      expect(r.exitCode, r.all).toBe(0);
      const puts = standin.calls("PutObject");
      expect(puts.length).toBe(1);
      expect([puts[0]?.status, puts[0]?.checksum]).toEqual([200, true]);

      // The same through the library, with the setting in the runner's own environment.
      const key = `${prefix}lib.txt`;
      await withCtx(standin, async (ctx) => {
        const aws = createAwsRunner({
          region: "us-east-2",
          timeoutMs: 60_000,
          env: awsTestEnv(standin, { AWS_REQUEST_CHECKSUM_CALCULATION: "when_required" }),
        });
        const body = ctx.tmp.file();
        await writeFile(body, "x");
        await putObjectLocked(
          { ...ctx, aws },
          key,
          body,
          {},
          isoSeconds(new Date(Date.now() + 86_400_000)),
        );
      });
      expect(standin.calls("PutObject").at(-1)?.checksum).toBe(true);
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
      expect(parts[0]?.checksum, "real S3 requires a part checksum under a lock").toBe(true);
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
