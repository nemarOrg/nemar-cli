/**
 * Direct tests of curlStreamCopy's copy-integrity gates (#967 code-review
 * follow-up on the initial fix). Uses a real local Bun.serve() HTTP server
 * as the "OpenNeuro" source -- not a mock -- so the download + size
 * verification runs against genuine bytes over a genuine HTTP request via
 * the real `curl` binary. The final `aws s3 cp` upload step is stubbed at
 * the process-PATH boundary: a real executable script stands in for `aws`
 * (same PATH-substitution technique test/upload-steps.unit.test.ts uses for
 * missing/present tools), so the test needs neither AWS credentials nor a
 * real bucket, and we can assert the upload only fires on the pass paths.
 * No live backend, no network beyond loopback -- pure tier.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { curlStreamCopy } from "../src/lib/s3-server-copy";

const REGION = "us-east-2";

let requestCount = 0;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
const bodies: Record<string, string> = {
  full: "x".repeat(1000), // pairs with the -s1000-- keys below
  short: "x".repeat(10), // shorter than a -s1000-- declared size
  empty: "",
};

let binDir: string;
let awsLogFile: string;
let previousPath: string | undefined;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      requestCount++;
      const path = new URL(req.url).pathname.slice(1);
      const body = bodies[path];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(body);
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;

  // A real `aws` stand-in: logs its argv and exits 0, so `curlStreamCopy`'s
  // final `aws s3 cp` step neither needs credentials nor touches a real
  // bucket. Prepended (not substituted) onto PATH, so `curl` and everything
  // else still resolve to the genuine system binaries.
  binDir = mkdtempSync(join(tmpdir(), "nemar-fake-aws-"));
  awsLogFile = join(binDir, "aws-invocations.log");
  writeFileSync(awsLogFile, "");
  writeFileSync(
    join(binDir, "aws"),
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(awsLogFile)}\nexit 0\n`,
  );
  chmodSync(join(binDir, "aws"), 0o755);
  previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;
});

afterAll(() => {
  server.stop(true);
  // Guarded restore (#1175): assigning `undefined` to a process.env key
  // coerces to the literal string "undefined" instead of deleting it, which
  // would poison PATH for every test running later in the same `bun test`
  // process (test/ + backend/test/ share one process at the root).
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  rmSync(binDir, { recursive: true, force: true });
});

beforeEach(() => {
  requestCount = 0;
  writeFileSync(awsLogFile, "");
});

function awsInvocations(): string[] {
  return readFileSync(awsLogFile, "utf-8").split("\n").filter(Boolean);
}

describe("curlStreamCopy", () => {
  test("correct-size download uploads and reports success", async () => {
    const destUri = "s3://nemar/on1/objects/SHA256E-s1000--ok.edf";
    const result = await curlStreamCopy(`${baseUrl}/full`, destUri, REGION);
    expect(result.success).toBe(true);
    expect(requestCount).toBe(1);
    const invocations = awsInvocations();
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toContain(destUri);
  });

  test("truncated/mismatched body is rejected and never uploaded", async () => {
    const destUri = "s3://nemar/on1/objects/SHA256E-s1000--truncated.edf";
    const result = await curlStreamCopy(`${baseUrl}/short`, destUri, REGION);
    expect(result.success).toBe(false);
    expect(result.error).toContain("1000");
    expect(awsInvocations()).toHaveLength(0);
  });

  test("empty body with a positive declared size is rejected and never uploaded", async () => {
    const destUri = "s3://nemar/on1/objects/SHA256E-s1000--empty.edf";
    const result = await curlStreamCopy(`${baseUrl}/empty`, destUri, REGION);
    expect(result.success).toBe(false);
    expect(result.error).toContain("empty");
    expect(awsInvocations()).toHaveLength(0);
  });

  test("a genuinely 0-byte declared key accepts an empty body (review fix #1)", async () => {
    const destUri = "s3://nemar/on1/objects/SHA256E-s0--reallyempty.edf";
    const result = await curlStreamCopy(`${baseUrl}/empty`, destUri, REGION);
    expect(result.success).toBe(true);
    const invocations = awsInvocations();
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toContain(destUri);
  });

  test("an oversize declared size is rejected by the buffer guard without fetching", async () => {
    // 6GB declared, past MAX_FALLBACK_BUFFER_BYTES (5GB) -- must fail before
    // curl ever runs (review fix #2b: disk-exhaustion guard).
    const destUri = "s3://nemar/on1/objects/SHA256E-s6000000000--huge.edf";
    const result = await curlStreamCopy(`${baseUrl}/full`, destUri, REGION);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeds|limit/i);
    expect(requestCount).toBe(0); // never hit the source
    expect(awsInvocations()).toHaveLength(0); // never attempted the upload
  });
});
