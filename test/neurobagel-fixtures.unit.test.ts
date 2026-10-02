/**
 * The captured fixtures are what they say they are (epic #1586, phase 1).
 *
 * A fixture without provenance is a fixture nobody can refresh or doubt.
 * Each directory under test/neurobagel/fixtures/ holds the documents exactly as
 * the data plane served them plus provenance.json (URL, fetch time, version,
 * sha256, size, ETag).
 * Refresh one with `bun run scripts/neurobagel/gather.ts --out test/neurobagel/fixtures <id>`
 * (add `--base https://data-test.nemar.org` for nm099998), then regenerate the
 * goldens and the oracle recordings (see shared/neurobagel/README.md).
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_ROOT, NEUROBAGEL_TEST_ROOT, fixtureIds } from "../scripts/neurobagel/fixtures-io";
import { bidsIndexSchema } from "../shared/contract/dataset.js";

interface DocumentProvenance {
  absent: boolean;
  bytes: number | null;
  etag: string | null;
  redirected: boolean;
  sha256: string | null;
  status: number;
  too_large_over_bytes: number | null;
  url: string;
}
interface Provenance {
  base: string;
  dataset_id: string;
  documents: Record<string, DocumentProvenance>;
  fetched_at: string;
  latest_version: string;
}

const provenanceOf = (id: string): Provenance =>
  JSON.parse(readFileSync(join(FIXTURE_ROOT, id, "provenance.json"), "utf8")) as Provenance;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const gitBlobSha = (bytes: Uint8Array): string =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

describe("fixture provenance", () => {
  test("every real edge class named in the issue is present", () => {
    for (const id of [
      "nm000132",
      "nm000103",
      "nm000104",
      "nm000109",
      "nm000270",
      "nm000147",
      "nm099998",
    ]) {
      expect(fixtureIds()).toContain(id);
    }
    // One iEEG, one MEG and one OpenNeuro mirror.
    expect(fixtureIds()).toEqual(expect.arrayContaining(["nm000182", "nm000229", "on000117"]));
  });

  for (const id of fixtureIds()) {
    describe(id, () => {
      const provenance = provenanceOf(id);

      test("names its own dataset, host, version and a UTC fetch time", () => {
        expect(provenance.dataset_id).toBe(id);
        expect(provenance.base).toBe(
          id === "nm099998" ? "https://data-test.nemar.org" : "https://data.nemar.org",
        );
        expect(provenance.latest_version).toMatch(/^v\d+\.\d+\.\d+$/);
        expect(provenance.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        const metadata = JSON.parse(
          readFileSync(join(FIXTURE_ROOT, id, "metadata.json"), "utf8"),
        ) as {
          provenance: { latest_snapshot: string };
        };
        expect(metadata.provenance.latest_snapshot).toBe(provenance.latest_version);
      });

      for (const [name, doc] of Object.entries(provenance.documents)) {
        test(`${name}: the file on disk is the file that was served (sha256, size, and the git blob where the server says so)`, () => {
          const path = join(FIXTURE_ROOT, id, name);
          expect(doc.url.startsWith(`${provenance.base}/${id}/`)).toBe(true);
          if (doc.absent) {
            expect(doc.status).toBe(404);
            expect(existsSync(path)).toBe(false);
            return;
          }
          expect(doc.status).toBe(200);
          const bytes = readFileSync(path);
          expect(bytes.length).toBe(doc.bytes as number);
          expect(sha256(bytes)).toBe(doc.sha256 as string);
          expect(doc.too_large_over_bytes).toBeNull();
          // The data plane's ETag for a git-tracked file IS its git blob sha (ADR 0066).
          const git = /^"git:([0-9a-f]{40})"$/.exec(doc.etag ?? "");
          if (git) expect(gitBlobSha(bytes)).toBe(git[1]);
        });
      }
    });
  }

  test("every fixture's bids_index is a valid wire document of the data plane's own contract", () => {
    for (const id of fixtureIds()) {
      const metadata = JSON.parse(
        readFileSync(join(FIXTURE_ROOT, id, "metadata.json"), "utf8"),
      ) as {
        extensions?: { nemar?: { bids_index?: unknown } };
      };
      const result = bidsIndexSchema.nullable().safeParse(metadata.extensions?.nemar?.bids_index);
      expect(result.success).toBe(true);
    }
  });

  test("a redirected (annexed) response is recorded as such and never keeps the presigned URL", () => {
    for (const id of fixtureIds()) {
      for (const doc of Object.values(provenanceOf(id).documents)) {
        expect(doc.url).not.toContain("?");
      }
    }
    const annexed = provenanceOf("nm000147").documents;
    expect(annexed["participants.tsv"].redirected).toBe(true);
  });

  test("nothing under test/neurobagel carries a credential, a signature or the live anonymous deposit", () => {
    for (const path of files(NEUROBAGEL_TEST_ROOT)) {
      const text = readFileSync(path, "utf8");
      expect(text).not.toMatch(/X-Amz|AKIA[0-9A-Z]{12}|Signature=/);
      // nm000284 is a live concealed deposit: it must never be copied into this repository.
      expect(path).not.toContain("nm000284");
      expect(text).not.toContain("nm000284");
    }
  });

  test("no fixture, golden or recording is larger than 1 MB", () => {
    for (const path of files(NEUROBAGEL_TEST_ROOT)) {
      expect(statSync(path).size).toBeLessThan(1024 * 1024);
    }
  });
});
