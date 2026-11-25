/**
 * CI TIER: process (it spawns the CLI and serves a local stand-in registry).
 *
 * `nemar dataset license-check <path>` through the real CLI entry point (epic #2182 card D1):
 * a real subprocess on a fixture BIDS directory, with the registries replaced by a local
 * stand-in that serves the responses recorded in test/fixtures/license-lineage/. The registry
 * origins move through NEMAR_LICENSE_*_URL, which exist for this test only. The child gets an
 * environment built from nothing and an isolated NEMAR_CONFIG_DIR whose API is the stand-in.
 *
 * Asserted: the printed outcome, sources, evidence URLs, remedy and docs link, the JSON form,
 * and the exit code (0 for a compatible outcome, 2 for every other, 1 for a missing path).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "bun";
import {
  LINEAGE_COPY,
  type LineageResult,
  SOURCE_STATUS_COPY,
  lineageLines,
  resolveLicenseLineage,
} from "../shared/license-lineage";
import { type StandIn, startStandIn } from "./fixtures/license-lineage/stand-in";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

let standIn: StandIn;
let scratch: string;
let dataset: string;

beforeEach(() => {
  standIn = startStandIn();
  scratch = mkdtempSync(join(tmpdir(), "nemar-license-check-"));
  dataset = join(scratch, "dataset");
  mkdirSync(dataset);
  const configDir = join(scratch, "config");
  mkdirSync(configDir);
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "t",
      accounts: { t: { apiKey: "k", apiUrl: `${standIn.origin}/api` } },
    }),
  );
});

afterEach(() => {
  standIn.stop();
  rmSync(scratch, { recursive: true, force: true });
});

function writeDataset(description: Record<string, unknown>, readme?: string): void {
  writeFileSync(join(dataset, "dataset_description.json"), JSON.stringify(description));
  if (readme !== undefined) writeFileSync(join(dataset, "README"), readme);
}

async function cli(args: string[]) {
  const env: Record<string, string> = {
    PATH: dirname(process.execPath),
    HOME: scratch,
    NEMAR_CONFIG_DIR: join(scratch, "config"),
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    TERM: "dumb",
    NEMAR_LICENSE_DATACITE_URL: standIn.bases.datacite,
    NEMAR_LICENSE_CROSSREF_URL: standIn.bases.crossref,
    NEMAR_LICENSE_OPENALEX_URL: standIn.bases.openalex,
    NEMAR_LICENSE_OPENNEURO_URL: standIn.bases.openneuro,
    NEMAR_LICENSE_PHYSIONET_URL: standIn.bases.physionet,
  };
  const proc = spawn({
    cmd: [process.execPath, "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

const licenseCheck = (args: string[]) => cli(["dataset", "license-check", ...args]);

describe("nemar dataset license-check", () => {
  test("an OpenNeuro CC0 source and a PhysioNet ODC-By source: compatible_attribution, exit 0", async () => {
    writeDataset(
      {
        Name: "fixture",
        License: "CC0",
        SourceDatasets: [{ URL: "https://openneuro.org/datasets/ds003645/versions/2.0.2" }],
      },
      "Converted. Also uses https://physionet.org/content/eegmmidb/1.0.0/ and cites 10.1038/s41597-019-0027-4.",
    );
    const { stdout, exitCode } = await licenseCheck([dataset]);
    expect(stdout).toContain("License lineage: compatible_attribution");
    expect(stdout).toContain("10.18112/openneuro.ds003645.v2.0.2 [source_datasets]: compatible");
    expect(stdout).toContain("evidence: https://openneuro.org/datasets/ds003645/versions/2.0.2");
    expect(stdout).toContain("10.13026/c28g6p [readme]: compatible_attribution");
    expect(stdout).toContain(
      `evidence: ${standIn.bases.physionet}/api/v1/project/published/eegmmidb/1.0.0/`,
    );
    // The README's article DOI is not an upstream source.
    expect(stdout).not.toContain("s41597");
    expect(stdout).toContain(`Remedy: ${LINEAGE_COPY.compatible_attribution.remedy}`);
    expect(stdout).toContain(`Docs: ${LINEAGE_COPY.compatible_attribution.anchor}`);
    expect(exitCode).toBe(0);
    expect(standIn.misses).toEqual([]);
  }, 30_000);

  test("a Zenodo CC-BY-NC source under a CC0 target: needs_permission, exit 2", async () => {
    writeDataset({
      Name: "fixture",
      License: "CC0",
      SourceDatasets: [{ URL: "https://zenodo.org/records/22967622" }],
    });
    const { stdout, exitCode } = await licenseCheck([dataset]);
    expect(stdout).toContain("License lineage: needs_permission");
    expect(stdout).toContain(
      "10.5281/zenodo.22967622 [source_datasets]: needs_permission; license cc-by-nc 4.0",
    );
    expect(stdout).toContain(`evidence: ${standIn.bases.datacite}/dois/10.5281%2Fzenodo.22967622`);
    expect(stdout).toContain(`Remedy: ${LINEAGE_COPY.needs_permission.remedy}`);
    expect(exitCode).toBe(2);
  }, 30_000);

  test("--json prints the result document; a credentialed source exits 2", async () => {
    writeDataset({
      Name: "fixture",
      License: "CC0",
      SourceDatasets: [{ DOI: "10.13026/5ntk-km72" }],
    });
    const { stdout, exitCode } = await licenseCheck([dataset, "--json"]);
    const result = JSON.parse(stdout) as LineageResult;
    expect(result.outcome).toBe("redistribution_prohibited");
    expect(result.resolver_version).toBe("license-lineage/1");
    expect(result.sources[0]).toMatchObject({
      resolver: "physionet",
      license: "physionet-credentialed",
    });
    expect(exitCode).toBe(2);
  }, 30_000);

  test("no declared source: no_upstream_declared, exit 2, and no registry is asked", async () => {
    writeDataset({ Name: "fixture", License: "CC0" });
    const { stdout, exitCode } = await licenseCheck([dataset]);
    expect(stdout).toContain("License lineage: no_upstream_declared");
    expect(exitCode).toBe(2);
    expect(standIn.requests.filter((k) => !k.includes(" api "))).toEqual([]);
  }, 30_000);

  test("inputs it cannot use exit 1 with one line naming the problem, and no stack trace", async () => {
    const cases: Array<[string, () => string, string]> = [
      [
        "a file, not a directory",
        () => {
          const f = join(scratch, "plain-file");
          writeFileSync(f, "x");
          return f;
        },
        "Not a directory",
      ],
      ["no dataset_description.json", () => dataset, "No dataset_description.json in"],
      [
        "an unparseable dataset_description.json",
        () => {
          writeFileSync(join(dataset, "dataset_description.json"), "{ not json");
          return dataset;
        },
        SOURCE_STATUS_COPY.description_unreadable.statement,
      ],
      [
        "an unparseable .nemar/metadata.json",
        () => {
          writeDataset({ Name: "x", License: "CC0" });
          mkdirSync(join(dataset, ".nemar"), { recursive: true });
          writeFileSync(join(dataset, ".nemar", "metadata.json"), "[1, 2");
          return dataset;
        },
        SOURCE_STATUS_COPY.metadata_unreadable.statement,
      ],
      [
        "an unreadable dataset_description.json",
        () => {
          writeDataset({ Name: "x", License: "CC0" });
          chmodSync(join(dataset, "dataset_description.json"), 0o000);
          return dataset;
        },
        "Could not read",
      ],
    ];
    for (const [name, setup, message] of cases) {
      rmSync(dataset, { recursive: true, force: true });
      mkdirSync(dataset);
      const { stdout, stderr, exitCode } = await licenseCheck([setup()]);
      expect(exitCode, name).toBe(1);
      expect(stderr.trim().split("\n"), name).toHaveLength(1);
      expect(stderr, name).toContain(message);
      expect(stderr, name).not.toContain("    at ");
      expect(stdout, name).not.toContain("License lineage:");
      const desc = join(dataset, "dataset_description.json");
      if (existsSync(desc)) chmodSync(desc, 0o644);
    }
    expect(standIn.requests.filter((k) => !k.includes(" api "))).toEqual([]);
  }, 60_000);

  test("a missing path exits 1", async () => {
    const { exitCode, stderr } = await licenseCheck([join(scratch, "absent")]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Path not found");
  }, 30_000);
});

describe("nemar admin dataset publish license-lineage", () => {
  test("prints the Worker's result with the same lines, and exits by the outcome", async () => {
    // The Worker's answer, computed by the same resolver over the recorded registries.
    const result = await resolveLicenseLineage(
      {
        datasetDescription: JSON.stringify({
          License: "CC0",
          SourceDatasets: [{ DOI: "10.13026/5ntk-km72" }],
        }),
        nemarMetadata: null,
        attestationUpstreamSource: null,
        readme: null,
      },
      { bases: standIn.bases },
    );
    standIn.setApi("/admin/datasets/nm000480/license-lineage", {
      dataset_id: "nm000480",
      ...result,
    });
    const { stdout, exitCode } = await cli([
      "admin",
      "dataset",
      "publish",
      "license-lineage",
      "nm000480",
    ]);
    expect(stdout).toContain("Dataset: nm000480");
    for (const line of lineageLines(result)) expect(stdout).toContain(line);
    expect(exitCode).toBe(2);
  }, 30_000);

  test("a malformed id is refused before any request", async () => {
    const { exitCode } = await cli(["admin", "dataset", "publish", "license-lineage", "nope"]);
    expect(exitCode).toBe(1);
    expect(standIn.requests.some((k) => k.includes("license-lineage"))).toBe(false);
  }, 30_000);
});
