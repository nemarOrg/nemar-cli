/**
 * A real local HTTP upstream for the MCP recording-tools tests (epic #1065
 * phase 3, issue #1295; plan decision 9) -- the `Bun.serve()` precedent
 * `zarr-data-cache.test.ts` documents (its own module doc, "Real engines
 * throughout, no mocks"): a real server on an ephemeral port, standing in
 * for both S3 (`zarr-data.ts`'s `deps.s3Base`) and
 * `raw.githubusercontent.com` (`get-events.ts`'s `deps.rawGithubBase`) in
 * one instance, so a single fixture set serves both.
 *
 * Serves committed fixture files by path (registered via a plain
 * `Record<string, Uint8Array>`, mutable after `start()` returns -- a test
 * can register `index.json` only once it knows the server's own URL, since
 * the index document's rewritten `data_base`/`events_parquet`/
 * `contract_base` have to point back at this server). Answers `HEAD` with
 * `Content-Length` (hyparquet's `asyncBufferFromUrl` probes the size with
 * `HEAD` before its first ranged `GET` when no `byteLength` is given).
 * Honors a single `Range: bytes=a-b` / `bytes=a-` / `bytes=-N` request with
 * a real `206` + `Content-Range` (hyparquet reads the parquet footer and
 * row group by range); anything else answers `200` with the full body.
 * Logs every request (`{ method, url, range }`) so a test can assert on
 * exactly which keys the code under test actually fetched -- the "reads
 * only `view/<L>/` keys" evidence `render_overview`'s definition of done
 * asks for.
 */

export interface FixtureRequestLogEntry {
  method: string;
  /** The decoded request path, without the leading `/` -- the same "S3
   *  key" shape `zarr-data-cache.test.ts`'s fake upstream logs. */
  url: string;
  range: string;
}

export interface FixtureServer {
  /** `http://localhost:<port>` -- no trailing slash. */
  url: string;
  /** Mutable: `files.set(path, bytes)` after `start()` to register an
   *  object (e.g. a rewritten `index.json`) once the server's own URL is
   *  known. */
  files: Map<string, Uint8Array>;
  requestLog: FixtureRequestLogEntry[];
  stop(): void;
}

function parseSingleRange(header: string, length: number): { start: number; end: number } | null {
  const single = /^bytes=(?:(\d+)-(\d+)|(\d+)-|-(\d+))$/.exec(header);
  if (!single) return null;
  let start: number;
  let end: number;
  if (single[4] !== undefined) {
    const n = Number(single[4]);
    start = Math.max(0, length - n);
    end = length - 1;
  } else if (single[3] !== undefined) {
    start = Number(single[3]);
    end = length - 1;
  } else {
    start = Number(single[1]);
    end = Number(single[2]);
  }
  if (start >= length || start > end) return null;
  return { start, end: Math.min(end, length - 1) };
}

/**
 * Start the fixture server. `initialFiles` seeds the store; more files can
 * be added to the returned `files` map at any point before the request
 * that needs them.
 */
export function startFixtureServer(initialFiles: Record<string, Uint8Array> = {}): FixtureServer {
  const files = new Map<string, Uint8Array>(Object.entries(initialFiles));
  const requestLog: FixtureRequestLogEntry[] = [];

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const key = decodeURIComponent(url.pathname.slice(1));
      const range = req.headers.get("range") ?? "";
      requestLog.push({ method: req.method, url: key, range });

      const bytes = files.get(key);
      if (!bytes) return new Response(null, { status: 404 });
      const isHead = req.method === "HEAD";
      // A cheap, deterministic stand-in for S3's real ETag -- just enough
      // for a test to confirm a reader kept "whatever ETag the upstream
      // sent" rather than fabricating one.
      const etag = `"fixture-${key.length}-${bytes.length}"`;

      if (range) {
        const parsed = parseSingleRange(range, bytes.length);
        if (!parsed) {
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${bytes.length}` },
          });
        }
        const { start, end } = parsed;
        const slice = bytes.slice(start, end + 1);
        return new Response(isHead ? null : slice, {
          status: 206,
          headers: {
            "Content-Length": String(slice.length),
            "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
            "Content-Type": "application/octet-stream",
            ETag: etag,
          },
        });
      }

      return new Response(isHead ? null : bytes, {
        status: 200,
        headers: {
          "Content-Length": String(bytes.length),
          "Content-Type": "application/octet-stream",
          ETag: etag,
        },
      });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    files,
    requestLog,
    stop: () => server.stop(true),
  };
}
