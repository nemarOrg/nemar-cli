/**
 * What `createEzidVersionDoi({ reserveOnly })` actually sends to EZID (#1447).
 *
 * An anonymous release has to mint its version identifier -- that step is the
 * only thing that dispatches the central manifest job, so without it the
 * dataset is public with no `dataset_versions` row and the data plane answers
 * "Version not published" -- and it must NOT make the identifier resolve, since
 * ADR 0065 A6 keeps a concealed deposit citable by its landing page alone.
 * "Does not resolve" is a property of the bytes on the wire, so that is what
 * these tests read.
 *
 * WHY NOT A SOURCE SCAN
 * ---------------------
 * The first guard for this was one: a grep asserting that
 * `services/central-manifest.ts` passes `reserveOnly` when the dataset is
 * anonymous. A reviewer deleted the entire `if (opts.reserveOnly) { return ...
 * }` block from `services/doi.ts` and every anonymity suite still passed,
 * because the scan was reading a different file than the one holding the
 * guarantee. The call site being right is worth pinning, but it is not evidence
 * that the flag does anything.
 *
 * Real engine: the real `createEzidVersionDoi`, the real EZID client, the real
 * ANVL wire format, and a local `Bun.serve()` standing in for the registrar via
 * `NEMAR_EZID_API_URL` (the override `backend/test/doi-attribution-routes.test.ts`
 * added). Nothing here stubs a NEMAR function. The stand-in keeps an
 * identifier store so PUT/GET/POST sequencing behaves like EZID does: creating
 * an existing identifier fails with "already exists", which is the branch the
 * resume tests need.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createEzidVersionDoi } from "../src/services/doi";
import type { EzidStatus } from "../src/services/ezid";

const DATASET_ID = "nm099811";
const VERSION = "1.0.0";
// The sandbox shoulder, which is `doi:10.5072/FK2` with no `NEMAR.` segment
// (services/ezid.ts TEST_SHOULDER). `extractDoi` lowercases, so the identifier
// EZID is addressed by and the DOI recorded in D1 differ in case.
const CONCEPT_IDENTIFIER = "doi:10.5072/FK2NM099811";
const VERSION_IDENTIFIER = "doi:10.5072/FK2NM099811.V1.0.0";
const VERSION_DOI = "10.5072/fk2nm099811.v1.0.0";

const ENV = {
  EZID_SANDBOX_USERNAME: "apitest",
  EZID_SANDBOX_PASSWORD: "apitest",
  EZID_USERNAME: "unused",
  EZID_PASSWORD: "unused",
  FRONTEND_URL: "https://nemar.example",
};

/** The blinded description an anonymous release reads (ADR 0065). */
const BLINDED = {
  Name: "A concealed deposit with a long enough descriptive name",
  Authors: ["Anonymous (withheld until publication)"],
  License: "CC0",
};

/** The same dataset after de-anonymization, which is what publication reads. */
const NAMED = {
  Name: "A concealed deposit with a long enough descriptive name",
  Authors: ["Rivera, Dana"],
  License: "CC0",
};

interface EzidWrite {
  method: string;
  path: string;
  fields: Record<string, string>;
}

/** Every write the Worker made to the stand-in, oldest first. */
let writes: EzidWrite[] = [];
/** The stand-in's identifier store: identifier -> its ANVL fields. */
let store: Map<string, Record<string, string>>;
let server: ReturnType<typeof Bun.serve>;

/** Decode an ANVL request body the way EZID would. */
function parseAnvl(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const idx = line.indexOf(": ");
    if (idx === -1) continue;
    fields[decodeURIComponent(line.slice(0, idx))] = decodeURIComponent(line.slice(idx + 2));
  }
  return fields;
}

function anvlBody(identifier: string, fields: Record<string, string>): string {
  const lines = [`success: ${identifier}`];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`${k}: ${v.replace(/%/g, "%25").replace(/\n/g, "%0A")}`);
  }
  return lines.join("\n");
}

/** Seed the store as if a prior run had left the identifier in `status`. */
function seedIdentifier(status: EzidStatus, dataciteXml: string) {
  store.set(VERSION_IDENTIFIER, {
    _status: status,
    _target: `https://nemar.example/datasets/${DATASET_ID}?v=1.0.0`,
    _profile: "datacite",
    _created: "1700000000",
    _updated: "1700000000",
    _owner: "apitest",
    _ownergroup: "apitest",
    datacite: dataciteXml,
  });
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      // `/id/doi:10.5072/...` -- the identifier is everything after `/id/`.
      const identifier = decodeURIComponent(url.pathname.replace(/^\/id\//, ""));
      if (req.method === "GET") {
        const fields = store.get(identifier);
        if (!fields) return new Response("error: bad request - no such identifier");
        return new Response(anvlBody(identifier, fields));
      }
      const fields = parseAnvl(await req.text());
      writes.push({ method: req.method, path: url.pathname, fields });
      if (req.method === "PUT") {
        // EZID's create: refuses an identifier that already exists, which is
        // what drives the resume branch in createEzidVersionDoi.
        if (store.has(identifier)) {
          return new Response("error: identifier already exists");
        }
        store.set(identifier, {
          _profile: "datacite",
          _created: "1700000000",
          _updated: "1700000000",
          _owner: "apitest",
          _ownergroup: "apitest",
          ...fields,
        });
        return new Response(`success: ${identifier}`);
      }
      if (req.method === "POST") {
        // EZID's update: merges the supplied fields into the record.
        const existing = store.get(identifier);
        if (!existing) return new Response("error: bad request - no such identifier");
        store.set(identifier, { ...existing, ...fields });
        return new Response(`success: ${identifier}`);
      }
      return new Response("error: method not allowed", { status: 405 });
    },
  });
  (globalThis as { NEMAR_EZID_API_URL?: string }).NEMAR_EZID_API_URL =
    `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  (globalThis as { NEMAR_EZID_API_URL?: string }).NEMAR_EZID_API_URL = undefined;
});

beforeEach(() => {
  writes = [];
  store = new Map();
  // The concept identifier exists and is itself reserved, which is the state
  // `doi_create` leaves it in for a concealed deposit.
  store.set(CONCEPT_IDENTIFIER, {
    _status: "reserved",
    _target: `https://nemar.example/datasets/${DATASET_ID}`,
    _profile: "datacite",
    _created: "1700000000",
    _updated: "1700000000",
    _owner: "apitest",
    _ownergroup: "apitest",
    datacite: "<resource/>",
  });
});

/** Writes that set a status, in order. Reads the wire, not our own arguments. */
function statusWrites(): string[] {
  return writes.filter((w) => w.fields._status).map((w) => w.fields._status);
}

function mint(opts: { reserveOnly?: boolean; description?: Record<string, unknown> }) {
  return createEzidVersionDoi(ENV, {
    datasetId: DATASET_ID,
    conceptIdentifier: CONCEPT_IDENTIFIER,
    version: VERSION,
    bidsDescription: opts.description ?? BLINDED,
    githubRepo: `nemarDatasets/${DATASET_ID}`,
    sandbox: true,
    reserveOnly: opts.reserveOnly,
  });
}

describe("an anonymous release reserves the version identifier and stops", () => {
  test("nothing on the wire ever sets the identifier public", async () => {
    const result = await mint({ reserveOnly: true });

    expect(result.status).toBe("reserved");
    expect(result.doi).toBe(VERSION_DOI);
    // One write, and it reserves. This is the assertion the deleted-guard
    // mutation has to fail: without the early return the function goes on to
    // POST `_status: public`, and a second entry appears here.
    expect(statusWrites()).toEqual(["reserved"]);
    expect(store.get(VERSION_IDENTIFIER)?._status).toBe("reserved");
  });

  test("the concept record is left alone", async () => {
    await mint({ reserveOnly: true });

    // The published path POSTs a rebuilt `datacite` to the concept identifier
    // to add its HasVersion relation. For a concealed deposit that record is
    // reserved too, so the relation would be invisible either way -- and not
    // touching it is what `doi_sync` already does for these rows.
    expect(writes.filter((w) => w.path === `/id/${CONCEPT_IDENTIFIER}`)).toEqual([]);
    expect(store.get(CONCEPT_IDENTIFIER)?.datacite).toBe("<resource/>");
  });

  test("re-running an anonymous release adopts its own reserved identifier", async () => {
    // Idempotence: the release can be retried, and the second run finds the
    // identifier already there. It must NOT take the #900 crash-resume branch,
    // which would complete the very transition the flag exists to prevent.
    seedIdentifier("reserved", "<resource>blinded</resource>");

    const result = await mint({ reserveOnly: true });

    expect(result.status).toBe("reserved");
    expect(statusWrites()).toEqual(["reserved"]); // the refused create, and nothing else
    expect(store.get(VERSION_IDENTIFIER)?._status).toBe("reserved");
  });

  test("an already-resolving identifier is refused, not adopted", async () => {
    // `public` is the one pre-existing state a normal republish returns happily
    // (the prior mint finished the job). Under `reserveOnly` it means this
    // version already resolves and DataCite has harvested it, so reporting
    // success would record the leak as the intended state.
    seedIdentifier("public", "<resource>blinded</resource>");

    await expect(mint({ reserveOnly: true })).rejects.toThrow(
      /already exists with status "public".*anonymous release requires a reserved identifier/s,
    );
    expect(store.get(VERSION_IDENTIFIER)?._status).toBe("public"); // untouched
  });

  test("a tombstoned identifier is refused too", async () => {
    seedIdentifier("unavailable", "<resource>blinded</resource>");

    await expect(mint({ reserveOnly: true })).rejects.toThrow(/anonymous release requires/);
    expect(store.get(VERSION_IDENTIFIER)?._status).toBe("unavailable");
  });
});

describe("publishing a formerly-concealed version rewrites its attribution", () => {
  test("completing a reserved identifier resends the DataCite record", async () => {
    // The bug this covers: `makePublic` sends `_status` and `_target` and
    // nothing else, so the record EZID keeps is the one the identifier was
    // RESERVED with -- built during the anonymous release, when the only author
    // available was the blinded label. Publishing it unchanged hands DataCite
    // "Anonymous (withheld until publication)" as the version's PERMANENT
    // creator, which is the one failure mode ADR 0065 calls irreversible.
    seedIdentifier(
      "reserved",
      "<resource><creators><creator><creatorName>Anonymous (withheld until publication)</creatorName></creator></creators></resource>",
    );

    const result = await mint({ reserveOnly: false, description: NAMED });

    expect(result.status).toBe("public");
    const record = store.get(VERSION_IDENTIFIER);
    expect(record?._status).toBe("public");
    expect(record?.datacite).toContain("Rivera, Dana");
    expect(record?.datacite).not.toContain("Anonymous (withheld until publication)");
  });

  test("the flip and the metadata arrive in the same request", async () => {
    // Two requests would leave a window in which the identifier resolves with
    // the blinded record, which is long enough for a harvester.
    seedIdentifier("reserved", "<resource>blinded</resource>");

    await mint({ reserveOnly: false, description: NAMED });

    const flip = writes.find((w) => w.fields._status === "public");
    expect(flip).toBeDefined();
    expect(flip?.fields.datacite).toContain("Rivera, Dana");
  });

  test("without the flag a fresh mint still ends public", async () => {
    // The control: `reserveOnly` is the deviation, and the ordinary path must
    // be unaffected by it. Reserve-then-public is EZID's required sequence for
    // a caller-specified DOI, so both statuses appear, in that order.
    const result = await mint({ reserveOnly: false, description: NAMED });

    expect(result.status).toBe("public");
    expect(statusWrites()).toEqual(["reserved", "public"]);
    expect(store.get(VERSION_IDENTIFIER)?._status).toBe("public");
  });
});
