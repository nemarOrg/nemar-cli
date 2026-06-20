/**
 * Tests for decideImportRecovery (epic #749, Phase 5 / #754): rollback ONLY for
 * the unambiguous orphan; every other case quarantines (safety-critical — pin
 * every branch). Pure function, no I/O, no mocks.
 */

import { describe, expect, test } from "bun:test";
import { SYSTEM_USER_ID } from "../src/lib/constants";
import {
  type ImportGuardState,
  OPENNEURO_UPSTREAM_MARKER,
  classifyRecovery,
  decideImportRecovery,
} from "../src/services/import-recovery";

// The on004395 orphan signature: private, no DOI, no versions, never completed.
function orphan(): ImportGuardState {
  return {
    exists: true,
    visibility: "private",
    conceptDoi: null,
    latestVersionDoi: null,
    versionCount: 0,
    ownerUserId: 42,
    importReachedComplete: false,
  };
}

describe("decideImportRecovery", () => {
  test("unambiguous orphan -> rollback", () => {
    expect(decideImportRecovery(orphan())).toEqual({
      action: "rollback",
      reason: "unambiguous_orphan",
    });
  });

  test("dataset row already gone -> quarantine (not_found_dataset)", () => {
    expect(decideImportRecovery({ ...orphan(), exists: false }).reason).toBe("not_found_dataset");
  });

  test("system-owned catalog row -> quarantine (system_owned), never delete", () => {
    const d = decideImportRecovery({ ...orphan(), ownerUserId: SYSTEM_USER_ID });
    expect(d).toEqual({ action: "quarantine", reason: "system_owned" });
  });

  test("import reached complete -> quarantine (reached_complete)", () => {
    expect(decideImportRecovery({ ...orphan(), importReachedComplete: true }).reason).toBe(
      "reached_complete",
    );
  });

  test("has a concept DOI -> quarantine (has_doi)", () => {
    expect(decideImportRecovery({ ...orphan(), conceptDoi: "10.x/abc" }).reason).toBe("has_doi");
  });

  test("has a version DOI -> quarantine (has_doi)", () => {
    expect(decideImportRecovery({ ...orphan(), latestVersionDoi: "10.x/v1" }).reason).toBe(
      "has_doi",
    );
  });

  test("made public -> quarantine (made_public)", () => {
    expect(decideImportRecovery({ ...orphan(), visibility: "public" }).reason).toBe("made_public");
  });

  test("has a published version -> quarantine (has_version)", () => {
    expect(decideImportRecovery({ ...orphan(), versionCount: 1 }).reason).toBe("has_version");
  });

  test("every quarantine branch returns action=quarantine", () => {
    const states: ImportGuardState[] = [
      { ...orphan(), exists: false },
      { ...orphan(), ownerUserId: SYSTEM_USER_ID },
      { ...orphan(), importReachedComplete: true },
      { ...orphan(), conceptDoi: "x" },
      { ...orphan(), latestVersionDoi: "x" },
      { ...orphan(), visibility: "public" },
      { ...orphan(), versionCount: 3 },
    ];
    for (const s of states) expect(decideImportRecovery(s).action).toBe("quarantine");
  });
});

describe("classifyRecovery (#808 upstream-inaccessible override)", () => {
  test("upstream marker in last_error -> quarantine upstream_inaccessible (overrides rollback)", () => {
    // The orphan would normally roll back; the upstream marker forces a distinct,
    // listable quarantine instead (OpenNeuro-side problem, not a NEMAR bug).
    const lastErr = `${OPENNEURO_UPSTREAM_MARKER} cannot fetch metadata from OpenNeuro: README (HTTP 403)`;
    expect(classifyRecovery(lastErr, orphan())).toEqual({
      action: "quarantine",
      reason: "upstream_inaccessible",
    });
  });

  test("no marker -> defers to decideImportRecovery", () => {
    expect(classifyRecovery("terminal: prepare=failure copy=skipped", orphan())).toEqual(
      decideImportRecovery(orphan()),
    );
    expect(classifyRecovery(null, { ...orphan(), exists: false }).reason).toBe("not_found_dataset");
  });
});
