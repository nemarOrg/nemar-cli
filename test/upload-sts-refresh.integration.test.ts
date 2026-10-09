/**
 * Real STS lease renewal through upload step 9, with git-annex sending signed
 * requests only to the loopback S3 stand-in. The API calls mint real 15-minute
 * leases for nm099999; the copy itself never reaches the dev or production bucket.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { requestUploadCredentials } from "../src/lib/api/data";
import { setConfig } from "../src/lib/config";
import { gitAnnexAdd } from "../src/lib/git-annex/init";
import { runCommand } from "../src/lib/git-annex/run-command";
import {
  awsCredentialEnv,
  buildS3RemoteArgs,
  toS3Credentials,
} from "../src/lib/git-annex/s3-remote";
import { listAnnexedKeys } from "../src/lib/git-annex/transfer";
import { initUploadProgress } from "../src/lib/upload-progress";
import { listAnnexedPaths, transferAnnexedData } from "../src/lib/upload/transfer";
import { ok } from "../src/lib/upload/types";
import { makeScratch, newDatasetRepo, writeFile } from "./helpers/annex-repo";
import { startS3Standin } from "./scrub/helpers/s3-standin";
import { LIVE_TARGET_BLOCKED, TEST_CONFIG } from "./setup";

setDefaultTimeout(30_000);

const DATASET_ID = "nm099999";
const REMOTE = "nemar-s3";
const TEST_API_URL = (() => {
  try {
    return new URL(TEST_CONFIG.apiUrl);
  } catch {
    return undefined;
  }
})();
const API_HOST = TEST_API_URL?.hostname.toLowerCase() ?? "";
const gitAnnexAvailable = Bun.which("git-annex") !== null;
const canRun =
  !LIVE_TARGET_BLOCKED &&
  TEST_API_URL?.protocol === "https:" &&
  API_HOST === "nemar-api-dev.sccn-org.workers.dev" &&
  TEST_CONFIG.adminApiKey.length > 0 &&
  gitAnnexAvailable;
const scratch = makeScratch("nemar-upload-sts-refresh");
let standin: ReturnType<typeof startS3Standin> | undefined;
const sessionTokenFingerprint = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

beforeAll(() => {
  if (canRun) setConfig("apiKey", TEST_CONFIG.adminApiKey);
});

afterAll(() => {
  standin?.stop();
  scratch.cleanup();
});

describe.skipIf(!canRun)("STS credential renewal through the real upload transfer", () => {
  test("renews expired 15-minute API leases and signs loopback copies with the refreshed session", async () => {
    const repo = await newDatasetRepo(scratch.root, "lease-refresh");
    const samples = [
      {
        source: join(import.meta.dir, "fixtures/identifier-scan/clean.edf"),
        path: "sub-01/eeg/sub-01_task-rest_eeg.edf",
      },
      {
        source: join(import.meta.dir, "fixtures/identifier-scan/flagged.edf"),
        path: "sub-02/eeg/sub-02_task-rest_eeg.edf",
      },
    ];
    const targets = samples.map(({ source, path }) => {
      const bytes = readFileSync(source);
      writeFile(repo, path, bytes);
      return { path, size: statSync(source).size, type: "data" as const };
    });
    const annexed = await gitAnnexAdd(
      repo,
      targets.map((target) => target.path),
      {},
      { forceLarge: true },
    );
    expect(annexed.success).toBe(true);

    const initial = await requestUploadCredentials(DATASET_ID, 900);
    const initialCredentials = toS3Credentials(initial.credentials);
    standin = startS3Standin({ region: initial.s3.region });
    const standinUrl = new URL(standin.url);
    expect(standinUrl.hostname).toBe("127.0.0.1");
    const allowLoopback = await runCommand(
      ["git", "config", "annex.security.allowed-ip-addresses", "127.0.0.1"],
      { cwd: repo },
    );
    expect(allowLoopback.exitCode).toBe(0);

    const initialAccessKeyId = initial.credentials.access_key_id;
    const initialTokenFingerprint = sessionTokenFingerprint(initial.credentials.session_token);
    const renewedCredentials: Array<{ accessKeyId: string; sessionTokenFingerprint: string }> = [];
    const transfer = await transferAnnexedData({
      absolutePath: repo,
      progress: initUploadProgress(repo, DATASET_ID, targets),
      addTargets: targets,
      dataFiles: targets,
      jobs: 1,
      copyBatchMaxFiles: 1,
      openRemote: async () => {
        const remoteConfig = {
          name: REMOTE,
          bucket: initial.s3.bucket,
          prefix: `${DATASET_ID}/objects`,
          region: initial.s3.region,
        };
        const remoteArgs = buildS3RemoteArgs(remoteConfig).filter(
          (arg) => !arg.startsWith("protocol="),
        );
        remoteArgs.push(
          "protocol=http",
          "host=127.0.0.1",
          `port=${standinUrl.port}`,
          "requeststyle=path",
        );
        const configured = await runCommand(["git", "annex", "initremote", REMOTE, ...remoteArgs], {
          cwd: repo,
          env: awsCredentialEnv(initialCredentials),
        });
        if (configured.exitCode !== 0) {
          // Do not include subprocess output: it can contain credential material.
          throw new Error("Could not configure the local S3 stand-in remote");
        }
        const initialLease = {
          credentials: initialCredentials,
          expiresAtMs: Date.parse(initial.credentials.expiration),
        };
        return ok({
          credentials: initialCredentials,
          lease: initialLease,
          renewLease: async () => {
            const renewed = await requestUploadCredentials(DATASET_ID, 900);
            renewedCredentials.push({
              accessKeyId: renewed.credentials.access_key_id,
              sessionTokenFingerprint: sessionTokenFingerprint(renewed.credentials.session_token),
            });
            if (renewedCredentials.length === 1) {
              // Keep returning ExpiredToken for the lease used by the first batch, including
              // any retries git-annex makes internally. Only the application-level renewal
              // can then make progress with the next API-issued access key and session token.
              standin?.inject("PutObject", {
                code: "ExpiredToken",
                status: 403,
                keyId: renewed.credentials.access_key_id,
              });
            }
            return {
              credentials: toS3Credentials(renewed.credentials),
              expiresAtMs: Date.parse(renewed.credentials.expiration),
            };
          },
          remoteIdentity: JSON.stringify([REMOTE, remoteArgs]),
        });
      },
    });

    expect(transfer.status).toBe("ok");
    const remoteLocations = await listAnnexedPaths(repo, REMOTE);
    expect([...remoteLocations].sort()).toEqual(targets.map((target) => target.path).sort());

    const setupUsedInitialLease = standin.log.some(
      (entry) =>
        entry.keyId === initialAccessKeyId &&
        entry.sessionTokenFingerprint === initialTokenFingerprint &&
        (entry.op === "GetBucketLocation" || entry.op === "CreateBucket"),
    );
    expect(setupUsedInitialLease).toBe(true);
    expect(renewedCredentials).toHaveLength(3);

    const initializationWrites = standin
      .calls("PutObject")
      .filter((entry) => entry.key === `${DATASET_ID}/objects/annex-uuid`);
    expect(initializationWrites).toHaveLength(1);
    expect(initializationWrites[0]?.keyId).toBe(initialAccessKeyId);
    expect(initializationWrites[0]?.sessionTokenFingerprint).toBe(initialTokenFingerprint);

    const annexedKeys = await listAnnexedKeys(repo);
    const expectedObjectKeys = new Set(
      targets.map((target) => {
        const key = annexedKeys.get(target.path);
        expect(key).toBeDefined();
        return `${DATASET_ID}/objects/${key}`;
      }),
    );
    const copyRequests = standin
      .calls("PutObject")
      .filter((entry) => expectedObjectKeys.has(entry.key));
    const expiredKeyId = renewedCredentials[0]?.accessKeyId;
    const failedLeaseRequests = copyRequests.filter((entry) => entry.keyId === expiredKeyId);
    const successfulCopyRequests = copyRequests.filter((entry) => entry.status === 200);
    expect(failedLeaseRequests.length).toBeGreaterThan(0);
    expect(failedLeaseRequests.every((entry) => entry.status === 403)).toBe(true);
    expect([...new Set(successfulCopyRequests.map((entry) => entry.key))].sort()).toEqual(
      [...expectedObjectKeys].sort(),
    );
    expect(
      successfulCopyRequests.some((entry) => entry.keyId === renewedCredentials[1]?.accessKeyId),
    ).toBe(true);
    expect(
      successfulCopyRequests.some((entry) => entry.keyId === renewedCredentials[2]?.accessKeyId),
    ).toBe(true);
    for (const entry of copyRequests) {
      const credentials = renewedCredentials.find(({ accessKeyId }) => accessKeyId === entry.keyId);
      expect(credentials).toBeDefined();
      expect(entry.keyId).not.toBe(initialAccessKeyId);
      expect(entry.sessionTokenFingerprint).toBe(credentials?.sessionTokenFingerprint);
    }
    expect(successfulCopyRequests.every((entry) => entry.keyId !== expiredKeyId)).toBe(true);
  });
});
