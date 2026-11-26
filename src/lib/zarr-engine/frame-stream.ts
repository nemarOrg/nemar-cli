/**
 * Incremental frame reading and backpressured frame writing for the Zarr engine's stdio.
 *
 * `shared/zarr/protocol-frame.ts` decodes ONE complete frame. A pipe delivers bytes in
 * arbitrary pieces, so {@link FrameReader} collects them: the 8-byte prefix, then
 * `header_len` bytes of header, then the `payload_bytes` the header declares, and hands
 * the assembled bytes to `decodeFrame`, which stays the only decoder. The reader only
 * decides where a frame ends, which is the one thing the codec cannot know from a stream.
 *
 * What the reader does after a bad frame depends on whether it still knows where the next
 * frame starts:
 *
 *   - `invalid` (recoverable): the prefix was intact, so the frame's extent is known and
 *     it has been consumed. The header is not a JSON object, or `payload_bytes` is not
 *     a non-negative integer (the extent is then taken as header only). The engine
 *     answers `invalid_message` with `id: null` and keeps reading.
 *   - `fatal` (not recoverable): bad magic, a `header_len` past the limit, an unpadded
 *     prefix, a payload longer than a request may carry, or end of input inside a frame.
 *     Nothing says where the next frame begins, so the reader stops for good and the
 *     engine answers once and exits.
 *
 * Requests carry no payload (`payload_bytes` is 0 on every request), so a request payload
 * past {@link MAX_REQUEST_PAYLOAD_BYTES} is fatal rather than read into memory; a smaller
 * one is read and handed on, where message validation refuses it as `invalid_message`.
 *
 * Pure TypeScript apart from {@link writeFrame}'s sink type; no `bun:` import.
 */

import {
  FRAME_MAGIC,
  FRAME_PREFIX_BYTES,
  FrameError,
  type FrameErrorKind,
  MAX_HEADER_BYTES,
  decodeFrame,
} from "../../../shared/zarr/protocol-frame.js";

/** The most payload a request frame may declare before the reader gives up on the stream.
 *  A request has none (the protocol fixes `payload_bytes` at 0); this only bounds how much
 *  a misbehaving client can make the engine buffer. */
export const MAX_REQUEST_PAYLOAD_BYTES = 1024 * 1024;

/** The largest reply payload the engine's client reads (1 GiB). The engine refuses a
 *  `NEMAR_ZARR_MAX_PAYLOAD_BYTES` above it as a configuration error, so a window the engine
 *  would send always fits, and one that is too big is `too_large`, never a framing failure. */
export const MAX_CLIENT_PAYLOAD_BYTES = 1 << 30;

export type StreamErrorKind = FrameErrorKind | "payload_too_large";

export type FrameEvent =
  | { type: "frame"; header: Record<string, unknown>; payload: Uint8Array }
  | { type: "invalid"; kind: FrameErrorKind; message: string }
  | { type: "fatal"; kind: StreamErrorKind; message: string };

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The `payload_bytes` a header declares, or null when it cannot be read as a frame
 *  extent (bad JSON, not an object, not a non-negative integer). */
function peekPayloadBytes(headerBytes: Uint8Array): number | null {
  try {
    const header: unknown = JSON.parse(decoder.decode(headerBytes));
    if (typeof header !== "object" || header === null || Array.isArray(header)) return null;
    const n = (header as Record<string, unknown>).payload_bytes;
    if (n === undefined) return 0;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export interface FrameReaderOptions {
  /** The largest payload a frame may declare before the reader stops. The engine reads
   *  requests and keeps the default; a client reading windows passes a larger one. */
  maxPayloadBytes?: number;
}

export class FrameReader {
  /** The bytes not yet consumed, as the pieces they arrived in. Only the front of a frame
   *  (prefix and header) is ever joined while it is incomplete; a payload is joined once, when
   *  the whole frame has arrived, so feeding a large frame costs linear, not quadratic, copying. */
  private chunks: Uint8Array[] = [];
  private length = 0;
  /** The end of the frame at the front, once its header has been read; null before. */
  private frameEnd: number | null = null;
  private stopped = false;
  private readonly maxPayloadBytes: number;

  constructor(options: FrameReaderOptions = {}) {
    this.maxPayloadBytes = options.maxPayloadBytes ?? MAX_REQUEST_PAYLOAD_BYTES;
  }

  /** Feed bytes; returns every event they complete, in order. After a `fatal` event the
   *  reader ignores further input. */
  push(chunk: Uint8Array): FrameEvent[] {
    if (this.stopped || chunk.length === 0) return [];
    this.chunks.push(chunk);
    this.length += chunk.length;
    const events: FrameEvent[] = [];
    for (;;) {
      const event = this.next();
      if (event === null) break;
      events.push(event);
      if (event.type === "fatal") break;
    }
    return events;
  }

  /** Signal end of input. Bytes left over mean a frame was cut off, which is `fatal`;
   *  an empty buffer is a clean end and yields nothing. */
  end(): FrameEvent[] {
    if (this.stopped || this.length === 0) return [];
    this.stopped = true;
    return [
      {
        type: "fatal",
        kind: "truncated",
        message: `input ended inside a frame (${this.length} bytes buffered)`,
      },
    ];
  }

  private fatal(kind: StreamErrorKind, message: string): FrameEvent {
    this.stopped = true;
    this.chunks = [];
    this.length = 0;
    this.frameEnd = null;
    return { type: "fatal", kind, message };
  }

  /** The first `n` buffered bytes (n <= length) as one array, joining the leading pieces into
   *  one when they are split, so a later call for as many bytes or fewer copies nothing. */
  private front(n: number): Uint8Array {
    if (n === 0) return new Uint8Array(0);
    const first = this.chunks[0];
    if (first !== undefined && first.length >= n) return first.subarray(0, n);
    let covered = 0;
    let count = 0;
    while (covered < n) covered += this.chunks[count++].length;
    const joined = new Uint8Array(covered);
    let at = 0;
    for (let i = 0; i < count; i++) {
      joined.set(this.chunks[i], at);
      at += this.chunks[i].length;
    }
    this.chunks.splice(0, count, joined);
    return joined.subarray(0, n);
  }

  /** Drop the first `n` buffered bytes (the caller has read them with {@link front}). */
  private consume(n: number): void {
    const first = this.chunks[0];
    if (first.length === n) this.chunks.shift();
    else this.chunks[0] = first.subarray(n);
    this.length -= n;
  }

  /** The next event the buffered bytes complete, or null when more bytes are needed. */
  private next(): FrameEvent | null {
    if (this.frameEnd === null) {
      // Bad magic is decided as soon as the bytes that disagree are here, so a client that
      // sends a wrong prefix and waits is answered at once.
      const magic = this.front(Math.min(this.length, 4));
      for (let i = 0; i < magic.length; i++) {
        if (magic[i] !== FRAME_MAGIC.charCodeAt(i)) {
          return this.fatal("bad_magic", "frame does not start with NZE0");
        }
      }
      if (this.length < FRAME_PREFIX_BYTES) return null;
      const prefix = this.front(FRAME_PREFIX_BYTES);
      const headerLen = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(
        4,
        true,
      );
      if (headerLen > MAX_HEADER_BYTES) {
        return this.fatal(
          "header_too_large",
          `header_len ${headerLen} exceeds ${MAX_HEADER_BYTES}`,
        );
      }
      if ((FRAME_PREFIX_BYTES + headerLen) % 8 !== 0) {
        return this.fatal("unpadded", `8 + header_len (${headerLen}) is not a multiple of 8`);
      }
      const payloadStart = FRAME_PREFIX_BYTES + headerLen;
      if (this.length < payloadStart) return null;

      const declared = peekPayloadBytes(this.front(payloadStart).subarray(FRAME_PREFIX_BYTES));
      if (declared !== null && declared > this.maxPayloadBytes) {
        return this.fatal(
          "payload_too_large",
          `payload_bytes ${declared} exceeds the ${this.maxPayloadBytes} a frame may carry here`,
        );
      }
      this.frameEnd = payloadStart + (declared ?? 0);
    }
    const frameEnd = this.frameEnd;
    if (this.length < frameEnd) return null;

    // The whole frame is here: one join (at most) and the codec decodes it.
    const frameBytes = this.front(frameEnd);
    this.consume(frameEnd);
    this.frameEnd = null;
    try {
      const { header, payload } = decodeFrame(frameBytes);
      return { type: "frame", header, payload };
    } catch (err) {
      if (err instanceof FrameError) {
        return { type: "invalid", kind: err.kind, message: err.message };
      }
      throw err;
    }
  }
}

/** Every event of a byte stream (stdin, in the engine), then any end-of-input event. */
export async function* readFrames(
  source: AsyncIterable<Uint8Array>,
  options: FrameReaderOptions = {},
): AsyncGenerator<FrameEvent, void, undefined> {
  const reader = new FrameReader(options);
  for await (const chunk of source) {
    for (const event of reader.push(chunk)) {
      yield event;
      if (event.type === "fatal") return;
    }
  }
  for (const event of reader.end()) yield event;
}

/** The part of a Node `Writable` (stdout) that {@link writeFrame} uses. */
export interface FrameSink {
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): unknown;
}

/** Write one encoded frame and resolve when the sink has taken it, so a slow reader
 *  holds the next response back instead of the engine buffering it without bound. */
export function writeFrame(sink: FrameSink, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    sink.write(bytes, (error) => (error ? reject(error) : resolve()));
  });
}
