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
 * The view vocabulary's data files are vendored beside the bundle, byte for byte (ADR 0137, decisions 2
 * and 10): neuroschema's `views/registry.json`, `views/vectors/*` (the parity vectors), `views/montages/*`
 * (with their PROVENANCE.json) and the example product under `examples/views/`, copied into `views/` here
 * (the example product as `views/examples/`). `views/SHA256SUMS.json` lists each copy's source path, size
 * and SHA-256 with the release's version and commit; test/contract-neuroschema.test.ts holds every copy
 * to it. Only files git tracks at the checked-out commit are copied, and a checkout with uncommitted
 * changes under the vendored paths is refused, so the stamped commit is what was copied.
 *
 * Usage (from the nemar-cli repo root, with the neuroschema repo checked out
 * as a sibling):
 *   bun shared/contract/neuroschema/build-vendor.mjs ../neuroschema
 * Commit the regenerated dataset.bundle.json and views/ (the provenance is stamped from the checkout).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const nscRepo = process.argv[2];
if (!nscRepo) {
  console.error("usage: bun build-vendor.mjs <path-to-neuroschema-repo>");
  process.exit(1);
}

// Read the neuroschema version straight from its pyproject.toml (single
// source of truth over there) so this script's own provenance stamp can't
// drift from what NEUROSCHEMA_VERSION gets hand-set to in dataset.ts. A
// minimal regex, not a TOML parser, because we only need the one line.
const pyproject = readFileSync(join(nscRepo, "pyproject.toml"), "utf8");
const versionMatch = pyproject.match(/^version\s*=\s*"([^"]+)"/m);
const nscVersion = versionMatch ? versionMatch[1] : null;
if (!nscVersion) {
  console.error(`could not find version = "..." in ${join(nscRepo, "pyproject.toml")}`);
  process.exit(1);
}
const git = (...args) => execFileSync("git", ["-C", nscRepo, ...args], { encoding: "utf8" });
const nscCommit = git("rev-parse", "HEAD").trim();
const VENDORED_SOURCES = ["pyproject.toml", "schema", "views", "examples/views"];
const dirty = git("status", "--porcelain", "--", ...VENDORED_SOURCES).trim();
if (dirty) {
  console.error(`refusing: ${nscRepo} has uncommitted changes under the vendored paths:\n${dirty}`);
  process.exit(1);
}
const schemaRoot = resolve(nscRepo, "schema");
const ROOT_REL = "core/dataset.schema.json";
const RECORD_ROOT_REL = "core/record.schema.json";
const idFor = (relPath) => `nsc:/${relPath}`;

const bundle = new Map(); // relPath -> rewritten schema

function rewriteRefs(node, fileDir) {
  if (Array.isArray(node)) return node.map((n) => rewriteRefs(n, fileDir));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string" && !v.startsWith("#")) {
        const [file, frag] = v.split("#");
        const targetRel = relative(schemaRoot, resolve(fileDir, file));
        out.$ref = idFor(targetRel) + (frag ? `#${frag}` : "");
      } else {
        out[k] = rewriteRefs(v, fileDir);
      }
    }
    return out;
  }
  return node;
}

function walk(relPath) {
  if (bundle.has(relPath)) return;
  const abs = join(schemaRoot, relPath);
  const raw = JSON.parse(readFileSync(abs, "utf8"));
  const fileDir = dirname(abs);
  // Discover external refs first so we walk them too.
  const refs = [...JSON.stringify(raw).matchAll(/"\$ref":\s*"([^"#]+)(#[^"]*)?"/g)];
  const rewritten = rewriteRefs(raw, fileDir);
  rewritten.$id = idFor(relPath);
  bundle.set(relPath, rewritten);
  for (const [, file] of refs) {
    walk(relative(schemaRoot, resolve(fileDir, file)));
  }
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
const dest = join(import.meta.dir, "dataset.bundle.json");
writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${dest}: ${out.schemas.length} schemas, root ${out.root}`);

// The view vocabulary's data files (ADR 0137): tracked files only, copied byte for byte. The
// destination is emptied first so a file neuroschema removed does not linger here.
const VIEW_SOURCES = [
  { from: "views/registry.json", to: "registry.json" },
  { from: "views/vectors/", to: "vectors/" },
  { from: "views/montages/", to: "montages/" },
  { from: "examples/views/", to: "examples/" },
];
const viewsDest = join(import.meta.dir, "views");
rmSync(viewsDest, { recursive: true, force: true });
const tracked = git("ls-files", "-z", "--", "views", "examples/views").split("\0").filter(Boolean);
const files = [];
for (const source of tracked.sort()) {
  const rule = VIEW_SOURCES.find((r) =>
    r.from.endsWith("/") ? source.startsWith(r.from) : source === r.from,
  );
  if (!rule) continue;
  const path = rule.to + source.slice(rule.from.length);
  const target = join(viewsDest, path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(nscRepo, source), target);
  const bytes = readFileSync(target);
  files.push({
    path,
    source,
    size: statSync(target).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
for (const rule of VIEW_SOURCES) {
  if (!files.some((f) => f.source.startsWith(rule.from))) {
    console.error(`no tracked file in ${nscRepo} matches ${rule.from}`);
    process.exit(1);
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
writeFileSync(join(viewsDest, "SHA256SUMS.json"), `${JSON.stringify(sums, null, 2)}\n`);
console.log(`wrote ${viewsDest}: ${files.length} files and SHA256SUMS.json`);
