/**
 * Environment classification (epic #923).
 *
 * Allow-list, fail-CLOSED helpers over the `ENVIRONMENT` binding. The type says
 * ENVIRONMENT is one of production|development|staging|test, but at runtime it's
 * whatever wrangler passes (or undefined if misconfigured). Anything that gates
 * information disclosure or destructive/prod-only behavior must treat an unknown
 * value as production, not "not production" — matching the established
 * convention in auth-web.ts (isDevOrTest), email.ts, and admin/doi.ts.
 */

import type { Bindings } from "../types/bindings.js";

const NON_PRODUCTION = new Set(["development", "staging", "test"]);

/** True only for a recognized non-production environment; unknown/unset -> false. */
export function isNonProductionEnv(env: Pick<Bindings, "ENVIRONMENT">): boolean {
  return NON_PRODUCTION.has((env.ENVIRONMENT ?? "").trim().toLowerCase());
}
