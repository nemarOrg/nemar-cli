/**
 * bcryptjs version-alignment compatibility (nemar-cli#1232, epic #1225 phase 5).
 *
 * Before this phase, backend/package.json pinned bcryptjs@^2.4.3 (the real
 * password-hashing path, backend/src/services/password.ts) while the root
 * package.json pinned bcryptjs@^3.0.3 (used only by scripts/setup-test-users.ts).
 * Both are now aligned upward to ^3.0.3. bcryptjs 2.4.3 emits `$2a$` hashes and
 * 3.0.3 emits `$2b$`, and each version's `compare` accepts the other's hashes
 * while still rejecting a wrong password -- so every hash already stored in
 * production D1, all written by the pre-alignment 2.4.3 dependency, keeps
 * verifying after the bump. This file re-derives that claim against the real
 * entry points rather than trusting it.
 */

import { describe, expect, test } from "bun:test";
import { hashSync } from "bcryptjs";
import { hashPassword, validatePasswordStrength, verifyPassword } from "../src/services/password";

const PASSWORD = "TestPassword123!";
const WRONG_PASSWORD = "WrongPassword123!";

describe("password hashing: bcryptjs version alignment", () => {
  test("round trip through the production entry points", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash.startsWith("$2b$")).toBe(true);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword(WRONG_PASSWORD, hash)).toBe(false);
  });

  test("verifyPassword accepts a stored $2a$ hash produced by bcryptjs 2.4.3", async () => {
    // Generated with the real bcryptjs@2.4.3 package (the version
    // backend/package.json pinned before this phase) via
    // `bcrypt.hashSync("TestPassword123!", 10)`, run in an isolated scratch
    // install outside this repo. This is a recorded real value, not a
    // synthetic string built to match a regex: it is exactly the byte string
    // the old dependency produces, and it stands in for every password hash
    // already sitting in production D1. If bcryptjs 3.0.3's `compare` ever
    // stopped accepting `$2a$` hashes, every existing user would be locked
    // out on their next login.
    const legacyHash = "$2a$10$1Zw/x.ICr1qeu29Oj2aTq.13N2F7UH0A.DhmFwp8CY0nJnry6WuuG";
    expect(await verifyPassword(PASSWORD, legacyHash)).toBe(true);
    expect(await verifyPassword(WRONG_PASSWORD, legacyHash)).toBe(false);
  });

  test("the seeding path: hashSync verifies through the backend's verifyPassword", async () => {
    // scripts/setup-test-users.ts (root of the repo) calls bcryptjs's
    // `hashSync` directly to seed test-user password hashes. After this
    // phase's alignment, root and backend both declare bcryptjs@^3.0.3 and
    // bun resolves both to the identical 3.0.3 package (verified
    // byte-for-byte identical index.js across the two independent
    // node_modules trees -- there is no bun workspace hoisting here). So
    // this case degenerates to the round-trip case above: there is no
    // longer a second version to exercise, and faking one would defeat the
    // point. It stays a separate case because it drives the actual
    // `hashSync` entry point the seeding script calls, not `hashPassword`.
    const hash = hashSync(PASSWORD, 10);
    expect(hash.startsWith("$2b$")).toBe(true);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword(WRONG_PASSWORD, hash)).toBe(false);
  });

  test("validatePasswordStrength is unaffected by the bcryptjs alignment", () => {
    expect(validatePasswordStrength(PASSWORD).valid).toBe(true);
    expect(validatePasswordStrength(PASSWORD).errors).toEqual([]);

    const tooShort = validatePasswordStrength("Ab1");
    expect(tooShort.valid).toBe(false);
    expect(tooShort.errors).toContain("Password must be at least 12 characters");

    const noUppercase = validatePasswordStrength("alllowercase123");
    expect(noUppercase.valid).toBe(false);
    expect(noUppercase.errors).toContain("Password must contain at least one uppercase letter");

    const noDigit = validatePasswordStrength("NoDigitsHerePlease");
    expect(noDigit.valid).toBe(false);
    expect(noDigit.errors).toContain("Password must contain at least one number");
  });
});
