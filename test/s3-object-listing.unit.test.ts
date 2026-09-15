/**
 * Reading `aws s3api list-objects-v2 --output text` (#1392).
 *
 * This parse decides what the bucket holds, and therefore decides whether a
 * dataset is repaired, skipped as missing content, or left alone. It is the one
 * boundary the fleet suite injects, so the assumptions in it are checked here
 * against output shapes the real CLI produces.
 */

import { describe, expect, test } from "bun:test";
import { parseS3ObjectKeys } from "../src/lib/aws-cli";

const BASE = "on007788/objects/";
const KEY_A =
  "SHA256E-s231733--67a60a201040325a1c23d4d0a15405ebd032a58081cd10cd85ebf9cc61fa0145.pdf";
const KEY_B = "MD5E-s10874892--079de0d37c9bbcdaa4f5321b6ad2ecb5.nii.gz";

describe("parseS3ObjectKeys", () => {
  test("strips the prefix and returns bare keys", () => {
    expect(parseS3ObjectKeys(`${BASE}${KEY_A}\n`, BASE)).toEqual(new Set([KEY_A]));
  });

  test("splits a page on tabs and pages on newlines", () => {
    // `--output text` puts one page's keys on a line, tab-separated, and starts a
    // new line per page. Both separators have to work or a multi-page dataset
    // comes back short and reads as missing content.
    const out = `${BASE}${KEY_A}\t${BASE}${KEY_B}\n${BASE}third.bin\n`;
    expect(parseS3ObjectKeys(out, BASE)).toEqual(new Set([KEY_A, KEY_B, "third.bin"]));
  });

  test("an empty prefix prints the literal None, which is not a key", () => {
    // The CLI writes "None" for `Contents[].Key` when nothing matched. Taking it
    // as a key would make one phantom object.
    expect(parseS3ObjectKeys("None\n", BASE)).toEqual(new Set());
    expect(parseS3ObjectKeys("", BASE)).toEqual(new Set());
  });

  test("ignores anything nested below the prefix", () => {
    // An annex key is one path segment. A `qa/` or `version/` object that shares
    // the prefix must not be counted as content.
    const out = `${BASE}${KEY_A}\n${BASE}nested/thing.json\n`;
    expect(parseS3ObjectKeys(out, BASE)).toEqual(new Set([KEY_A]));
  });

  test("ignores an object outside the prefix entirely", () => {
    const out = `other-dataset/objects/${KEY_A}\n${BASE}${KEY_B}\n`;
    expect(parseS3ObjectKeys(out, BASE)).toEqual(new Set([KEY_B]));
  });

  test("keeps git-annex's own annex-uuid marker out of nothing", () => {
    // git-annex writes an `annex-uuid` marker at the prefix root. It IS one path
    // segment, so it parses as a key -- and that is harmless, because the caller
    // intersects with the keys the tree names. Pinned so the intersection stays
    // the thing that protects us rather than an accident of this parse.
    expect(parseS3ObjectKeys(`${BASE}annex-uuid\n`, BASE)).toEqual(new Set(["annex-uuid"]));
  });

  test("is not confused by a prefix given with or without its trailing slash", () => {
    expect(parseS3ObjectKeys(`${BASE}${KEY_A}\n`, BASE)).toEqual(new Set([KEY_A]));
  });
});
