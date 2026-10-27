/**
 * The authenticated NEMAR data hosts: the only origins, besides the NEMAR API, that this CLI
 * will ever send its API key to (ADR 0114).
 *
 * A data host serves a dataset's git repository and its annexed objects behind the same access
 * check as the API. Three things use this list, and nothing else decides where a key may go:
 *
 *   - `git-annex-remote-nemar` (the special remote) checks the `host` it is configured with;
 *   - `nemar auth git-credential` answers a git request only for a host on the list;
 *   - `nemar dataset clone` / `dataset get` ask only listed hosts about a dataset.
 *
 * The list is built from the CLI build and the process environment and from nothing else. A
 * repository's remote configuration, its `.git/config` and its `git-annex` branch are
 * writable by anyone who can push, so none of them can add a host: a configuration that names
 * a host not on this list is refused before any request is made.
 *
 * Defaults: `https://private.nemar.org` in a production build and
 * `https://private-test.nemar.org` in a dev build (`IS_DEV_BUILD`).
 *
 * `NEMAR_DATA_HOSTS` adds origins (comma-separated), for staging and for the tests that run a
 * data host on this machine. Each entry must be a bare origin (scheme, host and optional port;
 * no path, query, fragment or credentials) and an `https` one, with one exception: `http` is
 * accepted for a loopback address only (`127.0.0.1`, `localhost`, `[::1]`), so a test can run
 * a plain-HTTP data host on its own machine. A non-loopback `http` origin is refused, so the
 * key can never travel in clear text over a network.
 *
 * `NEMAR_DATA_HOSTS_ONLY=1` drops the build default, so the list is exactly the origins in
 * `NEMAR_DATA_HOSTS`. It can only narrow the list; the tests use it to keep a lookup from
 * reaching the real hosts.
 *
 * Origins are compared exactly, as `URL.origin` writes them: scheme, lower-cased host and the
 * port when it is not the scheme's default.
 */

import { IS_DEV_BUILD } from "./api/client.js";

export const DATA_HOSTS_ENV = "NEMAR_DATA_HOSTS";
export const DATA_HOSTS_ONLY_ENV = "NEMAR_DATA_HOSTS_ONLY";
export const PRODUCTION_DATA_HOST = "https://private.nemar.org";
export const DEV_DATA_HOST = "https://private-test.nemar.org";

/** A dataset id on a data host: two or three lower-case letters and six digits. */
export const DATA_HOST_DATASET_ID = /^[a-z]{2,3}[0-9]{6}$/;

export function isDataHostDatasetId(value: string): boolean {
  return DATA_HOST_DATASET_ID.test(value);
}

export interface DataHostOptions {
  /** The environment to read `NEMAR_DATA_HOSTS` from; the process environment by default. */
  env?: Record<string, string | undefined>;
  /** Which build's defaults apply; this build's by default. */
  isDevBuild?: boolean;
}

/** True for the loopback names a local test data host is reached at. */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/**
 * The normalized origin of `value` when it is a bare origin a data host may have, else null.
 *
 * `https` always; `http` only for a loopback host. A path other than `/`, a query, a
 * fragment and embedded credentials make it null.
 */
export function parseDataHostOrigin(value: string): string | null {
  const text = value.trim();
  if (text === "" || /[?#@]/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/") return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return url.origin;
  return null;
}

/** The `NEMAR_DATA_HOSTS` entries, split into the origins that parse and the texts that do not. */
export function parseDataHostList(raw: string | undefined): {
  origins: string[];
  rejected: string[];
} {
  const origins: string[] = [];
  const rejected: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const text = entry.trim();
    if (text === "") continue;
    const origin = parseDataHostOrigin(text);
    if (origin === null) rejected.push(text);
    else if (!origins.includes(origin)) origins.push(origin);
  }
  return { origins, rejected };
}

function envOf(options: DataHostOptions): Record<string, string | undefined> {
  return options.env ?? process.env;
}

/** The origins this CLI may send its key to, defaults first, without duplicates. */
export function allowedDataHosts(options: DataHostOptions = {}): string[] {
  const env = envOf(options);
  const isDev = options.isDevBuild ?? IS_DEV_BUILD;
  const defaults =
    env[DATA_HOSTS_ONLY_ENV] === "1" ? [] : [isDev ? DEV_DATA_HOST : PRODUCTION_DATA_HOST];
  const { origins } = parseDataHostList(env[DATA_HOSTS_ENV]);
  return [...defaults, ...origins.filter((origin) => !defaults.includes(origin))];
}

/** `NEMAR_DATA_HOSTS` entries that were ignored, for a command to tell the user about. */
export function rejectedDataHostEntries(options: DataHostOptions = {}): string[] {
  return parseDataHostList(envOf(options)[DATA_HOSTS_ENV]).rejected;
}

/** True when `value` is a bare origin that is exactly one of {@link allowedDataHosts}. */
export function isAllowedDataHost(value: string, options: DataHostOptions = {}): boolean {
  const origin = parseDataHostOrigin(value);
  return origin !== null && allowedDataHosts(options).includes(origin);
}

/**
 * The allow-listed origin a full URL belongs to (a repository's remote URL, say), or null.
 * Unlike {@link isAllowedDataHost} the URL may carry a path.
 */
export function dataHostOriginOfUrl(url: string, options: DataHostOptions = {}): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.username !== "" || parsed.password !== "") return null;
  return isAllowedDataHost(parsed.origin, options) ? parsed.origin : null;
}

/**
 * Whether a redirect target may be fetched while a data host `origin` is being read.
 *
 * Always `https`. `http` only when the data host itself is a loopback `http` origin, which
 * only `NEMAR_DATA_HOSTS` can produce, and the target is loopback too: a plain-HTTP address is
 * never followed in a real setup.
 */
export function isPermittedTransport(target: URL, origin: string): boolean {
  if (target.protocol === "https:") return true;
  return (
    target.protocol === "http:" &&
    isLoopbackHostname(target.hostname) &&
    new URL(origin).protocol === "http:"
  );
}
