/**
 * The callers of the OpenID Connect cascade, held to the list the module documents (epic #2014 phase
 * #2019; ADR 0119 rule 12).
 *
 * The rule is the one `services/docs-auth.ts` and `services/private-auth.ts` state for their own
 * statements: every path that ends a credential runs the cascade, and the count in the docblock is
 * LOAD-BEARING, because the next person to add a path reads it to learn whether theirs is one more.
 * A count nobody checks decays the first time someone adds a call and not a line of prose, so this
 * test reads the syntax tree (a call in a comment is not a call, and a call by another spelling is
 * still one) and fails when the code and the documented list differ in either direction:
 *
 *   - a call to `oidcEndStatements` or `oidcClientEndStatements` that is not on the list, and a listed
 *     one that is no longer there (so removing the statement from a caller fails here as well as in
 *     the behavioural suites);
 *   - a docblock whose spelled count is not the number of listed callers;
 *   - a deliberate non-path (a role demotion, a key revocation, the app session's sign-out) that has
 *     lost the sentence saying it is deliberate, which is how the next reader learns not to "fix" it;
 *   - a new module that scans for the wrong thing: each rule is also run on a planted violation, so
 *     it is shown to fire and not only to stay quiet.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { OIDC_CLIENT_END_CALLERS, OIDC_END_CALLERS } from "../src/services/oidc-cascade";
import { SRC, type Tree, createTree, parse, rel } from "./helpers/ts-scan";

const CASCADE = join(SRC, "services/oidc-cascade.ts");

/** Every call to a function of this name, as `file` (under `backend/src`) and the function it is in. */
function callsOf(tree: Tree, name: string): Array<{ file: string; site: string }> {
  const found: Array<{ file: string; site: string }> = [];
  for (const abs of tree.walk(SRC)) {
    if (abs === CASCADE) continue;
    const sf = parse(tree, abs);
    const visit = (node: ts.Node, site: string): void => {
      let here = site;
      if (
        (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
        node.name !== undefined
      ) {
        here = node.name.getText(sf);
      } else if (
        ts.isVariableDeclaration(node) &&
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        here = node.name.getText(sf);
      }
      if (ts.isCallExpression(node)) {
        const callee = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : ts.isIdentifier(node.expression)
            ? node.expression.text
            : "";
        if (callee === name) found.push({ file: rel(abs), site: here });
      }
      ts.forEachChild(node, (child) => visit(child, here));
    };
    visit(sf, "(module)");
  }
  return found.sort((a, b) => `${a.file} ${a.site}`.localeCompare(`${b.file} ${b.site}`));
}

const listed = (callers: ReadonlyArray<{ file: string; site: string }>) =>
  callers
    .map((c) => ({ file: c.file, site: c.site }))
    .sort((a, b) => `${a.file} ${a.site}`.localeCompare(`${b.file} ${b.site}`));

const WORDS: Record<string, number> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
  SIX: 6,
  SEVEN: 7,
  EIGHT: 8,
  NINE: 9,
  TEN: 10,
};

/** The caller count a constant's docblock spells (`SIX CALLERS`), or null when it spells none. */
function docblockCount(source: string, constant: string): number | null {
  const at = source.indexOf(`export const ${constant}`);
  if (at < 0) throw new Error(`${constant} is not exported`);
  const close = source.lastIndexOf("*/", at);
  const open = source.lastIndexOf("/**", close);
  const m = /\b(ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN) CALLERS?\b/.exec(
    source.slice(open, close),
  );
  return m ? (WORDS[m[1] as string] as number) : null;
}

describe("the callers of oidcEndStatements", () => {
  const real = createTree();

  test("the code calls it from exactly the places the module lists", () => {
    expect(callsOf(real, "oidcEndStatements")).toEqual(listed(OIDC_END_CALLERS));
  });

  test("the client's own cascade has exactly its one caller", () => {
    expect(callsOf(real, "oidcClientEndStatements")).toEqual(listed(OIDC_CLIENT_END_CALLERS));
  });

  test("no path of the list is a deliberate non-path: demotion, key revocation, sign-out", () => {
    const files = new Set(OIDC_END_CALLERS.map((c) => c.file));
    for (const file of ["routes/auth-keys.ts", "routes/auth-web.ts", "services/docs-auth.ts"]) {
      expect(files.has(file)).toBe(false);
    }
    expect(OIDC_END_CALLERS.some((c) => c.site === "revokeDocsCredentials")).toBe(false);
  });

  test("every SQL constant's docblock spells the number of callers it lists", () => {
    const source = readFileSync(CASCADE, "utf8");
    for (const constant of [
      "OIDC_ENQUEUE_LOGOUTS_SQL",
      "OIDC_END_TOKENS_SQL",
      "OIDC_END_GRANTS_SQL",
      "OIDC_END_CODES_SQL",
    ]) {
      expect({ constant, count: docblockCount(source, constant) }).toEqual({
        constant,
        count: OIDC_END_CALLERS.length,
      });
    }
    for (const constant of [
      "OIDC_CLIENT_END_TOKENS_SQL",
      "OIDC_CLIENT_END_GRANTS_SQL",
      "OIDC_CLIENT_END_CODES_SQL",
    ]) {
      expect({ constant, count: docblockCount(source, constant) }).toEqual({
        constant,
        count: OIDC_CLIENT_END_CALLERS.length,
      });
    }
  });

  test("each listed caller names a function that exists in its file", () => {
    for (const c of [...OIDC_END_CALLERS, ...OIDC_CLIENT_END_CALLERS]) {
      expect(readFileSync(join(SRC, c.file), "utf8")).toContain(c.site);
    }
  });
});

describe("the scan fires on a planted violation", () => {
  test("a new caller that is not on the list is found", () => {
    const planted = createTree({
      "routes/planted.ts": `import { oidcEndStatements } from "../services/oidc-cascade";
export async function aNewPathThatEndsACredential(userId: number) {
  return oidcEndStatements(userId, "account_revoked");
}`,
    });
    expect(callsOf(planted, "oidcEndStatements")).toContainEqual({
      file: "routes/planted.ts",
      site: "aNewPathThatEndsACredential",
    });
    expect(callsOf(planted, "oidcEndStatements")).not.toEqual(listed(OIDC_END_CALLERS));
  });

  test("a call in a comment or a string is not a call", () => {
    const planted = createTree({
      "routes/planted.ts": `// oidcEndStatements(1, "account_revoked")
const text = "oidcEndStatements(1, 'account_revoked')";
export const x = text;`,
    });
    expect(callsOf(planted, "oidcEndStatements")).toEqual(
      callsOf(createTree(), "oidcEndStatements"),
    );
  });

  test("a call through a property access is still a call", () => {
    const planted = createTree({
      "routes/planted.ts": `import * as cascade from "../services/oidc-cascade";
export function viaNamespace(userId: number) {
  return cascade.oidcEndStatements(userId, "account_revoked");
}`,
    });
    expect(callsOf(planted, "oidcEndStatements")).toContainEqual({
      file: "routes/planted.ts",
      site: "viaNamespace",
    });
  });
});

/**
 * The paths that DELIBERATELY do not end the grants say so where the next reader will look, in the
 * words below; the behavioural proof that they leave the rows alone is
 * `oidc-cascade-nonmembership.test.ts`.
 */
describe("a deliberate non-path says so", () => {
  const SENTENCE = "not ended here (ADR 0119 rule 12)";
  for (const file of [
    "routes/admin/users.ts", // the role demotion's batch
    "services/docs-auth.ts", // revokeDocsCredentials: every key revocation
    "routes/auth-web.ts", // /auth/logout
  ]) {
    test(`${file} carries the sentence`, () => {
      expect(readFileSync(join(SRC, file), "utf8")).toContain(SENTENCE);
    });
  }
});
