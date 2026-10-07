/**
 * The `aws` CLI version gate. `AWS_REQUEST_CHECKSUM_CALCULATION`, which every call pins so real S3
 * accepts the locked writes, does not exist before aws-cli 2.23.0: an older CLI would ignore it.
 * The parser is tested on version strings real CLIs print, and the gate on the REAL entry points
 * with a shim `aws` first on PATH that prints an old version.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "bun";
import { awsCliVersionOk, parseAwsCliVersion } from "../../../scripts/scrub/s3/s3-lib";
import { startS3Standin } from "../helpers/s3-standin";
import { DATASET, SLOW, removeTempDirs, runScrub, tempDir } from "./support";

afterAll(removeTempDirs);

const LEDGER = path.join(import.meta.dir, "..", "..", "..", "scripts", "scrub", "ledger-cli.ts");

describe("parseAwsCliVersion and the minimum", () => {
  test("reads what real CLIs print, and the minimum is 2.23.0", () => {
    const cases: Array<[string, [number, number, number] | null, boolean]> = [
      ["aws-cli/2.37.9 Python/3.14.8 Darwin/27.0.0 source/arm64\n", [2, 37, 9], true],
      ["aws-cli/2.23.0 Python/3.12.6 Linux/6.8.0-1015-aws exe/x86_64.ubuntu.24", [2, 23, 0], true],
      [
        "aws-cli/2.22.35 Python/3.12.6 Linux/6.5.0-1025-azure exe/x86_64.ubuntu.22",
        [2, 22, 35],
        false,
      ],
      ["aws-cli/1.33.12 Python/3.12.3 Linux/6.8.0 botocore/1.34.130", [1, 33, 12], false],
      ["aws-cli/3.0.0 Python/3.13.0 Linux/6.9.0 exe/x86_64", [3, 0, 0], true],
      ["aws-cli/2.100.1 Python/3.13.0 Linux/6.9.0 exe/x86_64", [2, 100, 1], true],
      ["not an aws cli", null, false],
      ["aws-cli/2.37 Python/3.14.8", null, false],
    ];
    for (const [text, version, ok] of cases) {
      expect(parseAwsCliVersion(text), text).toEqual(version);
      if (version) expect(awsCliVersionOk(version), text).toBe(ok);
    }
  });
});

describe("the gate on the real entry points", () => {
  const shimDir = mkdtempSync(path.join(tmpdir(), "aws-shim-"));
  afterAll(() => rmSync(shimDir, { recursive: true, force: true }));

  /** A directory whose `aws` prints `text` for --version and exits 0. */
  function shim(name: string, text: string): string {
    const dir = path.join(shimDir, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    const file = path.join(dir, "aws");
    writeFileSync(file, `#!/bin/sh\necho '${text}'\n`);
    chmodSync(file, 0o755);
    return dir;
  }

  test(
    "s3-scrub refuses an aws CLI older than 2.23.0, or one whose version it cannot read",
    async () => {
      const standin = startS3Standin();
      try {
        const old = shim("old", "aws-cli/2.22.35 Python/3.12.6 Linux/6.5.0 exe/x86_64.ubuntu.22");
        const r = await runScrub(
          standin,
          ["plan", "--dataset", DATASET, "--out", tempDir("old-cli")],
          { PATH: `${old}:${process.env.PATH ?? ""}` },
        );
        expect(r.exitCode, r.all).toBe(3);
        expect(r.stderr.trim()).toBe("s3-scrub: aws-cli-too-old");
        expect(standin.log.length).toBe(0);

        const odd = shim("odd", "something else entirely");
        const r2 = await runScrub(
          standin,
          ["plan", "--dataset", DATASET, "--out", tempDir("odd-cli")],
          { PATH: `${odd}:${process.env.PATH ?? ""}` },
        );
        expect(r2.exitCode, r2.all).toBe(3);
        expect(r2.stderr.trim()).toBe("s3-scrub: aws-cli-version-unknown");
      } finally {
        standin.stop();
      }
    },
    SLOW,
  );

  test(
    "ledger-cli publish refuses an aws CLI older than 2.23.0 before any S3 call",
    async () => {
      const standin = startS3Standin();
      const dir = tempDir("ledger-old-cli");
      try {
        const file = path.join(dir, "ledger.jsonl");
        writeFileSync(
          file,
          `${JSON.stringify({
            version: 1,
            at: "2026-10-05T00:00:00.000Z",
            dataset: DATASET,
            action: "plan",
            versions: [],
            counts: {},
            scanner: "identifier-scan@abcdef1",
            verification: "plan-only",
            actor: "someone",
          })}\n`,
        );
        const old = shim("old-ledger", "aws-cli/2.17.0 Python/3.11.9 Linux/6.5.0 exe/x86_64");
        const proc = spawn({
          cmd: ["bun", LEDGER, "publish", "--file", file, "--dataset", DATASET, "--execute"],
          env: {
            PATH: `${old}:${process.env.PATH ?? ""}`,
            HOME: dir,
            AWS_ACCESS_KEY_ID: "ASIATESTTESTTESTTEST",
            AWS_SECRET_ACCESS_KEY: "secret",
            AWS_SESSION_TOKEN: "token",
            AWS_ENDPOINT_URL_S3: standin.url,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
        expect(code, stderr).toBe(3);
        expect(stderr.trim()).toBe("aws-cli-too-old");
        expect(standin.log.length).toBe(0);
      } finally {
        standin.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SLOW,
  );
});
