/**
 * The publisher canary against a PRIVATE repository (#1450).
 *
 * An anonymous deposit is a public catalog row over a private repository
 * (ADR 0065), and the canary that ends `generateManifest` used to HEAD the raw
 * content host with no credential. Every probe 404'd, so the one dataset shape
 * the anonymity work exists to support could never be given a manifest -- and
 * the manifest is the capability list the data plane brokers against (ADR
 * 0066). Observed on the dev worker: `5/5 git:-keyed files do not resolve`
 * while the reserved version DOI and the `dataset_versions` row landed fine.
 *
 * Real engines throughout: one `Bun.serve()` stands in for api.github.com
 * (through the `NEMAR_GITHUB_API_URL` override the other GitHub-facing suites
 * use) and for the raw host (through `rawBase`), and `generateManifest` is
 * driven as the entry point. Nothing is mocked, so what the assertions see is
 * what was actually sent.
 *
 * The stand-in behaves like a private repo: it 404s any request that arrives
 * without the installation token. `refuses the same probe unauthenticated`
 * pins that, because it is what makes the first test non-vacuous -- against a
 * server that answered 200 for everyone, the fix and the bug would both pass.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { GitBackedFileMissingError, generateManifest } from "../src/services/manifest";

const TOKEN = "test-installation-token";
const REPO = "nm099998";
const TAG = "v1.0.0";
const TREE_SHA = "1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d";

/** Big enough to stay out of the 20-500 byte annex-pointer band. */
const DD_SIZE = 1353;
const CHANGES_SIZE = 640;

const commitPath = `/repos/nemarDatasets/${REPO}/commits/${TAG}`;
const treePath = `/repos/nemarDatasets/${REPO}/git/trees/${TREE_SHA}`;
const ddRawPath = `/nemarDatasets/${REPO}/${TAG}/dataset_description.json`;
const changesRawPath = `/nemarDatasets/${REPO}/${TAG}/CHANGES`;

interface Seen {
  method: string;
  path: string;
  authorization: string | null;
}

let server: Server;
let base: string;
let seen: Seen[] = [];
/** What the current test wants the raw half of the stand-in to answer. */
let rawStatus = 200;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const authorization = request.headers.get("Authorization");
      seen.push({ method: request.method, path: url.pathname, authorization });

      // A private repo, at both hosts: no token, no answer.
      if (authorization !== `Bearer ${TOKEN}`) {
        return new Response("Not Found", { status: 404 });
      }

      if (url.pathname === commitPath) {
        return Response.json({ sha: "deadbeef", commit: { tree: { sha: TREE_SHA } } });
      }
      if (url.pathname === treePath) {
        return Response.json({
          truncated: false,
          tree: [
            {
              path: "dataset_description.json",
              mode: "100644",
              type: "blob",
              sha: "aaaa1111",
              size: DD_SIZE,
            },
            { path: "CHANGES", mode: "100644", type: "blob", sha: "bbbb2222", size: CHANGES_SIZE },
          ],
        });
      }
      if (url.pathname === ddRawPath || url.pathname === changesRawPath) {
        return new Response(null, { status: rawStatus });
      }
      return new Response("no route", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = base;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

function build(): Promise<Awaited<ReturnType<typeof generateManifest>>> {
  seen = [];
  return generateManifest(REPO, "1.0.0", TOKEN, REPO, null, null, { rawBase: base });
}

describe("the manifest canary on a private repository", () => {
  test("refuses the same probe unauthenticated", async () => {
    // The oracle for the tests below. If this 200s, they prove nothing.
    const anonymous = await fetch(`${base}${ddRawPath}`, { method: "HEAD" });
    expect(anonymous.status).toBe(404);
  });

  test("passes, and sends the installation token on every probe", async () => {
    rawStatus = 200;

    const manifest = await build();

    expect(Object.keys(manifest.files).sort()).toEqual(["CHANGES", "dataset_description.json"]);
    const probes = seen.filter((s) => s.method === "HEAD");
    expect(probes.map((p) => p.path).sort()).toEqual([changesRawPath, ddRawPath]);
    for (const probe of probes) {
      expect(probe.authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  test("still refuses a manifest when an authenticated probe 404s", async () => {
    // The check the canary exists for: the tag resolves and the token is
    // accepted, so a 404 on the path means the blob is not there.
    rawStatus = 404;

    let thrown: unknown;
    try {
      await build();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(GitBackedFileMissingError);
    const error = thrown as GitBackedFileMissingError;
    expect(error.message).toContain("dataset_description.json (HTTP 404)");
    expect(error.message).toContain("The probe was authenticated");
    expect(error.checks.map((c) => c.verdict).sort()).toEqual(["absent", "absent"]);
  });

  test("writes the manifest when the host could not answer at all", async () => {
    // A refused credential, a secondary rate limit or a 5xx is not evidence
    // that a blob is gone, and refusing the manifest on one blocks a release
    // for a reason that has nothing to do with the data.
    rawStatus = 503;

    const manifest = await build();

    expect(Object.keys(manifest.files)).toContain("dataset_description.json");
  });
});
