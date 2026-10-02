/**
 * GET /neurobagel/index.json and GET /neurobagel/<name> (epic #1586, phase 4; ADR 0084).
 *
 * The real route runs INSIDE workerd, next to Miniflare's R2 and D1 simulators, because
 * it streams an R2 object's body and that cannot be read from bun (the news media suite
 * does the same). The store it reads is written by the real writer, against the real
 * data plane; the eligibility rows are mirrored into the workerd D1, which carries every
 * production migration.
 *
 * What is proven here, each with the control that makes it mean something:
 *   - nothing is served without the right bearer, and with none configured the route
 *     does not exist;
 *   - only a strict artifact name is served, and the dataset must be eligible NOW:
 *     the predicate is re-checked on every request, so a dataset that went private is
 *     gone from the very next read, with the stored objects untouched;
 *   - the index is served filtered by the same check;
 *   - the bytes served are the bytes the index promises (sha256 and size), which is what
 *     the node's loader verifies.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { runNeurobagelWriter } from "../src/services/neurobagel-writer";
import {
  type Harness,
  bundleRouteWorker,
  seedFromFixture,
  seedSynthetic,
  startHarness,
} from "./helpers/neurobagel-harness";

const TOKEN = "nb-read-token-0123456789abcdef0123456789abcdef";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ routeWorker: { script: await bundleRouteWorker(), token: TOKEN } });
});
afterAll(async () => {
  await h.dispose();
});
beforeEach(async () => {
  await h.reset();
  const d1 = h.workerD1 as D1Database;
  await d1.prepare("DELETE FROM dataset_versions").run();
  await d1.prepare("DELETE FROM datasets").run();
});

/** Write the store with the real writer, then give the workerd D1 the same catalog. */
async function populate(...ids: string[]): Promise<void> {
  for (const id of ids) {
    if (id === "nm000132") seedFromFixture(h);
    else seedSynthetic(h, id);
  }
  const result = await runNeurobagelWriter(h.env(), { trigger: "admin", execute: true });
  expect(result.status).toBe("ok");
  await h.mirrorCatalog?.();
}

const get = (path: string, headers: Record<string, string> = AUTH, method = "GET") =>
  (h.dispatch as NonNullable<Harness["dispatch"]>)(path, { method, headers });

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("authentication and configuration", () => {
  test("no Authorization header: 401 with a challenge, no-store, and nothing else", async () => {
    await populate("nm000700");
    const res = await get("/neurobagel/index.json", {});
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("a wrong token, a near-miss, another scheme and an empty bearer are all refused", async () => {
    await populate("nm000700");
    for (const header of [
      `Bearer ${TOKEN.slice(0, -1)}x`,
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(1)}`,
      `bearer ${TOKEN}`,
      `Basic ${TOKEN}`,
      TOKEN,
      "Bearer ",
      "Bearer",
    ]) {
      expect((await get("/neurobagel/index.json", { Authorization: header })).status).toBe(401);
      expect((await get("/neurobagel/nm000700.jsonld", { Authorization: header })).status).toBe(
        401,
      );
    }
    // The control: the right token on the same requests is served.
    expect((await get("/neurobagel/index.json")).status).toBe(200);
    expect((await get("/neurobagel/nm000700.jsonld")).status).toBe(200);
  });

  test("an unknown path under the route is 401 to a caller with no token, and 404 with one", async () => {
    expect((await get("/neurobagel/nope/deeper", {})).status).toBe(401);
    expect((await get("/neurobagel/nope/deeper")).status).toBe(404);
  });
});

describe("unconfigured, the route does not exist", () => {
  test("no token configured: 404 whatever is sent, including the right-looking one", async () => {
    // A fresh worker with a bucket and no secret.
    const bare = await startHarness({
      routeWorker: { script: await bundleRouteWorker(), token: "" },
    });
    try {
      for (const headers of [AUTH, {}]) {
        const res = await (bare.dispatch as NonNullable<Harness["dispatch"]>)(
          "/neurobagel/index.json",
          { headers },
        );
        expect(res.status).toBe(404);
      }
    } finally {
      await bare.dispose();
    }
  });
});

describe("what is served", () => {
  test("the index lists the datasets, in the schema's shape, and is no-store", async () => {
    await populate("nm000132", "nm000700", "on000700");
    const res = await get("/neurobagel/index.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const index = (await res.json()) as {
      schema: string;
      datasets: { id: string; artifacts: { name: string }[] }[];
    };
    expect(index.schema).toBe("nemar-neurobagel-artifact-index/1");
    expect(index.datasets.map((d) => d.id)).toEqual(["nm000132", "nm000700", "on000700"]);
  });

  test("every artifact the index names is served, with the sha256 and size the index promises", async () => {
    await populate("nm000132", "nm000700");
    const index = (await (await get("/neurobagel/index.json")).json()) as {
      datasets: { artifacts: { name: string; kind: string; sha256: string; bytes: number }[] }[];
    };
    let served = 0;
    for (const dataset of index.datasets) {
      for (const artifact of dataset.artifacts) {
        const res = await get(`/neurobagel/${artifact.name}`);
        expect(res.status).toBe(200);
        const bytes = new Uint8Array(await res.arrayBuffer());
        // What the node's loader verifies, before it loads anything.
        expect(sha256(bytes)).toBe(artifact.sha256);
        expect(bytes.length).toBe(artifact.bytes);
        expect(res.headers.get("Content-Type")).toBe(
          artifact.kind === "jsonld" ? "application/ld+json" : "application/json",
        );
        expect(res.headers.get("Cache-Control")).toBe("no-store");
        expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
        served++;
      }
    }
    expect(served).toBe(6);
  });

  test("HEAD answers like GET without a body", async () => {
    await populate("nm000700");
    const res = await get("/neurobagel/nm000700.jsonld", AUTH, "HEAD");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("only strict artifact names are served", () => {
  const BAD = [
    "nm000700.json",
    "nm000700.jsonld.bak",
    "nm000700_annotated.jsonld",
    "nm000700.report.json",
    "NM000700.jsonld",
    "nm00700.jsonld",
    "nm0007000.jsonld",
    "xx000042.jsonld",
    "ds000117.jsonld",
    "index.json.bak",
    "..%2Fnm000700.jsonld",
    "%2e%2e%2fnm000700.jsonld",
    "nm000700.jsonld%00",
    "nm000700.jsonld%20",
    ".jsonld",
    "nm000700_dataset_description.json.gz",
  ];
  for (const name of BAD) {
    test(`${name} is a 404, though the dataset is in the store`, async () => {
      await populate("nm000700");
      expect((await get(`/neurobagel/${name}`)).status).toBe(404);
    });
  }

  test("the reserved band and sandbox ids are not served even if an object sits under the name", async () => {
    await populate("nm000700");
    // Objects under artifact-shaped names for ids the store never holds.
    const stamp = { sha256: "0".repeat(64), kind: "jsonld" };
    await h.bucket.put("nm099998.jsonld", "{}", { customMetadata: stamp });
    await h.bucket.put("nm099900.jsonld", "{}", { customMetadata: stamp });
    await h.bucket.put("xx099903.jsonld", "{}", { customMetadata: stamp });
    for (const id of ["nm099998", "nm099900", "xx099903"]) {
      expect((await get(`/neurobagel/${id}.jsonld`)).status).toBe(404);
    }
  });

  test("the bucket is never listed: the root and listing-shaped requests are not an index of it", async () => {
    await populate("nm000700");
    for (const path of [
      "/neurobagel",
      "/neurobagel/",
      "/neurobagel/?list",
      "/neurobagel/?prefix=nm",
    ]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("nm000700");
    }
  });

  test("an object with an artifact-shaped name the writer did not stamp is not served", async () => {
    await populate("nm000700");
    await h.bucket.put("nm000700_annotated.json", '{ "planted": true }');
    expect((await get("/neurobagel/nm000700_annotated.json")).status).toBe(404);
  });

  test("an artifact the store does not hold is a 404 even for an eligible dataset", async () => {
    await populate("nm000700");
    await h.bucket.delete("nm000700_annotated.json");
    expect((await get("/neurobagel/nm000700_annotated.json")).status).toBe(404);
    // And a name for a dataset that is eligible but was never written.
    seedSynthetic(h, "nm000701");
    await h.mirrorCatalog?.();
    expect((await get("/neurobagel/nm000701.jsonld")).status).toBe(404);
  });
});

describe("eligibility is re-checked against D1 on every request", () => {
  const CAUSES: [string, string][] = [
    ["goes private", "UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000701'"],
    [
      "is withdrawn",
      "UPDATE datasets SET visibility = 'private', withdrawn_at = datetime('now') WHERE dataset_id = 'nm000701'",
    ],
    ["is archived", "UPDATE datasets SET status = 'archived' WHERE dataset_id = 'nm000701'"],
    ["is deleted", "DELETE FROM dataset_versions WHERE dataset_id = 'nm000701'"],
    [
      "becomes anonymous",
      "UPDATE datasets SET anonymous = 1, first_published_at = NULL WHERE dataset_id = 'nm000701'",
    ],
    ["becomes a sandbox row", "UPDATE datasets SET is_sandbox = 1 WHERE dataset_id = 'nm000701'"],
  ];

  for (const [cause, sql] of CAUSES) {
    test(`a dataset that ${cause} is gone from the next read, with the store untouched`, async () => {
      await populate("nm000700", "nm000701");
      expect((await get("/neurobagel/nm000701.jsonld")).status).toBe(200);
      const storeBefore = await (await get("/neurobagel/index.json")).text();

      await (h.workerD1 as D1Database).prepare(sql).run();

      for (const name of [
        "nm000701.jsonld",
        "nm000701_annotated.json",
        "nm000701_dataset_description.json",
      ]) {
        expect((await get(`/neurobagel/${name}`)).status).toBe(404);
      }
      // The object is still in the bucket: it is the CHECK that refuses, not a deletion.
      expect(await h.bucket.head("nm000701.jsonld")).not.toBeNull();
      // The control: the other dataset is untouched.
      expect((await get("/neurobagel/nm000700.jsonld")).status).toBe(200);

      // The index, as the writer stored it, still names the dataset; as served it does not.
      const stored = await (await h.bucket.get("index.json"))?.text();
      expect(stored).toContain("nm000701");
      const served = (await (await get("/neurobagel/index.json")).json()) as {
        datasets: { id: string }[];
      };
      expect(served.datasets.map((d) => d.id)).toEqual(["nm000700"]);
      expect(storeBefore).toContain("nm000701");
    });
  }

  test("a dataset that was never eligible in the row is not served, whatever the store holds", async () => {
    await populate("nm000700");
    // The writer wrote it while eligible; the catalog the route sees says private from the start.
    await (h.workerD1 as D1Database)
      .prepare("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000700'")
      .run();
    expect((await get("/neurobagel/nm000700.jsonld")).status).toBe(404);
    const served = (await (await get("/neurobagel/index.json")).json()) as {
      datasets: unknown[];
    };
    expect(served.datasets).toEqual([]);
  });

  test("a dataset restored to eligibility is served again at once", async () => {
    await populate("nm000700");
    const d1 = h.workerD1 as D1Database;
    await d1.prepare("UPDATE datasets SET visibility = 'private'").run();
    expect((await get("/neurobagel/nm000700.jsonld")).status).toBe(404);
    await d1.prepare("UPDATE datasets SET visibility = 'public'").run();
    expect((await get("/neurobagel/nm000700.jsonld")).status).toBe(200);
  });
});

describe("the index object", () => {
  test("absent: 404. Present and unusable: 503, which is not an empty release", async () => {
    expect((await get("/neurobagel/index.json")).status).toBe(404);
    await h.bucket.put("index.json", "{ not json");
    const res = await get("/neurobagel/index.json");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "index_unreadable" });
    await h.bucket.put("index.json", JSON.stringify({ schema: "something-else", datasets: [] }));
    expect((await get("/neurobagel/index.json")).status).toBe(503);
  });
});
