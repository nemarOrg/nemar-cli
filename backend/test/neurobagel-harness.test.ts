/**
 * The Neurobagel test harness's own retry rule (epic #1586, phase 4).
 *
 * Under bun, in one process after several Miniflare instances, a server created a moment ago
 * has been found not listening (`ConnectionRefused` on Miniflare's platform proxy). The harness
 * starts such infrastructure again, and ONLY such infrastructure: an assertion that fails, or a
 * bug in the code under test, is thrown at once and never retried, or a flaky-test retry would
 * hide a real failure. This pins that line.
 */

import { describe, expect, test } from "bun:test";
import { isInfrastructureError, retryInfrastructure } from "./helpers/neurobagel-harness";

describe("what counts as the infrastructure failing", () => {
  test("a refused or unreachable connection does", () => {
    for (const err of [
      new Error("ConnectionRefused: Unable to connect. Is the computer able to access the url?"),
      new Error("Unable to connect platform-proxy"),
      Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }),
      new Error("socket hang up"),
      new TypeError("fetch failed"),
    ]) {
      expect(isInfrastructureError(err), err.message).toBe(true);
    }
  });

  test("an assertion failure, a bug and a refusal from the code under test do not", () => {
    for (const err of [
      new Error("expect(received).toEqual(expected)"),
      new TypeError("Cannot read properties of undefined (reading 'put')"),
      new Error("INDEX_ATTEMPTS is not defined"),
      new Error("R2 put refused"),
      "a string",
    ]) {
      expect(isInfrastructureError(err), String(err)).toBe(false);
    }
  });
});

describe("retryInfrastructure", () => {
  test("starts again after infrastructure errors and returns what the first good start gives", async () => {
    let calls = 0;
    const result = await retryInfrastructure("a server", async () => {
      calls++;
      if (calls < 3) throw new Error("ConnectionRefused");
      return "up";
    });
    expect(result).toBe("up");
    expect(calls).toBe(3);
  });

  test("an error that is not the infrastructure is thrown at once, with no second attempt", async () => {
    let calls = 0;
    await expect(
      retryInfrastructure("a server", async () => {
        calls++;
        throw new Error("expect(received).toBe(expected)");
      }),
    ).rejects.toThrow("expect(received).toBe(expected)");
    expect(calls).toBe(1);
  });

  test("it gives up after its attempts, and says what it was starting and why it failed", async () => {
    let calls = 0;
    await expect(
      retryInfrastructure(
        "a server",
        async () => {
          calls++;
          throw new Error("Unable to connect");
        },
        3,
      ),
    ).rejects.toThrow(
      /a server: the test infrastructure did not come up after 3 attempts.*Unable to connect/,
    );
    expect(calls).toBe(3);
  });
});
