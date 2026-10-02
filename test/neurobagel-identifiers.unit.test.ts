/**
 * Deterministic identifiers (epic #1586, phase 1).
 *
 * The uuid5 vectors below were computed with Python's `uuid.uuid5`, an
 * independent implementation of RFC 4122, so the Web Crypto version is checked
 * against something that is not itself:
 *
 *   python3 -c "import uuid; print(uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org'))"
 *   NS = uuid.UUID('df8e9091-cb02-4426-ba88-973cf2e050f9'); uuid.uuid5(NS, name)
 */

import { describe, expect, test } from "bun:test";
import { JsonFloat, canonicalJson } from "../shared/neurobagel/canonical-json";
import {
  NEMAR_NEUROBAGEL_NAMESPACE,
  datasetName,
  nbIdentifier,
  uuid5,
} from "../shared/neurobagel/identifiers";

const NAMESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

describe("uuid5", () => {
  test("matches the RFC 4122 reference vector (Python uuid.NAMESPACE_DNS, python.org)", async () => {
    expect(await uuid5(NAMESPACE_DNS, "python.org")).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });

  const vectors: [string, string][] = [
    ["https://nemar.org/dataset/nm000132", "28b6f4fc-416d-5127-887e-67d68f4c550a"],
    ["https://nemar.org/dataset/nm000132/sub-001", "3e3beccd-8ecc-5295-aba7-52b32f0adc4a"],
    [
      "https://nemar.org/dataset/nm000132/sub-001/phenotypic/ses-unnamed",
      "b74657a0-0d9d-5ebd-aa65-11a2500189d9",
    ],
    [
      "https://nemar.org/dataset/nm000132/sub-001/imaging/ses-unnamed",
      "2c77036d-c858-55c0-8e1c-65f6d4d7cd04",
    ],
    [
      "https://nemar.org/dataset/nm000132/sub-001/imaging/ses-unnamed/eeg",
      "779c24c6-81fa-5d20-8445-1b046596b764",
    ],
    ["", "105f6ae2-5eb5-5c98-8215-9c23c367dfb0"],
    ["naïve/名前", "0b0f920f-42c5-523c-beab-a7e807d0ef3a"],
  ];
  for (const [name, expected] of vectors) {
    test(`the NEMAR namespace gives ${expected} for ${JSON.stringify(name)}`, async () => {
      expect(await uuid5(NEMAR_NEUROBAGEL_NAMESPACE, name)).toBe(expected);
    });
  }

  test("an identifier is nb: plus the uuid, in the shape Neurobagel's models require", async () => {
    const id = await nbIdentifier(datasetName("nm000132"));
    expect(id).toBe("nb:28b6f4fc-416d-5127-887e-67d68f4c550a");
    expect(id).toMatch(/^nb:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("the namespace is the one committed (changing it churns every identifier)", () => {
    expect(NEMAR_NEUROBAGEL_NAMESPACE).toBe("df8e9091-cb02-4426-ba88-973cf2e050f9");
  });

  test("a malformed namespace is an error, not a silent different hash", async () => {
    await expect(uuid5("not-a-uuid", "x")).rejects.toThrow("not a UUID");
  });
});
