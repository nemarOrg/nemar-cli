/**
 * Pins the runtime export surface of lib/git-annex/* across the #902/#908
 * split (git-annex.ts was decomposed into lib/git-annex/* concern modules
 * and deleted; importers point directly at the concern modules -- no barrel).
 *
 * Why runtime keys: test/ is not typechecked, so an export dropped during a
 * move would otherwise only surface as a distant import failure. This test
 * fails loudly and names the missing/extra symbol instead.
 *
 * Two layers of pinning:
 * - Per-module maps pin PLACEMENT (a symbol silently migrating between
 *   modules breaks importers at runtime even when the union is intact).
 * - The union of all modules minus INTERNAL_WIRING must equal the pre-split
 *   monolith surface (MONOLITH_EXPORTS below, captured at #908 commit 1 and
 *   updated by the declared removals in commits 2-3: the formatBytes
 *   pass-through re-export and the deprecated createDataladDataset/
 *   isDataladDataset aliases).
 *
 * INTERNAL_WIRING lists symbols exported ONLY so sibling git-annex/* modules
 * can import them (declared in #908): not part of the CLI-facing surface.
 *
 * Type-only exports (S3RemoteConfig, PrerequisitesResult, LocalDatasetInfo,
 * ...) do not appear as runtime keys; those are covered by `bun run
 * typecheck`.
 *
 * If this test fails after an intentional API change, update the lists in
 * the same commit and say so in the commit message.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const MODULE_EXPORTS: Record<string, string[]> = {
  "run-command": ["runCommand"],
  prereq: [
    "checkAWSCredentials",
    "checkDownloadPrerequisites",
    "checkGitAnnexInstalled",
    "checkGitHubSSH",
    "checkPrerequisites",
    "isVersionCompatible",
  ],
  init: [
    "ADD_CHUNK_MAX_BYTES",
    "ADD_CHUNK_MAX_PATHS",
    "chunkAddTargets",
    "configureLargefiles",
    "ensureGitAnnexInitialized",
    "gitAnnexAdd",
    "initDataset",
    "isGitAnnexDataset",
  ],
  policy: [
    "ANNEX_DATA_EXTENSIONS",
    "ANNEX_DATA_GLOBS",
    "ANNEX_SIZE_THRESHOLD_BYTES",
    "NEVER_ANNEX_GLOBS",
    "buildLargefilesExpression",
    "isNeverAnnexedMetadata",
    "shouldAnnex",
  ],
  "s3-remote": [
    "ANNEX_REMOTE_EXISTS_RE",
    "DEFAULT_S3_PARTSIZE",
    "NEMAR_S3_REMOTE_NAME",
    "annexRemoteExists",
    "awsCredentialEnv",
    "buildS3RemoteArgs",
    "clearAnnexCredentials",
    "configureS3Remote",
    "enableS3Remote",
    "getAnnexS3Remotes",
    "initOrEnableSpecialRemote",
    "markInheritedOpenNeuroRemotesIgnored",
    "selectAnnexS3Remote",
    "toS3Credentials",
  ],
  github: [
    "acceptGitHubInvitation",
    "configureGitHubRemote",
    "getGitHubToken",
    "githubTokenCredentialHelper",
    "resolveGitHubCloneAuth",
    "verifyGitHubAuth",
  ],
  "clone-push": [
    "cloneDataset",
    "commitRevert",
    "createRevertBranch",
    "isNonFastForwardPush",
    "pushBranch",
    "pushToGitHub",
    "saveDataset",
  ],
  transfer: [
    "MAX_UNAVAILABLE_SAMPLE",
    "batchSetKeysPresent",
    "classifyGetOutcome",
    "collectFileManifest",
    "copyToAnnexRemote",
    "countPendingDownload",
    "dropFiles",
    "dropUnusedAnnexObjects",
    "extractCopyError",
    "extractWhereisKeyUrl",
    "getAnnexWhereisAll",
    "getDatasetData",
    "getKeyHashDir",
    "getKeyHashDirs",
    "getRemoteUuid",
    "setKeyPresent",
  ],
  "repo-state": [
    "detectImportMarker",
    "ensureLocalMainBranch",
    "getCurrentBranch",
    "getDatasetIdFromRemote",
    "getDatasetStats",
    "getLocalDatasetInfo",
    "getVersionCommit",
    "gitFetchOrigin",
    "gitMergeFastForward",
    "isWorkingTreeDirty",
    "listDatasetVersions",
    "readLocalDatasetVersion",
    "readRemoteHeadDatasetVersion",
    "resolveUpstreamRef",
    "switchBranch",
  ],
};

/**
 * Exported only for sibling git-annex/* modules or for unit testing; never part
 * of the CLI-facing surface, so excluded from the MONOLITH_EXPORTS union check.
 * - getGitHubToken: imported by clone-push.ts.
 * - buildS3RemoteArgs / DEFAULT_S3_PARTSIZE / extractCopyError: exported for
 *   #886 unit tests (partsize + copy-error surfacing); internal otherwise.
 * - classifyGetOutcome / MAX_UNAVAILABLE_SAMPLE: exported for #1038 unit tests
 *   (partial-retrieval classification); internal otherwise.
 * - chunkAddTargets / ADD_CHUNK_MAX_PATHS / ADD_CHUNK_MAX_BYTES: exported for
 *   #884 unit tests (argv chunking of targeted adds); internal otherwise.
 * - isVersionCompatible: exported for epic #1225 phase 6 unit tests (the
 *   git-annex version comparator, since checkGitAnnexInstalled() shells out
 *   to the git-annex binary and can't be driven end-to-end offline);
 *   internal otherwise.
 */
const INTERNAL_WIRING = [
  "getGitHubToken",
  "buildS3RemoteArgs",
  "DEFAULT_S3_PARTSIZE",
  "extractCopyError",
  "classifyGetOutcome",
  "MAX_UNAVAILABLE_SAMPLE",
  "chunkAddTargets",
  "ADD_CHUNK_MAX_PATHS",
  "ADD_CHUNK_MAX_BYTES",
  "isVersionCompatible",
  // policy.ts postdates the split (#1158). Its surface is consumed by sibling
  // git-annex modules and by import-openneuro, never by the CLI directly, so
  // none of it belongs to the pre-split monolith surface below.
  "ANNEX_DATA_EXTENSIONS",
  "ANNEX_DATA_GLOBS",
  "ANNEX_SIZE_THRESHOLD_BYTES",
  "NEVER_ANNEX_GLOBS",
  "buildLargefilesExpression",
  "isNeverAnnexedMetadata",
  "shouldAnnex",
];

/**
 * The git-annex.ts monolith's runtime surface: captured at #908 commit 1,
 * minus the declared removals from commits 2-3 (formatBytes pass-through,
 * createDataladDataset/isDataladDataset aliases).
 */
const MONOLITH_EXPORTS = [
  "ANNEX_REMOTE_EXISTS_RE",
  "NEMAR_S3_REMOTE_NAME",
  "acceptGitHubInvitation",
  "annexRemoteExists",
  "awsCredentialEnv",
  "batchSetKeysPresent",
  "checkAWSCredentials",
  "checkDownloadPrerequisites",
  "checkGitAnnexInstalled",
  "checkGitHubSSH",
  "checkPrerequisites",
  "clearAnnexCredentials",
  "cloneDataset",
  "collectFileManifest",
  "commitRevert",
  "configureGitHubRemote",
  "configureLargefiles",
  "configureS3Remote",
  "copyToAnnexRemote",
  "countPendingDownload",
  "createRevertBranch",
  "detectImportMarker",
  "dropFiles",
  "dropUnusedAnnexObjects",
  "enableS3Remote",
  "ensureGitAnnexInitialized",
  "ensureLocalMainBranch",
  "extractWhereisKeyUrl",
  "getAnnexS3Remotes",
  "getAnnexWhereisAll",
  "getCurrentBranch",
  "getDatasetData",
  "getDatasetIdFromRemote",
  "getDatasetStats",
  "getKeyHashDir",
  "getKeyHashDirs",
  "getLocalDatasetInfo",
  "getRemoteUuid",
  "getVersionCommit",
  "gitAnnexAdd",
  "gitFetchOrigin",
  "gitMergeFastForward",
  "githubTokenCredentialHelper",
  "initDataset",
  "initOrEnableSpecialRemote",
  "isGitAnnexDataset",
  "isNonFastForwardPush",
  "isWorkingTreeDirty",
  "listDatasetVersions",
  "markInheritedOpenNeuroRemotesIgnored",
  "pushBranch",
  "pushToGitHub",
  "readLocalDatasetVersion",
  "readRemoteHeadDatasetVersion",
  "resolveGitHubCloneAuth",
  "resolveUpstreamRef",
  "runCommand",
  "saveDataset",
  "selectAnnexS3Remote",
  "setKeyPresent",
  "switchBranch",
  "toS3Credentials",
  "verifyGitHubAuth",
];

describe("lib/git-annex export surface", () => {
  for (const [mod, expected] of Object.entries(MODULE_EXPORTS)) {
    test(`git-annex/${mod} runtime exports match the pin exactly`, async () => {
      const m = await import(`../src/lib/git-annex/${mod}.ts`);
      expect(Object.keys(m).sort()).toEqual(expected);
    });
  }

  test("union of module exports equals the monolith surface", () => {
    const union = new Set(Object.values(MODULE_EXPORTS).flat());
    for (const w of INTERNAL_WIRING) union.delete(w);
    expect([...union].sort()).toEqual(MONOLITH_EXPORTS);
  });

  test("every file in lib/git-annex/ has a pin entry (no orphan modules)", () => {
    const files = readdirSync(join(import.meta.dir, "../src/lib/git-annex"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();
    expect(files).toEqual(Object.keys(MODULE_EXPORTS).sort());
  });
});
