/**
 * The offline half of the validation report checks: the Validator line of the text report, the
 * rule that a `--json` report is only ever a JSON object with the release added to it, and the
 * choice of the line that says why a validator run failed.
 *
 * These call the real functions on real strings, with no validator run and no network. The
 * failure inputs have the shape of stderr that validator 3.0.2 wrote in real runs.
 */

import { describe, expect, test } from "bun:test";
import type { BidsValidationResult } from "../src/lib/bids-validator";
import {
  formatValidationResult,
  validatorFailureReason,
  withValidatorVersion,
} from "../src/lib/bids-validator";
import validatorPin from "../validator-version.json" with { type: "json" };

const ESC = "\u001b";

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

describe("validatorFailureReason", () => {
  const errorLine =
    "error: Uncaught (in promise) NotFound: No such file or directory (os error 2): readfile '/nonexistent.json'";
  // A crash as validator 3.0.2 wrote it for a --config file that does not exist: the error line,
  // a source excerpt with a caret, then stack frames. The run ends on a frame.
  const crash = [
    errorLine,
    "  const config = options.config ? JSON.parse(Deno.readTextFileSync(options.config)) as Config : {}",
    "                                                  ^",
    "    at Object.readTextFileSync (ext:deno_fs/30_fs.js:852:10)",
    "    at main (https://jsr.io/@bids/validator/3.0.2/src/main.ts:38:51)",
    "    at async https://jsr.io/@bids/validator/3.0.2/src/api/app.ts:34:16",
    "",
  ].join("\n");

  test("names the error line, not the stack frame the run ends with", () => {
    expect(validatorFailureReason(crash)).toBe(errorLine);
  });

  test("returns the error line plain when Deno wraps the output in colour codes", () => {
    // The same crash with the codes Deno wrote around the error word, the caret and the frames.
    const coloured = [
      `${ESC}[0m${ESC}[1m${ESC}[31merror${ESC}[0m${errorLine.slice("error".length)}`,
      "  const config = options.config ? JSON.parse(Deno.readTextFileSync(options.config)) as Config : {}",
      `${ESC}[0m${ESC}[31m                                                  ^${ESC}[0m`,
      `    ${ESC}[0m${ESC}[2m${ESC}[38;5;245mat ${ESC}[0m${ESC}[2m${ESC}[38;5;245mObject.readTextFileSync${ESC}[0m (ext:deno_fs/30_fs.js:852:10)`,
      `    at ${ESC}[0m${ESC}[1m${ESC}[3mmain${ESC}[0m (${ESC}[0m${ESC}[36mhttps://jsr.io/@bids/validator/3.0.2/src/main.ts${ESC}[0m:38:51)`,
      `    at async ${ESC}[0m${ESC}[36mhttps://jsr.io/@bids/validator/3.0.2/src/api/app.ts${ESC}[0m:34:16`,
      "",
    ].join("\n");
    expect(coloured).toContain(ESC);
    expect(validatorFailureReason(coloured)).toBe(errorLine);
  });

  test("the first error line wins, and download progress lines are never the reason", () => {
    const stderr = [
      `${ESC}[0m${ESC}[32mDownload${ESC}[0m https://jsr.io/@bids/validator/meta.json`,
      "Download https://jsr.io/@bids/validator/3.0.2_meta.json",
      "error: first failure",
      "error: second failure",
      "",
    ].join("\n");
    expect(validatorFailureReason(stderr)).toBe("error: first failure");
    expect(validatorFailureReason("Download https://jsr.io/@bids/validator/meta.json\n")).toBe(
      undefined,
    );
  });

  test("without an error line, returns the last line that is not a stack frame", () => {
    const stderr = [
      "Download https://jsr.io/@bids/validator/meta.json",
      "The validator stopped before it printed an error",
      "  a detail that comes last",
      "    at async main (https://jsr.io/@bids/validator/3.0.2/src/main.ts:36:7)",
      "",
    ].join("\n");
    expect(validatorFailureReason(stderr)).toBe("a detail that comes last");
  });

  test("returns undefined when stderr has no line that could say why", () => {
    expect(validatorFailureReason("")).toBeUndefined();
    expect(validatorFailureReason("  \n\t\n")).toBeUndefined();
    expect(validatorFailureReason("    at async main (file:///x.ts:1:1)\n")).toBeUndefined();
  });
});
