/**
 * The unattended run of an automatic re-pull (ADR 0111, decision 6; epic #1046 phase 7, #1913).
 *
 * The Worker claims a dispatch and sends it to the central `run-upstream-repull` workflow, whose
 * job runs `nemar admin repull plan`, `execute` or `resume` with `--automatic-dispatch <id>`. This
 * module is what those three share: the dispatch the run was handed, read and checked; the output
 * rule of a run whose log is public; the check of the plan the automatic path takes, and what the
 * plan step hands the execute; and the run's reports to the Worker.
 *
 * THE DISPATCH. The run reads the dispatch from the event GitHub delivered (`GITHUB_EVENT_PATH`),
 * the `client_payload` the Worker built with `buildUpstreamRepullPayload`: exactly its nine keys,
 * `repull_id` absent on a first dispatch, each a string of the shape the Worker sends. Anything
 * else (a tenth key, a key missing, a value of another shape) is `dispatch-invalid`, and the CLI
 * reports nothing, because nothing in such a payload can be trusted to name the dispatch. The
 * workflow refuses it first, and its backstop reports `failed dispatch-invalid` when the dispatch
 * id, the dataset and the token at least have their shapes; the Worker stores that report only for
 * a token it signed over a live dispatch, so only the dispatch's own run can end it so. The token
 * is read from the event file and nowhere else: it is in no environment variable and no argument,
 * and one found on the command line ends the dispatch (`auto-token-on-argv`), since a token in a
 * `run:` line is in the public log and lets anyone end a live dispatch as failed.
 *
 * PRODUCTION ONLY. The CLI must be a release (`X.Y.Z`, not a development build) and the very
 * version the dispatch names (`auto-cli-version`); the Worker that signed the dispatch refuses an
 * automatic create outside exact production on its own. The API the run talks to must be the
 * production one, or a loopback one for the suites (`auto-api-not-production`, refused before
 * anything is sent and not reported, since the report would go there). `GH_TOKEN` must be set: it
 * is the App token the workflow minted for this dataset's repository alone (`auto-no-app-token`),
 * which lasts an hour, so a copy that would outlast it is refused (`auto-copy-too-long`) and a run
 * that failed with it expired says so (`token-expired`).
 *
 * THE LOG IS PUBLIC. A path can itself be an identifier, and a key or a file name can carry one,
 * so in automatic mode nothing reaches standard output or standard error but this module's own
 * lines, `repull-auto: <event> <key>=<value> ...`, whose values are counts and fixed words
 * ({@link AUTOMATIC_LINE_RE}). Every other write of the process, the libraries' progress lines,
 * their warnings, any error, and the runtime's own report of a crash, is swallowed and counted
 * ({@link installAutomaticQuiet}).
 * Subprocesses print nothing either: every git, git-annex and aws child runs with its output
 * piped (`git-annex/run-command.ts`), and it reaches the console only under `--verbose`, which the
 * automatic mode refuses (`auto-verbose`) together with `--debug`. The run's last line is its
 * result, `repull-auto: result phase=<phase>[ code=<code>]`, which the workflow's backstop reads.
 *
 * THE REPORTS. `POST /webhooks/repull-state` with the dispatch token: `started` once, by the run's
 * first command, then `opened`, `finished`, `refused` or `failed`. A code is a word from
 * `DISPATCH_CODES`; a refusal whose word the list does not hold is reported as its step's class
 * ({@link dispatchCodeOf}). A
 * terminal report the Worker stored leaves `$RUNNER_TEMP/repull-reported`, so the backstop does not
 * report the run again.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isOpenNeuroTag, sameUpstreamTag } from "../../../../shared/openneuro-tag.js";
import {
  APP_TOKEN_USABLE_SECONDS,
  AUTO_AFTER_COPY_SECONDS,
  AUTO_COPY_BUDGET_SECONDS,
  AUTO_SETTLE_RESERVE_SECONDS,
  DISPATCH_ID_RE,
  DISPATCH_TOKEN_RE,
  type DispatchCode,
  type DispatchPhase,
  NEMAR_VERSION_RE,
  type RunStep,
  STEP_CLASSES,
  automaticCopySeconds,
  automaticPlanRefusal,
  isDispatchCode,
} from "../../../../shared/repull-state.js";
import { IS_DEV_BUILD, getApiUrl } from "../../api/client.js";
import { isDebugEnabled } from "../../debug-log.js";
import { IMPORT_SCRUB_REFUSALS } from "../../import-scrub.js";
import { githubApiBase } from "../../pr-review-approve.js";
import { isVerbose } from "../../verbose.js";
import { version as cliVersion } from "../../version.js";
import type { PlanBody } from "../digest.js";
import type { Env } from "../sources.js";
import { planCounts } from "./body.js";
import { ExecuteRefused } from "./verify-plan.js";

/** The option that turns a command into the unattended run of one dispatch. */
export const AUTOMATIC_FLAG = "--automatic-dispatch";

/** The `repository_dispatch` event the central workflow runs on (the Worker's `UPSTREAM_REPULL_EVENT`). */
export const DISPATCH_EVENT = "run-upstream-repull";

/**
 * The keys of a dispatch's `client_payload`, as `buildUpstreamRepullPayload` writes them: nine at
 * most, under GitHub's limit of ten. `repull_id` is the only one that may be absent (a first
 * dispatch names no re-pull).
 */
export const DISPATCH_PAYLOAD_KEYS = [
  "mode",
  "dataset_id",
  "upstream_ds",
  "from_tag",
  "to_tag",
  "dispatch_id",
  "dispatch_token",
  "cli_version",
  "repull_id",
] as const;

const OPTIONAL_PAYLOAD_KEYS: ReadonlySet<string> = new Set(["repull_id"]);

/** A dispatch, as the run was handed it. `token` is a secret: never printed, never in a message. */
export interface DispatchPayload {
  mode: "open" | "finish";
  datasetId: string;
  upstreamDs: string;
  fromTag: string;
  toTag: string;
  dispatchId: number;
  /** The recorded re-pull a resume or a finish continues; null for a first dispatch. */
  repullId: number | null;
  token: string;
  cliVersion: string;
}

/** A dispatch or re-pull id as the payload carries it, within the one bound all three readers share. */
function positiveId(s: string): number | null {
  return DISPATCH_ID_RE.test(s) ? Number(s) : null;
}

/** A dispatch that is not what the Worker sends; the message names the key, never a value. */
function invalid(what: string): ExecuteRefused {
  return new ExecuteRefused(
    "dispatch-invalid",
    `The dispatch's ${what} is not what the Worker sends, so the run does not act on it.`,
  );
}

/**
 * Read a `client_payload`: exactly {@link DISPATCH_PAYLOAD_KEYS} (`repull_id` may be absent), each
 * a string of the shape `buildUpstreamRepullPayload` checks before it sends one. Throws
 * `dispatch-invalid` for anything else.
 */
export function parseDispatchPayload(raw: unknown): DispatchPayload {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw invalid("payload");
  const p = raw as Record<string, unknown>;
  const known = DISPATCH_PAYLOAD_KEYS as readonly string[];
  for (const key of Object.keys(p)) {
    if (!known.includes(key)) throw invalid("set of keys");
  }
  for (const key of DISPATCH_PAYLOAD_KEYS) {
    if (!(key in p)) {
      if (!OPTIONAL_PAYLOAD_KEYS.has(key)) throw invalid("set of keys");
      continue;
    }
    if (typeof p[key] !== "string") throw invalid(key);
  }
  const s = p as Record<string, string | undefined>;
  const mode = s.mode;
  if (mode !== "open" && mode !== "finish") throw invalid("mode");
  const datasetId = s.dataset_id as string;
  if (!/^on\d{6}$/.test(datasetId)) throw invalid("dataset_id");
  const upstreamDs = s.upstream_ds as string;
  if (!/^ds\d{6}$/.test(upstreamDs)) throw invalid("upstream_ds");
  const fromTag = s.from_tag as string;
  const toTag = s.to_tag as string;
  if (!isOpenNeuroTag(fromTag)) throw invalid("from_tag");
  if (!isOpenNeuroTag(toTag)) throw invalid("to_tag");
  if (sameUpstreamTag(fromTag, toTag)) throw invalid("tag pair");
  const dispatchId = positiveId(s.dispatch_id as string);
  if (dispatchId === null) throw invalid("dispatch_id");
  let repullId: number | null = null;
  if (s.repull_id !== undefined) {
    repullId = positiveId(s.repull_id);
    if (repullId === null) throw invalid("repull_id");
  }
  if (mode === "finish" && repullId === null) throw invalid("repull_id");
  const token = s.dispatch_token as string;
  if (!DISPATCH_TOKEN_RE.test(token)) throw invalid("dispatch_token");
  const version = s.cli_version as string;
  if (!NEMAR_VERSION_RE.test(version)) throw invalid("cli_version");
  return {
    mode,
    datasetId,
    upstreamDs,
    fromTag,
    toTag,
    dispatchId,
    repullId,
    token,
    cliVersion: version,
  };
}

/** The most an event file may hold: a dispatch's event is a few kilobytes. */
const MAX_EVENT_BYTES = 1024 * 1024;

/**
 * The dispatch GitHub delivered to this run: the event file `GITHUB_EVENT_PATH` names, which must
 * be a `run-upstream-repull` repository dispatch, and its `client_payload`. No event file at all
 * is the runner's failure (`runner-failed`), not the dispatch's; one that is there and is not a
 * dispatch the Worker sends is `dispatch-invalid`.
 */
export function readDispatchEvent(env: Env): DispatchPayload {
  const path = env.GITHUB_EVENT_PATH;
  const missing = () =>
    new ExecuteRefused(
      "runner-failed",
      "No dispatch event file: the automatic mode runs only inside the run-upstream-repull workflow.",
    );
  if (!path) throw missing();
  let event: unknown;
  try {
    if (statSync(path).size > MAX_EVENT_BYTES) throw invalid("event");
    event = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err instanceof ExecuteRefused) throw err;
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw missing();
    throw invalid("event");
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) throw invalid("event");
  const e = event as Record<string, unknown>;
  if (e.action !== DISPATCH_EVENT) throw invalid("event type");
  return parseDispatchPayload(e.client_payload);
}

// ----------------------------------------------------------------------------
// The output of a run whose log is public
// ----------------------------------------------------------------------------

/**
 * Every line an automatic run prints: `repull-auto: <event>` and `<key>=<value>` pairs of lowercase
 * letters, digits, `.`, `_` and `-`. The grammar is not what keeps a value out of the log: a
 * subject label (`sub-01`), a file name (`readme.md`) or a token in hex has this shape. What keeps
 * them out is that every value is chosen by this code, a count, a status or a word from a closed
 * list, and never taken from the dataset, the plan, a message or the environment; the grammar only
 * refuses what could not be one of those (a slash, a space, an uppercase letter).
 */
export const AUTOMATIC_LINE_RE =
  /^repull-auto: [a-z][a-z0-9-]{0,31}(?: [a-z][a-z0-9_]{0,31}=[a-z0-9_.-]{1,64})*$/;

/** The result line the workflow's backstop reads: the phase, and a code when it ended badly. */
export const RESULT_LINE_RE =
  /^repull-auto: result phase=(planned|opened|finished|refused|failed)(?: code=([a-z0-9-]{1,64}))?$/;

export type LineValue = string | number | boolean;

export interface AutomaticSink {
  /** One line of the fixed grammar on standard output; a value off the grammar is never printed. */
  emit(event: string, fields?: Readonly<Record<string, LineValue>>): void;
  /** A line the libraries meant for an operator: never printed, only counted. */
  drop(line: string): void;
  /** How many writes the run's other output made, every one of them swallowed. */
  dropped(): number;
  /**
   * A terminal report the Worker stored. From then on the run's last result line says what was
   * stored, even when the run crashes after it: the Worker's record of the dispatch stands.
   */
  stored(phase: DispatchPhase, code?: string): void;
  /** How long a step of the run took, in whole seconds, for the quiet line (`<key>_s`). */
  time(key: string, seconds: number): void;
  /** The quiet line's fields: how many writes were swallowed, then each step's seconds. */
  quietFields(): Record<string, LineValue>;
}

const EVENT_RE = /^[a-z][a-z0-9-]{0,31}$/;
const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const VALUE_RE = /^[a-z0-9_.-]{1,64}$/;

/** Render one line of the grammar, or the line that says one could not be (never a raw value). */
export function automaticLine(event: string, fields: Readonly<Record<string, LineValue>> = {}) {
  if (!EVENT_RE.test(event)) return "repull-auto: unprintable-line";
  const parts = [`repull-auto: ${event}`];
  for (const [key, raw] of Object.entries(fields)) {
    const value =
      typeof raw === "boolean"
        ? raw
          ? "yes"
          : "no"
        : typeof raw === "number"
          ? Number.isSafeInteger(raw) && raw >= 0
            ? String(raw)
            : "invalid"
          : raw;
    if (!KEY_RE.test(key) || !VALUE_RE.test(value)) return "repull-auto: unprintable-line";
    parts.push(`${key}=${value}`);
  }
  return parts.join(" ");
}

let installed: AutomaticSink | null = null;

/**
 * Swallow everything the process would print, from here on, but the sink's own lines: `console.*`,
 * both standard streams' `write`, and the runtime's own report of an uncaught exception or an
 * unhandled rejection, which ends the run failed instead. Installed once per process, before the command runs (the
 * entry point does it as soon as it sees {@link AUTOMATIC_FLAG}, so a notice, a warning or a usage
 * error is swallowed too), and never undone: the process is one unattended run.
 */
export function installAutomaticQuiet(): AutomaticSink {
  if (installed) return installed;
  const realWrite = process.stdout.write.bind(process.stdout) as (chunk: string) => boolean;
  let dropped = 0;
  const swallow = ((...args: unknown[]) => {
    dropped++;
    // A writer that waits for its callback must still get it, or it would wait for good.
    const last = args[args.length - 1];
    if (typeof last === "function") queueMicrotask(() => (last as (e: null) => void)(null));
    return true;
  }) as typeof process.stdout.write;
  const silent = () => {
    dropped++;
  };
  for (const method of [
    "log",
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "dir",
    "table",
  ] as const) {
    (console as unknown as Record<string, unknown>)[method] = silent;
  }
  process.stdout.write = swallow;
  process.stderr.write = swallow as typeof process.stderr.write;
  /** The phase of the last result line printed, or null before one. */
  let ended: string | null = null;
  /** The terminal report the Worker stored, or null before one. */
  let reported: { phase: DispatchPhase; code: string | undefined } | null = null;
  const times = new Map<string, number>();
  const quietFields = (): Record<string, LineValue> => {
    const fields: Record<string, LineValue> = { suppressed: dropped };
    for (const [key, seconds] of times) fields[`${key}_s`] = seconds;
    return fields;
  };
  /**
   * The last lines of a run that did not say how it ended: what the Worker stored, when it stored
   * a terminal report (it holds that outcome, and the backstop will not report another), else
   * `failed` with `runner-failed`. Marked ended before the first write, so a log that cannot
   * be written is not tried again on the way out.
   */
  const closingLines = () => {
    const stood = reported;
    ended = stood ? stood.phase : "failed";
    realWrite(`${automaticLine("quiet", quietFields())}\n`);
    if (stood) {
      realWrite(`${automaticLine("report-stands", { phase: stood.phase })}\n`);
      const { phase, code } = stood;
      realWrite(`${automaticLine("result", code === undefined ? { phase } : { phase, code })}\n`);
      return;
    }
    realWrite(`${automaticLine("result", { phase: "failed", code: "runner-failed" })}\n`);
  };
  installed = {
    emit(event, fields) {
      if (event === "result") ended = String(fields?.phase ?? "failed");
      realWrite(`${automaticLine(event, fields)}\n`);
    },
    drop() {
      dropped++;
    },
    dropped: () => dropped,
    stored(phase, code) {
      reported = { phase, code: phase === "refused" || phase === "failed" ? code : undefined };
    },
    time(key, seconds) {
      times.set(key, seconds);
    },
    quietFields,
  };
  // A run that exits before it says how it ended (a usage error, a crash) still ends with a result
  // line, so the workflow's backstop and the person reading the log see how it ended.
  process.on("exit", () => {
    if (ended === null) closingLines();
  });
  // Bun prints an uncaught exception and an unhandled rejection itself, natively, with the message
  // and a source excerpt, which can name a path or a key; a handler of the process's own takes that
  // over. The run ends, with its fixed lines and nothing else, and exits 1 whatever happens while
  // it writes them. Once the Worker stored a terminal report, the last line says what it stored;
  // before that, a run that had said it succeeded says now that it failed, and one that had
  // already said why it failed keeps its word.
  const crashed = () => {
    try {
      dropped++;
      const last = ended;
      const says = reported
        ? last !== reported.phase
        : last === null || last === "planned" || last === "opened" || last === "finished";
      if (says) closingLines();
    } finally {
      process.exit(1);
    }
  };
  process.on("uncaughtException", crashed);
  process.on("unhandledRejection", crashed);
  return installed;
}

/** Whether a command line is an automatic run's (the option, in either of its spellings). */
export function isAutomaticInvocation(argv: readonly string[]): boolean {
  return argv.some((a) => a === AUTOMATIC_FLAG || a.startsWith(`${AUTOMATIC_FLAG}=`));
}

// ----------------------------------------------------------------------------
// The run's context and the checks before it acts
// ----------------------------------------------------------------------------

/** What every command of an automatic run shares. */
export interface AutomaticContext {
  dispatch: DispatchPayload;
  /** This run's page in the central workflow repository, when it is one; reported with it. */
  runUrl: string | null;
  /** Where a stored terminal report leaves its mark for the workflow's backstop, when on a runner. */
  marker: string | null;
  sink: AutomaticSink;
}

/**
 * The run's page: only a run of the central workflow repository on github.com, whose id is a
 * number, which is the one URL the Worker's callback takes.
 */
export function runUrlOf(env: Env): string | null {
  const id = env.GITHUB_RUN_ID ?? "";
  if (
    env.GITHUB_SERVER_URL === "https://github.com" &&
    env.GITHUB_REPOSITORY === "nemarDatasets/.github" &&
    /^[0-9]{1,20}$/.test(id)
  ) {
    return `https://github.com/nemarDatasets/.github/actions/runs/${id}`;
  }
  return null;
}

/**
 * The dispatch an `--automatic-dispatch <id>` run acts on: the event's, which must be the one the
 * option names. Throws `dispatch-invalid` or `dispatch-mismatch`, which a run cannot report, since
 * nothing then says which dispatch it was handed.
 */
export function automaticContext(option: string, env: Env, sink: AutomaticSink): AutomaticContext {
  const id = positiveId(option);
  if (id === null) throw invalid("id on the command line");
  const dispatch = readDispatchEvent(env);
  if (dispatch.dispatchId !== id) {
    throw new ExecuteRefused(
      "dispatch-mismatch",
      "The dispatch named on the command line is not the one the event delivered.",
    );
  }
  const temp = env.RUNNER_TEMP;
  return {
    dispatch,
    runUrl: runUrlOf(env),
    marker: temp ? join(temp, "repull-reported") : null,
    sink,
  };
}

/** NEMAR's production API, the one an automatic run reports to and records through. */
export const PRODUCTION_API = "https://api.nemar.org";

/**
 * Whether an automatic run may send its dispatch token and its NEMAR key to `url`: the production
 * API exactly, or a loopback address (the suites' in-process API). A `TEST_API_URL` or a stored
 * `apiUrl` that names anything else would carry both elsewhere, so the run refuses it before it
 * sends anything (`auto-api-not-production`), and does not report: the report would go there too.
 */
export function isAutomaticApi(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) {
    return false;
  }
  if (u.protocol === "https:") return u.host === new URL(PRODUCTION_API).host;
  return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
}

/**
 * The dispatch token on the command line, where the public log shows it. Checked before anything
 * else that may refuse, and reported first, because the report ends the dispatch and so the token.
 */
export function tokenOnArgvRefusal(
  d: DispatchPayload,
  argv: readonly string[],
): ExecuteRefused | null {
  if (!argv.some((a) => a.includes(d.token))) return null;
  return new ExecuteRefused(
    "auto-token-on-argv",
    "The dispatch token is on the command line, where the public log shows it.",
  );
}

/** What a command checks the dispatch and its own process against before it acts. */
export interface AutomaticCheck {
  /** The kind of run the command is: `plan` and `execute` open, `resume` finishes. */
  mode: "open" | "finish";
  /** The dataset the command was given. */
  datasetId: string;
  argv: readonly string[];
  env: Env;
  /** The CLI's own version and whether it is a development build; the process's by default. */
  ownVersion?: string;
  devBuild?: boolean;
  /** Whether output that prints what the run reads is on; `--verbose` and `--debug` by default. */
  verbose?: boolean;
  /** The clock, in milliseconds; `Date.now()` by default. */
  nowMs?: number;
}

/**
 * The first reason this process may not act on the dispatch, or null. Each is reported as a
 * refusal, in this order: the token on the command line (reported first, because the report ends
 * the dispatch and so the token); a CLI that is not the release the dispatch names; output that
 * would print what the run reads; a command of the other kind or for another dataset; and no App
 * token.
 */
export function automaticRefusal(d: DispatchPayload, c: AutomaticCheck): ExecuteRefused | null {
  const onArgv = tokenOnArgvRefusal(d, c.argv);
  if (onArgv) return onArgv;
  const own = c.ownVersion ?? cliVersion;
  if ((c.devBuild ?? IS_DEV_BUILD) || !NEMAR_VERSION_RE.test(own) || own !== d.cliVersion) {
    return new ExecuteRefused(
      "auto-cli-version",
      "This CLI is not the release the dispatch names: an automatic run uses only that release.",
    );
  }
  const verbose =
    c.verbose ??
    (isVerbose() || isDebugEnabled() || c.argv.includes("--verbose") || c.argv.includes("--debug"));
  if (verbose) {
    return new ExecuteRefused(
      "auto-verbose",
      "Verbose or debug output is on, and it prints what the run reads; an automatic run takes neither.",
    );
  }
  if (d.mode !== c.mode || d.datasetId !== c.datasetId) {
    return new ExecuteRefused(
      "dispatch-mismatch",
      "The command is not the one the dispatch asks for: another kind of run, or another dataset.",
    );
  }
  if (!c.env.GH_TOKEN?.trim()) {
    return new ExecuteRefused(
      "auto-no-app-token",
      "GH_TOKEN is not set: an automatic run pushes and opens its pull request with the App token minted for this dataset.",
    );
  }
  if (tokenSinceOf(c.env, c.nowMs ?? Date.now()) === null) {
    return new ExecuteRefused(
      "auto-token-clock",
      `${TOKEN_SINCE_ENV} does not say when the App token was minted, so the run cannot keep its pushes inside the token's hour.`,
    );
  }
  return null;
}

/** Where the workflow notes, in epoch seconds, the moment it mints the App token. */
export const TOKEN_SINCE_ENV = "NEMAR_REPULL_TOKEN_SINCE";

/**
 * When the App token was minted, in epoch seconds, from {@link TOKEN_SINCE_ENV}; null when it is not
 * a whole number of seconds or lies more than five minutes ahead of this clock (a clock the run
 * cannot trust keeps nothing inside the hour).
 */
export function tokenSinceOf(env: Env, nowMs: number): number | null {
  const raw = env[TOKEN_SINCE_ENV]?.trim() ?? "";
  if (!/^[1-9][0-9]{0,11}$/.test(raw)) return null;
  const since = Number(raw);
  return since * 1000 <= nowMs + 5 * 60_000 ? since : null;
}

/** How much of the App token's usable hour is left at `nowMs`, in milliseconds (negative past it). */
export function tokenHourLeftMs(sinceSeconds: number, nowMs: number): number {
  return (sinceSeconds + APP_TOKEN_USABLE_SECONDS) * 1000 - nowMs;
}

/**
 * Refuse a step whose work, with what must follow it before the settle ends, would pass the App
 * token's usable hour (`auto-token-hour`): checked before the copy and before each push, so a run
 * that cannot finish inside the hour stops before it writes what it could not complete, never half
 * way through a push. `workSeconds` is the step's own estimate (the copy's, or none).
 */
export function tokenHourRefusal(
  sinceSeconds: number,
  nowMs: number,
  workSeconds: number,
): ExecuteRefused | null {
  const needMs = (workSeconds + AUTO_AFTER_COPY_SECONDS + AUTO_SETTLE_RESERVE_SECONDS) * 1000;
  if (tokenHourLeftMs(sinceSeconds, nowMs) >= needMs) return null;
  return new ExecuteRefused(
    "auto-token-hour",
    "What is left to do would pass the App token's usable hour, so the run stops before this step; the record, if there is one, stays where it stopped.",
  );
}

/** The copy's own estimate, from the plan's counts: its bytes and objects (the uploads are done). */
export function planCopySeconds(body: PlanBody): number {
  const counts = planCounts(body);
  return automaticCopySeconds({ bytes: counts.copy_bytes ?? 0, objects: counts.copy_items ?? 0 });
}

/** An option the automatic mode does not take, or one it needs that is missing. */
export function optionRefused(option: string, why: "not-taken" | "required"): ExecuteRefused {
  return new ExecuteRefused(
    "auto-option",
    why === "required"
      ? `An automatic run needs ${option}.`
      : `An automatic run does not take ${option}.`,
  );
}

// ----------------------------------------------------------------------------
// The plan the automatic path takes
// ----------------------------------------------------------------------------

/** A plan this run's planner made: its body, and whether it is executable. */
export interface LivePlan {
  executable: boolean;
  body: PlanBody;
}

/**
 * `plan`'s check of the plan it just made: executable, then {@link assertAutomaticCounts}. `execute`
 * asks the counts again of the proved body; the file's `executable` it never reads, and the plan
 * step's handoff stands for it.
 */
export function assertAutomaticPlan(live: LivePlan): void {
  if (!live.executable) {
    throw new ExecuteRefused("not-executable", "The plan is not executable.");
  }
  assertAutomaticCounts(live.body);
}

/**
 * A plan body's counts as the automatic path takes them: the shared rule the Worker also asks at
 * the automatic create (`automaticPlanRefusal`), then what only a run can check, that every key's
 * size is known and the copy fits the App token's hour. `plan` asks it of the plan it made, and
 * `execute` of that plan's proved body, a record past `prepared` included.
 */
export function assertAutomaticCounts(body: PlanBody): void {
  const counts = planCounts(body);
  const refused = automaticPlanRefusal(body.planner, counts);
  if (refused) throw new ExecuteRefused(refused.code, refused.message);
  if (counts.copy_bytes_unknown !== 0) {
    throw new ExecuteRefused(
      "auto-copy-too-large",
      "An automatic re-pull takes only a plan whose copy size is known for every key.",
    );
  }
  // The copy runs inside the App token's hour: what it and the uploads of the preparation would take,
  // by the estimate, must fit the budget. A count left out is unknown, never zero.
  const bytes = counts.copy_bytes;
  const objects = counts.copy_items;
  const localBytes = counts.local_bytes;
  const localObjects = counts.local_uploads;
  const budget = copyBudgetSeconds();
  if (
    bytes === undefined ||
    objects === undefined ||
    localBytes === undefined ||
    localObjects === undefined ||
    counts.local_bytes_unknown !== 0 ||
    automaticCopySeconds({ bytes: bytes + localBytes, objects: objects + localObjects }) > budget
  ) {
    throw new ExecuteRefused(
      "auto-copy-too-long",
      `An automatic re-pull takes only a plan whose copy, by its known size and count, fits ${Math.floor(budget / 60)} minutes: the App token that pushes it lasts an hour.`,
    );
  }
}

/**
 * Beside the plan file the automatic `plan` writes: its scratch clones and the bytes it computed
 * (`computed/<blob id>`), which the `execute` of the same run prepares from, so the run plans once.
 */
export function planHandoffDir(planPath: string): string {
  return `${planPath}.planner`;
}

/**
 * Keep the planner's `workdir`, its `computed` bytes and the `digest` of the plan they belong to
 * beside `planPath`, for a plan the plan step took (executable, and one the automatic path takes).
 * Everything is written inside `workdir` first and the whole is renamed into place last, so a
 * handoff is complete or absent.
 */
export function keepPlanHandoff(
  planPath: string,
  workdir: string,
  computed: ReadonlyMap<string, Buffer>,
  digest: string,
): void {
  mkdirSync(join(workdir, "computed"), { mode: 0o700 });
  for (const [oid, bytes] of computed) {
    writeFileSync(join(workdir, "computed", oid), bytes, { mode: 0o600 });
  }
  writeFileSync(join(workdir, "digest"), `${digest}\n`, { mode: 0o600 });
  const dir = planHandoffDir(planPath);
  rmSync(dir, { recursive: true, force: true });
  renameSync(workdir, dir);
}

/**
 * What {@link keepPlanHandoff} kept beside `planPath` for the plan of `digest`; `not-planned` when
 * the clones or the computed bytes are not there, or the handoff is another plan's. The preparation
 * proves each computed blob by its git id.
 */
export function readPlanHandoff(
  planPath: string,
  digest: string,
): {
  workdir: string;
  computed: Map<string, Buffer>;
} {
  const dir = planHandoffDir(planPath);
  const bytesDir = join(dir, "computed");
  const digestFile = join(dir, "digest");
  if (
    !existsSync(join(dir, "upstream.git")) ||
    !existsSync(bytesDir) ||
    !existsSync(digestFile) ||
    readFileSync(digestFile, "utf8").trim() !== digest
  ) {
    throw new ExecuteRefused(
      "not-planned",
      "No handoff of this plan's own plan step is beside the plan file; an automatic execute plans nothing itself.",
    );
  }
  const computed = new Map<string, Buffer>();
  for (const oid of readdirSync(bytesDir)) computed.set(oid, readFileSync(join(bytesDir, oid)));
  return { workdir: dir, computed };
}

/**
 * The copy's time budget: {@link AUTO_COPY_BUDGET_SECONDS}, or less when
 * `NEMAR_REPULL_COPY_BUDGET_SECONDS` names fewer (the suites shorten it to reach the refusal with a
 * small fixture). A value that would lengthen it, or that is not a whole number, is ignored, so the
 * override can only refuse more.
 */
export function copyBudgetSeconds(env: Env = process.env): number {
  const raw = env.NEMAR_REPULL_COPY_BUDGET_SECONDS?.trim() ?? "";
  const n = /^\d{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n < AUTO_COPY_BUDGET_SECONDS ? n : AUTO_COPY_BUDGET_SECONDS;
}

/**
 * Whether GitHub no longer takes the App token the run was given: `GET /repos/nemarDatasets/<id>`
 * with it answers 401. Asked only after a run failed or refused, because an installation token lasts
 * an hour and a run that outlives it fails at its next push or pull-request call with whatever word
 * that step has for it; the run then reports `token-expired`, which only a new run's token can carry
 * on from. Any other answer, or none, is not taken as expiry.
 */
export async function appTokenRefused(
  datasetId: string,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const token = env.GH_TOKEN?.trim();
  if (!token) return false;
  let base: string;
  try {
    base = githubApiBase(env);
  } catch {
    return false;
  }
  try {
    const res = await fetchImpl(`${base}/repos/nemarDatasets/${datasetId}`, {
      // The token goes to GitHub's API and nowhere else: a redirect is refused, never followed.
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "nemar-cli",
      },
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.status === 401;
  } catch {
    return false;
  }
}

/**
 * A word for a report: the refusal's own when the closed list holds it, else the class of the step
 * that met it (`scrub-failed` for a scrub's refusal in the preparation), `no-code` with no step.
 */
export function dispatchCodeOf(word: string | undefined, step?: RunStep): DispatchCode {
  if (isDispatchCode(word)) return word;
  if (step === undefined) return "no-code";
  if (step === "prepare" && (IMPORT_SCRUB_REFUSALS as readonly string[]).includes(word ?? "")) {
    return "scrub-failed";
  }
  return STEP_CLASSES[step];
}

// ----------------------------------------------------------------------------
// The reports
// ----------------------------------------------------------------------------

export type ReportAnswer = { stored: true } | { stored: false; code: DispatchCode };

export interface ReportOptions {
  fetchImpl?: typeof fetch;
  /** Tests only: the API's address; the CLI's own (`getApiUrl`) by default. */
  apiUrl?: string;
  /** Attempts for an answer that was lost or a 5xx; a refusal (4xx) is never tried again. */
  attempts?: number;
  timeoutMs?: number;
  backoffMs?: number;
}

const REPORT_TIMEOUT_MS = 15_000;
const TERMINAL: readonly DispatchPhase[] = ["opened", "finished", "refused", "failed"];

/**
 * Report on the dispatch at `POST /webhooks/repull-state`, with its token in `X-Repull-Token`.
 * Never throws and never reads the Worker's sentence: the answer is stored or the Worker's closed
 * word (`report-unanswered` when none came). A terminal report that was stored leaves the marker
 * for the workflow's backstop.
 */
export async function reportDispatch(
  ctx: AutomaticContext,
  phase: DispatchPhase,
  extra: { code?: string; repullId?: number } = {},
  opts: ReportOptions = {},
): Promise<ReportAnswer> {
  const body: Record<string, unknown> = {
    dispatch_id: ctx.dispatch.dispatchId,
    dataset_id: ctx.dispatch.datasetId,
    phase,
  };
  if (phase === "refused" || phase === "failed") body.code = dispatchCodeOf(extra.code);
  if (phase === "opened") body.repull_id = extra.repullId;
  if (ctx.runUrl) body.workflow_run_url = ctx.runUrl;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiUrl = opts.apiUrl ?? getApiUrl();
  const attempts = Math.max(1, opts.attempts ?? 3);
  let answer: ReportAnswer = { stored: false, code: "report-unanswered" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let status: number;
    let word: unknown;
    try {
      const res = await fetchImpl(`${apiUrl}/webhooks/repull-state`, {
        method: "POST",
        // The dispatch token goes to the API and nowhere else: a redirect is refused, never followed.
        redirect: "error",
        headers: { "Content-Type": "application/json", "X-Repull-Token": ctx.dispatch.token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? REPORT_TIMEOUT_MS),
      });
      status = res.status;
      word = ((await res.json().catch(() => null)) as { code?: unknown } | null)?.code;
    } catch {
      answer = { stored: false, code: "report-unanswered" };
      if (attempt < attempts) await sleep(opts.backoffMs ?? 2_000);
      continue;
    }
    if (status === 200) {
      answer = { stored: true };
      break;
    }
    answer = {
      stored: false,
      code: typeof word === "string" && isDispatchCode(word) ? word : "report-unanswered",
    };
    if (status < 500) break;
    if (attempt < attempts) await sleep(opts.backoffMs ?? 2_000);
  }
  ctx.sink.emit("report", {
    phase,
    answer: answer.stored ? "stored" : answer.code,
  });
  if (answer.stored && TERMINAL.includes(phase)) ctx.sink.stored(phase, body.code as string);
  if (answer.stored && TERMINAL.includes(phase) && ctx.marker) {
    try {
      writeFileSync(ctx.marker, `${phase}\n`, { mode: 0o600 });
    } catch {
      // The backstop then reports the run again, which the Worker refuses: the dispatch ended.
    }
  }
  return answer;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
