/**
 * git-annex key size and chunk-aware presence, shared by the CLI
 * (`src/lib/s3-server-copy.ts`) and the Worker
 * (`backend/src/services/import-integrity.ts`).
 *
 * Pure on purpose: no `node:` import, so the Workers bundle can take it. The two
 * callers used to hold hand-kept copies of this logic, which is the drift
 * AGENTS.md warns about; there is one definition now and both re-export it.
 */

/**
 * Declared size (bytes) encoded in a git-annex key, e.g.
 * `SHA256E-s10565888--abc123.edf` -> 10565888. Works for any backend that
 * encodes size this way (SHA256E, MD5E, SHA1E, ...). Returns null for
 * non-annex keys (`git:<sha>`, in-tree git blobs) or anything that doesn't
 * match the pattern, so callers can tell "no declared size" apart from "0
 * bytes claimed" -- load-bearing for the copy-integrity checks, which must not
 * silently accept an empty object as correct.
 */
export function annexKeyDeclaredSize(key: string): number | null {
  const match = key.match(/-s(\d+)--/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * True when `key` is present in `existing` (a key -> byte-size map from the S3
 * listing) at its correct size. An annex key's declared size must match exactly
 * -- a 0-byte or truncated object counts as absent even though the key exists
 * (the #967 bug: a failed curl fallback used to leave a valid-looking 0-byte PUT
 * behind). A non-annex `git:` key has no declared size, so presence alone is
 * sufficient (its bytes live in GitHub, not S3). A key whose content was
 * uploaded through a chunked special remote is present when all of its chunk
 * objects are (see isChunkedKeyPresent).
 */
export function isKeyPresentAtDeclaredSize(key: string, existing: Map<string, number>): boolean {
  const actual = existing.get(key);
  if (actual !== undefined) {
    const declared = annexKeyDeclaredSize(key);
    if (declared === null || actual === declared) return true;
  }
  // Content uploaded through a chunked special remote exists only as chunk
  // objects; it is present when every chunk is (#1565).
  return isChunkedKeyPresent(key, existing);
}

/**
 * git-annex chunk object name -> its whole-file key, chunk size and chunk
 * number. A dataset uploaded with `chunk=1GiB` on its special remote stores
 * `SHA256E-s982-S1073741824-C1--<hash>.vhdr` (C1..Cn) and never the plain
 * `SHA256E-s982--<hash>.vhdr` (nm000276: 3055 of 3089 objects, #1565). The
 * whole-file key is the name with `-S<chunksize>-C<n>` removed. Returns null
 * for anything that is not a chunk name.
 */
export function parseChunkKey(
  name: string,
): { baseKey: string; chunkSize: number; chunkNumber: number } | null {
  const m = name.match(/^(.+?-s\d+(?:-m\d+)?)-S(\d+)-C(\d+)(--.*)$/);
  if (!m) return null;
  const chunkSize = Number.parseInt(m[2], 10);
  const chunkNumber = Number.parseInt(m[3], 10);
  if (!(chunkSize > 0) || !(chunkNumber > 0)) return null;
  return { baseKey: `${m[1]}${m[4]}`, chunkSize, chunkNumber };
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
  const declared = annexKeyDeclaredSize(key);
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
