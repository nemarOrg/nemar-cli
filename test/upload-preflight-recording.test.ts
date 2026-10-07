/**
 * The identifier preflight reaches the backend with the deposit attestation (ADR 0087), on both
 * ways an upload starts: a create, and a resume from the CLI's local config, which never calls
 * the create route and so records through `PUT /datasets/:id/attestation`.
 *
 * Real HTTP against a local Bun.serve stand-in that records each body, the real client and the
 * real `createOrResumeDataset`, and a record made by the real preflight step from a real tree.
 * Asserted on the WIRE: an argument that is accepted but never sent is the failure this guards.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UploaderPreflight } from "../shared/identifier-screen-report";
import { getApiUrl } from "../src/lib/api/client";
import type { DepositAttestation } from "../src/lib/attestation";
import type { LocalDatasetConfig } from "../src/lib/dataset-config";
import { identifierPreflightStep } from "../src/lib/upload/identifier-preflight";
import { createOrResumeDataset, warnUnrecordedPreflight } from "../src/lib/upload/transfer";

interface Seen {
  method: string;
  pathname: string;
  body: Record<string, unknown> | null;
}

let server: ReturnType<typeof Bun.serve> | undefined;
let seen: Seen[] = [];
/** What the stand-in says about the preflight; `undefined` plays a backend that predates it. */
let recordedReply: boolean | undefined;
let putStatus = 200;
let configDir: string;
let datasetDir: string;
let serverUrl: string;
/**
 * Test-tier URL overrides (every `TEST_`-prefixed variable ending in `_URL`), set aside while this
 * file runs and put back after. The client prefers such an override to the config file, and a
 * live-tier file earlier in the same process sets one and keeps it, so without this the client
 * would follow it. This file talks to its own stand-in only, named in the config file.
 */
const setAside = new Map<string, string>();
let previousConfigDir: string | undefined;
let preflight: UploaderPreflight;

const ATTESTATION: DepositAttestation = {
  deposit_type: "owner",
  key_status: "destroyed",
  deidentified: true,
};

const DATASET = {
  id: "1",
  dataset_id: "nm099998",
  name: "fixture",
  description: null,
  github_repo: "nemarDatasets/nm099998",
  github_url: "https://github.com/nemarDatasets/nm099998",
  ssh_url: "git@github.com:nemarDatasets/nm099998.git",
  s3_prefix: "nm099998/",
};

const S3 = { bucket: "nemar", region: "us-east-2", public_url: "https://example.invalid" };

const recording = (): Record<string, boolean> =>
  recordedReply === undefined ? {} : { identifier_preflight_recorded: recordedReply };

beforeAll(async () => {
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.startsWith("TEST_") && key.endsWith("_URL")) {
      setAside.set(key, value);
      Reflect.deleteProperty(process.env, key);
    }
  }
  previousConfigDir = process.env.NEMAR_CONFIG_DIR;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      seen.push({
        method: req.method,
        pathname: url.pathname,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
      });
      if (req.method === "POST" && url.pathname === "/datasets") {
        // `resumed: true` only skips the IAM-propagation wait a fresh create takes after the
        // request; the request under test has been sent and recorded by then.
        return Response.json({
          message: "created",
          resumed: true,
          dataset: DATASET,
          upload_urls: {},
          s3_config: S3,
          ...recording(),
        });
      }
      if (req.method === "GET" && url.pathname === "/datasets/nm099998") {
        return Response.json({ dataset: { ...DATASET, visibility: "private" } });
      }
      if (req.method === "PUT" && url.pathname === "/datasets/nm099998/attestation") {
        if (putStatus !== 200) return Response.json({ error: "no" }, { status: putStatus });
        return Response.json({ recorded: true, ...recording() });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  serverUrl = `http://localhost:${server.port}`;

  // A real record, from the real step over a real (clean) tree.
  const tree = mkdtempSync(join(tmpdir(), "nemar-preflight-wire-tree-"));
  try {
    writeFileSync(join(tree, "dataset_description.json"), JSON.stringify({ Name: "Fixture" }));
    mkdirSync(join(tree, "code"));
    writeFileSync(join(tree, "code", "notes.txt"), "nothing to see\n");
    const step = await identifierPreflightStep(tree, {}, false);
    if (step.status !== "ok" || step.value === null) throw new Error("no preflight record");
    preflight = step.value;
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

afterAll(() => {
  server?.stop(true);
  for (const [key, value] of setAside) process.env[key] = value;
  // Guarded restore (#1175): test/ and backend/test/ share one process at the root.
  if (previousConfigDir === undefined) Reflect.deleteProperty(process.env, "NEMAR_CONFIG_DIR");
  else process.env.NEMAR_CONFIG_DIR = previousConfigDir;
});

beforeEach(() => {
  seen = [];
  recordedReply = true;
  putStatus = 200;
  configDir = mkdtempSync(join(tmpdir(), "nemar-preflight-wire-cfg-"));
  datasetDir = mkdtempSync(join(tmpdir(), "nemar-preflight-wire-ds-"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "wire",
      accounts: { wire: { apiKey: "test-key", apiUrl: serverUrl } },
    }),
  );
  process.env.NEMAR_CONFIG_DIR = configDir;
  // The stand-in is named in the config file only. If anything in the environment points the
  // client somewhere else, stop here rather than send a request to it.
  expect(getApiUrl()).toBe(serverUrl);
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(datasetDir, { recursive: true, force: true });
});

const FILES = [{ path: "sub-01/eeg/sub-01_task-rest_eeg.edf", size: 4096, type: "data" as const }];

/**
 * What a call printed. `console.log` is the step's only output channel; it is swapped for a
 * collector for the length of one call and put back however the call ends.
 */
async function printed<T>(fn: () => Promise<T>): Promise<{ value: T; output: string }> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const value = await fn();
    return { value, output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

const LOCAL_CONFIG: LocalDatasetConfig = {
  dataset_id: "nm099998",
  github_url: DATASET.github_url,
  ssh_url: DATASET.ssh_url,
  s3_prefix: DATASET.s3_prefix,
  s3_config: S3,
  created_at: "2026-10-06T00:00:00.000Z",
};

describe("a create sends the preflight beside the attestation", () => {
  test("the record on the wire is the one the step made", async () => {
    expect(preflight.scan.status).toBe("no-recordings");
    const { value: result, output } = await printed(() =>
      createOrResumeDataset(datasetDir, {}, "fixture", FILES, null, ATTESTATION, preflight),
    );
    expect(result.status).toBe("ok");
    expect(output).not.toContain("not recorded");
    const create = seen.filter((s) => s.method === "POST" && s.pathname === "/datasets");
    expect(create).toHaveLength(1);
    expect(create[0]?.body?.identifier_preflight).toEqual(preflight);
    expect(create[0]?.body?.attestation).toEqual(ATTESTATION);
  });

  test("a backend that drops the field is called out, and the create goes on", async () => {
    recordedReply = undefined;
    const { value: result, output } = await printed(() =>
      createOrResumeDataset(datasetDir, {}, "fixture", FILES, null, ATTESTATION, preflight),
    );
    expect(result.status).toBe("ok");
    expect(output).toContain("this NEMAR server does not record it");
  });

  test("a create without a preflight sends no such key", async () => {
    await createOrResumeDataset(datasetDir, {}, "fixture", FILES, null, ATTESTATION);
    const body = seen.find((s) => s.pathname === "/datasets")?.body ?? {};
    expect("identifier_preflight" in body).toBe(false);
  });
});

describe("a resume from the local config records both through the attestation route", () => {
  test("PUT carries the attestation and the preflight, after the dataset is confirmed", async () => {
    const result = await createOrResumeDataset(
      datasetDir,
      {},
      "fixture",
      FILES,
      LOCAL_CONFIG,
      ATTESTATION,
      preflight,
    );
    expect(result.status).toBe("ok");
    expect(seen.map((s) => `${s.method} ${s.pathname}`)).toEqual([
      "GET /datasets/nm099998",
      "PUT /datasets/nm099998/attestation",
    ]);
    expect(seen[1]?.body).toEqual({ attestation: ATTESTATION, identifier_preflight: preflight });
  });

  test("a backend without the route warns and the upload goes on", async () => {
    putStatus = 404;
    const { value: result, output } = await printed(() =>
      createOrResumeDataset(datasetDir, {}, "fixture", FILES, LOCAL_CONFIG, ATTESTATION, preflight),
    );
    expect(result.status).toBe("ok");
    expect(output).toContain("could not be recorded on resume");
    expect(output).toContain("not recorded with your attestation");
  });

  test("a stored record says nothing more", async () => {
    const { output } = await printed(() =>
      createOrResumeDataset(datasetDir, {}, "fixture", FILES, LOCAL_CONFIG, ATTESTATION, preflight),
    );
    expect(output).not.toContain("not recorded");
  });
});

describe("warnUnrecordedPreflight: never silent, never a refusal", () => {
  test("says nothing only when a record was sent and the backend says it stored it", () => {
    expect(warnUnrecordedPreflight(undefined, {})).toBe(false);
    expect(warnUnrecordedPreflight(preflight, { identifier_preflight_recorded: true })).toBe(false);
  });

  test("warns when the backend did not say it stored it, refused it, or failed", () => {
    // A backend that predates the preflight drops the field and says nothing about it.
    expect(warnUnrecordedPreflight(preflight, {})).toBe(true);
    expect(warnUnrecordedPreflight(preflight, { identifier_preflight_recorded: false })).toBe(true);
    expect(
      warnUnrecordedPreflight(preflight, {
        identifier_preflight_recorded: false,
        identifier_preflight_refused: "scan-kinds",
      }),
    ).toBe(true);
    expect(warnUnrecordedPreflight(preflight, { error: new Error("offline") })).toBe(true);
  });

  test("each cause is said as itself", async () => {
    const said = async (outcome: Parameters<typeof warnUnrecordedPreflight>[1]) =>
      (
        await printed(async () => {
          warnUnrecordedPreflight(preflight, outcome);
        })
      ).output;
    expect(await said({})).toContain("this NEMAR server does not record it");
    expect(await said({ identifier_preflight_recorded: false })).toContain(
      "the server could not store it",
    );
    expect(
      await said({
        identifier_preflight_recorded: false,
        identifier_preflight_refused: "scan-kinds",
      }),
    ).toContain("the server refused it (scan-kinds)");
    expect(await said({ error: new Error("offline") })).toContain("the request failed: offline");
  });
});

describe("a resume with a preflight and no attestation says the preflight went nowhere", () => {
  test("nothing is sent for it, and the uploader is told", async () => {
    const { value: result, output } = await printed(() =>
      createOrResumeDataset(datasetDir, {}, "fixture", FILES, LOCAL_CONFIG, undefined, preflight),
    );
    expect(result.status).toBe("ok");
    expect(seen.map((s) => `${s.method} ${s.pathname}`)).toEqual(["GET /datasets/nm099998"]);
    expect(output).toContain("preflight-without-attestation");
  });
});
