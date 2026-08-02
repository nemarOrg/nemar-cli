/**
 * Unit tests for the PATCH /auth/profile field semantics (#912),
 * backend/src/services/profile.ts. Pure functions, no network — the live
 * endpoint flow (session, GitHub existence, dedup, audit) is covered in
 * test/auth-passwordless.test.ts against the deployed dev backend.
 */

import { describe, expect, test } from "bun:test";
import {
  GITHUB_HANDLE_RE,
  githubHandleChanged,
  normalizeProfilePatch,
} from "../backend/src/services/profile";

describe("GITHUB_HANDLE_RE", () => {
  const valid = ["octocat", "a", "A1", "my-handle", "x0-y1-z2", "a".repeat(39)];
  const invalid = [
    "",
    "-leading",
    "trailing-",
    "double--hyphen",
    "under_score",
    "space here",
    "a".repeat(40),
    "@octocat", // @ must be stripped before the regex, not accepted by it
  ];

  for (const h of valid) {
    test(`accepts ${JSON.stringify(h)}`, () => {
      expect(GITHUB_HANDLE_RE.test(h)).toBe(true);
    });
  }
  for (const h of invalid) {
    test(`rejects ${JSON.stringify(h)}`, () => {
      expect(GITHUB_HANDLE_RE.test(h)).toBe(false);
    });
  }
});

describe("normalizeProfilePatch", () => {
  test("full patch: trims, strips leading @, passes values through", () => {
    const r = normalizeProfilePatch({
      github_username: " @octocat ",
      city: " San Diego ",
      country: " USA ",
      affiliation: " UCSD ",
    });
    expect(r).toEqual({
      ok: true,
      patch: {
        github_username: "octocat",
        city: "San Diego",
        country: "USA",
        affiliation: "UCSD",
      },
    });
  });

  test("subset patch: absent keys stay absent (true PATCH semantics)", () => {
    const r = normalizeProfilePatch({ city: "La Jolla", country: "USA" });
    if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
    expect(r.patch).toEqual({ city: "La Jolla", country: "USA" });
    expect("github_username" in r.patch).toBe(false);
    expect("affiliation" in r.patch).toBe(false);
  });

  test("empty github_username clears to null", () => {
    const r = normalizeProfilePatch({ github_username: "" });
    expect(r).toEqual({ ok: true, patch: { github_username: null } });
  });

  test("a bare @ clears to null (stray paste artifact, empty handle)", () => {
    const r = normalizeProfilePatch({ github_username: "@" });
    expect(r).toEqual({ ok: true, patch: { github_username: null } });
  });

  test("empty affiliation clears to null", () => {
    const r = normalizeProfilePatch({ affiliation: "  " });
    expect(r).toEqual({ ok: true, patch: { affiliation: null } });
  });

  test("invalid github handle is rejected with the website's error code", () => {
    const r = normalizeProfilePatch({ github_username: "-bad-" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error).toBe("invalid_github_username");
  });

  test("empty city is rejected (export-control non-empty rule)", () => {
    const r = normalizeProfilePatch({ city: "  ", country: "USA" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error).toBe("city_required");
  });

  test("empty country is rejected (export-control non-empty rule)", () => {
    const r = normalizeProfilePatch({ city: "San Diego", country: "" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error).toBe("country_required");
  });

  test("city/country cannot be cleared, unlike github/affiliation", () => {
    // The clearing convention (empty string -> NULL) deliberately does not
    // extend to the export-control fields.
    expect(normalizeProfilePatch({ city: "" }).ok).toBe(false);
    expect(normalizeProfilePatch({ country: "" }).ok).toBe(false);
  });

  test("body with no profile keys is an explicit error, not a silent no-op", () => {
    const r = normalizeProfilePatch({});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error).toBe("empty_patch");
  });
});

describe("githubHandleChanged", () => {
  test("case-insensitive match against the stored handle is not a change", () => {
    expect(githubHandleChanged("Octocat", "octocat")).toBe(false);
    expect(githubHandleChanged("octocat", "octocat")).toBe(false);
  });

  test("different handle, or no stored handle, is a change", () => {
    expect(githubHandleChanged("octocat", "monalisa")).toBe(true);
    expect(githubHandleChanged("octocat", null)).toBe(true);
    expect(githubHandleChanged("octocat", "")).toBe(true);
  });
});
