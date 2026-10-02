/**
 * Pins the Neurobagel read router's route table (epic #1586, phase 4; ADR 0084), in the
 * style of the admin, datasets and webhooks inventories.
 *
 * Hono's `.routes` lists one entry per handler in each registration chain, so pinning the
 * entry count per "METHOD /path" catches a dropped route AND a dropped middleware. What
 * this router must never grow is a way to WRITE or to LIST: it is two GETs behind one
 * bearer check, and nothing else.
 *
 * If this fails after an intentional change, update the map in the same commit and say so.
 */

import { describe, expect, test } from "bun:test";
import { neurobagelRoutes } from "../src/routes/neurobagel";

const EXPECTED_ENTRIES: Record<string, number> = {
  // The configuration-then-authentication gate, in front of everything.
  "ALL /*": 1,
  // The index the loader reads.
  "GET /index.json": 1,
  // One artifact, by strict name; one handler, no validator to drop.
  "GET /:name": 1,
};

describe("neurobagel read route inventory", () => {
  test("route table matches the pin exactly", () => {
    const actual: Record<string, number> = {};
    for (const r of neurobagelRoutes.routes) {
      const key = `${r.method} ${r.path}`;
      actual[key] = (actual[key] ?? 0) + 1;
    }
    expect(actual).toEqual(EXPECTED_ENTRIES);
  });

  test("entry total is pinned", () => {
    expect(neurobagelRoutes.routes.length).toBe(3);
  });

  test("the router is read-only: no method but GET answers, and nothing lists", () => {
    const methods = new Set(neurobagelRoutes.routes.map((r) => r.method));
    expect([...methods].sort()).toEqual(["ALL", "GET"]);
    // No route that could be a listing of the bucket.
    expect(
      neurobagelRoutes.routes.some(
        (r) => r.path === "/" || (r.path === "/*" && r.method !== "ALL"),
      ),
    ).toBe(false);
  });

  test("the gate is registered before every handler, so nothing is reachable unauthenticated", () => {
    const first = neurobagelRoutes.routes[0];
    expect(first?.method).toBe("ALL");
    expect(first?.path).toBe("/*");
  });
});
