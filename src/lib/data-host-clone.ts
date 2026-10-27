/**
 * Reading a dataset from an authenticated NEMAR data host: finding which host has it, cloning
 * its repository, and recognizing such a clone later (ADR 0114).
 *
 * A data host serves a dataset's git repository at `<origin>/git/<id>.git` behind the same
 * access check as the API, and its annexed objects at `<origin>/o/<id>/<key>`. The CLI reaches
 * the repository with a git credential helper (`nemar auth git-credential`) set for that one
 * origin, and the objects through the `git-annex-remote-nemar` special remote that the
 * repository declares in its `git-annex` branch with `autoenable=true`.
 *
 * Every request here that carries the API key goes to an origin on the allow-list in
 * `src/lib/data-hosts.ts`, and redirects are never followed with the key.
 */

import { type DataHostOptions, dataHostOriginOfUrl } from "./data-hosts.js";
import { ANNEX_CLONE_DESCRIPTION } from "./git-annex/init.js";
import { runCommand } from "./git-annex/run-command.js";

/** How long to wait for a data host to answer a dataset lookup. */
export const LOOKUP_TIMEOUT_MS = 15_000;

/** The URL a dataset's repository is cloned from. */
export function dataHostCloneUrl(origin: string, datasetId: string): string {
  return `${origin}/git/${datasetId}.git`;
}

/**
 * The shell command git runs as the credential helper: `!nemar auth git-credential`.
 *
 * `NEMAR_CREDENTIAL_HELPER` overrides it (an unusual install, or a test whose `nemar` is not on
 * `PATH`). Otherwise `nemar` is used when it is on `PATH`, since a bare name survives a
 * reinstall, and the running program's own path when it is not.
 */
export function credentialHelperCommand(env: Record<string, string | undefined> = process.env) {
  const override = env.NEMAR_CREDENTIAL_HELPER?.trim();
  if (override) return override.startsWith("!") ? override : `!${override}`;
  if (Bun.which("nemar")) return "!nemar auth git-credential";
  const script = process.argv[1];
  if (script) return `!${shellQuote(process.execPath)} ${shellQuote(script)} auth git-credential`;
  return "!nemar auth git-credential";
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** What a lookup learned from one data host. */
export interface DataHostLookup {
  found: { origin: string; name?: string } | null;
  /** Hosts that answered but refused the API key. */
  refused: string[];
  /** Hosts that could not be asked (down, slow, or an answer that is not a dataset). */
  unreachable: string[];
}

/**
 * Ask each of `origins` whether it holds `datasetId` for this key. The caller passes only
 * allow-listed origins (`allowedDataHosts()` or the one `--host` named after the list check),
 * and this function sends the key to nothing else.
 *
 * `GET <origin>/api/datasets/<id>` with the key, never following a redirect: 200 is a hit, 404
 * is "not here", 401 is a refused key.
 */
export async function findDatasetOnDataHosts(
  datasetId: string,
  apiKey: string,
  origins: readonly string[],
): Promise<DataHostLookup> {
  const result: DataHostLookup = { found: null, refused: [], unreachable: [] };
  for (const origin of origins) {
    try {
      const response = await fetch(`${origin}/api/datasets/${encodeURIComponent(datasetId)}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      if (response.status === 200) {
        const body = (await response.json().catch(() => null)) as {
          dataset?: { id?: unknown; name?: unknown };
        } | null;
        if (body?.dataset?.id === datasetId) {
          const name = typeof body.dataset.name === "string" ? body.dataset.name : undefined;
          result.found = { origin, name };
          return result;
        }
        result.unreachable.push(origin);
      } else if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
      } else if (response.status === 401) {
        await response.body?.cancel().catch(() => {});
        result.refused.push(origin);
      } else {
        await response.body?.cancel().catch(() => {});
        result.unreachable.push(origin);
      }
    } catch {
      result.unreachable.push(origin);
    }
  }
  return result;
}

export interface DataHostCloneResult {
  success: boolean;
  error?: string;
}

/**
 * Clone `<origin>/git/<id>.git` into `outputPath` and initialize git-annex.
 *
 * The credential helper is passed to the clone with `-c` and written into the clone's own
 * config, scoped to the origin (`credential.<origin>.helper`), and preceded by an empty helper,
 * which resets the list git has collected from lower-priority files: without it a keychain
 * helper configured for all hosts would be offered the key to store. The key itself is never
 * written anywhere.
 */
export async function cloneFromDataHost(
  origin: string,
  datasetId: string,
  outputPath: string,
  helper: string = credentialHelperCommand(),
): Promise<DataHostCloneResult> {
  const helperKey = `credential.${origin}.helper`;
  const clone = await runCommand([
    "git",
    "-c",
    `${helperKey}=`,
    "-c",
    `${helperKey}=${helper}`,
    "clone",
    dataHostCloneUrl(origin, datasetId),
    outputPath,
  ]);
  if (clone.exitCode !== 0) {
    return { success: false, error: clone.stderr.trim() || "Failed to clone dataset" };
  }

  // The reset and then the helper, in that order, as two values of one multi-valued key.
  for (const value of ["", helper]) {
    const set = await runCommand(["git", "config", "--add", helperKey, value], {
      cwd: outputPath,
    });
    if (set.exitCode !== 0) {
      return {
        success: false,
        error: `Cloned but could not write the credential helper to the clone's config: ${set.stderr.trim()}`,
      };
    }
  }

  const init = await runCommand(["git", "annex", "init", ANNEX_CLONE_DESCRIPTION], {
    cwd: outputPath,
  });
  if (init.exitCode !== 0) {
    const check = await runCommand(["git", "annex", "info"], { cwd: outputPath });
    if (check.exitCode !== 0) {
      return {
        success: false,
        error: `Cloned repository but git-annex initialization failed: ${init.stderr.trim()}`,
      };
    }
  }
  return { success: true };
}

/** True when the repository has a remote whose special remote program is `git-annex-remote-nemar`. */
export async function declaresNemarRemote(repoPath: string): Promise<boolean> {
  const { stdout, exitCode } = await runCommand(
    ["git", "config", "--get-regexp", "^remote\\..+\\.annex-externaltype$"],
    { cwd: repoPath },
  );
  if (exitCode !== 0) return false;
  return stdout.split("\n").some((line) => line.trim().split(/\s+/)[1]?.toLowerCase() === "nemar");
}

/** True when the special remote program git-annex would run is on `PATH`. */
export function specialRemoteOnPath(): boolean {
  return Bun.which("git-annex-remote-nemar") !== null;
}

/**
 * Whether the repository at `repoPath` is a clone of a dataset from an allow-listed data host,
 * judged by its `origin` URL (`<origin>/git/<id>.git`). Nothing else in the repository is
 * consulted: it is the user's own clone, but the decision to send the key still rests on the
 * origin being on the CLI's list.
 */
export async function detectDataHostClone(
  repoPath: string,
  options: DataHostOptions = {},
): Promise<{ origin: string; datasetId: string } | null> {
  const { stdout, exitCode } = await runCommand(["git", "remote", "get-url", "origin"], {
    cwd: repoPath,
  });
  if (exitCode !== 0) return null;
  const url = stdout.trim();
  const origin = dataHostOriginOfUrl(url, options);
  if (origin === null) return null;
  const match = /^\/git\/([a-z]{2,3}[0-9]{6})\.git\/?$/.exec(new URL(url).pathname);
  return match ? { origin, datasetId: match[1] } : null;
}
