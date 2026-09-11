/**
 * Every unrouted path on every hostname answers with the same 404 document
 * (epic #1336 phase 0 review).
 *
 * Drives the worker entry the way Cloudflare does (`worker.fetch`), the
 * precedent `mcp-fork.test.ts` sets, because this contract is invisible from
 * anywhere else: the two notFound handlers live on different Hono instances and
 * only the real entry point decides which one a request reaches.
 *
 * WHY THERE ARE TWO HANDLERS AND BOTH NEED A TEST. `app` mounts `api` at `/` and
 * `/nemar`, and Hono's `route()` copies a sub-app's routes WITHOUT its notFound
 * handler. So `api.notFound` never fires for api.nemar.org -- `app`'s does -- and
 * `api.notFound` is reached only where a request re-enters `api.fetch` directly,
 * which today is the data.nemar.org host fork. Before this pass only one of the
 * two existed, so the same unrouted path answered `text/plain` on one hostname
 * and `application/json` on the other, and nothing noticed for as long as
 * nothing compared them. Deleting EITHER registration fails a test here.
 *
 * The shape is not incidental: `src/lib/api/client.ts` keys its "this backend
 * does not support this command yet" hint on `status === 404 && body.error ===
 * "Not Found"`, and that hint was dead code against api.nemar.org until the
 * handler existed there.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import { notFoundBody } from "../src/lib/not-found";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

let db: Database;

/** `development` for the documented rate-limit bypass; `caches.default` does not
 *  exist under bun:test, so a rate-limited environment would log a cache failure
 *  and fail open rather than exercising anything this file is about. */
function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "development" } as unknown as Bindings;
}

function request(url: string, method = "GET"): Promise<Response> {
  return worker.fetch(new Request(url, { method }), env(), ctx);
}

beforeEach(() => {
  db = freshDb();
});

describe("the API 404", () => {
  test("api.nemar.org answers the shared JSON document", async () => {
    // Fails if `app.notFound` is removed: Hono's default is `text/plain` with
    // the body `404 Not Found`.
    const res = await request("https://api.nemar.org/no/such/route");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(notFoundBody("GET", "/no/such/route"));
  });

  test("the /nemar prefix mount answers the same way", async () => {
    const res = await request("https://api.nemar.org/nemar/no/such/route");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(notFoundBody("GET", "/nemar/no/such/route"));
  });

  test("data.nemar.org answers the same document, via the other handler", async () => {
    // This is the one request that reaches `api.notFound`: the host fork rewrites
    // the path and re-enters `api.fetch`, which is why the reported path carries
    // the `/data` prefix. Fails if `api.notFound` is removed.
    const res = await request("https://data.nemar.org/nope", "POST");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(notFoundBody("POST", "/data/nope"));
  });

  test("an odd path is reflected without throwing", async () => {
    // The handler interpolates the path into the body, so a hostile one must not
    // produce a 500. JSON plus `X-Content-Type-Options: nosniff` from
    // `secureHeaders()` is what makes reflecting it safe.
    for (const path of ["/%2e%2e%2f%2e%2e", "/a%00b", "/<script>alert(1)</script>", "//double//"]) {
      const res = await request(`https://api.nemar.org${path}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});
