/**
 * The publication, version and import hooks, and the daily reconcile (epic #1586,
 * phase 4; ADR 0084).
 *
 * The rule under test: the writer runs as a STEP of those flows and must NEVER fail,
 * block or delay any of them. So:
 *   - off (the default) it does nothing at all, not even a read;
 *   - on, it runs in `waitUntil`, after the flow has answered, and the flow's own
 *     answer is the same whether the writer works, fails or hangs;
 *   - every kind of failure (D1, R2, the data plane, a throwing `waitUntil`) is
 *     contained.
 * Each hook is driven THROUGH ITS REAL ENTRY POINT: the real worker, the manifest-ready
 * callback with its real HMAC token, the import-state callback, the publication
 * approval route; and the reconcile through the cron wrapper.
 *
 * Real engines throughout (see helpers/neurobagel-harness). The two network boundaries
 * the callbacks themselves use are substituted narrowly: S3 (a HEAD the manifest
 * callback sends to an `amazonaws.com` host) and the GitHub API, both to the local
 * stand-in.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PUBLICATION_STEPS } from "../../shared/publication-steps";
import worker from "../src/index";
import { signManifestCallbackToken } from "../src/services/github/callback-tokens";
import {
  runNeurobagelReconcileCron,
  runNeurobagelWriter,
  scheduleNeurobagelSync,
} from "../src/services/neurobagel-writer";
import { hashApiKey } from "../src/services/token";
import type { Bindings } from "../src/types/bindings";
import { wrapD1 } from "./helpers/d1";
import {
  type Harness,
  recordWrites,
  seedSynthetic,
  startHarness,
  storeKeys,
} from "./helpers/neurobagel-harness";

let h: Harness;
const realFetch = globalThis.fetch;
const quiet = { error: console.error, warn: console.warn, log: console.log };

beforeAll(async () => {
  h = await startHarness();
  // The GitHub REST API, for the metadata refresh the version callback starts: nothing
  // there answers, which the refresh treats as non-fatal, as it does in production.
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = h.standin.url;
});
afterAll(async () => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  await h.dispose();
});
beforeEach(async () => {
  await h.reset();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = quiet.error;
  console.warn = quiet.warn;
  console.log = quiet.log;
});

/** A `waitUntil` that keeps what it is handed, so a test can settle it and look at it. */
function collector() {
  const work: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => {
      work.push(p);
    },
    count: () => work.length,
    settle: async () => {
      // Work may start more work; settle until it stops.
      let seen = 0;
      while (seen < work.length) {
        const batch = work.slice(seen);
        seen = work.length;
        await Promise.all(batch);
      }
    },
  };
}

const API = "https://api.nemar.org";

/** Send the S3 HEADs the manifest callback makes (to an amazonaws.com host) to the stand-in. */
function routeS3ToStandin(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname.endsWith(".amazonaws.com")) {
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
      return realFetch(`${h.standin.url}${url.pathname}`, {
        method: input instanceof Request ? input.method : (init?.method ?? "GET"),
        headers,
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

const objectsAfter = async () => (await storeKeys(h.bucket)).filter((k) => k !== "index.json");

// ----------------------------------------------------------------------------
// The hook itself
// ----------------------------------------------------------------------------

describe("scheduleNeurobagelSync", () => {
  test("OFF by default: no read, no write, no waitUntil, nothing", async () => {
    seedSynthetic(h, "nm000960");
    const statements: string[] = [];
    const d1 = wrapD1(h.env().DB, (sql) => {
      statements.push(sql);
    });
    const c = collector();
    scheduleNeurobagelSync(
      h.env({ DB: d1, NEUROBAGEL_WRITER_ENABLED: undefined }),
      c.waitUntil,
      "nm000960",
      "hook:publication",
    );
    await c.settle();
    expect(c.count()).toBe(0);
    expect(statements).toEqual([]);
    expect(h.standin.log).toEqual([]);
    expect(await storeKeys(h.bucket)).toEqual([]);
  });

  test("any value but exactly '1' is off", () => {
    const c = collector();
    for (const value of ["0", "true", "yes", "", " 1", "1 "]) {
      scheduleNeurobagelSync(
        h.env({ NEUROBAGEL_WRITER_ENABLED: value }),
        c.waitUntil,
        "nm000960",
        "hook:publication",
      );
    }
    expect(c.count()).toBe(0);
  });

  test("an id that can never be federated returns before any read", async () => {
    const statements: string[] = [];
    const d1 = wrapD1(h.env().DB, (sql) => {
      statements.push(sql);
    });
    const c = collector();
    for (const id of ["xx000042", "nm099900", "nm099998", "nm099999", "ds000117", "garbage"]) {
      scheduleNeurobagelSync(h.env({ DB: d1 }), c.waitUntil, id, "hook:import");
    }
    expect(c.count()).toBe(0);
    expect(statements).toEqual([]);
  });

  test("with no bucket it logs and does nothing", () => {
    const c = collector();
    const warnings: string[] = [];
    console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
    scheduleNeurobagelSync(
      h.env({ NEUROBAGEL: undefined }),
      c.waitUntil,
      "nm000960",
      "hook:import",
    );
    expect(c.count()).toBe(0);
    expect(warnings.join(" ")).toContain("store_unconfigured");
  });

  test("on: it returns at once, hands ONE piece of work to waitUntil, and writes after", async () => {
    seedSynthetic(h, "nm000960");
    const c = collector();
    const returned = scheduleNeurobagelSync(h.env(), c.waitUntil, "nm000960", "hook:publication");
    expect(returned).toBeUndefined();
    expect(c.count()).toBe(1);
    await c.settle();
    expect(await objectsAfter()).toEqual([
      "nm000960.jsonld",
      "nm000960_annotated.json",
      "nm000960_dataset_description.json",
    ]);
  });

  test("a dataset that is not eligible yet (no version row) is a no-op, and a later hook picks it up", async () => {
    seedSynthetic(h, "nm000961", { versions: [] });
    const c = collector();
    scheduleNeurobagelSync(h.env(), c.waitUntil, "nm000961", "hook:publication");
    await c.settle();
    expect(await storeKeys(h.bucket)).toEqual([]);
    h.db.run(
      "INSERT INTO dataset_versions (dataset_id, version, doi, provider) VALUES ('nm000961', '1.0.0', '10.5072/FK2x', 'ezid')",
    );
    scheduleNeurobagelSync(h.env(), c.waitUntil, "nm000961", "hook:version");
    await c.settle();
    expect(await objectsAfter()).toContain("nm000961.jsonld");
  });

  test("idempotent: the same hook twice is one set of writes", async () => {
    seedSynthetic(h, "nm000962");
    const rec = recordWrites(h.bucket);
    const env = h.env({ NEUROBAGEL: rec.bucket });
    const c = collector();
    scheduleNeurobagelSync(env, c.waitUntil, "nm000962", "hook:version");
    await c.settle();
    const afterFirst = rec.log.length;
    expect(afterFirst).toBe(4);
    scheduleNeurobagelSync(env, c.waitUntil, "nm000962", "hook:version");
    await c.settle();
    expect(rec.log.length).toBe(afterFirst);
  });

  test("it removes a dataset that stopped being eligible, from the hook that saw the change", async () => {
    seedSynthetic(h, "nm000963");
    const c = collector();
    scheduleNeurobagelSync(h.env(), c.waitUntil, "nm000963", "hook:version");
    await c.settle();
    expect(await objectsAfter()).toContain("nm000963.jsonld");
    h.db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000963'");
    scheduleNeurobagelSync(h.env(), c.waitUntil, "nm000963", "hook:publication");
    await c.settle();
    expect(await objectsAfter()).toEqual([]);
  });
});

describe("it never throws into the flow", () => {
  test("D1 down: the work resolves, the failure is logged, the caller saw nothing", async () => {
    seedSynthetic(h, "nm000964");
    const d1 = wrapD1(h.env().DB, () => {
      throw new Error("D1 is down");
    });
    const logged: string[] = [];
    console.error = (...a: unknown[]) => logged.push(a.join(" "));
    const c = collector();
    expect(() =>
      scheduleNeurobagelSync(h.env({ DB: d1 }), c.waitUntil, "nm000964", "hook:publication"),
    ).not.toThrow();
    await expect(c.settle()).resolves.toBeUndefined();
    expect(logged.join(" ")).toContain("D1 is down");
  });

  test("R2 failing to list: contained, and the store is as it was", async () => {
    seedSynthetic(h, "nm000965");
    const broken = new Proxy(h.bucket, {
      get(target, prop) {
        if (prop === "list") return async () => Promise.reject(new Error("R2 list failed"));
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;
    const logged: string[] = [];
    console.error = (...a: unknown[]) => logged.push(a.join(" "));
    const c = collector();
    scheduleNeurobagelSync(h.env({ NEUROBAGEL: broken }), c.waitUntil, "nm000965", "hook:import");
    await expect(c.settle()).resolves.toBeUndefined();
    expect(logged.join(" ")).toContain("R2 list failed");
    expect(await storeKeys(h.bucket)).toEqual([]);
  });

  test("an unreadable object in the store: the run reports it and does not throw", async () => {
    seedSynthetic(h, "nm000966");
    // An object whose reading fails: a conditional write that cannot be satisfied.
    const failing = new Proxy(h.bucket, {
      get(target, prop) {
        if (prop === "put") return async () => Promise.reject(new Error("R2 put refused"));
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;
    const result = await runNeurobagelWriter(h.env({ NEUROBAGEL: failing }), {
      trigger: "hook:version",
      execute: true,
      only: ["nm000966"],
    });
    expect(result.results[0]?.outcome).toBe("error");
    expect((result.results[0] as { error: string }).error).toContain("R2 put refused");
    expect(await storeKeys(h.bucket)).toEqual([]);
  });

  test("a waitUntil that throws, and a missing waitUntil, do not reach the caller", async () => {
    const throwing = () => {
      throw new Error("waitUntil is not available");
    };
    console.error = () => {};
    expect(() =>
      scheduleNeurobagelSync(h.env(), throwing, "nm000960", "hook:publication"),
    ).not.toThrow();
    expect(() =>
      scheduleNeurobagelSync(h.env(), undefined, "nm000960", "hook:publication"),
    ).not.toThrow();
    // The work both calls started is unawaited by design; let it finish before the next test resets D1.
    await Bun.sleep(100);
  });

  test("a rejected `after` (the metadata refresh failed) does not stop the sync", async () => {
    seedSynthetic(h, "nm000967");
    const c = collector();
    scheduleNeurobagelSync(h.env(), c.waitUntil, "nm000967", "hook:version", {
      after: Promise.reject(new Error("refresh failed")),
    });
    await c.settle();
    expect(await objectsAfter()).toContain("nm000967.jsonld");
  });

  test("the sync waits for `after`: it reads the columns the refresh wrote", async () => {
    seedSynthetic(h, "nm000968");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const c = collector();
    scheduleNeurobagelSync(h.env(), c.waitUntil, "nm000968", "hook:version", { after: gate });
    // The refresh has not finished, so the writer has not started.
    await Bun.sleep(30);
    expect(await storeKeys(h.bucket)).toEqual([]);
    h.db.run("UPDATE datasets SET name = 'Refreshed name' WHERE dataset_id = 'nm000968'");
    release();
    await c.settle();
    const { listStore } = await import("../src/services/neurobagel-store");
    const stored = (await listStore(h.bucket)).datasets.get("nm000968");
    expect(stored?.jsonld).toBeTruthy();
    expect(await (await h.bucket.get("nm000968.jsonld"))?.text()).toContain("Refreshed name");
  });
});

// ----------------------------------------------------------------------------
// The real entry points
// ----------------------------------------------------------------------------

const CALLBACK_SECRET = "manifest-callback-secret-0123456789abcdef";

async function seedManifestJob(id: string, version: string, nonce: string): Promise<string> {
  h.db
    .query(
      `INSERT INTO manifest_jobs (dataset_id, version, nonce, doi, concept_doi, doi_provider, status, request_source)
       VALUES (?, ?, ?, ?, ?, 'ezid', 'dispatched', 'webhook')`,
    )
    .run(id, version, nonce, `10.82901/nemar.${id}.v${version}`, `10.82901/nemar.${id}`);
  return signManifestCallbackToken({ datasetId: id, version, nonce }, CALLBACK_SECRET);
}

function manifestReady(token: string, id: string, env: Bindings, c: ReturnType<typeof collector>) {
  return worker.fetch(
    new Request(`${API}/webhooks/manifest-ready`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Token": token },
      body: JSON.stringify({
        dataset_id: id,
        version: "1.0.0",
        manifest_url: "https://example.invalid/m.json",
        summary_url: "https://example.invalid/s.json",
        totals: { files: 5, bytes: 100, annex: 3, git: 2 },
        workflow_run_id: "1",
      }),
    }),
    env,
    { waitUntil: c.waitUntil, passThroughOnException: () => {} } as unknown as ExecutionContext,
  );
}

describe("the manifest-ready callback (a new published version)", () => {
  test("the version row lands, the callback answers, and the dataset is federated after", async () => {
    // Published, public, first-published, with no version row: not eligible until the
    // callback inserts it.
    seedSynthetic(h, "nm000970", { versions: [] });
    h.standin.put("/nm000970/version/v1.0.0-summary.json", "{}");
    routeS3ToStandin();
    const token = await seedManifestJob("nm000970", "1.0.0", "nonce-970");
    const c = collector();
    const env = h.env({ MANIFEST_CALLBACK_SECRET: CALLBACK_SECRET });

    const res = await manifestReady(token, "nm000970", env, c);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, dataset_id: "nm000970" });
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM dataset_versions WHERE dataset_id = 'nm000970'").get(),
    ).toEqual({ n: 1 });
    await c.settle();
    expect(await objectsAfter()).toEqual([
      "nm000970.jsonld",
      "nm000970_annotated.json",
      "nm000970_dataset_description.json",
    ]);
  });

  test("with the writer off the callback is exactly what it was: no extra work, no store", async () => {
    seedSynthetic(h, "nm000971", { versions: [] });
    h.standin.put("/nm000971/version/v1.0.0-summary.json", "{}");
    routeS3ToStandin();
    const token = await seedManifestJob("nm000971", "1.0.0", "nonce-971");
    const c = collector();
    const env = h.env({
      MANIFEST_CALLBACK_SECRET: CALLBACK_SECRET,
      NEUROBAGEL_WRITER_ENABLED: undefined,
    });
    const res = await manifestReady(token, "nm000971", env, c);
    expect(res.status).toBe(200);
    // The one piece of work the callback always did: the metadata refresh. Nothing of ours.
    expect(c.count()).toBe(1);
    await c.settle();
    expect(await storeKeys(h.bucket)).toEqual([]);
  });

  test("a writer that HANGS cannot hold the callback: it answers 200 all the same", async () => {
    seedSynthetic(h, "nm000972", { versions: [] });
    h.standin.put("/nm000972/version/v1.0.0-summary.json", "{}");
    routeS3ToStandin();
    const token = await seedManifestJob("nm000972", "1.0.0", "nonce-972");
    // The writer's first D1 read never returns.
    const d1 = wrapD1(h.env().DB, (sql) => {
      if (sql.includes("latest_version") && sql.includes("ORDER BY d.dataset_id")) {
        return new Promise<void>(() => {});
      }
    });
    const c = collector();
    const env = h.env({ DB: d1, MANIFEST_CALLBACK_SECRET: CALLBACK_SECRET });
    const started = Date.now();
    const res = await manifestReady(token, "nm000972", env, c);
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
    // The version row is in: the callback's own job was done before the writer's began.
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM dataset_versions WHERE dataset_id = 'nm000972'").get(),
    ).toEqual({ n: 1 });
    expect(await storeKeys(h.bucket)).toEqual([]);
  });

  test("a writer that FAILS cannot fail the callback", async () => {
    seedSynthetic(h, "nm000973", { versions: [] });
    h.standin.put("/nm000973/version/v1.0.0-summary.json", "{}");
    routeS3ToStandin();
    const token = await seedManifestJob("nm000973", "1.0.0", "nonce-973");
    const broken = new Proxy(h.bucket, {
      get(target, prop) {
        if (prop === "list") return async () => Promise.reject(new Error("R2 is down"));
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;
    const c = collector();
    console.error = () => {};
    const res = await manifestReady(
      token,
      "nm000973",
      h.env({ NEUROBAGEL: broken, MANIFEST_CALLBACK_SECRET: CALLBACK_SECRET }),
      c,
    );
    expect(res.status).toBe(200);
    await expect(c.settle()).resolves.toBeUndefined();
  });
});

const WEBHOOK_TOKEN = "import-webhook-token-0123456789abcdef";

function importState(
  status: string,
  id: string,
  c: ReturnType<typeof collector>,
  over: Partial<Bindings> = {},
) {
  return worker.fetch(
    new Request(`${API}/webhooks/import-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Token": WEBHOOK_TOKEN },
      body: JSON.stringify({
        dataset_id: id,
        source: "openneuro",
        source_id: id.replace("on", "ds"),
        stage: "finalize",
        status,
      }),
    }),
    h.env({ NEMAR_WEBHOOK_TOKEN: WEBHOOK_TOKEN, ...over }),
    { waitUntil: c.waitUntil, passThroughOnException: () => {} } as unknown as ExecutionContext,
  );
}

describe("the import-state callback (an import)", () => {
  test("a completed import federates the mirror, after the callback has answered", async () => {
    seedSynthetic(h, "on000980");
    const c = collector();
    const res = await importState("complete", "on000980", c);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "complete" });
    await c.settle();
    expect(await objectsAfter()).toContain("on000980.jsonld");
  });

  test("an import still in flight does nothing", async () => {
    seedSynthetic(h, "on000981");
    const c = collector();
    const res = await importState("preparing", "on000981", c);
    expect(res.status).toBe(200);
    await c.settle();
    expect(c.count()).toBe(0);
    expect(await storeKeys(h.bucket)).toEqual([]);
  });

  test("a completed import of a dataset that is not eligible yet is a no-op", async () => {
    seedSynthetic(h, "on000982", { visibility: "private" });
    const c = collector();
    expect((await importState("complete", "on000982", c)).status).toBe(200);
    await c.settle();
    expect(await storeKeys(h.bucket)).toEqual([]);
  });

  test("with the writer off the callback is untouched", async () => {
    seedSynthetic(h, "on000983");
    const c = collector();
    const res = await importState("complete", "on000983", c, {
      NEUROBAGEL_WRITER_ENABLED: undefined,
    });
    expect(res.status).toBe(200);
    expect(c.count()).toBe(0);
    expect(await storeKeys(h.bucket)).toEqual([]);
  });

  test("a failing writer cannot fail the import callback, which the workflow needs to succeed", async () => {
    seedSynthetic(h, "on000984");
    const d1 = wrapD1(h.env().DB, (sql) => {
      if (sql.includes("latest_version") && sql.includes("ORDER BY d.dataset_id")) {
        throw new Error("D1 is down");
      }
    });
    const c = collector();
    console.error = () => {};
    const res = await importState("complete", "on000984", c, { DB: d1 });
    expect(res.status).toBe(200);
    await expect(c.settle()).resolves.toBeUndefined();
  });
});

const ADMIN_KEY = "nb-hooks-admin-key-0123456789abcdef0123456789abcdef";

describe("the publication approval (a publication)", () => {
  test("a run whose steps are all complete federates the dataset, and answers as before", async () => {
    seedSynthetic(h, "nm000990");
    h.db
      .query(
        `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access)
         VALUES ('hookadmin', 'hookadmin@example.org', 'x', 'approved', 'admin', 1, 1)`,
      )
      .run();
    const admin = h.db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'hookadmin'")
      .get();
    h.db
      .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
      .run(admin?.id ?? 0, await hashApiKey(ADMIN_KEY), ADMIN_KEY.slice(0, 8));
    h.db
      .query(
        `INSERT INTO publication_requests
           (dataset_id, status, requested_by, requested_at, updated_at, steps_completed)
         VALUES ('nm000990', 'approving', ?, datetime('now', '-3 hours'), datetime('now', '-30 minutes'), ?)`,
      )
      .run(admin?.id ?? 0, JSON.stringify(PUBLICATION_STEPS));
    const c = collector();

    const res = await worker.fetch(
      new Request(`${API}/admin/publish/nm000990/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ resume: true }),
      }),
      h.env(),
      { waitUntil: c.waitUntil, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      message: "All steps already completed",
      status: "published",
    });
    await c.settle();
    expect(await objectsAfter()).toContain("nm000990.jsonld");
  });
});

// ----------------------------------------------------------------------------
// The daily reconcile and the dev fences
// ----------------------------------------------------------------------------

describe("the reconcile cron wrapper", () => {
  test("outside production it is skipped before any read or write", async () => {
    seedSynthetic(h, "nm000995");
    for (const environment of ["development", "staging", "test"] as const) {
      const statements: string[] = [];
      const d1 = wrapD1(h.env().DB, (sql) => {
        statements.push(sql);
      });
      const rec = recordWrites(h.bucket);
      const result = await runNeurobagelReconcileCron(
        h.env({ ENVIRONMENT: environment, DB: d1, NEUROBAGEL: rec.bucket }),
      );
      expect(result).toBeNull();
      expect(statements).toEqual([]);
      expect(rec.log).toEqual([]);
    }
    expect(h.standin.log).toEqual([]);
  });

  test("an unset or misspelled ENVIRONMENT is production, and runs", async () => {
    seedSynthetic(h, "nm000995");
    for (const environment of [undefined, "prod", ""] as const) {
      await h.reset();
      seedSynthetic(h, "nm000995");
      const result = await runNeurobagelReconcileCron(h.env({ ENVIRONMENT: environment as never }));
      expect(result?.status).toBe("ok");
    }
  });

  test("in production it reconciles, bounded and in order, and an exemplar is never federated", async () => {
    for (const id of ["nm000995", "nm000996", "nm000997"]) seedSynthetic(h, id);
    // An exemplar: eligible outside production, never in it.
    seedSynthetic(h, "xx099903", { isExemplar: 1, isSandbox: 1 });
    const env = h.env({ ENVIRONMENT: "production", NEUROBAGEL_RECONCILE_MAX: "2" });
    const t1 = await runNeurobagelReconcileCron(env);
    expect(t1?.status).toBe("ok");
    expect(t1?.trigger).toBe("cron");
    expect(t1?.examined).toBe(2);
    expect(t1?.eligible).toBe(3);
    const t2 = await runNeurobagelReconcileCron(env);
    expect(t2?.examined).toBe(2);
    expect(await objectsAfter()).toEqual(
      ["nm000995", "nm000996", "nm000997"]
        .flatMap((id) => [`${id}.jsonld`, `${id}_annotated.json`, `${id}_dataset_description.json`])
        .sort(),
    );
    // The control: outside production the same exemplar IS federated.
    await h.reset();
    seedSynthetic(h, "xx099903", { isExemplar: 1, isSandbox: 1 });
    const staging = await runNeurobagelWriter(h.env({ ENVIRONMENT: "staging" }), {
      trigger: "admin",
      execute: true,
    });
    expect(staging.results.map((r) => `${r.id}:${r.outcome}`)).toEqual(["xx099903:written"]);
  });

  test("with the writer off it does nothing even in production", async () => {
    seedSynthetic(h, "nm000995");
    const rec = recordWrites(h.bucket);
    const result = await runNeurobagelReconcileCron(
      h.env({
        ENVIRONMENT: "production",
        NEUROBAGEL: rec.bucket,
        NEUROBAGEL_WRITER_ENABLED: undefined,
      }),
    );
    expect(result?.status).toBe("disabled");
    expect(rec.log).toEqual([]);
  });

  test("it records one run row, which status reads as the last reconcile", async () => {
    seedSynthetic(h, "nm000995");
    await runNeurobagelReconcileCron(h.env({ ENVIRONMENT: "production" }));
    const rows = h.db
      .query<{ resource_id: string; details: string }, []>(
        "SELECT resource_id, details FROM audit_log WHERE action = 'neurobagel_run'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe("cron");
    expect(JSON.parse(rows[0]?.details ?? "{}")).toMatchObject({ eligible: 1, written: 1 });
  });
});

describe("dev fences: nothing the dev worker does reaches production or a person", () => {
  test("a writer run sends no mail and dispatches nothing to GitHub, whatever it finds", async () => {
    seedSynthetic(h, "nm000998");
    seedSynthetic(h, "nm000999", { anonymous: 1, firstPublishedAt: null });
    const outbound: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      outbound.push(`${init?.method ?? "GET"} ${url.hostname}`);
      return realFetch(input, init);
    }) as typeof fetch;
    // A DEV worker with a live Resend key and the writer deliberately enabled.
    await runNeurobagelWriter(
      h.env({ ENVIRONMENT: "development", RESEND_API_KEY: "re_live_key_that_must_not_be_used" }),
      { trigger: "admin", execute: true },
    );
    // Only the local stand-in was spoken to: never Resend, never GitHub's API.
    expect(outbound.filter((o) => !o.includes("127.0.0.1"))).toEqual([]);
  });

  test("the dev store is the bucket bound to the dev worker, and nothing else is reachable", async () => {
    // The writer takes its bucket from the binding and from nowhere else: with a
    // different binding the objects land there and the default bucket stays empty.
    seedSynthetic(h, "nm000998");
    const other = await h.mf.getR2Bucket("NEUROBAGEL");
    expect(other).toBeTruthy();
    const rec = recordWrites(h.bucket);
    await runNeurobagelWriter(h.env({ NEUROBAGEL: rec.bucket }), {
      trigger: "admin",
      execute: true,
    });
    expect(rec.log.length).toBeGreaterThan(0);
    expect(new Set(rec.log.map((e) => e.key.split(".")[0]?.split("_")[0]))).toEqual(
      new Set(["nm000998", "index"]),
    );
  });
});
