/**
 * `shared/contract/private-site.ts` as the other two parties read it (ADR
 * 0078, ADR 0079).
 *
 * The website's authorize page and the private site's Worker cannot import
 * this file; their drift tests read it as TEXT with a pattern for
 * `export const NAME = "value"` or an integer. So what such a reader sees is
 * part of the contract, and it is asserted here with the same kind of
 * pattern, UNANCHORED, the loosest a consumer might write: a comment that
 * happens to spell an export line would show up as a phantom constant, and a
 * value built from an expression would be missing.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as contract from "../../shared/contract/private-site.js";

const TEXT = readFileSync(join(import.meta.dir, "../../shared/contract/private-site.ts"), "utf-8");

function constantsAsText(): Record<string, string | number> {
  const found: Record<string, string | number> = {};
  for (const [, name, raw] of TEXT.matchAll(/export const (\w+)\s*=\s*("[^"]*"|\d+)/g)) {
    found[name as string] = (raw as string).startsWith('"')
      ? (raw as string).slice(1, -1)
      : Number(raw);
  }
  return found;
}

describe("the contract as text", () => {
  test("a text reader sees exactly these constants, and nothing else", () => {
    expect(constantsAsText()).toEqual({
      NEMAR_API_RPC_ENTRYPOINT: "NemarApiRpc",
      PRIVATE_GRANT_TTL_SECONDS: 60,
      PRIVATE_SESSION_TTL_SECONDS: 28800,
      PRIVATE_AUTHORIZE_PATH: "/auth/private/authorize",
      PRIVATE_AUTHORIZE_STATE_PARAM: "state",
      PRIVATE_CALLBACK_PATH: "/__auth/callback",
      DESCRIBE_ACCOUNTS_MAX: 100,
    });
  });

  test("what the text says is what the module exports", () => {
    for (const [name, value] of Object.entries(constantsAsText())) {
      expect({ name, value: (contract as Record<string, unknown>)[name] }).toEqual({ name, value });
    }
  });

  test("the describeAccounts bound is D1's own limit on bound values", () => {
    // One call is one SELECT with one bound value per id, and D1 binds at most
    // 100 per statement, so a larger bound would turn a call into several reads
    // or a fault. A caller reads this constant as text to size its batches.
    expect(contract.DESCRIBE_ACCOUNTS_MAX).toBe(100);
  });

  test("a text reader finds every describeAccounts refusal spelled out in both unions", () => {
    // The other two parties read this file as text, so a union that names
    // another union (`PrincipalRefusal | "invalid_request"`) shows them one
    // literal. Each declaration runs to the blank line after it.
    const declaration = (name: string): string => {
      const start = TEXT.indexOf(`export type ${name} =`);
      expect(start).toBeGreaterThan(-1);
      return TEXT.slice(start, TEXT.indexOf("\n\n", start));
    };
    for (const name of ["DescribeAccountsRefusal", "DescribeAccountsResult"]) {
      const text = declaration(name);
      for (const literal of [
        "invalid_credential",
        "inactive_account",
        "unresolved_account",
        "unavailable",
        "invalid_request",
      ]) {
        expect({ name, literal, spelled: text.includes(`"${literal}"`) }).toEqual({
          name,
          literal,
          spelled: true,
        });
      }
      expect(text).not.toContain("PrincipalRefusal");
    }
    expect(declaration("DescribeAccountsResult")).not.toContain("DescribeAccountsRefusal");
  });

  test("the TTL literals mean what their comments say", () => {
    expect(contract.PRIVATE_SESSION_TTL_SECONDS).toBe(8 * 60 * 60);
    expect(contract.PRIVATE_GRANT_TTL_SECONDS).toBe(60);
  });
});
