/**
 * `findUnannexedData` against a repo built the way OpenNeuro builds one.
 *
 * OpenNeuro decides what to annex by size alone (~1 MB), NEMAR by the policy in
 * git-annex/policy.ts. The gap between those two rules is what this detector
 * exists to surface, so the fixture reproduces the gap for real: a repo whose
 * largefiles config is OpenNeuro's, populated so that files land on both sides
 * of it, then inspected with NEMAR's rule. No stubbing of either rule.
 *
 * ds007788 is the live instance -- 893 `_motion.tsv` recordings (675 MB) left as
 * git blobs because each is under 1 MB, alongside 690 annexed siblings.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitAnnexAdd, initDataset } from "../src/lib/git-annex/init";
import { runCommand } from "../src/lib/git-annex/run-command";
import { findUnannexedData } from "../src/lib/import-openneuro";

/** OpenNeuro's rule: size alone, ~1 MB, no notion of extension. */
const UPSTREAM_LARGEFILES = "largerthan=1mb";

const FIXTURES: Array<{ path: string; size: number }> = [
  // Under 1 MB, so upstream keeps it in git -- but it is a recording. This is
  // exactly the ds007788 shape and the file the detector has to catch.
  { path: "sub-01/motion/sub-01_task-walk_tracksys-exo_motion.tsv", size: 800_000 },
  { path: "sub-01/motion/sub-01_task-rest_tracksys-exo_motion.tsv", size: 240_000 },
  // Over 1 MB, so upstream already annexed it. Already correct, must not be
  // reported.
  { path: "sub-01/motion/sub-01_task-long_tracksys-exo_motion.tsv", size: 1_500_000 },
  { path: "sub-01/eeg/sub-01_task-rest_eeg.edf", size: 2_000_000 },
  // Metadata, whatever its size. Must never be reported.
  { path: "sub-01/eeg/sub-01_task-rest_events.tsv", size: 300_000 },
  { path: "sub-01/motion/sub-01_task-walk_tracksys-exo_channels.tsv", size: 200_000 },
  { path: "participants.tsv", size: 500 },
  { path: "dataset_description.json", size: 400 },
];

let repoDir: string;

// git-annex marks object files read-only; rm needs write+execute on dirs.
function chmodTreeWritable(dir: string): void {
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

beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), "nemar-upstream-clone-"));

  const init = await initDataset(repoDir);
  if (!init.success) throw new Error(`initDataset failed: ${init.error}`);

  // Upstream's rule, NOT ours -- this repo stands in for the OpenNeuro clone.
  const cfg = await runCommand(
    ["git", "annex", "config", "--set", "annex.largefiles", UPSTREAM_LARGEFILES],
    { cwd: repoDir },
  );
  if (cfg.exitCode !== 0) throw new Error(`largefiles config failed: ${cfg.stderr}`);

  for (const f of FIXTURES) {
    const abs = join(repoDir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "x".repeat(f.size));
  }

  const added = await gitAnnexAdd(
    repoDir,
    FIXTURES.map((f) => f.path),
  );
  if (!added.success) throw new Error(`gitAnnexAdd failed: ${added.error}`);

  const commit = await runCommand(["git", "commit", "-m", "upstream state"], { cwd: repoDir });
  if (commit.exitCode !== 0) throw new Error(`commit failed: ${commit.stderr}`);
}, 120_000);

afterAll(() => {
  if (!repoDir) return;
  chmodTreeWritable(repoDir);
  rmSync(repoDir, { recursive: true, force: true });
});

describe("findUnannexedData", () => {
  test("the fixture really did reproduce the upstream split", async () => {
    // Guard the premise: if upstream's rule stopped splitting these files, the
    // assertions below would pass for the wrong reason. Ask git-annex, not the
    // index mode -- on an adjusted-unlock branch an annexed file is not a
    // symlink, which is the trap this whole test caught in the first place.
    const { stdout, exitCode } = await runCommand(["git", "annex", "find", "--include", "*"], {
      cwd: repoDir,
    });
    expect(exitCode).toBe(0);
    const annexed = new Set(stdout.split("\n").filter(Boolean));
    // Under 1 MB: upstream left it in git, though it is a recording.
    expect(annexed.has("sub-01/motion/sub-01_task-walk_tracksys-exo_motion.tsv")).toBe(false);
    // Over 1 MB: upstream annexed it, so it is already where NEMAR wants it.
    expect(annexed.has("sub-01/motion/sub-01_task-long_tracksys-exo_motion.tsv")).toBe(true);
  });

  test("reports exactly the recordings upstream left in git", async () => {
    const found = await findUnannexedData(repoDir);
    expect(found.map((f) => f.path).sort()).toEqual([
      "sub-01/motion/sub-01_task-rest_tracksys-exo_motion.tsv",
      "sub-01/motion/sub-01_task-walk_tracksys-exo_motion.tsv",
    ]);
  });

  test("does not report files upstream already annexed", async () => {
    const found = await findUnannexedData(repoDir);
    const paths = found.map((f) => f.path);
    expect(paths).not.toContain("sub-01/motion/sub-01_task-long_tracksys-exo_motion.tsv");
    expect(paths).not.toContain("sub-01/eeg/sub-01_task-rest_eeg.edf");
  });

  test("does not report metadata, however large", async () => {
    const found = await findUnannexedData(repoDir);
    const paths = found.map((f) => f.path);
    expect(paths).not.toContain("sub-01/eeg/sub-01_task-rest_events.tsv");
    expect(paths).not.toContain("sub-01/motion/sub-01_task-walk_tracksys-exo_channels.tsv");
    expect(paths).not.toContain("participants.tsv");
    expect(paths).not.toContain("dataset_description.json");
  });

  test("reports real byte sizes so the warning can be quantified", async () => {
    const found = await findUnannexedData(repoDir);
    const bytes = found.reduce((sum, f) => sum + f.size, 0);
    expect(bytes).toBe(800_000 + 240_000);
  });

  test("a clean dataset reports nothing", async () => {
    const clean = mkdtempSync(join(tmpdir(), "nemar-clean-clone-"));
    try {
      const init = await initDataset(clean);
      if (!init.success) throw new Error(`initDataset failed: ${init.error}`);
      mkdirSync(join(clean, "sub-01/eeg"), { recursive: true });
      writeFileSync(join(clean, "participants.tsv"), "id\n");
      writeFileSync(join(clean, "dataset_description.json"), "{}");
      const added = await gitAnnexAdd(clean, ["participants.tsv", "dataset_description.json"]);
      if (!added.success) throw new Error(`gitAnnexAdd failed: ${added.error}`);
      expect(await findUnannexedData(clean)).toEqual([]);
    } finally {
      chmodTreeWritable(clean);
      rmSync(clean, { recursive: true, force: true });
    }
  }, 60_000);
});
