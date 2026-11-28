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
 * the commands that reproduce the review's identification of LICENSE (ADR 0142; printed, never
 * run), and the exit code (0 for a compatible outcome, 2 for every other, 1 for a missing path).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "bun";
import {
  LICENSE_MATCHER_VERSION,
  reproduceCommands,
  scancodeRequirementsUrl,
} from "../shared/license-file";
import {
  LINEAGE_COPY,
  type LineageResult,
  RESOLVER_VERSION,
  SOURCE_STATUS_COPY,
  lineageLines,
  resolveLicenseLineage,
} from "../shared/license-lineage";
import { version as cliVersion } from "../src/lib/version";
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
    NEMAR_LICENSE_OSF_URL: standIn.bases.osf,
    NEMAR_LICENSE_FIGSHARE_URL: standIn.bases.figshare,
    NEMAR_LICENSE_ZENODO_URL: standIn.bases.zenodo,
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

  test("an osf.io source and a declared license: the outcome is the answer, no bug-report prompt", async () => {
    // nm000712's source shape (ADR 0142 decision 3): an osf.io URL with no DataCite DOI.
    writeDataset({
      Name: "fixture",
      License: "CC0",
      SourceDatasets: [{ URL: "https://osf.io/rmafj/" }, { DOI: "10.23668/psycharchives.22842" }],
    });
    const { stdout, stderr, exitCode } = await licenseCheck([dataset]);
    expect(stdout).toContain("License lineage: needs_permission");
    // DataCite holds no DOI for the node, so it is named by its URL (ADR 0139, amended 2026-11-27).
    expect(stdout).toContain("https://osf.io/rmafj [source_datasets]: share_alike_mismatch");
    expect(stdout).not.toContain("10.17605/osf.io/rmafj");
    expect(stdout).toContain(
      'declared license: "CC-By Attribution-ShareAlike 4.0 International" <https://creativecommons.org/licenses/by-sa/4.0/legalcode>',
    );
    expect(stdout).toContain('declared license: "Scientific Use License v1"');
    expect(exitCode).toBe(2);
    expect(stderr).not.toContain("attach the log");
    expect(standIn.misses).toEqual([]);
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
    expect(result.resolver_version).toBe(RESOLVER_VERSION);
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

  test("prints the commands that scan LICENSE as the review does, and runs none of them", async () => {
    writeDataset({ Name: "fixture", License: "CC0" });
    const license = join(dataset, "LICENSE");
    writeFileSync(license, "CC0 1.0 Universal\n");
    const commands = reproduceCommands(license, cliVersion);
    const { stdout, exitCode } = await licenseCheck([dataset]);
    expect(stdout).toContain(`License file: ${license}`);
    expect(stdout).toContain(LICENSE_MATCHER_VERSION);
    for (const c of commands) expect(stdout).toContain(`    ${c}`);
    expect(commands[1]).toContain(`/nemar-cli/v${cliVersion}/scripts/ci/scancode-requirements.txt`);
    expect(commands[2]).toContain(`--json - '${license}'`);
    // The exit code is the lineage's, unchanged by the license file.
    expect(exitCode).toBe(2);
    // Nothing was run: no environment was created.
    expect(existsSync(join(REPO_ROOT, "scancode-env"))).toBe(false);
    expect(existsSync(join(dataset, "scancode-env"))).toBe(false);
  }, 30_000);

  test("--json carries license_matcher; no LICENSE means no commands", async () => {
    writeDataset({ Name: "fixture", License: "CC0" });
    const none = await licenseCheck([dataset, "--json"]);
    expect(JSON.parse(none.stdout).license_matcher).toEqual({
      version: LICENSE_MATCHER_VERSION,
      requirements: scancodeRequirementsUrl(cliVersion),
      license_file: null,
      commands: [],
    });
    expect(none.exitCode).toBe(2);
    const license = join(dataset, "LICENSE");
    writeFileSync(license, "CC0 1.0 Universal\n");
    const some = await licenseCheck([dataset, "--json"]);
    const parsed = JSON.parse(some.stdout) as LineageResult & { license_matcher: unknown };
    expect(parsed.outcome).toBe("no_upstream_declared");
    expect(parsed.license_matcher).toEqual({
      version: LICENSE_MATCHER_VERSION,
      requirements: scancodeRequirementsUrl(cliVersion),
      license_file: license,
      commands: reproduceCommands(license, cliVersion),
    });
    const human = await licenseCheck([dataset]);
    expect(human.stdout).not.toContain("no LICENSE at the dataset root");
    rmSync(license);
    expect((await licenseCheck([dataset])).stdout).toContain(
      "License file: no LICENSE at the dataset root",
    );
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

  test("unresolved and needs_permission print no bug-report prompt; a 5xx from NEMAR does", async () => {
    for (const sources of [
      [{ URL: "https://example.org/data" }],
      [{ URL: "https://osf.io/j7as8" }],
    ]) {
      const result = await resolveLicenseLineage(
        {
          datasetDescription: JSON.stringify({ License: "CC0", SourceDatasets: sources }),
          nemarMetadata: null,
          attestationUpstreamSource: null,
          readme: null,
        },
        { bases: standIn.bases },
      );
      expect(["unresolved", "needs_permission"]).toContain(result.outcome);
      standIn.setApi("/admin/datasets/nm000480/license-lineage", {
        dataset_id: "nm000480",
        ...result,
      });
      const r = await cli(["admin", "dataset", "publish", "license-lineage", "nm000480"]);
      expect(r.stdout).toContain(`License lineage: ${result.outcome}`);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).not.toContain("attach the log");
    }
    standIn.setApi("/admin/datasets/nm000480/license-lineage", { error: "Internal error" }, 500);
    const failed = await cli(["admin", "dataset", "publish", "license-lineage", "nm000480"]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("attach the log");
  }, 60_000);

  test("a malformed id is refused before any request", async () => {
    const { exitCode } = await cli(["admin", "dataset", "publish", "license-lineage", "nope"]);
    expect(exitCode).toBe(1);
    expect(standIn.requests.some((k) => k.includes("license-lineage"))).toBe(false);
  }, 30_000);
});
