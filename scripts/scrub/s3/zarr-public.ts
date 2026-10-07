/**
 * `zarr-public`: the runbook's check from outside (step 16) that the Zarr serving copy of a
 * dataset that is public again carries no identifier.
 *
 * It reads as an anonymous reader does, with no credentials: the dataset's `zarr/index.json`, then
 * the root `zarr.json` of every store in the UNION of the stores the index names and the stores the
 * zarr stage proved (`zarr-verified.json`, which it wrote from a credentialed listing of the whole
 * prefix). Of each it asks the SAME questions the zarr stage asked before it wrote its proof,
 * through the same functions (`zarrIdentifierCount` and `unknownRecordingMembers` in
 * `zarr-json.ts`, with the members the operator accepted then): how many members are scanner
 * identifiers or mirrored EDF identification fields, and does the recording metadata hold a name
 * no list accounts for. Zero and none, for every store, is the only pass.
 *
 * Why the union: the index is what readers follow, but it can be stale; a store the zarr stage
 * proved that the index does not name is refused (`store-not-in-index`), because the public surface
 * and the proof disagree about what exists. And a check that read no store proves nothing: an
 * empty union is refused unless the proof itself says the dataset has no Zarr copy (`no-zarr`).
 *
 * Nothing printed is a value: counts and fixed words only, never a store path.
 */

import { readFile } from "node:fs/promises";
import { isStorePath, parseZarrVerified } from "../contract";
import { EXIT, StageError, countWords, formatWordCounts, runPool } from "./s3-lib";
import { checkDataset, parseFile, publicObjectUrl } from "./s3-stages";
import {
  MAX_ZARR_JSON_BYTES,
  ZarrJsonError,
  parseZarrJsonBytes,
  unknownRecordingMembers,
  zarrIdentifierCount,
} from "./zarr-json";

export interface ZarrPublicOptions {
  dataset: string;
  /** The zarr stage's proof, `zarr-verified.json`: the stores it proved and the members accepted. */
  zarrVerifiedFile: string;
  /** Where an anonymous reader reaches the bucket. No credentials are ever sent to it. */
  publicBase: string;
  timeoutMs: number;
  concurrency: number;
  log: (line: string) => void;
}

/** An index.json is large for a big dataset (12.8 MB was measured); anything past this is not one. */
const MAX_INDEX_BYTES = 64 * 1024 * 1024;

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
  let proofText: string;
  try {
    proofText = await readFile(o.zarrVerifiedFile, "utf8");
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
    throw new StageError(
      missing ? "zarr-verified.json-missing" : "zarr-verified.json-unreadable",
      missing ? EXIT.refused : EXIT.failed,
    );
  }
  const proof = parseFile("zarr-verified.json", parseZarrVerified, proofText);
  if (proof.dataset !== o.dataset) {
    throw new StageError("zarr-verified-wrong-dataset", EXIT.refused);
  }
  const allowed = new Set(proof.allowedMembers);
  const url = (key: string) => publicObjectUrl(o.publicBase, key);

  const index = await anonymousGet(
    url(`${o.dataset}/zarr/index.json`),
    o.timeoutMs,
    MAX_INDEX_BYTES,
  );
  let indexed: string[] = [];
  if (index.status === 200 && index.bytes) {
    try {
      const doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(index.bytes)) as {
        stores?: unknown;
      };
      if (!Array.isArray(doc.stores)) throw new Error("no stores");
      indexed = doc.stores.map((s) => (s as { zarr?: unknown } | null)?.zarr) as string[];
      if (!indexed.every(isStorePath)) throw new Error("bad store path");
    } catch {
      throw new StageError("index-malformed", EXIT.unreadable);
    }
  } else if (proof.found !== "no-zarr") {
    // 403 is what a private dataset, and a dataset with no Zarr copy, both answer.
    o.log(`zarr-public: index.json answered ${index.status}`);
    throw new StageError("index-unreadable", EXIT.unreadable);
  }

  // A store the zarr stage proved and the index does not name: the two disagree about what exists.
  const inIndex = new Set(indexed);
  const notIndexed = proof.stores.filter((s) => !inIndex.has(s)).length;
  if (notIndexed > 0) {
    o.log(`zarr-public: ${notIndexed} store(s) the zarr stage proved are not in index.json`);
    throw new StageError("store-not-in-index", EXIT.refused);
  }
  const stores = [...new Set([...indexed, ...proof.stores])].sort();
  if (stores.length === 0) {
    if (proof.found === "no-zarr") {
      o.log("zarr-public: ok; the zarr stage found no Zarr copy and the index names no store");
      return 0;
    }
    throw new StageError("no-store-checked", EXIT.refused);
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
    if (zarrIdentifierCount(doc) > 0) return "identifier-found";
    if (unknownRecordingMembers(doc, allowed).length > 0) return "unknown-recording-member";
    return "clean";
  });
  const words = outcomes as string[];
  const clean = words.filter((w) => w === "clean").length;
  const found = words.filter((w) => w === "identifier-found").length;
  const unknown = words.filter((w) => w === "unknown-recording-member").length;
  const unreadable = words.length - clean - found - unknown;
  o.log(
    `zarr-public: stores=${words.length} clean=${clean} identifier=${found} unknownMembers=${unknown} unreadable=${unreadable}`,
  );
  const notClean = words.filter((w) => w !== "clean");
  if (notClean.length > 0)
    o.log(`zarr-public: not clean, by reason: ${formatWordCounts(countWords(notClean))}`);
  if (found > 0 || unknown > 0) return EXIT.failed;
  if (unreadable > 0) return EXIT.unreadable;
  return 0;
}
