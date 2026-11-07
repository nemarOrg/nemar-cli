/**
 * The code bundle a person submits with a compute job, as the command-line interface (CLI) and the Worker
 * both see it (epic #2021 phase D3, #2024; ADR 0118, the amendment of this phase).
 *
 * A bundle is ONE archive, `bundle.tar.gz`, that the CLI packs and uploads to the single address the
 * Worker issues. Two documents describe it, and they are not the same thing:
 *
 *  - the ARCHIVE's own `{ size, sha256 }`, the `bundle` of the job specification (`JobSpecSchema`). The
 *    SHA-256 is of the archive file itself. The launcher verifies it on the node, so the Worker never
 *    hashes the archive's bytes; the Worker checks the uploaded object's SIZE against the declared one;
 *  - the MANIFEST, `bundle-manifest.json`: the path, size and SHA-256 of every file INSIDE the archive,
 *    as the packer listed them. The Worker validates its shape and caps and records it beside the
 *    archive. It does not re-hash a file: a per-file digest is the packer's claim, recorded, not
 *    checked.
 *
 * ONE SET OF CAPS. The CLI refuses an oversized bundle before any network call using the constants
 * below; the Worker enforces the OWNER'S policy (`bundleLimits`), whose default is these same numbers
 * (`DEFAULT_COMPUTE_POLICY`, and a test holds the two together). `checkBundleManifest` is the one rule
 * for what a manifest may hold, called with the constants by the CLI and with the policy's limits by the
 * Worker; a refusal names a field and a fixed word, never a path or a value. If the owner RAISES a limit,
 * a CLI released before the change keeps refusing locally at the constants, which is the safe direction.
 *
 * This module imports only the contract's path and digest predicates, and holds no zod schema, so a CLI and
 * a browser can load it and nothing here can be strict. The manifest's ZOD schema, a request document the
 * Worker validates as it comes in, is `./compute-submit-request.ts`.
 */

import { COMPUTE_SHA256_RE, isSafeComputePath } from "./compute.js";

// --- The caps ---------------------------------------------------------------------------------------

const MIB = 1024 * 1024;

/** The most bytes of the archive itself (the compressed file that is uploaded): 100 MiB. */
export const BUNDLE_MAX_TOTAL_BYTES = 100 * MIB;

/** The most files inside one archive. */
export const BUNDLE_MAX_FILES = 2000;

/** The most bytes of any one file inside the archive: 25 MiB. */
export const BUNDLE_MAX_FILE_BYTES = 25 * MIB;

/** The longest path of a file inside the archive, in characters. */
export const BUNDLE_PATH_MAX = 240;

/** The archive's name in `incoming/<id>/` and in `records/<id>/submitted/`: fixed, never chosen by a person. */
export const BUNDLE_ARCHIVE_FILE = "bundle.tar.gz";

/**
 * The most bytes of a request body that carries a manifest: one entry is a path of at most
 * {@link BUNDLE_PATH_MAX} characters (four bytes each in UTF-8), a size and a digest, so about 1.1 KiB
 * as JSON; {@link BUNDLE_MAX_FILES} of them, and 64 KiB for the specification beside it. A body over
 * this is `invalid_spec` with status 413 before anything is read.
 */
export const BUNDLE_BODY_MAX_BYTES = BUNDLE_MAX_FILES * 1200 + 64 * 1024;

export interface BundleLimits {
  maxTotalBytes: number;
  maxFiles: number;
  maxFileBytes: number;
}

/** The constants as a limits object, for a caller with no owner policy (the CLI). */
export const BUNDLE_DEFAULT_LIMITS: Readonly<BundleLimits> = Object.freeze({
  maxTotalBytes: BUNDLE_MAX_TOTAL_BYTES,
  maxFiles: BUNDLE_MAX_FILES,
  maxFileBytes: BUNDLE_MAX_FILE_BYTES,
});

// --- The manifest ------------------------------------------------------------------------------------

/** Why a manifest is refused: a fixed word of the compute refusals and, for `invalid_spec`, the field. */
export type BundleManifestRefusal =
  | { ok: false; code: "invalid_spec"; field: string }
  | { ok: false; code: "bundle_too_many_files" | "bundle_too_large" | "entry_not_in_bundle" };

export type BundleManifestVerdict = { ok: true } | BundleManifestRefusal;

/**
 * The one rule for what a manifest may hold, in this order, and the FIRST failure is the answer:
 *  1. a list of 1 or more entries (`invalid_spec`, field `files`);
 *  2. at most `limits.maxFiles` entries (`bundle_too_many_files`);
 *  3. for each entry in order: it is exactly `{ path, size, sha256 }` and the path is a safe relative
 *     path of at most {@link BUNDLE_PATH_MAX} characters (`invalid_spec`, `files.<i>.path`, `.size` or
 *     `.sha256`), no path is listed twice (`files.<i>.path`), the file is within `limits.maxFileBytes`
 *     and the running total within `limits.maxTotalBytes` (`bundle_too_large`);
 *  4. the job's `entry`, when it has one, is one of the paths (`entry_not_in_bundle`).
 * The paths are compared exactly. The archive's own size is checked against `maxTotalBytes` by the
 * caller, because it is not in the manifest. Pure.
 */
export function checkBundleManifest(
  files: unknown,
  limits: BundleLimits = BUNDLE_DEFAULT_LIMITS,
  entry?: string,
): BundleManifestVerdict {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, code: "invalid_spec", field: "files" };
  }
  if (files.length > limits.maxFiles) return { ok: false, code: "bundle_too_many_files" };
  const seen = new Set<string>();
  let total = 0;
  for (let i = 0; i < files.length; i++) {
    const item = files[i] as unknown;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, code: "invalid_spec", field: `files.${i}` };
    }
    const file = item as Record<string, unknown>;
    if (Object.keys(file).some((k) => k !== "path" && k !== "size" && k !== "sha256")) {
      return { ok: false, code: "invalid_spec", field: `files.${i}` };
    }
    if (typeof file.path !== "string" || !isSafeComputePath(file.path, BUNDLE_PATH_MAX)) {
      return { ok: false, code: "invalid_spec", field: `files.${i}.path` };
    }
    if (seen.has(file.path)) return { ok: false, code: "invalid_spec", field: `files.${i}.path` };
    seen.add(file.path);
    if (typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0) {
      return { ok: false, code: "invalid_spec", field: `files.${i}.size` };
    }
    if (typeof file.sha256 !== "string" || !COMPUTE_SHA256_RE.test(file.sha256)) {
      return { ok: false, code: "invalid_spec", field: `files.${i}.sha256` };
    }
    if (file.size > limits.maxFileBytes) return { ok: false, code: "bundle_too_large" };
    total += file.size;
    if (total > limits.maxTotalBytes) return { ok: false, code: "bundle_too_large" };
  }
  if (entry !== undefined && !seen.has(entry)) return { ok: false, code: "entry_not_in_bundle" };
  return { ok: true };
}
