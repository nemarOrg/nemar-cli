/**
 * What the ORCID callback does with a session cookie that is already in the browser (ADR 0119
 * rule 10; epic #2014 phase #2017 round 1).
 *
 * Real route tests in the shape of `orcid-relink-route.test.ts`: bun:sqlite behind `realD1` with
 * every migration, real sessions from `issueSession`, real state cookies from `encodeState`, the real
 * routes through `app.request`, and a real local server standing in for ORCID's token endpoint (the
 * only external boundary). Nothing here depends on the authorization endpoint, so the rules can ship
 * on their own; `oidc-authorize-sign-in-loop.test.ts` drives the same callback from the check route.
 *
 *   1. A plain sign-in (`mode=login`) never attaches the finished iD to the account a cookie already
 *      in the browser names, under either cookie name. The account is the one the iD itself names
 *      (signed in with a FRESH session, whatever session the browser held) or a new sign-up.
 *   2. An explicit link (`link` or `relink` in the state cookie, which only this site sets) attaches
 *      the iD to the session's account; while `HOST_PREFIXED_SESSION_COOKIE` is on, only to a session
 *      read under the `__Host-` name.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { authOrcidRoutes } from "../src/routes/auth-orcid";
import { encodeState } from "../src/services/orcid-auth";
import { hashCookieId, issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const APP = "https://app.nemar.org";
const CSRF = "csrf-callback-sign-in-test";
const PERSON_ID = "0000-0002-1825-0097";
const OTHER_ID = "0000-0001-5109-3700";

/** The iD the stand-in's token endpoint returns for the next exchange. */
let returnedOrcid = PERSON_ID;
let orcid: Server;
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let flag: string | undefined;

beforeAll(() => {
  orcid = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/oauth/token") {
        return Response.json({ orcid: returnedOrcid, name: "Ada Lovelace", access_token: "x" });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  orcid.stop(true);
});

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authOrcidRoutes);
  returnedOrcid = PERSON_ID;
  flag = "1";
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ORCID_CLIENT_ID: "APP-TEST",
    ORCID_CLIENT_SECRET: "test-secret",
    ORCID_API_BASE: `http://localhost:${orcid.port}`,
    ORCID_PUB_API_BASE: `http://localhost:${orcid.port}`,
    APP_BASE_URL: APP,
    WEB_SESSION_COOKIE_DOMAIN: "",
    HOST_PREFIXED_SESSION_COOKIE: flag,
    ENCRYPTION_KEY: "callback-test-encryption-key-0123456789",
  } as unknown as Bindings;
}

let counter = 0;

/** An active person, holding `identity` as a proven ORCID iD when one is given. */
function seedPerson(identity: string | null = null): number {
  counter += 1;
  const email = `cbperson${counter}@example.org`;
  db.run(
    `INSERT INTO users (email, status, signup_source, email_verified, account_kind, orcid, orcid_verified)
     VALUES (?, 'verified', 'web', 1, 'person', ?, ?)`,
    [email, identity, identity ? 1 : 0],
  );
  const id = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email)
    ?.id as number;
  if (identity) {
    db.run(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
      [id, identity],
    );
  }
  return id;
}

async function session(userId: number, name = "__Host-nemar_session"): Promise<string> {
  const { cookieIdRaw } = await issueSession(env(), userId, false, "test-agent", null, "orcid");
  return `${name}=${cookieIdRaw}`;
}

/** The ORCID callback, as the browser reaches it after ORCID, with the state cookie start set. */
function callback(
  mode: "login" | "link" | "relink",
  next: string,
  cookies: string[] = [],
): Promise<Response> {
  const state = `__Host-nemar_oauth_state=${encodeState({ csrf: CSRF, mode, next })}`;
  return app.request(
    `${APP}/auth/orcid/callback?state=${CSRF}&code=authcode`,
    { headers: { Cookie: [state, ...cookies].join("; ") } },
    env(),
  );
}

/** The session cookie the response set (under either name), as `name=value`, or null. */
function mintedSession(res: Response): string | null {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    if ((name === "__Host-nemar_session" || name === "nemar_session") && eq < pair.length - 1) {
      return pair;
    }
  }
  return null;
}

async function accountOf(cookie: string): Promise<number | null> {
  const value = cookie.slice(cookie.indexOf("=") + 1);
  return (
    db
      .query<{ user_id: number }, [string]>(
        "SELECT user_id FROM web_sessions WHERE cookie_id_hash = ?",
      )
      .get(await hashCookieId(value))?.user_id ?? null
  );
}

function errorOf(res: Response): string | null {
  const location = res.headers.get("Location");
  return location ? new URL(location).searchParams.get("error") : null;
}

function identitiesOf(userId: number): string[] {
  return db
    .query<{ s: string }, [number]>(
      "SELECT provider_subject AS s FROM oauth_identities WHERE user_id = ? ORDER BY id",
    )
    .all(userId)
    .map((r) => r.s);
}

function orcidOf(userId: number): string | null {
  return (
    db
      .query<{ o: string | null }, [number]>("SELECT orcid AS o FROM users WHERE id = ?")
      .get(userId)?.o ?? null
  );
}

describe("a plain sign-in ignores a session cookie already in the browser", () => {
  for (const name of ["nemar_session", "__Host-nemar_session"]) {
    test(`an unclaimed iD is not attached to the account a ${name} cookie names`, async () => {
      const cookieOwner = seedPerson();
      returnedOrcid = OTHER_ID;
      const res = await callback("login", "/dashboard", [await session(cookieOwner, name)]);
      expect(identitiesOf(cookieOwner)).toEqual([]);
      expect(orcidOf(cookieOwner)).toBeNull();
      // The iD belongs to nobody yet, so this is a new sign-up: the email step, and no session.
      expect(res.headers.get("Location")).toStartWith(`${APP}/auth/orcid/complete`);
      expect(mintedSession(res)).toBeNull();
    });

    test(`an iD that backs another account signs that account in, whatever a ${name} cookie names`, async () => {
      const cookieOwner = seedPerson();
      const holder = seedPerson(PERSON_ID);
      const res = await callback("login", "/dashboard", [await session(cookieOwner, name)]);
      expect(identitiesOf(cookieOwner)).toEqual([]);
      const fresh = mintedSession(res);
      expect(fresh).not.toBeNull();
      expect(await accountOf(fresh as string)).toBe(holder);
    });
  }

  test("signing in again with a live session for the same account mints a new session", async () => {
    // What the authorization endpoint waits for when it asks for a fresh sign-in.
    const person = seedPerson(PERSON_ID);
    const old = await session(person);
    const res = await callback("login", "/oauth/authorize?client_id=x", [old]);
    expect(res.headers.get("Location")).toBe(`${APP}/oauth/authorize?client_id=x`);
    const fresh = mintedSession(res);
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(old);
    expect(await accountOf(fresh as string)).toBe(person);
  });
});

describe("an explicit link attaches the iD to the session's account", () => {
  test("with a __Host- session, the iD is attached", async () => {
    const person = seedPerson();
    const res = await callback("link", "/settings", [await session(person)]);
    expect(errorOf(res)).toBeNull();
    expect(identitiesOf(person)).toEqual([PERSON_ID]);
    expect(orcidOf(person)).toBe(PERSON_ID);
  });

  test("with a legacy-name session while the flag is off, the link still works", async () => {
    flag = undefined;
    const person = seedPerson();
    const res = await callback("link", "/settings", [await session(person, "nemar_session")]);
    expect(errorOf(res)).toBeNull();
    expect(identitiesOf(person)).toEqual([PERSON_ID]);
  });
});
