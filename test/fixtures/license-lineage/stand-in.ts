/**
 * A local stand-in for the registries, serving the RECORDED responses in this directory
 * (`index.json`; provenance in README.md). It answers each request with the status and body that
 * the real registry gave on the recording date, keyed by registry, method and URL (decoded, with
 * the query parameters order-independent), and the OpenNeuro GraphQL POST by its query.
 *
 * `override` sets an HTTP condition on a route (a status, or a delay past the client's timeout),
 * the HTTP-fixture pattern `.rules/testing.md` allows for error paths. A request with no recording
 * is answered 599 and listed in `misses`, so a test can assert it read only real responses.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistryBases } from "../../../shared/license-lineage";

interface Recording {
  registry: keyof RegistryBases;
  method: "GET" | "POST";
  path: string;
  body?: { query: string };
  status: number;
  file: string;
}

const DIR = import.meta.dir;
const RECORDINGS: Recording[] = JSON.parse(readFileSync(join(DIR, "index.json"), "utf-8"));

function keyOf(method: string, registry: string, pathAndQuery: string, body?: string): string {
  const url = new URL(pathAndQuery, "http://x");
  const params = [...url.searchParams.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("&");
  const q = body ? `|${body.replace(/\s+/g, " ").trim()}` : "";
  return `${method} ${registry} ${decodeURIComponent(url.pathname)}?${params}${q}`;
}

export interface Override {
  status?: number;
  delayMs?: number;
}

export interface StandIn {
  bases: RegistryBases;
  origin: string;
  requests: string[];
  misses: string[];
  /** Answer `GET <origin>/api<path>` (the NEMAR API a spawned CLI is configured with) with `body`. */
  setApi(path: string, body: unknown): void;
  /** Set an HTTP condition on every request whose key contains `match`. */
  override(match: string, o: Override): void;
  stop(): void;
}

export function startStandIn(): StandIn {
  const table = new Map<string, Recording>();
  for (const r of RECORDINGS) {
    table.set(keyOf(r.method, r.registry, r.path, r.body?.query), r);
  }
  const overrides: Array<[string, Override]> = [];
  const api = new Map<string, unknown>();
  const requests: string[] = [];
  const misses: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const [, registry, ...rest] = url.pathname.split("/");
      const path = `/${rest.join("/")}${url.search}`;
      let body: string | undefined;
      if (req.method === "POST") {
        const parsed = (await req.json()) as { query?: string };
        body = parsed.query;
      }
      const key = keyOf(req.method, registry, path, body);
      requests.push(key);
      if (registry === "api") {
        const sub = url.pathname.slice("/api".length);
        if (sub === "/notices") return Response.json({ notices: [] });
        if (api.has(sub)) return Response.json(api.get(sub));
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      const o = overrides.find(([m]) => key.includes(m))?.[1];
      if (o?.delayMs) await Bun.sleep(o.delayMs);
      if (o?.status) return new Response("{}", { status: o.status });
      const rec = table.get(key);
      if (!rec) {
        misses.push(key);
        return new Response("no recording", { status: 599 });
      }
      return new Response(readFileSync(join(DIR, rec.file)), {
        status: rec.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const origin = `http://localhost:${server.port}`;
  return {
    bases: {
      datacite: `${origin}/datacite`,
      crossref: `${origin}/crossref`,
      openalex: `${origin}/openalex`,
      openneuro: `${origin}/openneuro`,
      physionet: `${origin}/physionet`,
    },
    origin,
    requests,
    misses,
    setApi: (path, body) => {
      api.set(path, body);
    },
    override: (match, o) => {
      overrides.push([match, o]);
    },
    stop: () => server.stop(true),
  };
}
