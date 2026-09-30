/**
 * `NemarApiRpc`: the service-binding entrypoint the private site's Worker
 * calls (ADR 0078). Exported from `src/worker.ts`, the Worker's `main`.
 *
 * A THIN SHIM, ON PURPOSE. Each method hands `this.env` (and `this.ctx` where
 * a background write needs `waitUntil`) to an env-level function beside this
 * file, and the tests drive those functions. This module is the only one that
 * imports `cloudflare:workers`, which bun cannot resolve; keeping every rule
 * out of it is what keeps every rule testable under bun, and keeping it out of
 * `index.ts` is what keeps the eight test files that import `index.ts` loading.
 * Its own wiring is proven in workerd, by
 * `backend/test/private-site-rpc-entry.test.ts`.
 *
 * What a caller must know is in ADR 0078 and `shared/contract/private-site.ts`:
 * refusals are values and faults throw; the HTTP middleware (CORS, rate limit,
 * maintenance mode) does not run, so each method mirrors maintenance mode
 * itself; and any Worker in the Cloudflare account can bind this, so
 * the account is the trust boundary and no method takes a bare user id as
 * authority.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ExchangePrivateGrantRequest,
  ExchangePrivateGrantResult,
  NemarApiRpcContract,
  PrincipalCredential,
  ResolvePrincipalResult,
  RevokePrivateSessionRequest,
  RevokePrivateSessionResult,
} from "../../../shared/contract/private-site.js";
import type { Bindings } from "../types/bindings";
import { resolvePrincipal } from "./principal";
import { exchangePrivateGrant, revokePrivateSession } from "./private-session";

export class NemarApiRpc extends WorkerEntrypoint<Bindings> implements NemarApiRpcContract {
  resolvePrincipal(credential: PrincipalCredential): Promise<ResolvePrincipalResult> {
    return resolvePrincipal(this.env, credential, this.ctx);
  }

  exchangePrivateGrant(request: ExchangePrivateGrantRequest): Promise<ExchangePrivateGrantResult> {
    return exchangePrivateGrant(this.env, request, this.ctx);
  }

  revokePrivateSession(request: RevokePrivateSessionRequest): Promise<RevokePrivateSessionResult> {
    return revokePrivateSession(this.env, request);
  }
}
