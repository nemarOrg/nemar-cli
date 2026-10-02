/**
 * The HTTP gatherer against the live data plane (epic #1586, phase 1).
 *
 * Read-only public GETs of data.nemar.org and data-test.nemar.org, so this is an
 * *.integration.test.ts (CI's required unit tier skips that suffix) and it is
 * opt-in: NEUROBAGEL_LIVE=1 bun test test/neurobagel-gather.integration.test.ts
 *
 * What it proves that the fixtures cannot: the gatherer still reads what the
 * server serves today, treats a 404 as an absent file and anything else as an
 * error, follows the redirect an annexed file answers with, and hands the
 * transform documents the transform accepts (or, for the anonymous control,
 * refuses).
 * It asserts structure, not bytes: a live dataset may publish a new version.
 * Without NEUROBAGEL_LIVE=1 every test below is reported as skipped, not passed.
 */

import { describe, expect, test } from "bun:test";
import {
  ANONYMOUS_CONTROL,
  GatherError,
  gatherDataset,
  listDatasetIds,
} from "../scripts/neurobagel/gather";
import {
  NeurobagelRefusal,
  artifactFileNames,
  buildNeurobagelArtifacts,
} from "../shared/neurobagel";

const live = process.env.NEUROBAGEL_LIVE === "1";
if (!live) {
  console.warn(
    "neurobagel-gather.integration: skipped (set NEUROBAGEL_LIVE=1 to read the live data plane)",
  );
}
const text = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : new TextDecoder().decode(bytes);

describe.skipIf(!live)("gatherer against data.nemar.org", () => {
  test("a clean dataset: all three documents, transformed end to end", async () => {
    const g = await gatherDataset("nm000132");
    expect(g.metadata.status).toBe(200);
    expect(g.participantsTsv.status).toBe(200);
    expect(g.participantsJson.status).toBe(200);
    expect(g.latestVersion).toMatch(/^v\d+\.\d+\.\d+$/);
    const artifacts = await buildNeurobagelArtifacts({
      expectedDatasetId: "nm000132",
      metadata: JSON.parse(text(g.metadata.bytes) as string),
      participantsTsv: text(g.participantsTsv.bytes),
      participantsJson: text(g.participantsJson.bytes),
    });
    expect(artifacts.report.graph.subjects).toBeGreaterThan(0);
    expect(Object.keys(artifacts.files)).toContain(artifactFileNames("nm000132").jsonld);
  });

  test("a dataset with no participants.tsv answers 404, which is an absent file and not an error", async () => {
    const g = await gatherDataset("nm000270");
    expect(g.participantsTsv.status).toBe(404);
    expect(g.participantsTsv.bytes).toBeNull();
    expect(g.metadata.status).toBe(200);
  });

  test("an annexed file is followed through its redirect, and the presigned URL is not kept", async () => {
    const g = await gatherDataset("nm000147");
    expect(g.participantsTsv.status).toBe(200);
    expect(g.participantsTsv.redirected).toBe(true);
    expect(g.participantsTsv.url).not.toContain("?");
    expect(g.participantsTsv.bytes?.length).toBeGreaterThan(0);
  });

  test("a dataset id that does not exist is an error, not an empty result", async () => {
    await expect(gatherDataset("nm999999")).rejects.toBeInstanceOf(GatherError);
  });

  test("a malformed id is rejected before any request", async () => {
    await expect(gatherDataset("../etc/passwd")).rejects.toThrow("not a dataset id");
  });

  test("the public catalog lists datasets, including the OpenNeuro mirrors", async () => {
    const ids = await listDatasetIds();
    expect(ids.length).toBeGreaterThan(500);
    expect(ids.some((id) => id.startsWith("nm"))).toBe(true);
    expect(ids.some((id) => id.startsWith("on"))).toBe(true);
  });
});

describe.skipIf(!live)("gatherer against the dev data host", () => {
  test("the anonymous negative control is gathered as metadata only, and the transform refuses it", async () => {
    const g = await gatherDataset(ANONYMOUS_CONTROL.datasetId, ANONYMOUS_CONTROL.base, {
      metadataOnly: true,
    });
    expect(g.participantsTsv.skipped).toBe(true);
    expect(g.participantsJson.skipped).toBe(true);
    const metadata = JSON.parse(text(g.metadata.bytes) as string);
    expect(metadata.anonymous).toBe(true);
    const error = await buildNeurobagelArtifacts({
      expectedDatasetId: ANONYMOUS_CONTROL.datasetId,
      metadata,
      participantsTsv: null,
      participantsJson: null,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(NeurobagelRefusal);
  });
});
