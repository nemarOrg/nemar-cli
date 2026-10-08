/**
 * What `nemar dataset upload` prints once the upload is done (issue #1646).
 *
 * BIDS validation runs on GitHub after an upload and must complete before a
 * publication request can go through; a request made earlier is only recorded.
 * The success output used to say nothing about either, so a depositor's next
 * command was a publication request that could not be acted on yet. It now
 * names the two commands, in order.
 *
 * `printUploadSuccess` is the real function, run against a real (temporary)
 * dataset directory. It prints through console.log, so the test reads what it
 * printed by wrapping console.log for the length of the call and restoring it
 * in `finally`; nothing about the function is replaced.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printUploadSuccess } from "../src/lib/upload/finalize";
import type { DatasetInfo } from "../src/lib/upload/types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nemar-upload-success-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function infoFor(datasetId: string): DatasetInfo {
  return {
    dataset_id: datasetId,
    ssh_url: `git@github.com:nemarDatasets/${datasetId}.git`,
    s3_prefix: `${datasetId}/`,
    github_url: `https://github.com/nemarDatasets/${datasetId}`,
    upload_urls: {},
    s3_config: {
      bucket: "nemar",
      region: "us-east-2",
      public_url: "https://nemar.s3.amazonaws.com",
    },
  };
}

/** The lines printUploadSuccess prints, without terminal color codes. */
function printedLines(datasetId: string): string[] {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    printUploadSuccess(dir, infoFor(datasetId));
  } finally {
    console.log = original;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping escape sequences is the point
  return lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
}

describe("printUploadSuccess: what happens next", () => {
  test("says validation runs on GitHub, how to follow it, and when to request publication", () => {
    const lines = printedLines("nm099999");
    const start = lines.indexOf("BIDS validation runs on GitHub after the upload.");
    expect(start).toBeGreaterThan(-1);
    // Three lines, in order: what runs, how to follow it, what comes after.
    expect(lines[start + 1]).toBe("  Follow it with: nemar dataset ci nm099999");
    expect(lines[start + 2]).toBe(
      "  Once it has completed, request publication: nemar dataset publish request nm099999",
    );
    expect(lines[start + 3]).toBe("");
  });

  test("the dataset id in the commands is the uploaded one", () => {
    const text = printedLines("nm000358").join("\n");
    expect(text).toContain("nemar dataset ci nm000358");
    expect(text).toContain("nemar dataset publish request nm000358");
    expect(text).not.toContain("nm099999");
  });

  test("it follows the existing summary and does not replace any of it", () => {
    const lines = printedLines("nm099999");
    const text = lines.join("\n");
    expect(lines[1]).toBe("Upload complete!");
    expect(text).toContain("Dataset ID: nm099999");
    expect(text).toContain("GitHub: https://github.com/nemarDatasets/nm099999");
    expect(text).toContain("nemar dataset download nm099999");
    expect(text).toContain("Note: This dataset is private.");
    expect(lines.indexOf("BIDS validation runs on GitHub after the upload.")).toBeGreaterThan(
      lines.indexOf("  nemar dataset download nm099999"),
    );
  });

  test("a sandbox dataset can follow CI but is not told to request publication", () => {
    // The backend refuses a publication request for an xx dataset, so naming
    // that command would send a trainee to a certain refusal.
    const text = printedLines("xx012345").join("\n");
    expect(text).toContain("nemar dataset ci xx012345");
    expect(text).not.toContain("publish request");
  });
});
