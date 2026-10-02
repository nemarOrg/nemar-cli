/**
 * Source scans on the TypeScript syntax tree, for the Neurobagel feature (epic #1586, phase 4).
 *
 * A scan of source TEXT is easy to walk around: an extensionless import, a dynamic import, a
 * destructured binding, `bucket["put"]`, a method taken with `.bind`, a string built from two
 * halves. These helpers read the tree the compiler reads (the `typescript` package the repo
 * already type-checks with), so a rule is about what the code DOES and not how it is spelled:
 *
 *   - imports: static, `export ... from`, dynamic `import(...)`, extensionless and `.js`
 *     specifiers alike, over the TRANSITIVE closure of a set of files, with the data plane as a
 *     boundary the closure does not cross and type-only imports (which emit nothing) skipped;
 *   - the bucket: every way of reaching a mutating method on the binding, through aliases,
 *     casts, destructuring, element access and `bind`;
 *   - strings: literals, templates and concatenations folded to the text they produce.
 *
 * Every function takes a `Tree`, which reads the real files and lets a test lay a modified or
 * new file over them (the scratch copy a planted violation lives in), so each rule is proven
 * to fire, not only to stay quiet.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

export const SRC = resolve(import.meta.dir, "../../src");
export const REPO = resolve(import.meta.dir, "../../..");

/** The real files, with an overlay of replacements and additions keyed by path under `backend/src`. */
export interface Tree {
  read(abs: string): string | null;
  /** Every `.ts` file under `dir`, the overlay's included. */
  walk(dir: string): string[];
}

export function createTree(overlay: Record<string, string> = {}): Tree {
  const overlaid = new Map(Object.entries(overlay).map(([k, v]) => [join(SRC, k), v]));
  return {
    read(abs) {
      const o = overlaid.get(abs);
      if (o !== undefined) return o;
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    },
    walk(dir) {
      const out = new Set<string>();
      const visit = (d: string) => {
        if (!existsSync(d)) return;
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) visit(join(d, e.name));
          else if (e.name.endsWith(".ts")) out.add(join(d, e.name));
        }
      };
      visit(dir);
      for (const k of overlaid.keys()) if (k.startsWith(`${dir}/`)) out.add(k);
      return [...out].sort();
    },
  };
}

export function parse(tree: Tree, abs: string): ts.SourceFile {
  const text = tree.read(abs);
  if (text === null) throw new Error(`no such file: ${abs}`);
  return ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
}

export const rel = (abs: string): string =>
  abs.startsWith(SRC) ? relative(SRC, abs) : relative(REPO, abs);

// ----------------------------------------------------------------------------
// Strings
// ----------------------------------------------------------------------------

const HOLE = "\u0000";

/**
 * The text an expression produces when it is made of literals: a string, a template, a
 * concatenation. A part that is not a literal becomes a hole (NUL), so a scan sees the
 * fragments on either side of it and cannot be defeated by splitting a name in two.
 */
export function foldString(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return foldString(node.expression);
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      text += (foldString(span.expression) ?? HOLE) + span.literal.text;
    }
    return text;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldString(node.left);
    const right = foldString(node.right);
    if (left === null && right === null) return null;
    return (left ?? HOLE) + (right ?? HOLE);
  }
  return null;
}

/** Every folded string in a file, each concatenation or template counted once. */
export function foldedStrings(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    const folded = foldString(n);
    if (folded !== null && !ts.isParenthesizedExpression(n)) {
      out.push(folded);
      // A template's spans can hold more strings (`${a ? "x" : "y"}`); a concatenation's
      // operands are already folded in. Only the former is descended into.
      if (ts.isTemplateExpression(n)) for (const s of n.templateSpans) visit(s.expression);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ----------------------------------------------------------------------------
// Imports
// ----------------------------------------------------------------------------

export interface Specifier {
  spec: string;
  kind: "static" | "dynamic";
}

export interface ImportScan {
  specifiers: Specifier[];
  /** `import(x)` or `require(x)` whose argument is not a literal: a module name that cannot be read. */
  unanalyzable: string[];
}

function isTypeOnlyImport(n: ts.ImportDeclaration): boolean {
  const c = n.importClause;
  if (!c) return false; // `import "x"` runs the module
  if (c.isTypeOnly) return true;
  if (c.name) return false;
  const b = c.namedBindings;
  return Boolean(
    b && ts.isNamedImports(b) && b.elements.length > 0 && b.elements.every((e) => e.isTypeOnly),
  );
}

/** Every module a file loads at run time: type-only imports emit nothing and are not edges. */
export function scanImports(sf: ts.SourceFile): ImportScan {
  const specifiers: Specifier[] = [];
  const unanalyzable: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      if (!isTypeOnlyImport(n)) specifiers.push({ spec: n.moduleSpecifier.text, kind: "static" });
    } else if (
      ts.isExportDeclaration(n) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      if (!n.isTypeOnly) specifiers.push({ spec: n.moduleSpecifier.text, kind: "static" });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const e = n.moduleReference.expression;
      if (ts.isStringLiteral(e)) specifiers.push({ spec: e.text, kind: "static" });
    } else if (ts.isCallExpression(n)) {
      const isImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === "require";
      if (isImport || isRequire) {
        const arg = n.arguments[0];
        const folded = arg ? foldString(arg) : null;
        if (folded !== null && !folded.includes(HOLE)) {
          specifiers.push({ spec: folded, kind: "dynamic" });
        } else {
          unanalyzable.push(n.getText(sf).slice(0, 80));
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { specifiers, unanalyzable };
}

/** A relative specifier to a file, whether it is written with `.js`, `.ts` or neither. */
export function resolveImport(tree: Tree, from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec.replace(/\.(js|ts)$/, ""));
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (tree.read(candidate) !== null) return candidate;
  }
  return null;
}

export interface Closure {
  /** Every file reached, the roots and the boundary files included. */
  files: Set<string>;
  /** For each file reached, the file that first led to it. */
  via: Map<string, string>;
  unanalyzable: { file: string; text: string }[];
}

/**
 * The files `roots` load at run time, transitively. A `boundary` file is reached but not
 * entered: it is code the feature takes the answers of, not code it is made of.
 */
export function importClosure(
  tree: Tree,
  roots: readonly string[],
  boundary: ReadonlySet<string>,
): Closure {
  const files = new Set<string>();
  const via = new Map<string, string>();
  const unanalyzable: Closure["unanalyzable"] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    if (boundary.has(file)) continue;
    const scan = scanImports(parse(tree, file));
    for (const text of scan.unanalyzable) unanalyzable.push({ file, text });
    for (const { spec } of scan.specifiers) {
      const target = resolveImport(tree, file, spec);
      if (target && !files.has(target)) {
        if (!via.has(target)) via.set(target, file);
        stack.push(target);
      }
    }
  }
  return { files, via, unanalyzable };
}

/** How a file was reached, root first: `a.ts -> b.ts -> email.ts`. */
export function chainTo(closure: Closure, file: string): string {
  const chain = [rel(file)];
  let at = file;
  while (closure.via.has(at)) {
    at = closure.via.get(at) as string;
    chain.unshift(rel(at));
  }
  return chain.join(" -> ");
}

// ----------------------------------------------------------------------------
// The bucket
// ----------------------------------------------------------------------------

export const BUCKET_MUTATORS: ReadonlySet<string> = new Set([
  "put",
  "delete",
  "createMultipartUpload",
  "resumeMultipartUpload",
]);

export interface BucketFinding {
  line: number;
  what: string;
}

const BINDING = "NEUROBAGEL";

function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isTypeAssertionExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

function namesBinding(node: ts.Expression): boolean {
  const n = unwrap(node);
  if (ts.isPropertyAccessExpression(n)) return n.name.text === BINDING;
  if (ts.isElementAccessExpression(n)) {
    const key = foldString(n.argumentExpression);
    return key === BINDING;
  }
  return false;
}

function typeMentionsBucket(node: ts.TypeNode | undefined): boolean {
  return Boolean(node && /\bR2Bucket\b/.test(node.getText()));
}

function bindingElementName(e: ts.BindingElement): string | null {
  if (e.dotDotDotToken) return null;
  const key = e.propertyName ?? e.name;
  return ts.isIdentifier(key) ? key.text : ts.isStringLiteral(key) ? key.text : null;
}

/**
 * Follow the binding through one file: which expressions hold the bucket. Aliases
 * (`const b = env.NEUROBAGEL`), casts, destructuring (`const { NEUROBAGEL } = env`,
 * `{ put } = bucket`), `??`/`||`/`?:` branches, parameters and fields typed `R2Bucket`, and
 * properties declared as one (`interface Context { bucket: R2Bucket }`, so every `x.bucket`).
 *
 * In a file of the feature anything typed `R2Bucket` may well be the binding (it is handed
 * one). Elsewhere in the tree an `R2Bucket` is some other bucket (the news media's), and with
 * `typed: false` only what is traced to the binding itself counts.
 */
function traceBucket(sf: ts.SourceFile, typed: boolean): (node: ts.Expression) => boolean {
  const tainted = new Set<string>();
  const taintedProps = new Set<string>();
  const typedBucket = (node: ts.TypeNode | undefined) => typed && typeMentionsBucket(node);

  const isTainted = (node: ts.Expression): boolean => {
    const n = unwrap(node);
    if (namesBinding(n)) return true;
    if (ts.isIdentifier(n)) return tainted.has(n.text);
    if (ts.isPropertyAccessExpression(n) && taintedProps.has(n.name.text)) return true;
    if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword) {
      return tainted.has(`this.${n.name.text}`);
    }
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return isTainted(n.left) || isTainted(n.right);
      }
      if (op === ts.SyntaxKind.EqualsToken) return isTainted(n.right);
    }
    if (ts.isConditionalExpression(n)) return isTainted(n.whenTrue) || isTainted(n.whenFalse);
    return false;
  };

  // Names that hold the binding, found to a fixpoint (an alias of an alias).
  const taint = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n)) {
      if (ts.isIdentifier(n.name)) {
        if (typedBucket(n.type) || (n.initializer && isTainted(n.initializer))) {
          tainted.add(n.name.text);
        }
      } else if (ts.isObjectBindingPattern(n.name) && n.initializer) {
        for (const e of n.name.elements) {
          if (bindingElementName(e) === BINDING && ts.isIdentifier(e.name))
            tainted.add(e.name.text);
        }
        if (isTainted(n.initializer)) {
          // `const { x } = bucket` takes pieces of it: each name holds a method.
          for (const e of n.name.elements) if (ts.isIdentifier(e.name)) tainted.add(e.name.text);
        }
      }
    } else if (ts.isParameter(n)) {
      if (ts.isIdentifier(n.name)) {
        if (typedBucket(n.type)) tainted.add(n.name.text);
      } else if (ts.isObjectBindingPattern(n.name)) {
        for (const e of n.name.elements) {
          if (bindingElementName(e) === BINDING && ts.isIdentifier(e.name))
            tainted.add(e.name.text);
        }
      }
    } else if (ts.isPropertyDeclaration(n) && ts.isIdentifier(n.name)) {
      if (typedBucket(n.type) || (n.initializer && isTainted(n.initializer))) {
        tainted.add(`this.${n.name.text}`);
        taintedProps.add(n.name.text);
      }
    } else if (ts.isPropertySignature(n) && ts.isIdentifier(n.name) && typedBucket(n.type)) {
      taintedProps.add(n.name.text);
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      isTainted(n.right)
    ) {
      tainted.add(n.left.text);
    }
    ts.forEachChild(n, taint);
  };
  for (let pass = 0; pass < 3; pass++) taint(sf);
  return isTainted;
}

/**
 * Every way a file reaches a MUTATING method of the bucket binding: a property access, an
 * element access (`bucket["put"]`, `bucket["pu" + "t"]`), `put.bind`, a method destructured
 * out of the bucket. An element access whose key is not a literal (`bucket[op]()`) cannot be
 * told from a write and is a finding too.
 *
 * Reading methods (`get`, `head`, `list`) are not findings. Whether a file MAY write is the
 * caller's rule; this only says where a write is reachable.
 */
export function bucketMutations(
  sf: ts.SourceFile,
  options: { typed?: boolean } = {},
): BucketFinding[] {
  const isTainted = traceBucket(sf, options.typed ?? true);
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const findings: BucketFinding[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && isTainted(n.expression)) {
      if (BUCKET_MUTATORS.has(n.name.text)) {
        findings.push({ line: line(n), what: `.${n.name.text} on the bucket` });
      }
    } else if (ts.isElementAccessExpression(n) && isTainted(n.expression)) {
      const key = foldString(n.argumentExpression);
      if (key === null || key.includes(HOLE)) {
        findings.push({ line: line(n), what: "a computed key on the bucket" });
      } else if (BUCKET_MUTATORS.has(key)) {
        findings.push({ line: line(n), what: `["${key}"] on the bucket` });
      }
    } else if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer) {
      if (isTainted(n.initializer)) {
        for (const e of n.name.elements) {
          const name = bindingElementName(e);
          if (e.dotDotDotToken || (name !== null && BUCKET_MUTATORS.has(name))) {
            findings.push({ line: line(e), what: "a method destructured from the bucket" });
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return findings;
}

/**
 * Where the binding is HANDED to other code: a call or `new` with the bucket (or something
 * traced to it) as an argument, whose callee is neither a function of this file, nor one
 * imported from a feature module, nor `Proxy`. A bucket given to a helper elsewhere is a
 * bucket that helper can write, whatever that helper's own file looks like.
 */
export function bucketLeaks(
  sf: ts.SourceFile,
  isFeatureModule: (spec: string) => boolean,
): BucketFinding[] {
  const isTainted = traceBucket(sf, true);
  const local = new Set<string>();
  const imported = new Map<string, string>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) local.add(st.name.text);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name)) local.add(d.name.text);
    }
    const b = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
    if (
      b &&
      ts.isNamedImports(b) &&
      ts.isImportDeclaration(st) &&
      ts.isStringLiteral(st.moduleSpecifier)
    ) {
      for (const e of b.elements) imported.set(e.name.text, st.moduleSpecifier.text);
    }
  }
  const findings: BucketFinding[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.arguments?.some(isTainted)) {
      const callee = n.expression;
      let ok = false;
      if (ts.isIdentifier(callee)) {
        const spec = imported.get(callee.text);
        ok =
          callee.text === "Proxy" ||
          callee.text === "Boolean" ||
          (spec === undefined && local.has(callee.text)) ||
          (spec !== undefined && isFeatureModule(spec));
      }
      if (!ok) {
        findings.push({
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          what: `the bucket handed to ${callee.getText(sf).slice(0, 40)}`,
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return findings;
}

/** Does the file name the binding at all: `x.NEUROBAGEL`, `x["NEUROBAGEL"]`, `{ NEUROBAGEL }`, `NEUROBAGEL?:`. */
export function namesTheBucketBinding(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(n) && n.name.text === BINDING) found = true;
    else if (ts.isElementAccessExpression(n) && foldString(n.argumentExpression) === BINDING)
      found = true;
    else if (ts.isBindingElement(n) && bindingElementName(n) === BINDING) found = true;
    else if (ts.isPropertySignature(n) && ts.isIdentifier(n.name) && n.name.text === BINDING)
      found = true;
    else if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === BINDING)
      found = true;
    else if (ts.isShorthandPropertyAssignment(n) && n.name.text === BINDING) found = true;
    else if (ts.isLiteralTypeNode(n) && ts.isStringLiteral(n.literal) && n.literal.text === BINDING)
      found = true;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

// ----------------------------------------------------------------------------
// SQL
// ----------------------------------------------------------------------------

/** A SELECT over `*`, bare or through an alias (`d.*`): the projection must name its columns. */
export function wildcardSelects(sf: ts.SourceFile): string[] {
  const hits: string[] = [];
  for (const text of foldedStrings(sf)) {
    if (!/\bSELECT\b/i.test(text)) continue;
    if (/\bSELECT\s+(?:DISTINCT\s+)?\*/i.test(text) || /\b[A-Za-z_]\w*\.\*/.test(text)) {
      hits.push(text.replaceAll(HOLE, "${}").replace(/\s+/g, " ").slice(0, 80));
    }
  }
  return hits;
}

export { HOLE };
