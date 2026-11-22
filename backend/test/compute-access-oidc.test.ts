/**
 * A suspension or a revocation of compute access ends the person's compute OpenID Connect grants, and
 * only those (epic #2021 phase D1, #2022; ADR 0119 rule 12, "Compute suspension"; ADR 0118). Driven
 * through the REAL Worker entry point (`startOidcHarness`: the middleware stack, the admin router behind
 * its real authentication) over a real database, with every grant, token and code made by the real
 * authorization and token routes and the clients registered by the owner's real route. Nothing is stood in
 * for.
 *
 * What is pinned:
 *  - a suspension ends the grants that carry a `compute.` scope (their tokens, whatever scopes the tokens
 *    carry, and their unused codes), queues a back-channel logout for those clients that have an address
 *    and tells nobody else, and leaves the person signed in at every other client;
 *  - a revocation of compute access does the same, with the same reason word;
 *  - a grant, a denial and a request do not touch a grant (nothing ended, so nothing is told);
 *  - the OIDC statements are guarded on the state the flip leaves, so a decision that lost a race ends
 *    no grant (MUTATION: drop the guard from `endComputeStatements`);
 *  - the decision is atomic with the OIDC end: a statement of the batch that fails leaves every grant live.
 *
 * MUTATIONS: omit `oidcEndStatements` from `endComputeStatements`; use the whole-account ending instead
 * of the `compute.` filter.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { endComputeStatements } from "../src/services/compute-access";
import {
  clientRowId,
  countsOf,
  deliveries,
  registerLogoutClient,
  revokedReasons,
  seedProvenAccount,
  signInAt,
  stillWorks,
} from "./helpers/oidc-cascade";
import { registerClient, rotateKeys } from "./helpers/oidc-flow";
import { ADMIN_KEY, type OidcHarness, startOidcHarness } from "./helpers/oidc-harness";

const COMPUTE_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "compute.read",
  "compute.reserve",
] as const;

let h: OidcHarness;

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
});

afterEach(() => {
  h.db.exec("DROP TRIGGER IF EXISTS oidc_boom");
});

const setState = (userId: number, state: string) =>
  h.db.run("UPDATE users SET compute_access = ? WHERE id = ?", [state, userId]);

const decide = (decision: string, userId: number) =>
  h.call("POST", `/admin/compute/access/${decision}/by-id/${userId}`, { key: ADMIN_KEY });

async function world() {
  const compute = await registerLogoutClient(h, { allowed_scopes: [...COMPUTE_SCOPES] });
  const computeQuiet = await registerClient(h, { allowed_scopes: [...COMPUTE_SCOPES] });
  const other = await registerLogoutClient(h);
  const userId = seedProvenAccount(h);
  const held = {
    compute: await signInAt(h, userId, compute, { scope: COMPUTE_SCOPES.join(" ") }),
    computeQuiet: await signInAt(h, userId, computeQuiet, { scope: COMPUTE_SCOPES.join(" ") }),
    other: await signInAt(h, userId, other),
  };
  return { compute, computeQuiet, other, userId, held };
}

describe("a suspension or a revocation of compute access", () => {
  for (const decision of ["suspend", "revoke"] as const) {
    test(`${decision} ends the compute grants, tells only the compute client that has an address, and leaves the others signed in`, async () => {
      const w = await world();
      setState(w.userId, "active");

      const res = await decide(decision, w.userId);
      expect(res.status).toBe(200);
      await h.settle();

      expect(await stillWorks(h, w.held.compute)).toBe(false);
      expect(await stillWorks(h, w.held.computeQuiet)).toBe(false);
      expect(await stillWorks(h, w.held.other)).toBe(true);
      expect(deliveries(h, w.userId).map((d) => [d.client_id, d.reason])).toEqual([
        [clientRowId(h, w.compute), "compute_suspended"],
      ]);
      expect(revokedReasons(h, w.userId)).toEqual(["compute_suspended"]);
      // The unused codes of the compute grants are gone too; the other client's is not.
      expect(countsOf(h, w.userId).codesUnused).toBe(1);
    });
  }

  test("a grant, a denial and a request end no grant and tell no client", async () => {
    const w = await world();
    for (const [decision, from] of [
      ["grant", "requested"],
      ["deny", "requested"],
    ] as const) {
      setState(w.userId, from);
      expect([decision, (await decide(decision, w.userId)).status]).toEqual([decision, 200]);
    }
    await h.settle();
    expect(await stillWorks(h, w.held.compute)).toBe(true);
    expect(await stillWorks(h, w.held.other)).toBe(true);
    expect(deliveries(h, w.userId)).toEqual([]);
  });

  test("the statements are guarded on the state the flip leaves: run while the account is elsewhere, they end nothing (MUTATION: drop the guard)", async () => {
    // A decision that lost a race runs its batch with the account in a state other than the one its flip
    // would have left. `endComputeStatements` is the batch's tail, so it is run here directly, against the
    // real tables, with the account `active` and the guard asking for `suspended`.
    const w = await world();
    setState(w.userId, "active");
    h.db.run(
      "INSERT INTO compute_pools (holder_kind, holder_ref, pool) VALUES ('account', ?, 'cpu')",
      [String(w.userId)],
    );
    const statements = endComputeStatements(w.userId, "suspended");
    await h.env.DB.batch(statements.map((s) => h.env.DB.prepare(s.sql).bind(...s.binds)));
    expect(await stillWorks(h, w.held.compute)).toBe(true);
    expect(deliveries(h, w.userId)).toEqual([]);
    expect(
      (
        h.db
          .query("SELECT frozen FROM compute_pools WHERE holder_ref = ?")
          .get(String(w.userId)) as {
          frozen: number;
        }
      ).frozen,
    ).toBe(0);
    // And once the account IS suspended, the same statements end the compute grants.
    setState(w.userId, "suspended");
    await h.env.DB.batch(statements.map((s) => h.env.DB.prepare(s.sql).bind(...s.binds)));
    expect(await stillWorks(h, w.held.compute)).toBe(false);
    expect(await stillWorks(h, w.held.other)).toBe(true);
  });

  test("the OIDC end is atomic with the decision: a failing statement leaves every grant live", async () => {
    const w = await world();
    setState(w.userId, "active");
    h.db.exec(
      "CREATE TRIGGER oidc_boom BEFORE UPDATE OF revoked_at ON oidc_grants BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    const res = await decide("suspend", w.userId);
    expect(res.status).toBe(500);
    h.db.exec("DROP TRIGGER oidc_boom");
    expect(
      (
        h.db.query("SELECT compute_access FROM users WHERE id = ?").get(w.userId) as {
          compute_access: string;
        }
      ).compute_access,
    ).toBe("active");
    expect(await stillWorks(h, w.held.compute)).toBe(true);
    expect(deliveries(h, w.userId)).toEqual([]);
  });
});
