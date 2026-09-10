/**
 * Tests for the shared CORS origin tables (#1346).
 *
 * These encode a security boundary, so the block cases matter as much as the
 * allow cases: the point of scoping the Pages allowance to our own project names
 * is that anyone can create a `*.pages.dev` host, and nobody else can create one
 * under `nemar-website.pages.dev`.
 */

import { describe, expect, test } from "bun:test";
import {
  WEBSITE_PAGES_HOSTS,
  isNemarWebOrigin,
  isWebsitePagesHost,
} from "../src/services/cors-origins";

describe("isWebsitePagesHost", () => {
  test("allows each project's apex and its preview subdomains", () => {
    for (const host of WEBSITE_PAGES_HOSTS) {
      expect(isWebsitePagesHost(host)).toBe(true);
      expect(isWebsitePagesHost(`branch-name.${host}`)).toBe(true);
      expect(isWebsitePagesHost(`a1b2c3d4.${host}`)).toBe(true);
    }
  });

  test("covers both website projects", () => {
    expect(isWebsitePagesHost("nemar-website.pages.dev")).toBe(true);
    expect(isWebsitePagesHost("nemar-website-test.pages.dev")).toBe(true);
  });

  test("rejects a project label that merely ends with ours", () => {
    // The character before the project label must be a dot, not a hyphen, or
    // registering `evil-nemar-website` would buy an attacker the allowance.
    expect(isWebsitePagesHost("evil-nemar-website.pages.dev")).toBe(false);
    expect(isWebsitePagesHost("x.evil-nemar-website.pages.dev")).toBe(false);
    expect(isWebsitePagesHost("xnemar-website.pages.dev")).toBe(false);
  });

  test("rejects our name used as a prefix of someone else's domain", () => {
    expect(isWebsitePagesHost("nemar-website.pages.dev.evil.com")).toBe(false);
    expect(isWebsitePagesHost("nemar-website.pages.dev.evil.example")).toBe(false);
  });

  test("rejects unrelated Pages hosts and the bare suffix", () => {
    expect(isWebsitePagesHost("pages.dev")).toBe(false);
    expect(isWebsitePagesHost("someone-else.pages.dev")).toBe(false);
    expect(isWebsitePagesHost("nemar-cli.pages.dev")).toBe(false);
    expect(isWebsitePagesHost("")).toBe(false);
  });
});

describe("isNemarWebOrigin", () => {
  test("allows the nemar.org surfaces", () => {
    for (const host of [
      "nemar.org",
      "www.nemar.org",
      "ww2.nemar.org",
      "app.nemar.org",
      "test.nemar.org",
    ]) {
      expect(isNemarWebOrigin(host)).toBe(true);
    }
  });

  test("allows loopback for local development", () => {
    expect(isNemarWebOrigin("localhost")).toBe(true);
    expect(isNemarWebOrigin("127.0.0.1")).toBe(true);
  });

  test("allows the Pages previews", () => {
    expect(isNemarWebOrigin("326-viewer-deep-links.nemar-website.pages.dev")).toBe(true);
  });

  test("blocks lookalikes and third parties", () => {
    for (const host of [
      "notnemar.org",
      "nemar.org.evil.com",
      "openneuro.org",
      "evil.example",
      "xnemar.org",
    ]) {
      expect(isNemarWebOrigin(host)).toBe(false);
    }
  });

  test("does not decide the api fork's legacy osc.earth allowance", () => {
    // That one stays inline in index.ts: the zarr fork must not inherit it.
    expect(isNemarWebOrigin("osc.earth")).toBe(false);
    expect(isNemarWebOrigin("www.osc.earth")).toBe(false);
  });
});
