/**
 * Which provider each Worker sends through (epic #1893 phase 2, ADR 0110): both production and
 * staging send through the Cloudflare binding, and only production falls back to Resend, for quota
 * and account-level refusals. Parsed with Bun's TOML parser, so a misplaced or commented-out line
 * fails here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type VarsBlock = Record<string, unknown>;
type SendEmail = { name: string; allowed_sender_addresses?: string[] };

const config = Bun.TOML.parse(
  readFileSync(join(import.meta.dir, "../wrangler-sccn.toml"), "utf-8"),
) as {
  vars?: VarsBlock;
  send_email?: SendEmail[];
  env?: Record<string, { vars?: VarsBlock; send_email?: SendEmail[] }>;
};

describe("backend/wrangler-sccn.toml email provider", () => {
  test("the vars blocks it checks exist (the guard is not vacuous)", () => {
    expect(config.vars?.ENVIRONMENT).toBe("production");
    expect(config.env?.dev?.vars?.ENVIRONMENT).toBe("development");
  });

  test("production and staging send through the Cloudflare binding they declare", () => {
    expect(config.vars?.EMAIL_PROVIDER).toBe("cloudflare");
    expect(config.env?.dev?.vars?.EMAIL_PROVIDER).toBe("cloudflare");
    expect(config.send_email?.map((b) => b.name)).toEqual(["EMAIL"]);
    expect(config.env?.dev?.send_email?.map((b) => b.name)).toEqual(["EMAIL"]);
  });

  test("only production falls back to Resend", () => {
    expect(config.vars?.EMAIL_FALLBACK).toBe("resend");
    const where = Object.entries(config.env ?? {})
      .filter(([, env]) => Object.keys(env.vars ?? {}).includes("EMAIL_FALLBACK"))
      .map(([name]) => name);
    expect(where).toEqual([]);
  });
});
