/**
 * A scan of the Worker's source for the two sets that must agree (epic #2005 phase A8, #2013;
 * AGENTS.md, "Revocation cascades, always"): the functions that RUN `computeReleaseStatements`, and the
 * functions that END every credential of an account. It reads the syntax tree the compiler reads, so a
 * rule is about what the code DOES and not how it is spelled, and it takes a `Tree` so a test can lay a
 * planted file over the real ones and show the rule FIRES.
 *
 * A UNIT is the innermost function (a declaration, a variable's arrow, a method, or the callback of a
 * route registration, labelled `POST /path`), or the module's top level; a unit's facts are the strings
 * and names in it OUTSIDE any function nested in it.
 *
 * "RUNS the compute set" is any reference to `computeReleaseStatements`, however it is reached: a named
 * import, an aliased one (`import { computeReleaseStatements as x }`), a namespace import's property
 * (`ns.computeReleaseStatements`, `ns["computeReleaseStatements"]`), a local alias (`const f = ...`,
 * a destructuring of the namespace) and a use that passes the function as a value (`.map(f)`) rather than
 * calling it. What the scan cannot follow it refuses to guess about (`unfollowable`): a dynamic import, a
 * re-export, and a reference at module top level (it could be re-exported under another name).
 *
 * "ENDS every credential" is a unit that revokes all of an account's API keys (`UPDATE tokens SET
 * revoked_at ... WHERE user_id = ?`) AND revokes sessions (`UPDATE web_sessions SET revoked_at ...`, of
 * any scope), whether the SQL is in the unit or in a constant or function it names (resolved by VALUE,
 * through aliases and namespace properties, to a fixed point, so a new constant or helper is found by
 * what it does and not by what it is called).
 */

import ts from "typescript";
import { type Tree, foldString, parse, rel } from "./ts-scan";
import { SRC } from "./ts-scan";

export const COMPUTE_SET_FUNCTION = "computeReleaseStatements";

const TOKENS_ALL_RE = /UPDATE\s+tokens\s+SET\s+revoked_at[\s\S]*?WHERE\s+user_id\s*=\s*\?/i;
const SESSIONS_RE = /UPDATE\s+web_sessions\s+SET\s+revoked_at/i;

type FnNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration;

const isFn = (n: ts.Node): n is FnNode =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n) ||
  ts.isConstructorDeclaration(n);

/** The last path segment without extension, so `./compute-release`, `../services/compute-release.js` match alike. */
const moduleBase = (spec: string): string =>
  (spec.split("/").pop() ?? spec).replace(/\.(js|ts)$/, "");

interface Unit {
  /** `file#label`. */
  key: string;
  file: string;
  /** The label alone; a plain function name when it has one. */
  label: string;
  /** Folded strings in the unit outside nested functions. */
  strings: string[];
  /** Identifier names in the unit outside nested functions (declaration names included). */
  names: Set<string>;
  /** `ns.prop` and `ns["prop"]` property names, by namespace local name. */
  nsProps: Map<string, Set<string>>;
}

interface FileFacts {
  file: string;
  sf: ts.SourceFile;
  units: Unit[];
  /** local name to the name it was exported as, for every named import of the file. */
  aliasOf: Map<string, string>;
  /** local names of namespace imports, with the module's base name. */
  namespaces: Map<string, string>;
  /** local names that are the compute set function in this file (imported, aliased, assigned). */
  computeLocals: Set<string>;
  unfollowable: string[];
}

function labelOf(node: FnNode, sf: ts.SourceFile): string {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.name.getText(sf);
  }
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
    return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText(sf);
  if (parent && ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression)) {
    const path = parent.arguments.find((a) => ts.isStringLiteralLike(a));
    if (path && ts.isStringLiteralLike(path)) {
      const callee = parent.expression;
      const method = ts.isPropertyAccessExpression(callee)
        ? callee.name.text.toUpperCase()
        : "CALL";
      return `${method} ${path.text}`;
    }
  }
  return `<anonymous@${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}>`;
}

function collectFacts(file: string, sf: ts.SourceFile): FileFacts {
  const aliasOf = new Map<string, string>();
  const namespaces = new Map<string, string>();
  const unfollowable: string[] = [];
  const computeLocals = new Set<string>();

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const base = moduleBase(stmt.moduleSpecifier.text);
      const clause = stmt.importClause;
      if (!clause) continue;
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          const original = (el.propertyName ?? el.name).text;
          aliasOf.set(el.name.text, original);
          if (base === "compute-release" && original === COMPUTE_SET_FUNCTION) {
            computeLocals.add(el.name.text);
          }
        }
      } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        namespaces.set(clause.namedBindings.name.text, base);
      }
    }
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      moduleBase(stmt.moduleSpecifier.text) === "compute-release"
    ) {
      unfollowable.push(`${rel(file)}: re-exports compute-release`);
    }
  }

  // Dynamic imports of compute-release, anywhere.
  const dynamic = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0]) &&
      moduleBase(n.arguments[0].text) === "compute-release"
    ) {
      unfollowable.push(`${rel(file)}: dynamically imports compute-release`);
    }
    ts.forEachChild(n, dynamic);
  };
  dynamic(sf);

  const isComputeProp = (n: ts.Node): boolean => {
    if (ts.isPropertyAccessExpression(n)) {
      return (
        ts.isIdentifier(n.expression) &&
        namespaces.get(n.expression.text) === "compute-release" &&
        n.name.text === COMPUTE_SET_FUNCTION
      );
    }
    if (ts.isElementAccessExpression(n)) {
      return (
        ts.isIdentifier(n.expression) &&
        namespaces.get(n.expression.text) === "compute-release" &&
        ts.isStringLiteralLike(n.argumentExpression) &&
        n.argumentExpression.text === COMPUTE_SET_FUNCTION
      );
    }
    return false;
  };

  // Local aliases, to a fixed point: `const f = computeReleaseStatements`, `const f = ns.computeReleaseStatements`,
  // `const { computeReleaseStatements: f } = ns`.
  for (let changed = true; changed; ) {
    changed = false;
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        const init = n.initializer;
        const fromSet =
          (ts.isIdentifier(init) && computeLocals.has(init.text)) || isComputeProp(init);
        if (fromSet && ts.isIdentifier(n.name) && !computeLocals.has(n.name.text)) {
          computeLocals.add(n.name.text);
          changed = true;
        }
        if (
          ts.isObjectBindingPattern(n.name) &&
          ts.isIdentifier(init) &&
          namespaces.get(init.text) === "compute-release"
        ) {
          for (const el of n.name.elements) {
            const prop = (el.propertyName ?? el.name).getText(sf);
            if (
              prop === COMPUTE_SET_FUNCTION &&
              ts.isIdentifier(el.name) &&
              !computeLocals.has(el.name.text)
            ) {
              computeLocals.add(el.name.text);
              changed = true;
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // Units.
  const units: Unit[] = [];
  const seen = new Map<string, number>();
  const newUnit = (label: string): Unit => {
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    const unique = count === 1 ? label : `${label}@${count}`;
    const unit: Unit = {
      key: `${rel(file)}#${unique}`,
      file,
      label: unique,
      strings: [],
      names: new Set(),
      nsProps: new Map(),
    };
    units.push(unit);
    return unit;
  };
  const addNs = (unit: Unit, ns: string, prop: string) => {
    const set = unit.nsProps.get(ns) ?? new Set<string>();
    set.add(prop);
    unit.nsProps.set(ns, set);
  };
  const gather = (n: ts.Node, unit: Unit): void => {
    if (isFn(n)) {
      // A function is its own unit, and its facts are not its parent's.
      const inner = newUnit(labelOf(n, sf));
      ts.forEachChild(n, (c) => gather(c, inner));
      return;
    }
    const folded = foldString(n);
    if (folded !== null && !ts.isParenthesizedExpression(n)) {
      unit.strings.push(folded);
      if (ts.isTemplateExpression(n)) for (const s of n.templateSpans) gather(s.expression, unit);
      return;
    }
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
      addNs(unit, n.expression.text, n.name.text);
    } else if (
      ts.isElementAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      ts.isStringLiteralLike(n.argumentExpression)
    ) {
      addNs(unit, n.expression.text, n.argumentExpression.text);
    }
    if (ts.isIdentifier(n)) unit.names.add(n.text);
    ts.forEachChild(n, (c) => gather(c, unit));
  };
  const top = newUnit("<module>");
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) continue;
    gather(stmt, top);
  }
  return { file, sf, units, aliasOf, namespaces, computeLocals, unfollowable };
}

export interface Analysis {
  /** Every unit that references the compute set function, by key. */
  users: string[];
  /** Every unit that ends every credential, by key. */
  ends: string[];
  /** Units that end every credential and neither run the compute set nor delegate to a unit that does. */
  unsatisfied: string[];
  /** What the scan cannot follow. */
  unfollowable: string[];
}

export function analyse(tree: Tree): Analysis {
  const facts = tree
    .walk(SRC)
    .filter((f) => !f.endsWith("services/compute-release.ts"))
    .map((f) => collectFacts(f, parse(tree, f)));
  const unfollowable = facts.flatMap((f) => f.unfollowable);

  // The compute set's users.
  const users = new Set<string>();
  for (const f of facts) {
    for (const u of f.units) {
      const direct =
        [...u.names].some((n) => f.computeLocals.has(n)) ||
        [...u.nsProps].some(
          ([ns, props]) =>
            f.namespaces.get(ns) === "compute-release" && props.has(COMPUTE_SET_FUNCTION),
        );
      if (!direct) continue;
      if (u.label === "<module>") {
        unfollowable.push(`${u.key}: references the compute set at module level`);
      }
      users.add(u.key);
    }
  }

  // Revokers, by VALUE: module-level constants whose text revokes, and functions whose unit revokes,
  // resolved through aliases and namespace properties to a fixed point.
  const tokenRevokers = new Set<string>();
  const sessionRevokers = new Set<string>();
  const resolve = (f: FileFacts, u: Unit): { tokens: boolean; sessions: boolean } => {
    const refs = new Set<string>();
    for (const n of u.names) refs.add(f.aliasOf.get(n) ?? n);
    for (const props of u.nsProps.values()) for (const p of props) refs.add(p);
    return {
      tokens:
        u.strings.some((s) => TOKENS_ALL_RE.test(s)) || [...refs].some((r) => tokenRevokers.has(r)),
      sessions:
        u.strings.some((s) => SESSIONS_RE.test(s)) || [...refs].some((r) => sessionRevokers.has(r)),
    };
  };
  // Module-level constants: `const NAME = "<sql>"` is a unit-less fact of `<module>` named by its declaration.
  for (const f of facts) {
    for (const stmt of f.sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const text = foldString(d.initializer);
        if (text === null) continue;
        if (TOKENS_ALL_RE.test(text)) tokenRevokers.add(d.name.text);
        if (SESSIONS_RE.test(text)) sessionRevokers.add(d.name.text);
      }
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of facts) {
      for (const u of f.units) {
        if (u.label === "<module>" || u.label.startsWith("<anonymous") || /\s/.test(u.label))
          continue;
        const { tokens, sessions } = resolve(f, u);
        if (tokens && !tokenRevokers.has(u.label)) {
          tokenRevokers.add(u.label);
          changed = true;
        }
        if (sessions && !sessionRevokers.has(u.label)) {
          sessionRevokers.add(u.label);
          changed = true;
        }
      }
    }
  }

  // Units that end every credential: they revoke every key AND sessions, themselves.
  const ends: string[] = [];
  const endsFacts: Array<{ f: FileFacts; u: Unit }> = [];
  for (const f of facts) {
    for (const u of f.units) {
      if (u.label === "<module>") continue;
      const { tokens, sessions } = resolve(f, u);
      if (tokens && sessions) {
        ends.push(u.key);
        endsFacts.push({ f, u });
      }
    }
  }

  // A unit is satisfied when it runs the compute set, or names a function that is satisfied (a route that
  // calls `finalizeRevocation`, the sweep that calls `tombstoneUserCascade`, the cleanup that calls the
  // sweep): to a fixed point, so a chain of delegation of any depth is followed.
  const plain = (label: string) => !/\s|^</.test(label);
  const satisfiedNames = new Set([...users].map((k) => k.slice(k.indexOf("#") + 1)).filter(plain));
  const satisfied = new Set<string>(users);
  for (let changed = true; changed; ) {
    changed = false;
    for (const { f, u } of endsFacts) {
      if (satisfied.has(u.key)) continue;
      if ([...u.names].some((n) => satisfiedNames.has(f.aliasOf.get(n) ?? n))) {
        satisfied.add(u.key);
        if (plain(u.label)) satisfiedNames.add(u.label);
        changed = true;
      }
    }
  }
  const unsatisfied = endsFacts.filter(({ u }) => !satisfied.has(u.key)).map(({ u }) => u.key);

  return {
    users: [...users].sort(),
    ends: ends.sort(),
    unsatisfied: unsatisfied.sort(),
    unfollowable: unfollowable.sort(),
  };
}
