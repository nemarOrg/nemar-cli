/**
 * Pins the runtime export surface of lib/api/* across the #902/#908 split
 * (api.ts was decomposed into lib/api/* endpoint-group modules and deleted;
 * importers point directly at the group modules -- no barrel).
 *
 * Why runtime keys: test/ is not typechecked, so an export dropped during a
 * move would otherwise only surface as a distant import failure. This test
 * fails loudly and names the missing/extra symbol instead.
 *
 * Two layers of pinning:
 * - Per-module maps pin PLACEMENT (a symbol silently migrating between
 *   modules breaks importers at runtime even when the union is intact).
 * - The union of all modules minus INTERNAL_WIRING must equal the pre-split
 *   monolith surface (MONOLITH_EXPORTS below, captured at #908 commit 1
 *   before any code moved) so nothing is dropped or invented.
 *
 * INTERNAL_WIRING lists symbols exported ONLY so sibling api/* modules can
 * import them (declared in #908): they are not part of the CLI-facing
 * surface and must never leak into MONOLITH_EXPORTS.
 *
 * Type-only exports (Dataset, VersionManifest, NemarMetadataPayload, ...) do
 * not appear as runtime keys; those are covered by `bun run typecheck`.
 *
 * If this test fails after an intentional API change, update the lists in
 * the same commit and say so in the commit message.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const MODULE_EXPORTS: Record<string, string[]> = {
  errors: ["ApiError", "MaintenanceError", "errorDetail"],
  client: ["IS_DEV_BUILD", "checkHealth", "request"],
  auth: [
    "checkGitHubUsername",
    "checkOrcidName",
    "checkSSHKeyStatus",
    "checkUsername",
    "completeSandbox",
    "createApiKey",
    "getCurrentUser",
    "getSandboxStatus",
    "listApiKeys",
    "login",
    "pollDeviceToken",
    "registerSSHKey",
    "requestEmailChange",
    "requestKeyRegeneration",
    "requestUploadAccess",
    "resendVerification",
    "resetSandbox",
    "retrieveKey",
    "revokeApiKey",
    "revokeApiKeyWithBearer",
    "signup",
    "startDeviceAuth",
    "startOrcidCliLink",
    "suggestUsername",
    "unlinkOrcid",
    "updateProfile",
    "verifyEmailChange",
  ],
  datasets: [
    "ORCID_REGEX",
    "approveAccessRequest",
    "createDataset",
    "denyAccessRequest",
    "finalizeDataset",
    "getDataset",
    "getFacets",
    "getManifest",
    "getUserCiStatus",
    "getVersionHistory",
    "inviteCollaborator",
    "listAccessRequests",
    "listCollaborators",
    "listDatasets",
    "listManifestVersions",
    "requestDatasetAccess",
    "resolveSourceId",
    "searchDatasets",
    "submitEnrichment",
    "validateDataset",
  ],
  publish: [
    "PUBLICATION_STEPS",
    "approvePublication",
    "denyPublication",
    "getPublishStatus",
    "isRetryablePublishError",
    "listPublishRequests",
    "requestPublication",
    "resendPublishNotification",
    "stepIndexFor",
  ],
  data: [
    "applyS3Lock",
    "getDatasetFiles",
    "requestDownloadCredentials",
    "requestUploadCredentials",
    "requestUploadUrls",
  ],
  admin: [
    "addCi",
    "approveUser",
    "approveUserById",
    "availabilityReport",
    "availabilityReportSweep",
    "availabilityReportSweepReset",
    "backfillUserNames",
    "backfillUsernames",
    "bulkDeleteDatasets",
    "changeUserRole",
    "changeVisibility",
    "clearIdentityConflict",
    "createConceptDoi",
    "createExemplar",
    "createKeyFor",
    "dataIntegritySweep",
    "dataIntegritySweepReset",
    "deleteDataset",
    "dispatchCooldown",
    "dispatchManifest",
    "doctorFix",
    "doctorScan",
    "enforceBulk",
    "enforceDataset",
    "getAdminUserByUsername",
    "getCiStatus",
    "getDoiInfo",
    "getEmailPreferences",
    "getFleetDrift",
    "getImportStatus",
    "getSummaryCoverage",
    "getUserDuplicates",
    "hedSweep",
    "hedSweepReset",
    "importCoverageSweep",
    "importDataset",
    "importIssueTriage",
    "listKeysFor",
    "listUsers",
    "publishDataset",
    "publishVersionDoi",
    "publishZarrCatalog",
    "recordingStatsSweep",
    "recordingStatsSweepReset",
    "reindexBulk",
    "reindexDataset",
    "remintExemplarDois",
    "resetTestDataset",
    "restoreDataset",
    "retryImport",
    "revalidateDataset",
    "revokeKeyFor",
    "revokeUser",
    "revokeUserById",
    "rollbackImport",
    "sendBroadcast",
    "setAccountKind",
    "signalDefaultsSweep",
    "signalDefaultsSweepReset",
    "syncCi",
    "updateDoi",
    "updateEmailPreferences",
    "uploadTierOf",
    "validateCi",
    "verifyImport",
    "withdrawDataset",
    "zarrFidelitySweep",
  ],
  notices: ["NOTICE_LEVELS", "createNotice", "deleteNotice", "getNotices", "listAdminNotices"],
};

/** Exported only for sibling api/* modules; never part of the CLI surface. */
const INTERNAL_WIRING = ["request"];

/**
 * CLI-facing symbols added to lib/api/* AFTER the #908 split.
 *
 * Subtracted from the union like INTERNAL_WIRING, but for the opposite
 * reason: these ARE part of the CLI surface, they simply post-date the
 * monolith. Keeping them in their own list means MONOLITH_EXPORTS stays a
 * faithful capture of what api.ts exported at #908 commit 1, rather than
 * being retro-edited to claim it exported names that never existed there —
 * which would quietly destroy the "nothing invented" guarantee for every
 * future reviewer.
 *
 * Per-module placement is still pinned above, so these get the same
 * protection every other symbol has.
 */
const POST_SPLIT_ADDITIONS = [
  "NOTICE_LEVELS", // #1025, notice level vocabulary
  "approveUserById", // #1012, id-keyed approve for web/ORCID accounts
  "revokeUserById", // #1274, ADR 0040: id-keyed revoke, the approve twin's eraser
  "backfillUserNames", // #1255, epic #1250: POST /admin/users/backfill-names
  "backfillUsernames", // #1253, epic #1250: POST /admin/users/backfill-usernames
  "checkOrcidName", // #1255, epic #1250: GET /auth/orcid-name pre-signup lookup
  "clearIdentityConflict", // #1254, ADR 0043: POST /admin/users/:id/clear-identity-conflict
  "createApiKey", // #1283, epic #1272 phase 3, ADR 0047: POST /auth/keys
  "createKeyFor", // #1284, epic #1272 phase 4, ADR 0048: owner-mint POST /admin/users/:username/keys
  "importCoverageSweep", // #1311, epic #1306 phase 3: POST /admin/imports/coverage-sweep
  "importIssueTriage", // #1310, epic #1306: POST /admin/imports/issue-triage
  "doctorFix", // #1130, CLI wrapper for POST /admin/doctor/fix
  "doctorScan", // #1130, CLI wrapper for POST /admin/doctor/scan
  "getAdminUserByUsername", // #1284 review, epic #1272 phase 4, ADR 0048: GET /admin/users/:username, read by `nemar admin doctor kinds`
  "getFacets", // #1149, epic #1144 phase 5b: GET /datasets/facets for shell completion
  "getUserDuplicates", // #1254, ADR 0043: GET /admin/users/duplicates
  "listApiKeys", // #1283, epic #1272 phase 3, ADR 0047: GET /auth/keys
  "listKeysFor", // #1284, epic #1272 phase 4, ADR 0048: GET /admin/users/:username/keys
  "pollDeviceToken", // #1283, epic #1272 phase 3, ADR 0047: POST /auth/device/token
  "publishZarrCatalog", // #1062, epic #1181 phase 2: POST /admin/zarr-catalog/publish
  "requestEmailChange", // #1266, ADR 0044: POST /auth/email/change/request
  "revokeApiKey", // #1283, epic #1272 phase 3, ADR 0047: DELETE /auth/keys/:id|current
  "revokeApiKeyWithBearer", // #1289 review: DELETE /auth/keys/:id with an explicit bearer, for revoking a just-minted key whose write to disk failed
  "revokeKeyFor", // #1284, epic #1272 phase 4, ADR 0048: DELETE /admin/users/:username/keys/:id
  "setAccountKind", // #1284, epic #1272 phase 4, ADR 0048: POST /admin/users/:username/kind
  "startDeviceAuth", // #1283, epic #1272 phase 3, ADR 0047: POST /auth/device/start
  "startOrcidCliLink", // #1266, ADR 0044: POST /auth/orcid/cli-start
  "suggestUsername", // #1283, epic #1272 phase 3, ADR 0042/0047: GET /auth/profile/username-suggestion
  "unlinkOrcid", // #1266, ADR 0044: POST /auth/orcid/unlink
  "updateProfile", // #1266, ADR 0044: PATCH /auth/profile
  "verifyEmailChange", // #1266, ADR 0044: POST /auth/email/change/verify
  "requestUploadAccess", // #1253, epic #1250: POST /users/me/upload-access/request
  "recordingStatsSweep", // #1194, CLI wrapper for POST /admin/datasets/recording-stats-sweep
  "recordingStatsSweepReset", // #1194, CLI wrapper for the recording-stats sweep reset
  "signalDefaultsSweep", // #1194, CLI wrapper for POST /admin/datasets/signal-defaults-sweep
  "signalDefaultsSweepReset", // #1194, CLI wrapper for the signal-defaults sweep reset
  "uploadTierOf", // #1251, ADR 0040: upload / browse / unknown from a listed row
  "zarrFidelitySweep", // #1068, epic #1181 phase 8: POST /admin/datasets/zarr-fidelity-sweep
];

/** The api.ts monolith's runtime surface, captured at #908 commit 1. */
const MONOLITH_EXPORTS = [
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
  "availabilityReport",
  "availabilityReportSweep",
  "availabilityReportSweepReset",
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
  "createExemplar",
  "createNotice",
  "dataIntegritySweep",
  "dataIntegritySweepReset",
  "deleteDataset",
  "deleteNotice",
  "denyAccessRequest",
  "denyPublication",
  "dispatchCooldown",
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
  "remintExemplarDois",
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
  "restoreDataset",
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
  "verifyImport",
  "withdrawDataset",
];

describe("lib/api export surface", () => {
  for (const [mod, expected] of Object.entries(MODULE_EXPORTS)) {
    test(`api/${mod} runtime exports match the pin exactly`, async () => {
      const m = await import(`../src/lib/api/${mod}.ts`);
      expect(Object.keys(m).sort()).toEqual(expected);
    });
  }

  test("union of module exports equals the monolith surface", () => {
    const union = new Set(Object.values(MODULE_EXPORTS).flat());
    for (const w of INTERNAL_WIRING) union.delete(w);
    for (const a of POST_SPLIT_ADDITIONS) union.delete(a);
    expect([...union].sort()).toEqual(MONOLITH_EXPORTS);
  });

  test("every file in lib/api/ has a pin entry (no orphan modules)", () => {
    const files = readdirSync(join(import.meta.dir, "../src/lib/api"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();
    expect(files).toEqual(Object.keys(MODULE_EXPORTS).sort());
  });
});
