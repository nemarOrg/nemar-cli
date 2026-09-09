/**
 * Pure Zarr v3 `sharding_indexed` planning for `read_window` taste mode
 * (epic #1065 phase 4, issue #1296).
 *
 * Level 0 of every served store is a SHARDED array: shape `[n_channels,
 * n_samples]`, outer chunk (the "shard") `[n_channels, shard_samples]`,
 * inner chunk (the codec's own `sharding_indexed.configuration.chunk_shape`)
 * `[n_channels, chunk_samples]`, `index_location: "end"`. Verified live on
 * nm000329's `eeg_250hz` (shard 75000, chunk 1000) and on003392's `meg_250hz`
 * (shard 68000, chunk 1000) -- see `test/fixtures/zarr-array-level0.zarr.json`
 * and `backend/test/fixtures/mcp/nm000329-shard-index-c-0-0.bin` (the REAL
 * captured footer, 75 entries, offsets chaining contiguously from 0,
 * `sum(nbytes) + 1204 == 8_970_760`, the shard's own `Content-Length`).
 *
 * An inner chunk always spans every channel, so the chunk grid is always
 * `1 x ceil(n_samples / shard_samples)` and a shard's object key is always
 * `<zarr>/<group>/0/c/0/<j>` -- a taste of one channel still decodes every
 * channel of every inner chunk the window spans. Cost is driven by DURATION
 * (how many inner chunks) and the store's own channel count, never by how
 * many channels the caller asked for.
 *
 * The shard footer is the last `n_inner * 16 + 4` bytes: `n_inner` pairs of
 * little-endian uint64 `(offset, nbytes)` (each pair's `offset` is a byte
 * offset INTO THE SHARD OBJECT, so entries chain contiguously from 0 for a
 * shard with no absent chunk) plus a trailing crc32c word -- this module
 * never verifies that checksum, only strips it. An absent inner chunk is
 * marked `2^64 - 1` in BOTH fields (`SHARD_ABSENT_MARKER`) and contributes no
 * bytes to the shard at all -- the byte offsets of the entries around it
 * simply do not advance for it.
 *
 * Both the shard (outer) grid and the inner-chunk grid are Zarr's ordinary
 * "last chunk may be shorter" regular grid: the LAST shard of an array (or
 * the last inner chunk of the last shard) is truncated to fit the array's
 * actual extent rather than padded, so `nInnerForShard` computes a smaller
 * entry count for a boundary shard, and this module's callers must expect a
 * correspondingly shorter decoded sample count for a boundary inner chunk
 * (the blosc frame's own header carries its true `nbytes`, so
 * `decodeBloscZstdInt16` already returns the right length; nothing here
 * assumes every inner chunk decodes to a full `chunk_samples`).
 *
 * No I/O in this file -- `read-window.ts` does the fetching and decoding;
 * this file only computes which shards, which local chunk indices, and
 * which byte ranges to ask for.
 */

/** Both fields of an absent inner-chunk footer entry, per the Zarr v3
 *  `sharding_indexed` spec. `Number(SHARD_ABSENT_MARKER)` would lose
 *  precision (2^64 - 1 is far past `Number.MAX_SAFE_INTEGER`), so the
 *  comparison against a parsed `bigint` stays a `bigint` comparison; nothing
 *  downstream of {@link parseShardFooter} ever sees this value as a Number. */
export const SHARD_ABSENT_MARKER = 0xffffffffffffffffn;

export interface ShardIndexEntry {
  /** Byte offset into the shard object. `0` (meaningless) for an absent
   *  entry -- check `present` first. */
  offset: number;
  /** Compressed byte length of this inner chunk. `0` for an absent entry. */
  nbytes: number;
  present: boolean;
}

/** `n_inner * 16 + 4`: `n_inner` `(offset, nbytes)` uint64 pairs (16 bytes
 *  each) plus the trailing crc32c word. */
export function footerByteLength(nInner: number): number {
  if (!Number.isInteger(nInner) || nInner < 1) {
    throw new Error(`footerByteLength: nInner must be a positive integer, got ${nInner}`);
  }
  return nInner * 16 + 4;
}

/** How many inner-chunk entries a shard's OWN footer carries -- the
 *  boundary (last) shard of an array is truncated to the array's actual
 *  remaining extent, so its inner-chunk grid is over a SHORTER span than a
 *  full `shard_samples`, per the module doc's "last chunk may be shorter"
 *  paragraph. */
export function nInnerForShard(opts: {
  shardIndex: number;
  shardSamples: number;
  chunkSamples: number;
  nSamples: number;
}): number {
  const { shardIndex, shardSamples, chunkSamples, nSamples } = opts;
  const shardStart = shardIndex * shardSamples;
  const remaining = Math.min(shardSamples, nSamples - shardStart);
  if (remaining <= 0) {
    throw new Error(
      `nInnerForShard: shardIndex ${shardIndex} starts at or past nSamples ${nSamples} (shardSamples ${shardSamples})`,
    );
  }
  return Math.ceil(remaining / chunkSamples);
}

/**
 * Parse a shard's footer bytes (exactly {@link footerByteLength}`(nInner)`
 * long -- the tail of the shard object) into `nInner` entries in local
 * chunk-index order. The trailing 4-byte crc32c word is stripped, never
 * verified (per the module doc).
 */
export function parseShardFooter(bytes: Uint8Array, nInner: number): ShardIndexEntry[] {
  const expected = footerByteLength(nInner);
  if (bytes.length !== expected) {
    throw new Error(
      `parseShardFooter: expected exactly ${expected} bytes for nInner ${nInner}, got ${bytes.length}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: ShardIndexEntry[] = [];
  for (let i = 0; i < nInner; i++) {
    const offsetBig = view.getBigUint64(i * 16, true);
    const nbytesBig = view.getBigUint64(i * 16 + 8, true);
    const present = offsetBig !== SHARD_ABSENT_MARKER && nbytesBig !== SHARD_ABSENT_MARKER;
    entries.push({
      offset: present ? Number(offsetBig) : 0,
      nbytes: present ? Number(nbytesBig) : 0,
      present,
    });
  }
  return entries;
}

/** Which shard (outer chunk) indices `[startSample, endSampleExclusive)`
 *  spans, ascending. Half-open: a window ending exactly on a shard boundary
 *  never includes the next shard. */
export function shardsForWindow(
  startSample: number,
  endSampleExclusive: number,
  shardSamples: number,
): number[] {
  if (endSampleExclusive <= startSample) return [];
  const first = Math.floor(startSample / shardSamples);
  const last = Math.floor((endSampleExclusive - 1) / shardSamples);
  const out: number[] = [];
  for (let j = first; j <= last; j++) out.push(j);
  return out;
}

/** Which LOCAL inner-chunk indices (0-based within one shard) a window
 *  intersects, ascending. Half-open on both the window and each candidate
 *  chunk's own nominal span, so a window ending exactly on a chunk boundary
 *  never pulls in the next chunk. */
export function innerIndicesForWindowInShard(opts: {
  shardIndex: number;
  shardSamples: number;
  chunkSamples: number;
  nInnerThisShard: number;
  startSample: number;
  endSampleExclusive: number;
}): number[] {
  const {
    shardIndex,
    shardSamples,
    chunkSamples,
    nInnerThisShard,
    startSample,
    endSampleExclusive,
  } = opts;
  const shardStart = shardIndex * shardSamples;
  const out: number[] = [];
  for (let local = 0; local < nInnerThisShard; local++) {
    const chunkStart = shardStart + local * chunkSamples;
    const chunkEnd = chunkStart + chunkSamples; // nominal; fine even when truncated, see module doc
    if (chunkStart < endSampleExclusive && chunkEnd > startSample) out.push(local);
  }
  return out;
}

/** The exact sample span (global, half-open) one local inner-chunk index
 *  covers, truncated at the array's actual `nSamples` and at the shard's own
 *  boundary -- correct for a mid-array absent chunk (full `chunkSamples`
 *  long) and a boundary/truncated chunk alike, without depending on any
 *  decoded byte length (the absent case has none). */
export function chunkSampleSpan(opts: {
  shardIndex: number;
  localIndex: number;
  shardSamples: number;
  chunkSamples: number;
  nSamples: number;
}): { start: number; end: number } {
  const { shardIndex, localIndex, shardSamples, chunkSamples, nSamples } = opts;
  const shardStart = shardIndex * shardSamples;
  const shardEnd = Math.min(nSamples, shardStart + shardSamples);
  const start = shardStart + localIndex * chunkSamples;
  const end = Math.min(shardEnd, start + chunkSamples);
  return { start, end };
}

export interface ChunkRead {
  kind: "range" | "absent";
  /** Local chunk indices covered, ascending, contiguous by index. */
  localIndices: number[];
  /** Byte range within the shard object, inclusive end -- only for `"range"`. */
  start?: number;
  end?: number;
}

/**
 * Coalesce a shard's wanted local chunk indices into the fewest HTTP Range
 * reads: a run of indices that are both index-consecutive AND byte-adjacent
 * (`entries[i].offset + entries[i].nbytes === entries[i + 1].offset`)
 * becomes one `"range"` read; an absent entry is always its own `"absent"`
 * read (no bytes to fetch) and breaks any run around it. `wantedLocalIndices`
 * need not be sorted or deduplicated.
 */
export function planShardReads(
  entries: ShardIndexEntry[],
  wantedLocalIndices: number[],
): ChunkRead[] {
  const wanted = Array.from(new Set(wantedLocalIndices)).sort((a, b) => a - b);
  const reads: ChunkRead[] = [];
  let i = 0;
  while (i < wanted.length) {
    const idx = wanted[i];
    const entry = entries[idx];
    if (!entry) {
      throw new Error(
        `planShardReads: local index ${idx} has no footer entry (${entries.length} parsed)`,
      );
    }
    if (!entry.present) {
      reads.push({ kind: "absent", localIndices: [idx] });
      i++;
      continue;
    }
    const runIndices = [idx];
    const runStart = entry.offset;
    let runEnd = entry.offset + entry.nbytes; // exclusive
    let j = i + 1;
    while (j < wanted.length) {
      const nextIdx = wanted[j];
      const nextEntry = entries[nextIdx];
      if (nextIdx !== wanted[j - 1] + 1 || !nextEntry?.present || nextEntry.offset !== runEnd)
        break;
      runIndices.push(nextIdx);
      runEnd = nextEntry.offset + nextEntry.nbytes;
      j++;
    }
    reads.push({ kind: "range", localIndices: runIndices, start: runStart, end: runEnd - 1 });
    i = j;
  }
  return reads;
}

// ---------------------------------------------------------------------------
// Cache serialization for the `shardidx/<zarr>/<group>/0/<j>` projection kind
// (`read-window.ts`) -- a compact `[offset, nbytes]` pair per entry, `[-1,
// -1]` for an absent one (real offsets/nbytes are always non-negative, so
// this sentinel is unambiguous).
// ---------------------------------------------------------------------------

export function shardEntriesToPairs(entries: ShardIndexEntry[]): Array<[number, number]> {
  return entries.map((e) => (e.present ? [e.offset, e.nbytes] : [-1, -1]));
}

export function shardEntriesFromPairs(pairs: Array<[number, number]>): ShardIndexEntry[] {
  return pairs.map(([offset, nbytes]) =>
    offset === -1 && nbytes === -1
      ? { offset: 0, nbytes: 0, present: false }
      : { offset, nbytes, present: true },
  );
}
