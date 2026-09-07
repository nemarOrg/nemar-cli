/**
 * Pure-function unit tests for the device-flow login pieces that do not need
 * a subprocess or a network stand-in (epic #1272 phase 3, #1283; ADR 0047):
 * machine-name normalisation, the local poll deadline, and the accounts-map
 * key a signed-in server user resolves to. The CLI-subprocess behavior these
 * feed into is covered end to end in test/auth-device-cli.test.ts.
 *
 * Unit tier: this file must never reference a live test-backend URL env
 * var, the shared HTTP test-request helper, or spawn the CLI as a
 * subprocess -- any one of the three routes a file into the
 * integration-dev CI job (.github/workflows/test.yml), which this one has
 * no business in.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MACHINE_NAME,
  DEVICE_CONFIRM_GRACE_SECONDS,
  MACHINE_NAME_MAX_CHARS,
} from "../shared/contract/device-auth";
import { accountKeyFor } from "../src/lib/config";
import { machineName, normalizeMachineNameInput, pollDeadlineMs } from "../src/lib/device-login";

describe("normalizeMachineNameInput", () => {
  test("passes an ordinary name through unchanged", () => {
    expect(normalizeMachineNameInput("laptop.local")).toBe("laptop.local");
  });

  test("strips control characters", () => {
    expect(normalizeMachineNameInput("lap\x00top\x1f.local")).toBe("laptop.local");
  });

  test("collapses internal whitespace runs to one space", () => {
    expect(normalizeMachineNameInput("my   work   laptop")).toBe("my work laptop");
  });

  test("trims leading and trailing whitespace", () => {
    expect(normalizeMachineNameInput("  laptop.local  ")).toBe("laptop.local");
  });

  test("caps at MACHINE_NAME_MAX_CHARS", () => {
    const long = "x".repeat(MACHINE_NAME_MAX_CHARS + 20);
    const result = normalizeMachineNameInput(long);
    expect(result.length).toBe(MACHINE_NAME_MAX_CHARS);
    expect(result).toBe("x".repeat(MACHINE_NAME_MAX_CHARS));
  });

  test("an empty string falls back to DEFAULT_MACHINE_NAME", () => {
    expect(normalizeMachineNameInput("")).toBe(DEFAULT_MACHINE_NAME);
  });

  test("an all-control-character/whitespace string falls back to DEFAULT_MACHINE_NAME", () => {
    expect(normalizeMachineNameInput("\x00\x01  \x1f\t")).toBe(DEFAULT_MACHINE_NAME);
  });
});

describe("machineName", () => {
  test("never throws and returns a non-empty, capped string", () => {
    // The real os.hostname() of whatever machine runs this suite -- this is
    // the live code path, not a stand-in for it; the exact value is
    // unknowable here, but its SHAPE is what normalizeMachineNameInput
    // already pins above.
    const name = machineName();
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThanOrEqual(MACHINE_NAME_MAX_CHARS);
  });
});

describe("pollDeadlineMs", () => {
  test("is startedAt plus expires_in plus the confirm grace, in milliseconds", () => {
    const startedAt = 1_000_000;
    const expiresIn = 600;
    expect(pollDeadlineMs(startedAt, expiresIn)).toBe(
      startedAt + (expiresIn + DEVICE_CONFIRM_GRACE_SECONDS) * 1000,
    );
  });

  test("is built from relative values, so it does not depend on wall-clock time", () => {
    // Two different "now" values with the same relative expiresIn produce
    // deadlines offset by exactly the difference between them -- proving the
    // computation never reads Date.now() itself (clock-skew immunity), only
    // the `startedAt` it was handed.
    const a = pollDeadlineMs(5_000, 300);
    const b = pollDeadlineMs(5_000 + 42_000, 300);
    expect(b - a).toBe(42_000);
  });
});

describe("accountKeyFor", () => {
  test("keys by username when present", () => {
    expect(accountKeyFor({ username: "ada", email: "ada@example.org" })).toBe("ada");
  });

  test("keys by email when username is null (a brand-new ORCID account, ADR 0047)", () => {
    expect(accountKeyFor({ username: null, email: "ada@example.org" })).toBe("ada@example.org");
  });

  test("keys by email when username is an empty or all-whitespace string", () => {
    expect(accountKeyFor({ username: "", email: "ada@example.org" })).toBe("ada@example.org");
    expect(accountKeyFor({ username: "   ", email: "ada@example.org" })).toBe("ada@example.org");
  });

  test("trims a username that carries incidental whitespace", () => {
    expect(accountKeyFor({ username: "  ada  ", email: "ada@example.org" })).toBe("ada");
  });
});
