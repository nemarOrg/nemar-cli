/**
 * Which hosts reach the Neurobagel read route (epic #1586, phase 4; ADR 0084).
 *
 * The one worker answers on the api host, the data host, the zarr host and the mcp host
 * (services/host-routing.ts). The read route is mounted on the api app, so it belongs to
 * the api host (and its `/nemar` mount and the workers.dev fallback) and to NO other:
 * the data host rewrites every path under `/data/`, where `neurobagel` is not a dataset
 * id, and the zarr and mcp hosts have their own sub-apps. Driven through the real worker
 * with a real store written by the real writer; the 200 answered is the index, which the
 * route reads as text, so it runs from bun.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import { runNeurobagelWriter } from "../src/services/neurobagel-writer";
import { type Harness, seedSynthetic, startHarness } from "./helpers/neurobagel-harness";

const TOKEN = "nb-host-token-0123456789abcdef0123456789abcdef";
const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.dispose();
});
beforeEach(async () => {
  await h.reset();
  seedSynthetic(h, "nm000900");
  await runNeurobagelWriter(h.env(), { trigger: "admin", execute: true });
});

const fetchFrom = (url: string, over = {}) =>
  worker.fetch(
    new Request(url, { headers: { Authorization: `Bearer ${TOKEN}` } }),
    h.env({ NEUROBAGEL_READ_TOKEN: TOKEN, ...over }),
    ctx,
  );

describe("the read route is on the api host and only there", () => {
  test("api.nemar.org, its /nemar mount and the workers.dev fallback all serve the index", async () => {
    for (const url of [
      "https://api.nemar.org/neurobagel/index.json",
      "https://api.nemar.org/nemar/neurobagel/index.json",
      "https://nemar-api-dev.sccn-org.workers.dev/neurobagel/index.json",
      "https://api-test.nemar.org/neurobagel/index.json",
    ]) {
      const res = await fetchFrom(url);
      expect(res.status).toBe(200);
      const index = (await res.json()) as { datasets: { id: string }[] };
      expect(index.datasets.map((d) => d.id)).toEqual(["nm000900"]);
    }
  });

  test("the data host never reaches it, even with the right token and a store behind it", async () => {
    for (const path of ["/neurobagel/index.json", "/neurobagel/nm000900.jsonld"]) {
      const res = await fetchFrom(`https://data.nemar.org${path}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).not.toBe("application/ld+json");
      expect(await res.text()).not.toContain("nemar-neurobagel-artifact-index");
    }
  });

  test("the staging data host (DATA_HOSTNAME) is the same", async () => {
    const res = await fetchFrom("https://data-test.nemar.org/neurobagel/index.json", {
      DATA_HOSTNAME: "data-test.nemar.org",
    });
    expect(res.status).toBe(404);
  });

  test("the zarr and mcp hosts never reach it", async () => {
    for (const host of ["zarr.nemar.org", "mcp.nemar.org"]) {
      const res = await fetchFrom(`https://${host}/neurobagel/index.json`);
      expect(res.status).not.toBe(200);
      expect(await res.text()).not.toContain("nemar-neurobagel-artifact-index");
    }
  });
});
