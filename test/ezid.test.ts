/**
 * EZID service tests
 *
 * Tests ANVL encoding/decoding, utility functions, and live API calls
 * against the EZID test shoulder (doi:10.5072/FK2).
 */

import { describe, test, expect } from "bun:test";
import {
  percentEncode,
  percentDecode,
  encodeAnvl,
  decodeAnvl,
  getDoiUrl,
  extractDoi,
  isTestShoulder,
  checkStatus,
  mintIdentifier,
  getIdentifier,
  updateIdentifier,
  deleteIdentifier,
  makePublic,
  TEST_SHOULDER,
  PRODUCTION_SHOULDER,
  type EzidAuth,
} from "../backend/src/services/ezid";

// Test credentials (public, safe to use)
const TEST_AUTH: EzidAuth = {
  username: "apitest",
  password: "ezidapitest2025!",
};

describe("ANVL encoding", () => {
  test("percentEncode encodes special characters", () => {
    expect(percentEncode("hello%world")).toBe("hello%25world");
    expect(percentEncode("line1\nline2")).toBe("line1%0Aline2");
    expect(percentEncode("return\rhere")).toBe("return%0Dhere");
    expect(percentEncode("no special")).toBe("no special");
  });

  test("percentDecode reverses encoding", () => {
    expect(percentDecode("hello%25world")).toBe("hello%world");
    expect(percentDecode("line1%0Aline2")).toBe("line1\nline2");
    expect(percentDecode("return%0Dhere")).toBe("return\rhere");
  });

  test("percentDecode handles combined encodings", () => {
    expect(percentDecode("a%25b%0Ac%0Dd")).toBe("a%b\nc\rd");
  });

  test("percentDecode handles multi-byte UTF-8", () => {
    // e-acute encoded as UTF-8 percent-encoded
    expect(percentDecode("%C3%A9")).toBe("\u00e9");
    // CJK character
    expect(percentDecode("%E4%B8%AD")).toBe("\u4e2d");
  });

  test("percentEncode/percentDecode roundtrip", () => {
    const values = ["hello%world\nnew\rline", "plain text", "100% done\n"];
    for (const v of values) {
      expect(percentDecode(percentEncode(v))).toBe(v);
    }
  });

  test("encodeAnvl formats key-value pairs", () => {
    const result = encodeAnvl({
      _target: "https://example.com",
      _status: "reserved",
    });
    expect(result).toBe("_target: https://example.com\n_status: reserved");
  });

  test("encodeAnvl preserves colons in values", () => {
    const result = encodeAnvl({ _target: "https://nemar.org:8080/path" });
    expect(result).toBe("_target: https://nemar.org:8080/path");
    expect(result).not.toContain("%3A");
  });

  test("decodeAnvl parses response", () => {
    const body = "success: doi:10.5072/FK2TEST\n_target: https%3A//example.com\n_status: reserved";
    const { status, fields } = decodeAnvl(body);
    expect(status).toBe("success: doi:10.5072/FK2TEST");
    expect(fields._target).toBe("https://example.com");
    expect(fields._status).toBe("reserved");
  });

  test("decodeAnvl handles continuation lines", () => {
    const body = [
      "success: doi:10.5072/FK2TEST",
      "datacite: <?xml version=\"1.0\"?>",
      " <resource>",
      " <title>Test</title>",
      " </resource>",
      "_status: reserved",
    ].join("\n");

    const { fields } = decodeAnvl(body);
    expect(fields.datacite).toContain("<?xml");
    expect(fields.datacite).toContain("<title>Test</title>");
    expect(fields.datacite).toContain("</resource>");
    expect(fields._status).toBe("reserved");
  });

  test("decodeAnvl handles empty body", () => {
    const { status, fields } = decodeAnvl("");
    expect(status).toBe("");
    expect(Object.keys(fields)).toHaveLength(0);
  });

  test("decodeAnvl handles status-only body", () => {
    const { status, fields } = decodeAnvl("success: ok");
    expect(status).toBe("success: ok");
    expect(Object.keys(fields)).toHaveLength(0);
  });

  test("decodeAnvl skips lines without colon-space delimiter", () => {
    const body = "success: test\n_status: reserved\nmalformed_line\n_target: http://x";
    const { fields } = decodeAnvl(body);
    expect(fields._status).toBe("reserved");
    expect(fields._target).toBe("http://x");
    expect(Object.keys(fields)).toHaveLength(2);
  });
});

describe("utility functions", () => {
  test("getDoiUrl formats DOI URL", () => {
    expect(getDoiUrl("doi:10.82901/NEMAR.ABC123")).toBe("https://doi.org/10.82901/NEMAR.ABC123");
    expect(getDoiUrl("10.82901/NEMAR.ABC123")).toBe("https://doi.org/10.82901/NEMAR.ABC123");
  });

  test("extractDoi strips doi: prefix", () => {
    expect(extractDoi("doi:10.82901/NEMAR.ABC123")).toBe("10.82901/NEMAR.ABC123");
    expect(extractDoi("10.82901/NEMAR.ABC123")).toBe("10.82901/NEMAR.ABC123");
  });

  test("isTestShoulder identifies test shoulders", () => {
    expect(isTestShoulder(TEST_SHOULDER)).toBe(true);
    expect(isTestShoulder("doi:10.5072/FK2")).toBe(true);
    expect(isTestShoulder(PRODUCTION_SHOULDER)).toBe(false);
  });
});

describe("EZID API (live test shoulder)", () => {
  test("checkStatus returns true", async () => {
    const up = await checkStatus();
    expect(up).toBe(true);
  });

  test("full lifecycle: mint -> get -> update -> delete", async () => {
    // 1. Mint a reserved DOI
    const minted = await mintIdentifier(TEST_AUTH, {
      shoulder: TEST_SHOULDER,
      status: "reserved",
      target: "https://nemar.org/test",
      dataciteFields: {
        creator: "Test, User",
        title: "EZID Integration Test",
        publisher: "NEMAR",
        publicationyear: "2026",
        resourcetype: "Dataset",
      },
    });

    expect(minted.identifier).toMatch(/^doi:10\.5072\/FK2/);
    expect(minted.status).toBe("reserved");
    expect(minted.target).toBe("https://nemar.org/test");

    const identifier = minted.identifier;

    // 2. Get the identifier
    const fetched = await getIdentifier(TEST_AUTH, identifier);
    expect(fetched.identifier).toBe(identifier);
    expect(fetched.status).toBe("reserved");

    // 3. Update metadata
    const updated = await updateIdentifier(TEST_AUTH, identifier, {
      target: "https://nemar.org/test-updated",
    });
    expect(updated.target).toBe("https://nemar.org/test-updated");

    // 4. Delete (reserved identifiers can be deleted)
    await deleteIdentifier(TEST_AUTH, identifier);

    // Verify deletion
    try {
      await getIdentifier(TEST_AUTH, identifier);
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toContain("no such identifier");
    }
  }, 30000); // 30s timeout for network calls

  test("mint with DataCite XML", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<resource xmlns="http://datacite.org/schema/kernel-4">
  <identifier identifierType="DOI">(:tba)</identifier>
  <creators><creator><creatorName>Test, User</creatorName></creator></creators>
  <titles><title>EZID XML Test</title></titles>
  <publisher>NEMAR</publisher>
  <publicationYear>2026</publicationYear>
  <resourceType resourceTypeGeneral="Dataset">EEG Dataset</resourceType>
</resource>`;

    const minted = await mintIdentifier(TEST_AUTH, {
      shoulder: TEST_SHOULDER,
      status: "reserved",
      target: "https://nemar.org/xml-test",
      dataciteXml: xml,
    });

    expect(minted.identifier).toMatch(/^doi:10\.5072\/FK2/);
    expect(minted.dataciteXml).toContain("EZID XML Test");

    // Cleanup
    await deleteIdentifier(TEST_AUTH, minted.identifier);
  }, 30000);
});
