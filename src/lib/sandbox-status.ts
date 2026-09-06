/**
 * Has this account completed sandbox training? (#1274)
 *
 * `config.sandboxCompleted` is a CACHE of a fact the backend owns
 * (`users.sandbox_completed`), and it has THREE states, which the gates that
 * read it through `isSandboxCompleted()` could not tell apart:
 *
 *   `true`      the server said yes. Trusted: the fact never goes backwards
 *               without an explicit `nemar sandbox reset`, which writes here.
 *   `false`     the server said no. Also trusted -- every writer of this
 *               field (login, `auth status --refresh`, `sandbox status
 *               --refresh`, the training run itself, `sandbox reset`) copies
 *               a server answer, so a stored `false` IS a server answer, just
 *               an older one. `--refresh` is how a user updates it.
 *   ABSENT      nobody has ever asked on this machine. A fresh install, a
 *               second laptop, a wiped `~/.config/nemar`.
 *
 * The bug was reading the third as the second: an empty cache is not the
 * server saying no, but the upload gate refused on it anyway and told someone
 * who had trained months ago to train again, while `nemar sandbox` walked them
 * back through it. So absence is now a QUESTION -- ask the backend once, cache
 * what it says, and only then decide.
 *
 * The fourth state is the answer to that question failing. It is neither
 * "trained" nor "not trained": callers keep whatever refusal they had but say
 * something the user can act on (re-check) rather than sending them through
 * training they may not need. Same three-state honesty `service_access` gets
 * in the upload preflight (ADR 0040): absent is not "no".
 */

import { getSandboxStatus } from "./api/auth.js";
import { errorDetail } from "./api/errors.js";
import { getConfig, setConfig } from "./config.js";

export type SandboxCompletion =
  | { status: "completed" }
  | { status: "not_completed" }
  /** The backend could not be asked. `reason` is for the operator, not a gate. */
  | { status: "unknown"; reason: string };

/**
 * Resolve training completion, consulting the backend only when the cache has
 * never been written. Writes the server's answer back to the config on
 * success, so the next command on this machine is a cache hit either way.
 */
export async function resolveSandboxCompletion(): Promise<SandboxCompletion> {
  const cached = getConfig().sandboxCompleted;
  if (cached !== undefined) return { status: cached ? "completed" : "not_completed" };

  try {
    const live = await getSandboxStatus();
    setConfig("sandboxCompleted", live.sandbox_completed);
    if (live.sandbox_dataset_id) setConfig("sandboxDatasetId", live.sandbox_dataset_id);
    return live.sandbox_completed ? { status: "completed" } : { status: "not_completed" };
  } catch (error) {
    return { status: "unknown", reason: errorDetail(error) };
  }
}
