/**
 * A signal in the middle of a stage: the REAL `s3-scrub.ts` is started as a subprocess, caught in
 * the middle of a download, and sent a real SIGINT, SIGTERM or SIGHUP. The download is assemble's
 * read of the first 8 MiB of a recording (the part it patches), and the stand-in sends the headers
 * and the first 4 MiB, then holds the rest, so the `aws` child has written raw original bytes into
 * the stage's temp directory. (A small read, such as plan's 8 KiB, is buffered by the CLI and only
 * reaches the file at the end, so it cannot be caught half way.) Bun does not run a `finally` when
 * a signal ends the process, so without a handler that directory would stay on disk, and the `aws`
 * child would keep running.
 *
 * The child is started under `umask 022` so the owner-only mode of the temp file is the program's
 * own doing, not the test runner's.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawn } from "bun";
import { type S3Standin, startS3Standin } from "../helpers/s3-standin";
import {
  DATASET,
  MIB,
  REPO_ROOT,
  SCRIPT,
  SLOW,
  assembleArgs,
  awsTestEnv,
  fixtureC,
  has,
  planArgs,
  removeTempDirs,
  runScrub,
  seedManifest,
  seedObject,
  tempDir,
  writeHashes,
} from "./support";

afterAll(removeTempDirs);

let standin: S3Standin | undefined;
afterEach(() => {
  standin?.stop();
  standin = undefined;
});

async function waitFor<T>(probe: () => T | undefined, ms: number): Promise<T | undefined> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const got = probe();
    if (got !== undefined) return got;
    await Bun.sleep(50);
  }
  return undefined;
}

/** The pids of processes whose command line mentions `text` (the aws child names its temp file). */
async function pidsMentioning(text: string): Promise<string[]> {
  const proc = spawn({ cmd: ["pgrep", "-f", text], stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split("\n").filter((l) => l.trim() !== "");
}

const tempDirsIn = (root: string) => readdirSync(root).filter((n) => n.startsWith("scrub-s3-"));

describe("a signal mid-stage", () => {
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    test(
      `${signal}: the aws child is killed, the temp directory removed, and the exit is ${code}`,
      async () => {
        standin = startS3Standin();
        const c = fixtureC();
        seedObject(standin, c);
        seedManifest(standin, "v1.0.0", [c]);
        const out = tempDir("signal-out");
        const plan = await runScrub(standin, planArgs(out));
        expect(plan.exitCode, plan.all).toBe(0);
        writeHashes(out, [c]);
        // Assemble's read of C's first part: headers and 4 MiB, then nothing for a minute.
        standin.stallBodyNext({ keyPrefix: `${DATASET}/objects/`, bytes: 4 * MIB, ms: 60_000 });
        const root = tempDir("signal");
        const cmd = ["bun", SCRIPT, ...assembleArgs(out)].map((a) => `'${a}'`).join(" ");
        const proc = spawn({
          cmd: ["sh", "-c", `umask 022; exec ${cmd}`],
          cwd: REPO_ROOT,
          env: awsTestEnv(standin, { TMPDIR: root }),
          stdout: "pipe",
          stderr: "pipe",
        });
        const stderr = new Response(proc.stderr).text();
        const stdout = new Response(proc.stdout).text();

        // Caught half way: the aws child has its output file open in the stage's temp directory.
        const file = await waitFor(() => {
          for (const d of tempDirsIn(root)) {
            const files = readdirSync(path.join(root, d));
            if (files.length > 0) return path.join(root, d, files[0] as string);
          }
          return undefined;
        }, 60_000);
        // (No awaiting the child's output here: that would wait for it to exit.)
        expect(file).toBeDefined();
        const dir = path.dirname(file as string);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        // Written by the aws child under the program's umask, not the runner's 022.
        expect(statSync(file as string).mode & 0o777).toBe(0o600);
        expect((await pidsMentioning(dir)).length).toBeGreaterThan(0);

        proc.kill(signal);
        const exit = await proc.exited;
        expect(exit, `${await stdout}${await stderr}`).toBe(code);
        expect(await stderr).toContain(`s3-scrub: interrupted by ${signal}; temp files removed`);
        expect(existsSync(dir)).toBe(false);
        expect(tempDirsIn(root)).toEqual([]);
        // The child went with it, rather than finishing the download into a deleted directory.
        const gone = await (async () => {
          // Generous: a SIGKILLed child is reaped at once, but a loaded machine schedules late.
          const until = Date.now() + 30_000;
          while (Date.now() < until) {
            if ((await pidsMentioning(dir)).length === 0) return true;
            await Bun.sleep(100);
          }
          return false;
        })();
        expect(gone).toBe(true);
        // Nothing was recorded: the assembly never finished. What it leaves in S3 is one open
        // multipart upload (the runbook says how to find and abort it), and no object.
        expect(has(out, "assembled.json")).toBe(false);
        expect(standin.openUploads()).toBe(1);
        expect(standin.keys("nemar", `${DATASET}/objects/${c.newKey}`)).toEqual([]);
      },
      SLOW,
    );
  }
});
