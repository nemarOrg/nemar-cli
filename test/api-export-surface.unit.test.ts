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
    "checkSSHKeyStatus",
    "checkUsername",
    "completeSandbox",
    "getCurrentUser",
    "getSandboxStatus",
    "login",
    "registerSSHKey",
    "requestKeyRegeneration",
    "resendVerification",
    "resetSandbox",
    "retrieveKey",
    "signup",
  ],
  datasets: [
    "ORCID_REGEX",
    "approveAccessRequest",
    "createDataset",
    "denyAccessRequest",
    "finalizeDataset",
    "getDataset",
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
    "bulkDeleteDatasets",
    "changeUserRole",
    "changeVisibility",
    "createConceptDoi",
    "createExemplar",
    "dataIntegritySweep",
    "dataIntegritySweepReset",
    "deleteDataset",
    "dispatchCooldown",
    "dispatchManifest",
    "doctorFix",
    "doctorScan",
    "enforceBulk",
    "enforceDataset",
    "getCiStatus",
    "getDoiInfo",
    "getEmailPreferences",
    "getFleetDrift",
    "getImportStatus",
    "getSummaryCoverage",
    "hedSweep",
    "hedSweepReset",
    "importDataset",
    "listUsers",
    "publishDataset",
    "publishVersionDoi",
    "reindexBulk",
    "reindexDataset",
    "remintExemplarDois",
    "resetTestDataset",
    "restoreDataset",
    "retryImport",
    "revalidateDataset",
    "revokeUser",
    "rollbackImport",
    "sendBroadcast",
    "syncCi",
    "updateDoi",
    "updateEmailPreferences",
    "validateCi",
    "verifyImport",
    "withdrawDataset",
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
  "doctorFix", // #1130, CLI wrapper for POST /admin/doctor/fix
  "doctorScan", // #1130, CLI wrapper for POST /admin/doctor/scan
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
