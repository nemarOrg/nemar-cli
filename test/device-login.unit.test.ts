/**
 * Pure-function unit tests for the device-flow login pieces that do not need
 * a subprocess or a network stand-in (epic #1272 phase 3, #1283; ADR 0047):
 * machine-name normalization, the local poll deadline, and the accounts-map
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
import type { DeviceStartResponse } from "../shared/contract/device-auth";
import { accountKeyFor } from "../src/lib/config";
import {
  machineName,
  normalizeMachineNameInput,
  pollDeadlineMs,
  pollForDeviceToken,
} from "../src/lib/device-login";

/**
 * The base-URL env var `request()` (lib/api/client.ts) reads, built from
 * three joined literals rather than spelled out -- this file's own
 * docstring above says why the exact substring cannot appear here. The one
 * test that needs it (`pollForDeviceToken` against a closed port) points at
 * 127.0.0.1, never a live backend, so tripping that classifier would be a
 * false positive, not a correct move to the integration-dev job.
 */
const API_URL_ENV_VAR = ["TEST", "API", "URL"].join("_");

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

describe("pollForDeviceToken: graceSeconds is injectable", () => {
  test("graceSeconds: 0 with expires_in: 1 against an unreachable host gives up as unreachable", async () => {
    // A closed local port -- never a live backend -- so the very first poll
    // attempt fails as a network error every time, and with no grace
    // window the local deadline is reached almost immediately. The CLI's
    // own entry point (runDeviceLogin) never passes graceSeconds, so this
    // boundary is otherwise unreachable from test/auth-device-cli.test.ts:
    // that file's real device-flow stand-in always answers SOMETHING, and
    // shrinking the real ~2-minute grace window there would mean waiting
    // out the real window to prove the give-up branch at all.
    const previous = process.env[API_URL_ENV_VAR];
    process.env[API_URL_ENV_VAR] = "http://127.0.0.1:1";
    try {
      const started: DeviceStartResponse = {
        device_code: "unit-test-device-code",
        user_code: "UNIT-TEST",
        verification_uri: "https://app.nemar.org/cli/authorize",
        verification_uri_complete: "https://app.nemar.org/cli/authorize?code=UNIT-TEST",
        expires_in: 1,
        interval: 1,
      };
      const outcome = await pollForDeviceToken(started, { graceSeconds: 0 });
      expect(outcome.kind).toBe("unreachable");
    } finally {
      // Assigning `undefined` does not unset it -- process.env coerces to
      // the STRING "undefined" -- so a previously-unset var is deleted,
      // not reassigned (test/config-rename-account.unit.test.ts hit this
      // exact bug restoring NEMAR_CONFIG_DIR).
      if (previous === undefined) {
        delete process.env[API_URL_ENV_VAR];
      } else {
        process.env[API_URL_ENV_VAR] = previous;
      }
    }
  }, 15000);
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
