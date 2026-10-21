/**
 * The offline half of the validation report checks: the Validator line of the text report, and
 * the rule that a `--json` report is only ever a JSON object with the release added to it.
 *
 * These call the real functions on real strings, with no validator run and no network.
 */

import { describe, expect, test } from "bun:test";
import type { BidsValidationResult } from "../src/lib/bids-validator";
import { formatValidationResult, withValidatorVersion } from "../src/lib/bids-validator";
import validatorPin from "../validator-version.json" with { type: "json" };

function resultFor(validatorVersion: string): BidsValidationResult {
  return {
    valid: true,
    issues: [],
    codeMessages: {},
    summary: {
      sessions: [],
      subjects: [],
      tasks: [],
      modalities: [],
      totalFiles: 1,
      size: 1,
      dataProcessed: true,
      schemaVersion: "1.0.0",
    },
    errorCount: 0,
    warningCount: 0,
    validatorVersion,
  };
}

describe("the text report names its validator release", () => {
  test("the Validator line carries the release the result was produced by", () => {
    expect(formatValidationResult(resultFor("9.9.9"), false)).toContain(
      "  Validator: @bids/validator 9.9.9\n",
    );
  });
});

describe("withValidatorVersion", () => {
  test("adds the release as a top-level key and keeps the report on one line", () => {
    const report = withValidatorVersion('{"issues":{"issues":[],"codeMessages":{}},"summary":{}}');
    expect(report).not.toContain("\n");
    expect(JSON.parse(report)).toEqual({
      issues: { issues: [], codeMessages: {} },
      summary: {},
      validatorVersion: validatorPin.version,
    });
  });

  test("refuses output that is not a JSON object, so a --json consumer never reads it as a report", () => {
    for (const text of ["not json", "[1, 2]", "null", "42", ""]) {
      expect(() => withValidatorVersion(text)).toThrow();
    }
  });
});
