// Shared Workers-runtime crypto shim for backend tests (issue #1229, phase 2
// of epic #1225).
//
// `crypto.subtle.timingSafeEqual` is a Cloudflare Workers extension to Web
// Crypto, not a standard Web Crypto API. Bun's runtime does not implement it,
// so any handler that calls `lib/constant-time.ts`'s `timingSafeEqual` (or,
// before this phase, one of its four now-deleted copies) throws before
// reaching the behavior under test unless something supplies the missing
// primitive.
//
// This installs a REAL constant-time comparison for that missing platform
// primitive. It is not a mock in the sense .rules/testing.md forbids: no
// business logic is replaced or bypassed, the handler's own auth check still
// executes against whatever this installs, and each consuming suite's
// "rejects a wrong token" case proves the check stays live rather than being
// short-circuited.
//
// Before phase 2 of epic #1225, six test files each hand-copied this exact
// ~15-line polyfill (zarr-pool-breaks, zarr-index-v3, recording-stats-callback,
// bounded-audit-payloads, sweep-stamps-candidates, catalog-has-zarr). Phase 2
// added `backend/src/lib/constant-time.ts`, which feature-detects this same
// capability at the production call site, so none of those six suites need
// this shim to pass anymore -- `constant-time-compare.test.ts` is what
// exercises the "native absent" branch explicitly, with tighter control over
// installing and restoring the capability. The six call sites below are kept
// anyway: they still exercise the native Workers branch of the shared
// helper through a real callback route, which is coverage worth keeping.
//
// Idempotent: safe to call from multiple test files sharing one bun test
// process (root `bun test` runs test/ + backend/test/ in ONE process).
export function installWorkersTimingSafeEqual(): void {
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") return;
  subtle.timingSafeEqual = (a: ArrayBufferView, b: ArrayBufferView): boolean => {
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= (x[i] as number) ^ (y[i] as number);
    return diff === 0;
  };
}
