/**
 * Finishing the version identifiers an anonymous release left `reserved`
 * (#1447, ADR 0065).
 *
 * `version_doi` mints the version being published NOW. A concealed release
 * minted one too and stopped at `reserved`, and peer review is precisely the
 * process that produces a revision -- so the ordinary shape at real publication
 * is `1.0.1` public and `1.0.0` still reserved, with nothing that would ever
 * revisit `1.0.0`. Its `dataset_versions` row stops being withheld the moment
 * `anonymous` clears, so the dataset page renders a live `https://doi.org/...`
 * anchor for an identifier that does not resolve.
 *
 * Real engine throughout: the real `completeConcealedEraVersionDois`, the real
 * `createEzidVersionDoi`, the real EZID client and ANVL wire format, the real
 * GitHub Contents API client, and `bun:sqlite` behind `realD1` with every
 * migration applied. The two registrars are local `Bun.serve` stand-ins reached
 * through the `NEMAR_EZID_API_URL` / `NEMAR_GITHUB_API_URL` overrides the other
 * suites use, and both record every request -- so the assertions are about what
 * went on the wire and what the stores hold afterward, not about arguments this
 * test passed in.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { buildVersionIdentifier } from "../src/services/doi";
import type { EzidStatus } from "../src/services/ezid";
import {
  MAX_CONCEALED_ERA_VERSION_DOIS,
  completeConcealedEraVersionDois,
} from "../src/services/publication-orchestrator";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const DATASET_ID = "nm099811";
/** Stored without the `doi:` scheme and lowercased, the way `extractDoi` leaves it. */
const CONCEPT_DOI = "10.5072/fk2nm099811";
const CONCEPT_IDENTIFIER = "doi:10.5072/FK2NM099811";
const REPO = `nemarDatasets/${DATASET_ID}`;

/** The restored attribution: what `main` carries at real publication. */
const RESTORED_AUTHOR = "Rivera, Dana";
const BLINDED_LABEL = "Anonymous (withheld until publication)";
const DESCRIPTION = {
  Name: "A concealed deposit with a long enough descriptive name",
  BIDSVersion: "1.8.0",
  Authors: [RESTORED_AUTHOR],
  License: "CC0",
};

/** The record an anonymous release reserved: blinded, because that is all it had. */
const BLINDED_XML = `<resource><creators><creator><creatorName>${BLINDED_LABEL}</creatorName></creator></creators></resource>`;

function versionIdentifier(version: string): string {
  // The real builder, so the test cannot disagree with production about which
  // identifier a version has.
  return buildVersionIdentifier(DATASET_ID, version, true);
}

// ---------------------------------------------------------------------------
// EZID stand-in (ANVL over HTTP), with an identifier store so PUT/GET/POST
// sequence the way EZID does: creating an existing identifier fails, which is
// the branch every test here goes through.
// ---------------------------------------------------------------------------

interface Recorded {
  method: string;
  path: string;
  fields: Record<string, string>;
}

let ezidSeen: Recorded[] = [];
let store: Map<string, Record<string, string>>;
let ezidServer: ReturnType<typeof Bun.serve>;

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

/** Seed the store as an earlier run would have left an identifier. */
function seedIdentifier(identifier: string, status: EzidStatus, dataciteXml: string): void {
  store.set(identifier, {
    _status: status,
    _target: `https://nemar.example/datasets/${DATASET_ID}`,
    _profile: "datacite",
    _created: "1700000000",
    _updated: "1700000000",
    _owner: "apitest",
    _ownergroup: "apitest",
    datacite: dataciteXml,
  });
}

// ---------------------------------------------------------------------------
// GitHub stand-in: the two Contents API reads `readRepoMetadata` makes with
// `useContentsApi`.
// ---------------------------------------------------------------------------

let githubSeen: string[] = [];
let githubServer: ReturnType<typeof Bun.serve>;
/** What the stand-in says about the repository. `status` forces a failed read. */
const repoState: { description: Record<string, unknown> | null; status: number } = {
  description: DESCRIPTION,
  status: 200,
};

beforeAll(() => {
  ezidServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const identifier = decodeURIComponent(url.pathname.replace(/^\/id\//, ""));
      if (req.method === "GET") {
        ezidSeen.push({ method: "GET", path: url.pathname, fields: {} });
        const fields = store.get(identifier);
        if (!fields) return new Response("error: bad request - no such identifier");
        return new Response(anvlBody(identifier, fields));
      }
      const fields = parseAnvl(await req.text());
      ezidSeen.push({ method: req.method, path: url.pathname, fields });
      if (req.method === "PUT") {
        if (store.has(identifier)) return new Response("error: identifier already exists");
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
        const existing = store.get(identifier);
        if (!existing) return new Response("error: bad request - no such identifier");
        store.set(identifier, { ...existing, ...fields });
        return new Response(`success: ${identifier}`);
      }
      return new Response("error: method not allowed", { status: 405 });
    },
  });
  githubServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      // Path AND query: which ref the attribution is read from is a decision,
      // not an incidental.
      githubSeen.push(`${url.pathname}${url.search}`);
      if (repoState.status !== 200) {
        // A plain 403 (no secondary-rate-limit body) is terminal for
        // githubFetchWithRetry, so an unreadable repository costs no backoff.
        return new Response('{"message":"no"}', { status: repoState.status });
      }
      if (url.pathname === `/repos/${REPO}/contents/dataset_description.json`) {
        if (!repoState.description) return new Response('{"message":"Not Found"}', { status: 404 });
        return Response.json({
          content: btoa(JSON.stringify(repoState.description)),
          encoding: "base64",
        });
      }
      // No enrichment file in this fixture; both spellings are absent.
      return new Response('{"message":"Not Found"}', { status: 404 });
    },
  });
  (globalThis as { NEMAR_EZID_API_URL?: string }).NEMAR_EZID_API_URL =
    `http://127.0.0.1:${ezidServer.port}`;
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${githubServer.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_EZID_API_URL?: string }).NEMAR_EZID_API_URL = undefined;
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  ezidServer.stop(true);
  githubServer.stop(true);
});

let db: Database;

beforeEach(() => {
  ezidSeen = [];
  githubSeen = [];
  store = new Map();
  repoState.description = DESCRIPTION;
  repoState.status = 200;
  // The concept record is public by the time this runs: `publish_doi` is a step
  // of the real publication and precedes the finalize block.
  seedIdentifier(CONCEPT_IDENTIFIER, "public", "<resource/>");
  db = freshDb();
  db.prepare(
    `INSERT INTO users (id, username, email, github_username, status)
     VALUES (1, 'alice', 'alice@nemar.org', 'alice', 'approved')`,
  ).run();
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    GITHUB_ADMIN_PAT: "ghp_stand_in",
    EZID_SANDBOX_USERNAME: "apitest",
    EZID_SANDBOX_PASSWORD: "apitest",
    EZID_USERNAME: "unused",
    EZID_PASSWORD: "unused",
    FRONTEND_URL: "https://nemar.example",
  } as unknown as Bindings;
}

function seedDataset(fields?: { conceptDoi?: string | null; githubRepo?: string | null }): void {
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                           github_repo, anonymous, concept_doi, first_published_at)
     VALUES (?, ?, 1, 'active', 'public', 0, ?, 0, ?, datetime('now'))`,
  ).run(
    DATASET_ID,
    DESCRIPTION.Name,
    fields?.githubRepo === undefined ? REPO : fields.githubRepo,
    fields?.conceptDoi === undefined ? CONCEPT_DOI : fields.conceptDoi,
  );
}

/**
 * The durable record that this deposit was once released under the blind.
 *
 * `status` matters: only a request the orchestrator actually ran (`approving` or
 * `published`) can have reserved anything.
 */
function seedRequest(anonymous: number, status = "published"): void {
  db.prepare(
    `INSERT INTO publication_requests (dataset_id, status, requested_by, anonymous)
     VALUES (?, ?, 1, ?)`,
  ).run(DATASET_ID, status, anonymous);
}

function seedVersion(version: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
     VALUES (?, ?, ?, 'ezid', ?)`,
  ).run(DATASET_ID, version, `10.5072/fk2${DATASET_ID}.v${version}`, createdAt);
}

function run(anonymousRelease = false): Promise<string | undefined> {
  return completeConcealedEraVersionDois(env(), realD1(db), DATASET_ID, anonymousRelease);
}

function auditRows(): { action: string; resource_id: string; details: string }[] {
  return db.prepare("SELECT action, resource_id, details FROM audit_log ORDER BY id").all() as {
    action: string;
    resource_id: string;
    details: string;
  }[];
}

function statusOf(version: string): string | undefined {
  return store.get(versionIdentifier(version))?._status;
}

function dataciteOf(version: string): string | undefined {
  return store.get(versionIdentifier(version))?.datacite;
}

/** Requests to one version identifier, by method. */
function methodsFor(version: string): string[] {
  const path = `/id/${encodeURIComponent(versionIdentifier(version))}`;
  return ezidSeen
    .filter((r) => decodeURIComponent(r.path) === decodeURIComponent(path))
    .map((r) => r.method);
}

describe("completing the reservations the blind left behind", () => {
  test("a reserved version is published with the restored authors, not the blinded label", async () => {
    seedDataset();
    seedRequest(1);
    seedVersion("1.0.0", "2026-01-01 00:00:00");
    seedIdentifier(versionIdentifier("1.0.0"), "reserved", BLINDED_XML);

    const warning = await run();

    expect(warning).toBeUndefined();
    expect(statusOf("1.0.0")).toBe("public");
    // The record EZID keeps is the REBUILT one. Sending the flip alone would
    // freeze the blinded creator as the version's permanent attribution, which
    // is the one failure mode ADR 0065 calls irreversible.
    expect(dataciteOf("1.0.0")).toContain(RESTORED_AUTHOR);
    expect(dataciteOf("1.0.0")).not.toContain(BLINDED_LABEL);
    // Read from `main`, not from `v1.0.0`: the tag carries the description as it
    // stood during review, which is where the blinded label came from. Reading
    // it would rebuild the record with the very label this is undoing.
    expect(githubSeen).toContain(`/repos/${REPO}/contents/dataset_description.json?ref=main`);
    expect(auditRows()).toEqual([]);
  });

  test("the older version is completed even though only the newest was just published", async () => {
    // The revision case, which is the ordinary outcome of review: `version_doi`
    // dealt with 1.0.1, and nothing in the run names 1.0.0.
    seedDataset();
    seedRequest(1);
    seedVersion("1.0.0", "2026-01-01 00:00:00");
    seedVersion("1.0.1", "2026-02-01 00:00:00");
    seedIdentifier(versionIdentifier("1.0.0"), "reserved", BLINDED_XML);
    seedIdentifier(versionIdentifier("1.0.1"), "public", `<resource>${RESTORED_AUTHOR}</resource>`);

    const warning = await run();

    expect(warning).toBeUndefined();
    expect(statusOf("1.0.0")).toBe("public");
    expect(dataciteOf("1.0.0")).toContain(RESTORED_AUTHOR);
    // The already-public one is recognized and left exactly as it was: the
    // refused create and the status read, and no write of any kind.
    expect(statusOf("1.0.1")).toBe("public");
    expect(dataciteOf("1.0.1")).toBe(`<resource>${RESTORED_AUTHOR}</resource>`);
    expect(methodsFor("1.0.1")).toEqual(["PUT", "GET"]);
    // The refresh carries EVERY recorded version, not just the one being
    // completed: the concept record is rewritten wholesale, so a partial list
    // drops the relations already there.
    expect(store.get(CONCEPT_IDENTIFIER)?.datacite).toContain(`10.5072/fk2${DATASET_ID}.v1.0.0`);
    expect(store.get(CONCEPT_IDENTIFIER)?.datacite).toContain(`10.5072/fk2${DATASET_ID}.v1.0.1`);
  });

  test("the concept record's HasVersion set names the completed version", async () => {
    seedDataset();
    seedRequest(1);
    seedVersion("1.0.0", "2026-01-01 00:00:00");
    seedIdentifier(versionIdentifier("1.0.0"), "reserved", BLINDED_XML);

    await run();

    // Reserved identifiers were left out of the concept record (the anonymous
    // release skips the refresh), so completing one has to put it back.
    expect(store.get(CONCEPT_IDENTIFIER)?.datacite).toContain(`10.5072/fk2${DATASET_ID}.v1.0.0`);
  });

  test("an identifier EZID does not hold at all is minted, not skipped", async () => {
    // A `dataset_versions` row whose identifier is missing (a lost mint, or the
    // sandbox shoulder's two-week purge). The create succeeds and ends public.
    seedDataset();
    seedRequest(1);
    seedVersion("1.0.0", "2026-01-01 00:00:00");

    const warning = await run();

    expect(warning).toBeUndefined();
    expect(statusOf("1.0.0")).toBe("public");
    // Create, then the flip; the EZID client reads the record back after each
    // write, so every write is followed by a GET.
    expect(methodsFor("1.0.0")).toEqual(["PUT", "GET", "POST", "GET"]);
  });
});

describe("who this runs for", () => {
  test("an anonymous release asks for nothing: the blind is arriving, not leaving", async () => {
    seedDataset();
    seedRequest(1);
    seedVersion("1.0.0", "2026-01-01 00:00:00");
    seedIdentifier(versionIdentifier("1.0.0"), "reserved", BLINDED_XML);

    const warning = await run(true);

    expect(warning).toBeUndefined();
    expect(statusOf("1.0.0")).toBe("reserved");
    expect(ezidSeen).toEqual([]);
    expect(githubSeen).toEqual([]);
  });

  test("a dataset that was never anonymous is not touched", async () => {
    // The ordinary publication, which is the overwhelming majority of runs: no
    // EZID and no GitHub traffic may be added to it.
    seedDataset();
    seedRequest(0);
    seedVersion("1.0.0", "2026-01-01 00:00:00");
    seedIdentifier(versionIdentifier("1.0.0"), "reserved", BLINDED_XML);

    const warning = await run();

    expect(warning).toBeUndefined();
    expect(statusOf("1.0.0")).toBe("reserved");
    expect(ezidSeen).toEqual([]);
    expect(githubSeen).toEqual([]);
  });

  test("a DENIED anonymous request still counts, because denial can follow a partial run", async () => {
    // The narrowing that looks obviously right and is wrong: only `approving`
    // and `published` sound like requests the orchestrator ran. The deny route
    // accepts a request that is already `approving`, so a release that got as
    // far as reserving this identifier and then failed can be denied afterwards
    // and end up `denied` with the reservation still standing. Filtering it out
    // leaves that identifier reserved forever behind a link the landing page
    // renders as live. Over-answering costs one idempotent EZID call.
    seedDataset();
    seedRequest(1, "denied");
    seedVersion("1.0.0", "2026-01-01 00:00:00");
    seedIdentifier(versionIdentifier("1.0.0"), "reserved", BLINDED_XML);

    expect(await run()).toBeUndefined();
    expect(statusOf("1.0.0")).toBe("public");
  });

  test("a request still sitting unapproved counts too, for the same reason", async () => {
    // `blocked` is written both before a run and by the orchestrator mid-run,
    // and `publication-sweep` moves a `blocked` row back to `requested`, so
    // `requested` is not evidence that nothing happened either.
    seedDataset();
    seedRequest(1, "requested");
    seedVersion("1.0.0", "2026-01-01 00:00:00");
    seedIdentifier(versionIdentifier("1.0.0"), "reserved", BLINDED_XML);

    expect(await run()).toBeUndefined();
    expect(statusOf("1.0.0")).toBe("public");
  });

  test("a version recorded AFTER first publication is not concealed-era", async () => {
    // Anonymity is impossible after `first_published_at` (ADR 0065, enforced by
    // migration 0085's triggers), so an ordinary later revision cannot have been
    // minted under a blind. Attempting it would be harmless-but-wasteful today
    // and is what makes the cap below misreport.
    seedDataset();
    seedRequest(1);
    seedVersion("1.0.0", "2026-01-01 00:00:00");
    seedVersion("2.0.0", "2027-01-01 00:00:00");
    seedIdentifier(versionIdentifier("1.0.0"), "reserved", BLINDED_XML);
    seedIdentifier(versionIdentifier("2.0.0"), "public", "<resource/>");

    const warning = await run();

    expect(warning).toBeUndefined();
    expect(statusOf("1.0.0")).toBe("public");
    // Never addressed at all, not merely left unchanged.
    expect(methodsFor("2.0.0")).toEqual([]);
  });

  test("an ordinary publication long after the blind reports nothing, even past the cap", async () => {
    // The shape that made the first draft cry wolf forever: one concealed-era
    // version, then more ordinary revisions than the cap. Counting every row
    // truncated at 10 and appended "may still be RESERVED" on every publication
    // for the rest of the dataset's life.
    seedDataset();
    seedRequest(1);
    seedVersion("1.0.0", "2026-01-01 00:00:00");
    seedIdentifier(versionIdentifier("1.0.0"), "reserved", BLINDED_XML);
    for (let i = 1; i <= MAX_CONCEALED_ERA_VERSION_DOIS + 1; i++) {
      seedVersion(`2.0.${i}`, `2027-01-${String(i).padStart(2, "0")} 00:00:00`);
      seedIdentifier(versionIdentifier(`2.0.${i}`), "public", "<resource/>");
    }

    const warning = await run();

    expect(warning).toBeUndefined();
    expect(auditRows()).toEqual([]);
    expect(statusOf("1.0.0")).toBe("public");
    expect(methodsFor(`2.0.${MAX_CONCEALED_ERA_VERSION_DOIS + 1}`)).toEqual([]);
  });

  test("a formerly-anonymous dataset with no recorded versions is a no-op", async () => {
    seedDataset();
    seedRequest(1);

    const warning = await run();

    expect(warning).toBeUndefined();
    expect(ezidSeen).toEqual([]);
    expect(githubSeen).toEqual([]);
    expect(auditRows()).toEqual([]);
  });
});

describe("what it refuses to guess", () => {
  test("no concept DOI is reported, because the record cannot be related", async () => {
    seedDataset({ conceptDoi: null });
    seedRequest(1);
    seedVersion("1.0.0", "2026-01-01 00:00:00");
    seedIdentifier(versionIdentifier("1.0.0"), "reserved", BLINDED_XML);

    const warning = await run();

    expect(warning).toMatch(/no concept DOI/);
    expect(warning).toMatch(/RESERVED/);
    expect(statusOf("1.0.0")).toBe("reserved");
    expect(ezidSeen).toEqual([]);
    const rows = auditRows();
    expect(rows.map((r) => r.action)).toEqual(["concealed_era_version_doi_incomplete"]);
    expect(rows[0].resource_id).toBe(DATASET_ID);
    expect(JSON.parse(rows[0].details).problems[0]).toMatch(/no concept DOI/);
  });

  test("no GitHub repository is reported, because attribution cannot be rebuilt", async () => {
    seedDataset({ githubRepo: null });
    seedRequest(1);
    seedVersion("1.0.0", "2026-01-01 00:00:00");
    seedIdentifier(versionIdentifier("1.0.0"), "reserved", BLINDED_XML);

    const warning = await run();

    expect(warning).toMatch(/no GitHub repository/);
    expect(statusOf("1.0.0")).toBe("reserved");
    expect(ezidSeen).toEqual([]);
    expect(auditRows().map((r) => r.action)).toEqual(["concealed_era_version_doi_incomplete"]);
  });

  test("an unreadable repository leaves the identifier reserved rather than publishing a placeholder", async () => {
    // `readRepoMetadata` reports a failed read instead of raising, and its
    // fallback description carries no authors -- which DataCite renders as a
    // `(:unav)` creator. Reserved is recoverable by approving again; a public
    // version DOI attributed to nobody, on a dataset that was anonymous by
    // choice, is not.
    seedDataset();
    seedRequest(1);
    seedVersion("1.0.0", "2026-01-01 00:00:00");
    seedIdentifier(versionIdentifier("1.0.0"), "reserved", BLINDED_XML);
    repoState.status = 403;

    const warning = await run();

    expect(warning).toMatch(/attribution could not be rebuilt/);
    expect(statusOf("1.0.0")).toBe("reserved");
    expect(dataciteOf("1.0.0")).toBe(BLINDED_XML);
    expect(ezidSeen).toEqual([]);
    expect(githubSeen.length).toBeGreaterThan(0);
    expect(auditRows().map((r) => r.action)).toEqual(["concealed_era_version_doi_incomplete"]);
  });

  test("a repository still carrying the blinded label leaves the reservation alone", async () => {
    // The interlock the mint steps have, applied to the one thing this function
    // does. `refuseWhileBlinded` reads `datasets.authors`, which `repo_public`
    // rewrote earlier in the same run, so it cannot answer here; the repository
    // can, because the restoring commit is what puts the real names on `main`.
    // A DataCite record naming "Anonymous (withheld until publication)" is
    // harvested within hours and cannot be recalled.
    seedDataset();
    seedRequest(1);
    seedVersion("1.0.0", "2026-01-01 00:00:00");
    seedIdentifier(versionIdentifier("1.0.0"), "reserved", BLINDED_XML);
    repoState.description = { ...DESCRIPTION, Authors: [BLINDED_LABEL] };

    const warning = await run();

    expect(warning).toMatch(/still carries the anonymous-deposit author label/);
    expect(statusOf("1.0.0")).toBe("reserved");
    expect(dataciteOf("1.0.0")).toBe(BLINDED_XML);
    expect(ezidSeen).toEqual([]);
    expect(auditRows().map((r) => r.action)).toEqual(["concealed_era_version_doi_incomplete"]);
  });

  test("a repository that declares no authors is still completed", async () => {
    // The control for the guard above: "declares nothing" is not "could not be
    // read". A dataset whose description has no Authors gets the same `(:unav)`
    // creator its concept DOI already got, and refusing here would strand a
    // legitimate deposit's identifier forever.
    seedDataset();
    seedRequest(1);
    seedVersion("1.0.0", "2026-01-01 00:00:00");
    seedIdentifier(versionIdentifier("1.0.0"), "reserved", BLINDED_XML);
    repoState.description = { Name: DESCRIPTION.Name, BIDSVersion: "1.8.0" };

    const warning = await run();

    expect(warning).toBeUndefined();
    expect(statusOf("1.0.0")).toBe("public");
    expect(dataciteOf("1.0.0")).not.toContain(BLINDED_LABEL);
  });
});

describe("it keeps going, and it stays bounded", () => {
  test("one version that cannot be advanced does not strand the others", async () => {
    seedDataset();
    seedRequest(1);
    seedVersion("1.0.0", "2026-01-01 00:00:00");
    seedVersion("1.0.1", "2026-02-01 00:00:00");
    seedIdentifier(versionIdentifier("1.0.0"), "reserved", BLINDED_XML);
    // Deliberately tombstoned: `createEzidVersionDoi` refuses to publish an
    // `unavailable` identifier back to resolving.
    seedIdentifier(versionIdentifier("1.0.1"), "unavailable", BLINDED_XML);

    const warning = await run();

    expect(statusOf("1.0.0")).toBe("public");
    expect(statusOf("1.0.1")).toBe("unavailable");
    expect(warning).toMatch(/1\.0\.1/);
    expect(warning).not.toMatch(/1\.0\.0 \(/);
    expect(auditRows().map((r) => r.action)).toEqual(["concealed_era_version_doi_incomplete"]);
  });

  test("more versions than the cap: the oldest are done, the excess is reported", async () => {
    seedDataset();
    seedRequest(1);
    const total = MAX_CONCEALED_ERA_VERSION_DOIS + 1;
    for (let i = 0; i < total; i++) {
      const version = `1.0.${i}`;
      // Ascending created_at, so "oldest first" is unambiguous.
      seedVersion(version, `2026-01-${String(i + 1).padStart(2, "0")} 00:00:00`);
      seedIdentifier(versionIdentifier(version), "reserved", BLINDED_XML);
    }

    const warning = await run();

    expect(warning).toMatch(
      new RegExp(`more than ${MAX_CONCEALED_ERA_VERSION_DOIS} versions recorded before first`),
    );
    for (let i = 0; i < MAX_CONCEALED_ERA_VERSION_DOIS; i++) {
      expect(statusOf(`1.0.${i}`)).toBe("public");
    }
    // The newest one is the one left behind, and the admin is told so.
    expect(statusOf(`1.0.${MAX_CONCEALED_ERA_VERSION_DOIS}`)).toBe("reserved");
    expect(auditRows().map((r) => r.action)).toEqual(["concealed_era_version_doi_incomplete"]);
  });

  test("the truncation note survives a later failure in the same run", async () => {
    // Every early return goes through the shared writer with the accumulated
    // list, so a run that both truncated and then failed says both things. A
    // fresh array at the failure site would silently drop the cap notice.
    seedDataset({ conceptDoi: null });
    seedRequest(1);
    for (let i = 0; i < MAX_CONCEALED_ERA_VERSION_DOIS + 1; i++) {
      seedVersion(`1.0.${i}`, `2026-01-${String(i + 1).padStart(2, "0")} 00:00:00`);
    }

    const warning = await run();

    expect(warning).toMatch(
      new RegExp(`more than ${MAX_CONCEALED_ERA_VERSION_DOIS} versions recorded before first`),
    );
    expect(warning).toMatch(/no concept DOI/);
    expect(JSON.parse(auditRows()[0].details).problems).toHaveLength(2);
  });
});
