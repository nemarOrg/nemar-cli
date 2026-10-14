/**
 * Which publication requests `nemar admin publish list` asks for.
 *
 * The default is the requests that still need somebody: an administrator
 * reading the list wants what is open, not the history. A state flag narrows to
 * that state, several widen to their union, and `--all` is every request.
 */

export const ACTIVE_STATUSES = ["requested", "approving", "blocked"] as const;

export const STATE_FLAGS = ["requested", "approving", "blocked", "published", "denied"] as const;

export type StateFlag = (typeof STATE_FLAGS)[number];

export interface ListFilterOptions {
  all?: boolean;
  requested?: boolean;
  approving?: boolean;
  blocked?: boolean;
  published?: boolean;
  denied?: boolean;
}

/**
 * The statuses to request, or `undefined` for every request. `--all` wins over
 * the state flags, because "everything" already contains them.
 */
export function resolveListStatuses(options: ListFilterOptions): string[] | undefined {
  if (options.all) return undefined;
  const chosen = STATE_FLAGS.filter((flag) => options[flag]);
  return chosen.length > 0 ? chosen : [...ACTIVE_STATUSES];
}

/** What the list is showing, in the words of the flags that produced it. */
export function describeListScope(options: ListFilterOptions): string {
  const statuses = resolveListStatuses(options);
  if (!statuses) return "all requests";
  if (!STATE_FLAGS.some((flag) => options[flag])) return "active requests";
  return `${statuses.join(" or ")} requests`;
}
