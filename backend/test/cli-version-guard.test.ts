/**
 * cliVersionGuard behavior across the two auth paths (#199, web exemption).
 *
 * The guard exists to reject installed CLIs older than MIN_CLI_VERSION
 * (pre-0.6.4 clients used registerurl instead of the S3 special remote).
 * The web dashboard's upload flow authenticates with the `nemar_session`
 * cookie and is served by the site itself, so it can never be
 * version-stale and sends no X-CLI-Version header. authMiddleware records
 * which credential resolved the user in `authMethod`; the guard exempts
 * "cookie" and gates everything else exactly as before.
 *
 * The Hono app here stubs authMiddleware with a var-setting middleware —
 * the guard only reads `c.get("authMethod")` and request headers, so no
 * DB or bindings are needed.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { cliVersionGuard } from "../src/middleware/cliVersion";
import type { Bindings, Variables } from "../src/types/bindings";

function appWithAuthMethod(authMethod?: "token" | "cookie") {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.post(
    "/datasets",
    async (c, next) => {
      if (authMethod) c.set("authMethod", authMethod);
      await next();
    },
    cliVersionGuard,
    (c) => c.json({ ok: true }),
  );
  return app;
}

describe("cliVersionGuard", () => {
  test("cookie-auth request passes with no X-CLI-Version header", async () => {
    const res = await appWithAuthMethod("cookie").request("/datasets", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("cookie-auth request passes even with a stale header", async () => {
    // A browser never sends this header, but if a proxy injected one the
    // web exemption should still win — the client is the site itself.
    const res = await appWithAuthMethod("cookie").request("/datasets", {
      method: "POST",
      headers: { "X-CLI-Version": "0.1.0" },
    });
    expect(res.status).toBe(200);
  });

  test("token-auth request without the header is rejected 426", async () => {
    const res = await appWithAuthMethod("token").request("/datasets", { method: "POST" });
    expect(res.status).toBe(426);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("CLI version too old");
  });

  test("token-auth request below the minimum is rejected 426", async () => {
    const res = await appWithAuthMethod("token").request("/datasets", {
      method: "POST",
      headers: { "X-CLI-Version": "0.6.3" },
    });
    expect(res.status).toBe(426);
  });

  test("token-auth request at/above the minimum passes", async () => {
    const res = await appWithAuthMethod("token").request("/datasets", {
      method: "POST",
      headers: { "X-CLI-Version": "0.9.8" },
    });
    expect(res.status).toBe(200);
  });

  test("unset authMethod still gates on the header (fail closed)", async () => {
    const res = await appWithAuthMethod(undefined).request("/datasets", { method: "POST" });
    expect(res.status).toBe(426);
  });

  test("unparseable version is rejected 400", async () => {
    const res = await appWithAuthMethod("token").request("/datasets", {
      method: "POST",
      headers: { "X-CLI-Version": "banana" },
    });
    expect(res.status).toBe(400);
  });
});
