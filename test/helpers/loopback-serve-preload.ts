/**
 * Preloaded for every `bun test` run (bunfig.toml): a `Bun.serve()` that names no interface
 * listens on loopback only.
 *
 * Why. The fake registrars, mail servers and S3 stand-ins in these suites call
 * `Bun.serve({ port: 0 })` and are reached at 127.0.0.1. Bun's default is a wildcard bind,
 * and on macOS a wildcard bind succeeds on a port some other process already holds on
 * 127.0.0.1 specifically (workerd, node, a VPN agent). The kernel sends 127.0.0.1 traffic to
 * the more specific listener, so the request is answered by a stranger: a 200 "ok", a 404, a
 * 401 "auth required", a 500, and the fake records no call. Measured on a developer machine
 * with other sessions running: 8 of 6,000 fetches to a fresh `port: 0` server were answered by
 * a foreign listener, every one on a port another process held, and 0 of 6,000 once the
 * server bound 127.0.0.1 explicitly. That is how a test such as email-delivery-fence's
 * "production bypasses the allow-list" fails once in a few dozen runs under load and then
 * passes on the rerun. A CI runner has no foreign listeners, so the same suites never show it.
 *
 * Binding the loopback address means the kernel refuses a port that is taken there, which
 * is the collision the wildcard bind hid. A caller that names `hostname` (or `unix`) keeps
 * what it asked for.
 */

const serve = Bun.serve.bind(Bun) as (options: Record<string, unknown>) => unknown;

(Bun as { serve: unknown }).serve = (options: Record<string, unknown>) =>
  serve(
    "hostname" in options || "unix" in options ? options : { ...options, hostname: "127.0.0.1" },
  );
