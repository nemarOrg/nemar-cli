/**
 * The states of a person's compute access and the only edges between them (epic #2021 phase D1,
 * #2022; ADR 0118, the compute-access addendum). Pure and import-free, so the Worker, the CLI and the
 * tests read one table, as `repull-state.ts` does for a re-pull.
 *
 * Compute access is its OWN grant (`users.compute_access`, migration 0131). It never reads or writes
 * `service_access`: ADR 0040 makes upload approval the single writer of that column, and compute is
 * decided apart from it because it is gated by a different review and spends a finite allocation.
 * The database holds the vocabulary as a CHECK; this module holds what the database cannot say, which
 * edge a decision may take.
 *
 *   none       never asked
 *   requested  the person asked once, and an administrator has not answered
 *   active     granted; the only state that may use compute
 *   suspended  an administrator paused it; a grant lifts it
 *   denied     an administrator declined the request
 *   revoked    an administrator ended it, or the account itself ended
 *
 * A person asks only from `none`, and exactly once: `denied` and `revoked` answer `access_closed`
 * to a new request, because the review is of a person at a moment and a second ask is the
 * administrator's to invite, by granting.
 */

export const COMPUTE_ACCESS_STATES = [
  "none",
  "requested",
  "active",
  "suspended",
  "denied",
  "revoked",
] as const;

export type ComputeAccessState = (typeof COMPUTE_ACCESS_STATES)[number];

export function isComputeAccessState(value: unknown): value is ComputeAccessState {
  return typeof value === "string" && (COMPUTE_ACCESS_STATES as readonly string[]).includes(value);
}

/**
 * The edges a write may take, and no others. `denied` and `revoked` reach `active` by an
 * administrator's grant only; a person never leaves them by asking again.
 */
export const COMPUTE_ACCESS_TRANSITIONS: Readonly<
  Record<ComputeAccessState, readonly ComputeAccessState[]>
> = {
  none: ["requested"],
  requested: ["active", "denied"],
  active: ["suspended", "revoked"],
  suspended: ["active", "revoked"],
  denied: ["active"],
  revoked: ["active"],
};

export function canTransition(from: ComputeAccessState, to: ComputeAccessState): boolean {
  return COMPUTE_ACCESS_TRANSITIONS[from].includes(to);
}

/** True for `active` and for nothing else: a suspended, denied or revoked person does not compute. */
export function canUseCompute(state: ComputeAccessState): boolean {
  return state === "active";
}

/** The four decisions an administrator takes, in the order they are listed. */
export const COMPUTE_ACCESS_DECISIONS = ["grant", "deny", "suspend", "revoke"] as const;
export type ComputeAccessDecision = (typeof COMPUTE_ACCESS_DECISIONS)[number];

export function isComputeAccessDecision(value: unknown): value is ComputeAccessDecision {
  return (
    typeof value === "string" && (COMPUTE_ACCESS_DECISIONS as readonly string[]).includes(value)
  );
}

/** The state each decision ends in. */
export const COMPUTE_DECISION_TARGET: Readonly<Record<ComputeAccessDecision, ComputeAccessState>> =
  {
    grant: "active",
    deny: "denied",
    suspend: "suspended",
    revoke: "revoked",
  };

/**
 * The states each decision may be taken from: exactly the edges above that end in its target. A
 * grant from `requested`, `suspended`, `denied` and `revoked`; a deny from `requested`; a suspend
 * from `active`; a revoke from `active` and `suspended`.
 */
export const COMPUTE_DECISION_FROM: Readonly<
  Record<ComputeAccessDecision, readonly ComputeAccessState[]>
> = {
  grant: COMPUTE_ACCESS_STATES.filter((s) => canTransition(s, "active")),
  deny: COMPUTE_ACCESS_STATES.filter((s) => canTransition(s, "denied")),
  suspend: COMPUTE_ACCESS_STATES.filter((s) => canTransition(s, "suspended")),
  revoke: COMPUTE_ACCESS_STATES.filter((s) => canTransition(s, "revoked")),
};
