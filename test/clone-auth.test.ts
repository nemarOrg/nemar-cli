/**
 * Unit tests for the pure GitHub clone-auth resolver in src/lib/git-annex.ts.
 *
 * The finalize phase of the OpenNeuro import runs on a CI runner that has an
 * HTTPS App token (GH_TOKEN) but no SSH key. A raw `git@github.com:` clone of
 * the private NEMAR repo there fails with "Permission denied (publickey)"
 * (nemarOrg/nemar-cli#768). `resolveGitHubCloneAuth` decides whether to rewrite
 * the SSH URL to HTTPS-with-token; a wrong branch either leaks a malformed
 * credential helper or strands CI on SSH, so the matrix is covered exhaustively.
 */

import { describe, expect, test } from "bun:test";
import { githubTokenCredentialHelper, resolveGitHubCloneAuth } from "../src/lib/git-annex/github";

describe("resolveGitHubCloneAuth", () => {
  const ssh = "git@github.com:nemarDatasets/on007955.git";
  const https = "https://github.com/nemarDatasets/on007955.git";

  test("SSH URL + valid token -> HTTPS URL with credential helper", () => {
    const r = resolveGitHubCloneAuth(ssh, "ghs_abc123");
    expect(r.url).toBe(https);
    expect(r.credentialHelper).toBe(githubTokenCredentialHelper("ghs_abc123"));
    // The helper feeds the token to git as the x-access-token password.
    expect(r.credentialHelper).toContain("username=x-access-token");
    expect(r.credentialHelper).toContain("password=ghs_abc123");
  });

  test("SSH URL + null token -> SSH passthrough (developer's own key)", () => {
    const r = resolveGitHubCloneAuth(ssh, null);
    expect(r.url).toBe(ssh);
    expect(r.credentialHelper).toBeUndefined();
  });

  test("SSH URL + malformed token (empty / whitespace / single-quote) -> SSH passthrough", () => {
    // A single quote would break out of the printf credential helper's quoting,
    // so it's rejected the same as whitespace rather than emitting a broken helper.
    for (const bad of ["", "   ", "tok en", "tok\nen", "\t", "tok'en", "'"]) {
      const r = resolveGitHubCloneAuth(ssh, bad);
      expect(r.url).toBe(ssh);
      expect(r.credentialHelper).toBeUndefined();
    }
  });

  test("token surrounded by whitespace is trimmed, not rejected", () => {
    const r = resolveGitHubCloneAuth(ssh, "  ghs_padded  ");
    expect(r.url).toBe(https);
    expect(r.credentialHelper).toBe(githubTokenCredentialHelper("ghs_padded"));
  });

  test("already-HTTPS URL passes through untouched even with a token", () => {
    const r = resolveGitHubCloneAuth(https, "ghs_abc123");
    expect(r.url).toBe(https);
    expect(r.credentialHelper).toBeUndefined();
  });

  test("public OpenNeuro HTTPS clone is never rewritten", () => {
    const on = "https://github.com/OpenNeuroDatasets/ds007964.git";
    const r = resolveGitHubCloneAuth(on, "ghs_abc123");
    expect(r.url).toBe(on);
    expect(r.credentialHelper).toBeUndefined();
  });
});
