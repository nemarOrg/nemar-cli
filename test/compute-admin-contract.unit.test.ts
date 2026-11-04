/**
 * The compute admin routes' wire contract (epic #2005 phase A2, #2007; ADR 0118,
 * shared/contract/compute-admin.ts): every schema it exports is a RESPONSE the command-line
 * interface (CLI) parses, so every one must accept and keep a key it does not know, at the top
 * level and in every object below, or a released CLI breaks the day the Worker adds one.
 *
 * Checked by behaviour, like the strict compute files are in contract-schemas.test.ts: a document
 * with an unknown key added to EVERY object in it must parse, and come out with the keys still on
 * it. A new export that is not in the table below fails the first test, so it is classified on
 * purpose and not by accident; the words and the constants it exports are not schemas and are
 * checked on their own.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import * as admin from "../shared/contract/compute-admin";

const pool = {
  id: 7,
  holder_kind: "account",
  holder_ref: "12",
  pool: "cpu",
  granted_milli: 12500,
  held_milli: 0,
  charged_milli: 0,
  available_milli: 12500,
  frozen: false,
  created_at: "2026-11-04 10:00:00",
  updated_at: "2026-11-04 10:00:00",
};

const entry = {
  id: 3,
  kind: "grant",
  pool_id: 7,
  budget_pool_id: null,
  granted_delta_milli: 12500,
  held_delta_milli: 0,
  charged_delta_milli: 0,
  job_id: null,
  hold_ref: null,
  reason: "admin_grant",
  actor_user_id: 1,
  created_at: "2026-11-04 10:00:00",
};

/** A valid document for each exported schema. */
const VALID: Record<string, unknown> = {
  ComputePoolViewSchema: pool,
  ComputeLedgerEntryViewSchema: entry,
  ComputePoolsResponseSchema: { pools: [pool, pool], next_after: null },
  ComputeAccountPoolsResponseSchema: { account_id: 12, pools: [pool] },
  ComputePoolWriteResponseSchema: { pool, entry, replayed: false },
  ComputePolicyResponseSchema: {
    version: 2,
    is_default: false,
    policy: { defaultGrantMilli: { cpu: 1, gpu: 2 }, registries: ["ghcr.io/team"] },
    set_by: 1,
    note: null,
    created_at: "2026-11-04 10:00:00",
  },
};

/** The same document with an unknown key on every object in it, nested ones and array items too. */
function withUnknownEverywhere(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map((v) => withUnknownEverywhere(v, depth + 1));
  if (value !== null && typeof value === "object") {
    return {
      ...Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, withUnknownEverywhere(v, depth + 1)]),
      ),
      [`future_key_${depth}`]: { added: "by a newer worker" },
    };
  }
  return value;
}

const schemas = () =>
  Object.entries(admin).filter((e): e is [string, z.ZodTypeAny] => e[1] instanceof z.ZodType);

describe("compute-admin: every exported schema is open", () => {
  test("every schema it exports is classified here, and nothing here is gone", () => {
    expect(
      schemas()
        .map(([n]) => n)
        .sort(),
    ).toEqual(Object.keys(VALID).sort());
  });

  for (const name of Object.keys(VALID)) {
    test(`${name} accepts the valid document, and the same document with an unknown key on every object`, () => {
      const schema = (admin as Record<string, unknown>)[name] as z.ZodTypeAny;
      const valid = VALID[name];
      expect(schema.safeParse(valid).success).toBe(true);
      const extended = withUnknownEverywhere(valid);
      const parsed = schema.safeParse(extended);
      expect([name, parsed.success]).toEqual([name, true]);
      // Kept, not stripped: a client that learns about a key later needs no schema change.
      if (parsed.success) expect(parsed.data).toEqual(extended);
    });
  }

  test("the behaviour test can tell: a closed schema would refuse the extended document", () => {
    const closed = z.object({ id: z.number() }).strict();
    expect(closed.safeParse(withUnknownEverywhere({ id: 1 })).success).toBe(false);
    const stripping = z.object({ id: z.number() });
    const out = stripping.parse(withUnknownEverywhere({ id: 1 }));
    expect(out).not.toEqual(withUnknownEverywhere({ id: 1 }));
  });

  test("a word the Worker may grow is a string in a response, not an enum", () => {
    const grown = { ...pool, holder_kind: "tenant", pool: "tpu" };
    expect(admin.ComputePoolViewSchema.safeParse(grown).success).toBe(true);
    expect(admin.ComputeLedgerEntryViewSchema.safeParse({ ...entry, kind: "waive" }).success).toBe(
      true,
    );
  });

  test("the file declares no closed schema at all", () => {
    const text = readFileSync(
      join(import.meta.dir, "..", "shared", "contract", "compute-admin.ts"),
      "utf8",
    );
    expect(text.includes(".strict(")).toBe(false);
  });
});

describe("compute-admin: the words and constants", () => {
  test("the platform keys are the two budgets, and the named constants are in them", () => {
    expect([...admin.COMPUTE_PLATFORM_KEYS]).toEqual(["pipelines", "people"]);
    expect(admin.COMPUTE_PIPELINES_BUDGET).toBe("pipelines");
    expect(admin.COMPUTE_PEOPLE_BUDGET).toBe("people");
    for (const k of admin.COMPUTE_PLATFORM_KEYS) expect(admin.isComputePlatformKey(k)).toBe(true);
    for (const k of ["", "People", "tenant", "pipelines ", "__proto__", "toString"]) {
      expect([k, admin.isComputePlatformKey(k)]).toEqual([k, false]);
    }
  });

  test("every error word has a status, and no status is outside 400 to 599", () => {
    expect(Object.keys(admin.COMPUTE_ADMIN_ERROR_STATUS).sort()).toEqual(
      [...admin.COMPUTE_ADMIN_ERROR_CODES].sort(),
    );
    for (const status of Object.values(admin.COMPUTE_ADMIN_ERROR_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
    expect(admin.COMPUTE_ADMIN_ERROR_STATUS.would_exceed_limit).toBe(409);
  });

  test("one request moves at most 2^40 milli-SU, far below the largest exact total", () => {
    expect(admin.COMPUTE_REQUEST_MILLI_MAX).toBe(2 ** 40);
    expect(admin.COMPUTE_REQUEST_MILLI_MAX).toBeLessThan(Number.MAX_SAFE_INTEGER / 1000);
  });

  test("the header key takes 8 to 100 letters, digits and . _ - and fits the table with its prefix", () => {
    const ok = ["abcdefgh", "k".repeat(100), "a.b_c-d.e", "0123456789"];
    const no = ["abcdefg", "k".repeat(101), "has space", "a:b:c:d:e", "a/b/c/d/e", "ünïcode-key"];
    for (const k of ok) expect([k, admin.COMPUTE_IDEMPOTENCY_KEY_RE.test(k)]).toEqual([k, true]);
    for (const k of no) expect([k, admin.COMPUTE_IDEMPOTENCY_KEY_RE.test(k)]).toEqual([k, false]);
  });
});
