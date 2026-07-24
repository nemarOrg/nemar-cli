/**
 * Pure unit tests for the non-production email-code sign-in allowlist
 * (#1008). The dev/staging D1 mirrors real production users and the
 * non-production /auth/code/request response echoes dev_code, so the
 * policy in services/auth-code.ts is what stands between "staging QA
 * works without an inbox" and "anyone can sign in as any mirrored
 * user". No I/O — the route wiring is exercised by the live
 * passwordless suite at dev-to-main promotion.
 */

import { describe, expect, test } from "bun:test";
import {
  NONPROD_TEST_ACCOUNT,
  nonProdCodeEchoAllowed,
  nonProdCodeRequestAllowed,
} from "../src/services/auth-code";

describe("nonProdCodeRequestAllowed (#1008)", () => {
  test("admins and owners may request codes regardless of email", () => {
    expect(nonProdCodeRequestAllowed("admin", "real-admin@gmail.com")).toBe(true);
    expect(nonProdCodeRequestAllowed("owner", "real-owner@ucsd.edu")).toBe(true);
  });

  test("the shared QA account may request codes", () => {
    expect(nonProdCodeRequestAllowed("member", NONPROD_TEST_ACCOUNT)).toBe(true);
    expect(NONPROD_TEST_ACCOUNT).toBe("test@nemar.org");
  });

  test("@nemar.test fixture accounts may request codes (live suite depends on it)", () => {
    expect(nonProdCodeRequestAllowed("member", "pl-happy-123@nemar.test")).toBe(true);
    expect(nonProdCodeRequestAllowed(null, "pl-happy-123@nemar.test")).toBe(true);
  });

  test("mirrored real member accounts are refused", () => {
    expect(nonProdCodeRequestAllowed("member", "someone@gmail.com")).toBe(false);
    expect(nonProdCodeRequestAllowed(null, "someone@university.edu")).toBe(false);
  });

  test("lookalike domains do not pass the suffix check", () => {
    expect(nonProdCodeRequestAllowed("member", "x@evilnemar.test.com")).toBe(false);
    expect(nonProdCodeRequestAllowed("member", "test@nemar.org.attacker.io")).toBe(false);
    expect(nonProdCodeRequestAllowed("member", "not-test@nemar.org")).toBe(false);
  });
});

describe("nonProdCodeEchoAllowed (#1008)", () => {
  test("synthetic accounts get dev_code echoed", () => {
    expect(nonProdCodeEchoAllowed(NONPROD_TEST_ACCOUNT)).toBe(true);
    expect(nonProdCodeEchoAllowed("pl-rotate-9@nemar.test")).toBe(true);
  });

  test("admins/owners never get dev_code echoed — the response body is attacker-readable", () => {
    // The echo policy is email-based only; even a real admin address
    // must read the code from the actual email.
    expect(nonProdCodeEchoAllowed("real-admin@gmail.com")).toBe(false);
    expect(nonProdCodeEchoAllowed("shirazi@ieee.org")).toBe(false);
  });
});
