/**
 * `nemar dataset download --http` against real published datasets.
 *
 * The unit suite covers selection and the worker pool against a local origin.
 * What it cannot cover is the thing most likely to break silently: the shape of
 * the data plane's `manifest.json`. That document is produced by the backend
 * and consumed here by field name (`path`, `size`, `bytes_url`,
 * `checksum_algorithm`), and a rename on either side turns into "downloaded 0
 * files" with no error. So this walks two exemplars end to end and checks what
 * actually landed on disk.
 *
 * Targets are the staging exemplar fleet (`xx0999NN`): small, public,
 * published, and persistent by construction (`is_exemplar=1` exempts them from
 * every cleanup). `xx099900` is the smallest at about 16 MB.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { LIVE_TARGET_BLOCKED } from "./setup";

// A real multi-megabyte transfer over the public internet.
setDefaultTimeout(180_000);

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const SMALLEST_EXEMPLAR = "xx099900";

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "nemar-http-live-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = spawn(["bun", "run", ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NEMAR_NO_UPDATE_CHECK: "1", FORCE_COLOR: "0" },
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

/** File count and byte total the data plane declares for a dataset's latest version. */
async function manifestSummary(
  datasetId: string,
): Promise<{ version: string; metadataFiles: number; totalFiles: number }> {
  const base = `${(process.env.TEST_API_URL ?? "").replace(/\/+$/, "")}/data`;
  const listing = (await (await fetch(`${base}/${datasetId}`)).json()) as {
    latest: string;
  };
  const files = (await (
    await fetch(`${base}/${datasetId}/${listing.latest}/manifest.json`)
  ).json()) as { checksum_algorithm?: string }[];
  return {
    version: listing.latest,
    metadataFiles: files.filter((f) => f.checksum_algorithm === "git").length,
    totalFiles: files.length,
  };
}

describe.skipIf(LIVE_TARGET_BLOCKED)("nemar dataset download --http (live)", () => {
  test("--no-data lands exactly the git-tracked metadata", async () => {
    const summary = await manifestSummary(SMALLEST_EXEMPLAR);
    const out = join(workDir, "metadata-only");

    const { stdout, exitCode } = await runCli([
      "dataset",
      "download",
      SMALLEST_EXEMPLAR,
      "--http",
      "--no-data",
      "-o",
      out,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Method:  HTTP (no git-annex)");
    expect(stdout).toContain(summary.version);
    // The count is the assertion that matters: it fails if manifest.json ever
    // renames the field this path reads, which is otherwise a silent no-op.
    expect(stdout).toContain(`Files:   ${summary.metadataFiles}`);

    const description = join(out, "dataset_description.json");
    expect(existsSync(description)).toBe(true);
    expect(JSON.parse(readFileSync(description, "utf8")).Name).toBeTruthy();
  });

  test("a full download lands the data too, and re-running skips it", async () => {
    const summary = await manifestSummary(SMALLEST_EXEMPLAR);
    const out = join(workDir, "full");

    const first = await runCli(["dataset", "download", SMALLEST_EXEMPLAR, "--http", "-o", out]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toMatch(/Downloaded \d+ files/);
    expect(existsSync(join(out, "dataset_description.json"))).toBe(true);

    // Re-running is the resume path: every file is present at its declared
    // size, so nothing is refetched.
    const second = await runCli(["dataset", "download", SMALLEST_EXEMPLAR, "--http", "-o", out]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("already present");
    expect(second.stdout).toContain("Downloaded 0 files");
    expect(summary.totalFiles).toBeGreaterThan(summary.metadataFiles);
  });

  test("a subject filter narrows the data but keeps the metadata", async () => {
    // The exemplar has one subject, so this checks the shape rather than the
    // arithmetic: a filter that matches nothing must still leave a readable
    // BIDS root behind, and a bogus subject must not silently download
    // everything.
    const out = join(workDir, "filtered");
    const { stdout, exitCode } = await runCli([
      "dataset",
      "download",
      SMALLEST_EXEMPLAR,
      "--http",
      "--subjects",
      "sub-99",
      "-o",
      out,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("subjects: sub-99");
    expect(existsSync(join(out, "dataset_description.json"))).toBe(true);
    expect(existsSync(join(out, "sub-99"))).toBe(false);
  });

  test("an unpublished dataset is refused with an actionable message", async () => {
    // The data plane serves published, public datasets only. The failure has to
    // name git-annex, because that is the route that would have worked.
    const { stdout, exitCode } = await runCli([
      "dataset",
      "download",
      "xx099999",
      "--http",
      "-o",
      join(workDir, "nope"),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("git-annex");
  });
});
