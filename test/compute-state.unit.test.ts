/**
 * The compute gateway's state machine and fixed words (epic #2005, phase A1 #2006; ADR 0118).
 *
 * The edge table is checked against an independent list written out here edge by edge, so a
 * change to the table must also change this test, and every other pair of the 10 x 10 is asserted
 * refused. That is what makes "the only edges a write may take" a tested sentence. The module is
 * pure and import-free; the test reads its source to hold it to that.
 *
 * The Tapis conditions below are copied from the `Job.condition` enum of Tapis's published Jobs
 * OpenAPI specification (read 2026-11-03). No response has been recorded from a real tenant yet,
 * so this is the published vocabulary, not an observation.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as words from "../shared/compute-state";
import {
  COMPUTE_CANCEL_REASONS,
  COMPUTE_JOB_FLAGS,
  COMPUTE_KINDS,
  COMPUTE_REFUSAL_CODES,
  COMPUTE_REFUSAL_STATUS,
  COMPUTE_SOURCES,
  COMPUTE_STATES,
  COMPUTE_TRANSITIONS,
  COMPUTE_WORD_RE,
  type ComputeState,
  LAUNCHER_FAILURE_CODES,
  LEDGER_ENTRY_KINDS,
  LIVE_COMPUTE_STATES,
  PLATFORM_FAILURE_CODES,
  RESULT_REFUSAL_DETAILS,
  TERMINAL_COMPUTE_STATES,
  canTransitionCompute,
  failureCodeFromTapisCondition,
  isPlatformFailure,
  launcherExitNumber,
  stateFromTapisStatus,
} from "../shared/compute-state";

/** The edges, written out once more so the table cannot drift unseen. 53 of the 100 pairs. */
const EDGES: ReadonlyArray<readonly [ComputeState, ComputeState]> = [
  ["created", "created"],
  ["created", "uploading"],
  ["created", "submitted"],
  ["created", "queued"],
  ["created", "running"],
  ["created", "archiving"],
  ["created", "finished"],
  ["created", "failed"],
  ["created", "cancelled"],
  ["created", "unreported"],

  ["uploading", "uploading"],
  ["uploading", "submitted"],
  ["uploading", "queued"],
  ["uploading", "running"],
  ["uploading", "archiving"],
  ["uploading", "finished"],
  ["uploading", "failed"],
  ["uploading", "cancelled"],
  ["uploading", "unreported"],

  ["submitted", "submitted"],
  ["submitted", "queued"],
  ["submitted", "running"],
  ["submitted", "archiving"],
  ["submitted", "finished"],
  ["submitted", "failed"],
  ["submitted", "cancelled"],
  ["submitted", "unreported"],

  ["queued", "queued"],
  ["queued", "running"],
  ["queued", "archiving"],
  ["queued", "finished"],
  ["queued", "failed"],
  ["queued", "cancelled"],
  ["queued", "unreported"],

  ["running", "running"],
  ["running", "archiving"],
  ["running", "finished"],
  ["running", "failed"],
  ["running", "cancelled"],
  ["running", "unreported"],

  ["archiving", "archiving"],
  ["archiving", "finished"],
  ["archiving", "failed"],
  ["archiving", "cancelled"],
  ["archiving", "unreported"],

  // `unreported` leaves to any state from `submitted` on, never back to `created` or `uploading`.
  ["unreported", "unreported"],
  ["unreported", "submitted"],
  ["unreported", "queued"],
  ["unreported", "running"],
  ["unreported", "archiving"],
  ["unreported", "finished"],
  ["unreported", "failed"],
  ["unreported", "cancelled"],
];

describe("the edges", () => {
  test("there are ten states and a hundred ordered pairs", () => {
    expect([...COMPUTE_STATES]).toEqual([
      "created",
      "uploading",
      "submitted",
      "queued",
      "running",
      "archiving",
      "finished",
      "failed",
      "cancelled",
      "unreported",
    ]);
    expect(new Set(COMPUTE_STATES).size).toBe(10);
  });

  test("every listed edge is allowed", () => {
    for (const [from, to] of EDGES) {
      expect(canTransitionCompute(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  test("every other pair of the hundred is refused", () => {
    const allowed = new Set(EDGES.map(([a, b]) => `${a}>${b}`));
    expect(allowed.size).toBe(EDGES.length);
    expect(EDGES.length).toBe(53);
    let refused = 0;
    for (const from of COMPUTE_STATES) {
      for (const to of COMPUTE_STATES) {
        if (allowed.has(`${from}>${to}`)) continue;
        expect(canTransitionCompute(from, to), `${from} -> ${to}`).toBe(false);
        refused++;
      }
    }
    expect(refused).toBe(100 - EDGES.length);
  });

  test("the table holds exactly the listed edges and no others", () => {
    const fromTable = new Set<string>();
    for (const from of COMPUTE_STATES) {
      for (const to of COMPUTE_TRANSITIONS[from]) fromTable.add(`${from}>${to}`);
    }
    expect(fromTable).toEqual(new Set(EDGES.map(([a, b]) => `${a}>${b}`)));
  });

  test("a terminal state has no edge out, not even to itself", () => {
    for (const s of TERMINAL_COMPUTE_STATES) {
      expect(COMPUTE_TRANSITIONS[s]).toEqual([]);
      expect(canTransitionCompute(s, s)).toBe(false);
    }
  });

  test("terminal and live states split the ten, and unreported is live", () => {
    expect([...TERMINAL_COMPUTE_STATES]).toEqual(["finished", "failed", "cancelled"]);
    expect([...LIVE_COMPUTE_STATES].sort() as string[]).toEqual(
      ["created", "uploading", "submitted", "queued", "running", "archiving", "unreported"].sort(),
    );
    expect(LIVE_COMPUTE_STATES).toContain("unreported");
    const union = new Set([...LIVE_COMPUTE_STATES, ...TERMINAL_COMPUTE_STATES]);
    expect(union.size).toBe(10);
    expect(LIVE_COMPUTE_STATES.length + TERMINAL_COMPUTE_STATES.length).toBe(10);
  });

  test("every live state may repeat itself and may end failed or cancelled", () => {
    for (const s of LIVE_COMPUTE_STATES) {
      expect(canTransitionCompute(s, s)).toBe(true);
      expect(canTransitionCompute(s, "failed")).toBe(true);
      expect(canTransitionCompute(s, "cancelled")).toBe(true);
    }
  });

  test("unreported is reachable from every live state", () => {
    for (const s of LIVE_COMPUTE_STATES) expect(canTransitionCompute(s, "unreported")).toBe(true);
    for (const s of TERMINAL_COMPUTE_STATES) {
      expect(canTransitionCompute(s, "unreported")).toBe(false);
    }
  });

  test("no edge goes backwards along the happy path", () => {
    const path = [
      "created",
      "uploading",
      "submitted",
      "queued",
      "running",
      "archiving",
      "finished",
    ] as const;
    for (const [from, to] of EDGES) {
      const a = (path as readonly string[]).indexOf(from);
      const b = (path as readonly string[]).indexOf(to);
      if (a < 0 || b < 0) continue;
      expect(b, `${from} -> ${to}`).toBeGreaterThanOrEqual(a);
    }
  });

  test("a value that is not a state is refused, including names on Object.prototype", () => {
    for (const bad of ["bogus", "", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(canTransitionCompute(bad as ComputeState, "created")).toBe(false);
      expect(canTransitionCompute("created", bad as ComputeState)).toBe(false);
    }
  });
});

describe("Tapis statuses", () => {
  // The thirteen statuses of the published specification and the one state each maps to.
  const EXPECTED: ReadonlyArray<readonly [string, ComputeState]> = [
    ["PENDING", "submitted"],
    ["PROCESSING_INPUTS", "submitted"],
    ["STAGING_INPUTS", "submitted"],
    ["STAGING_JOB", "submitted"],
    ["SUBMITTING_JOB", "submitted"],
    ["BLOCKED", "submitted"],
    ["PAUSED", "submitted"],
    ["QUEUED", "queued"],
    ["RUNNING", "running"],
    ["ARCHIVING", "archiving"],
    ["FINISHED", "finished"],
    ["FAILED", "failed"],
    ["CANCELLED", "cancelled"],
  ];

  test("each of the thirteen maps to one state", () => {
    expect(EXPECTED).toHaveLength(13);
    expect(new Set(EXPECTED.map(([s]) => s)).size).toBe(13);
    for (const [status, expected] of EXPECTED) {
      expect(stateFromTapisStatus(status), status).toBe(expected);
    }
  });

  test("BLOCKED and PAUSED map to submitted", () => {
    expect(stateFromTapisStatus("BLOCKED")).toBe("submitted");
    expect(stateFromTapisStatus("PAUSED")).toBe("submitted");
  });

  test("an unknown status is null, never guessed", () => {
    for (const bad of [
      "",
      "running",
      "Running",
      "HIDDEN",
      "constructor",
      "__proto__",
      "toString",
    ]) {
      expect(stateFromTapisStatus(bad), bad).toBeNull();
    }
  });

  test("the module lists exactly the thirteen", () => {
    expect([...words.TAPIS_JOB_STATUSES].sort() as string[]).toEqual(
      EXPECTED.map(([s]) => s).sort(),
    );
  });

  test("a mapped state is never `created`, `uploading` or `unreported`", () => {
    for (const [status] of EXPECTED) {
      expect(["created", "uploading", "unreported"]).not.toContain(stateFromTapisStatus(status));
    }
  });
});

describe("fixed words", () => {
  test("COMPUTE_WORD_RE is lowercase letters, digits and underscore, 1 to 64", () => {
    for (const ok of ["a", "z9", "snake_case", "_", "0", "a".repeat(64)]) {
      expect(COMPUTE_WORD_RE.test(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "A",
      "kebab-case",
      "a b",
      " a",
      "a ",
      "a\n",
      "a.b",
      "é",
      "a".repeat(65),
    ]) {
      expect(COMPUTE_WORD_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  test("every word list the module exports matches COMPUTE_WORD_RE", () => {
    // Walk the module's exports so a list added later cannot skip the check. The Tapis statuses
    // are Tapis's own upper-case vocabulary and are not NEMAR words.
    const lists = Object.entries(words).filter(
      ([name, value]) =>
        name !== "TAPIS_JOB_STATUSES" &&
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((v) => typeof v === "string"),
    );
    expect(lists.length).toBeGreaterThanOrEqual(10);
    for (const [name, list] of lists) {
      for (const w of list as string[]) expect(COMPUTE_WORD_RE.test(w), `${name}: ${w}`).toBe(true);
    }
  });

  test("a word list has no duplicates", () => {
    for (const [name, value] of Object.entries(words)) {
      if (!Array.isArray(value)) continue;
      expect(new Set(value).size, name).toBe(value.length);
    }
  });

  test("the smaller vocabularies are exactly the ones the design names", () => {
    expect([...LEDGER_ENTRY_KINDS]).toEqual([
      "grant",
      "hold",
      "release",
      "charge",
      "refund",
      "adjust",
      "overrun",
      "expire",
    ]);
    expect([...COMPUTE_SOURCES]).toEqual(["cli", "web", "partner", "pipeline"]);
    expect([...COMPUTE_KINDS]).toEqual(["batch", "interactive"]);
    expect([...COMPUTE_JOB_FLAGS]).toEqual(["unreserved", "unattributed", "mismatch", "overrun"]);
    expect([...COMPUTE_CANCEL_REASONS]).toEqual([
      "user",
      "admin",
      "account_ended",
      "unreserved",
      "unattributed",
      "scheduler",
    ]);
    expect([...RESULT_REFUSAL_DETAILS]).toEqual([
      "results_too_large",
      "results_quota_exceeded",
      "too_many_outputs",
    ]);
  });
});

describe("refusal codes", () => {
  // Section 6's seven, then the rest in the order the phase issue lists them, each with the HTTP
  // status a route answers. The statuses are the module's to declare once (the phase issue names
  // the table, not its values); a route that disagrees with this table is the bug.
  const EXPECTED: ReadonlyArray<readonly [string, number]> = [
    ["no_compute_access", 403],
    ["suspended", 403],
    ["insufficient_balance", 409],
    ["over_job_limit", 422],
    ["over_concurrency", 409],
    ["platform_budget_exhausted", 409],
    ["client_cap_reached", 409],
    ["invalid_spec", 400],
    ["over_ceiling", 422],
    ["partition_not_offered", 422],
    ["runtime_unavailable", 422],
    ["registry_not_allowed", 422],
    ["compute_disabled", 503],
    ["dataset_not_eligible", 422],
    ["recipe_unknown", 422],
    ["pipelines_account_missing", 503],
    ["live_attempt_exists", 409],
    ["bundle_too_large", 413],
    ["bundle_too_many_files", 413],
    ["results_too_large", 413],
    ["results_quota_exceeded", 409],
    ["too_many_outputs", 413],
    ["results_expired", 410],
    ["job_not_found", 404],
    ["bad_state", 409],
  ];

  test("the list is the seven of section 6 plus the eighteen the phase names", () => {
    expect([...COMPUTE_REFUSAL_CODES] as string[]).toEqual(EXPECTED.map(([c]) => c));
    expect(COMPUTE_REFUSAL_CODES).toHaveLength(25);
  });

  test("every code has a status and the table has no stray key", () => {
    expect(Object.keys(COMPUTE_REFUSAL_STATUS).sort()).toEqual([...COMPUTE_REFUSAL_CODES].sort());
    for (const [code, status] of EXPECTED) {
      expect(
        COMPUTE_REFUSAL_STATUS[code as keyof typeof COMPUTE_REFUSAL_STATUS] as number,
        code,
      ).toBe(status);
    }
  });

  test("every status is a client or server error", () => {
    for (const status of Object.values(COMPUTE_REFUSAL_STATUS)) {
      expect(Number.isInteger(status)).toBe(true);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  test("the three result refusal details are also refusal codes", () => {
    for (const d of RESULT_REFUSAL_DETAILS) expect(COMPUTE_REFUSAL_CODES).toContain(d);
  });
});

describe("failure codes", () => {
  test("the launcher codes number seven, with exit numbers 10 to 16 in order", () => {
    expect([...LAUNCHER_FAILURE_CODES]).toEqual([
      "code_fetch_failed",
      "dataset_fetch_failed",
      "entry_not_found",
      "runtime_error",
      "out_of_memory",
      "time_limit",
      "result_upload_failed",
    ]);
    expect(LAUNCHER_FAILURE_CODES.map((c) => launcherExitNumber(c))).toEqual([
      10, 11, 12, 13, 14, 15, 16,
    ]);
    expect(launcherExitNumber("code_fetch_failed")).toBe(10);
    expect(launcherExitNumber("result_upload_failed")).toBe(16);
  });

  test("the platform codes are the eleven the phase names", () => {
    expect([...PLATFORM_FAILURE_CODES]).toEqual([
      "code_fetch_failed",
      "dataset_fetch_failed",
      "tapis_submit_failed",
      "submit_timeout",
      "staging_failed",
      "launch_failed",
      "archive_failed",
      "tapis_error",
      "result_verification_failed",
      "records_unavailable",
      "result_upload_failed",
    ]);
  });

  test("the four user-caused launcher codes are not platform failures", () => {
    const userCaused = ["entry_not_found", "runtime_error", "out_of_memory", "time_limit"];
    for (const c of userCaused) {
      expect(isPlatformFailure(c), c).toBe(false);
      expect(isPlatformFailure(c, "results_too_large"), c).toBe(false);
    }
    // Exactly the launcher codes that are not on the platform list.
    expect(LAUNCHER_FAILURE_CODES.filter((c) => !isPlatformFailure(c)).sort() as string[]).toEqual(
      [...userCaused].sort(),
    );
  });

  test("every platform code is a platform failure", () => {
    for (const c of PLATFORM_FAILURE_CODES) expect(isPlatformFailure(c), c).toBe(true);
  });

  test("result_upload_failed is a platform failure unless its detail is a refusal detail", () => {
    expect(isPlatformFailure("result_upload_failed")).toBe(true);
    expect(isPlatformFailure("result_upload_failed", undefined)).toBe(true);
    expect(isPlatformFailure("result_upload_failed", null)).toBe(true);
    expect(isPlatformFailure("result_upload_failed", "")).toBe(true);
    expect(isPlatformFailure("result_upload_failed", "put_failed")).toBe(true);
    for (const d of RESULT_REFUSAL_DETAILS) {
      expect(isPlatformFailure("result_upload_failed", d), d).toBe(false);
    }
  });

  test("a refusal detail changes no platform code but result_upload_failed", () => {
    for (const c of PLATFORM_FAILURE_CODES) {
      if (c === "result_upload_failed") continue;
      for (const d of RESULT_REFUSAL_DETAILS)
        expect(isPlatformFailure(c, d), `${c} ${d}`).toBe(true);
    }
  });

  test("a word that is no failure code is not a platform failure", () => {
    for (const bad of ["", "nonsense", "constructor", "__proto__", "RESULT_UPLOAD_FAILED"]) {
      expect(isPlatformFailure(bad), bad).toBe(false);
    }
  });

  test("every RESULT_REFUSAL_DETAILS word is a valid word", () => {
    expect(RESULT_REFUSAL_DETAILS.length).toBe(3);
    for (const d of RESULT_REFUSAL_DETAILS) expect(COMPUTE_WORD_RE.test(d), d).toBe(true);
  });
});

describe("Tapis conditions", () => {
  // The whole `Job.condition` enum of the published specification, each with the code it must
  // give. Written out here so a condition that moves from one code to another fails a test.
  const EXPECTED: ReadonlyArray<readonly [string, string]> = [
    ["CANCELLED_BY_USER", "tapis_error"],
    ["JOB_ARCHIVING_FAILED", "archive_failed"],
    ["JOB_DATABASE_ERROR", "tapis_error"],
    ["JOB_EXECUTION_MONITORING_ERROR", "tapis_error"],
    ["JOB_EXECUTION_MONITORING_ERROR_TIMEOUT", "tapis_error"],
    ["JOB_EXECUTION_MONITORING_TIMEOUT", "tapis_error"],
    ["JOB_FILES_SERVICE_ERROR", "staging_failed"],
    ["JOB_INTERNAL_ERROR", "tapis_error"],
    ["JOB_INVALID_DEFINITION", "launch_failed"],
    ["JOB_LAUNCH_FAILURE", "launch_failed"],
    ["JOB_QUEUE_MONITORING_ERROR", "tapis_error"],
    ["JOB_RECOVERY_FAILURE", "tapis_error"],
    ["JOB_RECOVERY_TIMEOUT", "tapis_error"],
    ["JOB_REMOTE_ACCESS_ERROR", "tapis_error"],
    ["JOB_REMOTE_OUTCOME_ERROR", "runtime_error"],
    ["JOB_UNABLE_TO_STAGE_INPUTS", "staging_failed"],
    ["JOB_UNABLE_TO_STAGE_JOB", "staging_failed"],
    ["JOB_TRANSFER_FAILED_OR_CANCELLED", "staging_failed"],
    ["JOB_TRANSFER_MONITORING_TIMEOUT", "staging_failed"],
    ["NORMAL_COMPLETION", "tapis_error"],
    ["SCHEDULER_CANCELLED", "tapis_error"],
    ["SCHEDULER_DEADLINE", "time_limit"],
    ["SCHEDULER_OUT_OF_MEMORY", "out_of_memory"],
    ["SCHEDULER_STOPPED", "tapis_error"],
    ["SCHEDULER_TIMEOUT", "time_limit"],
    ["SCHEDULER_TERMINATED", "tapis_error"],
  ];

  test("each published condition maps as the design says", () => {
    expect(EXPECTED).toHaveLength(26);
    for (const [condition, code] of EXPECTED) {
      expect(failureCodeFromTapisCondition(condition) as string, condition).toBe(code);
    }
  });

  test("the named conditions map to the named codes", () => {
    expect(failureCodeFromTapisCondition("SCHEDULER_TIMEOUT")).toBe("time_limit");
    expect(failureCodeFromTapisCondition("SCHEDULER_DEADLINE")).toBe("time_limit");
    expect(failureCodeFromTapisCondition("SCHEDULER_OUT_OF_MEMORY")).toBe("out_of_memory");
    expect(failureCodeFromTapisCondition("JOB_ARCHIVING_FAILED")).toBe("archive_failed");
    expect(failureCodeFromTapisCondition("JOB_REMOTE_OUTCOME_ERROR")).toBe("runtime_error");
  });

  test("anything else is tapis_error", () => {
    for (const other of [
      undefined,
      null,
      "",
      "NEW_CONDITION",
      "scheduler_timeout",
      "constructor",
    ]) {
      expect(failureCodeFromTapisCondition(other as string | null | undefined), String(other)).toBe(
        "tapis_error",
      );
    }
  });

  test("every code a condition gives is a known failure code", () => {
    const known = new Set<string>([...LAUNCHER_FAILURE_CODES, ...PLATFORM_FAILURE_CODES]);
    for (const [condition] of EXPECTED) {
      expect(known.has(failureCodeFromTapisCondition(condition)), condition).toBe(true);
    }
  });
});

describe("the module imports nothing", () => {
  test("shared/compute-state.ts has no import, require or dynamic import", () => {
    const src = readFileSync(join(import.meta.dir, "../shared/compute-state.ts"), "utf8")
      // Comments may say the word; only code counts.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/\bfrom\s+["']/);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bimport\s*\(/);
    // A guard against a vacuous pass: the file is code, not an empty string.
    expect(src).toContain("COMPUTE_STATES");
  });
});
