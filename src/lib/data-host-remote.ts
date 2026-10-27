/**
 * `git-annex-remote-nemar`: a git-annex external special remote that reads annexed content
 * from an authenticated NEMAR data host (ADR 0114).
 *
 * It speaks version 1 of git-annex's external special remote protocol on stdin and stdout.
 * git-annex starts it for a remote declared with `externaltype=nemar` and two settings:
 *
 *   host=<origin of the data host>   dataset=<dataset id, two or three letters and six digits>
 *
 * Those settings live in the repository's `git-annex` branch, which anyone who can push may
 * change, so they are never trusted: `host` must be one of the origins this CLI allows
 * (`src/lib/data-hosts.ts`) and `dataset` must have the shape of a dataset id, or the remote
 * refuses to initialize and makes no request. The API key comes from the CLI's own stored
 * account, never from the repository.
 *
 * What it does:
 *   - `TRANSFER RETRIEVE`: `GET <host>/o/<dataset>/<key>` with `Authorization: Bearer <key>`.
 *     Redirects are followed by hand, at most {@link MAX_REDIRECTS}, and `Authorization` is sent
 *     only to a URL whose origin is the configured host: the short-lived address a large
 *     object redirects to carries its own signature and lives on another origin, which must
 *     not see the key. Only `https` is followed (see `isPermittedTransport`).
 *   - `CHECKPRESENT`: a `HEAD` to the same address; 200 present, 404 absent, anything else
 *     unknown (a fault is never reported as absence, which git-annex would act on).
 *   - `TRANSFER STORE` and `REMOVE` are refused: the remote is read-only for now.
 *
 * stdout is the protocol channel, so nothing else may be written to it. Messages sent to
 * git-annex are built from fixed text, status codes and error class names; none contains the
 * API key, a redirect address or its query string.
 */

import { type FileHandle, open, rm } from "node:fs/promises";
import {
  type DataHostOptions,
  isAllowedDataHost,
  isDataHostDatasetId,
  isPermittedTransport,
  parseDataHostOrigin,
} from "./data-hosts.js";

/** The most redirects followed for one request. */
export const MAX_REDIRECTS = 3;

/** How long a request may take to answer with headers, and a body to produce its next bytes. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** A progress line is sent at most this often, in bytes received. */
const PROGRESS_STEP_BYTES = 256 * 1024;

/** The longest object name the data host accepts; the same limit as the server's key rule. */
const KEY_MAX_LENGTH = 255;

/**
 * A key safe to put in a URL path: letters, digits and `. _ + -`, so it cannot hold a
 * separator, a dot segment, a query or whitespace. git-annex keys that fall outside this
 * (one holding `%` or `:`) are not on a data host.
 */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** The configuration `INITREMOTE` and `PREPARE` accept: a vetted host and dataset id. */
export interface RemoteSettings {
  origin: string;
  dataset: string;
}

export function isSafeKey(key: string): boolean {
  return key.length <= KEY_MAX_LENGTH && SAFE_KEY.test(key);
}

/**
 * The byte size a key declares (`SHA256E-s123--hash.ext` is 123), or null when it declares
 * none or is a chunk key, whose `-s` field this remote does not interpret.
 */
export function sizeOfKey(key: string): number | null {
  if (/-S\d+-C\d+(?:-|$)/.test(key)) return null;
  const match = /^[A-Za-z0-9]+-s(\d+)(?:-|$)/.exec(key);
  if (!match) return null;
  const size = Number(match[1]);
  return Number.isSafeInteger(size) ? size : null;
}

/**
 * Check what the repository's remote configuration names. Returns the settings, or a message
 * for `INITREMOTE-FAILURE` and `PREPARE-FAILURE`. Makes no request.
 */
export function vetSettings(
  host: string | undefined,
  dataset: string | undefined,
  options: DataHostOptions = {},
): { ok: true; settings: RemoteSettings } | { ok: false; message: string } {
  if (!host) return { ok: false, message: "The remote has no host setting." };
  if (!dataset) return { ok: false, message: "The remote has no dataset setting." };
  if (!isDataHostDatasetId(dataset)) {
    return {
      ok: false,
      message: "The dataset setting is not a dataset id (two or three letters and six digits).",
    };
  }
  const origin = parseDataHostOrigin(host);
  if (origin === null) {
    return {
      ok: false,
      message: `The host setting ${printable(host)} is not an https origin.`,
    };
  }
  if (!isAllowedDataHost(origin, options)) {
    return {
      ok: false,
      message: `${origin} is not a data host this CLI sends its API key to. The remote's host setting is part of the repository, so it cannot add one.`,
    };
  }
  return { ok: true, settings: { origin, dataset } };
}

/** Make text safe as the free-text part of one protocol line. */
export function printable(text: string, max = 200): string {
  const flat = text.replace(/[^\x20-\x7e]/g, "?");
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : "error";
}

/** The address of an object on a data host. The key is already vetted by {@link isSafeKey}. */
export function objectUrl(settings: RemoteSettings, key: string): URL {
  return new URL(
    `${settings.origin}/o/${encodeURIComponent(settings.dataset)}/${encodeURIComponent(key)}`,
  );
}

function statusMessage(status: number, redirected: boolean): string {
  if (redirected) return `The storage address was refused (status ${status}).`;
  if (status === 401) {
    return "The data host refused the API key. Run 'nemar auth login' to sign in again.";
  }
  if (status === 404) {
    return "The data host has no such object, or this account has no access to the dataset.";
  }
  if (status === 429) return "The data host is limiting requests; try again shortly.";
  return `The data host answered status ${status}.`;
}

type Fetched =
  | { kind: "response"; response: Response; redirected: boolean }
  | { kind: "failed"; message: string };

/**
 * One request to an object, following redirects by hand. `Authorization` goes only to a URL
 * whose origin is `settings.origin`.
 */
async function fetchObject(
  settings: RemoteSettings,
  key: string,
  apiKey: string,
  method: "GET" | "HEAD",
  follow: boolean,
  signal: AbortSignal,
): Promise<Fetched> {
  let url = objectUrl(settings, key);
  let redirected = false;
  for (let hop = 0; ; hop++) {
    const headers: Record<string, string> = { "Accept-Encoding": "identity" };
    if (url.origin === settings.origin) headers.Authorization = `Bearer ${apiKey}`;
    let response: Response;
    try {
      response = await fetch(url, { method, headers, redirect: "manual", signal });
    } catch (error) {
      if (signal.aborted) return { kind: "failed", message: "The request timed out." };
      return { kind: "failed", message: `Could not reach the host (${errorClass(error)}).` };
    }
    if (response.status < 300 || response.status >= 400) {
      return { kind: "response", response, redirected };
    }
    await response.body?.cancel().catch(() => {});
    if (!follow) return { kind: "response", response, redirected };
    if (hop >= MAX_REDIRECTS) {
      return { kind: "failed", message: `More than ${MAX_REDIRECTS} redirects.` };
    }
    const location = response.headers.get("location");
    if (!location) return { kind: "failed", message: "A redirect named no address." };
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return { kind: "failed", message: "A redirect named an address that is not a URL." };
    }
    if (!isPermittedTransport(next, settings.origin)) {
      return { kind: "failed", message: "A redirect named an address that is not https." };
    }
    url = next;
    redirected = true;
  }
}

/** Run `work` with an abort signal that fires `ms` after the last call to `touch`. */
async function withIdleTimeout<T>(
  ms: number,
  work: (signal: AbortSignal, touch: () => void) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), ms);
  const touch = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), ms);
  };
  try {
    return await work(controller.signal, touch);
  } finally {
    clearTimeout(timer);
  }
}

export type RetrieveResult = { ok: true; bytes: number } | { ok: false; message: string };

/**
 * Download an object to `file`. `onProgress` gets the running byte count. A file that ends
 * with the wrong size is removed, so no short object is left where git-annex would find it
 * (git-annex also verifies the hash itself).
 */
export async function retrieveObject(
  settings: RemoteSettings,
  key: string,
  apiKey: string,
  file: string,
  onProgress: (bytes: number) => void,
): Promise<RetrieveResult> {
  if (!isSafeKey(key)) return { ok: false, message: "The key is not one a data host serves." };
  const expected = sizeOfKey(key);
  return withIdleTimeout(REQUEST_TIMEOUT_MS, async (signal, touch) => {
    const fetched = await fetchObject(settings, key, apiKey, "GET", true, signal);
    if (fetched.kind === "failed") return { ok: false, message: fetched.message };
    const { response, redirected } = fetched;
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, message: statusMessage(response.status, redirected) };
    }
    const declared = response.headers.get("content-length");
    if (expected !== null && declared !== null && Number(declared) !== expected) {
      await response.body.cancel().catch(() => {});
      return {
        ok: false,
        message: `The object is ${printable(declared, 20)} bytes but its key says ${expected}.`,
      };
    }
    touch();
    let handle: FileHandle | undefined;
    let received = 0;
    let reported = 0;
    try {
      handle = await open(file, "w");
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        touch();
        received += value.byteLength;
        if (expected !== null && received > expected) {
          await reader.cancel().catch(() => {});
          throw new SizeError(`More bytes arrived than the key's ${expected}.`);
        }
        await handle.write(value);
        if (received - reported >= PROGRESS_STEP_BYTES) {
          reported = received;
          onProgress(received);
        }
      }
      await handle.close();
      handle = undefined;
      if (expected !== null && received !== expected) {
        throw new SizeError(`The object ended after ${received} bytes; its key says ${expected}.`);
      }
      if (received !== reported) onProgress(received);
      return { ok: true, bytes: received } as RetrieveResult;
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(file, { force: true }).catch(() => {});
      if (error instanceof SizeError) return { ok: false, message: error.message };
      if (signal.aborted) return { ok: false, message: "The transfer stalled and timed out." };
      return { ok: false, message: `The transfer failed (${errorClass(error)}).` };
    }
  });
}

class SizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SizeError";
  }
}

export type PresenceResult =
  | { state: "present" }
  | { state: "absent" }
  | { state: "unknown"; message: string };

/** Ask whether an object is on the data host: a `HEAD`, never a download. */
export async function checkObject(
  settings: RemoteSettings,
  key: string,
  apiKey: string,
): Promise<PresenceResult> {
  if (!isSafeKey(key)) return { state: "absent" };
  return withIdleTimeout(REQUEST_TIMEOUT_MS, async (signal) => {
    const fetched = await fetchObject(settings, key, apiKey, "HEAD", false, signal);
    if (fetched.kind === "failed") return { state: "unknown", message: fetched.message };
    const { status } = fetched.response;
    await fetched.response.body?.cancel().catch(() => {});
    if (status === 200) return { state: "present" };
    if (status === 404) return { state: "absent" };
    return { state: "unknown", message: statusMessage(status, false) };
  });
}

/** Where the protocol's lines come from and go to. */
export interface RemoteIo {
  /** Every line git-annex sends, without its newline. */
  lines: AsyncIterable<string>;
  /** Send one line to git-annex (the newline is added). */
  send: (line: string) => Promise<void> | void;
}

export interface RemoteDeps {
  /** Reads the API key from the CLI's stored account; undefined when there is none. */
  loadApiKey: () => string | undefined;
  options?: DataHostOptions;
}

class ProtocolAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolAbort";
  }
}

/**
 * Run the protocol until git-annex closes its side or sends `ERROR`. Returns the exit code.
 */
export async function runRemote(io: RemoteIo, deps: RemoteDeps): Promise<number> {
  const iterator = io.lines[Symbol.asyncIterator]();
  // Lines that arrived while a request was waiting for its VALUE reply. git-annex answers a
  // GETCONFIG at once, but a line that comes between is kept and handled in order afterwards.
  const deferred: string[] = [];
  let settings: RemoteSettings | null = null;
  let apiKey: string | null = null;

  const next = async (): Promise<string | null> => {
    const held = deferred.shift();
    if (held !== undefined) return held;
    const result = await iterator.next();
    return result.done ? null : result.value;
  };

  const getConfig = async (name: string): Promise<string | undefined> => {
    await io.send(`GETCONFIG ${name}`);
    while (true) {
      const result = await iterator.next();
      if (result.done) throw new ProtocolAbort("git-annex closed the connection");
      const line = result.value;
      if (line === "VALUE" || line.startsWith("VALUE ")) {
        const value = line.slice("VALUE".length).trimStart();
        return value === "" ? undefined : value;
      }
      if (line.startsWith("ERROR")) throw new ProtocolAbort(line);
      deferred.push(line);
    }
  };

  const vetConfigured = async () => {
    const host = await getConfig("host");
    const dataset = await getConfig("dataset");
    return vetSettings(host, dataset, deps.options);
  };

  const retrieve = async (key: string, file: string): Promise<void> => {
    if (!settings || !apiKey) {
      await io.send(
        `TRANSFER-FAILURE RETRIEVE ${printable(key)} The remote has not been prepared.`,
      );
      return;
    }
    // Chained, not awaited inside the callback: a progress line must not reorder the reply.
    let progress: Promise<void> = Promise.resolve();
    const result = await retrieveObject(settings, key, apiKey, file, (bytes) => {
      progress = progress.then(() => io.send(`PROGRESS ${bytes}`));
    });
    await progress;
    if (result.ok) await io.send(`TRANSFER-SUCCESS RETRIEVE ${key}`);
    else await io.send(`TRANSFER-FAILURE RETRIEVE ${printable(key)} ${printable(result.message)}`);
  };

  await io.send("VERSION 1");

  while (true) {
    const line = await next();
    if (line === null) return 0;
    if (line.trim() === "") continue;
    const [command, ...rest] = splitWords(line, 1);
    const argument = rest[0] ?? "";
    try {
      switch (command) {
        case "EXTENSIONS":
          await io.send("EXTENSIONS");
          break;
        case "INITREMOTE": {
          const vetted = await vetConfigured();
          await io.send(
            vetted.ok ? "INITREMOTE-SUCCESS" : `INITREMOTE-FAILURE ${printable(vetted.message)}`,
          );
          break;
        }
        case "PREPARE": {
          const vetted = await vetConfigured();
          if (!vetted.ok) {
            settings = null;
            await io.send(`PREPARE-FAILURE ${printable(vetted.message)}`);
            break;
          }
          const stored = deps.loadApiKey();
          if (!stored) {
            settings = null;
            await io.send(
              "PREPARE-FAILURE No NEMAR API key is stored. Run 'nemar auth login' first.",
            );
            break;
          }
          settings = vetted.settings;
          apiKey = stored;
          await io.send("PREPARE-SUCCESS");
          break;
        }
        case "LISTCONFIGS":
          await io.send("CONFIG host The https origin of the NEMAR data host");
          await io.send("CONFIG dataset The dataset id on that host");
          await io.send("CONFIGEND");
          break;
        case "GETCOST":
          await io.send("COST 200");
          break;
        case "GETAVAILABILITY":
          await io.send("AVAILABILITY GLOBAL");
          break;
        case "GETINFO":
          if (settings) {
            await io.send("INFOFIELD host");
            await io.send(`INFOVALUE ${settings.origin}`);
            await io.send("INFOFIELD dataset");
            await io.send(`INFOVALUE ${settings.dataset}`);
          }
          await io.send("INFOEND");
          break;
        case "WHEREIS":
          await io.send("WHEREIS-FAILURE");
          break;
        case "CLAIMURL":
          await io.send("CLAIMURL-FAILURE");
          break;
        case "CHECKURL":
          await io.send("CHECKURL-FAILURE");
          break;
        case "TRANSFER": {
          const [direction, key, ...file] = splitWords(argument, 2);
          if (direction === "STORE") {
            await io.send(
              `TRANSFER-FAILURE STORE ${printable(key ?? "")} This remote is read-only for now.`,
            );
          } else if (direction === "RETRIEVE" && key && file[0]) {
            await retrieve(key, file[0]);
          } else {
            await io.send("UNSUPPORTED-REQUEST");
          }
          break;
        }
        case "CHECKPRESENT": {
          if (!argument) {
            await io.send("UNSUPPORTED-REQUEST");
            break;
          }
          if (!settings || !apiKey) {
            await io.send(
              `CHECKPRESENT-UNKNOWN ${printable(argument)} The remote has not been prepared.`,
            );
            break;
          }
          const presence = await checkObject(settings, argument, apiKey);
          if (presence.state === "present") await io.send(`CHECKPRESENT-SUCCESS ${argument}`);
          else if (presence.state === "absent") await io.send(`CHECKPRESENT-FAILURE ${argument}`);
          else await io.send(`CHECKPRESENT-UNKNOWN ${printable(argument)} ${presence.message}`);
          break;
        }
        case "REMOVE":
          await io.send(`REMOVE-FAILURE ${printable(argument)} This remote is read-only for now.`);
          break;
        case "ERROR":
          return 1;
        case "VALUE":
          // A VALUE nobody asked for; nothing to answer.
          break;
        default:
          await io.send("UNSUPPORTED-REQUEST");
      }
    } catch (error) {
      if (error instanceof ProtocolAbort) return 1;
      throw error;
    }
  }
}

/**
 * Split a protocol line into at most `limit + 1` pieces on single spaces; the last piece keeps
 * the rest of the line, spaces included (a file name may hold them).
 */
export function splitWords(line: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = line;
  for (let i = 0; i < limit; i++) {
    const at = rest.indexOf(" ");
    if (at < 0) break;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  parts.push(rest);
  return parts;
}
