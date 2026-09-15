/**
 * Reading `aws s3api list-objects-v2 --output text` (#1392, #1396).
 *
 * This parse decides what the bucket holds, and therefore decides whether a
 * dataset is repaired, skipped as missing content, or left alone. It is the one
 * boundary the fleet suite injects, so the assumptions in it are checked here
 * against output shapes the real CLI produces.
 *
 * It carries SIZES now. A failed copy leaves a zero-byte object under the right
 * key name (#967), and a listing of names alone calls that content: on003645 has
 * 653 such objects out of 823, and the sweeps read it as complete.
 */

import { describe, expect, test } from "bun:test";
import { parseS3ObjectSizes } from "../src/lib/aws-cli";

const BASE = "on007788/objects/";
const KEY_A =
  "SHA256E-s231733--67a60a201040325a1c23d4d0a15405ebd032a58081cd10cd85ebf9cc61fa0145.pdf";
const KEY_B = "MD5E-s10874892--079de0d37c9bbcdaa4f5321b6ad2ecb5.nii.gz";

/** The keys alone, for the shape assertions below. Sizes have their own block. */
const keysOf = (stdout: string, prefix: string) =>
  new Set(parseS3ObjectSizes(stdout, prefix).keys());

describe("parseS3ObjectSizes: which rows are keys at all", () => {
  // Every row carries both fields, because the command asks for both:
  // `--query Contents[].[Key,Size] --output text`. Rows here are written that
  // way rather than as bare keys, so the fixture matches what the CLI emits.
  test("strips the prefix and returns bare keys", () => {
    expect(keysOf(`${BASE}${KEY_A}\t231733\n`, BASE)).toEqual(new Set([KEY_A]));
  });

  test("reads one object per row, key then size", () => {
    const out = `${BASE}${KEY_A}\t231733\n${BASE}${KEY_B}\t10874892\n`;
    expect(keysOf(out, BASE)).toEqual(new Set([KEY_A, KEY_B]));
  });

  test("an empty prefix prints the literal None, which is not a key", () => {
    // The CLI writes "None" when nothing matched. Taking it as a key would make
    // one phantom object.
    expect(keysOf("None\n", BASE)).toEqual(new Set());
    expect(keysOf("", BASE)).toEqual(new Set());
  });

  test("ignores anything nested below the prefix", () => {
    // An annex key is one path segment. A `qa/` or `version/` object that shares
    // the prefix must not be counted as content.
    const out = `${BASE}${KEY_A}\t231733\n${BASE}nested/thing.json\t12\n`;
    expect(keysOf(out, BASE)).toEqual(new Set([KEY_A]));
  });

  test("ignores an object outside the prefix entirely", () => {
    const out = `other-dataset/objects/${KEY_A}\t231733\n${BASE}${KEY_B}\t10874892\n`;
    expect(keysOf(out, BASE)).toEqual(new Set([KEY_B]));
  });

  test("keeps git-annex's own annex-uuid marker out of nothing", () => {
    // git-annex writes an `annex-uuid` marker at the prefix root. It IS one path
    // segment, so it parses as a key -- and that is harmless, because the caller
    // intersects with the keys the tree names. Pinned so the intersection stays
    // the thing that protects us rather than an accident of this parse.
    expect(keysOf(`${BASE}annex-uuid\t36\n`, BASE)).toEqual(new Set(["annex-uuid"]));
  });

  test("is not confused by a prefix given with or without its trailing slash", () => {
    expect(keysOf(`${BASE}${KEY_A}\t231733\n`, BASE)).toEqual(new Set([KEY_A]));
  });

  test("reads a key containing a SPACE without truncating it", () => {
    // Splitting on the first whitespace run took token 0 as the name, so a key
    // with a space lost its tail and a path fragment was read as its size --
    // and a mis-parsed size means "missing content" everywhere downstream.
    // This fleet has such paths, which is why git-annex base64-encodes those
    // values in `.log.rmet` at all.
    const spaced = "SHA256E-s500--abc def.mat";
    const out = `${BASE}${spaced}\t500\n`;
    expect(parseS3ObjectSizes(out, BASE)).toEqual(new Map([[spaced, 500]]));
  });

  test("skips a row whose size did not parse rather than calling it zero bytes", () => {
    // Zero is a meaningful value here: it is the failed-copy signature. A row we
    // did not understand must not be reported as one.
    expect(parseS3ObjectSizes(`${BASE}${KEY_A}\tnot-a-number\n`, BASE)).toEqual(new Map());
  });
});

describe("parseS3ObjectSizes", () => {
  test("keeps the size, which is what tells content from a failed copy", () => {
    const out = `${BASE}${KEY_A}\t231733\n${BASE}${KEY_B}\t0\n`;
    expect(parseS3ObjectSizes(out, BASE)).toEqual(
      new Map([
        [KEY_A, 231733],
        [KEY_B, 0],
      ]),
    );
  });

  test("a row with no size is dropped, never guessed at", () => {
    // Guessing the declared size would reinstate exactly the bug: an object whose
    // size the listing did not report would be taken for whole content.
    //
    // Dropping beats recording it as 0 bytes, which is what this used to do.
    // `isKeyPresentAtDeclaredSize` treats a key with NO declared size (a `git:`
    // key) as present on its name alone, so a 0 recorded for such a key reads as
    // present; a key that is absent from the map reads as missing either way.
    // The command asks for `[Key,Size]`, so a row without both is a shape we do
    // not understand, and the safe reading of that is "not confirmed".
    expect(parseS3ObjectSizes(`${BASE}${KEY_A}\n`, BASE)).toEqual(new Map());
  });

  test("an empty prefix is an empty map", () => {
    expect(parseS3ObjectSizes("None\n", BASE)).toEqual(new Map());
    expect(parseS3ObjectSizes("", BASE)).toEqual(new Map());
  });
});
