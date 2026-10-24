/**
 * The tag pin against the real OpenNeuro (epic #1046 Phase 3, ADR 0111 decision 10): the GraphQL
 * API that names the latest snapshot, the GitHub mirror that carries the tags, and `prepareImport`
 * itself, refusing a tag the mirror lacks before it creates anything.
 *
 * Integration tier (`*.integration.test.ts`): it reads openneuro.org and github.com, which this
 * repository does not control. ds000001 is used because its mirror is about 330 KB and its tags
 * include OpenNeuro's legacy forms (`00006`, and 24-hex-digit snapshot ids that a bare
 * `git rev-parse` could take for an abbreviated commit).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isOpenNeuroTag } from "../shared/openneuro-tag";
import { cloneOpenNeuroAtTag, openNeuroMirrorUrl } from "../src/lib/import-openneuro";
import { fetchOpenNeuroLatestTag } from "../src/lib/openneuro";
import { makeScratch, run } from "./helpers/annex-repo";

const DATASET = "ds000001";
const scratch = makeScratch("import-tag-pin-live");

afterAll(() => scratch.cleanup());

/** The commit a tag names on the mirror, peeled, as git ls-remote reports it. */
async function mirrorTagCommit(tag: string): Promise<string | null> {
  const r = await run(["git", "ls-remote", "--tags", openNeuroMirrorUrl(DATASET)]);
  const lines = r.stdout.split("\n");
  const peeled = lines.find((l) => l.endsWith(`refs/tags/${tag}^{}`));
  const plain = lines.find((l) => l.endsWith(`refs/tags/${tag}`));
  return (peeled ?? plain)?.split("\t")[0] ?? null;
}

describe("the latest tag comes from OpenNeuro, and the clone is at it", () => {
  test("fetchOpenNeuroLatestTag names a tag the mirror has", async () => {
    const lookup = await fetchOpenNeuroLatestTag(DATASET);
    expect(lookup.tag).not.toBeNull();
    expect(isOpenNeuroTag(lookup.tag)).toBe(true);
    expect(await mirrorTagCommit(lookup.tag as string)).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  test("with no tag, cloneOpenNeuroAtTag clones the mirror at OpenNeuro's latest", async () => {
    const dir = join(scratch.root, "latest");
    const pinned = await cloneOpenNeuroAtTag(DATASET, dir);
    expect(pinned.tag).toBe(pinned.latestTag as string);
    const expected = await mirrorTagCommit(pinned.tag);
    expect(pinned.commit).toBe(expected as string);
    expect((await run(["git", "rev-parse", "HEAD"], dir)).stdout.trim()).toBe(expected as string);
  }, 120_000);

  test("a legacy hex tag is resolved as a tag", async () => {
    const dir = join(scratch.root, "legacy");
    const tag = "57fecb0ccce88d000ac17538";
    const pinned = await cloneOpenNeuroAtTag(DATASET, dir, { tag });
    expect(pinned.commit).toBe((await mirrorTagCommit(tag)) as string);
  }, 120_000);
});

describe("prepareImport refuses a tag the mirror lacks, before it creates anything", () => {
  test("the run exits 1 and its last failure line starts with the mirror-lag marker", async () => {
    // A child process, because prepare ends a refusal with process.exit. No credentials and no
    // API key are given to it: a refusal at Step 1 must not need either, because it happens
    // before the dataset record is created.
    const script = join(scratch.root, "prepare.ts");
    await Bun.write(
      script,
      [
        `import { prepareImport } from ${JSON.stringify(join(import.meta.dir, "..", "src/lib/import-openneuro.ts"))};`,
        `await prepareImport(${JSON.stringify(DATASET)}, { tag: "0.0.0-nemar-absent", workDir: ${JSON.stringify(join(scratch.root, "prepare"))} });`,
        'console.log("UNREACHABLE: prepare returned");',
      ].join("\n"),
    );
    const child = Bun.spawn(["bun", script], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(await child.exited).toBe(1);
    const log = out + err;
    expect(log).not.toContain("UNREACHABLE");
    expect(log).not.toContain("Creating NEMAR dataset record");
    const failures = log.split("\n").filter((l) => l.includes("✖"));
    // The ANSI colour codes ora adds, removed as the workflow's reporter removes them.
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
    const last = (failures.at(-1) ?? "").replace(ansi, "").replace("✖", "").trim();
    expect(
      last.startsWith(`[openneuro-mirror-lag] ${DATASET}: upstream tag 0.0.0-nemar-absent`),
    ).toBe(true);
  }, 120_000);
});

describe("the CLI's --tag reaches prepare", () => {
  test("`admin import-openneuro --phase prepare --tag` refuses a tag the mirror lacks", async () => {
    // The real entry point with an isolated config holding a key it never gets to use: the refusal
    // comes before the first API call. The configured API is a closed local port, so the start-up
    // notice fetch fails at once instead of reaching a real backend.
    const configDir = join(scratch.root, "cli-config");
    await Bun.write(
      join(configDir, "config.json"),
      JSON.stringify({
        activeAccount: "tagpin",
        accounts: { tagpin: { apiKey: "unused-key", apiUrl: "http://127.0.0.1:1" } },
      }),
    );
    const child = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "..", "src", "index.ts"),
        "admin",
        "import-openneuro",
        DATASET,
        "--phase",
        "prepare",
        "--tag",
        "0.0.0-nemar-absent",
        "--dir",
        join(scratch.root, "cli-prepare"),
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: configDir,
          NEMAR_CONFIG_DIR: configDir,
          NEMAR_NO_UPDATE_CHECK: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(await child.exited).toBe(1);
    const failures = (out + err).split("\n").filter((l) => l.includes("✖"));
    expect(failures.at(-1)).toContain(
      `[openneuro-mirror-lag] ${DATASET}: upstream tag 0.0.0-nemar-absent`,
    );
  }, 120_000);
});
