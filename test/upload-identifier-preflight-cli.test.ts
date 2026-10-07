/**
 * The identifier preflight through the real CLI entry point (epic #1610 phase 3, ADR 0087).
 *
 * A real subprocess (`bun run src/index.ts dataset upload <dir>`) against a local HTTP server
 * that records every request, with an isolated config. Each test here ends AT the preflight, by
 * design: a run that went past it would go on to talk to GitHub and git-annex with whatever
 * credentials the machine holds, so the proceeding paths are covered at the step level
 * (upload-identifier-preflight.test.ts) and on the wire (upload-preflight-recording.test.ts).
 *
 * What is asserted is what a person and a CI log would see, and what left the machine: the
 * verdict in fixed words, no value and no path in the output, no request that carries dataset
 * content, and no git repository created in the dataset.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

interface Recorded {
  method: string;
  pathname: string;
}

function startServer() {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push({ method: req.method, pathname: url.pathname });
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) };
}

/** A port nothing listens on: the API is unreachable, as on a machine with no network. */
function closedPort(): string {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const url = `http://localhost:${server.port}`;
  server.stop(true);
  return url;
}

let configDir: string;
let dataset: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-preflight-cli-cfg-"));
  // A parent named after nobody, and a dataset directory whose own name must not be printed.
  dataset = join(mkdtempSync(join(tmpdir(), "nemar-preflight-cli-")), "Quillfeather-study");
  mkdirSync(dataset);
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "preflight",
      // The sandbox flag is a cache the upload reads before asking the backend, so the run gets
      // to the preflight without one.
      accounts: { preflight: { apiKey: "k", sandboxCompleted: true } },
    }),
  );
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(dirname(dataset), { recursive: true, force: true });
});

async function upload(args: string[], apiUrl: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: apiUrl,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  // Removed from the CHILD's environment only; this process's own is untouched.
  env.FORCE_COLOR = undefined;
  env.CLICOLOR_FORCE = undefined;
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "dataset", "upload", dataset, ...args],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { output: `${stdout}\n${stderr}`, exitCode: await proc.exited };
}

function put(out: Uint8Array, text: string, start: number, width: number): void {
  out.fill(0x20, start, start + width);
  out.set(new TextEncoder().encode(text).subarray(0, width), start);
}

function recording(patient: string): Uint8Array {
  const out = new Uint8Array(1024).fill(0x20);
  put(out, "0", 0, 8);
  put(out, patient, 8, 80);
  put(out, "Startdate X X X X", 88, 80);
  put(out, "01.01.85", 168, 8);
  return out;
}

function write(rel: string, content: string | Uint8Array): void {
  const path = join(dataset, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Hostile on purpose: a surname with an apostrophe and quotes in the header's name slot, the
 * same surname as a subject label in the paths, and quotes in a file name.
 */
function namedDataset(): void {
  write("dataset_description.json", JSON.stringify({ Name: "Fixture", BIDSVersion: "1.9.0" }));
  write("participants.tsv", "participant_id\tage\nsub-Quillfeather\t30\n");
  write(
    `sub-Quillfeather/eeg/sub-Quillfeather_task-"rest"_eeg.edf`,
    recording(`P01 F X O'Brien-"Quillfeather"`),
  );
}

function brainVisionDataset(): void {
  write("dataset_description.json", JSON.stringify({ Name: "Fixture", BIDSVersion: "1.9.0" }));
  write("sub-01/eeg/sub-01_task-rest_eeg.vhdr", "Brain Vision Data Exchange Header File\n");
  write("sub-01/eeg/sub-01_task-rest_eeg.eeg", new Uint8Array(64));
}

/** Nothing a person could be named by: not the surname, not a path, not the directory. */
function expectNoValue(output: string): void {
  for (const part of ["Quillfeather", "Brien", '"rest"', "sub-Quill", basename(dirname(dataset))]) {
    expect(output).not.toContain(part);
  }
}

/** The request the upload makes first with dataset content, and every step after it. */
function expectNothingSent(requests: Recorded[]): void {
  expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  expect(requests.map((r) => r.pathname).filter((p) => p.startsWith("/datasets"))).toEqual([]);
  expect(existsSync(join(dataset, ".git"))).toBe(false);
}

describe("nemar dataset upload: direct identifiers", () => {
  test("refused in kinds and counts, before anything is sent or any tool runs", async () => {
    namedDataset();
    const server = startServer();
    try {
      const r = await upload(["--yes", "--skip-validation"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain("Identifier preflight: FOUND IDENTIFIERS");
      expect(r.output).toContain("Findings by kind:");
      expect(r.output).toContain("edf-patient-name x1");
      expect(r.output).toContain("Upload refused");
      expect(r.output).toContain("Nothing was sent");
      // It ran before the tool checks, the prerequisite check and validation.
      expect(r.output).not.toContain("Checking prerequisites");
      expect(r.output).not.toContain("Missing required tools");
      expect(r.output).not.toContain("Validating BIDS");
      expectNoValue(r.output);
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });

  test("--dry-run is refused too: the preview says what a real upload would do", async () => {
    namedDataset();
    const server = startServer();
    try {
      const r = await upload(["--dry-run", "--yes"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain("Upload refused");
      expectNoValue(r.output);
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });

  test("no flag acknowledges a direct identifier, and naming the verdict is not allowed", async () => {
    namedDataset();
    const server = startServer();
    try {
      const flagged = await upload(
        ["--yes", "--acknowledge-identifier-preflight", "review"],
        server.url,
      );
      expect(flagged.exitCode).toBe(1);
      expect(flagged.output).toContain("Upload refused");
      const direct = await upload(
        ["--yes", "--acknowledge-identifier-preflight", "direct-identifiers"],
        server.url,
      );
      expect(direct.exitCode).not.toBe(0);
      expect(direct.output).toContain("Allowed choices are");
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });

  test("offline: the preflight needs no network to reach its verdict", async () => {
    namedDataset();
    const r = await upload(["--yes"], closedPort());
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("Identifier preflight: FOUND IDENTIFIERS");
    expect(r.output).toContain("Upload refused");
    expect(existsSync(join(dataset, ".git"))).toBe(false);
  });
});

describe("nemar dataset upload: a verdict that needs an acknowledgment", () => {
  test("--yes does not acknowledge it; without a terminal or the flag, the upload stops", async () => {
    brainVisionDataset();
    const server = startServer();
    try {
      const r = await upload(["--yes"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain("Identifier preflight: recordings NOT screened");
      expect(r.output).toContain("Not screened (format x files): .vhdr x1, .eeg x1.");
      expect(r.output).toContain("--yes does not acknowledge a finding");
      expect(r.output).toContain("--acknowledge-identifier-preflight not-screened");
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });

  test("a flag naming another verdict does not acknowledge this one", async () => {
    brainVisionDataset();
    const server = startServer();
    try {
      const r = await upload(["--yes", "--acknowledge-identifier-preflight", "review"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain("names a different verdict than the one found (not-screened)");
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });

  test("--no declines it", async () => {
    brainVisionDataset();
    const server = startServer();
    try {
      const r = await upload(["--no"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain("Declined (--no)");
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });
});

describe("the upload action hands the record to the create call (source-level supplement)", () => {
  // Every subprocess test above ends at the preflight, because a run past it would reach GitHub
  // and git-annex with this machine's credentials. So nothing above can see whether the action
  // passes the record on to createOrResumeDataset; the wire is tested in
  // upload-preflight-recording.test.ts from that function down. This pins the one hop between.
  test("the step runs before the tool checks and its value reaches createOrResumeDataset", async () => {
    const source = await Bun.file(join(REPO_ROOT, "src", "commands", "dataset.ts")).text();
    const action = source.slice(source.indexOf("export function createUploadCommand"));
    const step = action.indexOf("await identifierPreflightStep(absolutePath, options)");
    expect(step).toBeGreaterThan(0);
    for (const later of [
      'checkPrerequisitesForCommand("upload")',
      "collectAuthorOrcids(",
      "createOrResumeDataset(",
    ]) {
      expect(action.indexOf(later)).toBeGreaterThan(step);
    }
    const call = action.slice(action.indexOf("createOrResumeDataset("));
    const args = call.slice(0, call.indexOf(");"));
    expect(args).toContain("identifierPreflight ?? undefined");
    expect(action).toContain("const identifierPreflight = preflight.value;");
  });
});
