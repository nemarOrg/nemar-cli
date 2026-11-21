/**
 * Email Preferences Tests
 *
 * Unit tests for parseEmailPreferences and CLI smoke tests
 * for admin email-preferences commands.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import { parseEmailPreferences } from "../backend/src/services/email";
import { TEST_CONFIG, sleep } from "./setup";

// ============================================================================
// Unit tests for parseEmailPreferences
// ============================================================================

describe("parseEmailPreferences", () => {
  test("null input returns all enabled", () => {
    const result = parseEmailPreferences(null);
    expect(result).toEqual({
      user_approval: true,
      publication_request: true,
      news: true,
      rfcs: true,
      maintenance: true,
      dataset_anonymity: true,
      identifier_sweep: true,
      support_tickets: true,
    });
  });

  test("valid JSON with both fields", () => {
    const result = parseEmailPreferences(
      JSON.stringify({ user_approval: false, publication_request: true, news: true }),
    );
    expect(result).toEqual({
      user_approval: false,
      publication_request: true,
      news: true,
      rfcs: true,
      maintenance: true,
      dataset_anonymity: true,
      identifier_sweep: true,
      support_tickets: true,
    });
  });

  test("valid JSON with all disabled", () => {
    // #1409: the stored row predates `dataset_anonymity`, so it opts IN.
    // Every field here is `!== false`, which means a key a row has never seen
    // defaults to enabled -- and for an anonymity alert that is the direction
    // that matters. Defaulting a new alert to OFF would have given every
    // current admin no anonymity mail at all, silently, on the day it shipped.
    const result = parseEmailPreferences(
      JSON.stringify({ user_approval: false, publication_request: false, news: false }),
    );
    expect(result).toEqual({
      user_approval: false,
      publication_request: false,
      news: false,
      rfcs: true,
      maintenance: true,
      dataset_anonymity: true,
      identifier_sweep: true,
      support_tickets: true,
    });
  });

  test("an explicit dataset_anonymity: false is honored", () => {
    // The control for the default above: opting out is still possible, it just
    // has to be said. Without this, a parse that ignored the key entirely
    // would satisfy every other assertion in this file.
    const result = parseEmailPreferences(JSON.stringify({ dataset_anonymity: false }));
    expect(result.dataset_anonymity).toBe(false);
    expect(result.news).toBe(true);
  });

  test("an explicit support_tickets: false is honored, and a row that predates it opts in", () => {
    expect(parseEmailPreferences(JSON.stringify({ support_tickets: false })).support_tickets).toBe(
      false,
    );
    expect(parseEmailPreferences(JSON.stringify({ identifier_sweep: false })).support_tickets).toBe(
      true,
    );
  });

  test("an explicit identifier_sweep: false is honored, and a row that predates it opts in", () => {
    // Epic #1610 phase 5 (ADR 0088): the identifier sweep's weekly report. Same
    // default as dataset_anonymity above, and the same control in both directions.
    expect(
      parseEmailPreferences(JSON.stringify({ identifier_sweep: false })).identifier_sweep,
    ).toBe(false);
    expect(
      parseEmailPreferences(JSON.stringify({ dataset_anonymity: false })).identifier_sweep,
    ).toBe(true);
  });

  test("missing fields default to true", () => {
    const result = parseEmailPreferences(JSON.stringify({}));
    expect(result).toEqual({
      user_approval: true,
      publication_request: true,
      news: true,
      rfcs: true,
      maintenance: true,
      dataset_anonymity: true,
      identifier_sweep: true,
      support_tickets: true,
    });
  });

  test("partial fields: only user_approval set", () => {
    const result = parseEmailPreferences(JSON.stringify({ user_approval: false }));
    expect(result).toEqual({
      user_approval: false,
      publication_request: true,
      news: true,
      rfcs: true,
      maintenance: true,
      dataset_anonymity: true,
      identifier_sweep: true,
      support_tickets: true,
    });
  });

  test("partial fields: only publication_request set", () => {
    const result = parseEmailPreferences(JSON.stringify({ publication_request: false }));
    expect(result).toEqual({
      user_approval: true,
      publication_request: false,
      news: true,
      rfcs: true,
      maintenance: true,
      dataset_anonymity: true,
      identifier_sweep: true,
      support_tickets: true,
    });
  });

  test("corrupt JSON returns all enabled", () => {
    const result = parseEmailPreferences("{not valid json");
    expect(result).toEqual({
      user_approval: true,
      publication_request: true,
      news: true,
      rfcs: true,
      maintenance: true,
      dataset_anonymity: true,
      identifier_sweep: true,
      support_tickets: true,
    });
  });

  test("empty string returns all enabled", () => {
    const result = parseEmailPreferences("");
    expect(result).toEqual({
      user_approval: true,
      publication_request: true,
      news: true,
      rfcs: true,
      maintenance: true,
      dataset_anonymity: true,
      identifier_sweep: true,
      support_tickets: true,
    });
  });

  test("extra fields are ignored", () => {
    const result = parseEmailPreferences(
      JSON.stringify({ user_approval: false, publication_request: true, unknown_field: false }),
    );
    expect(result).toEqual({
      user_approval: false,
      publication_request: true,
      news: true,
      rfcs: true,
      maintenance: true,
      dataset_anonymity: true,
      identifier_sweep: true,
      support_tickets: true,
    });
  });

  test("each community key is read on its own, and a key a row has never seen is on", () => {
    // Owner decision 2026-11-20: news is opt-out, so "never chose" is ON for all three, and one
    // key's opt-out must not leak into its neighbors (a parse that read one key for all three
    // would pass every all-true and all-false case above).
    const off = (key: "news" | "rfcs" | "maintenance") =>
      parseEmailPreferences(JSON.stringify({ [key]: false }));
    expect(off("news")).toMatchObject({ news: false, rfcs: true, maintenance: true });
    expect(off("rfcs")).toMatchObject({ news: true, rfcs: false, maintenance: true });
    expect(off("maintenance")).toMatchObject({ news: true, rfcs: true, maintenance: false });
  });

  test("the retired announcements key is ignored, never read as a community opt-out", () => {
    // Migration 0146 carries it into the three keys; a row that somehow still has it (a rollback
    // window, a restore) must not silently decide anyone's mail, and must not appear in the result.
    const result = parseEmailPreferences(JSON.stringify({ announcements: false }));
    expect(result).toMatchObject({ news: true, rfcs: true, maintenance: true });
    expect("announcements" in result).toBe(false);
  });

  test("a recall has no stored key, so no stored value can switch it off", () => {
    const result = parseEmailPreferences(JSON.stringify({ recall: false }));
    expect("recall" in result).toBe(false);
  });

  test("null values in fields default to true", () => {
    const result = parseEmailPreferences(
      JSON.stringify({ user_approval: null, publication_request: null }),
    );
    expect(result).toEqual({
      user_approval: true,
      publication_request: true,
      news: true,
      rfcs: true,
      maintenance: true,
      dataset_anonymity: true,
      identifier_sweep: true,
      support_tickets: true,
    });
  });

  test("zero values treated as false", () => {
    const result = parseEmailPreferences(
      JSON.stringify({ user_approval: 0, publication_request: 0 }),
    );
    // 0 !== false is true, so these default to enabled
    expect(result).toEqual({
      user_approval: true,
      publication_request: true,
      news: true,
      rfcs: true,
      maintenance: true,
      dataset_anonymity: true,
      identifier_sweep: true,
      support_tickets: true,
    });
  });
});

// ============================================================================
// CLI smoke tests for admin email-preferences commands
// ============================================================================

interface TestContext {
  configDir: string;
  configFile: string;
}

function createTestContext(): TestContext {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const configDir = join(import.meta.dir, ".test-configs", uniqueId);
  mkdirSync(configDir, { recursive: true });
  const configFile = join(configDir, "config.json");
  return { configDir, configFile };
}

async function runCli(
  args: string[],
  ctx?: TestContext,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", "src/index.ts", ...args],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      ...(ctx ? { NEMAR_CONFIG_DIR: ctx.configDir } : {}),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

function setTestConfig(ctx: TestContext, config: Record<string, unknown>) {
  writeFileSync(ctx.configFile, JSON.stringify(config));
}

beforeEach(async () => {
  await sleep(300);
});

describe("admin email-preferences show", () => {
  test("shows help text", async () => {
    const { stdout } = await runCli(["admin", "email-preferences", "show", "--help"]);
    expect(stdout).toContain("email");
  });

  test("requires authentication", async () => {
    const ctx = createTestContext();
    const { stderr, exitCode } = await runCli(["admin", "email-preferences", "show"], ctx);
    const output = stderr + (await runCli(["admin", "email-preferences", "show"], ctx)).stdout;
    expect(exitCode).not.toBe(0);
  });
});

describe("admin email-preferences update", () => {
  test("shows help text", async () => {
    const { stdout } = await runCli(["admin", "email-preferences", "update", "--help"]);
    expect(stdout).toContain("email");
  });

  test("requires authentication", async () => {
    const ctx = createTestContext();
    const { exitCode } = await runCli(
      ["admin", "email-preferences", "update", "--user-approval", "true"],
      ctx,
    );
    expect(exitCode).not.toBe(0);
  });
});
