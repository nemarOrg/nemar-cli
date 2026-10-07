/**
 * How an import's finalize publishes: it waits for the identifier screen's verdict and approves
 * only a clear one (ADR 0087).
 *
 * Requesting publication starts the screen (ADR 0086), and approval is refused until it reports.
 * The importer used to request and approve in one run, which the gate now refuses. So finalize
 * polls the request's screen state for a bounded time, approves when `screenGate` says `clear`,
 * re-runs a screen the gate calls `stale` at most once (an automated commit to `main`, such as
 * enrichment's, can land after the screen read the head), and otherwise approves nothing.
 *
 * **A held publication is not a failed import.** Every outcome but an approval error returns: the
 * data is copied and registered, the request stays open, and Phase 4 mails the admins whatever the
 * screen says, including when it never reports. Exiting non-zero here would quarantine or roll back
 * the import and open a public failure issue for a dataset that needs a person, not a fix (ADR 0053).
 *
 * **Unknown is never clear.** A status that cannot be read, a screen view an older backend does
 * not send, a state that is not a state, and a wait that runs out are each `unchecked`, never an
 * approval.
 */

import {
  type ScreenGate,
  isScreenState,
  screenGate,
} from "../../shared/identifier-screen-report.js";
import { ApiError } from "./api/errors.js";
import { approvePublication, getPublishStatus, rerunIdentifierScreen } from "./api/publish.js";
import type { ImportPrivacyRecord } from "./s3-server-copy.js";

/** The outcome of finalize's publication step, as one fixed word. */
export type ImportPublicationOutcome =
  /** The screen was clear and the approval ran. */
  | "published"
  /** The dataset was public before this run (a data re-copy); nothing was requested. */
  | "already-published"
  /** The screen found direct identifiers. The request is blocked; there is no override. */
  | "blocked"
  /** A person must look and approve with a recorded reason. */
  | "review"
  /** No verdict this run could act on. */
  | "unchecked";

/** Why an outcome is `review` or `unchecked`. Fixed words. */
export type ImportPublicationReason =
  /** The screen asked for an admin's acknowledgment (findings of lesser severity, or a scan that could not cover everything). */
  | "acknowledgment-needed"
  /** The import's scrub changed content git tracks, whose original the pushed history still holds. */
  | "history-holds-originals"
  /** The staging manifest has no scrub record (an older prepare), so whether the scrub ran is unknown. */
  | "no-scrub-record"
  /** The screen did not run, failed, or did not report. */
  | "no-verdict"
  /** The screen was still running when the wait ran out. */
  | "timeout"
  /** The request's status could not be read before the wait ran out. */
  | "status-unreadable"
  /** The backend sent no screen view, or a state that is not one. */
  | "no-screen-view"
  /** `main` moved after the screen read it, and the one re-run allowed did not settle it. */
  | "stale"
  /** The approval could not verify which commit the screen read. */
  | "unverified";

export interface PublicationDecision {
  outcome: ImportPublicationOutcome;
  reason?: ImportPublicationReason;
}

/** How long finalize waits for a verdict: past the screen's own 35-minute deadline, under the 50-minute watchdog. */
export const SCREEN_WAIT_MS = 45 * 60_000;
/** How often it reads the request's status while it waits. */
export const SCREEN_POLL_MS = 30_000;
/** Re-runs allowed for a screen whose commit `main` has moved past. */
export const MAX_RESCREENS = 1;
/** Approval attempts for an error that is not the screen's, and the gap between them. */
const APPROVE_ATTEMPTS = 10;
const APPROVE_RETRY_MS = 3_000;

export interface AwaitScreenOptions {
  nemarId: string;
  skipCiCheck: boolean;
  /** From the staging manifest; absent when an older prepare wrote it. */
  privacy: ImportPrivacyRecord | undefined;
  waitMs?: number;
  pollMs?: number;
  approveRetryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Progress for a spinner: fixed words only. */
  onProgress?: (text: string) => void;
}

/** The gate a status view's state puts the request behind; anything unrecognized is `rerun`. */
function gateOfState(state: unknown): ScreenGate | "exempt" {
  if (state === "exempt") return "exempt";
  return screenGate(isScreenState(state) ? state : null);
}

type Verdict =
  | { kind: "verdict"; gate: ScreenGate | "exempt" }
  | { kind: "no-view" }
  | { kind: "timeout" }
  | { kind: "unreadable" };

/** The screen's refusal of an approval, when the error is one; null for any other error. */
function screenRefusal(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.statusCode !== 409) return null;
  if (err.code !== "identifier_screen_not_clear") return null;
  const body = err.rawBody as { gate?: unknown } | undefined;
  return typeof body?.gate === "string" ? body.gate : "unknown";
}

/**
 * Wait for the screen's verdict and approve a clear one. Returns the outcome; throws only when an
 * approval of a clear screen fails for a reason that is not the screen's (the import's failure, as
 * it always was).
 */
export async function awaitScreenAndApprove(
  opts: AwaitScreenOptions,
): Promise<PublicationDecision> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? SCREEN_POLL_MS;
  const deadline = now() + (opts.waitMs ?? SCREEN_WAIT_MS);
  const progress = opts.onProgress ?? (() => undefined);
  let rescreens = 0;

  const pollForVerdict = async (): Promise<Verdict> => {
    let sawStatus = false;
    for (;;) {
      try {
        const status = await getPublishStatus(opts.nemarId);
        const view = status.identifier_screen;
        if (!view || typeof view !== "object") return { kind: "no-view" };
        sawStatus = true;
        const gate = gateOfState(view.state);
        if (gate !== "wait") return { kind: "verdict", gate };
      } catch {
        // A failed read is retried until the deadline; it is never read as a verdict.
      }
      const left = deadline - now();
      if (left <= 0) return { kind: sawStatus ? "timeout" : "unreadable" };
      progress(`Waiting for the identifier screen (${Math.ceil(left / 60_000)} min left)`);
      await sleep(Math.min(pollMs, left));
    }
  };

  for (;;) {
    const verdict = await pollForVerdict();
    if (verdict.kind === "timeout") return { outcome: "unchecked", reason: "timeout" };
    if (verdict.kind === "unreadable") return { outcome: "unchecked", reason: "status-unreadable" };
    if (verdict.kind === "no-view") return { outcome: "unchecked", reason: "no-screen-view" };
    const gate = verdict.gate;
    if (gate === "blocks") return { outcome: "blocked" };
    if (gate === "acknowledge") return { outcome: "review", reason: "acknowledgment-needed" };
    if (gate === "rerun") return { outcome: "unchecked", reason: "no-verdict" };
    if (gate === "wait") return { outcome: "unchecked", reason: "timeout" };

    // Clear. What the screen cannot see is the history: a value the scrub blanked, or a recording
    // it rewrote while git held it, is still in the commits the push carried.
    if (!opts.privacy) return { outcome: "review", reason: "no-scrub-record" };
    if (opts.privacy.historyHoldsOriginals) {
      return { outcome: "review", reason: "history-holds-originals" };
    }

    let refusal: string | null = null;
    for (let attempt = 1; attempt <= APPROVE_ATTEMPTS; attempt++) {
      try {
        progress(`Approving publication (attempt ${attempt}/${APPROVE_ATTEMPTS})`);
        // A retry resumes: the orchestrator keeps its progress, and a resumed run that has not
        // started publishing is gated like a fresh one (ADR 0086).
        await approvePublication(opts.nemarId, attempt > 1, false, opts.skipCiCheck);
        return { outcome: "published" };
      } catch (err) {
        refusal = screenRefusal(err);
        if (refusal !== null) break;
        if (attempt === APPROVE_ATTEMPTS) throw err;
        await sleep(opts.approveRetryMs ?? APPROVE_RETRY_MS);
      }
    }

    // The gate refused a screen this run read as clear: its state or the head moved in between.
    if (refusal === "stale") {
      if (rescreens >= MAX_RESCREENS) return { outcome: "unchecked", reason: "stale" };
      rescreens++;
      progress("The screened commit is no longer main; re-running the identifier screen");
      try {
        await rerunIdentifierScreen(opts.nemarId);
      } catch {
        // A re-run that could not start leaves the old state, which the next read reports.
      }
      continue;
    }
    if (refusal === "unverified") {
      if (deadline - now() <= 0) return { outcome: "unchecked", reason: "unverified" };
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
      continue;
    }
    // Any other refusal: read the state again, which says what it is now, after a pause so a
    // backend that keeps disagreeing with its own status is not asked again at once.
    if (deadline - now() <= 0) return { outcome: "unchecked", reason: "timeout" };
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

/** The fixed sentence the finalize log prints for a decision. Counts and words only: the log is public. */
export function describePublicationDecision(id: string, d: PublicationDecision): string {
  switch (d.outcome) {
    case "published":
      return "Identifier screen: clear; publication approved";
    case "already-published":
      return `${id} was already published; publication not requested (data re-copy only)`;
    case "blocked":
      return "Identifier screen: blocked; publication not approved. The data must be corrected and publication requested again.";
    case "review":
      return `Identifier screen: review (${d.reason}); publication not approved. An admin decides: nemar admin publish list`;
    case "unchecked":
      return `Identifier screen: unchecked (${d.reason}); publication not approved. An admin decides: nemar admin publish screen ${id}`;
  }
}
