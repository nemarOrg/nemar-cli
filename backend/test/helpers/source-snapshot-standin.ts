import type { Server } from "bun";

/**
 * The local stand-in for the three hosts the snapshot read reaches (epic #1046 phase 2, #1908):
 * the raw content CDN, the GitHub API, and S3, plus the registrar (EZID) answering success. It
 * speaks the real wire formats and logs every request, so a test asserts on what was sent.
 * Shared by `source-snapshot-insert.test.ts` and `source-snapshot-legacy-handler.test.ts`.
 */

export interface Logged {
  method: string;
  path: string;
  authorization: string | null;
  userAgent: string | null;
}

/**
 * One local server for the raw content host, the GitHub API and S3. A `dataset_description.json`
 * is served from `descriptions` (path to {status, body}); absent paths are 404. S3 HEAD and PUT
 * answer 200, the GitHub commit and tree endpoints answer an empty repository.
 */
export function startStandin() {
  const descriptions = new Map<string, { status: number; body: string; chunked: boolean }>();
  /** `<repo>@<ref>` to the `dataset_description.json` text a git tree read of it finds. */
  const gitDescriptions = new Map<string, string>();
  const log: Logged[] = [];
  let hang = false;
  const server: Server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);
      log.push({
        method: req.method,
        path,
        authorization: req.headers.get("authorization"),
        userAgent: req.headers.get("user-agent"),
      });
      // The GitHub App installation-token endpoint, rerouted here: it never answers.
      if (path.startsWith("/__token-stall")) return new Promise<Response>(() => {});
      if (path.endsWith("/dataset_description.json")) {
        if (hang) return new Promise<Response>(() => {});
        const entry = descriptions.get(path);
        if (!entry) return new Response("404: Not Found", { status: 404 });
        if (entry.chunked) {
          // No Content-Length: the reader has to count the bytes itself.
          const bytes = new TextEncoder().encode(entry.body);
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            }),
            { status: entry.status },
          );
        }
        return new Response(entry.body, { status: entry.status });
      }
      const commit = /^\/repos\/nemarDatasets\/([^/]+)\/commits\/(.+)$/.exec(path);
      if (commit) {
        return Response.json({
          sha: "c".repeat(40),
          commit: { tree: { sha: `tree.${commit[2]}` } },
        });
      }
      const tree = /^\/repos\/nemarDatasets\/([^/]+)\/git\/trees\/tree\.(.+)$/.exec(path);
      if (tree) {
        const text = gitDescriptions.get(`${tree[1]}@${tree[2]}`);
        const entries =
          text === undefined
            ? []
            : [
                {
                  path: "dataset_description.json",
                  type: "blob",
                  sha: `blob.${tree[2]}`,
                  size: text.length,
                },
              ];
        return Response.json({ sha: "t".repeat(40), tree: entries, truncated: false });
      }
      const blob = /^\/repos\/nemarDatasets\/([^/]+)\/git\/blobs\/blob\.(.+)$/.exec(path);
      if (blob) {
        const text = gitDescriptions.get(`${blob[1]}@${blob[2]}`) ?? "";
        return Response.json({ content: btoa(text), encoding: "base64" });
      }
      // The registrar (EZID), as the legacy handler's mint reaches it: success for every verb.
      if (path.startsWith("/id/")) return new Response(`success: ${path.slice(4)}`);
      if (req.method === "HEAD" || req.method === "PUT") return new Response(null, { status: 200 });
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    base,
    log,
    setHang(on: boolean) {
      hang = on;
    },
    /** Serve a description for `repo` at `v<version>`. */
    describe(repo: string, version: string, body: unknown, status = 200, chunked = false) {
      descriptions.set(`/nemarDatasets/${repo}/v${version}/dataset_description.json`, {
        status,
        chunked,
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    },
    /** Serve `body` as the description a git tree read of `repo` at `ref` finds. */
    gitDescribe(repo: string, ref: string, body: unknown) {
      gitDescriptions.set(`${repo}@${ref}`, typeof body === "string" ? body : JSON.stringify(body));
    },
    reset() {
      gitDescriptions.clear();
      descriptions.clear();
      log.length = 0;
      hang = false;
    },
    rawRequests: () => log.filter((r) => r.path.endsWith("/dataset_description.json")),
    stop: () => server.stop(true),
  };
}
