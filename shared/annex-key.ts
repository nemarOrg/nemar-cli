/**
 * git-annex key size and chunk-aware presence, shared by the CLI
 * (`src/lib/s3-server-copy.ts`) and the Worker
 * (`backend/src/services/import-integrity.ts`).
 *
 * Pure on purpose: no `node:` import, so the Workers bundle can take it. The two
 * callers used to hold hand-kept copies of this logic, which is the drift
 * AGENTS.md warns about; there is one definition now and both re-export it.
 *
 * KEY GRAMMAR. A key is `<fields>--<name>`, split at the FIRST `--`:
 *
 *   fields = BACKEND[-s<size>][-m<mtime>][-S<chunksize>-C<chunknumber>]
 *
 * A special remote configured with `chunk=<size>` stores each piece of a file as
 * `<fields>-S<chunksize>-C<n>--<name>` (n counts from 1) and never the plain key.
 * `scripts/zarr/generate_zarr.py` is the other implementation of this grammar
 * (`annex_key_size`, `annex_chunk_key`, `annex_chunk_sizes`, `_complete_chunk_size`)
 * and reads it the same way: everything is taken from the fields before the first
 * `--`, because the name after it is free text for a WORM or URL key. Keep the
 * two consistent.
 */

/** The fields and name of a key, split at the first `--`; null when there is none. */
function splitKey(key: string): { fields: string; name: string } | null {
  const sep = key.indexOf("--");
  if (sep < 0) return null;
  return { fields: key.slice(0, sep), name: key.slice(sep + 2) };
}

/**
 * Declared size (bytes) encoded in a git-annex key, e.g.
 * `SHA256E-s10565888--abc123.edf` -> 10565888. Works for any backend that
 * encodes size this way (SHA256E, MD5E, SHA1E, ...). Returns null for
 * non-annex keys (`git:<sha>`, in-tree git blobs) or anything that doesn't
 * match the pattern, so callers can tell "no declared size" apart from "0
 * bytes claimed" -- load-bearing for the copy-integrity checks, which must not
 * silently accept an empty object as correct.
 *
 * This is the historical contract for a PLAIN key and is deliberately unchanged:
 * a key with an `-m<mtime>` field (`WORM-s5-m17--x`) returns null here, so a
 * plain WORM object stays present-if-listed. The chunk path uses
 * {@link annexKeyFieldSize}, which reads past `-m`.
 */
export function annexKeyDeclaredSize(key: string): number | null {
  const match = key.match(/-s(\d+)--/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * The `-s<size>` field of a key, read from the fields before the first `--` and
 * tolerant of a following `-m<mtime>` (`WORM-s5-m17--x` -> 5). The twin of
 * `annex_key_size` in `scripts/zarr/generate_zarr.py`. Null when the key has no
 * `--` or no size field. Used for chunk geometry, where the size has to be known
 * to know how many chunks to expect.
 */
export function annexKeyFieldSize(key: string): number | null {
  const parts = splitKey(key);
  if (!parts) return null;
  const match = parts.fields.match(/-s(\d+)(?=-|$)/);
  if (!match) return null;
  const size = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(size) ? size : null;
}

/**
 * True when `key` is present in `existing` (a key -> byte-size map from the S3
 * listing) at its correct size.
 *
 * A plain object decides the answer whenever it exists: an annex key's declared
 * size must match exactly, so a 0-byte or truncated object counts as absent even
 * though the key exists (the #967 bug: a failed curl fallback used to leave a
 * valid-looking 0-byte PUT behind). A non-annex `git:` key has no declared size,
 * so presence alone is sufficient (its bytes live in GitHub, not S3).
 *
 * Chunks are consulted ONLY when the plain object is ABSENT, for content uploaded
 * through a chunked special remote (nm000276, #1565): present when a chunking of
 * it is complete (see isChunkedKeyPresent). A truncated plain object beside a
 * complete chunk set stays missing. The data plane serves the plain key, so that
 * combination is the #967 signature, and reading it as present would be worse
 * than reading it as absent: the listing would say complete while the served
 * object is short.
 */
export function isKeyPresentAtDeclaredSize(key: string, existing: Map<string, number>): boolean {
  const actual = existing.get(key);
  if (actual !== undefined) {
    const declared = annexKeyDeclaredSize(key);
    return declared === null || actual === declared;
  }
  return isChunkedKeyPresent(key, existing);
}

/** A chunk object name split into the whole-file key it belongs to. */
export interface ParsedChunkKey {
  baseKey: string;
  chunkSize: number;
  chunkNumber: number;
}

/**
 * Chunk object name -> its whole-file key, chunk size and chunk number.
 * `SHA256E-s982-S1073741824-C1--ba3d.vhdr` -> base `SHA256E-s982--ba3d.vhdr`,
 * chunk size 1073741824, chunk 1 (nm000276: 3055 of 3089 objects, #1565). The
 * `-S<chunksize>-C<n>` pair must be the LAST thing in the fields, before the
 * first `--`, as the special remote writes it; the same text inside the free-text
 * name is not a chunk. Returns null for anything that is not a chunk name,
 * including a zero or unsafe-integer size or number.
 */
export function parseChunkKey(name: string): ParsedChunkKey | null {
  const parts = splitKey(name);
  if (!parts) return null;
  const match = parts.fields.match(/^(.+)-S(\d+)-C(\d+)$/);
  if (!match) return null;
  const chunkSize = Number.parseInt(match[2], 10);
  const chunkNumber = Number.parseInt(match[3], 10);
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) return null;
  if (!Number.isSafeInteger(chunkNumber) || chunkNumber < 1) return null;
  return { baseKey: `${match[1]}--${parts.name}`, chunkSize, chunkNumber };
}

/** baseKey -> chunkSize -> chunkNumber -> object size, built once per listing. */
type ChunkIndex = Map<string, Map<number, Map<number, number>>>;
const chunkIndexCache = new WeakMap<Map<string, number>, { size: number; index: ChunkIndex }>();

function chunkIndexFor(existing: Map<string, number>): ChunkIndex {
  const cached = chunkIndexCache.get(existing);
  if (cached && cached.size === existing.size) return cached.index;
  const index: ChunkIndex = new Map();
  for (const [name, size] of existing) {
    const parsed = parseChunkKey(name);
    if (!parsed) continue;
    let bySize = index.get(parsed.baseKey);
    if (!bySize) {
      bySize = new Map();
      index.set(parsed.baseKey, bySize);
    }
    let chunks = bySize.get(parsed.chunkSize);
    if (!chunks) {
      chunks = new Map();
      bySize.set(parsed.chunkSize, chunks);
    }
    chunks.set(parsed.chunkNumber, size);
  }
  chunkIndexCache.set(existing, { size: existing.size, index });
  return index;
}

/**
 * True when every chunk of `key` is in `existing` at the size chunking gives
 * it: chunks 1..n-1 at the chunk size, the last one at the remainder (one
 * chunk for an empty file). A missing or short chunk means the file cannot be
 * reassembled, so it counts as absent. Exported for unit tests.
 */
export function isChunkedKeyPresent(key: string, existing: Map<string, number>): boolean {
  const declared = annexKeyFieldSize(key);
  if (declared === null) return false;
  const bySize = chunkIndexFor(existing).get(key);
  if (!bySize) return false;
  for (const [chunkSize, chunks] of bySize) {
    const n = declared === 0 ? 1 : Math.ceil(declared / chunkSize);
    let complete = true;
    for (let i = 1; i <= n; i++) {
      const expected = i < n ? chunkSize : declared - (n - 1) * chunkSize;
      if (chunks.get(i) !== expected) {
        complete = false;
        break;
      }
    }
    if (complete) return true;
  }
  return false;
}
