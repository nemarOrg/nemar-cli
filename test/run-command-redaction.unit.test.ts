/**
 * What --verbose shows when the CLI reads a GitHub token through the real gh executable.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitHubToken } from "../src/lib/git-annex/github";
import { credentialValues } from "../src/lib/git-annex/run-command";
import { setVerbose } from "../src/lib/verbose";

const SECRET = "NEMAR-TEST-GH-TOKEN-0123456789";

/** Run fn with verbose on, collecting what is written to stderr. */
async function verboseLog<T>(fn: () => Promise<T>): Promise<{ value: T; log: string }> {
  const chunks: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  setVerbose(true);
  try {
    return { value: await fn(), log: chunks.join("") };
  } finally {
    setVerbose(false);
    process.stderr.write = write;
  }
}

afterEach(() => setVerbose(false));

describe("getGitHubToken under --verbose", () => {
  test("the real gh auth token result is not written to the verbose log", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "nemar-gh-auth-"));
    const previous = {
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN,
    };
    process.env.GH_CONFIG_DIR = configDir;
    process.env.GH_TOKEN = SECRET;
    Reflect.deleteProperty(process.env, "GITHUB_TOKEN");
    Reflect.deleteProperty(process.env, "GH_ENTERPRISE_TOKEN");

    try {
      const { value, log } = await verboseLog(getGitHubToken);

      expect(value.token).toBe(SECRET);
      expect(log).toContain("[sensitive subprocess output suppressed]");
      expect(log).not.toContain(SECRET);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("without --verbose the command writes nothing to the log", async () => {
    const chunks: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const { runCommand } = await import("../src/lib/git-annex/run-command");
      await runCommand(["git", "rev-parse", "--is-inside-work-tree"], {
        cwd: process.cwd(),
      });
    } finally {
      process.stderr.write = write;
    }
    expect(chunks.join("")).toBe("");
  });
});

describe("credentialValues", () => {
  test("collects the given and inherited AWS values once each, skipping empty ones", () => {
    const keys = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"] as const;
    const saved = keys.map((key) => process.env[key]);
    for (const key of keys) Reflect.deleteProperty(process.env, key);
    process.env.AWS_ACCESS_KEY_ID = "INHERITED-KEY-ID-0001";
    try {
      const values = credentialValues({
        AWS_SECRET_ACCESS_KEY: "NEMAR-TEST-AWS-SECRET",
        AWS_SESSION_TOKEN: "",
        AWS_ACCESS_KEY_ID: "INHERITED-KEY-ID-0001",
      });
      expect(values.sort()).toEqual(["INHERITED-KEY-ID-0001", "NEMAR-TEST-AWS-SECRET"].sort());
    } finally {
      for (const [i, key] of keys.entries()) {
        const value = saved[i];
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });
});
