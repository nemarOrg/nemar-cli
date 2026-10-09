/**
 * Real STS lease renewal through upload step 9, with git-annex sending signed
 * requests only to the loopback S3 stand-in. The API calls mint real 15-minute
 * leases for nm099999; the copy itself never reaches the dev or production bucket.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { setConfig } from "../src/lib/config";
import { awsCredentialEnv, buildS3RemoteArgs, toS3Credentials } from "../src/lib/git-annex/s3-remote";
import { gitAnnexAdd } from "../src/lib/git-annex/init";
import { runCommand } from "../src/lib/git-annex/run-command";
import { requestUploadCredentials } from "../src/lib/api/data";
import { initUploadProgress } from "../src/lib/upload-progress";
import {
  listAnnexedPaths,
  transferAnnexedData,
} from "../src/lib/upload/transfer";
import { ok } from "../src/lib/upload/types";
import { startS3Standin } from "./scrub/helpers/s3-standin";
import { LIVE_TARGET_BLOCKED, TEST_CONFIG } from "./setup";
import { makeScratch, newDatasetRepo, writeFile } from "./helpers/annex-repo";

setDefaultTimeout(30_000);

const DATASET_ID = "nm099999";
const REMOTE = "nemar-s3";
const API_HOST = (() => {
  try {
    return new URL(TEST_CONFIG.apiUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
})();
const gitAnnexAvailable = Bun.which("git-annex") !== null;
const canRun =
  !LIVE_TARGET_BLOCKED &&
  API_HOST === "nemar-api-dev.sccn-org.workers.dev" &&
  TEST_CONFIG.adminApiKey.length > 0 &&
  gitAnnexAvailable;
const scratch = makeScratch("nemar-upload-sts-refresh");
let standin: ReturnType<typeof startS3Standin> | undefined;

beforeAll(() => {
  if (canRun) setConfig("apiKey", TEST_CONFIG.adminApiKey);
});

afterAll(() => {
  standin?.stop();
  scratch.cleanup();
});

describe.skipIf(!canRun)("STS credential renewal through the real upload transfer", () => {
  test("renews 15-minute API leases between batches and signs only loopback S3 copies", async () => {
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

    standin = startS3Standin({ region: "us-east-2" });
    const standinUrl = new URL(standin.url);
    expect(standinUrl.hostname).toBe("127.0.0.1");
    const allowLoopback = await runCommand(
      ["git", "config", "annex.security.allowed-ip-addresses", "127.0.0.1"],
      { cwd: repo },
    );
    expect(allowLoopback.exitCode).toBe(0);

    let initialAccessKeyId = "";
    const renewedAccessKeyIds: string[] = [];
    const transfer = await transferAnnexedData({
      absolutePath: repo,
      progress: initUploadProgress(repo, DATASET_ID, targets),
      addTargets: targets,
      jobs: 1,
      copyBatchMaxFiles: 1,
      openRemote: async () => {
        const initial = await requestUploadCredentials(DATASET_ID, 900);
        initialAccessKeyId = initial.credentials.access_key_id;
        const initialCredentials = toS3Credentials(initial.credentials);
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
        const configured = await runCommand(
          ["git", "annex", "initremote", REMOTE, ...remoteArgs],
          { cwd: repo, env: awsCredentialEnv(initialCredentials) },
        );
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
            renewedAccessKeyIds.push(renewed.credentials.access_key_id);
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
        (entry.op === "GetBucketLocation" || entry.op === "CreateBucket"),
    );
    expect(setupUsedInitialLease).toBe(true);
    expect(renewedAccessKeyIds).toHaveLength(2);

    const copyKeyIds = standin.calls("PutObject").map((entry) => entry.keyId ?? "");
    expect(copyKeyIds).toHaveLength(2);
    expect(copyKeyIds.every((keyId) => renewedAccessKeyIds.includes(keyId))).toBe(true);
    expect(copyKeyIds.every((keyId) => keyId !== initialAccessKeyId)).toBe(true);
  });
});
