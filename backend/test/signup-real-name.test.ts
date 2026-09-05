/**
 * Name sourcing at CLI signup (#1255, epic #1250).
 *
 * ORCID is required at signup and is the canonical source of the researcher
 * name DOIs cite, so the signup insert reads the public ORCID record itself.
 * A record may hide its name, which is why the CLI can supply a typed pair as
 * a fallback -- and why the record must still WIN when it has a name, so a
 * mistyped name cannot overwrite the citable one.
 *
 * Real engine end to end: bun:sqlite behind realD1 with every migration
 * applied, the real Hono route, real bcrypt hashing, real zod validation.
 *
 * The two external boundaries are real HTTP servers, not mocks:
 *  - ORCID's public record API is a local `Bun.serve()` reached through the
 *    ORCID_PUB_API_BASE binding (the same override an ORCID mirror would
 *    use), so the production fetch/parse path in `fetchOrcidName` runs.
 *  - GitHub's /users/:login is the same local server, reached through the
 *    `NEMAR_GITHUB_API_URL` test override that already exists for this.
 * Both serve real ORCID/GitHub response shapes. RESEND_API_KEY is unset, so
 * the verification email takes the unconfigured path without any network.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { authRoutes } from "../src/routes/auth";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ORCID = "0000-0002-1825-0097";

/** What the local ORCID server returns for the next personal-details read. */
let orcidRecord: { status: number; body: unknown };
let server: ReturnType<typeof Bun.serve>;
let base: string;

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      // ORCID public record.
      if (url.pathname.endsWith("/personal-details")) {
        return new Response(JSON.stringify(orcidRecord.body), {
          status: orcidRecord.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      // GitHub user lookup (validateGitHubUsername).
      const gh = url.pathname.match(/^\/users\/(.+)$/);
      if (gh) {
        return new Response(JSON.stringify({ login: gh[1], id: 4242 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = base;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ORCID_PUB_API_BASE: base,
    GITHUB_ADMIN_PAT: "test-pat-not-used-against-a-real-host",
    API_BASE_URL: "http://localhost:8787",
  } as Bindings;
}

function signup(body: Record<string, unknown>): Promise<Response> {
  return app.request(
    "/auth/signup",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "newuser",
        email: "newuser@example.org",
        password: "Correct-Horse-Battery-9",
        github_username: "newuser",
        description: "I would like to deposit EEG datasets collected in our lab.",
        orcid: ORCID,
        city: "San Diego",
        country: "USA",
        ...body,
      }),
    },
    env(),
  );
}

function storedName() {
  return db
    .query<{ given_name: string | null; family_name: string | null }, []>(
      "SELECT given_name, family_name FROM users WHERE username = 'newuser'",
    )
    .get();
}

const NAMED_RECORD = {
  status: 200,
  body: { name: { "given-names": { value: "Ada" }, "family-name": { value: "Lovelace" } } },
};
/** ORCID's shape for a record whose owner made their name private. */
const PRIVATE_RECORD = { status: 200, body: { name: null } };

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authRoutes);
  orcidRecord = NAMED_RECORD;
});

describe("POST /auth/signup name sourcing", () => {
  test("stores the name from the public ORCID record", async () => {
    const res = await signup({});
    expect(res.status).toBe(201);
    expect(storedName()).toEqual({ given_name: "Ada", family_name: "Lovelace" });
  });

  test("stores the supplied name when the record hides one", async () => {
    orcidRecord = PRIVATE_RECORD;
    const res = await signup({ given_name: "Grace", family_name: "Hopper" });
    expect(res.status).toBe(201);
    expect(storedName()).toEqual({ given_name: "Grace", family_name: "Hopper" });
  });

  test("the ORCID record wins over a supplied name", async () => {
    // The record is the authority on how this person is cited; a typed pair
    // is a fallback, not an override.
    const res = await signup({ given_name: "Typo", family_name: "Mistake" });
    expect(res.status).toBe(201);
    expect(storedName()).toEqual({ given_name: "Ada", family_name: "Lovelace" });
  });

  test("a hidden record with no supplied name still creates the account", async () => {
    // Registration is not failed over a missing name: publishing is blocked
    // later, and backfill/Settings can close the gap.
    orcidRecord = PRIVATE_RECORD;
    const res = await signup({});
    expect(res.status).toBe(201);
    expect(storedName()).toEqual({ given_name: null, family_name: null });
  });

  test("an ORCID lookup failure falls back to the supplied name", async () => {
    orcidRecord = { status: 503, body: { error: "upstream down" } };
    const res = await signup({ given_name: "Grace", family_name: "Hopper" });
    expect(res.status).toBe(201);
    expect(storedName()).toEqual({ given_name: "Grace", family_name: "Hopper" });
  });

  test("a half-supplied name does not overwrite a half-known record name", async () => {
    // Mixing sources would produce a name neither party stated.
    orcidRecord = {
      status: 200,
      body: { name: { "given-names": { value: "Ada" }, "family-name": null } },
    };
    const res = await signup({ family_name: "Hopper" });
    expect(res.status).toBe(201);
    expect(storedName()).toEqual({ given_name: "Ada", family_name: null });
  });
});

describe("GET /auth/orcid-name", () => {
  function lookup(query: string): Promise<Response> {
    return app.request(`/auth/orcid-name${query}`, {}, env());
  }

  test("returns the record's name with found: true", async () => {
    const res = await lookup(`?orcid=${ORCID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      found: true,
      given_name: "Ada",
      family_name: "Lovelace",
    });
  });

  test("found: false when the record hides its name", async () => {
    orcidRecord = PRIVATE_RECORD;
    const res = await lookup(`?orcid=${ORCID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ found: false, given_name: null, family_name: null });
  });

  test("found: false (not an error) when ORCID is unreachable", async () => {
    orcidRecord = { status: 500, body: {} };
    const res = await lookup(`?orcid=${ORCID}`);
    expect(res.status).toBe(200);
    expect((await res.json()).found).toBe(false);
  });

  test("400 on a malformed iD, without calling ORCID", async () => {
    const res = await lookup("?orcid=not-an-orcid");
    expect(res.status).toBe(400);
  });

  test("400 when the iD is missing", async () => {
    const res = await lookup("");
    expect(res.status).toBe(400);
  });

  test("found: false when only one name part is published", async () => {
    // Half a name is not citable, so it is not a name the CLI can accept.
    orcidRecord = {
      status: 200,
      body: { name: { "given-names": { value: "Ada" }, "family-name": null } },
    };
    const res = await lookup(`?orcid=${ORCID}`);
    expect(await res.json()).toEqual({ found: false, given_name: "Ada", family_name: null });
  });
});
