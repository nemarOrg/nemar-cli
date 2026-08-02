/**
 * Unit tests for the ORCID SSO service helpers (#832).
 *
 * Pure helpers are tested directly; the code->token exchange runs against a
 * real Bun.serve token endpoint (no mocks), mirroring test/github-auth.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type OrcidConfig,
  buildAuthorizeUrl,
  decideLinkOutcome,
  decideSecondOrcidOutcome,
  decideVerifiedFlag,
  decodeState,
  encodeState,
  exchangeCodeForOrcid,
  fetchOrcidName,
  getOrcidConfig,
  isValidOrcidId,
  normalizeOrcidId,
  safeNextPath,
  signPending,
  verifyPending,
} from "../backend/src/services/orcid-auth";
import type { Bindings } from "../backend/src/types/bindings";

const SECRET = "test-encryption-key-0123456789";

describe("isValidOrcidId / normalizeOrcidId", () => {
  test("accepts a canonical iD and the X checksum form", () => {
    expect(isValidOrcidId("0000-0002-1825-0097")).toBe(true);
    expect(isValidOrcidId("0000-0001-5109-353X")).toBe(true);
  });
  test("rejects malformed values", () => {
    expect(isValidOrcidId("0000-0002-1825-009")).toBe(false);
    expect(isValidOrcidId("not-an-orcid")).toBe(false);
    expect(isValidOrcidId(null)).toBe(false);
  });
  test("normalizes a full URI to the bare iD", () => {
    expect(normalizeOrcidId("https://orcid.org/0000-0002-1825-0097")).toBe("0000-0002-1825-0097");
    expect(normalizeOrcidId("  0000-0001-5109-353X ")).toBe("0000-0001-5109-353X");
    expect(normalizeOrcidId("garbage")).toBeNull();
  });
});

describe("buildAuthorizeUrl", () => {
  test("builds the authorize URL with the expected params", () => {
    const url = new URL(
      buildAuthorizeUrl({
        config: { base: "https://sandbox.orcid.org", clientId: "APP-123" },
        redirectUri: "https://app.nemar.org/auth/orcid/callback",
        state: "csrf-xyz",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://sandbox.orcid.org/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("APP-123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("/authenticate");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.nemar.org/auth/orcid/callback");
    expect(url.searchParams.get("state")).toBe("csrf-xyz");
  });
});

describe("encodeState / decodeState", () => {
  test("round-trips and sanitizes next", () => {
    const enc = encodeState({ csrf: "abc", mode: "link", next: "/welcome" });
    const dec = decodeState(enc);
    expect(dec).toEqual({ csrf: "abc", mode: "link", next: "/welcome" });
  });
  test("round-trips the relink mode (#913)", () => {
    const enc = encodeState({ csrf: "abc", mode: "relink", next: "/settings" });
    expect(decodeState(enc)).toEqual({ csrf: "abc", mode: "relink", next: "/settings" });
  });
  test("defaults an unknown mode to login and strips open-redirect next", () => {
    const enc = encodeState({
      csrf: "abc",
      mode: "weird" as unknown as "login",
      next: "//evil.com",
    });
    const dec = decodeState(enc);
    expect(dec?.mode).toBe("login");
    expect(dec?.next).toBe("/");
  });
  test("returns null on garbage or missing csrf", () => {
    expect(decodeState("not-base64!!")).toBeNull();
    expect(decodeState(encodeState({ csrf: "", mode: "login", next: "/" }))).toBeNull();
    expect(decodeState(null)).toBeNull();
  });
  test("rejects a non-string csrf in an attacker-crafted cookie", () => {
    const raw = btoa(JSON.stringify({ csrf: 0, mode: "login", next: "/" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
    expect(decodeState(raw)).toBeNull();
  });
});

describe("safeNextPath", () => {
  test("keeps same-origin absolute paths, rejects everything else", () => {
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
    expect(safeNextPath("//evil.com")).toBe("/");
    expect(safeNextPath("https://evil.com")).toBe("/");
    expect(safeNextPath("/a\\b")).toBe("/");
    expect(safeNextPath(null)).toBe("/");
  });
  test("rejects percent-encoded open-redirect bypass, keeps benign encoding raw", () => {
    expect(safeNextPath("/%2F%2Fevil.com")).toBe("/"); // decodes to //evil.com
    expect(safeNextPath("/valid%20path")).toBe("/valid%20path"); // raw value preserved
  });
});

describe("decideLinkOutcome", () => {
  test("covers link_new / already_linked / conflict", () => {
    expect(decideLinkOutcome(null, 7)).toBe("link_new");
    expect(decideLinkOutcome(7, 7)).toBe("already_linked");
    expect(decideLinkOutcome(9, 7)).toBe("conflict");
  });
});

describe("decideSecondOrcidOutcome (#913)", () => {
  test("only an explicit relink flow may replace an existing linked iD", () => {
    expect(decideSecondOrcidOutcome("relink")).toBe("replace");
    expect(decideSecondOrcidOutcome("link")).toBe("refuse");
    expect(decideSecondOrcidOutcome("login")).toBe("refuse");
  });
});

describe("decideVerifiedFlag", () => {
  test("adopts the verified iD when users.orcid is empty", () => {
    expect(decideVerifiedFlag(null, "0000-0002-1825-0097")).toEqual({
      setUsersOrcid: "0000-0002-1825-0097",
      orcidVerified: 1,
      needsAdminReview: false,
    });
  });
  test("marks verified when discovered value already agrees", () => {
    expect(decideVerifiedFlag("0000-0002-1825-0097", "0000-0002-1825-0097")).toEqual({
      setUsersOrcid: null,
      orcidVerified: 1,
      needsAdminReview: false,
    });
  });
  test("flags for review and preserves the citation value on mismatch", () => {
    expect(decideVerifiedFlag("0000-0002-1825-0097", "0000-0001-5109-353X")).toEqual({
      setUsersOrcid: null,
      orcidVerified: 0,
      needsAdminReview: true,
    });
  });
  test("normalizes a URI-format discovered value before comparing", () => {
    // The DOI-enrichment pipeline stores iDs as full URIs; these must compare
    // equal to a bare verified iD, not falsely trigger admin review.
    expect(
      decideVerifiedFlag("https://orcid.org/0000-0002-1825-0097", "0000-0002-1825-0097"),
    ).toEqual({ setUsersOrcid: null, orcidVerified: 1, needsAdminReview: false });
    expect(
      decideVerifiedFlag("https://orcid.org/0000-0002-1825-0097", "0000-0001-5109-353X"),
    ).toEqual({ setUsersOrcid: null, orcidVerified: 0, needsAdminReview: true });
  });
  test("treats a garbage or empty existing value as absent", () => {
    expect(decideVerifiedFlag("not-an-orcid", "0000-0002-1825-0097")).toEqual({
      setUsersOrcid: "0000-0002-1825-0097",
      orcidVerified: 1,
      needsAdminReview: false,
    });
    expect(decideVerifiedFlag("", "0000-0002-1825-0097")).toEqual({
      setUsersOrcid: "0000-0002-1825-0097",
      orcidVerified: 1,
      needsAdminReview: false,
    });
  });
});

describe("signPending / verifyPending", () => {
  test("round-trips a valid token", async () => {
    const token = await signPending(
      { orcid: "0000-0002-1825-0097", name: "Ada", exp: Date.now() + 60_000 },
      SECRET,
    );
    const out = await verifyPending(token, SECRET, Date.now());
    expect(out?.orcid).toBe("0000-0002-1825-0097");
    expect(out?.name).toBe("Ada");
  });
  test("rejects a tampered payload", async () => {
    const token = await signPending(
      { orcid: "0000-0002-1825-0097", name: null, exp: Date.now() + 60_000 },
      SECRET,
    );
    const tampered = `${token.slice(0, -2)}xx`;
    expect(await verifyPending(tampered, SECRET, Date.now())).toBeNull();
  });
  test("rejects a wrong secret and an expired token", async () => {
    const token = await signPending(
      { orcid: "0000-0002-1825-0097", name: null, exp: Date.now() + 60_000 },
      SECRET,
    );
    expect(await verifyPending(token, "other-secret", Date.now())).toBeNull();
    const expired = await signPending(
      { orcid: "0000-0002-1825-0097", name: null, exp: Date.now() - 1 },
      SECRET,
    );
    expect(await verifyPending(expired, SECRET, Date.now())).toBeNull();
  });
  test("rejects structurally malformed tokens", async () => {
    expect(await verifyPending("nodothere", SECRET, Date.now())).toBeNull();
    expect(await verifyPending(".abc", SECRET, Date.now())).toBeNull();
    expect(await verifyPending(null, SECRET, Date.now())).toBeNull();
  });
  test("rejects a valid-HMAC token whose payload carries a malformed iD", async () => {
    // A leaked secret must still not let an arbitrary iD through: the decode
    // path re-validates the ORCID iD shape.
    const token = await signPending(
      { orcid: "not-an-orcid", name: null, exp: Date.now() + 60_000 },
      SECRET,
    );
    expect(await verifyPending(token, SECRET, Date.now())).toBeNull();
  });
  test("round-trips a null name (ORCID withheld it)", async () => {
    const token = await signPending(
      { orcid: "0000-0002-1825-0097", name: null, exp: Date.now() + 60_000 },
      SECRET,
    );
    const out = await verifyPending(token, SECRET, Date.now());
    expect(out?.orcid).toBe("0000-0002-1825-0097");
    expect(out?.name).toBeNull();
  });
  test("treats now === exp as still valid; now > exp as expired", async () => {
    const exp = Date.now() + 5_000;
    const token = await signPending({ orcid: "0000-0002-1825-0097", name: null, exp }, SECRET);
    expect(await verifyPending(token, SECRET, exp)).not.toBeNull();
    expect(await verifyPending(token, SECRET, exp + 1)).toBeNull();
  });
});

describe("getOrcidConfig", () => {
  test("returns null when client credentials are unset", () => {
    expect(getOrcidConfig({ ENVIRONMENT: "development" } as unknown as Bindings)).toBeNull();
  });
  test("defaults base to sandbox outside production and trims trailing slash", () => {
    const cfg = getOrcidConfig({
      ENVIRONMENT: "development",
      ORCID_CLIENT_ID: "APP-1",
      ORCID_CLIENT_SECRET: "secret",
    } as unknown as Bindings);
    expect(cfg?.base).toBe("https://sandbox.orcid.org");
  });
  test("defaults base to production host in production", () => {
    const cfg = getOrcidConfig({
      ENVIRONMENT: "production",
      ORCID_CLIENT_ID: "APP-1",
      ORCID_CLIENT_SECRET: "secret",
    } as unknown as Bindings);
    expect(cfg?.base).toBe("https://orcid.org");
  });
  test("honours an explicit ORCID_API_BASE and trims its trailing slash", () => {
    const cfg = getOrcidConfig({
      ENVIRONMENT: "production",
      ORCID_CLIENT_ID: "APP-1",
      ORCID_CLIENT_SECRET: "secret",
      ORCID_API_BASE: "https://sandbox.orcid.org/",
    } as unknown as Bindings);
    expect(cfg?.base).toBe("https://sandbox.orcid.org");
  });
});

describe("exchangeCodeForOrcid", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  // Drives the next token-endpoint response.
  let next: { status: number; body: unknown };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/oauth/token") {
          // Assert the exchange posts form-encoded grant params plus the
          // confidential-client credentials (ORCID 401s without them).
          const form = new URLSearchParams(await req.text());
          if (
            form.get("grant_type") !== "authorization_code" ||
            !form.get("code") ||
            !form.get("client_id") ||
            !form.get("client_secret")
          ) {
            return new Response("bad request", { status: 400 });
          }
          return new Response(JSON.stringify(next.body), {
            status: next.status,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => server.stop(true));

  function cfg(): OrcidConfig {
    return { base, clientId: "APP-1", clientSecret: "secret" };
  }

  test("returns the iD and name from the token response", async () => {
    next = {
      status: 200,
      body: { access_token: "x", orcid: "0000-0002-1825-0097", name: "Ada Lovelace" },
    };
    const out = await exchangeCodeForOrcid(cfg(), "the-code", "https://app.nemar.org/cb");
    expect(out).toEqual({ orcid: "0000-0002-1825-0097", name: "Ada Lovelace" });
  });

  test("treats a blank name as null", async () => {
    next = { status: 200, body: { orcid: "0000-0002-1825-0097", name: "   " } };
    const out = await exchangeCodeForOrcid(cfg(), "the-code", "https://app.nemar.org/cb");
    expect(out.name).toBeNull();
  });

  test("normalizes a URI-format orcid in the token response to the bare iD", async () => {
    next = {
      status: 200,
      body: { orcid: "https://orcid.org/0000-0002-1825-0097", name: "Ada" },
    };
    const out = await exchangeCodeForOrcid(cfg(), "the-code", "https://app.nemar.org/cb");
    expect(out.orcid).toBe("0000-0002-1825-0097");
  });

  test("throws on a non-ok response", async () => {
    next = { status: 401, body: { error: "invalid_client" } };
    await expect(
      exchangeCodeForOrcid(cfg(), "the-code", "https://app.nemar.org/cb"),
    ).rejects.toThrow();
  });

  test("throws when the response has no valid orcid", async () => {
    next = { status: 200, body: { access_token: "x", name: "Ada" } };
    await expect(
      exchangeCodeForOrcid(cfg(), "the-code", "https://app.nemar.org/cb"),
    ).rejects.toThrow();
  });
});

describe("fetchOrcidName", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let next: { status: number; body: unknown };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname.endsWith("/personal-details")) {
          return new Response(JSON.stringify(next.body), {
            status: next.status,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    base = `http://localhost:${server.port}`;
  });

  afterAll(() => server.stop(true));

  test("extracts given + family from the public record", async () => {
    next = {
      status: 200,
      body: {
        name: {
          "given-names": { value: "Ada" },
          "family-name": { value: "Lovelace" },
        },
      },
    };
    expect(await fetchOrcidName("0000-0002-1825-0097", base)).toEqual({
      given: "Ada",
      family: "Lovelace",
    });
  });

  test("returns nulls when the record hides its name", async () => {
    next = { status: 200, body: { name: null } };
    expect(await fetchOrcidName("0000-0002-1825-0097", base)).toEqual({
      given: null,
      family: null,
    });
  });

  test("returns nulls for blank/missing name parts", async () => {
    next = { status: 200, body: { name: { "given-names": { value: "  " } } } };
    expect(await fetchOrcidName("0000-0002-1825-0097", base)).toEqual({
      given: null,
      family: null,
    });
  });

  test("throws on a non-ok response", async () => {
    next = { status: 404, body: { error: "not found" } };
    await expect(fetchOrcidName("0000-0002-1825-0097", base)).rejects.toThrow();
  });
});
