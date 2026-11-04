/**
 * The OpenID Connect provider's fixed vocabulary (epic #2014 phase #2016; ADR 0119), read from
 * `shared/oidc.ts`: the scope catalogue, the token prefixes and lifetimes, the identifier formats.
 *
 * Every value here is written out a second time, from the ADR's tables, and compared with the
 * shared constant: a constant that drifted from the ADR fails here, and a test that merely read
 * the constant back would pass whatever it said. The file's own claim to be import-free is read
 * from its text, because a later import would pull the Worker into a module the CLI and the
 * website transcribe.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OIDC_ACCESS_TOKEN_PREFIX,
  OIDC_ACCESS_TOKEN_TTL_SECONDS,
  OIDC_AUTHORIZATION_CODE_TTL_SECONDS,
  OIDC_CLIENT_ID_HEX_LENGTH,
  OIDC_CLIENT_ID_PREFIX,
  OIDC_GRANTS,
  OIDC_ID_TOKEN_TTL_SECONDS,
  OIDC_KEY_MIN_NEXT_AGE_HOURS,
  OIDC_REFRESH_GRACE_SECONDS,
  OIDC_REFRESH_TOKEN_ABSOLUTE_SECONDS,
  OIDC_REFRESH_TOKEN_IDLE_SECONDS,
  OIDC_REFRESH_TOKEN_PREFIX,
  OIDC_RETIRED_KEY_PUBLISH_DAYS,
  OIDC_SCOPES,
  OIDC_SCOPE_NAMES,
  OIDC_SECRET_MIN_LENGTH,
  isMachineOnlyScope,
  isOidcClientId,
  isOidcKid,
  isOidcScope,
  oidcClaimsSupported,
} from "../../shared/oidc";

const DAY = 86_400;

describe("the scope catalogue is the ADR's table", () => {
  test("ten scopes, in the ADR's order", () => {
    expect([...OIDC_SCOPE_NAMES]).toEqual([
      "openid",
      "profile",
      "email",
      "orcid",
      "nemar.account",
      "offline_access",
      "compute.read",
      "compute.reserve",
      "compute.submit",
      "compute.stats",
    ]);
    expect(OIDC_SCOPES).toHaveLength(10);
  });

  test("compute.stats is the one machine-only scope", () => {
    const machineOnly = OIDC_SCOPES.filter((s) => s.machineOnly).map((s) => s.name);
    expect(machineOnly).toEqual(["compute.stats"]);
    expect(isMachineOnlyScope("compute.stats")).toBe(true);
    expect(isMachineOnlyScope("compute.read")).toBe(false);
    expect(isMachineOnlyScope("not-a-scope")).toBe(false);
  });

  test("isOidcScope accepts a catalogue name and nothing near it", () => {
    for (const name of OIDC_SCOPE_NAMES) expect(isOidcScope(name)).toBe(true);
    for (const bad of ["", "OpenID", "openid ", "compute", "compute.*", "admin", 7, null]) {
      expect(isOidcScope(bad)).toBe(false);
    }
  });

  test("the claims each scope carries are the ADR's (nemar.account names none yet)", () => {
    const claims = Object.fromEntries(OIDC_SCOPES.map((s) => [s.name, [...s.claims]]));
    expect(claims.openid).toEqual(["sub"]);
    expect(claims.profile).toEqual(["name", "given_name", "family_name"]);
    expect(claims.email).toEqual(["email", "email_verified"]);
    expect(claims.orcid).toEqual(["orcid", "orcid_verified"]);
    // ADR 0119 rule 6 says "account kind, status and tier" and names no claim, so none is declared
    // and discovery does not advertise one. The userinfo phase names them.
    expect(claims["nemar.account"]).toEqual([]);
    for (const compute of ["compute.read", "compute.reserve", "compute.submit", "compute.stats"]) {
      expect(claims[compute]).toEqual([]);
    }
  });

  test("claims_supported holds the identity token's own claims and every scope's", () => {
    expect(oidcClaimsSupported()).toEqual([
      "iss",
      "sub",
      "aud",
      "exp",
      "iat",
      "nonce",
      "name",
      "given_name",
      "family_name",
      "email",
      "email_verified",
      "orcid",
      "orcid_verified",
    ]);
  });

  test("the grants are the three the ADR allows", () => {
    expect([...OIDC_GRANTS]).toEqual(["authorization_code", "refresh_token", "client_credentials"]);
  });
});

describe("tokens: prefixes and lifetimes are the ADR's table", () => {
  test("prefixes, and neither can be read as an API key", () => {
    expect(OIDC_ACCESS_TOKEN_PREFIX).toBe("nmo_at_");
    expect(OIDC_REFRESH_TOKEN_PREFIX).toBe("nmo_rt_");
    // API keys are `nm_`: a prefix test for one must not match the other.
    expect(`${OIDC_ACCESS_TOKEN_PREFIX}x`.startsWith("nm_")).toBe(false);
    expect(`${OIDC_REFRESH_TOKEN_PREFIX}x`.startsWith("nm_")).toBe(false);
    expect(OIDC_ACCESS_TOKEN_PREFIX.startsWith(OIDC_REFRESH_TOKEN_PREFIX)).toBe(false);
  });

  test("lifetimes, in seconds", () => {
    expect(OIDC_AUTHORIZATION_CODE_TTL_SECONDS).toBe(60);
    expect(OIDC_ID_TOKEN_TTL_SECONDS).toBe(5 * 60);
    expect(OIDC_ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
    expect(OIDC_REFRESH_TOKEN_IDLE_SECONDS).toBe(30 * DAY);
    expect(OIDC_REFRESH_TOKEN_ABSOLUTE_SECONDS).toBe(90 * DAY);
    expect(OIDC_REFRESH_GRACE_SECONDS).toBe(30);
  });
});

describe("keys and identifiers", () => {
  test("the rotation rule: a next key is 24 hours old before it signs, a retired key is published 7 days", () => {
    expect(OIDC_KEY_MIN_NEXT_AGE_HOURS).toBe(24);
    expect(OIDC_RETIRED_KEY_PUBLISH_DAYS).toBe(7);
  });

  test("OIDC_SECRET must be at least 32 characters", () => {
    expect(OIDC_SECRET_MIN_LENGTH).toBe(32);
  });

  test("a client id is oc_ plus 24 lowercase hex", () => {
    expect(OIDC_CLIENT_ID_PREFIX).toBe("oc_");
    expect(OIDC_CLIENT_ID_HEX_LENGTH).toBe(24);
    const ok = `oc_${"0123456789abcdef".repeat(2).slice(0, 24)}`;
    expect(isOidcClientId(ok)).toBe(true);
    expect(isOidcClientId(ok.toUpperCase())).toBe(false);
    expect(isOidcClientId(`${ok}0`)).toBe(false);
    expect(isOidcClientId(ok.slice(0, -1))).toBe(false);
    expect(isOidcClientId(`ox_${ok.slice(3)}`)).toBe(false);
    expect(isOidcClientId(`oc_${"g".repeat(24)}`)).toBe(false);
    expect(isOidcClientId(null)).toBe(false);
  });

  test("a key id is 16 lowercase hex", () => {
    expect(isOidcKid("0123456789abcdef")).toBe(true);
    expect(isOidcKid("0123456789ABCDEF")).toBe(false);
    expect(isOidcKid("0123456789abcde")).toBe(false);
    expect(isOidcKid("0123456789abcdef0")).toBe(false);
    expect(isOidcKid("0123456789abcdeg")).toBe(false);
    expect(isOidcKid(undefined)).toBe(false);
  });
});

describe("the module is import-free", () => {
  test("shared/oidc.ts has no import or require", () => {
    const text = readFileSync(join(import.meta.dir, "../../shared/oidc.ts"), "utf-8");
    // Strip comments first: the header talks about imports.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/\brequire\(/);
    expect(code).not.toMatch(/\bimport\(/);
  });
});
