/**
 * A local stand-in for an authenticated NEMAR data host, for the special remote, credential
 * helper and clone tests. Real HTTP servers on loopback, no mocked client code.
 *
 * Two servers, so a redirect crosses a real origin boundary:
 *
 *   - the data host: `GET /api/datasets/<id>`, `GET|HEAD /o/<id>/<key>` with a Bearer key, and
 *     smart HTTP git at `/git/<id>.git/...` with Basic (any user name, the key as password),
 *     served by `git http-backend` from a directory of bare repositories. A small object is
 *     answered with its bytes; one over `redirectAbove` bytes is a 302 to the storage server.
 *   - the storage server (another port, so another origin): serves the bytes only to a request
 *     that carries no `Authorization` at all, like a presigned address, and answers 403 to one
 *     that does. It also records every request, so a test can show what it was sent.
 *
 * Both record each request with the credential headers it carried. Tests assert on those
 * records: the property under test is where the API key went.
 */

import type { Server } from "bun";

export interface SeenRequest {
  method: string;
  path: string;
  /** The raw `Authorization` header, or null when there was none. */
  authorization: string | null;
}

export interface StandinOptions {
  apiKey: string;
  datasetId: string;
  /** Objects by git-annex key. */
  objects?: Map<string, Uint8Array>;
  /** An object longer than this is redirected to the storage server; default 1 KiB. */
  redirectAbove?: number;
  /** A directory holding `<datasetId>.git`, served at `/git/`. */
  gitRoot?: string;
  /**
   * Answer an authenticated git request with a 302 to the same path on this origin (another
   * origin, the storage server's by default when given as `"storage"`), so a clone is redirected
   * across origins after it has authenticated.
   */
  gitRedirectTo?: "storage";
  /**
   * Answer a request for an object instead of the default. Return undefined to fall through.
   * `storageOrigin` is the other server's origin.
   */
  override?: (req: Request, key: string, storageOrigin: string) => Response | undefined;
}

export class DataHostStandin {
  readonly dataSeen: SeenRequest[] = [];
  readonly storageSeen: SeenRequest[] = [];
  readonly origin: string;
  readonly storageOrigin: string;
  private readonly data: Server;
  private readonly storage: Server;
  /** The secret in each redirect's query string, so tests can search output for it. */
  readonly redirectTokens: string[] = [];

  constructor(private readonly options: StandinOptions) {
    this.storage = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => this.handleStorage(req),
    });
    this.storageOrigin = `http://127.0.0.1:${this.storage.port}`;
    this.data = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => this.handleData(req),
    });
    this.origin = `http://127.0.0.1:${this.data.port}`;
  }

  stop(): void {
    this.data.stop(true);
    this.storage.stop(true);
  }

  /** Requests the data host got that carried a given path prefix. */
  dataRequests(prefix: string): SeenRequest[] {
    return this.dataSeen.filter((seen) => seen.path.startsWith(prefix));
  }

  private record(into: SeenRequest[], req: Request): void {
    into.push({
      method: req.method,
      path: new URL(req.url).pathname,
      authorization: req.headers.get("authorization"),
    });
  }

  private handleStorage(req: Request): Response {
    this.record(this.storageSeen, req);
    const path = new URL(req.url).pathname;
    if (path.startsWith("/git/")) {
      // A git request that arrives here asks for credentials, as a protected host would.
      return new Response("authentication required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="storage"' },
      });
    }
    if (req.headers.get("authorization") !== null) {
      // A presigned address refuses a request that also names a credential.
      return new Response("refused: Authorization sent", { status: 403 });
    }
    const url = new URL(req.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/blob\//, ""));
    const bytes = this.options.objects?.get(key);
    if (!bytes) return new Response("no such object", { status: 404 });
    return new Response(req.method === "HEAD" ? null : bytes, {
      headers: { "Content-Length": String(bytes.byteLength) },
    });
  }

  private async handleData(req: Request): Promise<Response> {
    this.record(this.dataSeen, req);
    const url = new URL(req.url);
    const auth = req.headers.get("authorization") ?? "";

    if (url.pathname.startsWith("/git/")) return this.handleGit(req, url, auth);

    if (auth !== `Bearer ${this.options.apiKey}`) {
      return new Response('{"ok":false,"error":"unauthenticated"}', {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const lookup = url.pathname.match(/^\/api\/datasets\/([^/]+)$/);
    if (lookup) {
      if (lookup[1] !== this.options.datasetId) {
        return new Response('{"ok":false,"error":"not_found"}', { status: 404 });
      }
      return Response.json({
        ok: true,
        dataset: { id: this.options.datasetId, name: "Fixture dataset" },
        permission: "read",
      });
    }

    const object = url.pathname.match(/^\/o\/([^/]+)\/([^/]+)$/);
    if (object) {
      const key = decodeURIComponent(object[2]);
      const custom = this.options.override?.(req, key, this.storageOrigin);
      if (custom) return custom;
      if (object[1] !== this.options.datasetId) return new Response("not found", { status: 404 });
      const bytes = this.options.objects?.get(key);
      if (!bytes) return new Response("not found", { status: 404 });
      if (req.method === "GET" && bytes.byteLength > (this.options.redirectAbove ?? 1024)) {
        const token = `tok${crypto.randomUUID().replaceAll("-", "")}`;
        this.redirectTokens.push(token);
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${this.storageOrigin}/blob/${encodeURIComponent(key)}?X-Signature=${token}`,
          },
        });
      }
      return new Response(req.method === "HEAD" ? null : bytes, {
        headers: {
          "Content-Length": String(bytes.byteLength),
          "Content-Type": "application/octet-stream",
        },
      });
    }
    return new Response("not found", { status: 404 });
  }

  private async handleGit(req: Request, url: URL, auth: string): Promise<Response> {
    const [scheme, value] = auth.split(" ");
    const password = scheme?.toLowerCase() === "basic" ? atob(value ?? "").split(":")[1] : null;
    if (password !== this.options.apiKey) {
      return new Response("authentication required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="NEMAR"' },
      });
    }
    if (this.options.gitRedirectTo === "storage") {
      return new Response(null, {
        status: 302,
        headers: { Location: `${this.storageOrigin}${url.pathname}${url.search}` },
      });
    }
    if (!this.options.gitRoot) return new Response("not found", { status: 404 });
    const body = Buffer.from(await req.arrayBuffer());
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      GIT_PROJECT_ROOT: this.options.gitRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: req.method,
      PATH_INFO: url.pathname.replace(/^\/git/, ""),
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers.get("content-type") ?? "",
      CONTENT_LENGTH: String(body.length),
      REMOTE_ADDR: "127.0.0.1",
      GATEWAY_INTERFACE: "CGI/1.1",
      SERVER_PROTOCOL: "HTTP/1.1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const encoding = req.headers.get("content-encoding");
    if (encoding) env.HTTP_CONTENT_ENCODING = encoding;
    const protocol = req.headers.get("git-protocol");
    if (protocol) env.HTTP_GIT_PROTOCOL = protocol;

    const out = await runBackend(env, body);
    const split = out.indexOf("\r\n\r\n");
    const headerText = out.subarray(0, split).toString("utf8");
    const headers = new Headers();
    let status = 200;
    for (const line of headerText.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const name = line.slice(0, colon);
      const text = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number(text.split(" ")[0]);
      else headers.set(name, text);
    }
    return new Response(out.subarray(split + 4), { status, headers });
  }
}

/** Run `git http-backend` and collect its whole output. */
async function runBackend(env: Record<string, string>, stdin: Buffer): Promise<Buffer> {
  const proc = Bun.spawn(["git", "http-backend"], {
    env,
    stdin,
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = Buffer.from(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  return out;
}

/** `n` bytes that are not all the same, so a shortened copy cannot match by accident. */
export function patternBytes(n: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = x & 0xff;
  }
  return bytes;
}
