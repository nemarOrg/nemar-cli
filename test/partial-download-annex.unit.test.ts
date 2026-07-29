/**
 * Real git-annex coverage for getDatasetData's partial-retrieval handling (#1038).
 *
 * The pure classifier is covered in partial-download.unit.test.ts; this file
 * exercises the wiring around it: the JSON tally, the failure-note collection
 * feeding the classifier, and the sample cap. It also pins that a run without
 * an onProgress callback tallies identically, since both share one code path.
 *
 * No mocks and no network: a local "remote" annex repo is cloned, and content
 * is dropped from the remote so the clone genuinely cannot fetch it. That
 * reproduces the production shape (some files retrievable, some absent
 * everywhere) with nothing but git-annex on disk. Mirrors the setup in
 * git-annex-precount.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import { getDatasetData } from "../src/lib/git-annex/transfer";

const TMP_DIR = join(import.meta.dir, ".test-partial-annex");
let annexAvailable = true;

function chmodTreeWritable(dir: string): void {
  // git-annex marks object files read-only; rm needs write+execute on dirs.
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        chmodSync(full, 0o755);
      } catch {}
      chmodTreeWritable(full);
    } else {
      try {
        chmodSync(full, 0o644);
      } catch {}
    }
  }
}

async function runCmd(cmd: string[], cwd?: string): Promise<number> {
  const proc = spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  return await proc.exited;
}

/**
 * Build a remote repo with `keep` files whose content stays available and
 * `drop` files whose content is force-dropped (so it exists nowhere), then
 * clone it. The clone can retrieve exactly the kept files.
 */
async function makeClone(name: string, keep: number, drop: number): Promise<string> {
  const remote = join(TMP_DIR, `${name}-remote`);
  mkdirSync(remote, { recursive: true });
  await runCmd(["git", "init", "-q"], remote);
  await runCmd(["git", "config", "user.email", "test@test.com"], remote);
  await runCmd(["git", "config", "user.name", "Test"], remote);
  await runCmd(["git", "annex", "init", "-q", "remote"], remote);
  await runCmd(["git", "annex", "config", "--set", "annex.largefiles", "anything"], remote);

  const names: string[] = [];
  for (let i = 0; i < keep + drop; i++) {
    const f = `f${String(i).padStart(2, "0")}.bin`;
    writeFileSync(join(remote, f), `${f}-`.repeat(64));
    names.push(f);
  }
  await runCmd(["git", "annex", "add", "."], remote);
  await runCmd(["git", "commit", "-q", "-m", "add"], remote);

  const local = join(TMP_DIR, `${name}-clone`);
  await runCmd(["git", "clone", "-q", remote, local]);
  await runCmd(["git", "annex", "init", "-q", "local"], local);

  // Drop content from the remote AFTER cloning, so the clone's location log
  // still points at it but the bytes are gone -- exactly the production shape.
  for (const f of names.slice(keep)) {
    await runCmd(["git", "annex", "drop", "--force", f], remote);
  }
  return local;
}

beforeAll(async () => {
  mkdirSync(TMP_DIR, { recursive: true });
  annexAvailable = (await runCmd(["git", "annex", "version"])) === 0;
});

afterAll(() => {
  if (existsSync(TMP_DIR)) {
    chmodTreeWritable(TMP_DIR);
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

describe("getDatasetData partial retrieval", () => {
  test("streaming path reports a partial run as success", async () => {
    if (!annexAvailable) return;
    const repo = await makeClone("stream-mixed", 2, 3);

    const result = await getDatasetData(repo, { onProgress: () => {} });

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("partial");
    expect(result.filesDownloaded).toBe(2);
    expect(result.filesUnavailable).toBe(3);
    // The JSON path names the files it could not source.
    expect(result.unavailablePaths.length).toBe(3);
  }, 120_000);

  test("a run without onProgress tallies the same way", async () => {
    if (!annexAvailable) return;
    // onProgress only observes the stream; it must not change the tally. Guards
    // against reintroducing a separate text-parsing path, whose output git-annex
    // formats differently across versions under -J.
    const repo = await makeClone("nostream-mixed", 2, 3);

    const result = await getDatasetData(repo);

    expect(result.filesDownloaded).toBe(2);
    expect(result.filesUnavailable).toBe(3);
    expect(result.outcome).toBe("partial");
    expect(result.success).toBe(true);
    // Paths are captured regardless of the callback: one path, one behavior.
    expect(result.unavailablePaths.length).toBe(3);
  }, 120_000);

  test("a fully retrievable dataset is complete", async () => {
    if (!annexAvailable) return;
    const repo = await makeClone("all-present", 3, 0);

    const result = await getDatasetData(repo, { onProgress: () => {} });

    expect(result.outcome).toBe("complete");
    expect(result.success).toBe(true);
    expect(result.filesDownloaded).toBe(3);
    expect(result.filesUnavailable).toBe(0);
  }, 120_000);

  test("requireComplete makes the same partial run fail", async () => {
    if (!annexAvailable) return;
    const repo = await makeClone("strict", 2, 2);

    const result = await getDatasetData(repo, { onProgress: () => {}, requireComplete: true });

    expect(result.outcome).toBe("failed");
    expect(result.success).toBe(false);
    // The failure arm always carries git-annex's own diagnostic text.
    expect(result.error && result.error.length > 0).toBe(true);
  }, 120_000);

  test("unavailable paths are sampled, not unbounded", async () => {
    if (!annexAvailable) return;
    // 12 absent files exceeds MAX_UNAVAILABLE_SAMPLE (10): the count keeps
    // rising while the retained sample stops.
    const repo = await makeClone("sample-cap", 1, 12);

    const result = await getDatasetData(repo, { onProgress: () => {} });

    expect(result.filesUnavailable).toBe(12);
    expect(result.unavailablePaths.length).toBe(10);
  }, 180_000);

  test("a non-annex directory fails as a whole run", async () => {
    if (!annexAvailable) return;
    const plain = join(TMP_DIR, "plain");
    mkdirSync(plain, { recursive: true });

    const result = await getDatasetData(plain, { onProgress: () => {} });

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("failed");
  }, 60_000);
});
