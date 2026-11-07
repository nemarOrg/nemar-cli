/**
 * The world the partner-contract suites run in (epic #2021 phase D4, #2025): the compute lifecycle
 * fixture (real migrated SQLite, Miniflare's R2 through the Worker's own bindings, the real local S3
 * interface, the Tapis stand-in) with the REAL Worker entry point in front of it (the middleware stack,
 * the mount routing, the real compute router and the real OpenID Connect provider), and a partner CLIENT
 * registered through the owner's route, exactly as `nemar admin oidc clients add` registers one.
 *
 * Every credential is a real one: the client is registered by `POST /admin/oidc/clients`, the signing keys
 * are made by the owner's rotation, a person's access token is minted by the real authorization routes and
 * the real token endpoint, and a client credentials token by the same endpoint. The Tapis stand-in
 * answers from Tapis's published specifications and no response of it was recorded from a real tenant;
 * the partner's own Tapis job is submitted to it directly (`partnerLaunch`), as the partner would, with
 * an owner and tags of ITS choosing, which is the whole point of the suite.
 *
 * Nothing stands in for a NEMAR decision.
 */

import { expect } from "bun:test";
import { hashApiKey } from "../../src/services/token";
import type { Bindings } from "../../src/types/bindings";
import { type LifecycleFixture, startLifecycleFixture } from "./compute-lifecycle-fixture";
import { fundAccount, seedUser, setPolicy } from "./compute-seed";
import {
  type RegisteredClient,
  authorize,
  basic,
  formPost,
  redeem,
  registerClient,
  rotateKeys,
  sessionCookie,
} from "./oidc-flow";
import {
  type Answer,
  BYPASS,
  ISSUER,
  OIDC_TEST_SECRET,
  OWNER_KEY,
  type OidcHarness,
  harnessOver,
} from "./oidc-harness";

export interface PartnerWorld {
  fx: LifecycleFixture;
  h: OidcHarness;
  /** The partner client, registered with the audience `<issuer>/compute` and the scopes the partner needs. */
  client: RegisteredClient;
  env(over?: Partial<Bindings>): Bindings;
}

export const AUDIENCE = `${ISSUER}/compute`;

export const PARTNER_SCOPES = [
  "openid",
  "profile",
  "compute.reserve",
  "compute.read",
  "offline_access",
];

/**
 * The owner's confirmation the partner contract needs (`policy.partner`): NEMAR's service identity can see
 * the tenant's jobs, and the execution system a partner's job must run on (the Tapis stand-in's own).
 */
export const PARTNER_CONFIRMED = { tapisVisibilityConfirmed: true, execSystemId: "standin-exec" };

/** `setPolicy` with the partner confirmation in it (any key of `over` wins). */
export async function setPartnerPolicy(
  d1: Parameters<typeof setPolicy>[0],
  ownerId: number,
  over: Record<string, unknown> = {},
): Promise<void> {
  await setPolicy(d1, ownerId, { partner: PARTNER_CONFIRMED, ...over });
}

/** Build the world on a fixture that has just been reset. */
export async function buildPartnerWorld(
  fx: LifecycleFixture,
  options: {
    client?: Record<string, unknown>;
    caps?: { open: number; milli: number } | null;
    /** False leaves the owner's partner confirmation out (the default policy: closed). */
    confirmed?: boolean;
  } = {},
): Promise<PartnerWorld> {
  const base = fx.env({
    ENVIRONMENT: "test",
    API_BASE_URL: ISSUER,
    APP_BASE_URL: "https://app.nemar.org",
    OIDC_SECRET: OIDC_TEST_SECRET,
    TEST_BYPASS_TOKEN: BYPASS,
    HOST_PREFIXED_SESSION_COOKIE: "1",
  });
  const db = fx.harness.db;
  // The owner of the fixture holds the key the registration route is called with.
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    fx.ownerId,
    await hashApiKey(OWNER_KEY),
    OWNER_KEY.slice(0, 8),
  );
  const h = harnessOver(db, base, { owner: fx.ownerId, admin: fx.ownerId, member: fx.ownerId });
  await rotateKeys(h);
  const client = await registerClient(h, {
    allowed_scopes: PARTNER_SCOPES,
    allowed_grants: ["authorization_code", "refresh_token"],
    audience: AUDIENCE,
    ...(options.client ?? {}),
  });
  if (options.caps !== null) {
    const caps = options.caps ?? { open: 10, milli: 1_000_000_000 };
    await setPolicy(base.DB, fx.ownerId, {
      ...(options.confirmed === false ? {} : { partner: PARTNER_CONFIRMED }),
      clients: {
        [client.clientId]: {
          maxOpenReservations: caps.open,
          maxReservedMilliPerDay: caps.milli,
        },
      },
    });
  }
  return { fx, h, client, env: (over) => ({ ...base, ...(over ?? {}) }) as Bindings };
}

export interface PartnerPerson {
  id: number;
  /** The OpenID Connect subject: the person's Tapis username in this world (the identity transform). */
  sub: string;
  cookie: string;
  /** A live access token for the partner client with `compute.reserve`. */
  token: string;
}

let people = 0;

/** A funded person with compute access (`active` by default), a session and a partner token. */
export async function newPartnerPerson(
  w: PartnerWorld,
  over: { access?: string; grant?: number; scope?: string; client?: RegisteredClient } = {},
): Promise<PartnerPerson> {
  people += 1;
  const env = w.env();
  const id = await seedUser(env.DB, {});
  await env.DB.prepare("UPDATE users SET compute_access = ?1 WHERE id = ?2")
    .bind(over.access ?? "active", id)
    .run();
  await fundAccount(env.DB, id, over.grant ?? 100_000);
  const cookie = await sessionCookie(w.h, id);
  const token = await tokenFor(
    w,
    { id, cookie },
    over.scope ?? "openid compute.reserve",
    over.client,
  );
  const row = w.h.db
    .query<{ oidc_subject: string }, [number]>("SELECT oidc_subject FROM users WHERE id = ?")
    .get(id);
  return { id, sub: row?.oidc_subject as string, cookie, token };
}

/** A fresh access token for a person at a client, with the scope text given. */
export async function tokenFor(
  w: PartnerWorld,
  who: { id: number; cookie: string },
  scope: string,
  client: RegisteredClient = w.client,
): Promise<string> {
  const code = await authorize(w.h, client, who.cookie, { scope });
  const res = await redeem(w.h, client, code);
  expect(res.status).toBe(200);
  return (res.json as { access_token: string }).access_token;
}

/** A client credentials token (no person). */
export async function machineToken(w: PartnerWorld, client: RegisteredClient): Promise<string> {
  const res = await formPost(
    w.h,
    "/oauth/token",
    { grant_type: "client_credentials" },
    { authorization: basic(client.clientId, client.secret) },
  );
  expect(res.status).toBe(200);
  return (res.json as { access_token: string }).access_token;
}

let keys = 0;

export interface Hold {
  job_id: string;
  hold_id: string;
  tag: string;
  expires_at: string;
}

/** The body of a hold, with any field overridden. Four cores for an hour on `shared`: 4 SU. */
export function holdBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    app_id: "partner-app",
    app_version: "2.1.0",
    kind: "batch",
    partition: "shared",
    nodes: 1,
    cores: 4,
    memory_mb: 8000,
    gpus: 0,
    minutes: 60,
    ...over,
  };
}

/** One request to the Worker as the partner's server sends it. */
export async function partnerCall(
  w: PartnerWorld,
  method: "POST" | "DELETE" | "GET",
  path: string,
  opts: {
    token?: string | null;
    key?: string | null | undefined;
    json?: unknown;
    raw?: string;
    headers?: Record<string, string>;
    env?: Partial<Bindings>;
  } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key !== null) headers["Idempotency-Key"] = opts.key ?? `idem-${++keys}-${Date.now()}`;
  return w.h.call(method, path, {
    key: opts.token ?? null,
    ...(opts.json !== undefined ? { body: opts.json } : {}),
    ...(opts.raw !== undefined
      ? { rawBody: opts.raw, headers: { ...headers, "Content-Type": "application/json" } }
      : { headers }),
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
}

/** Reserve, failing the test on any answer but 201. */
export async function reserve(
  w: PartnerWorld,
  person: PartnerPerson,
  over: Record<string, unknown> = {},
  key?: string,
): Promise<Hold> {
  const res = await partnerCall(w, "POST", "/compute/holds", {
    token: person.token,
    json: holdBody(over),
    key,
  });
  if (res.status !== 201) throw new Error(`could not reserve: ${res.status} ${res.text}`);
  return res.json as unknown as Hold;
}

// --- The partner's own Tapis job ----------------------------------------------------------------------------

async function tapisToken(fx: LifecycleFixture): Promise<string> {
  const res = await fetch(`${fx.tapis.url}/v3/oauth2/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "password",
      username: fx.tapis.username,
      password: fx.tapis.password,
    }),
  });
  const body = (await res.json()) as { result: { access_token: { access_token: string } } };
  return body.result.access_token.access_token;
}

export interface Launch {
  owner?: string;
  appId?: string;
  appVersion?: string;
  queue?: string;
  nodes?: number;
  cores?: number;
  memoryMB?: number;
  maxMinutes?: number;
  tags?: string[];
  /** The `arg` of each scheduler option the job is submitted with (e.g. `--gpus=4`). */
  schedulerArgs?: string[];
  /** The execution system the job runs on. */
  execSystemId?: string;
  /** Share the job with the NEMAR service identity, so NEMAR's tag search sees it (an arrangement of the real tenant, unverified). */
  share?: boolean;
}

/**
 * A Tapis job the PARTNER launches: any owner, any tags, any resources, as a compromised partner could.
 * The defaults are the job `reserve(...)` asks for. Returns the Tapis uuid.
 */
export async function partnerLaunch(
  w: PartnerWorld,
  hold: Hold | null,
  person: PartnerPerson | null,
  over: Launch = {},
): Promise<string> {
  const token = await tapisToken(w.fx);
  const tags = over.tags ?? (hold === null ? [] : [hold.tag]);
  const res = await fetch(`${w.fx.tapis.url}/v3/jobs/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tapis-Token": token },
    body: JSON.stringify({
      name: "the partner's job",
      appId: over.appId ?? "partner-app",
      appVersion: over.appVersion ?? "2.1.0",
      owner: over.owner ?? person?.sub,
      execSystemLogicalQueue: over.queue ?? "shared",
      nodeCount: over.nodes ?? 1,
      coresPerNode: over.cores ?? 4,
      memoryMB: over.memoryMB ?? 8000,
      maxMinutes: over.maxMinutes ?? 60,
      tags,
      ...(over.execSystemId === undefined ? {} : { execSystemId: over.execSystemId }),
      ...(over.schedulerArgs === undefined
        ? {}
        : { parameterSet: { schedulerOptions: over.schedulerArgs.map((arg) => ({ arg })) } }),
    }),
  });
  const body = (await res.json()) as { result: { uuid: string } };
  const uuid = body.result.uuid;
  if (over.share !== false) w.fx.tapis.shareJob(uuid, w.fx.tapis.username);
  return uuid;
}

/** A row of a table, read by column name in a test (its columns are the schema's, which the migrations own). */
// biome-ignore lint/suspicious/noExplicitAny: a test reads columns of every type from a row by name
export type DbRow = Record<string, any>;

/** The row of a job. */
export function row(w: PartnerWorld, id: string): DbRow {
  return w.h.db.query("SELECT * FROM compute_jobs WHERE id = ?").get(id) as DbRow;
}

/** Every ledger entry of a job, in order. */
export function entries(w: PartnerWorld, id: string): DbRow[] {
  return w.h.db
    .query("SELECT * FROM compute_ledger WHERE job_id = ? ORDER BY id")
    .all(id) as DbRow[];
}

/** A pool's row for a holder. */
export function poolOf(w: PartnerWorld, kind: string, ref: string, pool = "cpu") {
  return w.h.db
    .query("SELECT * FROM compute_pools WHERE holder_kind = ? AND holder_ref = ? AND pool = ?")
    .get(kind, ref, pool) as DbRow | null;
}

/** One upload address of a report's answer. */
export interface ReportUpload {
  path: string;
  url: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * A database handle that runs `during` ONCE, right after the first read whose SQL contains `after` has
 * returned: what a CONCURRENT request did while this one was between two of its statements. The reads and
 * writes themselves are the real database's; nothing is faked, the other request is a real request (the
 * caller passes it as `during`). The local engine serializes whole requests, so a race that production's
 * interleaving can produce is made here, deterministically, at the exact statement.
 */
export function raceAfterRead(
  db: D1Database,
  after: string,
  during: () => Promise<void>,
  /** Which matching read: the first by default. */
  nth = 1,
): D1Database {
  let armed = true;
  let seen = 0;
  const wrapStatement = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, prop, receiver) {
        if (prop === "__target") return target;
        if (prop === "bind") {
          return (...values: unknown[]) => wrapStatement(target.bind(...values), sql);
        }
        if (prop === "first") {
          return async (...args: unknown[]) => {
            const result = await (target.first as (...a: unknown[]) => Promise<unknown>)(...args);
            if (armed && sql.includes(after) && ++seen === nth) {
              armed = false;
              await during();
            }
            return result;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") return (sql: string) => wrapStatement(target.prepare(sql), sql);
      if (prop === "batch") {
        // The real batch takes the real statements: unwrap the proxies.
        return (statements: D1PreparedStatement[]) =>
          target.batch(
            statements.map(
              (s) => (s as unknown as { __target?: D1PreparedStatement }).__target ?? s,
            ),
          );
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
