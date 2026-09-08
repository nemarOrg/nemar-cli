/**
 * Two candidate decode paths for a served array's blosc/zstd/byte-shuffle
 * inner chunks (issue #1293 spike, decision 7 of the phase 1 plan).
 *
 * Both take the RAW bytes of one Zarr v3 `sharding_indexed` inner chunk
 * (what `fixtures/chunk.bin` holds -- a single blosc2 frame; see
 * `fixtures/chunk.expected.json` for the ground truth, captured with a real
 * Python `zstandard` decompress + manual unshuffle and cross-checked against
 * `numcodecs.Blosc().decode()`) and return the decoded `Int16Array`.
 *
 * (a) `numcodecs` JS package's WASM `Blosc` codec -- the library the epic's
 *     research named as the browser-proven path (the nemar.org Zarr viewer
 *     already uses it). Whether its WASM loading works unmodified inside
 *     workerd (no filesystem, no `file://` fetch) is exactly what this spike
 *     settles; see README.md for the result.
 * (b) A from-scratch pure-JS decoder: parse the 16-byte blosc2 chunk header,
 *     read the per-block offset table, strip each block's 4-byte compressed-
 *     length prefix, decompress with `fzstd` (a pure-JS zstd decompressor,
 *     no WASM), and unshuffle. The byte-level format below was reverse-
 *     engineered against this exact fixture (not the general blosc2 spec)
 *     and verified against a real Python decode before being ported here --
 *     see the phase 1 PR description for the verification transcript.
 */

import { decompress as fzstdDecompress } from "fzstd";
import BloscCodec from "numcodecs/blosc";

/** Blosc2 chunk header, byte-for-byte (see the module doc). */
interface BloscHeader {
  version: number;
  versionlz: number;
  flags: number;
  typesize: number;
  nbytes: number;
  blocksize: number;
  cbytes: number;
  doShuffle: boolean;
  doBitShuffle: boolean;
  memcpyed: boolean;
}

function parseBloscHeader(bytes: Uint8Array): BloscHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint8(2);
  return {
    version: view.getUint8(0),
    versionlz: view.getUint8(1),
    flags,
    typesize: view.getUint8(3),
    nbytes: view.getUint32(4, true),
    blocksize: view.getUint32(8, true),
    cbytes: view.getUint32(12, true),
    doShuffle: (flags & 0x1) !== 0,
    doBitShuffle: (flags & 0x4) !== 0,
    memcpyed: (flags & 0x2) !== 0,
  };
}

/** Undo blosc's byte-level shuffle for one block: `shuffled[b*N + j]` is
 *  byte `b` of element `j`; reconstruct `unshuffled[j*T + b]`. Bit-shuffle
 *  (typesize-independent, bit rather than byte granularity) is out of scope
 *  for this spike -- every store this codebase serves uses byte shuffle
 *  (`shuffle: "shuffle"` in every captured `zarr.json`, never `"bitshuffle"`)
 *  and `unshuffleBlock` throws rather than silently mis-decoding one it does
 *  not recognize. */
function unshuffleBlock(shuffled: Uint8Array, typesize: number): Uint8Array {
  const n = shuffled.length / typesize;
  if (!Number.isInteger(n)) {
    throw new Error(
      `decode path (b): block length ${shuffled.length} is not a multiple of typesize ${typesize}`,
    );
  }
  const out = new Uint8Array(shuffled.length);
  for (let b = 0; b < typesize; b++) {
    const rowStart = b * n;
    for (let j = 0; j < n; j++) {
      out[j * typesize + b] = shuffled[rowStart + j];
    }
  }
  return out;
}

/** Path (b): pure JS, no WASM. Parses the blosc2 chunk header, iterates the
 *  per-block offset table, decompresses each block's zstd payload with
 *  `fzstd`, and unshuffles. Throws on a header shape this spike does not
 *  handle (memcpyed frames, bit-shuffle, or a non-zstd `versionlz`) rather
 *  than guessing. */
export function decodePathB(bytes: Uint8Array): Int16Array {
  if (bytes.length < 16) {
    throw new Error(
      `decode path (b): ${bytes.length} bytes is shorter than the 16-byte blosc2 header`,
    );
  }
  const header = parseBloscHeader(bytes);
  if (header.memcpyed) {
    throw new Error("decode path (b): memcpyed (uncompressed) blosc frames are not implemented");
  }
  if (header.doBitShuffle) {
    throw new Error("decode path (b): bit-shuffle is not implemented (only byte shuffle)");
  }
  // Every served level-0 and view array is int16 (typesize 2). A different
  // typesize is a store this decoder was not written for, never something to
  // reinterpret as int16 pairs.
  if (header.typesize !== 2) {
    throw new Error(
      `decode path (b): typesize ${header.typesize} is not int16; refusing to reinterpret`,
    );
  }
  // blosc2 signals a single block with blocksize == nbytes, never 0; a zero
  // here is a corrupt header, and dividing by it would give Infinity blocks.
  if (header.blocksize <= 0 || header.nbytes <= 0) {
    throw new Error(
      `decode path (b): invalid blosc2 header (nbytes ${header.nbytes}, blocksize ${header.blocksize})`,
    );
  }
  if (header.nbytes % header.typesize !== 0) {
    throw new Error(
      `decode path (b): nbytes ${header.nbytes} is not a multiple of typesize ${header.typesize}`,
    );
  }
  if (header.cbytes !== bytes.length) {
    throw new Error(
      `decode path (b): header cbytes ${header.cbytes} disagrees with the ${bytes.length} bytes supplied`,
    );
  }
  const nblocks = Math.ceil(header.nbytes / header.blocksize);
  if (16 + nblocks * 4 > bytes.length) {
    throw new Error(
      `decode path (b): ${nblocks}-entry offset table does not fit in ${bytes.length} bytes`,
    );
  }
  const offsetsView = new DataView(bytes.buffer, bytes.byteOffset + 16, nblocks * 4);
  const offsets: number[] = [];
  for (let i = 0; i < nblocks; i++) offsets.push(offsetsView.getUint32(i * 4, true));

  const out = new Uint8Array(header.nbytes);
  let written = 0;
  for (let i = 0; i < nblocks; i++) {
    const blockStart = offsets[i];
    if (blockStart + 4 > bytes.length) {
      throw new Error(
        `decode path (b): block ${i} offset ${blockStart} is past the end of the chunk`,
      );
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + blockStart, 4);
    const compressedLen = view.getUint32(0, true);
    const payloadStart = blockStart + 4;
    if (compressedLen === 0 || payloadStart + compressedLen > bytes.length) {
      throw new Error(
        `decode path (b): block ${i} claims ${compressedLen} compressed bytes at ${payloadStart}, ` +
          `but the chunk is ${bytes.length} bytes`,
      );
    }
    const payload = bytes.subarray(payloadStart, payloadStart + compressedLen);
    const decompressed = fzstdDecompress(payload);
    const blockNbytes = Math.min(header.blocksize, header.nbytes - written);
    if (decompressed.length !== blockNbytes) {
      throw new Error(
        `decode path (b): block ${i} decompressed to ${decompressed.length} bytes, expected ${blockNbytes}`,
      );
    }
    const unshuffled = header.doShuffle
      ? unshuffleBlock(decompressed, header.typesize)
      : decompressed;
    out.set(unshuffled, written);
    written += blockNbytes;
  }

  return asInt16("(b)", out);
}

/** `new Int16Array(buf, off, byteLength / 2)` silently floors an odd byte
 *  count and drops the last sample; refuse instead. */
function asInt16(path: string, bytes: Uint8Array): Int16Array {
  if (bytes.byteLength % 2 !== 0) {
    throw new Error(
      `decode path ${path}: decoded ${bytes.byteLength} bytes, not a whole number of int16`,
    );
  }
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

/** Path (a): the `numcodecs` JS package's WASM `Blosc` codec, called exactly
 *  as the phase 1 plan's verified facts describe (`FetchStore` + a runtime
 *  import of `numcodecs/blosc`). No manual header parsing -- the codec is
 *  handed the raw chunk bytes and asked to decode the whole blosc2 frame
 *  itself, same as `numcodecs.Blosc().decode()` did on the Python side that
 *  produced `fixtures/chunk.expected.json`. */
export async function decodePathA(bytes: Uint8Array): Promise<Int16Array> {
  const codec = BloscCodec.fromConfig({
    id: "blosc",
    clevel: 5,
    cname: "zstd",
    shuffle: 1,
    blocksize: 0,
  });
  const decoded = await codec.decode(bytes);
  return asInt16("(a)", decoded);
}
