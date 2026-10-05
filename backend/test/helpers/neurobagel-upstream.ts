/**
 * A real local HTTP server standing where Neurobagel's public repositories are, for tests that
 * drive the verification sweep through the admin route or the command line (epic #1586,
 * phase 6), where there is no option to pass an address.
 *
 * It serves the REAL recorded answers of GitHub's public API
 * (`fixtures/neurobagel-verify/PROVENANCE.md`), and redirects the sweep's one read through the
 * test-only `globalThis.NEMAR_NEUROBAGEL_UPSTREAM_URL`, so no test reaches the internet.
 * A test that needs a different upstream replaces `answers`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "../fixtures/neurobagel-verify");
const read = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

/** What the stand-in answers, by path below the API root. */
export const RECORDED: Record<string, unknown> = {
  "/repos/neurobagel/api/releases/latest": read("github-release-api.json"),
  "/repos/neurobagel/federation-api/releases/latest": read("github-release-federation-api.json"),
  "/repos/neurobagel/query-tool/releases/latest": read("github-release-query-tool.json"),
  "/repos/neurobagel/communities/contents/configs/Neurobagel": read(
    "github-contents-communities-configs.json",
  ),
  "/repos/neurobagel/communities/contents/config_metadata": read(
    "github-contents-communities-config-metadata.json",
  ),
};

export interface UpstreamStandin {
  /** Replace what is answered: a body, or a status to answer without one. */
  answers: Record<string, unknown>;
  /** Every request received, `METHOD /path`. */
  requests: string[];
  stop(): void;
}

export function startUpstreamStandin(): UpstreamStandin {
  const standin: UpstreamStandin = {
    answers: { ...RECORDED },
    requests: [],
    stop() {
      (globalThis as { NEMAR_NEUROBAGEL_UPSTREAM_URL?: string }).NEMAR_NEUROBAGEL_UPSTREAM_URL =
        undefined;
      server.stop(true);
    },
  };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      standin.requests.push(`${req.method} ${path}`);
      if (!(path in standin.answers)) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(standin.answers[path]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  (globalThis as { NEMAR_NEUROBAGEL_UPSTREAM_URL?: string }).NEMAR_NEUROBAGEL_UPSTREAM_URL =
    `http://127.0.0.1:${server.port}`;
  return standin;
}
