/**
 * `uniqueViolationColumns` / `isUniqueViolationOn` / `isOrcidIdentityUniqueViolation`
 * (#1254 review; ADR 0043).
 *
 * These decide whether a caught write failure is reported to a user as "that
 * identifier is taken" or as a 500, at six call sites. Getting it wrong is not
 * cosmetic in either direction: too narrow and a real collision surfaces as an
 * opaque error, too broad and a disk fault tells someone to go change an email
 * address that is fine.
 *
 * The error strings here are not invented. Each is the exact text one of the
 * two engines produces, captured from a real failure: bun:sqlite writes
 * `UNIQUE constraint failed: users.orcid`, and real D1 appends its own suffix
 * (`: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)`) -- verified with
 * `wrangler d1 execute --local` against migration 0077's indexes. A parser
 * that handled only the bun form would pass every test in this repo and
 * mis-report every collision in production.
 *
 * Pure functions with a fixed input, so this is a unit test by nature; the
 * behaviour AT the call sites is covered by the fault-injected route tests in
 * identity-refusals-route.test.ts and user-duplicates-route.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  isOrcidIdentityUniqueViolation,
  isUniqueViolationOn,
  uniqueViolationColumns,
} from "../src/services/identity";

const BUN_FORM = "UNIQUE constraint failed: users.orcid";
const D1_FORM =
  "UNIQUE constraint failed: users.orcid: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)";
const IDENTITY_FORM =
  "UNIQUE constraint failed: oauth_identities.provider, oauth_identities.provider_subject";

describe("uniqueViolationColumns", () => {
  test("parses the bun:sqlite form", () => {
    expect(uniqueViolationColumns(new Error(BUN_FORM))).toEqual(["users.orcid"]);
  });

  test("parses the real D1 form, without swallowing its suffix", () => {
    expect(uniqueViolationColumns(new Error(D1_FORM))).toEqual(["users.orcid"]);
  });

  test("parses a multi-column constraint", () => {
    expect(uniqueViolationColumns(new Error(IDENTITY_FORM))).toEqual([
      "oauth_identities.provider",
      "oauth_identities.provider_subject",
    ]);
  });

  test("returns nothing for an error that is not a UNIQUE violation", () => {
    expect(uniqueViolationColumns(new Error("disk I/O error"))).toEqual([]);
    expect(uniqueViolationColumns(new Error("NOT NULL constraint failed: users.email"))).toEqual([]);
  });

  test("survives a non-Error value", () => {
    // D1 errors do not always arrive as Error instances, which is why the
    // signature takes `unknown`.
    expect(uniqueViolationColumns(BUN_FORM)).toEqual(["users.orcid"]);
    expect(uniqueViolationColumns({ message: BUN_FORM })).toEqual([]);
    expect(uniqueViolationColumns(null)).toEqual([]);
    expect(uniqueViolationColumns(undefined)).toEqual([]);
  });
});

describe("isUniqueViolationOn", () => {
  test("matches its own column, in both engines' spellings", () => {
    expect(isUniqueViolationOn(new Error(BUN_FORM), "orcid")).toBe(true);
    expect(isUniqueViolationOn(new Error(D1_FORM), "orcid")).toBe(true);
  });

  test("does not match a DIFFERENT column", () => {
    expect(isUniqueViolationOn(new Error(BUN_FORM), "email")).toBe(false);
  });

  test("does not confuse users.email with users.email_verified", () => {
    // The reason this parses instead of substring-matching: `users.email` is a
    // prefix of `users.email_verified`, so `msg.includes("users.email")` --
    // the original implementation -- reports an unrelated constraint failure
    // as "that address is taken".
    const err = new Error("UNIQUE constraint failed: users.email_verified");
    expect(isUniqueViolationOn(err, "email")).toBe(false);
  });

  test("matches an exact column even when another is listed alongside", () => {
    const err = new Error("UNIQUE constraint failed: users.email, users.github_username");
    expect(isUniqueViolationOn(err, "email")).toBe(true);
    expect(isUniqueViolationOn(err, "github_username")).toBe(true);
    expect(isUniqueViolationOn(err, "orcid")).toBe(false);
  });

  test("is false for a non-UNIQUE failure", () => {
    expect(isUniqueViolationOn(new Error("disk I/O error"), "email")).toBe(false);
  });
});

describe("isOrcidIdentityUniqueViolation", () => {
  test("matches the oauth_identities constraint", () => {
    expect(isOrcidIdentityUniqueViolation(new Error(IDENTITY_FORM))).toBe(true);
  });

  test("does not match a users-table collision", () => {
    // The two are handled differently at finalize: only the identity one
    // means "somebody else already links this iD".
    expect(isOrcidIdentityUniqueViolation(new Error(BUN_FORM))).toBe(false);
  });
});
