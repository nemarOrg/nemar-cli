/**
 * What the gatherer will and will not write to disk (epic #1586, phase 1).
 *
 * A fixture is committed to a public repository, so nothing whose metadata is not
 * `anonymous: false` may be written, with one exception: the declared anonymous
 * control on the dev data host, as metadata only.
 * These tests build a `GatheredDataset` from the bytes of real captured fixtures and
 * drive `writeFixture`, the function every write goes through; the network is not
 * involved.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_ROOT } from "../scripts/neurobagel/fixtures-io";
import {
  ANONYMOUS_CONTROL,
  GatherError,
  type GatheredDataset,
  type GatheredDocument,
  refusalToWrite,
  writeFixture,
} from "../scripts/neurobagel/gather";

const bytesOf = (id: string, name: string): Uint8Array<ArrayBuffer> | null => {
  const path = join(FIXTURE_ROOT, id, name);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
};

function document(
  id: string,
  base: string,
  name: GatheredDocument["name"],
  bytes: Uint8Array<ArrayBuffer> | null,
  skipped = false,
): GatheredDocument {
  return {
    name,
    url: `${base}/${id}/${name}`,
    status: skipped ? 0 : bytes === null ? 404 : 200,
    bytes,
    sha256: null,
    etag: null,
    redirected: false,
    tooLargeOver: null,
    skipped,
  };
}

/** A gathered dataset made of fixture bytes; `metadata` may be replaced to change one field. */
function gathered(
  id: string,
  base: string,
  options: { metadata?: unknown; withParticipants?: boolean; participantsFrom?: string } = {},
): GatheredDataset {
  const metadataBytes =
    options.metadata === undefined
      ? bytesOf(id, "metadata.json")
      : new TextEncoder().encode(JSON.stringify(options.metadata));
  const from = options.participantsFrom ?? id;
  const withParticipants = options.withParticipants ?? true;
  return {
    datasetId: id,
    base,
    fetchedAt: "2026-10-02T00:00:00.000Z",
    latestVersion: "v1.0.0",
    metadata: document(id, base, "metadata.json", metadataBytes as Uint8Array<ArrayBuffer>),
    participantsTsv: document(
      id,
      base,
      "participants.tsv",
      withParticipants ? bytesOf(from, "participants.tsv") : null,
      !withParticipants,
    ),
    participantsJson: document(
      id,
      base,
      "participants.json",
      withParticipants ? bytesOf(from, "participants.json") : null,
      !withParticipants,
    ),
  };
}

const PROD = "https://data.nemar.org";
const withTempDir = (run: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "nb-gather-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const metadataOf = (id: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURE_ROOT, id, "metadata.json"), "utf8"));

describe("writeFixture refuses what must never reach a public repository", () => {
  test("a named dataset is written, with every document", () => {
    withTempDir((dir) => {
      const where = writeFixture(gathered("nm000132", PROD), dir);
      expect(readdirSync(where).sort()).toEqual([
        "metadata.json",
        "participants.json",
        "participants.tsv",
        "provenance.json",
      ]);
    });
  });

  for (const [label, value] of [
    ["true", true],
    ["null", null],
    ['"false"', "false"],
    ["missing", undefined],
  ] as const) {
    test(`a dataset whose metadata has anonymous = ${label} is refused, and nothing is written`, () => {
      const { anonymous: _a, ...rest } = metadataOf("nm000132");
      const metadata = value === undefined ? rest : { ...rest, anonymous: value };
      withTempDir((dir) => {
        expect(() => writeFixture(gathered("nm000132", PROD, { metadata }), dir)).toThrow(
          GatherError,
        );
        expect(readdirSync(dir)).toEqual([]);
      });
    });
  }

  test("the anonymous control on the WRONG host (the production data plane) is refused", () => {
    withTempDir((dir) => {
      const g = gathered(ANONYMOUS_CONTROL.datasetId, PROD, { withParticipants: false });
      expect(() => writeFixture(g, dir)).toThrow(GatherError);
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  test("another dataset claiming the control's host is refused", () => {
    withTempDir((dir) => {
      const metadata = { ...metadataOf("nm000132"), anonymous: true };
      const g = gathered("nm000132", ANONYMOUS_CONTROL.base, { metadata });
      expect(refusalToWrite(g)).not.toBeNull();
      expect(() => writeFixture(g, dir)).toThrow(GatherError);
    });
  });

  test("another dataset id on the control's host, even as metadata only, is refused by the id", () => {
    // Metadata only, so the participants-file rule cannot be what refuses it: only the
    // condition that the dataset IS the declared control can.
    const metadata = { ...metadataOf("nm000132"), anonymous: true };
    const g = gathered("nm000132", ANONYMOUS_CONTROL.base, { metadata, withParticipants: false });
    expect(g.participantsTsv.bytes).toBeNull();
    expect(g.participantsJson.bytes).toBeNull();
    const refusal = refusalToWrite(g);
    expect(refusal).toContain("so no document of it is written");
    withTempDir((dir) => {
      expect(() => writeFixture(g, dir)).toThrow(GatherError);
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  test("the declared control is written as metadata only", () => {
    withTempDir((dir) => {
      const g = gathered(ANONYMOUS_CONTROL.datasetId, ANONYMOUS_CONTROL.base, {
        withParticipants: false,
      });
      const where = writeFixture(g, dir);
      expect(readdirSync(where).sort()).toEqual(["metadata.json", "provenance.json"]);
    });
  });

  test("the declared control with a participants file is refused: a depositor file of an anonymous deposit is never written", () => {
    withTempDir((dir) => {
      const g = gathered(ANONYMOUS_CONTROL.datasetId, ANONYMOUS_CONTROL.base, {
        participantsFrom: "nm000132",
      });
      expect(g.participantsTsv.bytes).not.toBeNull();
      expect(() => writeFixture(g, dir)).toThrow(GatherError);
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  test("metadata that is not JSON, or is missing, is refused", () => {
    const garbage = gathered("nm000132", PROD);
    garbage.metadata = {
      ...garbage.metadata,
      bytes: new TextEncoder().encode("{ not json") as Uint8Array<ArrayBuffer>,
    };
    expect(refusalToWrite(garbage)).not.toBeNull();
    const missing = gathered("nm000132", PROD);
    missing.metadata = { ...missing.metadata, bytes: null, status: 404 };
    expect(refusalToWrite(missing)).not.toBeNull();
  });
});
