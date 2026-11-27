/**
 * The commit of every dataset version's tag, for suites that dispatch a run of the archive (ADR 0143: every
 * Worker-dispatched BIDS run reads the commit of its version's tag first, is deferred when GitHub cannot give it,
 * and is refused when the tag is absent). A real loopback server stands in for the one EXTERNAL request,
 * GitHub's `GET /repos/nemarDatasets/<dataset>/commits/refs/tags/<tag>`, and answers every dataset and tag with
 * {@link tagCommitOf} unless a case set another answer. {@link GITHUB_TAGS_ENV} is the GitHub App configuration a
 * production-shaped Worker needs before it asks, and {@link seedGithubTagsToken} seeds the installation token so
 * none is minted (no request leaves the loopback). Nothing of NEMAR is stood in for.
 *
 *   const tags = startGithubTags();   // in beforeAll; the Worker's GitHub seam now points here
 *   fx.env({ ...GITHUB_TAGS_ENV });   // or startLifecycleFixture({ githubTags: true }), which does both
 *   tags.answer("nm000104", "v1.0.0", { http: 502 });   // GitHub cannot answer: the run is deferred
 *   tags.answer("nm000104", "v1.0.0", "absent");        // no such tag: the run is refused
 */

import { createHash } from "node:crypto";
import { __seedInstallationTokenCacheForTests } from "../../src/services/github-auth";
import type { Bindings } from "../../src/types/bindings";

const LOOPBACK = "127.0.0.1";
const INSTALLATION_ID = 4243;

/** The App configuration that makes `githubAccess` answer with the seeded token; the key is never used to sign. */
export const GITHUB_TAGS_ENV: Partial<Bindings> = Object.freeze({
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "test only: never signed, the installation token is seeded",
  GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: String(INSTALLATION_ID),
});

/** Seed the installation token the configuration names, for an hour; call again after a cache reset. */
export function seedGithubTagsToken(): void {
  __seedInstallationTokenCacheForTests(
    INSTALLATION_ID,
    "github-tags-token",
    Date.now() + 3_600_000,
  );
}

/** The commit a dataset version's tag resolves to unless a case says otherwise: 40 hex digits of its name. */
export function tagCommitOf(dataset: string, tag: string): string {
  return createHash("sha256").update(`${dataset}@${tag}`).digest("hex").slice(0, 40);
}

export interface GithubTags {
  url: string;
  /** The paths asked, in order. */
  log: string[];
  /** Answer one dataset's tag with a commit, a status (a fault), or as absent (404, as GitHub answers it). */
  answer(dataset: string, tag: string, answer: string | { http: number } | "absent"): void;
  /** Forget every answer and the log. */
  reset(): void;
  /** Point the Worker's GitHub seam (`NEMAR_GITHUB_API_URL`) back where it was, and stop. */
  stop(): void;
}

/** Start the stand-in, point the Worker's GitHub seam at it, and seed the installation token. */
export function startGithubTags(): GithubTags {
  const answers = new Map<string, string | { http: number } | "absent">();
  const log: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: LOOPBACK,
    fetch(req) {
      const url = new URL(req.url);
      log.push(url.pathname);
      const m = /^\/repos\/nemarDatasets\/([^/]+)\/commits\/refs\/tags\/([^/]+)$/.exec(
        url.pathname,
      );
      if (!m) return Response.json({ message: "Not Found" }, { status: 404 });
      const dataset = m[1] as string;
      const tag = decodeURIComponent(m[2] as string);
      const set = answers.get(`${dataset}/${tag}`);
      if (set === "absent") return Response.json({ message: "Not Found" }, { status: 404 });
      if (set !== undefined && typeof set !== "string")
        return new Response("{}", { status: set.http });
      // The data plane's tag is `v1.0.0`; the lookup asks for it first, so an unset tag answers under that name.
      return Response.json({ sha: set ?? tagCommitOf(dataset, tag), commit: { message: "tag" } });
    },
  });
  const seam = globalThis as { NEMAR_GITHUB_API_URL?: string };
  const previous = seam.NEMAR_GITHUB_API_URL;
  const url = `http://${LOOPBACK}:${server.port}`;
  seam.NEMAR_GITHUB_API_URL = url;
  seedGithubTagsToken();
  return {
    url,
    log,
    answer: (dataset, tag, answer) => void answers.set(`${dataset}/${tag}`, answer),
    reset() {
      answers.clear();
      log.length = 0;
      seedGithubTagsToken();
    },
    stop() {
      seam.NEMAR_GITHUB_API_URL = previous;
      server.stop(true);
    },
  };
}
