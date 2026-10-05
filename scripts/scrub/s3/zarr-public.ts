/**
 * `zarr-public`: the runbook's check from outside (step 16) that the Zarr serving copy of a
 * dataset that is public again carries no identifier.
 *
 * It reads as an anonymous reader does, with no credentials: the dataset's `zarr/index.json`, then
 * the root `zarr.json` of every store the index names, and asks of each the SAME question the zarr
 * stage asked before it wrote its proof, through the same function (`zarrIdentifierCount` in
 * `zarr-json.ts`): how many members are scanner identifiers or mirrored EDF identification
 * fields. Zero for every store is the only pass.
 *
 * The index is what readers follow, so it is what this check follows; the zarr stage, which lists
 * the prefix with admin credentials, is the one that covers every store root that exists.
 *
 * Nothing printed is a value: counts and fixed words only, never a store path.
 */

import { EXIT, StageError, countWords, formatWordCounts, runPool } from "./s3-lib";
import { checkDataset } from "./s3-stages";
import {
  MAX_ZARR_JSON_BYTES,
  ZarrJsonError,
  parseZarrJsonBytes,
  zarrIdentifierCount,
} from "./zarr-json";

export interface ZarrPublicOptions {
  dataset: string;
  /** Where an anonymous reader reaches the bucket. No credentials are ever sent to it. */
  publicBase: string;
  timeoutMs: number;
  concurrency: number;
  log: (line: string) => void;
}

/** An index.json is large for a big dataset (12.8 MB was measured); anything past this is not one. */
const MAX_INDEX_BYTES = 64 * 1024 * 1024;

/** A store path as the index names it: relative, no empty or dot segment, ending `.zarr`. */
function isStorePath(p: unknown): p is string {
  if (typeof p !== "string" || !p.endsWith(".zarr")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

type Fetched = { status: number; bytes?: Uint8Array };

/** One anonymous GET. A redirect is an answer, not something to follow; no answer is status 0. */
async function anonymousGet(url: string, timeoutMs: number, limit: number): Promise<Fetched> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return { status: res.status };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > limit) return { status: -1 };
    return { status: 200, bytes };
  } catch {
    return { status: 0 };
  }
}

export async function zarrPublicStage(o: ZarrPublicOptions): Promise<number> {
  checkDataset(o.dataset);
  const base = o.publicBase.replace(/\/+$/, "");
  const url = (key: string) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;

  const index = await anonymousGet(
    url(`${o.dataset}/zarr/index.json`),
    o.timeoutMs,
    MAX_INDEX_BYTES,
  );
  if (index.status !== 200 || !index.bytes) {
    // 403 is what a private dataset, and a dataset with no Zarr copy, both answer.
    o.log(`zarr-public: index.json answered ${index.status}`);
    throw new StageError("index-unreadable", EXIT.unreadable);
  }
  let stores: string[];
  try {
    const doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(index.bytes)) as {
      stores?: unknown;
    };
    if (!Array.isArray(doc.stores)) throw new Error("no stores");
    stores = doc.stores.map((s) => (s as { zarr?: unknown } | null)?.zarr) as string[];
    if (!stores.every(isStorePath)) throw new Error("bad store path");
  } catch {
    throw new StageError("index-malformed", EXIT.unreadable);
  }

  const outcomes = await runPool(stores, o.concurrency, async (store): Promise<string> => {
    const got = await anonymousGet(
      url(`${o.dataset}/zarr/${store}/zarr.json`),
      o.timeoutMs,
      MAX_ZARR_JSON_BYTES,
    );
    if (got.status !== 200 || !got.bytes) return `http-${got.status}`;
    let doc: unknown;
    try {
      doc = parseZarrJsonBytes(got.bytes).doc;
    } catch (err) {
      if (err instanceof ZarrJsonError) return err.word;
      throw err;
    }
    return zarrIdentifierCount(doc) === 0 ? "clean" : "identifier-found";
  });
  const words = outcomes as string[];
  const clean = words.filter((w) => w === "clean").length;
  const found = words.filter((w) => w === "identifier-found").length;
  const unreadable = words.length - clean - found;
  o.log(
    `zarr-public: stores=${words.length} clean=${clean} identifier=${found} unreadable=${unreadable}`,
  );
  const notClean = words.filter((w) => w !== "clean");
  if (notClean.length > 0)
    o.log(`zarr-public: not clean, by reason: ${formatWordCounts(countWords(notClean))}`);
  if (found > 0) return EXIT.failed;
  if (unreadable > 0) return EXIT.unreadable;
  return 0;
}
