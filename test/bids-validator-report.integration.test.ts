/**
 * Every validation report names the validator release that produced it, and a failed validator run
 * is reported as a failure.
 *
 * The version is the pin in validator-version.json. These tests run the real validator, which
 * downloads its release from JSR on a cold cache, so they belong to the integration tier. The
 * offline checks of the same functions live in bids-validator-report.unit.test.ts. No mocks.
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
  }, 120_000);

  test("a validation result names the pinned release", async () => {
    const result = await validateBidsDataset(FIXTURE);
    expect(result.validatorVersion).toBe(validatorPin.version);
    expect(result.errorCount).toBe(0);
  }, 120_000);

  test("the text report prints the release next to the schema it used", async () => {
    const result = await validateBidsDataset(FIXTURE);
    expect(formatValidationResult(result, false)).toContain(
      `  Validator: @bids/validator ${validatorPin.version}\n`,
    );
  }, 120_000);

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
  }, 120_000);

  test("a dataset the validator cannot read is a failed validation, not a valid one", async () => {
    await expect(validateBidsDataset("/nonexistent/dataset-for-test")).rejects.toThrow(
      "BIDS validator failed",
    );
  }, 120_000);
});
