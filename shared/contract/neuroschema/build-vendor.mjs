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
 * Usage (from the nemar-cli repo root, with the neuroschema repo checked out
 * as a sibling):
 *   bun shared/contract/neuroschema/build-vendor.mjs ../neuroschema
 * Commit the regenerated dataset.bundle.json + bump the provenance below.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const nscRepo = process.argv[2];
if (!nscRepo) {
  console.error("usage: bun build-vendor.mjs <path-to-neuroschema-repo>");
  process.exit(1);
}
const schemaRoot = resolve(nscRepo, "schema");
const ROOT_REL = "core/dataset.schema.json";
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

const out = {
  _provenance: {
    source: "https://github.com/nemarOrg/neuroschema",
    generated_by: "shared/contract/neuroschema/build-vendor.mjs",
    note: "Do not hand-edit; regenerate from the neuroschema repo.",
  },
  root: idFor(ROOT_REL),
  schemas: [...bundle.values()],
};
const dest = join(import.meta.dir, "dataset.bundle.json");
writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${dest}: ${out.schemas.length} schemas, root ${out.root}`);
