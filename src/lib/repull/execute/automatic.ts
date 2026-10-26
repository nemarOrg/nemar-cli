/**
 * The unattended run of an automatic re-pull (ADR 0111, decision 6; epic #1046 phase 7, #1913).
 *
 * The Worker claims a dispatch and sends it to the central `run-upstream-repull` workflow, whose
 * job runs `nemar admin repull plan`, `execute` or `resume` with `--automatic-dispatch <id>`. This
 * module is what those three share: the dispatch the run was handed, read and checked; the output
 * rule of a run whose log is public; the check of the live plan the automatic path takes; and the
 * run's reports to the Worker.
 *
 * THE DISPATCH. The run reads the dispatch from the event GitHub delivered (`GITHUB_EVENT_PATH`),
 * the `client_payload` the Worker built with `buildUpstreamRepullPayload`: exactly its nine keys,
 * `repull_id` absent on a first dispatch, each a string of the shape the Worker sends. Anything
 * else (a tenth key, a key missing, a value of another shape) is `dispatch-invalid`, and nothing
 * is reported, because nothing in such a payload can be trusted to name the dispatch. The token
 * is read from the event file and nowhere else: it is in no environment variable and no argument,
 * and one found on the command line ends the dispatch (`auto-token-on-argv`), since a token in a
 * `run:` line is in the public log and lets anyone end a live dispatch as failed.
 *
 * PRODUCTION ONLY. The CLI must be a release (`X.Y.Z`, not a development build) and the very
 * version the dispatch names (`auto-cli-version`); the Worker that signed the dispatch refuses an
 * automatic create outside exact production on its own. `GH_TOKEN` must be set: it is the App
 * token the workflow minted for this dataset's repository alone (`auto-no-app-token`).
 *
 * THE LOG IS PUBLIC. A path can itself be an identifier, and a key or a file name can carry one,
 * so in automatic mode nothing reaches standard output or standard error but this module's own
 * lines, `repull-auto: <event> <key>=<value> ...`, whose values are counts and fixed words
 * ({@link AUTOMATIC_LINE_RE}). Every other write of the process, the libraries' progress lines,
 * their warnings and any error, is swallowed and counted ({@link installAutomaticQuiet}).
 * Subprocesses print nothing either: every git, git-annex and aws child runs with its output
 * piped (`git-annex/run-command.ts`), and it reaches the console only under `--verbose`, which the
 * automatic mode refuses (`auto-verbose`) together with `--debug`. The run's last line is its
 * result, `repull-auto: result phase=<phase>[ code=<code>]`, which the workflow's backstop reads.
 *
 * THE REPORTS. `POST /webhooks/repull-state` with the dispatch token: `started` once, by the run's
 * first command, then `opened`, `finished`, `refused` or `failed`. A code is a word from
 * `DISPATCH_CODES`; a refusal whose word the list does not hold is reported as `no-code`. A
 * terminal report the Worker stored leaves `$RUNNER_TEMP/repull-reported`, so the backstop does not
 * report the run again.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isOpenNeuroTag, sameUpstreamTag } from "../../../../shared/openneuro-tag.js";
import {
  AUTO_MAX_COPY_BYTES,
  CURRENT_PLANNER_VERSION,
  DISPATCH_TOKEN_RE,
  type DispatchCode,
  type DispatchPhase,
  NEMAR_VERSION_RE,
  isDispatchCode,
} from "../../../../shared/repull-state.js";
import { IS_DEV_BUILD, getApiUrl } from "../../api/client.js";
import { isDebugEnabled } from "../../debug-log.js";
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

const POSITIVE_ID = /^[1-9][0-9]{0,15}$/;

function positiveId(s: string): number | null {
  if (!POSITIVE_ID.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
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
 * be a `run-upstream-repull` repository dispatch, and its `client_payload`.
 */
export function readDispatchEvent(env: Env): DispatchPayload {
  const path = env.GITHUB_EVENT_PATH;
  if (!path) {
    throw new ExecuteRefused(
      "dispatch-invalid",
      "GITHUB_EVENT_PATH is not set: the automatic mode runs only inside the run-upstream-repull workflow.",
    );
  }
  let event: unknown;
  try {
    if (statSync(path).size > MAX_EVENT_BYTES) throw invalid("event");
    event = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err instanceof ExecuteRefused) throw err;
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
 * Every line an automatic run prints: `repull-auto: <event>` and `<key>=<value>` pairs whose
 * values are counts and fixed words (lowercase letters, digits, `.`, `_`, `-`). No path, key, file
 * name, subject label, message or token can have this shape and the meaning of one.
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
 * Swallow everything the process would print, from here on, but the sink's own lines: `console.*`
 * and both standard streams' `write`. Installed once per process, before the command runs (the
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
  let ended = false;
  installed = {
    emit(event, fields) {
      if (event === "result") ended = true;
      realWrite(`${automaticLine(event, fields)}\n`);
    },
    drop() {
      dropped++;
    },
    dropped: () => dropped,
  };
  // A run that exits before it says how it ended (a usage error, a crash) still ends with a result
  // line, so the workflow's backstop and the person reading the log see it failed.
  process.on("exit", () => {
    if (ended) return;
    realWrite(`${automaticLine("quiet", { suppressed: dropped })}\n`);
    realWrite(`${automaticLine("result", { phase: "failed", code: "runner-failed" })}\n`);
  });
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
}

/**
 * The first reason this process may not act on the dispatch, or null. Each is reported as a
 * refusal, in this order: the token on the command line (reported first, because the report ends
 * the dispatch and so the token); a CLI that is not the release the dispatch names; output that
 * would print what the run reads; a command of the other kind or for another dataset; and no App
 * token.
 */
export function automaticRefusal(d: DispatchPayload, c: AutomaticCheck): ExecuteRefused | null {
  if (c.argv.some((a) => a.includes(d.token))) {
    return new ExecuteRefused(
      "auto-token-on-argv",
      "The dispatch token is on the command line, where the public log shows it.",
    );
  }
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
  return null;
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

/** The live plan, as the planner made it in this run: its body, and whether it is executable. */
export interface LivePlan {
  executable: boolean;
  body: PlanBody;
}

/**
 * Refuse a plan the automatic path does not take (ADR 0111, decision 6: "the automatic path takes
 * only a plan with zero unexplained paths"), from the LIVE plan this run made and never from a
 * file's own fields: executable; made by the planner the automatic create takes
 * (`auto-planner-version`); `unexplained`, `conflicts` and `corrections` each stated and zero, a
 * count left out being unknown and never zero (`auto-not-clean-plan`); and a copy whose size is
 * known, every key of it, and at most {@link AUTO_MAX_COPY_BYTES} (`auto-copy-too-large`). The
 * Worker checks the same counts at the automatic create, from what the plan states.
 */
export function assertAutomaticPlan(live: LivePlan): void {
  if (!live.executable) {
    throw new ExecuteRefused("not-executable", "The live plan is not executable.");
  }
  assertAutomaticCounts(live.body);
}

/**
 * The counts {@link assertAutomaticPlan} reads, of a plan body. On its own only where no live plan
 * can be made: a record past `prepared` that a run takes up, whose registration moved the git-annex
 * branch the planner reads (the record itself was made by an automatic create, which checked them).
 */
export function assertAutomaticCounts(body: PlanBody): void {
  if (body.planner !== CURRENT_PLANNER_VERSION) {
    throw new ExecuteRefused(
      "auto-planner-version",
      `An automatic re-pull takes only a plan of planner ${CURRENT_PLANNER_VERSION}.`,
    );
  }
  const counts = planCounts(body);
  if (["unexplained", "conflicts", "corrections"].some((k) => counts[k] !== 0)) {
    throw new ExecuteRefused(
      "auto-not-clean-plan",
      "An automatic re-pull takes only a plan with zero unexplained paths, zero conflicts and zero corrections.",
    );
  }
  const bytes = counts.copy_bytes;
  if (counts.copy_bytes_unknown !== 0 || bytes === undefined || bytes > AUTO_MAX_COPY_BYTES) {
    throw new ExecuteRefused(
      "auto-copy-too-large",
      `An automatic re-pull takes only a plan whose copy size is known and at most ${AUTO_MAX_COPY_BYTES} bytes.`,
    );
  }
}

/** A word for a report: the refusal's own when the closed list holds it, `no-code` otherwise. */
export function dispatchCodeOf(word: string | undefined): DispatchCode {
  return isDispatchCode(word) ? word : "no-code";
}

// ----------------------------------------------------------------------------
// The reports
// ----------------------------------------------------------------------------

export type ReportAnswer = { stored: true } | { stored: false; code: DispatchCode };

export interface ReportOptions {
  fetchImpl?: typeof fetch;
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
  const attempts = Math.max(1, opts.attempts ?? 3);
  let answer: ReportAnswer = { stored: false, code: "report-unanswered" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let status: number;
    let word: unknown;
    try {
      const res = await fetchImpl(`${getApiUrl()}/webhooks/repull-state`, {
        method: "POST",
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
