/**
 * Who may call the partner's three routes, and what each credential does (epic #2021 phase D4, #2025; ADR
 * 0119, the addendum of this phase), through the REAL Worker entry point over real migrated SQLite, with
 * credentials the real flows issued: a CLI key stored hashed, a session cookie from `issueSession`, access
 * tokens from the real authorization routes and token endpoint, a client credentials token from the same
 * endpoint, and a client registered, disabled and its grant ended by the real owner and administrator routes.
 *
 * What is pinned, for EACH of `POST /compute/holds`, `POST /compute/jobs/:id/report` and
 * `DELETE /compute/holds/:id`:
 *  1. THE MATRIX. No credential is 401 `missing_credential`; a CLI key and a session cookie are 403
 *     `forbidden_credential` (a key without a lookup, so a valid and an invalid one are answered alike);
 *     garbage, a refresh token and a client secret are 401 `invalid_token`; a live token without
 *     `compute.reserve` is 403 `insufficient_scope` and names the scope; a client credentials token is
 *     `forbidden_credential` (it names no person); a token whose audience does not name this API is 403
 *     `wrong_audience` (the write routes check it, the read routes deliberately do not); a disabled client's
 *     token, a token whose grant was ended (a compute suspension) and a suspended person's OLD token are 401
 *     `invalid_token`. Every answer is `{ error, code }`, `no-store`, and writes nothing.
 *  2. A SUSPENDED PERSON who signs in again gets a token, and the reserve is `suspended` (403): the access
 *     state is the route's, not the credential's.
 *  3. THE CLIENT BINDING. A job reserved through client A is `job_not_found` for client B's token of the
 *     same person, on report and on release (no oracle: the same answer as an absent job), and another
 *     PERSON's job is the same answer.
 *  4. EVERY WRITE NEEDS an `Idempotency-Key` of the contract's shape: 400 `idempotency_key_required`.
 *
 * MUTATIONS (each applied, run, restored): drop the client term of `ownReservation`; make the audience
 * check always pass; let a CLI key through `computePartnerCredential`; drop the scope from `RESERVE_OIDC`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { COMPUTE_PARTNER_ERROR_STATUS } from "../../shared/contract/compute-partner";
import { hashApiKey } from "../src/services/token";
import { type LifecycleFixture, startLifecycleFixture } from "./helpers/compute-lifecycle-fixture";
import {
  type PartnerPerson,
  type PartnerWorld,
  buildPartnerWorld,
  entries,
  holdBody,
  machineToken,
  newPartnerPerson,
  partnerCall,
  partnerLaunch,
  reserve,
  row,
  tokenFor,
} from "./helpers/compute-partner-world";
import { type RegisteredClient, authorize, redeem, registerClient } from "./helpers/oidc-flow";
import { OWNER_KEY } from "./helpers/oidc-harness";

let fx: LifecycleFixture;
let w: PartnerWorld;

beforeAll(async () => {
  fx = await startLifecycleFixture();
}, 60_000);
afterAll(async () => {
  await fx?.dispose();
}, 30_000);
beforeEach(async () => {
  await fx.reset();
  w = await buildPartnerWorld(fx);
}, 60_000);

const KEY = `partner-cred-key-${"K".repeat(43)}`;

/** A real CLI key for a person. */
async function withKey(p: PartnerPerson): Promise<string> {
  const key = `${KEY.slice(0, 20)}${p.id}${"Z".repeat(30)}`;
  w.h.db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(p.id, await hashApiKey(key), key.slice(0, 8));
  return key;
}

const ledgerCount = () =>
  (w.h.db.query("SELECT COUNT(*) AS n FROM compute_ledger").get() as { n: number }).n;
const jobCount = () =>
  (w.h.db.query("SELECT COUNT(*) AS n FROM compute_jobs").get() as { n: number }).n;

interface Route {
  name: string;
  /** Call the route with `token` (and the shape it needs), for a job reserved by `owner`. */
  call(
    token: string | null,
    over?: { headers?: Record<string, string>; key?: string | null },
  ): Promise<Awaited<ReturnType<typeof partnerCall>>>;
}

/** The three routes, aimed at a reservation `owner` holds (the report and the release need one). */
async function routes(owner: PartnerPerson): Promise<Route[]> {
  const hold = await reserve(w, owner, {}, "setup-hold-1");
  const uuid = await partnerLaunch(w, hold, owner);
  return [
    {
      name: "POST /compute/holds",
      call: (token, over) =>
        partnerCall(w, "POST", "/compute/holds", {
          token,
          json: holdBody(),
          key: over?.key,
          headers: over?.headers,
        }),
    },
    {
      name: "POST /compute/jobs/:id/report",
      call: (token, over) =>
        partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
          token,
          json: { tapis_job_id: uuid },
          key: over?.key,
          headers: over?.headers,
        }),
    },
    {
      name: "DELETE /compute/holds/:id",
      call: (token, over) =>
        partnerCall(w, "DELETE", `/compute/holds/${hold.hold_id}`, {
          token,
          key: over?.key,
          headers: over?.headers,
        }),
    },
  ];
}

function expectRefusal(
  res: { status: number; json: Record<string, unknown> | null; headers: Headers },
  code: keyof typeof COMPUTE_PARTNER_ERROR_STATUS,
  where: string,
) {
  expect([where, res.status, res.json?.code]).toEqual([
    where,
    COMPUTE_PARTNER_ERROR_STATUS[code],
    code,
  ]);
  expect(typeof res.json?.error).toBe("string");
  expect(res.headers.get("Cache-Control")).toBe("no-store");
}

describe("the credential matrix on all three routes", () => {
  test("no credential is 401 missing_credential, with the bare Bearer challenge", async () => {
    const owner = await newPartnerPerson(w);
    for (const route of await routes(owner)) {
      const res = await route.call(null);
      expectRefusal(res, "missing_credential", route.name);
      expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    }
  });

  test("a CLI key is 403 forbidden_credential, a valid one and an invalid one alike", async () => {
    const owner = await newPartnerPerson(w);
    const key = await withKey(owner);
    for (const route of await routes(owner)) {
      expectRefusal(await route.call(key), "forbidden_credential", `${route.name} (valid key)`);
      expectRefusal(
        await route.call(`nm_${"Q".repeat(43)}`),
        "forbidden_credential",
        `${route.name} (unknown key)`,
      );
    }
  });

  test("the session cookie alone is 403 forbidden_credential", async () => {
    const owner = await newPartnerPerson(w);
    for (const route of await routes(owner)) {
      const res = await route.call(null, { headers: { Cookie: owner.cookie } });
      expectRefusal(res, "forbidden_credential", route.name);
    }
  });

  test("garbage, a refresh token and a client secret are 401 invalid_token", async () => {
    const owner = await newPartnerPerson(w);
    // A refresh token, from the real token endpoint.
    const authCode = await authorize(w.h, w.client, owner.cookie, {
      scope: "openid compute.reserve offline_access",
    });
    const issued = (await redeem(w.h, w.client, authCode)).json as { refresh_token: string };
    for (const route of await routes(owner)) {
      for (const bad of [`nmo_at_${"x".repeat(43)}`, issued.refresh_token, w.client.secret]) {
        const res = await route.call(bad);
        expectRefusal(res, "invalid_token", `${route.name} (${bad.slice(0, 7)})`);
        expect(res.headers.get("WWW-Authenticate")).toBe('Bearer error="invalid_token"');
      }
    }
  });

  test("a live token without compute.reserve is 403 insufficient_scope and names the scope", async () => {
    const owner = await newPartnerPerson(w);
    const readOnly = await tokenFor(w, owner, "openid compute.read");
    const plain = await tokenFor(w, owner, "openid profile");
    for (const route of await routes(owner)) {
      for (const token of [readOnly, plain]) {
        const res = await route.call(token);
        expectRefusal(res, "insufficient_scope", route.name);
        expect(res.headers.get("WWW-Authenticate")).toBe(
          'Bearer error="insufficient_scope", scope="compute.reserve"',
        );
      }
    }
  });

  test("a client credentials token names no person: forbidden_credential even with the scope", async () => {
    const owner = await newPartnerPerson(w);
    const machine = await registerClient(w.h, {
      allowed_scopes: ["compute.stats"],
      allowed_grants: ["client_credentials"],
      audience: "https://api.nemar.org/compute",
      first_party: false,
    });
    const token = await machineToken(w, machine);
    // Widen the live token by hand, to reach the account test behind the scope test.
    w.h.db
      .query("UPDATE oidc_tokens SET scopes = ? WHERE user_id IS NULL")
      .run('["compute.reserve"]');
    for (const route of await routes(owner)) {
      expectRefusal(await route.call(token), "forbidden_credential", route.name);
    }
  });

  test("a token whose audience does not name this API is 403 wrong_audience, on the write routes", async () => {
    const owner = await newPartnerPerson(w);
    const stranger = await registerClient(w.h, {
      allowed_scopes: ["openid", "compute.reserve", "compute.read"],
      allowed_grants: ["authorization_code"],
      audience: "https://other.example.org/resource",
    });
    const token = await tokenFor(w, owner, "openid compute.reserve", stranger);
    for (const route of await routes(owner)) {
      expectRefusal(await route.call(token), "wrong_audience", route.name);
    }
    // The audience is the NEMAR API's origin, on any path; the same token on a READ route is served
    // (ADR 0119, the addendum of phase D2, item 4: the read routes deliberately do not check it).
    const read = await tokenFor(w, owner, "openid compute.read", stranger);
    expect((await w.h.call("GET", "/compute/me", { key: read })).status).toBe(200);
  });

  test("a disabled client's token is 401 invalid_token", async () => {
    const owner = await newPartnerPerson(w);
    const list = await routes(owner);
    const disabled = await w.h.call("POST", `/admin/oidc/clients/${w.client.clientId}/disable`, {
      key: OWNER_KEY,
      body: {},
    });
    expect(disabled.status).toBe(200);
    for (const route of list)
      expectRefusal(await route.call(owner.token), "invalid_token", route.name);
  });

  test("a compute suspension ends the person's grants: the old token is 401, and a person who signs in again is told suspended", async () => {
    const owner = await newPartnerPerson(w);
    const list = await routes(owner);
    const decided = await w.h.call("POST", `/admin/compute/access/suspend/by-id/${owner.id}`, {
      key: OWNER_KEY,
      body: { reason: "test" },
    });
    expect(decided.status).toBe(200);
    for (const route of list)
      expectRefusal(await route.call(owner.token), "invalid_token", route.name);
    // Signing in does not need compute access (ADR 0119 rule 7), so a new token exists, and it is refused by state.
    const again = await tokenFor(w, owner, "openid compute.reserve");
    const before = [ledgerCount(), jobCount()];
    const res = await partnerCall(w, "POST", "/compute/holds", { token: again, json: holdBody() });
    expectRefusal(res, "suspended", "reserve after a suspension");
    expect([ledgerCount(), jobCount()]).toEqual(before);
  });
});

describe("the client and the person bind a reservation", () => {
  let other: RegisteredClient;
  beforeEach(async () => {
    other = await registerClient(w.h, {
      allowed_scopes: ["openid", "compute.reserve", "compute.read"],
      allowed_grants: ["authorization_code"],
      audience: "https://api.nemar.org/compute",
    });
  });

  test("another client's token of the SAME person is job_not_found on report and on release, like an absent job", async () => {
    const owner = await newPartnerPerson(w);
    const hold = await reserve(w, owner);
    const uuid = await partnerLaunch(w, hold, owner);
    const theirs = await tokenFor(w, owner, "openid compute.reserve", other);
    const before = JSON.stringify(row(w, hold.job_id));
    const report = await partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
      token: theirs,
      json: { tapis_job_id: uuid },
    });
    const absent = await partnerCall(
      w,
      "POST",
      "/compute/jobs/job_000000000000000000000abc/report",
      {
        token: theirs,
        json: { tapis_job_id: uuid },
      },
    );
    const release = await partnerCall(w, "DELETE", `/compute/holds/${hold.hold_id}`, {
      token: theirs,
    });
    expectRefusal(report, "job_not_found", "report");
    expectRefusal(release, "job_not_found", "release");
    // The same answer as a job that does not exist: no oracle.
    expect(report.text).toBe(absent.text);
    expect(JSON.stringify(row(w, hold.job_id))).toBe(before);
    expect(entries(w, hold.job_id).map((e) => e.kind)).toEqual(["hold"]);
  });

  test("another PERSON's token of the same client is job_not_found", async () => {
    const owner = await newPartnerPerson(w);
    const stranger = await newPartnerPerson(w);
    const hold = await reserve(w, owner);
    const uuid = await partnerLaunch(w, hold, owner);
    expectRefusal(
      await partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
        token: stranger.token,
        json: { tapis_job_id: uuid },
      }),
      "job_not_found",
      "report",
    );
    expectRefusal(
      await partnerCall(w, "DELETE", `/compute/holds/${hold.hold_id}`, { token: stranger.token }),
      "job_not_found",
      "release",
    );
    expect(row(w, hold.job_id).state).toBe("created");
  });

  test("a job that is not a partner's (a person's own job) is job_not_found too, and a malformed id is", async () => {
    const owner = await newPartnerPerson(w);
    w.h.db
      .query(
        `INSERT INTO compute_jobs (id, account_id, source, kind, state, app_id, app_version, spec_digest,
           partition, pool, nodes, cores_per_node, minutes)
         VALUES ('job_0000000000000000000000f1', ?, 'cli', 'batch', 'created', 'a', '1', ?, 'shared', 'cpu', 1, 1, 1)`,
      )
      .run(owner.id, "0".repeat(64));
    for (const id of ["job_0000000000000000000000f1", "not-a-job", "job_xyz"]) {
      expectRefusal(
        await partnerCall(w, "POST", `/compute/jobs/${id}/report`, {
          token: owner.token,
          json: { tapis_job_id: "abc-123" },
        }),
        "job_not_found",
        id,
      );
    }
    expectRefusal(
      await partnerCall(w, "DELETE", "/compute/holds/hold_0000000000000000000000f1", {
        token: owner.token,
      }),
      "job_not_found",
      "release of a person's job",
    );
    expectRefusal(
      await partnerCall(w, "DELETE", "/compute/holds/job_0000000000000000000000f1", {
        token: owner.token,
      }),
      "job_not_found",
      "release by a job id",
    );
  });
});

describe("every write needs an Idempotency-Key of the contract's shape", () => {
  test("absent, empty, too long or with a character outside the alphabet is 400, and writes nothing", async () => {
    const owner = await newPartnerPerson(w);
    const hold = await reserve(w, owner);
    const uuid = await partnerLaunch(w, hold, owner);
    const before = [ledgerCount(), jobCount()];
    for (const key of [null, "", "x".repeat(65), "has space", "slash/1", "q?"]) {
      for (const [method, path, json] of [
        ["POST", "/compute/holds", holdBody()],
        ["POST", `/compute/jobs/${hold.job_id}/report`, { tapis_job_id: uuid }],
        ["DELETE", `/compute/holds/${hold.hold_id}`, undefined],
      ] as const) {
        const res = await partnerCall(w, method, path, {
          token: owner.token,
          ...(json === undefined ? {} : { json }),
          key,
          ...(key === "" ? { headers: { "Idempotency-Key": "" } } : {}),
        });
        expectRefusal(
          res,
          "idempotency_key_required",
          `${method} ${path} key=${JSON.stringify(key)}`,
        );
      }
    }
    expect([ledgerCount(), jobCount()]).toEqual(before);
    expect(row(w, hold.job_id).tapis_uuid).toBeNull();
  });
});
