/**
 * The switches and caps of the automatic upstream re-pull (epic #1046 phase 7, #1913; ADR 0111).
 *
 * Nothing here acts. These readers say whether a Worker job may act and how much it may do in a
 * day; each job that reads them also tests the environment itself, because the switches would
 * live in one wrangler file read by both environments.
 *
 * The rules, each one deliberate:
 *  - Production is exactly the string `production`. No trim, no case fold, and an unset binding is
 *    not production, so a binding that went missing or was misspelled can never admit an `on`
 *    dataset to an automatic path. The `nemarDatasets` organization is shared with production, so
 *    this is the line between a rehearsal and a real repository.
 *  - A switch is on only as the exact string `"1"` (as `PR_REVIEW_ENABLED`). `"true"`, `" 1"`,
 *    `"yes"` and an unset binding are off.
 *  - The merge switch acts only while the open switch is also on, so turning the open switch off
 *    stops the whole automatic path whatever the merge switch says.
 *  - A cap that is absent takes its default. A cap that is set to anything but one or two digits
 *    no larger than {@link REPULL_CAP_MAX} reads 0 and is reported as unreadable, so a typo stops
 *    the work instead of falling back to a default the owner never chose.
 *
 * The switches are absent from every vars block of `backend/wrangler-sccn.toml`; the owner adds
 * them in a reviewed change (`repull-switches-flag.test.ts` pins that).
 */

import type { Bindings } from "../types/bindings";

/**
 * `REPULL_DAILY_OPEN_CAP` when the binding is absent: dispatches claimed to open a re-pull in a UTC
 * day. The cap bounds dispatches; pull requests follow only under the timing a later slice pins
 * (ADR 0111, Phase 7b, "The open cap").
 */
export const REPULL_OPEN_CAP_DEFAULT = 2;
/** `REPULL_DAILY_MERGE_CAP` when the binding is absent: re-pull merges claimed in a UTC day. */
export const REPULL_MERGE_CAP_DEFAULT = 5;
/** The largest cap a binding may set; a larger value is unreadable, not clamped. */
export const REPULL_CAP_MAX = 20;

export interface CapReading {
  value: number;
  /** `default` when absent, `set` when read, `unreadable` when set to anything else. */
  source: "default" | "set" | "unreadable";
}

/** Exactly `production`: no trim, no case fold, and unset is not production. */
export function isExactProduction(env: Pick<Bindings, "ENVIRONMENT">): boolean {
  return env.ENVIRONMENT === "production";
}

/** The automatic path may open and advance re-pulls: production, and the switch exactly `"1"`. */
export function autoRepullEnabled(
  env: Pick<Bindings, "ENVIRONMENT" | "AUTO_REPULL_ENABLED">,
): boolean {
  return isExactProduction(env) && env.AUTO_REPULL_ENABLED === "1";
}

/** The Worker may merge: the open switch is on as well, because the merge switch alone does nothing. */
export function autoRepullMergeEnabled(
  env: Pick<Bindings, "ENVIRONMENT" | "AUTO_REPULL_ENABLED" | "AUTO_REPULL_MERGE_ENABLED">,
): boolean {
  return autoRepullEnabled(env) && env.AUTO_REPULL_MERGE_ENABLED === "1";
}

/**
 * A cap from its binding. Absent: the fallback. One or two digits and at most
 * {@link REPULL_CAP_MAX}: that number (`0` stops the work). Anything else (a sign, a decimal, a
 * space, an empty string, a larger number) is unreadable and reads 0. This is the one definition of
 * the rule; the merge cap and the open cap both read through it.
 */
export function readCap(raw: string | undefined, fallback: number): CapReading {
  if (raw === undefined) return { value: fallback, source: "default" };
  if (/^\d{1,2}$/.test(raw)) {
    const value = Number(raw);
    if (value <= REPULL_CAP_MAX) return { value, source: "set" };
  }
  return { value: 0, source: "unreadable" };
}

export function repullOpenCap(env: Pick<Bindings, "REPULL_DAILY_OPEN_CAP">): CapReading {
  return readCap(env.REPULL_DAILY_OPEN_CAP, REPULL_OPEN_CAP_DEFAULT);
}

export function repullMergeCap(env: Pick<Bindings, "REPULL_DAILY_MERGE_CAP">): CapReading {
  return readCap(env.REPULL_DAILY_MERGE_CAP, REPULL_MERGE_CAP_DEFAULT);
}

/** What the Worker reads, as the admin route reports it. It holds no secret and no binding value. */
export interface RepullSwitchesReport {
  environment_is_production: boolean;
  auto_repull_enabled: boolean;
  auto_repull_merge_enabled: boolean;
  open_cap: CapReading;
  merge_cap: CapReading;
}

export function repullSwitchesReport(
  env: Pick<
    Bindings,
    | "ENVIRONMENT"
    | "AUTO_REPULL_ENABLED"
    | "AUTO_REPULL_MERGE_ENABLED"
    | "REPULL_DAILY_OPEN_CAP"
    | "REPULL_DAILY_MERGE_CAP"
  >,
): RepullSwitchesReport {
  return {
    environment_is_production: isExactProduction(env),
    auto_repull_enabled: autoRepullEnabled(env),
    auto_repull_merge_enabled: autoRepullMergeEnabled(env),
    open_cap: repullOpenCap(env),
    merge_cap: repullMergeCap(env),
  };
}
