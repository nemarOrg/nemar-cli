/**
 * What `rpc/entrypoint.ts` must hand on, read as text (ADR 0078).
 *
 * `NemarApiRpc` is a thin shim, and the one thing in it no behavioral test can
 * see is that it passes `this.ctx` to the two methods that start a background
 * write. Both finish a session read with a `last_used_at` touch handed to
 * `ctx.waitUntil`; the function each calls is tested under bun with a context it
 * is given, but local workerd completes a floating write whether or not the
 * class hands the context over (`private-site-rpc-entry.test.ts` says so). So
 * dropping `this.ctx` would leave the touch floating, and a method that has
 * returned can cancel a floating write in production, with every test green.
 *
 * The class imports `cloudflare:workers`, which bun cannot load, so it is read
 * as text, the way `private-site-contract.test.ts` reads the shared contract.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "../src/rpc/entrypoint.ts"), "utf-8");

describe("NemarApiRpc hands this.ctx to the methods that write in the background", () => {
  test("resolvePrincipal passes it", () => {
    expect(SOURCE).toContain("return resolvePrincipal(this.env, credential, this.ctx);");
  });

  test("exchangePrivateGrant passes it", () => {
    expect(SOURCE).toContain("return exchangePrivateGrant(this.env, request, this.ctx);");
  });

  test("revokePrivateSession takes none: it has no background write to hand over", () => {
    // Pinned so the other two read as a deliberate pair rather than an oversight:
    // a revoke that started handing a context on would be a new background write
    // that deserves its own look.
    expect(SOURCE).toContain("return revokePrivateSession(this.env, request);");
  });
});
