/**
 * Real-process unit tests for the git helpers added in PR #370.
 *
 * Each test creates a fresh temp git repo via `mkdtempSync` and shells out
 * to git for real (no mocks per project policy). Tests are isolated by
 * construction — each repo is built and torn down in the same test.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectImportMarker,
  isWorkingTreeDirty,
  readLocalDatasetVersion,
  resolveUpstreamRef,
} from "../src/lib/git-annex";

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "nemar-git-helpers-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@nemar.local");
  git(dir, "config", "user.name", "test");
  return dir;
}

function cleanup(dir: string): void {
  // git-annex object dirs can be read-only; force-write before remove.
  rmSync(dir, { recursive: true, force: true });
}

describe("isWorkingTreeDirty", () => {
  test("clean repo returns dirty=false, no error", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "a.txt"), "x");
      git(repo, "add", "a.txt");
      git(repo, "commit", "-qm", "init");
      const result = await isWorkingTreeDirty(repo);
      expect(result).toEqual({ dirty: false });
    } finally {
      cleanup(repo);
    }
  });

  test("modified tracked file is dirty", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "a.txt"), "x");
      git(repo, "add", "a.txt");
      git(repo, "commit", "-qm", "init");
      writeFileSync(join(repo, "a.txt"), "y");
      const result = await isWorkingTreeDirty(repo);
      expect(result.dirty).toBe(true);
      expect(result.error).toBeUndefined();
    } finally {
      cleanup(repo);
    }
  });

  test("untracked file is dirty", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "a.txt"), "x");
      git(repo, "add", "a.txt");
      git(repo, "commit", "-qm", "init");
      writeFileSync(join(repo, "untracked.txt"), "z");
      const result = await isWorkingTreeDirty(repo);
      expect(result.dirty).toBe(true);
    } finally {
      cleanup(repo);
    }
  });

  test("non-repo directory returns error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nemar-not-a-repo-"));
    try {
      const result = await isWorkingTreeDirty(dir);
      expect(result.dirty).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/not a git repository/i);
    } finally {
      cleanup(dir);
    }
  });
});

describe("resolveUpstreamRef", () => {
  test("returns configured upstream when branch tracks origin", async () => {
    const upstream = makeRepo();
    const downstream = mkdtempSync(join(tmpdir(), "nemar-downstream-"));
    try {
      writeFileSync(join(upstream, "f"), "1");
      git(upstream, "add", "f");
      git(upstream, "commit", "-qm", "init");
      // Clone with the working remote so origin/HEAD is set up.
      const result = spawnSync("git", ["clone", "-q", upstream, downstream], {
        encoding: "utf-8",
      });
      if (result.status !== 0) throw new Error(result.stderr);

      const resolved = await resolveUpstreamRef(downstream);
      expect(resolved.error).toBeUndefined();
      // Either the configured upstream (origin/main) or the symbolic origin/HEAD
      // is acceptable; both point at the same commit.
      expect(resolved.ref).toMatch(/^origin\/(main|HEAD)$/);
    } finally {
      cleanup(upstream);
      cleanup(downstream);
    }
  });

  test("returns null with error when no remote is configured", async () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "f"), "1");
      git(repo, "add", "f");
      git(repo, "commit", "-qm", "init");
      const resolved = await resolveUpstreamRef(repo);
      expect(resolved.ref).toBeNull();
      expect(resolved.error).toBeTruthy();
    } finally {
      cleanup(repo);
    }
  });
});

describe("readLocalDatasetVersion", () => {
  test("missing file returns version=null, no error", () => {
    const dir = mkdtempSync(join(tmpdir(), "nemar-no-desc-"));
    try {
      const r = readLocalDatasetVersion(dir);
      expect(r).toEqual({ version: null });
    } finally {
      cleanup(dir);
    }
  });

  test("malformed JSON surfaces error", () => {
    const dir = mkdtempSync(join(tmpdir(), "nemar-bad-desc-"));
    try {
      writeFileSync(join(dir, "dataset_description.json"), "{not json");
      const r = readLocalDatasetVersion(dir);
      expect(r.version).toBeNull();
      expect(r.error).toMatch(/unreadable/i);
    } finally {
      cleanup(dir);
    }
  });

  test("missing DatasetVersion field returns null without error", () => {
    const dir = mkdtempSync(join(tmpdir(), "nemar-no-version-"));
    try {
      writeFileSync(join(dir, "dataset_description.json"), JSON.stringify({ Name: "Test" }));
      const r = readLocalDatasetVersion(dir);
      expect(r).toEqual({ version: null });
    } finally {
      cleanup(dir);
    }
  });

  test("valid DatasetVersion is returned", () => {
    const dir = mkdtempSync(join(tmpdir(), "nemar-good-desc-"));
    try {
      writeFileSync(
        join(dir, "dataset_description.json"),
        JSON.stringify({ Name: "Test", DatasetVersion: "1.2.3" }),
      );
      const r = readLocalDatasetVersion(dir);
      expect(r).toEqual({ version: "1.2.3" });
    } finally {
      cleanup(dir);
    }
  });
});

describe("detectImportMarker", () => {
  test("repo without .nemar/metadata.json returns 'absent'", async () => {
    // Simulates a clone fetched mid-import: the importer hasn't pushed the
    // final metadata commit yet, so the marker file isn't anywhere in
    // history. This is the nemarOrg/nemar-cli#460 case.
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "README.md"), "openneuro ds######");
      git(repo, "add", "README.md");
      git(repo, "commit", "-qm", "initial");
      const result = await detectImportMarker(repo);
      expect(result).toBe("absent");
    } finally {
      cleanup(repo);
    }
  });

  test("repo with committed .nemar/metadata.json returns 'present'", async () => {
    // A completed openneuro import always lands the metadata commit; the
    // CLI must let the user proceed with `git annex get`.
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "README.md"), "openneuro ds######");
      git(repo, "add", "README.md");
      git(repo, "commit", "-qm", "initial");
      mkdirSync(join(repo, ".nemar"));
      writeFileSync(join(repo, ".nemar", "metadata.json"), JSON.stringify({ source: "openneuro" }));
      git(repo, "add", ".nemar/metadata.json");
      git(repo, "commit", "-qm", "Add NEMAR metadata (imported from OpenNeuro ds######)");
      const result = await detectImportMarker(repo);
      expect(result).toBe("present");
    } finally {
      cleanup(repo);
    }
  });

  test("file present in working tree but never committed returns 'absent'", async () => {
    // Guards against a false-positive where a stray untracked .nemar/
    // directory would mask an incomplete import.
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, "README.md"), "x");
      git(repo, "add", "README.md");
      git(repo, "commit", "-qm", "initial");
      mkdirSync(join(repo, ".nemar"));
      writeFileSync(join(repo, ".nemar", "metadata.json"), "{}");
      // Deliberately do NOT git add/commit the file.
      const result = await detectImportMarker(repo);
      expect(result).toBe("absent");
    } finally {
      cleanup(repo);
    }
  });

  test("non-git directory returns 'unknown'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nemar-marker-no-git-"));
    try {
      const result = await detectImportMarker(dir);
      expect(result).toBe("unknown");
    } finally {
      cleanup(dir);
    }
  });
});
