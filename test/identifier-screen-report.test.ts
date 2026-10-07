/**
 * The screen report is the door through which a workflow's words reach the database, the admin
 * email and the status views. These tests hold the door: what a real report looks like passes,
 * and each way of smuggling a value through (a free-text key, a string where a count belongs, an
 * unknown field, a kind nobody declared) is refused with a fixed word that does not quote it.
 */

import { describe, expect, test } from "bun:test";
import {
  DATASET_STATUSES,
  FINDING_KINDS,
  ReportError,
  SCREEN_ERRORS,
  type ScreenReport,
  type ScreenState,
  describeScreen,
  isScreenState,
  parseScreenReport,
  screenGate,
  stateOf,
} from "../shared/identifier-screen-report";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function scan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "nm000186",
    version: null,
    scanned_at: "2026-10-05T12:00:00.000Z",
    manifest_source: "clone",
    status: "direct-identifiers",
    incomplete: false,
    incomplete_reasons: [],
    files: { total: 10, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
    sampling: {
      edf_headers: { candidates: 4, oversize: 0, selected: 4, scanned: 4 },
      scans_tables: { candidates: 0, oversize: 0, selected: 0, scanned: 0 },
      json_files: { candidates: 1, oversize: 0, selected: 1, scanned: 1 },
      text_files: { candidates: 0, oversize: 0, selected: 0, scanned: 0 },
    },
    read_failures: { "edf/http-403": 2 },
    edf_bdf_files_flagged: 4,
    distinct_patient_field_values: 4,
    distinct_subjects_with_edf_bdf: 4,
    findings_by_kind: { "edf-patient-name": 4, "acq-time-dated": 2 },
    edf_bdf_files_by_kind: { "edf-patient-name": 4 },
    unscreened_formats: { ".set": 3, ".ds/": 1, "(no extension)": 1 },
    side_reads_failed: 0,
    ...overrides,
  };
}

function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    scanner: "identifier-scan@abcdef1",
    head: HEAD,
    scan: scan(),
    ...over,
  };
}

function refusal(input: unknown): string {
  try {
    parseScreenReport(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ReportError);
    return (error as ReportError).message;
  }
  throw new Error("accepted a report it should have refused");
}

describe("parseScreenReport: what passes", () => {
  test("a real-shaped scan report round-trips unchanged", () => {
    const input = report();
    expect(parseScreenReport(input)).toEqual(input as unknown as ScreenReport);
  });

  test("an error report carries a fixed word and no scan", () => {
    for (const error of SCREEN_ERRORS) {
      const parsed = parseScreenReport({
        version: 1,
        scanner: "identifier-scan@abcdef1",
        head: null,
        error,
      });
      expect(parsed.error).toBe(error);
      expect(stateOf(parsed)).toBe("error");
    }
  });

  test("an error report may have no scanner; a scan report may not", () => {
    expect(
      parseScreenReport({ version: 1, scanner: null, head: null, error: "workflow-failed" })
        .scanner,
    ).toBeNull();
    expect(refusal(report({ scanner: null }))).toBe("report-scanner");
  });

  test("every status the scanner can conclude is a state a report can carry", () => {
    // One coherent record per status: the parser refuses a status cleaner than its counts.
    const base = {
      findings_by_kind: {},
      edf_bdf_files_by_kind: {},
      edf_bdf_files_flagged: 0,
      unscreened_formats: {},
      incomplete: false,
      incomplete_reasons: [],
      files: { total: 10, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
    };
    const byStatus: Record<(typeof DATASET_STATUSES)[number], Record<string, unknown>> = {
      clean: {},
      "dates-only": { findings_by_kind: { "edf-startdate": 4 } },
      "no-recordings": { files: { total: 3, edf_bdf: 0, header_read: 0, header_read_failed: 0 } },
      "direct-identifiers": {
        findings_by_kind: { "edf-patient-name": 4 },
        edf_bdf_files_flagged: 4,
      },
      review: { findings_by_kind: { "tooling-debris": 1 } },
      unchecked: {
        incomplete: true,
        incomplete_reasons: ["edf-headers-unread"],
        files: { total: 10, edf_bdf: 4, header_read: 2, header_read_failed: 2 },
      },
      "not-screened": {
        unscreened_formats: { ".set": 2 },
        files: { total: 3, edf_bdf: 0, header_read: 0, header_read_failed: 0 },
      },
      "clean-edf-only-others-unscreened": { unscreened_formats: { ".set": 2 } },
    };
    for (const status of DATASET_STATUSES) {
      const parsed = parseScreenReport(
        report({ scan: scan({ ...base, status, ...byStatus[status] }) }),
      );
      expect(stateOf(parsed)).toBe(status);
    }
  });

  test("every finding kind is accepted as a key", () => {
    const kinds = Object.fromEntries(FINDING_KINDS.map((k) => [k, 1]));
    expect(
      parseScreenReport(report({ scan: scan({ findings_by_kind: kinds }) })).scan?.findings_by_kind,
    ).toEqual(kinds as never);
  });
});

describe("parseScreenReport: what is refused, without quoting it", () => {
  const LEAK = "JOHN-Q-SMITH 1971";

  test("an unknown key anywhere is refused", () => {
    expect(refusal(report({ patient: LEAK }))).toBe("report-key");
    expect(refusal(report({ scan: scan({ note: LEAK }) }))).toBe("scan-key");
    expect(
      refusal(
        report({
          scan: scan({
            files: { total: 1, edf_bdf: 1, header_read: 1, header_read_failed: 0, x: 1 },
          }),
        }),
      ),
    ).toBe("scan-files");
  });

  test("a key that is not a declared kind is refused", () => {
    expect(refusal(report({ scan: scan({ findings_by_kind: { [LEAK]: 1 } }) }))).toBe("scan-kinds");
    expect(refusal(report({ scan: scan({ edf_bdf_files_by_kind: { [LEAK]: 1 } }) }))).toBe(
      "scan-kinds",
    );
  });

  test("a string, a fraction or a negative where a count belongs is refused", () => {
    for (const bad of [LEAK, 1.5, -1, Number.NaN, null, Number.MAX_SAFE_INTEGER + 2]) {
      expect(
        refusal(report({ scan: scan({ findings_by_kind: { "edf-patient-name": bad } }) })),
      ).toBe("scan-kinds");
      expect(refusal(report({ scan: scan({ edf_bdf_files_flagged: bad }) }))).toBe("scan-count");
    }
  });

  test("a format key must look like an extension, so a file name cannot ride in it", () => {
    for (const key of [
      LEAK,
      "john.smith.edf",
      "sub-01_task-rest.set",
      ".set .set",
      "/etc/passwd",
    ]) {
      expect(refusal(report({ scan: scan({ unscreened_formats: { [key]: 1 } }) }))).toBe(
        "scan-formats",
      );
    }
  });

  test("a reason and a failure key come from closed lists, not from a pattern", () => {
    // Lowercase and hyphenated, so a pattern would let every one of these through.
    for (const word of [
      LEAK.toLowerCase().replace(/ /g, "-"),
      "john-smith-1971",
      "edf-headers-unreadable",
    ]) {
      expect(refusal(report({ scan: scan({ incomplete_reasons: [word] }) }))).toBe("scan-reasons");
    }
    expect(refusal(report({ scan: scan({ incomplete_reasons: ["Has Space"] }) }))).toBe(
      "scan-reasons",
    );
    for (const key of [
      LEAK,
      "read/johnsmith",
      "edf/johnsmith",
      "johnsmith/internal",
      "edf/http-99",
      "edf/error-johnsmith",
    ]) {
      expect(refusal(report({ scan: scan({ read_failures: { [key]: 1 } }) }))).toBe(
        "scan-failures",
      );
    }
    // What the producers really emit still passes.
    const ok = parseScreenReport(
      report({
        scan: scan({
          incomplete_reasons: ["edf-headers-unread", "history-unread", "submodule-unread"],
          files: { total: 10, edf_bdf: 4, header_read: 3, header_read_failed: 1 },
          incomplete: true,
          read_failures: {
            "edf/http-403": 1,
            "json/error-rangeerror": 1,
            "edf/superseded-absent": 1,
            "scans/timeout": 1,
          },
        }),
      }),
    );
    expect(Object.keys(ok.scan?.read_failures ?? {}).length).toBe(4);
  });

  test("finding_fields is the fleet scan's field, not the report's", () => {
    expect(refusal(report({ scan: scan({ finding_fields: ["edf-patient-name:patient"] }) }))).toBe(
      "scan-key",
    );
  });

  test("a status cannot be cleaner than its own counts", () => {
    const clean = (over: Record<string, unknown>) =>
      scan({
        status: "clean",
        findings_by_kind: {},
        edf_bdf_files_by_kind: {},
        edf_bdf_files_flagged: 0,
        unscreened_formats: {},
        incomplete: false,
        incomplete_reasons: [],
        files: { total: 10, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
        ...over,
      });
    expect(parseScreenReport(report({ scan: clean({}) })).scan?.status).toBe("clean");
    const lies: Record<string, unknown>[] = [
      { findings_by_kind: { "edf-patient-name": 3 } },
      { incomplete: true },
      { incomplete_reasons: ["json-unread"] },
      { files: { total: 10, edf_bdf: 4, header_read: 0, header_read_failed: 4 } },
      { unscreened_formats: { ".set": 2 } },
      { edf_bdf_files_flagged: 1 },
      { files: { total: 10, edf_bdf: 0, header_read: 0, header_read_failed: 0 } },
      { files: undefined },
    ];
    for (const lie of lies) {
      expect(refusal(report({ scan: clean(lie) }))).toBe("scan-status");
    }
    // dates-only may carry dates and nothing else; no-recordings needs no EDF and nothing unparsed.
    const dates = clean({ status: "dates-only", findings_by_kind: { "edf-startdate": 4 } });
    expect(parseScreenReport(report({ scan: dates })).scan?.status).toBe("dates-only");
    expect(
      refusal(
        report({
          scan: clean({ status: "dates-only", findings_by_kind: { "edf-patient-name": 1 } }),
        }),
      ),
    ).toBe("scan-status");
    expect(
      parseScreenReport(
        report({
          scan: clean({
            status: "no-recordings",
            files: { total: 3, edf_bdf: 0, header_read: 0, header_read_failed: 0 },
          }),
        }),
      ).scan?.status,
    ).toBe("no-recordings");
    expect(refusal(report({ scan: clean({ status: "no-recordings" }) }))).toBe("scan-status");
    // A scan that fell short cannot call itself finished, and cannot hide the shortfall in `incomplete`.
    expect(refusal(report({ scan: clean({ status: "unchecked" }) }))).toBe("scan-status");
    expect(
      refusal(
        report({
          scan: clean({
            status: "review",
            incomplete: false,
            incomplete_reasons: ["json-unread"],
          }),
        }),
      ),
    ).toBe("scan-status");
  });

  test("exactly one of scan and error", () => {
    expect(refusal(report({ error: "workflow-failed" }))).toBe("report-outcome");
    expect(refusal({ version: 1, scanner: "identifier-scan@abcdef1", head: null })).toBe(
      "report-outcome",
    );
    expect(
      refusal({ version: 1, scanner: "identifier-scan@abcdef1", head: null, error: LEAK }),
    ).toBe("report-error");
  });

  test("a scan of no commit cannot be matched to anything, so it is refused", () => {
    expect(refusal(report({ head: null }))).toBe("report-head");
    expect(refusal(report({ head: "abc123" }))).toBe("report-head");
  });

  test("the version, the scanner revision, the id and the time are checked", () => {
    expect(refusal(report({ version: 2 }))).toBe("report-version");
    expect(refusal(report({ scanner: LEAK }))).toBe("report-scanner");
    expect(refusal(report({ scan: scan({ id: LEAK }) }))).toBe("scan-id");
    expect(refusal(report({ scan: scan({ scanned_at: LEAK }) }))).toBe("scan-time");
    expect(refusal(report({ scan: scan({ status: LEAK }) }))).toBe("scan-status");
    expect(refusal(report({ scan: scan({ manifest_source: LEAK }) }))).toBe("scan-source");
  });

  test("a body that is not an object is refused", () => {
    for (const body of [null, undefined, "x", 3, [], [report()]]) {
      expect(refusal(body)).toBe("report-shape");
    }
  });

  test("no refusal message contains any part of the input", () => {
    const inputs = [
      report({ scan: scan({ findings_by_kind: { [LEAK]: 1 } }) }),
      report({ scan: scan({ unscreened_formats: { [LEAK]: 1 } }) }),
      report({ scan: scan({ incomplete_reasons: [LEAK] }) }),
      report({ scanner: LEAK }),
    ];
    for (const input of inputs) expect(refusal(input)).not.toContain("SMITH");
  });
});

describe("screenGate: unknown is never clear", () => {
  const expected: Record<ScreenState | "null", string> = {
    pending: "wait",
    clean: "clear",
    "dates-only": "clear",
    "no-recordings": "clear",
    "direct-identifiers": "blocks",
    review: "acknowledge",
    unchecked: "acknowledge",
    "not-screened": "acknowledge",
    "clean-edf-only-others-unscreened": "acknowledge",
    error: "rerun",
    unreported: "rerun",
    null: "rerun",
  };

  test("every state has the documented answer", () => {
    for (const [state, gate] of Object.entries(expected)) {
      expect(screenGate(state === "null" ? null : (state as ScreenState))).toBe(gate as never);
    }
  });

  test("a stored value that is not a state is not clear either", () => {
    for (const junk of ["", "CLEAN", "ok", "passed", "clean ", "0"]) {
      expect(isScreenState(junk)).toBe(false);
      expect(screenGate(junk as ScreenState)).toBe("rerun");
    }
  });

  test("only clean-class states are clear", () => {
    const clear = [...DATASET_STATUSES, "pending", "error", "unreported"].filter(
      (s) => screenGate(s as ScreenState) === "clear",
    );
    expect(clear.sort()).toEqual(["clean", "dates-only", "no-recordings"]);
  });
});

describe("describeScreen", () => {
  test("a screen that did not run says so in the headline and gives a cause", () => {
    const parsed = parseScreenReport({
      version: 1,
      scanner: "identifier-scan@abcdef1",
      head: null,
      error: "dispatch-failed",
    });
    const d = describeScreen("error", parsed);
    expect(d.headline).toContain("DID NOT RUN");
    expect(d.tone).toBe("stop");
    expect(d.lines.join(" ")).toContain("refused to start");
  });

  test("a screen that never reported is its own headline", () => {
    const d = describeScreen("unreported", null);
    expect(d.headline).toContain("DID NOT REPORT");
    expect(d.lines.join(" ")).toContain("no report arrived from the screen workflow in time");
  });

  test("an unreported screen stored with its error report states the cause once", () => {
    // The watchdog stores 'unreported' together with the `no-report-in-time`
    // report, so both the state and the report carry the same cause.
    const stored = parseScreenReport({
      version: 1,
      scanner: null,
      head: null,
      error: "no-report-in-time",
    });
    const d = describeScreen("unreported", stored);
    expect(d.headline).toContain("DID NOT REPORT");
    expect(d.lines.filter((l) => l.includes("no report arrived"))).toHaveLength(1);
  });

  test("a request with no screen is not described as clean", () => {
    const d = describeScreen(null, null);
    expect(d.tone).toBe("stop");
    expect(d.headline).toContain("NOT RUN");
  });

  test("a finding is described by kind and count, with the commit, and no value", () => {
    const parsed = parseScreenReport(report());
    const d = describeScreen("direct-identifiers", parsed);
    expect(d.tone).toBe("stop");
    const text = d.lines.join("\n");
    expect(text).toContain("edf-patient-name x4");
    expect(text).toContain(HEAD.slice(0, 12));
    expect(text).toContain("earlier commits");
    expect(text).toContain(".set x3");
  });

  test("every state has a headline, and only the clean ones are ok", () => {
    for (const state of [...DATASET_STATUSES, "pending", "error", "unreported"] as ScreenState[]) {
      const d = describeScreen(state, null);
      expect(d.headline.startsWith("Identifier screen:")).toBe(true);
      expect(d.tone === "ok").toBe(screenGate(state) === "clear");
    }
  });
});
