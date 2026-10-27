/**
 * A local listener that stands in as the HTTP and HTTPS proxy of a spawned CLI and records every
 * connection it is asked to make, so a test can assert that nothing left the machine for a
 * non-loopback host. Loopback traffic (the test's own stand-in servers) is excluded from
 * proxying by `NO_PROXY`, so only a request to some other host reaches the spy, which records
 * its first line (`CONNECT host:443 ...` for HTTPS, `GET http://host/... ` for HTTP) and then
 * closes the connection: the request fails, nothing is relayed.
 *
 * Bun's `fetch` and git (through curl) both honor these variables; a positive control in
 * test/data-host-cli.test.ts shows the spy sees a request to an outside host.
 */

import type { TCPSocketListener } from "bun";

export interface EgressSpy {
  /** The first line of each connection that reached the spy. */
  seen: string[];
  /** Variables to add to a spawned process's environment. */
  env: Record<string, string>;
  stop(): void;
}

export function startEgressSpy(): EgressSpy {
  const seen: string[] = [];
  const listener: TCPSocketListener<undefined> = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        seen.push(new TextDecoder().decode(data).split("\r\n")[0]);
        socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      },
      open() {},
      close() {},
      error() {},
    },
  });
  const proxy = `http://127.0.0.1:${listener.port}`;
  return {
    seen,
    env: {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      ALL_PROXY: proxy,
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
    },
    stop: () => listener.stop(true),
  };
}
