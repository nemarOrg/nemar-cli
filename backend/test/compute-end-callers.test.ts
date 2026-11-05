/**
 * The two sets that must agree (epic #2005 phase A8, #2013; AGENTS.md, "Revocation cascades, always"):
 * the functions that RUN `computeReleaseStatements`, and the functions that END every credential of an
 * account (revoke all of its API keys and its sessions). `COMPUTE_END_CALLERS` documents the first;
 * `COMPUTE_END_EXCEPTIONS` names the functions that revoke keys and sessions WITHOUT ending the account,
 * each with its reason. The scan (`helpers/compute-end-scan.ts`) holds both lists to the code, on the
 * syntax tree, so a third path that ends an account (the suspension of compute, an owner command that
 * merges two accounts) cannot be added without either running the compute set or being named an
 * exception here, in a reviewed change.
 *
 * Each rule is shown to FIRE by a planted file laid over the real tree: a new account-ending function
 * that forgot the compute set, whether its SQL is inline or in a constant or a helper; and every way of
 * reaching `computeReleaseStatements` (an aliased import, a namespace property, a local alias, a
 * destructuring, passing it as a value) is seen, while what the scan cannot follow (a dynamic import, a
 * re-export, a reference at module top level) is refused loudly and never guessed at.
 * MUTATIONS: remove the statements from `finalizeRevocation` or `tombstoneUserCascade` (the scan names
 * the function); add a function of the same shape.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPUTE_END_CALLERS, COMPUTE_END_EXCEPTIONS } from "../src/services/compute-release";
import { analyse } from "./helpers/compute-end-scan";
import { SRC, createTree } from "./helpers/ts-scan";

const real = analyse(createTree());

describe("the real tree", () => {
  test("the scan sees what it is meant to see (it is not vacuous)", () => {
    expect(real.ends).toEqual(
      expect.arrayContaining([
        "db/user-tombstone.ts#tombstoneUserCascade",
        "routes/admin/users.ts#finalizeRevocation",
        "routes/admin/users.ts#POST /users/:username/role",
      ]),
    );
    expect(real.users.length).toBeGreaterThanOrEqual(2);
  });

  test("the functions that run the compute set are exactly COMPUTE_END_CALLERS", () => {
    expect(real.users).toEqual([...COMPUTE_END_CALLERS].sort());
  });

  test("every function that ends every credential runs the compute set, or is a deliberate exception", () => {
    const missing = real.unsatisfied.filter((key) => !(key in COMPUTE_END_EXCEPTIONS));
    expect(missing).toEqual([]);
  });

  test("every exception is a real function that ends keys and sessions, has a reason, and is not also a caller", () => {
    for (const [key, reason] of Object.entries(COMPUTE_END_EXCEPTIONS)) {
      expect([key, real.ends.includes(key)]).toEqual([key, true]);
      expect([key, reason.length >= 40]).toEqual([key, true]);
      expect(COMPUTE_END_CALLERS as readonly string[]).not.toContain(key);
    }
  });

  test("the demotion is an exception, with the reason the docblock gives", () => {
    expect(COMPUTE_END_EXCEPTIONS).toHaveProperty([
      "routes/admin/users.ts#POST /users/:username/role",
    ]);
  });

  test("nothing in the tree is a use the scan cannot follow", () => {
    expect(real.unfollowable).toEqual([]);
  });
});

/** The real `routes/admin/users.ts` and `db/user-tombstone.ts`, text. */
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("the scan fires", () => {
  test("remove the statements from finalizeRevocation: it ends every credential and runs nothing (MUTATION)", () => {
    const text = read("routes/admin/users.ts");
    const line =
      "...computeReleaseStatements(user.id).map((s) => db.prepare(s.sql).bind(...s.binds)),";
    expect(text).toContain(line);
    const found = analyse(createTree({ "routes/admin/users.ts": text.replace(line, "") }));
    expect(found.unsatisfied).toContain("routes/admin/users.ts#finalizeRevocation");
    expect(found.users).not.toContain("routes/admin/users.ts#finalizeRevocation");
  });

  test("remove them from tombstoneUserCascade (MUTATION)", () => {
    const text = read("db/user-tombstone.ts");
    const line = "...computeReleaseStatements(id).map((s) => step(s.sql, ...s.binds)),";
    expect(text).toContain(line);
    const found = analyse(createTree({ "db/user-tombstone.ts": text.replace(line, "") }));
    expect(found.unsatisfied).toContain("db/user-tombstone.ts#tombstoneUserCascade");
  });

  const TOKENS = `"UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL"`;
  const SESSIONS = `"UPDATE web_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL"`;

  test("a new function that ends every credential and forgot compute is named, however its SQL is written", () => {
    const planted = analyse(
      createTree({
        // Inline.
        "routes/admin/planted-inline.ts": `
          export async function mergeAccounts(db: D1Database, id: number) {
            await db.batch([db.prepare(${TOKENS}).bind(id), db.prepare(${SESSIONS}).bind(id)]);
          }`,
        // In constants, imported under another name.
        "services/planted-constants.ts": `
          export const KEYS_GONE = ${TOKENS};
          export const SESSIONS_GONE = ${SESSIONS};`,
        "routes/admin/planted-imported.ts": `
          import { KEYS_GONE as k, SESSIONS_GONE as s } from "../../services/planted-constants";
          export async function suspendAccount(db: D1Database, id: number) {
            await db.batch([db.prepare(k).bind(id), db.prepare(s).bind(id)]);
          }`,
        // In a helper function, called from a route.
        "services/planted-helper.ts": `
          export async function revokeSessionsOf(db: D1Database, id: number) {
            await db.prepare(${SESSIONS}).bind(id).run();
          }`,
        "routes/admin/planted-route.ts": `
          import { revokeSessionsOf } from "../../services/planted-helper";
          export function register(admin: { post(path: string, h: (c: unknown) => unknown): void }) {
            admin.post("/users/:id/close", async () => {
              const db = {} as D1Database;
              await db.prepare(${TOKENS}).bind(1).run();
              await revokeSessionsOf(db, 1);
            });
          }`,
      }),
    );
    for (const key of [
      "routes/admin/planted-inline.ts#mergeAccounts",
      "routes/admin/planted-imported.ts#suspendAccount",
      "routes/admin/planted-route.ts#POST /users/:id/close",
    ]) {
      expect([key, planted.ends.includes(key), planted.unsatisfied.includes(key)]).toEqual([
        key,
        true,
        true,
      ]);
    }
  });

  test("a function that revokes keys alone, one key and the sessions, or one session by its cookie, is not an account's end", () => {
    const planted = analyse(
      createTree({
        "routes/planted-keys.ts": `
          export async function rotate(db: D1Database, id: number) {
            await db.prepare(${TOKENS}).bind(id).run();
          }
          export async function logout(db: D1Database, h: string) {
            await db.prepare("UPDATE web_sessions SET revoked_at = datetime('now') WHERE cookie_id_hash = ?").bind(h).run();
          }
          export async function oneKey(db: D1Database, id: number, user: number) {
            await db.prepare("UPDATE tokens SET revoked_at = datetime('now') WHERE id = ? AND user_id = ?").bind(id, user).run();
            await db.prepare(${SESSIONS}).bind(user).run();
          }`,
      }),
    );
    expect(planted.ends).not.toContain("routes/planted-keys.ts#oneKey");
    expect(planted.ends).not.toContain("routes/planted-keys.ts#rotate");
    expect(planted.ends).not.toContain("routes/planted-keys.ts#logout");
  });

  test("every way of reaching the compute set is seen as a use, and a function that ends credentials through one is satisfied", () => {
    const ends = (body: string) => `
      ${body}
      async function ender(db: D1Database, id: number) {
        await db.batch([db.prepare(${TOKENS}).bind(id), db.prepare(${SESSIONS}).bind(id)]);
      }`;
    const cases: Record<string, string> = {
      "named import": `import { computeReleaseStatements } from "../../services/compute-release";
        export function a(id: number) { return computeReleaseStatements(id); }`,
      "aliased import": `import { computeReleaseStatements as stmts } from "../../services/compute-release.js";
        export function a(id: number) { return stmts(id); }`,
      "namespace property": `import * as rel from "../../services/compute-release";
        export function a(id: number) { return rel.computeReleaseStatements(id); }`,
      "namespace element access": `import * as rel from "../../services/compute-release";
        export function a(id: number) { return rel["computeReleaseStatements"](id); }`,
      "local alias": `import { computeReleaseStatements } from "../../services/compute-release";
        const run = computeReleaseStatements;
        export function a(id: number) { return run(id); }`,
      "alias of a namespace property": `import * as rel from "../../services/compute-release";
        const run = rel.computeReleaseStatements;
        export function a(id: number) { return run(id); }`,
      "alias of a namespace element": `import * as rel from "../../services/compute-release";
        const run = rel["computeReleaseStatements"];
        export function a(id: number) { return run(id); }`,
      "alias of an alias": `import { computeReleaseStatements as first } from "../../services/compute-release";
        const second = first;
        const third = second;
        export function a(id: number) { return third(id); }`,
      "alias declared before the alias it copies": `import { computeReleaseStatements as first } from "../../services/compute-release";
        var third = second;
        var second = first;
        export function a(id: number) { return third(id); }`,
      "namespace destructuring": `import * as rel from "../../services/compute-release";
        const { computeReleaseStatements: run } = rel;
        export function a(id: number) { return run(id); }`,
      "passed as a value": `import { computeReleaseStatements } from "../../services/compute-release";
        export function a(ids: number[]) { return ids.map(computeReleaseStatements); }`,
    };
    for (const [name, body] of Object.entries(cases)) {
      const planted = analyse(createTree({ "routes/admin/planted-use.ts": ends(body) }));
      // The use is attributed to the function that makes it, not only to the module that declares an alias.
      expect([name, planted.users.includes("routes/admin/planted-use.ts#a")]).toEqual([name, true]);
      // Unreached by name, `ender` shares no function with the use, so it is still named.
      expect([name, planted.unsatisfied.includes("routes/admin/planted-use.ts#ender")]).toEqual([
        name,
        true,
      ]);
    }
    // A function that RUNS it itself is satisfied, and one that delegates to a function that does.
    const direct = analyse(
      createTree({
        "routes/admin/planted-direct.ts": `
          import { computeReleaseStatements as stmts } from "../../services/compute-release";
          export async function ender(db: D1Database, id: number) {
            await db.batch([db.prepare(${TOKENS}).bind(id), db.prepare(${SESSIONS}).bind(id), ...stmts(id).map((s) => db.prepare(s.sql))]);
          }`,
        "routes/admin/planted-delegate.ts": `
          import { computeReleaseStatements } from "../../services/compute-release";
          export function endCompute(id: number) { return computeReleaseStatements(id); }
          export async function ender(db: D1Database, id: number) {
            await db.batch([db.prepare(${TOKENS}).bind(id), db.prepare(${SESSIONS}).bind(id), ...endCompute(id).map((s) => db.prepare(s.sql))]);
          }`,
      }),
    );
    expect(direct.ends).toEqual(
      expect.arrayContaining([
        "routes/admin/planted-direct.ts#ender",
        "routes/admin/planted-delegate.ts#ender",
      ]),
    );
    expect(direct.unsatisfied).not.toContain("routes/admin/planted-direct.ts#ender");
    expect(direct.unsatisfied).not.toContain("routes/admin/planted-delegate.ts#ender");
  });

  test("what the scan cannot follow is refused, not guessed at: a dynamic import, a re-export, a module-level reference", () => {
    const planted = analyse(
      createTree({
        "routes/planted-dynamic.ts": `
          export async function a(id: number) {
            const m = await import("../services/compute-release.js");
            return m.computeReleaseStatements(id);
          }`,
        "routes/planted-reexport.ts": `export { computeReleaseStatements } from "../services/compute-release";`,
        "routes/planted-star.ts": `export * from "../services/compute-release";`,
        "routes/planted-top.ts": `
          import { computeReleaseStatements } from "../services/compute-release";
          export const later = computeReleaseStatements;`,
      }),
    );
    expect(planted.unfollowable.some((m) => m.includes("planted-dynamic.ts"))).toBe(true);
    expect(planted.unfollowable.some((m) => m.includes("planted-reexport.ts"))).toBe(true);
    expect(planted.unfollowable.some((m) => m.includes("planted-star.ts"))).toBe(true);
    expect(planted.unfollowable.some((m) => m.includes("planted-top.ts"))).toBe(true);
  });
});
