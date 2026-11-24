#!/usr/bin/env bun
/**
 * Regenerate the vendored neuroschema bundle (epic #896, #898).
 *
 * The website/CLI/data-plane dataset shape conforms to the neuroschema JSON
 * Schema, which lives in a SEPARATE repo (nemarOrg/neuroschema, Python/JSON-
 * Schema). nemar-cli CI can't reach that repo, so we vendor a self-contained
 * bundle of the dataset schema + all its transitive $refs into ONE file that
 * ajv (2020-12) can compile, and validate real data-plane responses against it.
 *
 * Bundling strategy: every reachable schema is assigned a stable absolute $id
 * (`nsc:/<path-from-schema-root>`), all external file $refs are rewritten to the
 * referenced file's $id, and internal `#/...` refs are left untouched (2020-12
 * resolves them against each schema's own $id). ajv then addSchema()s them all
 * and validates against the dataset root.
 *
 * Two roots are walked (ADR 0134, epic #2324 phase 2): the dataset document and
 * the record document, so the neuroschema extensions that only a record carries
 * are bundled too. `roots` names both; `root` stays the dataset root for the
 * readers that predate the record root. Any schema in the bundle can also be
 * validated on its own by its `nsc:/` id (test/contract/neuroschema-validator.ts).
 *
 * The view vocabulary's data files are vendored beside the bundle, byte for byte (ADR 0137,
 * decisions 2 and 10): neuroschema's `views/registry.json`, `views/vectors/*` (the parity vectors),
 * `views/montages/*` (with their PROVENANCE.json) and the example product under `examples/views/`,
 * copied into `views/` here (the example product as `views/examples/`). `views/SHA256SUMS.json`
 * lists each copy's source path, size and SHA-256 with the release's version and commit;
 * test/contract-neuroschema.test.ts holds every copy to it.
 *
 * Every byte comes from git, never from the working tree: the version, each schema and each view
 * file are read as blobs of the checked-out commit (`git cat-file blob <commit>:<path>`), and the
 * file list is that commit's tree (`git ls-tree`), so a skip-worktree or assume-unchanged file, a
 * line-ending conversion or a smudge filter cannot put bytes into the vendored copy that the
 * stamped commit does not hold. As a second guard, a checkout with uncommitted changes under the
 * vendored paths is refused. Everything is built in memory and checked before anything is written,
 * so a refused run leaves the vendored tree untouched. test/neuroschema-build-vendor.unit.test.ts
 * holds the script to this.
 *
 * Usage (from the nemar-cli repo root, with the neuroschema repo checked out
 * as a sibling, at the release tag):
 *   bun shared/contract/neuroschema/build-vendor.mjs ../neuroschema
 *     rewrites dataset.bundle.json and views/; commit both (the provenance is
 *     stamped from the commit).
 *   bun shared/contract/neuroschema/build-vendor.mjs ../neuroschema --check
 *     writes nothing: rebuilds in memory and compares with dataset.bundle.json
 *     and views/ (every file, and no file more or less), prints each difference,
 *     and exits 1 on any, 0 when the vendored tree is exact.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, sep } from "node:path";

const args = process.argv.slice(2);
const check = args.includes("--check");
const positional = args.filter((a) => a !== "--check");
const nscRepo = positional[0];
if (!nscRepo || positional.length !== 1) {
  console.error("usage: bun build-vendor.mjs <path-to-neuroschema-repo> [--check]");
  process.exit(1);
}

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const git = (...gitArgs) =>
  execFileSync("git", ["-C", nscRepo, ...gitArgs], { encoding: "utf8", maxBuffer: 1 << 28 });
const nscCommit = git("rev-parse", "HEAD").trim();
/** The raw bytes of `path` at the stamped commit: no working tree, no filter, no conversion. */
const blob = (path) =>
  execFileSync("git", ["-C", nscRepo, "cat-file", "blob", `${nscCommit}:${path}`], {
    maxBuffer: 1 << 28,
  });

const VENDORED_SOURCES = ["pyproject.toml", "schema", "views", "examples/views"];
const dirty = git("status", "--porcelain", "--", ...VENDORED_SOURCES).trim();
if (dirty) {
  fail(`refusing: ${nscRepo} has uncommitted changes under the vendored paths:\n${dirty}`);
}

// Read the neuroschema version straight from its pyproject.toml (single
// source of truth over there) so this script's own provenance stamp can't
// drift from what NEUROSCHEMA_VERSION gets hand-set to in dataset.ts. A
// minimal regex, not a TOML parser, because we only need the one line.
const pyproject = blob("pyproject.toml").toString("utf8");
const versionMatch = pyproject.match(/^version\s*=\s*"([^"]+)"/m);
const nscVersion = versionMatch ? versionMatch[1] : null;
if (!nscVersion) fail(`could not find version = "..." in pyproject.toml at ${nscCommit}`);

const ROOT_REL = "core/dataset.schema.json";
const RECORD_ROOT_REL = "core/record.schema.json";
const idFor = (relPath) => `nsc:/${relPath}`;
/** A ref's target, relative to the schema root, resolved against the referring file's directory. */
const targetOf = (fromRel, file) => {
  const target = posix.normalize(posix.join(posix.dirname(fromRel), file));
  if (target.startsWith("../") || posix.isAbsolute(target)) {
    fail(`ref ${file} in ${fromRel} leaves schema/`);
  }
  return target;
};

const bundle = new Map(); // relPath -> rewritten schema

function rewriteRefs(node, fromRel) {
  if (Array.isArray(node)) return node.map((n) => rewriteRefs(n, fromRel));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string" && !v.startsWith("#")) {
        const [file, frag] = v.split("#");
        out.$ref = idFor(targetOf(fromRel, file)) + (frag ? `#${frag}` : "");
      } else {
        out[k] = rewriteRefs(v, fromRel);
      }
    }
    return out;
  }
  return node;
}

function walk(relPath) {
  if (bundle.has(relPath)) return;
  const raw = JSON.parse(blob(`schema/${relPath}`).toString("utf8"));
  // Discover external refs first so we walk them too.
  const refs = [...JSON.stringify(raw).matchAll(/"\$ref":\s*"([^"#]+)(#[^"]*)?"/g)];
  const rewritten = rewriteRefs(raw, relPath);
  rewritten.$id = idFor(relPath);
  bundle.set(relPath, rewritten);
  for (const [, file] of refs) walk(targetOf(relPath, file));
}

walk(ROOT_REL);
walk(RECORD_ROOT_REL);

const out = {
  _provenance: {
    source: "https://github.com/nemarOrg/neuroschema",
    generated_by: "shared/contract/neuroschema/build-vendor.mjs",
    note: "Do not hand-edit; regenerate from the neuroschema repo.",
    neuroschema_version: nscVersion,
    source_commit: nscCommit,
  },
  root: idFor(ROOT_REL),
  roots: { dataset: idFor(ROOT_REL), record: idFor(RECORD_ROOT_REL) },
  schemas: [...bundle.values()],
};
const bundleBytes = Buffer.from(`${JSON.stringify(out, null, 2)}\n`);

// The view vocabulary's data files (ADR 0137): the stamped commit's tree, copied byte for byte.
const VIEW_SOURCES = [
  { from: "views/registry.json", to: "registry.json" },
  { from: "views/vectors/", to: "vectors/" },
  { from: "views/montages/", to: "montages/" },
  { from: "examples/views/", to: "examples/" },
];
const tree = git("ls-tree", "-r", "-z", "--name-only", nscCommit, "--", "views", "examples/views")
  .split("\0")
  .filter(Boolean)
  .sort();
const viewFiles = new Map(); // vendored path -> bytes
const files = [];
for (const source of tree) {
  const rule = VIEW_SOURCES.find((r) =>
    r.from.endsWith("/") ? source.startsWith(r.from) : source === r.from,
  );
  if (!rule) continue;
  const path = rule.to + source.slice(rule.from.length);
  const bytes = blob(source);
  viewFiles.set(path, bytes);
  files.push({
    path,
    source,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
for (const rule of VIEW_SOURCES) {
  if (!files.some((f) => f.source.startsWith(rule.from))) {
    fail(`no file at ${nscCommit} in ${nscRepo} matches ${rule.from}`);
  }
}
files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const sums = {
  format: "nemar.vendored-files.v1",
  description:
    "The neuroschema view files vendored beside dataset.bundle.json, byte for byte: each copy's path under views/, its path in the neuroschema repository at source_commit, its size and its SHA-256.",
  generated_by: "shared/contract/neuroschema/build-vendor.mjs",
  note: "Do not hand-edit; regenerate from the neuroschema repo.",
  neuroschema_version: nscVersion,
  source_commit: nscCommit,
  files,
};
viewFiles.set("SHA256SUMS.json", Buffer.from(`${JSON.stringify(sums, null, 2)}\n`));

const bundleDest = join(import.meta.dir, "dataset.bundle.json");
const viewsDest = join(import.meta.dir, "views");

if (check) {
  const differences = [];
  if (!existsSync(bundleDest) || !readFileSync(bundleDest).equals(bundleBytes)) {
    differences.push("dataset.bundle.json differs");
  }
  const onDisk = existsSync(viewsDest)
    ? readdirSync(viewsDest, { recursive: true })
        .map((p) => p.split(sep).join("/"))
        .filter((p) => statSync(join(viewsDest, p)).isFile())
    : [];
  for (const p of onDisk) if (!viewFiles.has(p)) differences.push(`views/${p} is not in the build`);
  for (const [p, bytes] of viewFiles) {
    const target = join(viewsDest, p);
    if (!existsSync(target)) differences.push(`views/${p} is missing`);
    else if (!readFileSync(target).equals(bytes)) differences.push(`views/${p} differs`);
  }
  if (differences.length > 0) {
    fail(`vendored tree differs from ${nscCommit} (${nscVersion}):\n${differences.join("\n")}`);
  }
  console.log(`vendored tree matches neuroschema ${nscVersion} at ${nscCommit}`);
  process.exit(0);
}

writeFileSync(bundleDest, bundleBytes);
console.log(`wrote ${bundleDest}: ${out.schemas.length} schemas, root ${out.root}`);
// Emptied first so a file neuroschema removed does not linger here.
rmSync(viewsDest, { recursive: true, force: true });
for (const [p, bytes] of viewFiles) {
  const target = join(viewsDest, p);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}
console.log(`wrote ${viewsDest}: ${files.length} files and SHA256SUMS.json`);
