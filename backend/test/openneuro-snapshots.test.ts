/**
 * The batched OpenNeuro snapshot reader (epic #1046 phase 4a, #1910; ADR 0111).
 *
 * The server is a local `Bun.serve` that answers from the REAL recorded response of 2026-10-24
 * (see `helpers/openneuro-standin.ts`), so the parser is exercised on OpenNeuro's own wire shape,
 * including the two per-alias failures (`DELETED_DATASET` and "does not exist"). The failure
 * modes a recording cannot hold (a 503, a hang, a body that is not JSON) are the stand-in's.
 *
 * The properties that matter, each with a test that fails when its line is changed:
 *  - batches of at most 50, sent one after another, ids only in `variables`;
 *  - a per-alias failure is `deleted` or `absent`, anything not understood is `error`;
 *  - a transport failure makes the WHOLE batch `error`, never a verdict and never an empty list.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPENNEURO_GRAPHQL_URL } from "../src/services/openneuro-endpoint";
import {
  OPENNEURO_SNAPSHOT_BATCH,
  buildUpstreamSnapshotQuery,
  parseUpstreamSnapshotBatch,
  readUpstreamSnapshots,
  snapshotGraphqlUrl,
} from "../src/services/openneuro-snapshots";
import { startOpenNeuroStandin } from "./helpers/openneuro-standin";

const FIXTURES = join(import.meta.dir, "fixtures/openneuro-graphql");
const request = JSON.parse(
  readFileSync(join(FIXTURES, "graphql-upstream-snapshots.request.json"), "utf-8"),
) as { query: string; variables: Record<string, string> };
const response = JSON.parse(
  readFileSync(join(FIXTURES, "graphql-upstream-snapshots.response.json"), "utf-8"),
);
const RECORDED_IDS = Object.values(request.variables);

let standin: ReturnType<typeof startOpenNeuroStandin>;
beforeAll(() => {
  standin = startOpenNeuroStandin();
});
afterAll(() => standin.stop());
beforeEach(() => standin.reset());

const env = () => ({ OPENNEURO_GRAPHQL_URL: standin.url });

describe("buildUpstreamSnapshotQuery", () => {
  test("is exactly the recorded request, and carries ids only as variables", () => {
    const built = buildUpstreamSnapshotQuery(RECORDED_IDS);
    expect(built).toEqual(request);
    expect(built.query).toContain("$a0: ID!");
    for (const id of RECORDED_IDS) expect(built.query).not.toContain(id);
  });

  test("an id that looks like query text stays in the variables", () => {
    const hostile = 'ds000001") { id } x: dataset(id: "ds000002';
    const built = buildUpstreamSnapshotQuery([hostile]);
    expect(built.variables).toEqual({ a0: hostile });
    expect(built.query).not.toContain("x: dataset");
  });
});

describe("parseUpstreamSnapshotBatch on the recorded response", () => {
  const reads = parseUpstreamSnapshotBatch(response, RECORDED_IDS);

  test("a live dataset is a snapshot read with its latest and its list", () => {
    const read = reads.get("ds003645");
    expect(read?.kind).toBe("snapshot");
    if (read?.kind !== "snapshot") throw new Error("unreachable");
    expect(read.latest?.tag).toBe("2.1.0");
    expect(read.snapshots.map((s) => s.tag)).toEqual(["1.0.0", "2.0.0", "2.0.1", "2.0.2", "2.1.0"]);
  });

  test("DELETED_DATASET is deleted and 'does not exist' is absent", () => {
    expect(reads.get("ds006903")).toEqual({
      kind: "deleted",
      reason: "Dataset ds006903 has been deleted. Reason: duplicate dataset.",
    });
    expect(reads.get("ds999999")).toEqual({
      kind: "absent",
      reason: "Dataset ds999999 does not exist.",
    });
  });

  test("a legacy history keeps its hex tags in upstream's order", () => {
    const read = reads.get("ds000001");
    if (read?.kind !== "snapshot") throw new Error("unreachable");
    expect(read.snapshots.map((s) => s.tag)).toEqual([
      "57fecb0ccce88d000ac17538",
      "57fecb41cce88d000dc1753b",
      "5817d0dacce88d0009594205",
      "00006",
      "1.0.0",
    ]);
  });
});

describe("parseUpstreamSnapshotBatch refuses what it does not understand", () => {
  const id = "ds003645";
  const good = {
    id,
    latestSnapshot: { tag: "2.1.0", created: "2026-10-24T04:10:36.000Z" },
    snapshots: [{ tag: "2.1.0", created: "2026-10-24T04:10:36.000Z" }],
  };
  const readOf = (json: unknown) => parseUpstreamSnapshotBatch(json, [id]).get(id);

  test("a body that is not an object, or has no data, is an error for every id", () => {
    for (const json of [null, "text", 7, [], {}, { data: null }, { data: "x" }]) {
      expect(readOf(json)?.kind).toBe("error");
    }
    const reads = parseUpstreamSnapshotBatch({ data: null }, ["ds000001", "ds000002"]);
    expect([...reads.values()].map((r) => r.kind)).toEqual(["error", "error"]);
  });

  test("a node that names another dataset is an error", () => {
    expect(readOf({ data: { a0: { ...good, id: "ds000002" } } })?.kind).toBe("error");
  });

  test("snapshots that is not an array is an error, never an empty list", () => {
    for (const snapshots of [null, undefined, "x", {}]) {
      expect(readOf({ data: { a0: { ...good, snapshots } } })?.kind).toBe("error");
    }
  });

  test("a malformed snapshot entry is an error", () => {
    for (const bad of [null, "2.0.0", { tag: 2 }, { tag: "" }, { tag: "1.0.0", created: 5 }]) {
      expect(readOf({ data: { a0: { ...good, snapshots: [bad] } } })?.kind).toBe("error");
    }
    expect(readOf({ data: { a0: { ...good, latestSnapshot: { tag: 5 } } } })?.kind).toBe("error");
  });

  test("a null latestSnapshot is a snapshot read with no latest", () => {
    const read = readOf({ data: { a0: { ...good, latestSnapshot: null, snapshots: [] } } });
    expect(read).toEqual({ kind: "snapshot", latest: null, snapshots: [] });
  });

  test("a null node is an error unless the error at its path says deleted or missing", () => {
    expect(readOf({ data: { a0: null } })?.kind).toBe("error");
    expect(readOf({ data: { a0: null }, errors: [{ message: "x", path: ["a1"] }] })?.kind).toBe(
      "error",
    );
    expect(readOf({ data: { a0: null }, errors: [{ message: "boom", path: ["a0"] }] })).toEqual({
      kind: "error",
      reason: "boom",
    });
    expect(
      readOf({
        data: { a0: null },
        errors: [{ message: "x", path: ["a0"], extensions: { code: "DELETED_DATASET" } }],
      })?.kind,
    ).toBe("deleted");
  });

  test("a node beside an error for the same alias is an error, an error for another alias is not", () => {
    const partial = readOf({
      data: { a0: good },
      errors: [{ message: "resolver failed", path: ["a0", "snapshots"] }],
    });
    expect(partial?.kind).toBe("error");
    expect(partial).toEqual({
      kind: "error",
      reason: "OpenNeuro sent data and an error for ds003645: resolver failed",
    });
    const other = readOf({
      data: { a0: good },
      errors: [{ message: "x", path: ["a1"] }],
    });
    expect(other?.kind).toBe("snapshot");
  });

  test("no latestSnapshot beside a non-empty list is an error; beside an empty list it is none", () => {
    const contradiction = readOf({
      data: { a0: { ...good, latestSnapshot: null } },
    });
    expect(contradiction?.kind).toBe("error");
    expect(readOf({ data: { a0: { ...good, latestSnapshot: undefined } } })?.kind).toBe("error");
    expect(readOf({ data: { a0: { ...good, latestSnapshot: null, snapshots: [] } } })).toEqual({
      kind: "snapshot",
      latest: null,
      snapshots: [],
    });
  });

  test("'does not exist' is an absence only for this alias's own id", () => {
    const nullWith = (message: string) =>
      readOf({ data: { a0: null }, errors: [{ message, path: ["a0"] }] });
    expect(nullWith("Dataset ds003645 does not exist.")?.kind).toBe("absent");
    expect(nullWith("Dataset ds003645 does not exist")?.kind).toBe("absent");
    for (const foreign of [
      'relation "snapshots" does not exist',
      "Dataset ds000002 does not exist.",
      "The user does not exist",
      "Dataset ds003645 does not exist. Retry later",
      "Datasets ds003645 does not exist.",
      "Error: Dataset ds003645 does not exist.",
    ]) {
      expect(nullWith(foreign)?.kind).toBe("error");
    }
    // The id is matched literally, not as a pattern.
    const dotted = parseUpstreamSnapshotBatch(
      {
        data: { a0: null },
        errors: [{ message: "Dataset dsX00001 does not exist.", path: ["a0"] }],
      },
      ["ds.00001"],
    );
    expect(dotted.get("ds.00001")?.kind).toBe("error");
  });

  test("a missing alias is an error", () => {
    expect(readOf({ data: { a1: good } })?.kind).toBe("error");
  });
});

// The helper is pure, so these tests send nothing: an address that is not a loopback one is `.invalid`
// (RFC 2606), which no resolver answers, and the property read is the string the helper returns.
describe("snapshotGraphqlUrl: the override is a test seam, not a production setting", () => {
  const ELSEWHERE = "https://openneuro.example.invalid/crn/graphql";
  const LOOPBACK = "http://127.0.0.1:43210/crn/graphql";

  test("no override, or a blank one, is OpenNeuro's own endpoint in every environment", () => {
    for (const environment of ["production", "development", "staging", "test", undefined]) {
      for (const binding of [undefined, "", "   "]) {
        const env = { ENVIRONMENT: environment as never, OPENNEURO_GRAPHQL_URL: binding };
        expect([environment, binding, snapshotGraphqlUrl(env)]).toEqual([
          environment,
          binding,
          OPENNEURO_GRAPHQL_URL,
        ]);
      }
    }
  });

  test("production ignores an override that is not a loopback address", () => {
    for (const value of [
      ELSEWHERE,
      "http://openneuro.example.invalid/crn/graphql",
      // Names that only look like loopback ones.
      "http://localhost.example.invalid/crn/graphql",
      "http://127.0.0.1.example.invalid/crn/graphql",
      "http://127.0.0.1@example.invalid/crn/graphql",
      "https://127.0.0.1/crn/graphql",
      "http://127.0.0.2/crn/graphql",
      "not a url",
    ]) {
      expect([
        value,
        snapshotGraphqlUrl({ ENVIRONMENT: "production", OPENNEURO_GRAPHQL_URL: value }),
      ]).toEqual([value, OPENNEURO_GRAPHQL_URL]);
    }
  });

  test("an environment that is not exactly a non-production one counts as production", () => {
    // Fail-closed, as testS3EndpointOverride is: a misspelled or missing ENVIRONMENT is not a
    // reason to send the reads somewhere.
    for (const ENVIRONMENT of ["Production", " production", "prod", "", "dev", undefined]) {
      expect([
        ENVIRONMENT,
        snapshotGraphqlUrl({
          ENVIRONMENT: ENVIRONMENT as never,
          OPENNEURO_GRAPHQL_URL: ELSEWHERE,
        }),
      ]).toEqual([ENVIRONMENT, OPENNEURO_GRAPHQL_URL]);
    }
  });

  test("development, staging and test honor the override", () => {
    for (const ENVIRONMENT of ["development", "staging", "test"] as const) {
      expect([
        ENVIRONMENT,
        snapshotGraphqlUrl({ ENVIRONMENT, OPENNEURO_GRAPHQL_URL: ELSEWHERE }),
      ]).toEqual([ENVIRONMENT, ELSEWHERE]);
      expect(snapshotGraphqlUrl({ ENVIRONMENT, OPENNEURO_GRAPHQL_URL: `  ${LOOPBACK}  ` })).toBe(
        LOOPBACK,
      );
    }
  });

  test("a loopback http address is honored in production too, for the suites that run the scheduler", () => {
    for (const value of [
      LOOPBACK,
      "http://localhost:43210/crn/graphql",
      "http://[::1]:43210/crn/graphql",
    ]) {
      expect([
        value,
        snapshotGraphqlUrl({ ENVIRONMENT: "production", OPENNEURO_GRAPHQL_URL: value }),
      ]).toEqual([value, value]);
    }
  });
});

/**
 * Runs `fn` with `fetch` told where each host goes, as `withFakeS3` in `doctor-fix-route.test.ts`
 * does: OpenNeuro's own host (`openneuro.org`) is answered by the local stand-in, and every other
 * host is answered 599 here and never reaches a network. The hosts asked are returned, so a test
 * sees WHERE the reader posted without anything leaving the machine. The real `fetch` comes back
 * even if `fn` throws.
 */
async function withHostsRouted<T>(fn: () => Promise<T>): Promise<{ value: T; hosts: string[] }> {
  const realFetch = globalThis.fetch;
  const hosts: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    hosts.push(url.hostname);
    if (url.hostname === "openneuro.org") return realFetch(new Request(standin.url, req));
    if (url.hostname === "127.0.0.1") return realFetch(req);
    return Promise.resolve(new Response("not routed in this test", { status: 599 }));
  }) as typeof fetch;
  try {
    return { value: await fn(), hosts };
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("readUpstreamSnapshots posts where snapshotGraphqlUrl says", () => {
  const ELSEWHERE = "https://openneuro.example.invalid/crn/graphql";

  test("production posts to OpenNeuro's own host whatever an override names", async () => {
    const { value, hosts } = await withHostsRouted(() =>
      readUpstreamSnapshots({ ENVIRONMENT: "production", OPENNEURO_GRAPHQL_URL: ELSEWHERE }, [
        ...RECORDED_IDS,
      ]),
    );
    expect(hosts).toEqual(["openneuro.org"]);
    expect(standin.log).toHaveLength(1);
    expect(value.errors).toEqual([]);
  });

  test("an unknown environment posts to OpenNeuro's own host as production does", async () => {
    const { hosts } = await withHostsRouted(() =>
      readUpstreamSnapshots({ OPENNEURO_GRAPHQL_URL: ELSEWHERE }, [...RECORDED_IDS]),
    );
    expect(hosts).toEqual(["openneuro.org"]);
  });

  test("a non-production environment posts where the override says, and nothing reaches the stand-in", async () => {
    const { value, hosts } = await withHostsRouted(() =>
      readUpstreamSnapshots({ ENVIRONMENT: "staging", OPENNEURO_GRAPHQL_URL: ELSEWHERE }, [
        ...RECORDED_IDS,
      ]),
    );
    expect(hosts).toEqual(["openneuro.example.invalid"]);
    expect(standin.log).toHaveLength(0);
    expect(value.errors[0]).toContain("599");
  });

  test("production reaches a loopback stand-in, as the suites that run the scheduler need", async () => {
    const { hosts } = await withHostsRouted(() =>
      readUpstreamSnapshots({ ENVIRONMENT: "production", OPENNEURO_GRAPHQL_URL: standin.url }, [
        ...RECORDED_IDS,
      ]),
    );
    expect(hosts).toEqual(["127.0.0.1"]);
    expect(standin.log).toHaveLength(1);
  });
});

describe("readUpstreamSnapshots against the stand-in", () => {
  test("the recorded ids are read in one request with the recorded verdicts", async () => {
    const result = await readUpstreamSnapshots(env(), RECORDED_IDS);
    expect(result.requests).toBe(1);
    expect(result.errors).toEqual([]);
    expect(standin.log).toHaveLength(1);
    expect(standin.log[0]?.ids).toEqual(RECORDED_IDS);
    expect(standin.log[0]?.userAgent).toBe("NEMAR-API");
    expect(standin.log[0]?.contentType).toBe("application/json");
    expect([...result.reads.entries()].map(([id, r]) => [id, r.kind])).toEqual([
      ["ds003645", "snapshot"],
      ["ds004362", "snapshot"],
      ["ds000001", "snapshot"],
      ["ds006903", "deleted"],
      ["ds999999", "absent"],
      ["ds002893", "snapshot"],
      ["ds003082", "snapshot"],
    ]);
  });

  test("120 ids make 3 requests of at most 50 variables each, and duplicates are asked once", async () => {
    standin.synthetic(true);
    const ids = Array.from({ length: 120 }, (_, i) => `ds${String(i + 1).padStart(6, "0")}`);
    const result = await readUpstreamSnapshots(env(), [...ids, ...ids.slice(0, 10)]);
    expect(OPENNEURO_SNAPSHOT_BATCH).toBe(50);
    expect(result.requests).toBe(3);
    expect(standin.log.map((r) => r.ids.length)).toEqual([50, 50, 20]);
    expect(standin.log.flatMap((r) => r.ids)).toEqual(ids);
    expect(result.reads.size).toBe(120);
    for (const logged of standin.log) {
      for (const id of logged.ids) expect(logged.query).not.toContain(id);
    }
  });

  test("no ids is no request", async () => {
    const result = await readUpstreamSnapshots(env(), []);
    expect(result.requests).toBe(0);
    expect(standin.log).toHaveLength(0);
  });

  test("a 503 turns the whole batch into error reads and names the status", async () => {
    standin.status(503);
    const result = await readUpstreamSnapshots(env(), RECORDED_IDS);
    expect([...result.reads.values()].every((r) => r.kind === "error")).toBe(true);
    expect(result.reads.size).toBe(RECORDED_IDS.length);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("503");
  });

  test("a hang past the timeout turns the batch into error reads", async () => {
    standin.hang();
    const started = Date.now();
    const result = await readUpstreamSnapshots(env(), RECORDED_IDS, { timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect([...result.reads.values()].every((r) => r.kind === "error")).toBe(true);
    expect(result.errors).toHaveLength(1);
  });

  test("a body that is not JSON turns the batch into error reads", async () => {
    standin.text("not json");
    const result = await readUpstreamSnapshots(env(), RECORDED_IDS);
    expect([...result.reads.values()].every((r) => r.kind === "error")).toBe(true);
    expect(result.errors[0]).toContain("not JSON");
  });

  test("an unreachable server never throws", async () => {
    const result = await readUpstreamSnapshots({ OPENNEURO_GRAPHQL_URL: "http://127.0.0.1:1/x" }, [
      "ds003645",
    ]);
    expect(result.reads.get("ds003645")?.kind).toBe("error");
    expect(result.errors).toHaveLength(1);
  });

  test("a node answering another id and a snapshots that is not a list are errors", async () => {
    standin.override("ds003645", { id: "ds000002", latestSnapshot: null, snapshots: [] });
    standin.override("ds004362", { id: "ds004362", latestSnapshot: null, snapshots: "none" });
    const result = await readUpstreamSnapshots(env(), RECORDED_IDS);
    expect(result.reads.get("ds003645")?.kind).toBe("error");
    expect(result.reads.get("ds004362")?.kind).toBe("error");
    expect(result.reads.get("ds002893")?.kind).toBe("snapshot");
  });

  test("a failed batch leaves the other batches' reads intact", async () => {
    standin.synthetic(true);
    const ids = Array.from({ length: 51 }, (_, i) => `ds${String(i + 1).padStart(6, "0")}`);
    // The second batch holds only ds000051; a node naming another dataset fails that read alone.
    standin.override("ds000051", { id: "ds000999", latestSnapshot: null, snapshots: [] });
    const result = await readUpstreamSnapshots(env(), ids);
    expect(result.requests).toBe(2);
    expect(result.reads.get("ds000001")?.kind).toBe("snapshot");
    expect(result.reads.get("ds000051")?.kind).toBe("error");
  });

  test("batch-level errors stay bounded at ten while every id still has a read", async () => {
    standin.status(503);
    const ids = Array.from({ length: 600 }, (_, i) => `ds${String(i + 1).padStart(6, "0")}`);
    const result = await readUpstreamSnapshots(env(), ids);
    expect(result.requests).toBe(12);
    expect(result.errors).toHaveLength(10);
    expect(result.reads.size).toBe(600);
  });
});
