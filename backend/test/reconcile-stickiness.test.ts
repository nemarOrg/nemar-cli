/**
 * Reconcile-stickiness regression (epic #967 phase 4, #971).
 *
 * "The tombstone sticks": once a version DOI is withdrawn (`_status:
 * unavailable`), `reconcileReservedVersionDois` (services/doi-reconcile.ts)
 * must never flip it back to public. If it did, the daily reconcile cron
 * would silently resurrect a withdrawn dataset's version DOI to resolve again
 * while the dataset itself stays private -- a broken, misleading DOI.
 *
 * Review fix (GROUP 3c): reconcileReservedVersionDois used to have its OWN
 * inline `id.status === "reserved"` guard, so this test originally only
 * pinned a *sibling* invariant (classifyExistingVersionDoi, used by
 * createEzidVersionDoi's mint-retry path) that happened to encode the same
 * principle but could not actually catch a regression in the sweep's own
 * logic. The sweep now calls `classifyExistingVersionDoi` itself (only
 * "complete_reserved" ever triggers `makePublic`), so this pin now covers the
 * REAL decision the sweep makes, not just an analogous one.
 *
 * getIdentifier's live EZID status is still not locally seam-able without a
 * registrar, so the sweep LOOP itself (the D1 scan + the live get/makePublic
 * calls) is not exercised here -- only the pure classification it now shares
 * with the mint-retry path. The genuine end-to-end proof -- tombstone a real
 * sandbox DOI, run the real `reconcileReservedVersionDois` against it, assert
 * it stays unavailable -- lives in test/ezid-sandbox.test.ts
 * (RUN_EZID_TESTS=true, gated, real EZID sandbox + real in-memory D1, no
 * mocks).
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
