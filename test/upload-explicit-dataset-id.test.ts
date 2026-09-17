/**
 * The CLI can NAME a dataset id on create (`nemar dataset upload --dataset-id`),
 * ADR 0068 / #1434.
 *
 * `POST /datasets` has accepted `dataset_id` since #1432, but the CLI's own
 * client did not send it, so the standing fixtures that live in the reserved
 * band could only be created by an out-of-band API call. That is the seam this
 * closes, and it is the whole reason the test asserts the WIRE BODY rather than
 * the option table: an option that parses but never reaches the request is
 * exactly the bug that existed before.
 *
 * Real HTTP against a local Bun.serve stand-in, real client code, isolated
 * NEMAR_CONFIG_DIR. No mocks.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUploadCommand } from "../src/commands/dataset";
import { createOrResumeDataset } from "../src/lib/upload/transfer";

let server: ReturnType<typeof Bun.serve> | undefined;
let bodies: Record<string, unknown>[] = [];
let configDir: string;
let datasetDir: string;
let previousApiUrl: string | undefined;
let previousConfigDir: string | undefined;

beforeAll(() => {
  previousApiUrl = process.env.TEST_API_URL;
  previousConfigDir = process.env.NEMAR_CONFIG_DIR;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/datasets") return Response.json({}, { status: 404 });
      bodies.push((await req.json()) as Record<string, unknown>);
      return Response.json({
        message: "created",
        // `resumed: true` only to skip the 10-second IAM-propagation wait the
        // fresh-create branch takes AFTER the request; the request under test
        // has already been sent and captured by then.
        resumed: true,
        dataset: {
          id: "1",
          dataset_id: "nm099998",
          name: "fixture",
          description: null,
          github_repo: "nemarDatasets/nm099998",
          github_url: "https://github.com/nemarDatasets/nm099998",
          ssh_url: "git@github.com:nemarDatasets/nm099998.git",
          s3_prefix: "nm099998/",
        },
        upload_urls: {},
        s3_config: { bucket: "nemar", region: "us-east-2", public_url: "https://example.invalid" },
      });
    },
  });
  process.env.TEST_API_URL = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  // Guarded restore (#1175): assigning `undefined` to a process.env key stores
  // the literal string "undefined" instead of deleting it, and test/ and
  // backend/test/ share one process at the root.
  if (previousApiUrl === undefined) delete process.env.TEST_API_URL;
  else process.env.TEST_API_URL = previousApiUrl;
  if (previousConfigDir === undefined) delete process.env.NEMAR_CONFIG_DIR;
  else process.env.NEMAR_CONFIG_DIR = previousConfigDir;
});

beforeEach(() => {
  bodies = [];
  configDir = mkdtempSync(join(tmpdir(), "nemar-explicit-id-cfg-"));
  datasetDir = mkdtempSync(join(tmpdir(), "nemar-explicit-id-ds-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "fixture-admin",
      accounts: { "fixture-admin": { apiKey: "test-key" } },
    }),
  );
  process.env.NEMAR_CONFIG_DIR = configDir;
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(datasetDir, { recursive: true, force: true });
});

const FILES = [{ path: "dataset_description.json", size: 42, type: "metadata" as const }];

describe("nemar dataset upload --dataset-id", () => {
  test("a named id reaches the wire as dataset_id", async () => {
    const result = await createOrResumeDataset(
      datasetDir,
      { datasetId: "nm099998" },
      "fixture",
      FILES,
      null,
    );

    expect(result.status).toBe("ok");
    expect(bodies).toHaveLength(1);
    expect(bodies[0].dataset_id).toBe("nm099998");
  });

  test("an ordinary upload sends no dataset_id key at all", async () => {
    const result = await createOrResumeDataset(datasetDir, {}, "fixture", FILES, null);

    expect(result.status).toBe("ok");
    expect(bodies).toHaveLength(1);
    // Asserted on the PARSED body, so it is a statement about the wire and not
    // about the object literal: `JSON.stringify` drops an undefined value, so
    // writing the key unconditionally and omitting it are indistinguishable
    // here and this test does not pretend to tell them apart. What it does
    // catch is the mutant that matters -- any DEFAULT for `dataset_id`, which
    // would have every ordinary upload claim a reserved id.
    expect("dataset_id" in bodies[0]).toBe(false);
  });

  test("the option's attribute name is what transfer.ts reads", () => {
    const option = createUploadCommand().options.find((o) => o.long === "--dataset-id");
    expect(option).toBeDefined();
    // Renaming the flag renames the attribute, and `createOrResumeDataset`
    // reads `options.datasetId`. This is the coupling the wire tests above
    // cannot see, because they pass the options object directly.
    expect(option?.attributeName()).toBe("datasetId");
  });
});
