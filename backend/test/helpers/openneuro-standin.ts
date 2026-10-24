import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";

/**
 * A local stand-in for OpenNeuro's GraphQL endpoint (epic #1046 phase 4a, #1910). It answers the
 * batched snapshot query the way the real server does, from the REAL recorded response in
 * `backend/test/fixtures/openneuro-graphql/` (2026-10-24): each posted alias `aN` is looked up by
 * its dataset id in the recording, and a dataset OpenNeuro refused comes back as `null` plus an
 * `errors[]` entry whose `path` is `["aN"]`, with the recorded message and code.
 *
 * It logs every request (the posted variables, the user agent), and has failure modes for the
 * network cases a recording cannot hold: a status, a hang, a body that is not JSON.
 *
 * An id that is not in the recording is a test bug and answers 500 "not recorded: dsX", so it
 * shows, unless `synthetic` is on: then an unrecorded id gets a plain one-snapshot node, which is
 * for tests of batching mechanics that need more ids than the recording holds.
 */

const FIXTURES = join(import.meta.dir, "../fixtures/openneuro-graphql");

interface Recorded {
  nodes: Map<string, unknown>;
  errors: Map<string, Record<string, unknown>>;
}

function loadRecording(): Recorded {
  const request = JSON.parse(
    readFileSync(join(FIXTURES, "graphql-upstream-snapshots.request.json"), "utf-8"),
  ) as { variables: Record<string, string> };
  const response = JSON.parse(
    readFileSync(join(FIXTURES, "graphql-upstream-snapshots.response.json"), "utf-8"),
  ) as { data: Record<string, unknown>; errors: Array<Record<string, unknown>> };
  const nodes = new Map<string, unknown>();
  const errors = new Map<string, Record<string, unknown>>();
  for (const [alias, ds] of Object.entries(request.variables)) {
    const node = response.data[alias];
    if (node !== null && node !== undefined) nodes.set(ds, node);
    const err = response.errors.find((e) => Array.isArray(e.path) && e.path[0] === alias);
    if (err) errors.set(ds, err);
  }
  return { nodes, errors };
}

export interface OpenNeuroRequest {
  /** The dataset ids posted, in alias order. */
  ids: string[];
  userAgent: string | null;
  contentType: string | null;
  /** The posted query text. */
  query: string;
}

type Mode =
  | { kind: "recorded" }
  | { kind: "status"; status: number }
  | { kind: "hang" }
  | { kind: "text"; body: string };

export function startOpenNeuroStandin() {
  const recording = loadRecording();
  const log: OpenNeuroRequest[] = [];
  const overrides = new Map<string, unknown>();
  let mode: Mode = { kind: "recorded" };
  let synthetic = false;

  const server: Server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { query: string; variables: Record<string, string> };
      const aliases = Object.keys(body.variables);
      log.push({
        ids: aliases.map((a) => body.variables[a] as string),
        userAgent: req.headers.get("user-agent"),
        contentType: req.headers.get("content-type"),
        query: body.query,
      });
      if (mode.kind === "status") return new Response("down", { status: mode.status });
      if (mode.kind === "text") return new Response(mode.body, { status: 200 });
      if (mode.kind === "hang") return new Promise<Response>(() => {});

      const data: Record<string, unknown> = {};
      const errors: unknown[] = [];
      for (const alias of aliases) {
        const ds = body.variables[alias] as string;
        if (overrides.has(ds)) {
          data[alias] = overrides.get(ds);
        } else if (recording.nodes.has(ds)) {
          data[alias] = recording.nodes.get(ds);
        } else if (recording.errors.has(ds)) {
          data[alias] = null;
          errors.push({ ...recording.errors.get(ds), path: [alias] });
        } else if (synthetic) {
          data[alias] = {
            id: ds,
            latestSnapshot: { tag: "1.0.0", created: "2020-01-01T00:00:00.000Z" },
            snapshots: [{ tag: "1.0.0", created: "2020-01-01T00:00:00.000Z" }],
          };
        } else {
          return new Response(`not recorded: ${ds}`, { status: 500 });
        }
      }
      return Response.json({
        ...(errors.length > 0 ? { errors } : {}),
        data,
        extensions: { openneuro: { version: "5.10.1" } },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/crn/graphql`,
    log,
    /** Answer `ds` with `node` instead of the recording (a node the real server never sends). */
    override(ds: string, node: unknown) {
      overrides.set(ds, node);
    },
    status(status: number) {
      mode = { kind: "status", status };
    },
    hang() {
      mode = { kind: "hang" };
    },
    text(body: string) {
      mode = { kind: "text", body };
    },
    synthetic(on: boolean) {
      synthetic = on;
    },
    reset() {
      mode = { kind: "recorded" };
      synthetic = false;
      overrides.clear();
      log.length = 0;
    },
    stop: () => server.stop(true),
  };
}
