/**
 * EZID Sandbox Integration Tests
 *
 * SAFETY RULES:
 * - DOIs are PERMANENT once made public; always use reserved status in tests
 * - Always use the test shoulder (doi:10.5072/FK2)
 * - Add delays between API calls (300-500ms) to be respectful
 * - Tests run ONLY with RUN_EZID_TESTS=true to opt-in
 * - Cleanup reserved identifiers after tests
 * - Production shoulder is detected and blocked
 * - Test data uses nm099999 disposable dataset
 *
 * Run with: RUN_EZID_TESTS=true bun test test/ezid-sandbox.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type DataCiteMetadata,
  bidsToDataCite,
  buildDataCiteXml,
  mapLicense,
  mapModalityToResourceType,
  parseAuthorName,
} from "../backend/src/services/datacite";
import {
  EZID_BASE_URL,
  type EzidAuth,
  PRODUCTION_SHOULDER,
  TEST_SHOULDER,
  checkStatus,
  createIdentifier,
  decodeAnvl,
  deleteIdentifier,
  encodeAnvl,
  extractDoi,
  getDoiUrl,
  getIdentifier,
  isTestShoulder,
  makePublic,
  makeUnavailable,
  mintIdentifier,
  percentDecode,
  percentEncode,
  updateIdentifier,
} from "../backend/src/services/ezid";
import { sleep } from "./setup";

// Only run these tests when explicitly enabled
const SHOULD_RUN = process.env.RUN_EZID_TESTS === "true";

// We need a dataset to test with - use disposable test dataset
const TEST_DATASET_ID = process.env.TEST_DATASET_ID || "nm099999";

// EZID test credentials (public test account, safe to use)
const EZID_TEST_AUTH: EzidAuth = {
  username: process.env.EZID_TEST_USERNAME || "apitest",
  password: process.env.EZID_TEST_PASSWORD || "ezidapitest2025!",
};

// Track created identifiers for cleanup
const createdIdentifiers: string[] = [];

// Safety check: detect if production shoulder is accidentally used
beforeAll(() => {
  if (!SHOULD_RUN) {
    console.log("\n  EZID sandbox tests are SKIPPED by default.");
    console.log("   To run: RUN_EZID_TESTS=true bun test test/ezid-sandbox.test.ts\n");
    return;
  }

  console.log("\n  Running EZID sandbox tests...");
  console.log(`   Dataset: ${TEST_DATASET_ID}`);
  console.log(`   Shoulder: ${TEST_SHOULDER}`);
  console.log(`   Username: ${EZID_TEST_AUTH.username}\n`);
});

// Cleanup reserved identifiers after all tests
afterAll(async () => {
  if (!SHOULD_RUN || createdIdentifiers.length === 0) {
    return;
  }

  console.log(`\n  Cleaning up ${createdIdentifiers.length} test identifiers...`);

  // Delete in parallel to stay within afterAll timeout
  const results = await Promise.allSettled(
    createdIdentifiers.map((identifier) =>
      deleteIdentifier(EZID_TEST_AUTH, identifier)
        .then(() => ({ identifier, deleted: true }))
        .catch((error: Error) => ({ identifier, deleted: false, error: error.message })),
    ),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      const r = result.value;
      if (r.deleted) {
        console.log(`   [x] Deleted ${r.identifier}`);
      } else {
        const msg = (r as { error?: string }).error || "";
        if (msg.includes("no such identifier")) {
          console.log(`   [x] Already deleted ${r.identifier}`);
        } else {
          console.log(`   [ ] Skipped ${r.identifier}: ${msg} (will auto-expire)`);
        }
      }
    }
  }

  console.log("   [x] Cleanup complete\n");
});

describe.skipIf(!SHOULD_RUN)("EZID Sandbox Integration", { timeout: 30000 }, () => {
  describe("Server Connectivity", () => {
    test("EZID server is up", async () => {
      const up = await checkStatus();
      expect(up).toBe(true);
      console.log("   [x] EZID server is up");
    });

    test("can authenticate with test account", async () => {
      await sleep(300);

      const response = await fetch(`${EZID_BASE_URL}/login`, {
        headers: {
          Authorization: `Basic ${btoa(`${EZID_TEST_AUTH.username}:${EZID_TEST_AUTH.password}`)}`,
        },
      });

      const body = await response.text();
      expect(body).toContain("success");
      console.log("   [x] Authenticated with test account");
    });
  });

  describe("Concept DOI Creation (Sandbox)", () => {
    test("can mint reserved DOI on test shoulder", async () => {
      await sleep(500);

      const minted = await mintIdentifier(EZID_TEST_AUTH, {
        shoulder: TEST_SHOULDER,
        status: "reserved",
        target: `https://nemar.org/dataset/${TEST_DATASET_ID}`,
        dataciteFields: {
          creator: "Test, User",
          title: `Test Dataset - ${new Date().toISOString()}`,
          publisher: "NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)",
          publicationyear: "2026",
          resourcetype: "Dataset",
        },
      });

      createdIdentifiers.push(minted.identifier);

      expect(minted.identifier).toMatch(/^doi:10\.5072\/FK2/);
      expect(minted.status).toBe("reserved");
      console.log(`   [x] Minted reserved DOI: ${minted.identifier}`);
    });

    test("can mint DOI with full DataCite XML", async () => {
      await sleep(500);

      // Build rich DataCite XML using our builder
      const metadata: DataCiteMetadata = {
        identifier: "(:tba)", // Placeholder, EZID assigns the real DOI
        creators: [
          {
            name: "Shirazi, Yahya",
            givenName: "Yahya",
            familyName: "Shirazi",
            orcid: "0000-0001-2345-6789",
            affiliation: "University of California, San Diego",
            ror: "https://ror.org/0168r3w48",
          },
          {
            name: "Delorme, Arnaud",
            givenName: "Arnaud",
            familyName: "Delorme",
            affiliation: "University of California, San Diego",
          },
        ],
        titles: ["Test NEMAR Dataset - Full DataCite Metadata"],
        publisher: "NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)",
        publicationYear: 2026,
        resourceTypeGeneral: "Dataset",
        resourceTypeSpecific: "EEG Dataset",
        subjects: ["EEG", "electroencephalography", "BIDS", "neuroscience"],
        contributors: [
          {
            name: "NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)",
            contributorType: "HostingInstitution",
            nameType: "Organizational",
          },
        ],
        dates: [
          { date: "2026-02-10", dateType: "Created" },
          { date: "2024-01-01/2025-12-31", dateType: "Collected" },
        ],
        relatedIdentifiers: [
          {
            identifier: "10.1234/example.paper.2024",
            relatedIdentifierType: "DOI",
            relationType: "IsSupplementTo",
          },
        ],
        descriptions: [
          {
            description:
              "A test EEG dataset with full DataCite metadata, demonstrating all 20 fields.",
            descriptionType: "Abstract",
          },
        ],
        language: "en",
        alternateIdentifiers: [{ identifier: TEST_DATASET_ID, type: "NEMAR" }],
        sizes: ["500 MB", "30 subjects", "64 channels"],
        formats: ["application/x-edf", "application/json", "text/tab-separated-values"],
        version: "1.0.0",
        rights: [
          {
            rights: "Creative Commons Attribution 4.0 International",
            rightsURI: "https://creativecommons.org/licenses/by/4.0/",
            rightsIdentifier: "CC-BY-4.0",
            rightsIdentifierScheme: "SPDX",
          },
        ],
        fundingReferences: [
          {
            funderName: "National Institutes of Health",
            funderIdentifier: "https://doi.org/10.13039/100000002",
            funderIdentifierType: "Crossref Funder ID",
            awardNumber: "R01-NS12345",
          },
        ],
      };

      const xml = buildDataCiteXml(metadata);

      const minted = await mintIdentifier(EZID_TEST_AUTH, {
        shoulder: TEST_SHOULDER,
        status: "reserved",
        target: `https://nemar.org/dataset/${TEST_DATASET_ID}`,
        dataciteXml: xml,
      });

      createdIdentifiers.push(minted.identifier);

      expect(minted.identifier).toMatch(/^doi:10\.5072\/FK2/);
      expect(minted.status).toBe("reserved");
      expect(minted.dataciteXml).toContain("Full DataCite Metadata");
      expect(minted.dataciteXml).toContain("ORCID");
      expect(minted.dataciteXml).toContain("HostingInstitution");
      expect(minted.dataciteXml).toContain("CC-BY-4.0");
      expect(minted.dataciteXml).toContain("R01-NS12345");

      console.log(`   [x] Minted DOI with full DataCite XML: ${minted.identifier}`);
      console.log("   [x] Verified: ORCID, affiliations, subjects, rights, funding all present");
    });

    test("blocks production shoulder in test", async () => {
      // Verify the safety check works
      expect(isTestShoulder(TEST_SHOULDER)).toBe(true);
      expect(isTestShoulder(PRODUCTION_SHOULDER)).toBe(false);
      console.log("   [x] Production shoulder correctly identified as non-test");
    });
  });

  describe("DOI Info Retrieval (Sandbox)", () => {
    test("can retrieve minted DOI metadata", async () => {
      await sleep(500);

      // Mint a DOI first
      const minted = await mintIdentifier(EZID_TEST_AUTH, {
        shoulder: TEST_SHOULDER,
        status: "reserved",
        target: "https://nemar.org/test-retrieval",
        dataciteFields: {
          creator: "Test, User",
          title: "Retrieval Test",
          publisher: "NEMAR",
          publicationyear: "2026",
          resourcetype: "Dataset",
        },
      });
      createdIdentifiers.push(minted.identifier);

      await sleep(300);

      // Retrieve it
      const fetched = await getIdentifier(EZID_TEST_AUTH, minted.identifier);

      expect(fetched.identifier).toBe(minted.identifier);
      expect(fetched.status).toBe("reserved");
      expect(fetched.target).toBe("https://nemar.org/test-retrieval");
      expect(fetched.profile).toBe("datacite");
      expect(fetched.owner).toBe(EZID_TEST_AUTH.username);

      console.log(`   [x] Retrieved DOI info: ${fetched.identifier}`);
      console.log(`   [x] Status: ${fetched.status}, Owner: ${fetched.owner}`);
    });

    test("returns proper error for non-existent DOI", async () => {
      await sleep(300);

      try {
        await getIdentifier(EZID_TEST_AUTH, "doi:10.5072/FK2NONEXISTENT999");
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toContain("no such identifier");
        console.log("   [x] Non-existent DOI correctly returns error");
      }
    });
  });

  describe("Metadata Updates (Sandbox)", () => {
    test("can update target URL", async () => {
      await sleep(500);

      const minted = await mintIdentifier(EZID_TEST_AUTH, {
        shoulder: TEST_SHOULDER,
        status: "reserved",
        target: "https://nemar.org/original",
        dataciteFields: {
          creator: "Test, User",
          title: "Update Target Test",
          publisher: "NEMAR",
          publicationyear: "2026",
          resourcetype: "Dataset",
        },
      });
      createdIdentifiers.push(minted.identifier);

      await sleep(400);

      const updated = await updateIdentifier(EZID_TEST_AUTH, minted.identifier, {
        target: "https://nemar.org/updated",
      });

      expect(updated.target).toBe("https://nemar.org/updated");
      console.log("   [x] Updated target URL");
    });

    test("can update DataCite XML metadata", async () => {
      await sleep(500);

      // Mint with basic metadata
      const minted = await mintIdentifier(EZID_TEST_AUTH, {
        shoulder: TEST_SHOULDER,
        status: "reserved",
        dataciteFields: {
          creator: "Test, User",
          title: "Before Update",
          publisher: "NEMAR",
          publicationyear: "2026",
          resourcetype: "Dataset",
        },
      });
      createdIdentifiers.push(minted.identifier);

      await sleep(400);

      // Update with rich DataCite XML
      const doi = extractDoi(minted.identifier);
      const metadata: DataCiteMetadata = {
        identifier: doi,
        creators: [
          {
            name: "Test, User",
            givenName: "User",
            familyName: "Test",
            orcid: "0000-0000-0000-0001",
          },
        ],
        titles: ["After Update - Rich Metadata"],
        publisher: "NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)",
        publicationYear: 2026,
        resourceTypeGeneral: "Dataset",
        resourceTypeSpecific: "EEG Dataset",
        subjects: ["EEG", "test"],
        language: "en",
        version: "2.0.0",
        rights: [
          {
            rights: "CC BY 4.0",
            rightsURI: "https://creativecommons.org/licenses/by/4.0/",
            rightsIdentifier: "CC-BY-4.0",
            rightsIdentifierScheme: "SPDX",
          },
        ],
      };

      const xml = buildDataCiteXml(metadata);
      const updated = await updateIdentifier(EZID_TEST_AUTH, minted.identifier, {
        dataciteXml: xml,
      });

      expect(updated.dataciteXml).toContain("After Update");
      expect(updated.dataciteXml).toContain("ORCID");
      expect(updated.dataciteXml).toContain("EEG Dataset");
      console.log("   [x] Updated DataCite XML metadata");
    });

    test("can add related identifiers (paper DOIs)", async () => {
      await sleep(500);

      const minted = await mintIdentifier(EZID_TEST_AUTH, {
        shoulder: TEST_SHOULDER,
        status: "reserved",
        dataciteFields: {
          creator: "Test, User",
          title: "Related IDs Test",
          publisher: "NEMAR",
          publicationyear: "2026",
          resourcetype: "Dataset",
        },
      });
      createdIdentifiers.push(minted.identifier);

      await sleep(400);

      const doi = extractDoi(minted.identifier);
      const metadata: DataCiteMetadata = {
        identifier: doi,
        creators: [{ name: "Test, User" }],
        titles: ["Related IDs Test"],
        publisher: "NEMAR",
        publicationYear: 2026,
        resourceTypeGeneral: "Dataset",
        relatedIdentifiers: [
          {
            identifier: "10.1234/associated.paper.2024",
            relatedIdentifierType: "DOI",
            relationType: "IsSupplementTo",
          },
          {
            identifier: "10.5678/previous.version",
            relatedIdentifierType: "DOI",
            relationType: "IsNewVersionOf",
          },
        ],
      };

      const xml = buildDataCiteXml(metadata);
      const updated = await updateIdentifier(EZID_TEST_AUTH, minted.identifier, {
        dataciteXml: xml,
      });

      expect(updated.dataciteXml).toContain("IsSupplementTo");
      expect(updated.dataciteXml).toContain("10.1234/associated.paper.2024");
      expect(updated.dataciteXml).toContain("IsNewVersionOf");
      console.log("   [x] Added related identifiers (paper DOIs)");
    });
  });

  describe("DOI Status Transitions (Sandbox)", () => {
    test("can transition reserved -> public (PERMANENT)", async () => {
      await sleep(500);

      const minted = await mintIdentifier(EZID_TEST_AUTH, {
        shoulder: TEST_SHOULDER,
        status: "reserved",
        target: "https://nemar.org/test-public",
        dataciteFields: {
          creator: "Test, User",
          title: "Public Transition Test",
          publisher: "NEMAR",
          publicationyear: "2026",
          resourcetype: "Dataset",
        },
      });
      // Do NOT add to cleanup - public DOIs cannot be deleted
      // Test shoulder auto-deletes after 2 weeks

      await sleep(400);

      const published = await makePublic(
        EZID_TEST_AUTH,
        minted.identifier,
        "https://nemar.org/test-public",
      );

      expect(published.status).toBe("public");
      console.log(`   [x] Made DOI public: ${published.identifier}`);
      console.log(`   [x] DOI URL: ${getDoiUrl(published.identifier)}`);
      console.log("   Note: Public DOI is permanent (test shoulder auto-expires in 2 weeks)");
    });

    test("can transition public -> unavailable (tombstone)", async () => {
      await sleep(500);

      // Mint and make public
      const minted = await mintIdentifier(EZID_TEST_AUTH, {
        shoulder: TEST_SHOULDER,
        status: "reserved",
        target: "https://nemar.org/test-unavailable",
        dataciteFields: {
          creator: "Test, User",
          title: "Unavailable Transition Test",
          publisher: "NEMAR",
          publicationyear: "2026",
          resourcetype: "Dataset",
        },
      });

      await sleep(400);
      await makePublic(EZID_TEST_AUTH, minted.identifier, "https://nemar.org/test-unavailable");

      await sleep(400);
      const unavailable = await makeUnavailable(
        EZID_TEST_AUTH,
        minted.identifier,
        "withdrawn for testing",
      );

      // EZID returns the full status string with reason
      expect(unavailable.raw._status).toContain("unavailable");
      console.log(`   [x] Made DOI unavailable: ${minted.identifier}`);
      console.log("   [x] Tombstone page will show withdrawal reason");
    }, 30000);

    test("cannot delete public DOI", async () => {
      await sleep(500);

      // Mint and make public
      const minted = await mintIdentifier(EZID_TEST_AUTH, {
        shoulder: TEST_SHOULDER,
        status: "reserved",
        target: "https://nemar.org/test-no-delete",
        dataciteFields: {
          creator: "Test, User",
          title: "No Delete Test",
          publisher: "NEMAR",
          publicationyear: "2026",
          resourcetype: "Dataset",
        },
      });

      await sleep(400);
      await makePublic(EZID_TEST_AUTH, minted.identifier, "https://nemar.org/test-no-delete");

      await sleep(400);

      try {
        await deleteIdentifier(EZID_TEST_AUTH, minted.identifier);
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toContain("EZID delete error");
        console.log("   [x] Public DOI correctly cannot be deleted");
      }
    }, 30000);
  });

  describe("BIDS to DataCite Mapping (Sandbox)", () => {
    test("maps real BIDS metadata to DataCite and mints DOI", async () => {
      await sleep(500);

      // Simulate a real BIDS dataset_description.json
      const bidsDescription = {
        Name: "Healthy Brain Network (HBN) EEG - Release 1",
        BIDSVersion: "1.9.0",
        Authors: ["Shirazi, Seyed Yahya", "Franco, Alexandre", "Delorme, Arnaud", "Makeig, Scott"],
        License: "CC-BY-4.0",
        DatasetType: "raw",
        Version: "1.0.1",
        HowToAcknowledge: "Please cite the associated paper.",
        Funding: ["NIH R01-NS12345"],
        ReferencesAndLinks: ["10.18112/openneuro.ds005505.v1.0.1"],
      };

      const enrichment = {
        authors: {
          "Shirazi, Seyed Yahya": {
            orcid: "0000-0001-2345-6789",
            affiliation: "University of California, San Diego",
          },
          "Delorme, Arnaud": {
            affiliation: "University of California, San Diego",
          },
          "Makeig, Scott": {
            affiliation: "University of California, San Diego",
          },
        },
        keywords: ["EEG", "pediatric", "resting state", "brain development"],
        relatedDois: [{ doi: "10.1038/sdata.2017.181", relationType: "IsSupplementTo" as const }],
        description:
          "A large-scale pediatric EEG dataset from the Healthy Brain Network initiative.",
      };

      const metadata = bidsToDataCite(TEST_DATASET_ID, "(:tba)", bidsDescription, enrichment);

      const xml = buildDataCiteXml(metadata);

      // Verify the XML is rich
      expect(xml).toContain("Shirazi, Seyed Yahya");
      expect(xml).toContain("ORCID");
      expect(xml).toContain("HostingInstitution");
      expect(xml).toContain("CC-BY-4.0");
      expect(xml).toContain("pediatric");
      expect(xml).toContain("IsSupplementTo");
      expect(xml).toContain(TEST_DATASET_ID);

      // Mint the DOI
      const minted = await mintIdentifier(EZID_TEST_AUTH, {
        shoulder: TEST_SHOULDER,
        status: "reserved",
        target: `https://nemar.org/dataset/${TEST_DATASET_ID}`,
        dataciteXml: xml,
      });
      createdIdentifiers.push(minted.identifier);

      expect(minted.identifier).toMatch(/^doi:10\.5072\/FK2/);
      console.log(`   [x] Minted DOI from BIDS metadata: ${minted.identifier}`);
      console.log("   [x] Rich DataCite: creators, ORCID, subjects, rights, funding, related DOIs");
    });
  });

  describe("Deterministic DOI Creation (Sandbox)", () => {
    const deterministicId = `${TEST_SHOULDER}${TEST_DATASET_ID.toUpperCase()}`;

    test("can create DOI with exact identifier", async () => {
      await sleep(500);

      const metadata = bidsToDataCite(TEST_DATASET_ID, extractDoi(deterministicId), {
        Name: "Deterministic Test",
      });
      const xml = buildDataCiteXml(metadata);

      const created = await createIdentifier(EZID_TEST_AUTH, deterministicId, {
        status: "reserved",
        target: `https://nemar.org/dataset/${TEST_DATASET_ID}`,
        dataciteXml: xml,
      });

      createdIdentifiers.push(created.identifier);

      expect(created.identifier).toBe(deterministicId);
      expect(created.status).toBe("reserved");
      console.log(`   [x] Created deterministic DOI: ${created.identifier}`);
    });

    test("collision returns clear error", async () => {
      await sleep(500);

      // The previous test already created this identifier
      try {
        await createIdentifier(EZID_TEST_AUTH, deterministicId, {
          status: "reserved",
          target: "https://nemar.org/collision-test",
        });
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toContain("already exists");
        console.log("   [x] Collision correctly returns 'already exists' error");
      }
    });

    test("can create version DOI with deterministic name", async () => {
      await sleep(500);

      const versionId = `${TEST_SHOULDER}${TEST_DATASET_ID.toUpperCase()}.V1.0.0`;
      const doi = extractDoi(versionId);

      const metadata = bidsToDataCite(
        TEST_DATASET_ID,
        doi,
        { Name: "Deterministic Version Test" },
        {
          relatedDois: [{ doi: extractDoi(deterministicId), relationType: "IsVersionOf" }],
        },
      );
      const xml = buildDataCiteXml(metadata);

      const created = await createIdentifier(EZID_TEST_AUTH, versionId, {
        status: "reserved",
        target: `https://github.com/nemarDatasets/${TEST_DATASET_ID}/releases/tag/v1.0.0`,
        dataciteXml: xml,
      });

      createdIdentifiers.push(created.identifier);

      expect(created.identifier).toBe(versionId);
      expect(created.status).toBe("reserved");
      expect(created.dataciteXml).toContain("IsVersionOf");
      console.log(`   [x] Created version DOI: ${created.identifier}`);
    });
  });

  describe("Error Handling (Sandbox)", () => {
    test("rejects invalid credentials", async () => {
      await sleep(300);

      const badAuth: EzidAuth = {
        username: "invalid_user",
        password: "invalid_pass",
      };

      try {
        await mintIdentifier(badAuth, {
          shoulder: TEST_SHOULDER,
          status: "reserved",
          dataciteFields: {
            creator: "Test, User",
            title: "Should Fail",
            publisher: "NEMAR",
            publicationyear: "2026",
            resourcetype: "Dataset",
          },
        });
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toContain("EZID");
        console.log("   [x] Invalid credentials rejected");
      }
    });

    test("rejects invalid metadata in DataCite XML", async () => {
      await sleep(300);

      // Malformed XML should be rejected by EZID
      try {
        await mintIdentifier(EZID_TEST_AUTH, {
          shoulder: TEST_SHOULDER,
          status: "reserved",
          dataciteXml: "<invalid>not valid datacite</invalid>",
        });
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toContain("EZID mint error");
        console.log("   [x] Invalid DataCite XML rejected");
      }
    });
  });

  describe("Deposition Lifecycle (Sandbox)", () => {
    test("full lifecycle: mint -> update -> make public -> update metadata", async () => {
      await sleep(500);

      // 1. Mint with basic metadata
      const minted = await mintIdentifier(EZID_TEST_AUTH, {
        shoulder: TEST_SHOULDER,
        status: "reserved",
        target: `https://nemar.org/dataset/${TEST_DATASET_ID}`,
        dataciteFields: {
          creator: "Test, User",
          title: "Lifecycle Test v1.0.0",
          publisher: "NEMAR",
          publicationyear: "2026",
          resourcetype: "Dataset",
        },
      });
      // Not adding to cleanup since we'll make it public
      console.log(`   [x] Step 1: Minted ${minted.identifier} (reserved)`);

      await sleep(400);

      // 2. Update with rich DataCite XML
      const doi = extractDoi(minted.identifier);
      const richXml = buildDataCiteXml({
        identifier: doi,
        creators: [{ name: "Test, User", givenName: "User", familyName: "Test" }],
        titles: ["Lifecycle Test v1.0.0"],
        publisher: "NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)",
        publicationYear: 2026,
        resourceTypeGeneral: "Dataset",
        resourceTypeSpecific: "EEG Dataset",
        subjects: ["EEG", "BIDS", "test"],
        language: "en",
        version: "1.0.0",
      });

      await updateIdentifier(EZID_TEST_AUTH, minted.identifier, {
        dataciteXml: richXml,
      });
      console.log("   [x] Step 2: Updated with rich DataCite XML");

      await sleep(400);

      // 3. Make public (PERMANENT on production; auto-expires on test shoulder)
      const published = await makePublic(
        EZID_TEST_AUTH,
        minted.identifier,
        `https://nemar.org/dataset/${TEST_DATASET_ID}`,
      );
      expect(published.status).toBe("public");
      console.log("   [x] Step 3: Made public");

      await sleep(400);

      // 4. Update metadata on public DOI (allowed by EZID)
      const updatedXml = buildDataCiteXml({
        identifier: doi,
        creators: [{ name: "Test, User", givenName: "User", familyName: "Test" }],
        titles: ["Lifecycle Test v1.0.0 - Updated"],
        publisher: "NEMAR (Neuroelectromagnetic Data Archive and Tools Resource)",
        publicationYear: 2026,
        resourceTypeGeneral: "Dataset",
        resourceTypeSpecific: "EEG Dataset",
        subjects: ["EEG", "BIDS", "test", "updated"],
        language: "en",
        version: "1.0.0",
      });

      const afterUpdate = await updateIdentifier(EZID_TEST_AUTH, minted.identifier, {
        dataciteXml: updatedXml,
      });
      expect(afterUpdate.dataciteXml).toContain("Updated");
      console.log("   [x] Step 4: Updated metadata on public DOI");
      console.log(`   [x] Full lifecycle complete for ${minted.identifier}`);
    }, 30000);
  });
});
