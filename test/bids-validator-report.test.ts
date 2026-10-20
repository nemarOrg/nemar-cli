/**
 * Every validation report names the validator release that produced it.
 *
 * The version is the pin in validator-version.json. The first test checks that the pin resolves to
 * that exact release when the validator itself reports its version, so a report that names the pin
 * names the release that ran. The others run the real validator on the bids-minimal fixture and
 * read the reports it produced. Real validator, real fixture, no mocks.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  formatValidationResult,
  getValidatorVersion,
  runBidsValidatorDirect,
  validateBidsDataset,
  withValidatorVersion,
} from "../src/lib/bids-validator";
import validatorPin from "../validator-version.json" with { type: "json" };

const FIXTURE = join(import.meta.dir, "fixtures/bids-minimal");

describe("validator version in validation reports", () => {
  test("the pin resolves to the release the validator reports for itself", async () => {
    expect(await getValidatorVersion()).toBe(validatorPin.version);
  });

  test("a validation result names the pinned release", async () => {
    const result = await validateBidsDataset(FIXTURE);
    expect(result.validatorVersion).toBe(validatorPin.version);
    expect(result.errorCount).toBe(0);
  });

  test("the text report prints the release next to the schema it used", async () => {
    const result = await validateBidsDataset(FIXTURE);
    expect(formatValidationResult(result, false)).toContain(
      `  Validator: @bids/validator ${validatorPin.version}\n`,
    );
  });

  test("the JSON report keeps the validator's fields and adds the release", async () => {
    const { stdout, exitCode } = await runBidsValidatorDirect(FIXTURE, {
      json: true,
      ignoreWarnings: true,
    });
    expect(exitCode).toBe(0);
    const report = JSON.parse(withValidatorVersion(stdout));
    expect(report.issues.issues).toEqual([]);
    expect(report.summary.schemaVersion).toEqual(expect.any(String));
    expect(report.validatorVersion).toBe(validatorPin.version);
  });

  test("output that is not a JSON object is passed through unchanged", () => {
    expect(withValidatorVersion("not json\n")).toBe("not json\n");
    expect(withValidatorVersion("[1, 2]")).toBe("[1, 2]");
  });
});
