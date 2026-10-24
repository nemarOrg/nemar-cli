/**
 * A real git-annex repository in the shape of an OpenNeuro GitHub mirror, with snapshot tags, for
 * the tag-pin tests (epic #1046 Phase 3).
 *
 * Two tagged snapshots and a HEAD past both of them, because the property under test is "the
 * import is at the tag, not at HEAD": a fixture whose HEAD IS the newest tag could not tell the two
 * apart. Every file changes between snapshots, including an annexed recording, so any part of the
 * tree left behind at the wrong commit shows up.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { run, writeFile } from "./annex-repo";

export const UPSTREAM_ID = "ds000001";

/** The recording's path, annexed as OpenNeuro annexes recordings. */
export const RECORDING = "sub-01/eeg/sub-01_task-rest_eeg.edf";

export interface TaggedUpstream {
  dir: string;
  /** Commit each tag names, and HEAD's. */
  commits: { "1.0.0": string; "1.0.1": string; head: string };
}

/** What `dataset_description.json` holds at each snapshot: OpenNeuro's own DOI form. */
export function upstreamDescription(tag: "1.0.0" | "1.0.1" | "draft"): Record<string, unknown> {
  return {
    Name: "A tagged upstream",
    BIDSVersion: "1.8.0",
    License: "CC0",
    Authors: ["Ada Lovelace"],
    ...(tag === "draft" ? {} : { DatasetDOI: `doi:10.18112/openneuro.${UPSTREAM_ID}.v${tag}` }),
  };
}

async function must(cmd: string[], cwd: string): Promise<string> {
  const r = await run(cmd, cwd);
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function snapshot(dir: string, label: "1.0.0" | "1.0.1" | "draft"): Promise<string> {
  writeFile(dir, "dataset_description.json", `${JSON.stringify(upstreamDescription(label))}\n`);
  writeFile(dir, "README", `README at ${label}\n`);
  writeFile(dir, "participants.tsv", `participant_id\tlabel\nsub-01\t${label}\n`);
  await must(["git", "add", "dataset_description.json", "README", "participants.tsv"], dir);
  // A recording, annexed, whose content (so key) differs per snapshot. The previous one is an annex
  // symlink; removing the link (never its read-only object) lets the new content take its place.
  rmSync(join(dir, RECORDING), { force: true });
  writeFile(dir, RECORDING, `edf bytes at ${label}\n`);
  await must(["git", "annex", "add", RECORDING], dir);
  await must(["git", "commit", "-q", "-m", `snapshot ${label}`], dir);
  return must(["git", "rev-parse", "HEAD"], dir);
}

/** Build the upstream under `root`: tags 1.0.0 and 1.0.1, then an untagged HEAD. */
export async function buildTaggedUpstream(root: string): Promise<TaggedUpstream> {
  const dir = join(root, `upstream-${UPSTREAM_ID}`);
  mkdirSync(dir, { recursive: true });
  await must(["git", "init", "-q", "-b", "main"], dir);
  await must(["git", "config", "user.email", "test@test.com"], dir);
  await must(["git", "config", "user.name", "Test"], dir);
  await must(["git", "annex", "init", "-q", "upstream"], dir);
  // OpenNeuro's rule: recordings annexed, metadata in git.
  writeFile(dir, ".gitattributes", "*.edf annex.largefiles=anything\n* annex.backend=SHA256E\n");
  await must(["git", "add", ".gitattributes"], dir);
  const first = await snapshot(dir, "1.0.0");
  await must(["git", "tag", "1.0.0"], dir);
  const second = await snapshot(dir, "1.0.1");
  // An annotated tag, as some mirrors carry: `^{commit}` must peel it.
  await must(["git", "tag", "-a", "-m", "snapshot 1.0.1", "1.0.1"], dir);
  const head = await snapshot(dir, "draft");
  return { dir, commits: { "1.0.0": first, "1.0.1": second, head } };
}

/**
 * A local endpoint that answers as OpenNeuro's GraphQL does when it is down (HTTP 503), for tests
 * that pass an explicit tag and must not reach the real API for the "latest" lookup. An error-path
 * fixture only: with it, the lookup says it does not know, which is what it would say.
 */
export function startUnavailableGraphql(): {
  lookup: { graphqlUrl: string; attempts: number; retryDelayMs: number };
  stop: () => void;
} {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("unavailable", { status: 503 }),
  });
  return {
    lookup: {
      graphqlUrl: `http://127.0.0.1:${server.port}/crn/graphql`,
      attempts: 1,
      retryDelayMs: 1,
    },
    stop: () => server.stop(true),
  };
}
