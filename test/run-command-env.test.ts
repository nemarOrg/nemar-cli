/**
 * Real subprocess tests for runCommand's `unsetEnv` option (no mocks).
 *
 * The OpenNeuro import fetches annexed metadata from OpenNeuro's PUBLIC bucket,
 * but a request signed as the CI `nemar-actions-datasets` identity is denied by
 * that IAM user's permissions boundary. git-annex only reads anonymously when
 * the AWS_* vars are ABSENT from the environment — setting them to "" is not
 * enough. `unsetEnv` must therefore delete the keys, not blank them (#768).
 */

import { describe, expect, test } from "bun:test";
import { runCommand } from "../src/lib/git-annex/run-command";

describe("runCommand unsetEnv (#768)", () => {
  test("deletes the named var so the child sees it as absent", async () => {
    const r = await runCommand(["bash", "-c", 'echo "${MY_TOKEN-ABSENT}"'], {
      env: { MY_TOKEN: "secret" },
      unsetEnv: ["MY_TOKEN"],
    });
    expect(r.exitCode).toBe(0);
    // `${VAR-default}` expands to the default only when VAR is UNSET (not when
    // it is set-but-empty), so this proves deletion rather than blanking.
    expect(r.stdout.trim()).toBe("ABSENT");
  });

  test("without unsetEnv the var is present", async () => {
    const r = await runCommand(["bash", "-c", 'echo "${MY_TOKEN-ABSENT}"'], {
      env: { MY_TOKEN: "secret" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("secret");
  });

  test("unsetEnv removes a var inherited from the parent process env", async () => {
    const key = "NEMAR_TEST_UNSET_VAR";
    process.env[key] = "from-parent";
    try {
      const r = await runCommand(["bash", "-c", `echo "\${${key}-ABSENT}"`], {
        unsetEnv: [key],
      });
      expect(r.stdout.trim()).toBe("ABSENT");
    } finally {
      delete process.env[key];
    }
  });

  test("unsetEnv for an absent var is a no-op", async () => {
    const r = await runCommand(["bash", "-c", "echo ok"], {
      unsetEnv: ["DEFINITELY_NOT_SET_12345"],
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("ok");
  });
});
