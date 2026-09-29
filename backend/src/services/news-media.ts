/**
 * News post images (#1551): validation and the `NEWS_MEDIA` R2 bucket.
 *
 * An image is stored once under `news/<sha256 of its bytes>.<ext>` and
 * referenced from a post by the site-relative URL `/news/media/<file>`. The
 * key is content-addressed, so re-uploading the same bytes lands on the same
 * object and every stored copy can be cached forever. Deleting a post leaves
 * its images in place: another post may reference the same key.
 *
 * Images are small by construction (NEWS_MEDIA_MAX_BYTES), which is what
 * makes serving them through the Worker acceptable; bulk data never takes
 * this path.
 */

export const NEWS_MEDIA_MAX_BYTES = 5 * 1024 * 1024;

export const NEWS_MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Key prefix inside the bucket. */
export const NEWS_MEDIA_PREFIX = "news/";

/** Site-relative URL prefix stored in posts and served by GET /news/media/:file. */
export const NEWS_MEDIA_URL_PREFIX = "/news/media/";

export type NewsImageType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
export type NewsImageExt = "png" | "jpg" | "webp" | "gif";

const EXT_BY_TYPE: Record<NewsImageType, NewsImageExt> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const TYPE_BY_EXT: Record<NewsImageExt, NewsImageType> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** A stored image's file name: 64 lowercase hex digits and a known extension. */
export const NEWS_MEDIA_FILE_RE = /^[0-9a-f]{64}\.(png|jpg|webp|gif)$/;

/** What a post's `banner_url` may hold (besides null). */
export const NEWS_BANNER_URL_RE = /^\/news\/media\/[0-9a-f]{64}\.(png|jpg|webp|gif)$/;

/**
 * The image type a request declared, from its Content-Type header, or null
 * when it is not one of the four accepted types. Parameters (`; charset=`)
 * are ignored and the comparison is case-insensitive, as media types are.
 */
export function declaredImageType(header: string | undefined): NewsImageType | null {
  if (!header) return null;
  const base = header.split(";")[0]?.trim().toLowerCase() ?? "";
  // Own keys only: `in` would also accept inherited names such as
  // `constructor`, letting one past this gate.
  return Object.hasOwn(EXT_BY_TYPE, base) ? (base as NewsImageType) : null;
}

export function extensionFor(type: NewsImageType): NewsImageExt {
  return EXT_BY_TYPE[type];
}

/** Content-Type for a validated file name, from its extension. */
export function contentTypeForFile(file: string): NewsImageType | null {
  const match = NEWS_MEDIA_FILE_RE.exec(file);
  return match ? TYPE_BY_EXT[match[1] as NewsImageExt] : null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  if (bytes.length < at + signature.length) return false;
  return signature.every((b, i) => bytes[at + i] === b);
}

const ascii = (s: string): number[] => [...s].map((ch) => ch.charCodeAt(0));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const GIF87 = ascii("GIF87a");
const GIF89 = ascii("GIF89a");
const RIFF = ascii("RIFF");
const WEBP = ascii("WEBP");

/**
 * The image type the bytes themselves say they are, from their leading
 * magic bytes, or null when they match none of the four. The upload route
 * refuses a body whose sniffed type differs from its declared Content-Type,
 * so a stored object is always what its extension (and served Content-Type)
 * claims.
 *
 * PNG checks the full 8-byte signature, not just `89 50 4E 47`: every
 * valid PNG carries all eight, and the last four catch a file mangled by a
 * text-mode transfer.
 */
export function sniffImageType(bytes: Uint8Array): NewsImageType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, JPEG_SIGNATURE)) return "image/jpeg";
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return "image/gif";
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return "image/webp";
  return null;
}

/**
 * Read a request body into memory, giving up as soon as it passes `max`
 * bytes. Returns null when it is too large, so an oversized upload is
 * refused without buffering all of it (a missing or false Content-Length
 * cannot get around the cap).
 */
export async function readBodyCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface StoredNewsImage {
  /** `<sha256>.<ext>` */
  file: string;
  /** `/news/media/<file>` */
  url: string;
  content_type: NewsImageType;
  bytes: number;
}

/**
 * Store validated image bytes under their content address. When the object
 * already exists it is left alone: the key is the hash of the bytes, so the
 * stored copy is identical by construction.
 *
 * `record` runs once the name is known and BEFORE anything is written; the
 * upload route writes its audit row there. An R2 put cannot share a
 * transaction with a D1 insert, and this order fails safe: a `record` that
 * throws leaves nothing stored, whereas the opposite order could leave a
 * public object that no audit row traces to its uploader (images cannot be
 * listed or deleted through the API, ADR 0076). The cost is an audit row
 * for a put that then fails, which the retry follows with another.
 */
export async function storeNewsImage(
  bucket: R2Bucket,
  bytes: Uint8Array,
  type: NewsImageType,
  record: (image: StoredNewsImage, alreadyStored: boolean) => Promise<unknown>,
): Promise<StoredNewsImage> {
  const file = `${await sha256Hex(bytes)}.${extensionFor(type)}`;
  const key = `${NEWS_MEDIA_PREFIX}${file}`;
  const image: StoredNewsImage = {
    file,
    url: `${NEWS_MEDIA_URL_PREFIX}${file}`,
    content_type: type,
    bytes: bytes.length,
  };
  const alreadyStored = (await bucket.head(key)) !== null;
  await record(image, alreadyStored);
  if (!alreadyStored) {
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: type, cacheControl: NEWS_MEDIA_CACHE_CONTROL },
    });
  }
  return image;
}

/**
 * The strong entity tag an `If-None-Match` header names, unquoted, when it
 * names exactly one; null otherwise (absent, `*`, or a list). Weak tags
 * (`W/"..."`) compare equal for GET under RFC 9110's weak comparison, so the
 * prefix is dropped.
 */
export function singleIfNoneMatch(header: string | undefined): string | null {
  if (!header) return null;
  const value = header.trim();
  if (value === "*" || value.includes(",")) return null;
  const match = /^(?:W\/)?"([^"]+)"$/.exec(value);
  return match ? match[1] : null;
}
