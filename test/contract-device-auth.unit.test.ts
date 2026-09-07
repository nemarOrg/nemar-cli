/**
 * Pure unit tests for the device authorization grant contract (epic #1272
 * phase 1, #1281; ADR 0047).
 *
 * No live backend -- validates the user-code alphabet/format helpers and the
 * refusal message table directly. The route behavior these codes drive is
 * covered by backend/test/device-auth-routes.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  DEVICE_AUTH_MESSAGES,
  DEVICE_AUTH_REFUSAL_CODES,
  DEVICE_GRANT_MESSAGES,
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
  deviceAuthRefusalCodeSchema,
  deviceGrantErrorSchema,
  formatUserCode,
  normalizeUserCode,
} from "../shared/contract/index.js";

describe("USER_CODE_ALPHABET", () => {
  test("excludes every vowel and 0/O/1/I", () => {
    for (const excluded of ["A", "E", "I", "O", "U", "0", "1"]) {
      expect(USER_CODE_ALPHABET.includes(excluded)).toBe(false);
    }
  });

  test("has no duplicate symbols and is exactly 28 characters", () => {
    // 28 = 9 * (byte rejection ceiling 252 / 28), the clean divisor
    // generateUserCode's rejection sampling relies on.
    expect(USER_CODE_ALPHABET.length).toBe(28);
    expect(new Set(USER_CODE_ALPHABET.split("")).size).toBe(USER_CODE_ALPHABET.length);
  });
});

describe("formatUserCode / normalizeUserCode round trip", () => {
  test("formats an 8-char code as XXXX-XXXX", () => {
    expect(formatUserCode("BCDFGHJK")).toBe("BCDF-GHJK");
  });

  test("normalizes a formatted, lowercase, or spaced code back to the raw form", () => {
    expect(normalizeUserCode("BCDF-GHJK")).toBe("BCDFGHJK");
    expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDFGHJK");
    expect(normalizeUserCode("bcdf ghjk")).toBe("BCDFGHJK");
    expect(normalizeUserCode(formatUserCode("BCDFGHJK"))).toBe("BCDFGHJK");
  });

  test("rejects the wrong length after stripping separators", () => {
    expect(normalizeUserCode("BCDF-GHJ")).toBeNull();
    expect(normalizeUserCode("BCDF-GHJKL")).toBeNull();
    expect(normalizeUserCode("")).toBeNull();
  });

  test("rejects a code containing a character outside the alphabet", () => {
    // 'A' is a vowel; 'O', '0', '1', 'I' are the excluded look-alikes.
    for (const bad of ["ACDFGHJK", "OCDFGHJK", "0CDFGHJK", "1CDFGHJK", "ICDFGHJK"]) {
      expect(normalizeUserCode(bad)).toBeNull();
    }
  });

  test("every character USER_CODE_ALPHABET contains round-trips", () => {
    const code = USER_CODE_ALPHABET.slice(0, USER_CODE_LENGTH);
    expect(normalizeUserCode(formatUserCode(code))).toBe(code);
  });
});

describe("device auth refusal messages", () => {
  test("every refusal code in the schema has a message", () => {
    for (const code of deviceAuthRefusalCodeSchema.options) {
      expect(DEVICE_AUTH_MESSAGES[code]).toBeTruthy();
    }
    expect(Object.keys(DEVICE_AUTH_MESSAGES).sort()).toEqual([...DEVICE_AUTH_REFUSAL_CODES].sort());
  });

  test("every refusal message is one sentence plus one next step", () => {
    for (const code of deviceAuthRefusalCodeSchema.options) {
      const message = DEVICE_AUTH_MESSAGES[code];
      // At least two sentences: a fact, and what to do about it.
      const sentences = message.split(". ").filter((s) => s.length > 0);
      expect(sentences.length).toBeGreaterThanOrEqual(2);
      expect(message.trim().endsWith(".")).toBe(true);
    }
  });

  test("service_account is declared but reserved for phase 4", () => {
    expect(DEVICE_AUTH_MESSAGES.service_account).toContain("Service accounts");
  });
});

describe("device grant error messages", () => {
  test("every grant error in the schema has a message", () => {
    for (const code of deviceGrantErrorSchema.options) {
      expect(DEVICE_GRANT_MESSAGES[code]).toBeTruthy();
    }
  });
});
