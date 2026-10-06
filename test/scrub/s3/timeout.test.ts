/**
 * Every `aws` spawn has a timeout. A server that stops answering must cost a bounded wait and a
 * fixed-word failure, never a hung stage: the stand-in holds one request far longer than the
 * limit, and the real CLI is killed and reported as a timeout.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { PlanFile } from "../../../scripts/scrub/contract";
import { AwsCliError, headObject } from "../../../scripts/scrub/s3/s3-lib";
import { type S3Standin, startS3Standin } from "../helpers/s3-standin";
import {
  BUCKET,
  SLOW,
  fixtureA,
  objectPath,
  planArgs,
  readJson,
  removeTempDirs,
  runScrub,
  seedManifest,
  seedObject,
  tempDir,
  withCtx,
} from "./support";

afterAll(removeTempDirs);

let standin: S3Standin;
afterEach(() => standin?.stop());

describe("timeouts", () => {
  test(
    "a hung request is killed at the limit and counted as a timeout, not waited for",
    async () => {
      standin = startS3Standin();
      const a = fixtureA();
      seedObject(standin, a);
      seedManifest(standin, "v1.0.0", [a]);
      // The first HEAD (the plan's check of A) is held for two minutes. The limit is 8 seconds,
      // long enough for every other call to finish on a loaded machine (the aws CLI alone can
      // take seconds to start under load), and far shorter than the stall.
      standin.stallNext("HEAD", 120_000);
      const dir = tempDir("timeout");
      const started = Date.now();
      const r = await runScrub(standin, planArgs(dir, ["--tags", "v1.0.0", "--timeout-sec", "8"]));
      const elapsed = Date.now() - started;
      expect(r.exitCode, r.all).toBe(4);
      const plan = readJson<PlanFile>(dir, "plan.json");
      expect(plan.keys[0]?.status).toBe("unreadable");
      expect(plan.keys[0]?.reasons).toEqual(["HeadObject:timeout"]);
      // Not the two minutes the server wanted: bounded by the stall, not by a guess at speed.
      expect(elapsed).toBeLessThan(90_000);
    },
    SLOW,
  );

  test(
    "the library raises a timeout error with the operation named",
    async () => {
      standin = startS3Standin();
      standin.putObject(BUCKET, objectPath("k"), new Uint8Array(3));
      standin.stallNext("HEAD", 30_000);
      await withCtx(
        standin,
        async (ctx) => {
          let err: unknown;
          await headObject(ctx, objectPath("k")).catch((e) => {
            err = e;
          });
          expect(err).toBeInstanceOf(AwsCliError);
          expect((err as AwsCliError).code).toBe("timeout");
          expect((err as AwsCliError).op).toBe("HeadObject");
        },
        BUCKET,
        1000,
      );
    },
    SLOW,
  );
});
