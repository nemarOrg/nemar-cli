/**
 * Reconcile-stickiness regression (epic #967 phase 4, #971).
 *
 * "The tombstone sticks": once a version DOI is withdrawn (`_status:
 * unavailable`), `reconcileReservedVersionDois` (services/doi-reconcile.ts)
 * must never flip it back to public. If it did, the daily reconcile cron
 * would silently resurrect a withdrawn dataset's version DOI to resolve again
 * while the dataset itself stays private -- a broken, misleading DOI.
 *
 * reconcileReservedVersionDois's actual guard is a live check against EZID
 * (`getIdentifier(...).status === "reserved"`), not a D1 column -- there is no
 * local seam to call it against a real tombstoned identifier without a live
 * registrar, so a mock-free unit test of the sweep loop itself isn't possible
 * here (see withdraw.test.ts's file comment for the same constraint applied
 * to withdrawDataset/restoreDataset). The genuine end-to-end proof --
 * tombstone a real sandbox DOI, run the real reconcile against it, assert it
 * stays unavailable -- lives in test/ezid-sandbox.test.ts (RUN_EZID_TESTS=true,
 * gated, real EZID sandbox, no mocks).
 *
 * What CAN be pinned offline is the sibling decision function the codebase
 * already uses for this exact invariant on the mint-retry path
 * (createEzidVersionDoi's already-exists branch, doi.ts): an `unavailable`
 * identifier is classified "error" (never "complete_reserved" /
 * "return_public"), i.e. never silently resurrected. This test re-asserts
 * that pin under the withdrawal epic so a regression here is caught even if
 * doi-reconcile.test.ts's copy is ever removed or narrowed.
 */

import { describe, expect, test } from "bun:test";
import { classifyExistingVersionDoi } from "../src/services/doi";

describe("withdrawal DOIs are never silently resurrected", () => {
  test("classifyExistingVersionDoi('unavailable') is 'error', not a resurrect path", () => {
    expect(classifyExistingVersionDoi("unavailable")).toBe("error");
    expect(classifyExistingVersionDoi("unavailable")).not.toBe("return_public");
    expect(classifyExistingVersionDoi("unavailable")).not.toBe("complete_reserved");
  });

  test("only 'reserved' completes a stuck mint; 'public'/'unavailable' are left alone", () => {
    expect(classifyExistingVersionDoi("reserved")).toBe("complete_reserved");
    expect(classifyExistingVersionDoi("public")).toBe("return_public");
    expect(classifyExistingVersionDoi("unavailable")).toBe("error");
  });
});
