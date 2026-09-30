/**
 * The Worker's entry module (`main` in wrangler-sccn.toml).
 *
 * `index.ts` stays the HTTP app and the cron handler, unchanged, and is what
 * the bun tests import. This file adds the one export bun cannot load: the
 * `NemarApiRpc` service-binding entrypoint (ADR 0078), whose module imports
 * `cloudflare:workers`. Anything else a Worker must export belongs in
 * `index.ts` unless it has the same constraint.
 */

export { default } from "./index";
export { NemarApiRpc } from "./rpc/entrypoint";
