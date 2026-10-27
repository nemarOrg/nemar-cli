/**
 * The allow-list of authenticated NEMAR data hosts (src/lib/data-hosts.ts, ADR 0114): the one
 * place that says where this CLI may send its API key besides the API itself.
 *
 * Pure functions over explicit environments, so each build default and each way
 * `NEMAR_DATA_HOSTS` can be written or misspelled is a row in a table.
 */

import { describe, expect, test } from "bun:test";
import {
  DEV_DATA_HOST,
  PRODUCTION_DATA_HOST,
  allowedDataHosts,
  dataHostOriginOfUrl,
  isAllowedDataHost,
  isDataHostDatasetId,
  isPermittedTransport,
  parseDataHostList,
  parseDataHostOrigin,
  rejectedDataHostEntries,
} from "../src/lib/data-hosts";

describe("build defaults", () => {
  test("a production build allows the production data host and nothing else", () => {
    expect(allowedDataHosts({ env: {}, isDevBuild: false })).toEqual([PRODUCTION_DATA_HOST]);
    expect(PRODUCTION_DATA_HOST).toBe("https://private.nemar.org");
  });

  test("a dev build allows the staging data host and not the production one", () => {
    expect(allowedDataHosts({ env: {}, isDevBuild: true })).toEqual([DEV_DATA_HOST]);
    expect(DEV_DATA_HOST).toBe("https://private-test.nemar.org");
    expect(isAllowedDataHost(PRODUCTION_DATA_HOST, { env: {}, isDevBuild: true })).toBe(false);
    expect(isAllowedDataHost(DEV_DATA_HOST, { env: {}, isDevBuild: false })).toBe(false);
  });

  test("this build's own flag decides when none is given", () => {
    // Tests run from source, which is a production build (the dev rewrite is a CI step).
    expect(allowedDataHosts({ env: {} })).toEqual([PRODUCTION_DATA_HOST]);
  });
});

describe("NEMAR_DATA_HOSTS_ONLY", () => {
  test("1 drops the build default, leaving exactly the environment's origins", () => {
    const env = { NEMAR_DATA_HOSTS_ONLY: "1", NEMAR_DATA_HOSTS: "https://staging.example.org" };
    expect(allowedDataHosts({ env, isDevBuild: false })).toEqual(["https://staging.example.org"]);
    expect(isAllowedDataHost(PRODUCTION_DATA_HOST, { env, isDevBuild: false })).toBe(false);
  });

  test("with no origins it leaves an empty list: nothing is allowed", () => {
    expect(allowedDataHosts({ env: { NEMAR_DATA_HOSTS_ONLY: "1" }, isDevBuild: false })).toEqual(
      [],
    );
  });

  test("only the exact value 1 narrows the list", () => {
    for (const value of ["", "0", "true", "yes", "TRUE", " 1"]) {
      const env = { NEMAR_DATA_HOSTS_ONLY: value };
      expect([value, allowedDataHosts({ env, isDevBuild: false })]).toEqual([
        value,
        [PRODUCTION_DATA_HOST],
      ]);
    }
  });
});

describe("NEMAR_DATA_HOSTS", () => {
  test("adds origins after the defaults, once each, in order", () => {
    const env = {
      NEMAR_DATA_HOSTS:
        "https://staging.example.org, https://other.example.org:8443,https://staging.example.org",
    };
    expect(allowedDataHosts({ env, isDevBuild: false })).toEqual([
      PRODUCTION_DATA_HOST,
      "https://staging.example.org",
      "https://other.example.org:8443",
    ]);
  });

  test("an entry that repeats a default adds nothing", () => {
    const env = { NEMAR_DATA_HOSTS: "https://private.nemar.org/" };
    expect(allowedDataHosts({ env, isDevBuild: false })).toEqual([PRODUCTION_DATA_HOST]);
  });

  test("normalizes case and a default port, so equivalent spellings compare equal", () => {
    const env = { NEMAR_DATA_HOSTS: "HTTPS://Staging.Example.ORG:443" };
    expect(allowedDataHosts({ env, isDevBuild: false })).toContain("https://staging.example.org");
    expect(isAllowedDataHost("https://STAGING.example.org", { env, isDevBuild: false })).toBe(true);
  });

  test("loopback http is accepted, and only loopback", () => {
    const env = {
      NEMAR_DATA_HOSTS: "http://127.0.0.1:8787,http://localhost:9000,http://[::1]:9100",
    };
    expect(allowedDataHosts({ env, isDevBuild: false })).toEqual([
      PRODUCTION_DATA_HOST,
      "http://127.0.0.1:8787",
      "http://localhost:9000",
      "http://[::1]:9100",
    ]);
  });

  const refused = [
    "http://example.com",
    "http://192.168.0.5:8080",
    "http://10.0.0.1",
    "http://127.0.0.1.example.com",
    "http://localhost.example.com",
    "https://example.org/path",
    "https://example.org/?x=1",
    "https://example.org#frag",
    "https://user:pw@example.org",
    "ftp://example.org",
    "file:///etc/passwd",
    "example.org",
    "not a url",
    "//example.org",
  ];

  for (const entry of refused) {
    test(`refuses ${JSON.stringify(entry)} and reports it`, () => {
      const env = { NEMAR_DATA_HOSTS: entry };
      expect(allowedDataHosts({ env, isDevBuild: false })).toEqual([PRODUCTION_DATA_HOST]);
      expect(rejectedDataHostEntries({ env })).toEqual([entry]);
    });
  }

  test("empty, blank and missing values add nothing and reject nothing", () => {
    for (const value of [undefined, "", "   ", " , ,"]) {
      expect(parseDataHostList(value)).toEqual({ origins: [], rejected: [] });
    }
  });

  test("one bad entry does not spoil its neighbours", () => {
    const parsed = parseDataHostList(
      "https://a.example.org,http://evil.example,https://b.example.org",
    );
    expect(parsed.origins).toEqual(["https://a.example.org", "https://b.example.org"]);
    expect(parsed.rejected).toEqual(["http://evil.example"]);
  });
});

describe("parseDataHostOrigin", () => {
  test("a bare origin, with or without the trailing slash", () => {
    expect(parseDataHostOrigin("https://private.nemar.org")).toBe("https://private.nemar.org");
    expect(parseDataHostOrigin(" https://private.nemar.org/ ")).toBe("https://private.nemar.org");
  });

  test("anything beyond an origin is refused", () => {
    for (const value of [
      "",
      "https://",
      "https://private.nemar.org/git",
      "https://private.nemar.org?",
      "https://private.nemar.org/?",
      "https://private.nemar.org#",
      "https://@private.nemar.org",
      "https://u:p@private.nemar.org",
    ]) {
      expect([value, parseDataHostOrigin(value)]).toEqual([value, null]);
    }
  });
});

describe("isAllowedDataHost compares origins exactly", () => {
  const options = { env: {}, isDevBuild: false };

  test("the listed origin", () => {
    expect(isAllowedDataHost("https://private.nemar.org", options)).toBe(true);
  });

  test("a different scheme, host, subdomain or port is another origin", () => {
    for (const value of [
      "http://private.nemar.org",
      "https://private.nemar.org:8443",
      "https://sub.private.nemar.org",
      "https://private.nemar.org.example.org",
      "https://nemar.org",
      "https://private-test.nemar.org",
      "https://api.nemar.org",
    ]) {
      expect([value, isAllowedDataHost(value, options)]).toEqual([value, false]);
    }
  });

  test("a loopback http host is allowed only on the port the environment names", () => {
    const env = { NEMAR_DATA_HOSTS: "http://127.0.0.1:8787" };
    expect(isAllowedDataHost("http://127.0.0.1:8787", { env, isDevBuild: false })).toBe(true);
    expect(isAllowedDataHost("http://127.0.0.1:8788", { env, isDevBuild: false })).toBe(false);
    expect(isAllowedDataHost("http://localhost:8787", { env, isDevBuild: false })).toBe(false);
    expect(isAllowedDataHost("http://127.0.0.1:8787", options)).toBe(false);
  });
});

describe("dataHostOriginOfUrl", () => {
  const options = { env: {}, isDevBuild: false };

  test("a repository URL on an allowed origin gives that origin", () => {
    expect(dataHostOriginOfUrl("https://private.nemar.org/git/np099999.git", options)).toBe(
      "https://private.nemar.org",
    );
  });

  test("other hosts, credentials in the URL and non-URLs give null", () => {
    for (const url of [
      "https://github.com/nemarDatasets/nm000104.git",
      "git@github.com:nemarDatasets/nm000104.git",
      "https://evil.example/git/np099999.git",
      "https://user:pw@private.nemar.org/git/np099999.git",
      "http://private.nemar.org/git/np099999.git",
      "/some/local/path",
      "",
    ]) {
      expect([url, dataHostOriginOfUrl(url, options)]).toEqual([url, null]);
    }
  });
});

describe("isPermittedTransport", () => {
  test("https is always permitted", () => {
    expect(
      isPermittedTransport(
        new URL("https://storage.example.org/x?sig=1"),
        "https://private.nemar.org",
      ),
    ).toBe(true);
  });

  test("http is permitted only on loopback and only for a loopback http data host", () => {
    const local = "http://127.0.0.1:8787";
    expect(isPermittedTransport(new URL("http://127.0.0.1:9000/blob"), local)).toBe(true);
    expect(isPermittedTransport(new URL("http://localhost:9000/blob"), local)).toBe(true);
    expect(isPermittedTransport(new URL("http://example.org/blob"), local)).toBe(false);
    expect(
      isPermittedTransport(new URL("http://127.0.0.1:9000/blob"), "https://private.nemar.org"),
    ).toBe(false);
  });

  test("other schemes are never permitted", () => {
    for (const url of [
      "ftp://example.org/x",
      "file:///etc/passwd",
      "data:text/plain,x",
      "ws://127.0.0.1/x",
    ]) {
      expect([url, isPermittedTransport(new URL(url), "http://127.0.0.1:8787")]).toEqual([
        url,
        false,
      ]);
    }
  });
});

describe("dataset ids", () => {
  test("two or three lower-case letters and six digits", () => {
    for (const id of ["np099999", "nm000104", "xyz123456", "ab000001"]) {
      expect([id, isDataHostDatasetId(id)]).toEqual([id, true]);
    }
  });

  test("anything else is not one", () => {
    for (const id of [
      "NP099999",
      "np99999",
      "np0999999",
      "n1099999",
      "abcd123456",
      "np09999a",
      "np099999\n",
      " np099999",
      "../np099999",
      "",
    ]) {
      expect([id, isDataHostDatasetId(id)]).toEqual([id, false]);
    }
  });
});
