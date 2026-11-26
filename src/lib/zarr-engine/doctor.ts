/**
 * The "Zarr engine" checks of `nemar doctor`: the engine starts and answers `hello` within 10
 * seconds, and the disk cache directory can be written (ADR 0120). Diagnostic only; the caller
 * prints them and the exit code of `doctor` does not depend on them.
 */

import { dlog } from "../debug-log.js";
import { EngineClient, EngineClientError } from "./client.js";
import { type DiskCache, resolveDiskCache } from "./disk-cache.js";
import { EngineConfigError } from "./http.js";

export const ENGINE_HELLO_TIMEOUT_MS = 10_000;

/** The detail of a cache check that failed in a way nothing anticipated. Fixed text: `doctor`
 *  always exits 0, so an unexpected error becomes this failed check, never a crash. */
export const CACHE_CHECK_UNEXPECTED =
  "the disk cache could not be checked (an unexpected error); run again with --debug and attach the log to an issue";

export interface ZarrEngineCheck {
  name: string;
  ok: boolean;
  /** What was found: the engine's version, the directory, or why it failed. */
  detail: string;
}

export async function checkZarrEngine(): Promise<ZarrEngineCheck[]> {
  const checks: ZarrEngineCheck[] = [];

  const started = Date.now();
  const client = EngineClient.start({ timeoutMs: ENGINE_HELLO_TIMEOUT_MS });
  try {
    const hello = await client.hello();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    checks.push({
      name: "engine starts",
      ok: true,
      detail: `${hello.engine} answered in ${seconds} s`,
    });
  } catch (err) {
    const last =
      err instanceof EngineClientError ? err.stderr.split("\n").filter(Boolean).at(-1) : "";
    const message = err instanceof Error ? err.message : String(err);
    checks.push({
      name: "engine starts",
      ok: false,
      detail: last ? `${message}: ${last}` : message,
    });
  } finally {
    await client.close();
  }

  checks.push(checkCacheDirectory());
  return checks;
}

/** The "cache directory" check. Never throws: a configuration error names the setting, and any
 *  other error is a failed check with {@link CACHE_CHECK_UNEXPECTED}. `resolve` is the resolver
 *  (the environment's, unless a test needs another). */
export function checkCacheDirectory(
  resolve: () => DiskCache = () => resolveDiskCache(),
): ZarrEngineCheck {
  try {
    const cache = resolve();
    if (!cache.enabled) {
      return {
        name: "cache directory",
        ok: true,
        detail: "disk cache is off (NEMAR_ZARR_DISK_CACHE_BYTES=0)",
      };
    }
    const writable = cache.checkWritable();
    return {
      name: "cache directory",
      ok: writable.ok,
      detail: writable.ok ? `${cache.dir} is writable` : `${cache.dir}: ${writable.reason}`,
    };
  } catch (err) {
    if (err instanceof EngineConfigError) {
      return { name: "cache directory", ok: false, detail: err.message };
    }
    dlog(
      `zarr engine cache check: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    return { name: "cache directory", ok: false, detail: CACHE_CHECK_UNEXPECTED };
  }
}
