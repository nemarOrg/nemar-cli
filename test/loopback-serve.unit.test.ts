/**
 * A `Bun.serve()` in a test listens on loopback only (test/helpers/loopback-serve-preload.ts).
 *
 * The failure this prevents is intermittent and depends on what else runs on the machine, so it
 * is pinned by what makes it impossible: a server that names no interface cannot share a port
 * with another process's loopback listener. The unpinned default is a wildcard bind, which
 * macOS allows beside a listener on 127.0.0.1, with that listener then answering the requests.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type Server, listen } from "bun";

const stoppers: (() => void)[] = [];
afterEach(() => {
  for (const stop of stoppers.splice(0)) stop();
});

function serveAt(options: { port: number; hostname?: string }): Server {
  const server = Bun.serve({ ...options, fetch: () => new Response("ours") });
  stoppers.push(() => server.stop(true));
  return server;
}

describe("Bun.serve() under bun test", () => {
  test("names no interface: it listens on loopback", () => {
    expect(serveAt({ port: 0 }).hostname).toBe("127.0.0.1");
  });

  test("refuses a port another process already holds on 127.0.0.1, instead of sharing it", () => {
    const stranger = listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {}, open() {} },
    });
    stoppers.push(() => stranger.stop(true));
    expect(() => serveAt({ port: stranger.port })).toThrow();
  });

  test("a caller that names its interface keeps it", () => {
    expect(serveAt({ port: 0, hostname: "0.0.0.0" }).hostname).toBe("0.0.0.0");
  });
});
