/**
 * Pins the runtime export surface of lib/git-annex across the #902/#908 split
 * (git-annex.ts is decomposed into lib/git-annex/* concern modules and
 * deleted; importers are re-pointed directly at the concern modules -- no
 * barrel).
 *
 * Why runtime keys: test/ is not typechecked, so an export dropped during the
 * move would otherwise only surface as a distant import failure. This test
 * fails loudly and names the missing/extra symbol instead.
 *
 * Type-only exports (S3RemoteConfig, PrerequisitesResult, LocalDatasetInfo,
 * ...) do not appear as runtime keys; those are covered by `bun run
 * typecheck`.
 *
 * The pinned list was captured from the git-annex.ts monolith as of #908
 * commit 1, BEFORE any code moved. Declared intentional removals land in
 * their own commits and update this list there: the formatBytes pass-through
 * (canonical implementation lives in lib/progress.ts) and the deprecated
 * createDataladDataset/isDataladDataset aliases. When the split lands, this
 * test becomes a per-module map whose union must equal this list plus
 * declared wiring exports. If this test fails after an intentional API
 * change, update the list in the same commit and say so in the commit
 * message.
 */

import { describe, expect, test } from "bun:test";

const EXPECTED_EXPORTS = [
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
  test("runtime exports match the pre-split pin exactly", async () => {
    const gitAnnex = await import("../src/lib/git-annex");
    expect(Object.keys(gitAnnex).sort()).toEqual(EXPECTED_EXPORTS);
  });
});
