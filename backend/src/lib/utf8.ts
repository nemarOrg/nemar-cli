/**
 * UTF-8 helpers shared by the mail services.
 */

/** `value` cut to at most `maxBytes` UTF-8 bytes, never inside a multibyte character. */
export function clampUtf8Bytes(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  // A continuation byte (10xxxxxx) means the cut landed inside a character: back up to its start.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}
