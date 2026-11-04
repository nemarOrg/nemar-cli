import type { Server } from "bun";

/**
 * A local stand-in for OpenNeuro's GitHub mirror on the raw content host (epic #1046 phase 4,
 * #1910): `/OpenNeuroDatasets/<ds>/<ref>/dataset_description.json`. It logs every request, answers
 * 404 for anything not served, and can hold responses so concurrent requests overlap and be counted.
 */

export interface RawRequest {
  path: string;
  authorization: string | null;
}

export function startRawHost() {
  const files = new Map<string, { status: number; body: string }>();
  const log: RawRequest[] = [];
  let delayMs = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const server: Server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      log.push({ path, authorization: req.headers.get("authorization") });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const entry = files.get(path);
        if (entry === undefined) return new Response("404: Not Found", { status: 404 });
        return new Response(entry.body, { status: entry.status });
      } finally {
        inFlight--;
      }
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    log,
    /** Serve `dataset_description.json` of OpenNeuro's `ds` at `ref` with `status`. */
    serve(ds: string, ref: string, status = 200, body?: string) {
      files.set(`/OpenNeuroDatasets/${ds}/${ref}/dataset_description.json`, {
        status,
        body: body ?? (status === 200 ? '{"Name":"x"}' : "error"),
      });
    },
    /** Hold every response for `ms`, so concurrent requests overlap and can be counted. */
    delay(ms: number) {
      delayMs = ms;
    },
    maxInFlight: () => maxInFlight,
    reset() {
      files.clear();
      log.length = 0;
      delayMs = 0;
      inFlight = 0;
      maxInFlight = 0;
    },
    stop: () => server.stop(true),
  };
}
