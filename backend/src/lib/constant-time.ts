/**
 * Constant-time string equality, shared by every webhook/token/CSRF
 * comparison in the backend (issue #1229, phase 2 of epic #1225).
 *
 * Before this module there were four separate implementations: one
 * (`github/callback-tokens.ts`'s `constantTimeEqual`) got it right, and this
 * function is that one, generalized from `Uint8Array` to the `string` shape
 * every call site actually has. The other three either called the Workers
 * extension unconditionally (throwing under `bun test`, since Bun does not
 * implement it) or claimed the extension "is not exposed in the Workers
 * runtime" — false, and disproven by this function's own feature-detected
 * branch.
 *
 * `crypto.subtle.timingSafeEqual` is a Cloudflare Workers extension to Web
 * Crypto, not a standard Web Crypto API. Bun and Node's `bun:test`/`node:test`
 * runners don't implement it, so we feature-detect and fall back to a manual
 * XOR-accumulate that runs in time proportional to the (equal) length but
 * doesn't short-circuit on a mismatched byte. Keeping the feature detection
 * (rather than branching on a hardcoded runtime check) means a runtime that
 * gains the extension later picks it up with no code change here.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  // The length itself is not secret, so exposing it via early return costs
  // nothing. This guard is required, not merely an optimization: Workers'
  // native timingSafeEqual throws on unequal-length inputs rather than
  // returning false, so skipping it would turn a length mismatch into a
  // 500 instead of the intended negative comparison.
  if (bufA.byteLength !== bufB.byteLength) return false;

  const subtle = (crypto as { subtle: { timingSafeEqual?: typeof crypto.subtle.timingSafeEqual } })
    .subtle;
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(bufA, bufB);
  }
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    diff |= (bufA[i] as number) ^ (bufB[i] as number);
  }
  return diff === 0;
}
