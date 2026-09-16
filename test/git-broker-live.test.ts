/**
 * The git-file broker against real GitHub (#1403, epic #1406).
 *
 * The unit suite covers the broker's logic against a local stand-in. What it
 * cannot cover is the thing this phase actually claims: that an installation
 * token reads a PRIVATE repo through the raw content host, and that a reader
 * with no GitHub account at all still gets the metadata. That needs a real
 * private repo, so the staging exemplar `xx099904` is kept in exactly the
 * shape an anonymous deposit has -- D1 row public, GitHub repo private --
 * and this walks it end to end.
 *
 * Why it can skip: the staging Worker deploys from `dev`, so between this
 * branch being written and the epic merging, the deployed data plane still
 * redirects git-tracked files to raw.githubusercontent.com. The skip is
 * decided by asking the live manifest which host it names, so it clears
 * itself the moment the broker is deployed -- rather than sitting red on
 * every unrelated PR's live tier in the meantime, or (worse) passing
 * vacuously and proving nothing.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { LIVE_TARGET_BLOCKED } from "./setup";

const PRIVATE_REPO_EXEMPLAR = "xx099904";
const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

function dataBase(): string {
  return `${(process.env.TEST_API_URL ?? "").replace(/\/+$/, "")}/data`;
}

interface ManifestEntry {
  path: string;
  size: number;
  checksum_algorithm?: string;
  bytes_url: string;
}

async function latestManifest(): Promise<{ version: string; entries: ManifestEntry[] }> {
  const listing = (await (await fetch(`${dataBase()}/${PRIVATE_REPO_EXEMPLAR}`)).json()) as {
    latest: string;
  };
  const entries = (await (
    await fetch(`${dataBase()}/${PRIVATE_REPO_EXEMPLAR}/${listing.latest}/manifest.json`)
  ).json()) as ManifestEntry[];
  return { version: listing.latest, entries };
}

/**
 * Has the deployed data plane got the broker yet?
 *
 * Tri-state on purpose. "Not deployed yet" and "I could not tell" used to be
 * the same `false`, which was defensible while the broker genuinely was not
 * deployed and is not any more: post-merge the broker is permanent, so every
 * skip from here on is an infrastructure error wearing the "not deployed yet"
 * costume. That matters because this file is the ONLY test that can see the
 * #1419 class at all -- the in-process suite is structurally blind to it --
 * so a silent skip is the one way a regression gets back out.
 */
async function brokerIsDeployed(): Promise<boolean | "unknown"> {
  if (LIVE_TARGET_BLOCKED) return false;
  try {
    const { entries } = await latestManifest();
    const git = entries.find((e) => e.checksum_algorithm === "git");
    return git !== undefined && !git.bytes_url.includes("raw.githubusercontent.com");
  } catch (err) {
    console.error(
      `[live] could not determine whether the broker is deployed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "unknown";
  }
}

const PROBE = await brokerIsDeployed();
const DEPLOYED = PROBE === true;

// An unreadable probe fails rather than skipping. It is one assertion, and it
// is the difference between "the oracle ran and found nothing wrong" and "the
// oracle did not run".
describe.skipIf(LIVE_TARGET_BLOCKED)("the git-file broker's live probe", () => {
  test("the deployment probe could reach the data plane", () => {
    expect(PROBE).not.toBe("unknown");
  });
});

describe.skipIf(!DEPLOYED)("git-file broker against a private repo (live)", () => {
  test("every git-tracked entry is served from the data host", async () => {
    const { entries } = await latestManifest();
    const git = entries.filter((e) => e.checksum_algorithm === "git");

    expect(git.length).toBeGreaterThan(0);
    // Not one entry may name GitHub: a single leftover is a file that 404s
    // for every anonymous reader of this dataset.
    expect(git.filter((e) => e.bytes_url.includes("githubusercontent"))).toEqual([]);
  });

  test("the bytes come back, and they do not come back anonymously from GitHub", async () => {
    const { version, entries } = await latestManifest();
    const entry = entries.find(
      (e) => e.checksum_algorithm === "git" && e.path === "dataset_description.json",
    );
    if (!entry) throw new Error("exemplar has no dataset_description.json in its manifest");

    const served = await fetch(entry.bytes_url);
    expect(served.status).toBe(200);
    // Inert type, and the two headers that keep user content from executing
    // on our origin now that we serve it ourselves.
    expect(served.headers.get("Content-Type")).toContain("application/json");
    expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = await served.text();
    expect(JSON.parse(body).Name).toBeTruthy();
    // Compared as a string: `Number(null)` is 0, which would pass vacuously
    // against a zero-byte entry, and this assertion is the whole oracle for
    // #1419.
    expect(served.headers.get("Content-Length")).toBe(String(entry.size));

    // The control that makes the test mean something: the same file, straight
    // from the public content host, is not readable. So the bytes above came
    // through the broker rather than from a repo that happens to be public.
    const direct = await fetch(
      `https://raw.githubusercontent.com/nemarDatasets/${PRIVATE_REPO_EXEMPLAR}/${version}/dataset_description.json`,
    );
    expect(direct.status).toBe(404);
  });

  test("a whole metadata download lands, with no GitHub account anywhere", async () => {
    const out = mkdtempSync(join(tmpdir(), "nemar-broker-live-"));
    try {
      const { entries } = await latestManifest();
      const gitCount = entries.filter((e) => e.checksum_algorithm === "git").length;

      const proc = spawn(
        [
          "bun",
          "run",
          ENTRY,
          "dataset",
          "download",
          PRIVATE_REPO_EXEMPLAR,
          "--http",
          "--no-data",
          "-o",
          out,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NEMAR_NO_UPDATE_CHECK: "1", FORCE_COLOR: "0" },
        },
      );
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(stdout).toContain(`Files:   ${gitCount}`);

      const description = join(out, "dataset_description.json");
      expect(existsSync(description)).toBe(true);
      expect(JSON.parse(readFileSync(description, "utf8")).Name).toBeTruthy();
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
