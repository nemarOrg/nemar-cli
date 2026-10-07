/**
 * The uploader preflight's record (ADR 0087) passes through the same door as the publication
 * report: closed kinds, counts, fixed words. These tests hold that door for the preflight shape,
 * which is made before the dataset has an id and is stored inside the deposit attestation.
 *
 * What a real record looks like passes; each way of smuggling text through (an unknown key, an
 * identity field, a scanner string with a name in it) is refused with a fixed word that does not
 * quote it; an acknowledgment is present exactly when the verdict needs one; and the words shown
 * to the uploader are the publication screen's words under the preflight's own name.
 */

import { describe, expect, test } from "bun:test";
import {
  DATASET_STATUSES,
  type DatasetStatus,
  KNOWN_FORMATS,
  OTHER_FORMAT,
  PREFLIGHT_ACKNOWLEDGEABLE,
  ReportError,
  type UploaderPreflight,
  describePreflight,
  describeScreen,
  foldOddFailures,
  foldOddFormats,
  foldUnknownFormats,
  parsePreflightScan,
  parseUploaderPreflight,
  screenGate,
} from "../shared/identifier-screen-report";

/** A scan whose counts agree with `status`, for every status the scanner can conclude. */
function scanFor(status: DatasetStatus): Record<string, unknown> {
  const base = {
    scanned_at: "2026-10-06T12:00:00.000Z",
    status,
    incomplete: false,
    incomplete_reasons: [] as string[],
    files: { total: 12, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
    findings_by_kind: {} as Record<string, number>,
    edf_bdf_files_flagged: 0,
    unscreened_formats: {} as Record<string, number>,
    read_failures: {} as Record<string, number>,
  };
  switch (status) {
    case "direct-identifiers":
      return { ...base, findings_by_kind: { "edf-patient-name": 4 }, edf_bdf_files_flagged: 4 };
    case "dates-only":
      return { ...base, findings_by_kind: { "edf-startdate": 4 } };
    case "review":
      return { ...base, findings_by_kind: { "image-or-document-file": 1 } };
    case "clean-edf-only-others-unscreened":
      return { ...base, unscreened_formats: { ".vhdr": 2 } };
    case "not-screened":
      return {
        ...base,
        files: { total: 12, edf_bdf: 0, header_read: 0, header_read_failed: 0 },
        unscreened_formats: { ".set": 3 },
      };
    case "no-recordings":
      return { ...base, files: { total: 3, edf_bdf: 0, header_read: 0, header_read_failed: 0 } };
    case "unchecked":
      return {
        ...base,
        incomplete: true,
        files: { total: 12, edf_bdf: 4, header_read: 3, header_read_failed: 1 },
        incomplete_reasons: ["edf-headers-unread"],
        read_failures: { "edf/short-body": 1 },
      };
    default:
      return base;
  }
}

function record(
  status: DatasetStatus,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    scanner: "nemar-cli@0.10.13-dev1",
    scan: scanFor(status),
    acknowledged_via: screenGate(status) === "acknowledge" ? "prompt" : null,
    ...over,
  };
}

function refusal(input: unknown): string {
  try {
    parseUploaderPreflight(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ReportError);
    return (error as ReportError).message;
  }
  throw new Error("accepted a preflight it should have refused");
}

describe("parseUploaderPreflight: what passes", () => {
  test("a record of every status the scanner can conclude round-trips unchanged", () => {
    for (const status of DATASET_STATUSES) {
      const input = record(status);
      expect(parseUploaderPreflight(input)).toEqual(input as unknown as UploaderPreflight);
    }
  });

  test("the acknowledgeable verdicts are exactly the publication gate's acknowledge set", () => {
    const expected: DatasetStatus[] = [
      "clean-edf-only-others-unscreened",
      "not-screened",
      "review",
      "unchecked",
    ];
    expect([...PREFLIGHT_ACKNOWLEDGEABLE].sort()).toEqual(expected.sort());
  });

  test("a flag acknowledgment is accepted like a prompt one", () => {
    const parsed = parseUploaderPreflight(record("not-screened", { acknowledged_via: "flag" }));
    expect(parsed.acknowledged_via).toBe("flag");
  });

  test("a direct-identifier record is stored as it is, never as acknowledged", () => {
    // The real CLI refuses before it sends anything; a record of this state can only come from a
    // modified client, and storing it honestly is worth more than refusing to.
    expect(parseUploaderPreflight(record("direct-identifiers")).scan.status).toBe(
      "direct-identifiers",
    );
    expect(refusal(record("direct-identifiers", { acknowledged_via: "flag" }))).toBe(
      "preflight-ack",
    );
  });
});

describe("parseUploaderPreflight: what is refused, without quoting it", () => {
  test("a verdict that needs an acknowledgment cannot be stored without one", () => {
    for (const status of PREFLIGHT_ACKNOWLEDGEABLE) {
      expect(refusal(record(status, { acknowledged_via: null }))).toBe("preflight-ack");
    }
  });

  test("a verdict the gate clears cannot be stored as acknowledged", () => {
    for (const status of ["clean", "dates-only", "no-recordings"] as const) {
      expect(refusal(record(status, { acknowledged_via: "prompt" }))).toBe("preflight-ack");
    }
  });

  test("an acknowledgment is a fixed word, never a reason", () => {
    expect(refusal(record("review", { acknowledged_via: "it is my own data, ok" }))).toBe(
      "preflight-ack",
    );
    expect(refusal(record("review", { acknowledged_via: true }))).toBe("preflight-ack");
  });

  test("an unknown key at either level is refused", () => {
    expect(refusal(record("clean", { reason: "x" }))).toBe("preflight-key");
    const scan = { ...scanFor("clean"), note: "x" };
    expect(refusal(record("clean", { scan }))).toBe("scan-key");
  });

  test("a preflight names no dataset and carries none of the fleet scan's extras", () => {
    for (const key of ["id", "version", "finding_fields", "sampling", "manifest_source"]) {
      const scan = { ...scanFor("clean"), [key]: key === "version" ? null : "nm000186" };
      expect(refusal(record("clean", { scan }))).toBe("scan-key");
    }
  });

  test("every scan field is required: a missing count is not zero", () => {
    for (const key of Object.keys(scanFor("clean"))) {
      const scan = scanFor("clean");
      delete scan[key];
      expect(refusal(record("clean", { scan }))).toBe("scan-missing");
    }
  });

  test("a status cannot be cleaner than its counts", () => {
    const clean = scanFor("clean");
    expect(
      refusal(record("clean", { scan: { ...clean, findings_by_kind: { "edf-patient-name": 1 } } })),
    ).toBe("scan-status");
    expect(
      refusal(record("clean", { scan: { ...clean, unscreened_formats: { ".set": 1 } } })),
    ).toBe("scan-status");
    expect(
      refusal(
        record("clean", {
          scan: {
            ...clean,
            files: { total: 12, edf_bdf: 4, header_read: 3, header_read_failed: 1 },
          },
        }),
      ),
    ).toBe("scan-status");
  });

  test("the scanner is the CLI's name and version, nothing else", () => {
    for (const scanner of [
      "nemar-cli@0.10.13 JOHN",
      'nemar-cli@0.10.13-"O\'Brien"',
      "identifier-scan@abcdef1",
      "nemar-cli",
      42,
    ]) {
      expect(refusal(record("clean", { scanner }))).toBe("preflight-scanner");
    }
    expect(parseUploaderPreflight(record("clean", { scanner: "nemar-cli@1.2.3" })).scanner).toBe(
      "nemar-cli@1.2.3",
    );
  });

  test("the version and the shape are checked", () => {
    expect(refusal(record("clean", { version: 2 }))).toBe("preflight-version");
    expect(refusal([record("clean")])).toBe("preflight-shape");
    expect(refusal(null)).toBe("preflight-shape");
    expect(refusal(record("clean", { scan: "clean" }))).toBe("scan-shape");
  });

  test("no refusal message contains any part of the input", () => {
    const hostile = 'SMITH^JOHN "O\'Brien" 14.03.1993';
    const attempts = [
      record("clean", { [hostile]: 1 }),
      record("clean", { scanner: hostile }),
      record("review", { acknowledged_via: hostile }),
      record("clean", { scan: { ...scanFor("clean"), status: hostile } }),
      record("clean", { scan: { ...scanFor("clean"), findings_by_kind: { [hostile]: 1 } } }),
      record("clean", { scan: { ...scanFor("clean"), unscreened_formats: { [hostile]: 1 } } }),
      record("clean", { scan: { ...scanFor("clean"), read_failures: { [hostile]: 1 } } }),
      record("clean", { scan: { ...scanFor("clean"), incomplete_reasons: [hostile] } }),
    ];
    for (const attempt of attempts) {
      const word = refusal(attempt);
      for (const part of ["SMITH", "JOHN", "Brien", "1993", "14.03"]) {
        expect(word).not.toContain(part);
      }
    }
  });
});

describe("parsePreflightScan", () => {
  test("is the scan half of the record, refused the same way", () => {
    expect(parsePreflightScan(scanFor("review")).status).toBe("review");
    expect(() => parsePreflightScan({ ...scanFor("review"), id: "nm000186" })).toThrow(ReportError);
  });
});

describe("folding into the vocabulary works on a preflight scan", () => {
  test("an odd format and an odd failure class fold, then parse", () => {
    const raw = {
      ...scanFor("unchecked"),
      status: "unchecked",
      files: { total: 12, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
      incomplete_reasons: ["json-unread"],
      unscreened_formats: { ".dat_backup_of_subject": 1 },
      read_failures: { "json/error-RangeError": 1 },
    };
    expect(() => parsePreflightScan(raw)).toThrow(ReportError);
    const folded = foldOddFailures(foldOddFormats(raw));
    const parsed = parsePreflightScan(folded);
    expect(parsed.unscreened_formats).toEqual({ [OTHER_FORMAT]: 1 });
    expect(parsed.read_failures).toEqual({ "json/error-rangeerror": 1 });
  });
});

describe("a preflight names formats from a closed list only", () => {
  test("an extension shaped like a name is refused at the door", () => {
    // The publication report's pattern would take `.john`; the preflight's list does not.
    const scan = { ...scanFor("not-screened"), unscreened_formats: { ".john": 1 } };
    expect(refusal(record("not-screened", { scan }))).toBe("scan-formats");
  });

  test("folding keeps every count and names nothing outside the list", () => {
    const formats: Record<string, number> = { ".vhdr": 2, ".john": 1, ".smith": 3, ".ds/": 1 };
    const folded = foldUnknownFormats({ unscreened_formats: formats }).unscreened_formats ?? {};
    const expected: Record<string, number> = { ".vhdr": 2, ".ds/": 1, [OTHER_FORMAT]: 4 };
    expect(folded).toEqual(expected);
    for (const key of Object.keys(folded)) expect(KNOWN_FORMATS.has(key)).toBe(true);
  });

  test("the formats the scanner itself names are all on the list", () => {
    for (const format of [
      ".set",
      ".fdt",
      ".vhdr",
      ".eeg",
      ".fif",
      ".edf.gz",
      ".mff/",
      ".ds/",
      "(no extension)",
    ]) {
      expect(KNOWN_FORMATS.has(format)).toBe(true);
    }
  });
});

describe("describePreflight", () => {
  test("says each verdict in the publication screen's words, under its own name", () => {
    for (const status of DATASET_STATUSES) {
      const screen = describeScreen(status, null);
      const preflight = describePreflight(parsePreflightScan(scanFor(status)), null);
      expect(preflight.headline).toBe(
        screen.headline.replace(/^Identifier screen: /, "Identifier preflight: "),
      );
      expect(preflight.tone).toBe(screen.tone);
    }
  });

  test("states the counts and how the uploader acknowledged, and nothing else", () => {
    const scan = parsePreflightScan(scanFor("clean-edf-only-others-unscreened"));
    const viaFlag = describePreflight(scan, "flag");
    expect(viaFlag.lines).toEqual([
      "Files: 12; EDF/BDF headers read: 4 of 4.",
      "Not screened (format x files): .vhdr x2.",
      "Acknowledged by the uploader with --acknowledge-identifier-preflight.",
    ]);
    expect(describePreflight(scan, "prompt").lines.at(-1)).toBe(
      "Acknowledged by the uploader at the prompt.",
    );
    expect(describePreflight(scan, null).lines).toHaveLength(2);
  });

  test("a direct finding is described by kind and count", () => {
    const d = describePreflight(parsePreflightScan(scanFor("direct-identifiers")), null);
    expect(d.headline).toBe("Identifier preflight: FOUND IDENTIFIERS");
    expect(d.tone).toBe("stop");
    expect(d.lines).toContain("Findings by kind: edf-patient-name x4.");
    expect(d.lines).toContain("EDF/BDF files with an identifier finding: 4.");
  });
});
