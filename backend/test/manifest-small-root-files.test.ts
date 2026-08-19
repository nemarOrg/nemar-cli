/**
 * Regression test for nemarOrg/nemar-cli#509:
 *
 * Small regular git-tracked files at the dataset root (README.md, CHANGES,
 * dataset_description.json, .gitattributes) were silently dropped from the
 * manifest because they fell into the "annex pointer candidate" size band
 * (20-500 bytes), failed parseAnnexPointer, then got filtered OUT of the
 * regular-files loop as well.
 *
 * This test asserts that:
 *   1. Small regular files at root are present in the manifest as git:* keys
 *   2. Real annex pointers in the same size band still resolve correctly
 *   3. `.gitattributes` is NOT excluded by an accidental `.git` substring match
 *   4. `.git/` and `.github/` plumbing IS still excluded
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Preserve the real module and override only the two functions generateManifest
// calls. Other tests in the suite transitively import the github service
// (webhooks, datasets routes pull ensureMainBranch etc.), so we must not
// replace the entire module export shape.
const fakeTree: Array<{
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}> = [];
const fakeBlobs: Record<string, string> = {};

const realGithub = await import("../src/services/github");
mock.module("../src/services/github", () => ({
  ...realGithub,
  getTreeAtRef: async () => fakeTree,
  getBlobContent: async (_repo: string, sha: string) => fakeBlobs[sha] ?? "",
}));

const { generateManifest } = await import("../src/services/manifest");

function blob(path: string, sha: string, size: number, content = ""): void {
  fakeTree.push({ path, mode: "100644", type: "blob", sha, size });
  fakeBlobs[sha] = content;
}

beforeEach(() => {
  fakeTree.length = 0;
  for (const k of Object.keys(fakeBlobs)) delete fakeBlobs[k];
});

describe("generateManifest — small root file handling (issue #509)", () => {
  test("includes small regular root files that are not annex pointers", async () => {
    // Shape mirrors nemarDatasets/on005262 at v1.0.0 (real sizes from gh api).
    blob(".gitattributes", "sha-gitattrs", 427, "*.edf annex.largefiles=anything");
    blob("CHANGES", "sha-changes", 66, "v1.0.0\nInitial import from OpenNeuro\n");
    blob("README.md", "sha-readme", 432, "# ArEEG: Arabic EEG Dataset\n\nInner speech EEG...");
    blob("dataset_description.json", "sha-dd", 461, '{"Name":"ArEEG","BIDSVersion":"1.9.0"}');
    // A real annex pointer in the same size band:
    blob("sub-0/eeg/x.edf", "sha-ptr", 180, "/annex/objects/SHA256E-s12345--abc123.edf\n");

    // skipGitBackedVerification: the canary added in #503 HEADs
    // raw.githubusercontent.com for git:-keyed paths. The mocked tree above
    // uses synthetic SHAs / tags that don't exist on real GitHub, so the
    // canary would 404 unrelated to what this test exercises. Skip it.
    const m = await generateManifest(
      "nemarDatasets/on005262",
      "v1.0.0",
      "fake-pat",
      "on005262",
      null,
      null,
      { skipGitBackedVerification: true },
    );

    expect(Object.keys(m.files).sort()).toEqual(
      [
        ".gitattributes",
        "CHANGES",
        "README.md",
        "dataset_description.json",
        "sub-0/eeg/x.edf",
      ].sort(),
    );

    // Regular files use git:<sha> keys
    expect(m.files["README.md"]).toEqual({
      key: "git:sha-readme",
      size: 432,
      checksum: "git:sha-readme",
    });
    expect(m.files.CHANGES.key).toBe("git:sha-changes");
    expect(m.files[".gitattributes"].key).toBe("git:sha-gitattrs");

    // Annex pointer resolves to its parsed key
    expect(m.files["sub-0/eeg/x.edf"].key).toBe("SHA256E-s12345--abc123.edf");
    expect(m.files["sub-0/eeg/x.edf"].size).toBe(12345);
  });

  test("excludes .git/ plumbing but keeps .gitattributes", async () => {
    blob(".git/config", "sha-gitconfig", 200, "[core]");
    blob(".github/workflows/ci.yml", "sha-ci", 300, "name: CI");
    blob(".gitattributes", "sha-gitattrs", 100, "* text=auto");
    blob("README.md", "sha-readme", 50, "# hi");

    const m = await generateManifest("test/repo", "v1.0.0", "fake-pat", "test", null, null, {
      skipGitBackedVerification: true,
    });

    expect(m.files[".gitattributes"]).toBeDefined();
    expect(m.files["README.md"]).toBeDefined();
    expect(m.files[".git/config"]).toBeUndefined();
    expect(m.files[".github/workflows/ci.yml"]).toBeUndefined();
  });

  test("large root files still flow through the regular-files path (regression for nm*)", async () => {
    // nm000104 shape: README.md is 9763 bytes — above the 500-byte pointer
    // candidate threshold, so it never enters the candidate loop.
    blob("README.md", "sha-readme-big", 9763, "# Dataset\n\n...lots of text...");
    blob("participants.tsv", "sha-participants", 2291, "subject_id\tage\n");

    const m = await generateManifest("test/repo", "v1.0.0", "fake-pat", "test", null, null, {
      skipGitBackedVerification: true,
    });

    expect(m.files["README.md"].key).toBe("git:sha-readme-big");
    expect(m.files["README.md"].size).toBe(9763);
    expect(m.files["participants.tsv"].key).toBe("git:sha-participants");
  });

  test("annex pointer candidates that resolve still take precedence over the regular-files fallback", async () => {
    // A 200-byte blob whose CONTENT is a valid annex pointer should be recorded
    // as an annex entry (with the parsed key), NOT as a git:<sha> entry.
    blob("sub-1/eeg/data.bdf", "sha-ptr", 200, "/annex/objects/MD5E-s987654--cafebabe.bdf");

    const m = await generateManifest("test/repo", "v1.0.0", "fake-pat", "test", null, null, {
      skipGitBackedVerification: true,
    });

    expect(m.files["sub-1/eeg/data.bdf"]).toEqual({
      key: "MD5E-s987654--cafebabe.bdf",
      size: 987654,
      checksum: "md5:cafebabe",
    });
  });
});
