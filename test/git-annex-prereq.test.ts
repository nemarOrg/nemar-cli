/**
 * git-annex version comparator (epic #1225 phase 6, site 2 of the semver
 * migration brief).
 *
 * checkGitAnnexInstalled() shells out to the `git-annex` binary to get the
 * actual version string, so it cannot be driven end-to-end in this sandbox
 * without git-annex installed -- that entry point was not reachable offline.
 * This drives the exported comparator directly instead: isVersionCompatible()
 * is the whole of what changed (semver.coerce + semver.gte replacing a
 * hand-rolled two-component parser), and checkGitAnnexInstalled() only ever
 * calls it with the two values already extracted from `git-annex version`
 * output, so the comparator IS the unit of behavior this phase changed.
 *
 * The table below is the migration's equivalence proof against the deleted
 * hand-rolled comparator (`parseVersion` + `isVersionCompatible` as they
 * stood before this phase): each row was measured against both the old
 * implementation and the new one before this file was written, and the two
 * agree on every row except where a deliberate decision is documented.
 *
 * git-annex's real version scheme is two-component MAJOR.CalVer (e.g.
 * "10.20241202"), sometimes with a build suffix ("-g1234abc"). The `-g...`
 * row is defense in depth, not a live path: checkGitAnnexInstalled() extracts
 * with `/version:\s*(\d+\.\d+)/`, which can never capture a trailing suffix,
 * so only a clean two-component string reaches the comparator in practice.
 */

import { describe, expect, test } from "bun:test";
import { isVersionCompatible } from "../src/lib/git-annex/prereq";

describe("isVersionCompatible: migration equivalence table", () => {
  test("10.20241202 >= 10.0 -> true (a real, current git-annex CalVer build)", () => {
    expect(isVersionCompatible("10.20241202", "10.0")).toBe(true);
  });

  test("8.20210223 >= 10.0 -> false (an old major version)", () => {
    expect(isVersionCompatible("8.20210223", "10.0")).toBe(false);
  });

  test("10.0 >= 10.0 -> true (exactly the minimum, inclusive)", () => {
    expect(isVersionCompatible("10.0", "10.0")).toBe(true);
  });

  test("10.20241202-g1234abc >= 10.0 -> true (build-suffixed; defense in depth, not a live path)", () => {
    expect(isVersionCompatible("10.20241202-g1234abc", "10.0")).toBe(true);
  });

  test("0.19.6 >= 10.0 -> false (a pre-10 major, three-component form)", () => {
    expect(isVersionCompatible("0.19.6", "10.0")).toBe(false);
  });

  test("11.0 >= 10.0 -> true (a newer major)", () => {
    expect(isVersionCompatible("11.0", "10.0")).toBe(true);
  });

  test("10.20200000 >= 10.20241202 -> false (same major, older CalVer minor)", () => {
    expect(isVersionCompatible("10.20200000", "10.20241202")).toBe(false);
  });
});

describe("isVersionCompatible: uncoercible input", () => {
  // semver.coerce() returns null for a string with no extractable version.
  // Decision (declared in the PR body): an uncoercible version, on either
  // side, is not compatible -- explicit, rather than letting a null flow
  // into semver.gte() and throw. This preserves the old parser's observable
  // behavior for an uncoercible `actual` (it fell back to [0], which always
  // compared as incompatible with a positive minVersion) without preserving
  // its implementation.
  test("an uncoercible actual version is never compatible", () => {
    expect(isVersionCompatible("not-a-version", "10.0")).toBe(false);
    expect(isVersionCompatible("", "10.0")).toBe(false);
  });

  test("an uncoercible required version is never satisfied", () => {
    expect(isVersionCompatible("10.20241202", "not-a-version")).toBe(false);
  });
});
