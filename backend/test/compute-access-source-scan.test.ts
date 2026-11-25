/**
 * Compute access is its own grant (epic #2021 phase D1, #2022; ADR 0040: upload approval is the single
 * writer of `service_access`; ADR 0118, the compute-access addendum). Two things are held by reading the
 * source, because a test that drives a route cannot see a column a statement never names:
 *
 *  1. NO QUERY OR WRITER OF COMPUTE ACCESS TOUCHES `service_access`. The three places that read or write
 *     `users.compute_access` (the service, the administrator's routes, and the request route in
 *     routes/users.ts) and the migration that adds it never name that column, in code or in SQL. (A comment
 *     may; the scan strips comments first.) A cascade that clears `service_access` for another reason, the
 *     account's revocation and deletion, is upload's, not compute's, and lives in files this scan does not read.
 *  2. THEY READ NO COMPUTE SWITCH. A decision and a request are bookkeeping: they spend nothing and call
 *     no Tapis, so they work whether or not compute is on. The switch is read in the one place
 *     `compute-source-scan.test.ts` pins; none of these files is it.
 *
 * Each rule is shown to FIRE on a planted text, so the scan is not vacuous. MUTATION: put
 * `service_access` into a statement of the request route, or `computeEnabled(c.env)` into a decision.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/** Code with block and line comments removed. Good enough for files with no `//` inside a string. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The request route and the helpers above it, from the compute section's marker to the end of the file. */
function requestSection(): string {
  const text = read("routes/users.ts");
  const at = text.indexOf("POST /users/me/compute-access/request");
  if (at < 0) throw new Error("the compute request section is not where this scan looks for it");
  return text.slice(at);
}

const SUBJECTS: Record<string, () => string> = {
  "services/compute-access.ts": () => read("services/compute-access.ts"),
  "routes/admin/compute-access.ts": () => read("routes/admin/compute-access.ts"),
  "the request route in routes/users.ts": requestSection,
  "migration 0131": () => readFileSync(join(SRC, "db/migrations/0131_compute_access.sql"), "utf8"),
};

const UPLOAD_GRANT = /service_access/;
const SWITCH =
  /computeEnabled|COMPUTE_ENABLED|isComputeEnvironment|computePipelinesDispatchEnabled/;
const withoutSql = (text: string) => text.replace(/^\s*--.*$/gm, " ");

describe("compute access is not upload access", () => {
  for (const [name, get] of Object.entries(SUBJECTS)) {
    test(`${name} never names service_access`, () => {
      expect(UPLOAD_GRANT.test(withoutSql(code(get())))).toBe(false);
    });
  }

  test("the scan fires: a statement that names it, and a comment that does not count", () => {
    expect(UPLOAD_GRANT.test(code("db.prepare('UPDATE users SET service_access = 1')"))).toBe(true);
    expect(UPLOAD_GRANT.test(code("// service_access is upload's\nconst x = 1;"))).toBe(false);
    expect(UPLOAD_GRANT.test(code("/* service_access */ const x = 1;"))).toBe(false);
    expect(
      UPLOAD_GRANT.test(withoutSql("-- service_access\nALTER TABLE users ADD COLUMN a TEXT;")),
    ).toBe(false);
  });
});

describe("a decision and a request read no compute switch", () => {
  for (const [name, get] of Object.entries(SUBJECTS)) {
    test(`${name} reads no switch`, () => {
      expect(SWITCH.test(code(get()))).toBe(false);
    });
  }

  test("the scan fires on a read of the switch, in any spelling it knows", () => {
    for (const planted of [
      "if (computeEnabled(c.env)) {}",
      "const on = env.COMPUTE_ENABLED === '1';",
      "isComputeEnvironment(env)",
    ]) {
      expect([planted, SWITCH.test(code(planted))]).toEqual([planted, true]);
    }
  });
});
