/**
 * Where `MAIL_RETENTION_DAYS` is set (epic #1893 phase 6a, ADR 0112): 730 days in production and 30
 * on staging, in the Worker's configuration file (a dashboard-only value would be dropped by the
 * next deploy). Parsed with Bun's TOML parser, so a misplaced or commented-out line fails here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { retentionDays } from "../src/services/ticket-retention";

type VarsBlock = Record<string, unknown>;

const config = Bun.TOML.parse(
  readFileSync(join(import.meta.dir, "../wrangler-sccn.toml"), "utf-8"),
) as { vars?: VarsBlock; env?: Record<string, { vars?: VarsBlock }> };

describe("backend/wrangler-sccn.toml retention", () => {
  test("the vars blocks it checks exist (the guard is not vacuous)", () => {
    expect(config.vars?.ENVIRONMENT).toBe("production");
    expect(config.env?.dev?.vars?.ENVIRONMENT).toBe("development");
  });

  test("production keeps tickets 730 days and staging 30, as quoted strings", () => {
    expect(config.vars?.MAIL_RETENTION_DAYS).toBe("730");
    expect(config.env?.dev?.vars?.MAIL_RETENTION_DAYS).toBe("30");
    expect(retentionDays({ MAIL_RETENTION_DAYS: config.vars?.MAIL_RETENTION_DAYS as string })).toBe(
      730,
    );
    expect(
      retentionDays({ MAIL_RETENTION_DAYS: config.env?.dev?.vars?.MAIL_RETENTION_DAYS as string }),
    ).toBe(30);
  });

  test("it is set in no other environment's vars", () => {
    const where = Object.entries(config.env ?? {})
      .filter(([, env]) => Object.keys(env.vars ?? {}).includes("MAIL_RETENTION_DAYS"))
      .map(([name]) => name);
    expect(where).toEqual(["dev"]);
  });
});
