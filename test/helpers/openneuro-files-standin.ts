import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";

/**
 * A local stand-in for OpenNeuro's GraphQL endpoint, answering the two-snapshot file-listing query
 * of `fetchSnapshotFilePair` (epic #1046 phase 4c, #1910) from the REAL recordings in
 * `test/fixtures/openneuro-snapshot-files/` (2026-10-24). A request is matched on the posted
 * `ds`, `from` and `to` variables; one that no recording holds answers 500 "not recorded" so a
 * test that asks for it fails loudly instead of reading an empty listing.
 *
 * Failure modes for the network cases a recording cannot hold: a status, a hang, a body that is
 * not JSON, and a partial answer (one snapshot null plus an `errors[]` entry, the shape GraphQL
 * uses when a tag does not exist).
 */

const FIXTURES = join(import.meta.dir, "../fixtures/openneuro-snapshot-files");

const RECORDINGS: Record<string, string> = {
  "ds002893 1.0.0 2.0.0": "snapshot-files-ds002893-1.0.0-2.0.0.response.json",
  "ds003082 1.0.0 1.0.1": "snapshot-files-ds003082-1.0.0-1.0.1.response.json",
};

export interface FilesRequest {
  ds: string;
  from: string;
  to: string;
  query: string;
  userAgent: string | null;
}

type Mode =
  | { kind: "recorded" }
  | { kind: "status"; status: number }
  | { kind: "hang" }
  | { kind: "text"; body: string }
  | { kind: "partial" }
  | { kind: "ds-fails"; ds: string; status: number }
  | { kind: "ds-content-fails"; ds: string };

export function startOpenNeuroFilesStandin() {
  const requests: FilesRequest[] = [];
  let mode: Mode = { kind: "recorded" };
  const server: Server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as {
        query: string;
        variables: { ds: string; from: string; to: string };
      };
      const { ds, from, to } = body.variables;
      requests.push({ ds, from, to, query: body.query, userAgent: req.headers.get("user-agent") });
      if (mode.kind === "status") return new Response("down", { status: mode.status });
      if (mode.kind === "hang") return new Promise<Response>(() => {});
      if (mode.kind === "text") return new Response(mode.body);
      if (mode.kind === "ds-fails" && mode.ds === ds) {
        return new Response("down", { status: mode.status });
      }
      if (mode.kind === "ds-content-fails" && mode.ds === ds) {
        // OpenNeuro answered (HTTP 200) but cannot serve this dataset: GraphQL errors, null data.
        return Response.json({
          data: { a: null, b: null },
          errors: [{ message: `Dataset ${ds} has been deleted.`, path: ["a"] }],
        });
      }
      const file = RECORDINGS[`${ds} ${from} ${to}`];
      if (!file) return new Response(`not recorded: ${ds} ${from} ${to}`, { status: 500 });
      const recorded = JSON.parse(readFileSync(join(FIXTURES, file), "utf-8")) as {
        data: { a: unknown; b: unknown };
      };
      if (mode.kind === "partial") {
        return Response.json({
          data: { a: recorded.data.a, b: null },
          errors: [{ message: `Snapshot ${ds}:${to} not found`, path: ["b"] }],
        });
      }
      return Response.json(recorded);
    },
  });
  return {
    url: `http://localhost:${server.port}/crn/graphql`,
    requests,
    setStatus(status: number) {
      mode = { kind: "status", status };
    },
    setHang() {
      mode = { kind: "hang" };
    },
    setText(body: string) {
      mode = { kind: "text", body };
    },
    setPartial() {
      mode = { kind: "partial" };
    },
    /** Answer HTTP `status` for one dataset only; every other dataset is served from the recording. */
    failDataset(ds: string, status = 503) {
      mode = { kind: "ds-fails", ds, status };
    },
    /** Answer HTTP 200 with GraphQL errors for one dataset: reachable, but unusable for it. */
    failDatasetContent(ds: string) {
      mode = { kind: "ds-content-fails", ds };
    },
    setRecorded() {
      mode = { kind: "recorded" };
    },
    stop() {
      server.stop(true);
    },
  };
}
