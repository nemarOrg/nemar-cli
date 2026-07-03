/**
 * Pins the runtime export surface of lib/api across the #902/#908 split
 * (api.ts is decomposed into lib/api/* endpoint-group modules and deleted;
 * importers are re-pointed directly at the group modules -- no barrel).
 *
 * Why runtime keys: test/ is not typechecked, so an export dropped during the
 * move would otherwise only surface as a distant import failure. This test
 * fails loudly and names the missing/extra symbol instead.
 *
 * Type-only exports (Dataset, VersionManifest, NemarMetadataPayload, ...) do
 * not appear as runtime keys; those are covered by `bun run typecheck`.
 *
 * The pinned list was captured from the api.ts monolith as of #908 commit 1,
 * BEFORE any code moved. When the split lands, this test becomes a per-module
 * map whose union must equal this list plus declared wiring exports. If this
 * test fails after an intentional API change, update the list in the same
 * commit and say so in the commit message.
 */

import { describe, expect, test } from "bun:test";

const EXPECTED_EXPORTS = [
  "ApiError",
  "IS_DEV_BUILD",
  "MaintenanceError",
  "ORCID_REGEX",
  "PUBLICATION_STEPS",
  "addCi",
  "applyS3Lock",
  "approveAccessRequest",
  "approvePublication",
  "approveUser",
  "bulkDeleteDatasets",
  "changeUserRole",
  "changeVisibility",
  "checkGitHubUsername",
  "checkHealth",
  "checkSSHKeyStatus",
  "checkUsername",
  "completeSandbox",
  "createConceptDoi",
  "createDataset",
  "createNotice",
  "deleteDataset",
  "deleteNotice",
  "denyAccessRequest",
  "denyPublication",
  "dispatchManifest",
  "enforceBulk",
  "enforceDataset",
  "errorDetail",
  "finalizeDataset",
  "getCiStatus",
  "getCurrentUser",
  "getDataset",
  "getDatasetFiles",
  "getDoiInfo",
  "getEmailPreferences",
  "getFleetDrift",
  "getImportStatus",
  "getManifest",
  "getNotices",
  "getPublishStatus",
  "getSandboxStatus",
  "getSummaryCoverage",
  "getUserCiStatus",
  "getVersionHistory",
  "hedSweep",
  "hedSweepReset",
  "importDataset",
  "inviteCollaborator",
  "isRetryablePublishError",
  "listAccessRequests",
  "listAdminNotices",
  "listCollaborators",
  "listDatasets",
  "listManifestVersions",
  "listPublishRequests",
  "listUsers",
  "login",
  "publishDataset",
  "publishVersionDoi",
  "registerSSHKey",
  "reindexBulk",
  "reindexDataset",
  "requestDatasetAccess",
  "requestDownloadCredentials",
  "requestKeyRegeneration",
  "requestPublication",
  "requestUploadCredentials",
  "requestUploadUrls",
  "resendPublishNotification",
  "resendVerification",
  "resetSandbox",
  "resetTestDataset",
  "resolveSourceId",
  "retrieveKey",
  "retryImport",
  "revalidateDataset",
  "revokeUser",
  "rollbackImport",
  "searchDatasets",
  "sendBroadcast",
  "signup",
  "stepIndexFor",
  "submitEnrichment",
  "syncCi",
  "updateDoi",
  "updateEmailPreferences",
  "validateCi",
  "validateDataset",
];

describe("lib/api export surface", () => {
  test("runtime exports match the pre-split pin exactly", async () => {
    const api = await import("../src/lib/api");
    expect(Object.keys(api).sort()).toEqual(EXPECTED_EXPORTS);
  });
});
