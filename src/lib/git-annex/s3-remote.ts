/**
 * git-annex service: S3 special-remote configuration and credentials.
 *
 * Split from lib/git-annex.ts by concern (#908, epic #902); bodies moved
 * verbatim.
 */

import { join } from "node:path";
import { runCommand } from "./run-command.js";

/**
 * S3 remote configuration
 */
export interface S3RemoteConfig {
  name: string;
  bucket: string;
  prefix: string;
  region: string;
  publicUrl?: string;
  /** git-annex S3 multipart chunk size (e.g. "1GiB"). Without it git-annex does
   *  a single-part PUT per object, which S3 caps at 5 GB — so any data file over
   *  5 GB (common for raw iEEG/EEG) fails with 400 EntityTooLarge (#886).
   *  Defaults to DEFAULT_S3_PARTSIZE when unset. */
  partsize?: string;
}

/**
 * S3 credentials for git-annex operations.
 * Supports both long-lived IAM credentials and temporary STS credentials.
 */
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Map API credential response to S3Credentials for git-annex operations.
 */
export function toS3Credentials(creds: {
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
}): S3Credentials {
  return {
    accessKeyId: creds.access_key_id,
    secretAccessKey: creds.secret_access_key,
    sessionToken: creds.session_token,
  };
}

/**
 * Filter informational git-annex messages from stderr.
 * These warnings are harmless side effects, not actual errors.
 */
function filterAnnexInfoMessages(stderr: string): string {
  // Known safe patterns: git-annex progress/bookkeeping messages
  const safePatterns = [
    /^\(merging .* into .*\.\.\.\)$/,
    /^\(recording state in git\.\.\.\)$/,
    /^\(scanning for /,
    /^\(checking /,
  ];
  return stderr
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      // "Remote origin not usable by git-annex; setting annex-ignore"
      if (trimmed.includes("setting annex-ignore")) return false;
      if (safePatterns.some((p) => p.test(trimmed))) return false;
      return true;
    })
    .join("\n")
    .trim();
}

/**
 * Default git-annex S3 multipart chunk size. 1 GiB keeps each part well under
 * S3's 5 GB single-PUT / part cap while staying under the 10,000-part limit for
 * multi-TB objects (1 GiB * 10,000 = ~10 TiB headroom). Enables multipart PUT so
 * files over 5 GB upload instead of failing with EntityTooLarge (#886).
 */
export const DEFAULT_S3_PARTSIZE = "1GiB";

/**
 * Build git-annex S3 special remote key=value config arguments,
 * shared by initremote and enableremote. Normalizes the prefix to
 * always end with exactly one slash. Conditionally includes publicurl.
 * Always sets partsize so large objects use multipart PUT (#886).
 * Exported for unit testing; not part of the CLI-facing surface.
 */
export function buildS3RemoteArgs(config: S3RemoteConfig): string[] {
  const params = [
    "type=S3",
    "encryption=none",
    `bucket=${config.bucket}`,
    `fileprefix=${config.prefix.replace(/\/$/, "")}/`,
    `datacenter=${config.region}`,
    "signature=v4",
    "autoenable=true",
    "protocol=https",
    `partsize=${config.partsize ?? DEFAULT_S3_PARTSIZE}`,
  ];
  if (config.publicUrl) {
    params.push(`publicurl=${config.publicUrl}`);
  }
  return params;
}

/**
 * Match git-annex's wording when initremote is called for an already-registered
 * special-remote name. Anchored to the exact phrase so unrelated stderr (S3
 * bucket-conflict messages, key-collision warnings, etc.) cannot trigger the
 * enableremote fallback in `initOrEnableSpecialRemote`.
 */
export const ANNEX_REMOTE_EXISTS_RE = /There is already a special remote named "[^"]+"/;

/**
 * Check whether a named special remote is registered in this git-annex repo.
 *
 * Probes with `git annex info <name> --json` and accepts the result only when
 * git-annex echoes back the same name in the `remote` field. `git annex info`
 * also accepts files, keys, treeish refs, UUIDs, and the `here` alias; the
 * `remote === name` constraint rejects all of those even if a working-tree
 * collision happens to give the same name. Returns false on any error.
 */
export async function annexRemoteExists(path: string, name: string): Promise<boolean> {
  const { stdout, exitCode } = await runCommand(["git", "annex", "info", name, "--json"], {
    cwd: path,
  });
  if (exitCode !== 0) return false;
  try {
    const info = JSON.parse(stdout);
    return (
      info?.success === true &&
      typeof info.uuid === "string" &&
      info.uuid.length > 0 &&
      info.remote === name
    );
  } catch {
    return false;
  }
}

/**
 * Run `git annex enableremote NAME PARAMS...` and surface a useful error.
 */
async function enableSpecialRemoteWithParams(
  path: string,
  name: string,
  params: string[],
  env: Record<string, string>,
): Promise<{ success: boolean; error?: string }> {
  const result = await runCommand(["git", "annex", "enableremote", name, ...params], {
    cwd: path,
    env,
  });
  if (result.exitCode !== 0) {
    const realStderr = filterAnnexInfoMessages(result.stderr);
    return {
      success: false,
      error:
        realStderr || result.stderr.trim() || `enableremote exited with code ${result.exitCode}`,
    };
  }
  return { success: true };
}

/**
 * Init a special remote, falling back to enableremote when the remote is
 * already registered (resume from a prior failed run). The fallback fires
 * pre-emptively via `annexRemoteExists`, and post-hoc when initremote stderr
 * matches `ANNEX_REMOTE_EXISTS_RE`. Any other initremote failure surfaces the
 * raw stderr so callers can see the underlying error (S3 access denied,
 * bucket region mismatch, etc.).
 */
export async function initOrEnableSpecialRemote(
  path: string,
  name: string,
  params: string[],
  env: Record<string, string>,
): Promise<{ success: boolean; error?: string }> {
  if (await annexRemoteExists(path, name)) {
    return enableSpecialRemoteWithParams(path, name, params, env);
  }

  const { stderr, exitCode } = await runCommand(["git", "annex", "initremote", name, ...params], {
    cwd: path,
    env,
  });

  if (exitCode !== 0) {
    if (ANNEX_REMOTE_EXISTS_RE.test(stderr)) {
      return enableSpecialRemoteWithParams(path, name, params, env);
    }
    const realStderr = filterAnnexInfoMessages(stderr);
    return {
      success: false,
      error: realStderr || stderr.trim() || `initremote exited with code ${exitCode}`,
    };
  }

  const residual = filterAnnexInfoMessages(stderr);
  if (residual) {
    console.warn(`  Warning during special remote setup: ${residual}`);
  }
  return { success: true };
}

/**
 * Configure an S3 special remote, idempotently. Resumes a prior partial
 * upload by re-enabling instead of re-creating. The remote is configured
 * with publicurl for credential-free downloads and autoenable=true so clones
 * automatically enable it.
 */
/**
 * Build the AWS credential env subset for a git-annex S3 invocation, or
 * undefined when no credentials are supplied (anonymous access). Only the
 * credential keys are returned — `runCommand` already merges `process.env`, so
 * callers pass this as the bare `env` option (and those that pre-merge for
 * null-filtering spread it over `process.env` themselves). Extracted from the
 * three S3 data paths per #190.
 */
export function awsCredentialEnv(credentials?: S3Credentials): Record<string, string> | undefined {
  if (!credentials) return undefined;
  return {
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    ...(credentials.sessionToken ? { AWS_SESSION_TOKEN: credentials.sessionToken } : {}),
  };
}

export async function configureS3Remote(
  path: string,
  config: S3RemoteConfig,
  credentials: S3Credentials,
): Promise<{ success: boolean; error?: string }> {
  const env: Record<string, string> = {
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
  };
  if (credentials.sessionToken) {
    env.AWS_SESSION_TOKEN = credentials.sessionToken;
  }

  // git-annex emits "Remote origin not usable by git-annex; setting
  // annex-ignore" on first probe of an unrelated origin. Pre-set the flag
  // so the message does not get mixed into our error stderr.
  const configResult = await runCommand(["git", "config", "remote.origin.annex-ignore", "true"], {
    cwd: path,
  });
  if (configResult.exitCode !== 0) {
    console.warn(
      `Warning: could not set remote.origin.annex-ignore: ${configResult.stderr.trim()}`,
    );
  }

  try {
    return await initOrEnableSpecialRemote(path, config.name, buildS3RemoteArgs(config), env);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { success: false, error: `S3 remote configuration failed: ${message}` };
  }
}

/**
 * Clear cached S3 credentials from git-annex's local credential store.
 *
 * git-annex caches AWS credentials in .git/annex/creds/ during initremote.
 * When using STS temporary credentials, these expire and cause 403 errors
 * on subsequent downloads instead of falling back to publicurl.
 * Call this after upload completes so downloads use publicurl.
 */
export async function clearAnnexCredentials(path: string): Promise<void> {
  const { join } = await import("node:path");
  const { readdirSync, unlinkSync } = await import("node:fs");
  const credsDir = join(path, ".git", "annex", "creds");
  let files: string[];
  try {
    files = readdirSync(credsDir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn(`Warning: Could not read ${credsDir}: ${(e as Error).message}`);
    return;
  }
  for (const file of files) {
    try {
      unlinkSync(join(credsDir, file));
    } catch (e: unknown) {
      console.warn(`Warning: Could not delete ${file}: ${(e as Error).message}`);
    }
  }
}

/**
 * Enable an existing S3 special remote in a cloned repository.
 *
 * After `git clone` + `git annex init`, the remote config exists in the git-annex
 * branch but is not active locally. This function enables it so `git annex get`
 * can fetch from the S3 publicurl without write credentials.
 *
 * Returns success even if the remote doesn't exist (old datasets without S3 remote),
 * so callers don't need to handle backward compatibility.
 */
export async function enableS3Remote(
  path: string,
  remoteName = "nemar-s3",
  credentials?: S3Credentials,
): Promise<{ success: boolean; enabled: boolean; error?: string }> {
  try {
    const env = awsCredentialEnv(credentials) ?? {};

    const { stderr, exitCode } = await runCommand(["git", "annex", "enableremote", remoteName], {
      cwd: path,
      ...(Object.keys(env).length > 0 && {
        env: Object.fromEntries(
          Object.entries({ ...process.env, ...env }).filter(
            (e): e is [string, string] => e[1] != null,
          ),
        ),
      }),
    });

    if (exitCode === 0) {
      return { success: true, enabled: true };
    }

    // Remote not found in git-annex branch (old dataset) - not an error
    if (
      stderr.includes("there is no special remote named") ||
      stderr.includes("not a special remote") ||
      stderr.includes("Unknown remote") ||
      stderr.includes("not found")
    ) {
      return { success: true, enabled: false };
    }

    return { success: false, enabled: false, error: stderr.trim() };
  } catch (e) {
    return { success: false, enabled: false, error: (e as Error).message };
  }
}

/**
 * Valid remote name pattern (alphanumeric, dash, underscore, dot).
 */
const VALID_REMOTE_NAME = /^[a-zA-Z0-9._-]+$/;

/**
 * The canonical NEMAR S3 remote name. Created by `configureS3Remote` and
 * `import-openneuro.ts` for every NEMAR-managed dataset.
 */
export const NEMAR_S3_REMOTE_NAME = "nemar-s3";

/**
 * Returns true when `git config remote.<name>.annex-ignore` is `true`.
 * `annex-ignore` is set for inherited or read-only S3 remotes that we should
 * never select as an upload target (e.g., OpenNeuro's `s3-PUBLIC` after import).
 */
async function isAnnexIgnoredRemote(datasetPath: string, name: string): Promise<boolean> {
  const { stdout, exitCode } = await runCommand(["git", "config", `remote.${name}.annex-ignore`], {
    cwd: datasetPath,
  });
  if (exitCode !== 0) return false;
  return stdout.trim().toLowerCase() === "true";
}

/**
 * Get names of S3-type git-annex special remotes configured in a dataset.
 * Uses git config to detect remotes with S3-related configuration.
 * Skips any remote where `remote.<name>.annex-ignore=true` so inherited or
 * read-only S3 remotes (e.g., OpenNeuro's `s3-PUBLIC`) are never selected as
 * an upload target. Returns empty array if no usable S3 remotes are found.
 */
export async function getAnnexS3Remotes(datasetPath: string): Promise<string[]> {
  const candidates: string[] = [];

  // Primary: check git config for S3-configured remotes
  const { stdout: remoteList, exitCode: listCode } = await runCommand(
    ["git", "config", "--get-regexp", "^remote\\..*\\.annex-s3"],
    {
      cwd: datasetPath,
    },
  );

  if (listCode === 0 && remoteList.trim()) {
    for (const line of remoteList.trim().split("\n")) {
      const match = line.match(/^remote\.(.+?)\.annex-/);
      if (match && VALID_REMOTE_NAME.test(match[1])) {
        candidates.push(match[1]);
      }
    }
  }

  // Fallback: parse git-annex info --json for remote descriptions
  if (candidates.length === 0) {
    const {
      stdout: infoJson,
      exitCode: jsonCode,
      stderr: infoStderr,
    } = await runCommand(["git", "annex", "info", "--json"], { cwd: datasetPath });

    if (jsonCode !== 0) {
      if (infoStderr.trim()) {
        console.error(`git annex info failed: ${infoStderr.trim()}`);
      }
      return [];
    }

    if (!infoJson.trim()) return [];

    let info: Record<string, unknown>;
    try {
      info = JSON.parse(infoJson);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Failed to parse git-annex info JSON: ${msg}`);
      return [];
    }

    const repos = [
      ...(Array.isArray(info["trusted repositories"]) ? info["trusted repositories"] : []),
      ...(Array.isArray(info["semitrusted repositories"]) ? info["semitrusted repositories"] : []),
      ...(Array.isArray(info["untrusted repositories"]) ? info["untrusted repositories"] : []),
    ];

    for (const repo of repos) {
      if (!repo?.description?.includes("[")) continue;
      const nameMatch = repo.description.match(/\[(.+?)\]/);
      if (!nameMatch) continue;

      const name = nameMatch[1];
      if (!VALID_REMOTE_NAME.test(name)) continue;

      const { stdout: typeOut } = await runCommand(["git", "config", `remote.${name}.annex-s3`], {
        cwd: datasetPath,
      });
      if (typeOut.trim()) candidates.push(name);
    }
  }

  const unique = [...new Set(candidates)];
  const usable: string[] = [];
  for (const name of unique) {
    if (await isAnnexIgnoredRemote(datasetPath, name)) continue;
    usable.push(name);
  }
  return usable;
}

/**
 * Mark inherited git-annex remotes as `annex-ignore=true` so subsequent
 * `nemar dataset push` calls never pick them as upload targets. Skips
 * remotes that aren't configured. Returns the list of names that were
 * actually marked. Warnings (non-fatal) are written to `onWarn` if provided
 * so callers can surface them through their existing UI.
 *
 * Defaults to the upstream OpenNeuro mirror remotes (`s3-PUBLIC`,
 * `s3-PRIVATE`). The exemplar clone tool (epic #923 Phase 5) reuses this
 * with `["nemar-s3"]` to disable the inherited PRODUCTION nemar-s3 remote a
 * cloned nm/on source carries, before configuring a fresh dev-bucket remote.
 */
export async function markInheritedOpenNeuroRemotesIgnored(
  datasetPath: string,
  onWarn?: (remote: string, error: string) => void,
  remoteNames: string[] = ["s3-PUBLIC", "s3-PRIVATE"],
): Promise<string[]> {
  const marked: string[] = [];
  for (const inherited of remoteNames) {
    const exists = await runCommand(["git", "config", `remote.${inherited}.annex-uuid`], {
      cwd: datasetPath,
    });
    if (exists.exitCode !== 0 || !exists.stdout.trim()) continue;
    const ignore = await runCommand(["git", "config", `remote.${inherited}.annex-ignore`, "true"], {
      cwd: datasetPath,
    });
    if (ignore.exitCode !== 0) {
      onWarn?.(inherited, ignore.stderr.trim() || "unknown error");
      continue;
    }
    marked.push(inherited);
  }
  return marked;
}

/**
 * Pick the best S3 remote for upload from the candidates returned by
 * {@link getAnnexS3Remotes}. Prefers the canonical `nemar-s3` remote name,
 * then any remote whose annex description equals `[nemar-s3]`, then the first
 * remaining candidate. Returns null if the list is empty.
 *
 * This handles datasets imported from OpenNeuro that still have the inherited
 * `s3-PUBLIC` / `s3-PRIVATE` remotes alongside `nemar-s3` even when those
 * remotes are not annex-ignored: we always prefer the NEMAR-owned bucket.
 */
export async function selectAnnexS3Remote(
  datasetPath: string,
  remotes: string[],
): Promise<string | null> {
  if (remotes.length === 0) return null;
  if (remotes.length === 1) return remotes[0];

  if (remotes.includes(NEMAR_S3_REMOTE_NAME)) return NEMAR_S3_REMOTE_NAME;

  // Tiebreaker: pick the remote whose git-annex description equals [nemar-s3].
  // Useful if a future repo renames the git remote but keeps the description.
  const { stdout: infoJson, exitCode } = await runCommand(["git", "annex", "info", "--json"], {
    cwd: datasetPath,
  });
  if (exitCode === 0 && infoJson.trim()) {
    try {
      const info = JSON.parse(infoJson) as Record<string, unknown>;
      const repos = [
        ...(Array.isArray(info["trusted repositories"]) ? info["trusted repositories"] : []),
        ...(Array.isArray(info["semitrusted repositories"])
          ? info["semitrusted repositories"]
          : []),
        ...(Array.isArray(info["untrusted repositories"]) ? info["untrusted repositories"] : []),
      ];
      for (const repo of repos) {
        if (repo?.description !== `[${NEMAR_S3_REMOTE_NAME}]`) continue;
        const uuid = typeof repo.uuid === "string" ? repo.uuid : null;
        if (!uuid) continue;
        for (const candidate of remotes) {
          const { stdout } = await runCommand(["git", "config", `remote.${candidate}.annex-uuid`], {
            cwd: datasetPath,
          });
          if (stdout.trim() === uuid) return candidate;
        }
      }
    } catch (parseError) {
      // Malformed `git annex info --json` usually means a corrupted git-annex
      // branch or a version mismatch — both worth surfacing so the user knows
      // why the description tiebreaker was skipped before we fall through.
      const msg = parseError instanceof Error ? parseError.message : String(parseError);
      console.warn(`Could not parse git annex info JSON for remote selection: ${msg}`);
    }
  }

  return remotes[0];
}
