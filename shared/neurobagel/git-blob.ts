/**
 * Git blob hashes, for the content pins of a curation entry.
 *
 * The data plane's entity tag for a git-tracked file IS its git blob SHA-1 (ADR 0066),
 * so a pin written from that tag and a pin computed here from the bytes agree.
 * Computing it from the text the transform was handed, instead of trusting a hash the
 * caller supplies, makes a pin say something about the very bytes being converted.
 *
 * SHA-1 is a content hash here, not a security boundary: a pin guards against a table
 * that changed since it was reviewed, not against someone crafting a collision.
 *
 * Pure: Web Crypto only.
 */

const BOM = "﻿";
const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `git hash-object` of these bytes: SHA-1 of `blob <length>` NUL and the bytes, lowercase hex. */
export async function gitBlobShaOfBytes(bytes: Uint8Array): Promise<string> {
  const header = encoder.encode(`blob ${bytes.length}\0`);
  const input = new Uint8Array(header.length + bytes.length);
  input.set(header, 0);
  input.set(bytes, header.length);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-1", input)));
}

/** The git blob SHA-1 of the UTF-8 bytes of `text`. */
export function gitBlobSha(text: string): Promise<string> {
  return gitBlobShaOfBytes(encoder.encode(text));
}

/**
 * Whether `text` is the file a pin names.
 * `null` text is a file the data plane does not have, and `null` is how a pin says "absent",
 * so the two agree only with each other.
 *
 * A UTF-8 byte order mark is the one tolerance: `Response.text()` and `TextDecoder` drop a
 * leading mark, and the transform's own table reader drops it too, so the text of a file that
 * starts with one matches the pin of the file's true bytes.
 * Text that is not valid UTF-8 never matches: decoding replaced bytes, and the pin is of the
 * bytes the reviewer saw.
 */
export async function contentMatchesPin(text: string | null, pin: string | null): Promise<boolean> {
  if (text === null || pin === null) return text === null && pin === null;
  if ((await gitBlobSha(text)) === pin) return true;
  return !text.startsWith(BOM) && (await gitBlobSha(BOM + text)) === pin;
}
