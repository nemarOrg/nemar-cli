/**
 * Pins the compute router's route table (epic #2005 phase A5, #2010; ADR 0118), the way
 * `test/webhooks-route-inventory.unit.test.ts` pins the webhooks router.
 *
 * Hono's `.routes` lists one entry per handler (a route's own middleware included). Pinning the per-route
 * ENTRY COUNT and the router's middleware catches a handler silently dropped, a route added with no test
 * to answer for it, and a `use("*")` slipping in front of the launcher's callbacks (which have no
 * account: a session middleware there would refuse every launcher).
 *
 * THE TRUST MODEL of each route is stated beside it: the three callbacks carry a per-job token and no
 * session, and each route that has a person behind it declares its own authentication on the route.
 */

import { describe, expect, test } from "bun:test";
import { oidcBearerScopes } from "../src/middleware/oidc-bearer";
import { computeRoutes } from "../src/routes/compute";
import {
  COMPUTE_OIDC_ROUTES,
  PERSON_OIDC,
  RESERVE_OIDC,
  STATS_OIDC,
  computePartnerCredential,
  computePersonCredential,
  computeStatsCredential,
} from "../src/routes/compute/auth";

const EXPECTED_ENTRIES: Record<string, number> = {
  // The launcher's callbacks: one handler each, authenticated inline by the `X-Compute-Job-Token`
  // header (a domain-tagged HMAC over the job and its nonce), with one refusal for every failure.
  "POST /jobs/:id/bundle": 1,
  "POST /jobs/:id/outputs": 1,
  "POST /jobs/:id/outputs/complete": 1,
  // The job's owner, signed in: `authMiddleware` (bearer first, then the session cookie), then
  // `cookieOriginGuard` (a write made with a session cookie must come from a NEMAR page), then the
  // handler. Any account that is not the owner is answered `job_not_found`.
  "POST /jobs/:id/cancel": 3,
  "POST /jobs/:id/links": 3,
  // The observer (phase A7, #2012): one handler, no session, authenticated inline by the
  // `Authorization: Bearer` header (an HMAC over a run id and the run's own nonce, one run, one post),
  // with one refusal for every failure.
  "POST /observer": 1,
  // The read routes (epic #2021 phase D2, #2023): the credential rule of `routes/compute/auth.ts`, then the
  // handler. `/me*` is a person's (a CLI key, the session cookie, or an access token carrying
  // `compute.read`); `/stats` is a partner CLIENT's (a client credentials token carrying `compute.stats`).
  "GET /me": 2,
  "GET /me/usage": 2,
  "GET /me/jobs": 2,
  "GET /me/jobs/:id": 2,
  "GET /stats": 2,
  // The person's submission, log and results (epic #2021 phase D3, #2024): a CLI key or the session
  // cookie through `authMiddleware` (an OpenID Connect token is refused there: `compute.submit` is
  // granted to no client yet), then, for a write, `cookieOriginGuard`, then the handler. Any account that
  // is not the owner is answered `job_not_found`.
  "POST /jobs": 3,
  "POST /jobs/:id/finalize": 3,
  "GET /jobs/:id/logs": 2,
  "GET /jobs/:id/results": 2,
  "POST /jobs/:id/results/renew": 3,
  // The partner contract (epic #2021 phase D4, #2025): an OpenID Connect access token for a PERSON carrying
  // `compute.reserve` through `computePartnerCredential` (a CLI key or the cookie is `forbidden_credential`),
  // then the handler. Any job that is not the caller's person AND client is `job_not_found`.
  "POST /holds": 2,
  "POST /jobs/:id/report": 2,
  "DELETE /holds/:id": 2,
};

const tableOf = () => {
  const actual: Record<string, number> = {};
  for (const r of computeRoutes.routes) {
    const key = `${r.method} ${r.path}`;
    actual[key] = (actual[key] ?? 0) + 1;
  }
  return actual;
};

describe("compute route inventory", () => {
  test("the route table is exactly the pinned one", () => {
    expect(tableOf()).toEqual(EXPECTED_ENTRIES);
  });

  test("entry total is pinned", () => {
    expect(computeRoutes.routes.length).toBe(39);
  });

  test("no router-level middleware exists: the launcher's callbacks have no session", () => {
    expect(computeRoutes.routes.filter((r) => r.method === "ALL")).toEqual([]);
  });

  test("each person's route carries its own authentication, and the launcher's carry none", () => {
    const handlersOf = (path: string) =>
      computeRoutes.routes.filter((r) => r.path === path).map((r) => r.handler.name || "handler");
    for (const path of ["/jobs/:id/cancel", "/jobs/:id/links"]) {
      expect(handlersOf(path)).toEqual(["authMiddleware", "cookieOriginGuard", "handler"]);
    }
    // The submission routes (phase D3): the same rule. Their handlers are named functions of `jobs.ts`.
    for (const path of ["/jobs", "/jobs/:id/finalize", "/jobs/:id/results/renew"]) {
      const names = computeRoutes.routes
        .filter((r) => r.method === "POST" && r.path === path)
        .map((r) => r.handler.name || "handler");
      expect(names.slice(0, 2)).toEqual(["authMiddleware", "cookieOriginGuard"]);
      expect(names).toHaveLength(3);
    }
    for (const path of ["/jobs/:id/logs", "/jobs/:id/results"]) {
      const names = computeRoutes.routes
        .filter((r) => r.method === "GET" && r.path === path)
        .map((r) => r.handler.name || "handler");
      expect(names[0]).toBe("authMiddleware");
      expect(names).toHaveLength(2);
    }
    for (const path of [
      "/jobs/:id/bundle",
      "/jobs/:id/outputs",
      "/jobs/:id/outputs/complete",
      "/observer",
    ]) {
      expect(handlersOf(path)).toHaveLength(1);
      expect(handlersOf(path)).not.toContain("authMiddleware");
    }
  });

  test("each partner route names its credential rule, then the handler; nothing else sits in front", () => {
    const handlersOf = (method: string, path: string) =>
      computeRoutes.routes
        .filter((r) => r.method === method && r.path === path)
        .map((r) => r.handler);
    for (const [method, path] of [
      ["POST", "/holds"],
      ["POST", "/jobs/:id/report"],
      ["DELETE", "/holds/:id"],
    ] as const) {
      const [first, second, ...rest] = handlersOf(method, path);
      expect([method, path, first]).toEqual([method, path, computePartnerCredential]);
      expect(typeof second).toBe("function");
      expect(rest).toEqual([]);
    }
    expect(oidcBearerScopes(RESERVE_OIDC)).toEqual(["compute.reserve"]);
  });

  test("every write is a POST (or the partner's DELETE), and every read route is a GET of the read table", () => {
    const reads = Object.keys(EXPECTED_ENTRIES).filter((k) => k.startsWith("GET "));
    expect(reads.sort()).toEqual(
      [
        "GET /me",
        "GET /me/jobs",
        "GET /me/jobs/:id",
        "GET /me/usage",
        "GET /stats",
        "GET /jobs/:id/logs",
        "GET /jobs/:id/results",
      ].sort(),
    );
    for (const key of Object.keys(EXPECTED_ENTRIES)) {
      expect(key.startsWith("POST ") || key.startsWith("GET ") || key === "DELETE /holds/:id").toBe(
        true,
      );
    }
  });

  test("each read route names its credential rule, then the handler; nothing else sits in front", () => {
    const handlersOf = (method: string, path: string) =>
      computeRoutes.routes
        .filter((r) => r.method === method && r.path === path)
        .map((r) => r.handler);
    for (const path of ["/me", "/me/usage", "/me/jobs", "/me/jobs/:id"]) {
      const [first, second, ...rest] = handlersOf("GET", path);
      expect([path, first]).toEqual([path, computePersonCredential]);
      expect(typeof second).toBe("function");
      expect(rest).toEqual([]);
    }
    const [first, second, ...rest] = handlersOf("GET", "/stats");
    expect(first).toBe(computeStatsCredential);
    expect(typeof second).toBe("function");
    expect(rest).toEqual([]);
  });

  test("the credential kinds and scopes each read route accepts are the ones pinned (ADR 0119 addendum)", () => {
    expect(COMPUTE_OIDC_ROUTES).toEqual({
      "GET /me": "compute.read",
      "GET /me/usage": "compute.read",
      "GET /me/jobs": "compute.read",
      "GET /me/jobs/:id": "compute.read",
      "GET /stats": "compute.stats",
      "POST /holds": "compute.reserve",
      "POST /jobs/:id/report": "compute.reserve",
      "DELETE /holds/:id": "compute.reserve",
    });
    // The two `oidcBearer` instances carry exactly the scope the table names, and no other.
    expect(oidcBearerScopes(PERSON_OIDC)).toEqual(["compute.read"]);
    expect(oidcBearerScopes(STATS_OIDC)).toEqual(["compute.stats"]);
    // The table lists exactly the `/me*` and `/stats` reads, so a route cannot accept an OIDC token
    // without a row here. The job log and results are reads too, and are NOT in it: a key or the
    // cookie only.
    const reads = Object.keys(EXPECTED_ENTRIES).filter(
      (k) => k.startsWith("GET ") && !k.startsWith("GET /jobs/"),
    );
    const partner = ["POST /holds", "POST /jobs/:id/report", "DELETE /holds/:id"];
    expect(Object.keys(COMPUTE_OIDC_ROUTES).sort()).toEqual([...reads, ...partner].sort());
  });

  test("the writes (cancel, links, the launcher's callbacks, the observer) accept no OpenID Connect token; the partner's three do", () => {
    // None of them is in the OIDC table but the partner's; the end-to-end proof (a token is refused on
    // cancel) is in `compute-read-credentials.test.ts`.
    const partner = new Set(["POST /holds", "POST /jobs/:id/report"]);
    for (const key of Object.keys(EXPECTED_ENTRIES).filter(
      (k) => k.startsWith("POST ") && !partner.has(k),
    )) {
      expect(Object.keys(COMPUTE_OIDC_ROUTES)).not.toContain(key);
    }
  });
});
