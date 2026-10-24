/**
 * The re-pull plan file and its digest (ADR 0111, decision 2: `--execute` requires `--plan <file>`
 * with the digest of the reviewed plan).
 *
 * The digest is the sha256 of the plan body's canonical JSON (`canonicalJson`: sorted keys, two
 * spaces, one trailing newline). What can differ between two runs over the same remotes is kept
 * out of the body, so the same inputs always give the same digest: `created_at`, `environment`,
 * the preflight answers (which depend on the token the operator holds, not on the dataset) and
 * whether the plan is executable (which follows from them).
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type CanonicalJsonValue,
  canonicalJson,
} from "../../../shared/neurobagel/canonical-json.js";
import type { Check } from "./preflight.js";

export const PLAN_SCHEMA = "nemar.repull-plan";
export const PLAN_FILE_VERSION = 1;

/** The fields of a plan file that are NOT part of the digested body. */
export const VOLATILE_FIELDS = [
  "schema",
  "version",
  "digest",
  "created_at",
  "environment",
  "preflight",
  "executable",
] as const;

export type PlanBody = { [key: string]: CanonicalJsonValue };

export interface PlanFile {
  schema: typeof PLAN_SCHEMA;
  version: typeof PLAN_FILE_VERSION;
  digest: string;
  created_at: string;
  environment: string;
  preflight: Check[];
  executable: boolean;
  body: PlanBody;
}

/** `sha256:<hex>` of the body's canonical JSON. */
export function planDigest(body: PlanBody): string {
  return `sha256:${createHash("sha256").update(canonicalJson(body)).digest("hex")}`;
}

/** The plan file as written: the volatile fields, then the body's own fields. */
export function planFileJson(file: PlanFile): string {
  const { body, ...head } = file;
  for (const key of Object.keys(body)) {
    if ((VOLATILE_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`a plan body may not hold the volatile field ${key}`);
    }
  }
  return `${JSON.stringify({ ...head, ...body }, null, 2)}\n`;
}

/** Split a plan file back into its volatile fields and its body, and recompute the digest. */
export function readPlanFile(text: string): {
  file: Record<string, unknown>;
  body: PlanBody;
  digest: string;
} {
  const file = JSON.parse(text) as Record<string, unknown>;
  const body: PlanBody = {};
  for (const [k, v] of Object.entries(file)) {
    if (!(VOLATILE_FIELDS as readonly string[]).includes(k)) body[k] = v as CanonicalJsonValue;
  }
  return { file, body, digest: planDigest(body) };
}

/** The default path: `$NEMAR_CONFIG_DIR/repull/<id>/<to>.<digest8>.json`. */
export function defaultPlanPath(
  configDir: string,
  datasetId: string,
  toTag: string,
  digest: string,
): string {
  return join(
    configDir,
    "repull",
    datasetId,
    `${toTag}.${digest.slice("sha256:".length, "sha256:".length + 8)}.json`,
  );
}

/** Write the plan with mode 0600 (a path can itself be an identifier), its directory 0700. */
export function writePlanFile(path: string, file: PlanFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, planFileJson(file), { mode: 0o600 });
  // `mode` applies only when the file is created; a rewrite keeps whatever mode it had.
  chmodSync(path, 0o600);
}
