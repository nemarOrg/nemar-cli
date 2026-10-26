/**
 * `--automatic-dispatch <id>` on `nemar admin repull plan`, `execute` and `resume`: the unattended
 * run of one dispatch, as the central `run-upstream-repull` workflow runs it (ADR 0111, decision 6;
 * the Phase 7d amendment). The rules are `lib/repull/execute/automatic.ts`'s; this is where the three
 * commands apply them.
 *
 *   plan     reports `started`; plans from live sources with a bucket listing; writes the plan
 *            file, which never leaves the runner, and says only counts; then refuses a plan that is
 *            not executable or that the automatic path does not take (`refused`, exit 3, no record
 *            written), or reports one that could not be made (exit 1).
 *   execute  runs the plan through its pull request exactly as an administrator's run does, with
 *            the dispatch presented at the create and the LIVE plan checked before any write;
 *            settles the release head; reports `opened`.
 *   resume   (a finish) reports `started`; takes up only the automatic re-pull its dispatch names,
 *            and only past its merge; walks it to `complete`; reports `finished`.
 *
 * Each ends with one result line and reports `refused` (nothing written, exit 1, or a plan the
 * path does not take, exit 3) or `failed` (a step after the record exists, or a release branch the
 * settle could not read, exit 3; a head enrichment did not make, exit 1) with a word from the closed
 * list, `token-expired` when GitHub no longer takes the App token, whatever the step called it:
 * `refused` once an open run wrote its record, which ends the automatic path for that tag, and
 * `failed` before. Every command keeps inside the App token's usable hour, from when the workflow
 * noted its mint (`NEMAR_REPULL_TOKEN_SINCE`): the plan, and the execute before its record, the copy
 * and each push, refuse `auto-token-hour` when what is left would not fit. The quiet line says how
 * long the token was held when the command started and how long each step took, in seconds.
 */

import { readFileSync } from "node:fs";
import { sameUpstreamTag } from "../../shared/openneuro-tag.js";
import { DISPATCH_ID_RE } from "../../shared/repull-state.js";
import { getApiUrl } from "../lib/api/client.js";
import { ApiError } from "../lib/api/errors.js";
import { getConfigDir, isAuthenticated } from "../lib/config.js";
import { markReportedExit } from "../lib/debug-log.js";
import { githubApiBase } from "../lib/pr-review-approve.js";
import {
  type PlanFile,
  defaultPlanPath,
  readPlanFile,
  writePlanFile,
} from "../lib/repull/digest.js";
import {
  type AutomaticContext,
  type AutomaticSink,
  type LineValue,
  appTokenRefused,
  assertAutomaticPlan,
  automaticContext,
  automaticRefusal,
  dispatchCodeOf,
  installAutomaticQuiet,
  isAutomaticApi,
  optionRefused,
  planCopySeconds,
  reportDispatch,
  tokenHourRefusal,
  tokenOnArgvRefusal,
  tokenSinceOf,
} from "../lib/repull/execute/automatic.js";
import { planCounts, planFacts } from "../lib/repull/execute/body.js";
import { readCatalogFacts } from "../lib/repull/execute/catalog.js";
import { type MeasuredStep, executeRepull } from "../lib/repull/execute/run.js";
import {
  SETTLE_DEFAULT_MINUTES,
  SETTLE_POLL_MS,
  SETTLE_QUIET_MS,
} from "../lib/repull/execute/settle.js";
import { ExecuteRefused, assertNotAnonymous, peekPlan } from "../lib/repull/execute/verify-plan.js";
import { RepullCannotPlan, planRepull } from "../lib/repull/plan.js";
import { resumeRepull } from "../lib/repull/resume.js";
import { openNeuroGraphqlUrl } from "../lib/repull/sources.js";

/** What every command that takes --automatic-dispatch says about it in its help. */
export const AUTOMATIC_HELP = `--automatic-dispatch <id> is the central run-upstream-repull workflow's, never an
administrator's: the run reads its dispatch from the event file GitHub delivered, reports to the
Worker with the dispatch's token, and prints only fixed lines (repull-auto: ...) because its log
is public. It refuses anything but the release the dispatch names, and needs GH_TOKEN.`;

/** How a run ended: what it reports, and the command's exit code. */
type Outcome =
  | { phase: "planned" }
  | { phase: "opened"; repullId: number }
  | { phase: "finished" }
  | { phase: "refused" | "failed"; code: string; exit: 1 | 3 };

/** The polling interval a test may shorten (`NEMAR_REPULL_POLL_MS`, as `resume` reads it). */
function pollMs(fallback: number): number {
  const raw = process.env.NEMAR_REPULL_POLL_MS;
  return raw && /^\d+$/.test(raw) ? Math.max(100, Number(raw)) : fallback;
}

/** A refusal or a failure as the run's outcome. */
function outcomeOf(err: unknown): Outcome {
  if (err instanceof ExecuteRefused) {
    return err.resumable
      ? { phase: "failed", code: err.code, exit: 3 }
      : { phase: "refused", code: err.code, exit: 1 };
  }
  return { phase: "failed", code: "runner-failed", exit: 1 };
}

interface Spec {
  command: "plan" | "execute" | "resume";
  mode: "open" | "finish";
  option: string;
  /** The dataset the command was given (for `execute`, the plan file's); may refuse. */
  datasetOf(): string;
  /** Whether this command is the run's first, which reports `started`. */
  reportsStart: boolean;
  body(ctx: AutomaticContext): Promise<Outcome>;
}

/**
 * Words the token probe never replaces with `token-expired`: the token on the command line, whose
 * report is what kills the token, so it goes first and as itself; the token hour's own refusals,
 * which say already why the run stopped; and a settle's outcome, a fact about a pull request that is
 * open whatever the token's state.
 */
const NOT_PROBED: ReadonlySet<string> = new Set([
  "auto-token-on-argv",
  "auto-token-hour",
  "auto-token-clock",
  "head-unreadable",
  "head-foreign",
]);

/** Whole seconds since `startedMs`. */
const secondsSince = (startedMs: number) =>
  Math.max(0, Math.round((Date.now() - startedMs) / 1000));

/**
 * When the App token was minted, as the workflow noted it. `automaticRefusal` has refused a run
 * without it (`auto-token-clock`) before any command's body runs, so this only restates that.
 */
function tokenSince(): number {
  const since = tokenSinceOf(process.env, Date.now());
  if (since === null) {
    throw new ExecuteRefused("auto-token-clock", "When the App token was minted is not known.");
  }
  return since;
}

/** The result line and the exit code; the last thing a run prints. */
function end(sink: AutomaticSink, outcome: Outcome, startedMs: number): void {
  sink.time("run", secondsSince(startedMs));
  sink.emit("quiet", sink.quietFields());
  if (outcome.phase === "refused" || outcome.phase === "failed") {
    sink.emit("result", { phase: outcome.phase, code: dispatchCodeOf(outcome.code) });
    process.exitCode = outcome.exit;
  } else {
    sink.emit("result", { phase: outcome.phase });
    process.exitCode = 0;
  }
  markReportedExit();
}

/** One automatic run of a command; see the module comment. */
async function runAutomatic(spec: Spec): Promise<void> {
  const startedMs = Date.now();
  const sink = installAutomaticQuiet();
  markReportedExit();
  sink.emit("start", {
    command: spec.command,
    ...(DISPATCH_ID_RE.test(spec.option) ? { dispatch: spec.option } : {}),
  });
  // How long the App token was held when this command started: the install and the sign-in for
  // the first command, and the plan as well for the execute.
  const since = tokenSinceOf(process.env, startedMs);
  if (since !== null) sink.time("token_age", Math.max(0, Math.round(startedMs / 1000 - since)));
  let ctx: AutomaticContext;
  try {
    ctx = automaticContext(spec.option, process.env, sink);
  } catch (err) {
    // Nothing names the dispatch, so nothing is reported.
    end(
      sink,
      {
        phase: "failed",
        code: err instanceof ExecuteRefused ? err.code : "runner-failed",
        exit: 1,
      },
      startedMs,
    );
    return;
  }
  // Where the token and the NEMAR key would go: anything but production (or the suites' loopback
  // API) is refused before anything is sent, and not reported, since the report would go there too.
  if (!isAutomaticApi(getApiUrl())) {
    end(sink, { phase: "failed", code: "auto-api-not-production", exit: 1 }, startedMs);
    return;
  }
  let outcome: Outcome;
  try {
    // The token on the command line first, before anything that reads a file can refuse instead:
    // its report is what ends the dispatch, and so the token.
    const onArgv = tokenOnArgvRefusal(ctx.dispatch, process.argv);
    if (onArgv) throw onArgv;
    const refusal = automaticRefusal(ctx.dispatch, {
      mode: spec.mode,
      datasetId: spec.datasetOf(),
      argv: process.argv,
      env: process.env,
    });
    if (refusal) throw refusal;
    if (!isAuthenticated()) {
      throw new ExecuteRefused("runner-failed", "The CLI is not signed in to NEMAR.");
    }
    if (spec.reportsStart) {
      const started = await reportDispatch(ctx, "started");
      // A rerun of the same run finds its dispatch started already, and goes on.
      if (!started.stored && started.code !== "already-started") {
        end(sink, { phase: "failed", code: started.code, exit: 1 }, startedMs);
        return;
      }
    }
    outcome = await spec.body(ctx);
  } catch (err) {
    outcome = outcomeOf(err);
  }
  // A run that outlived its App token fails at its next push or pull-request call, with that step's
  // word: when GitHub no longer takes the token, the report says why, whatever the step called it.
  // Once an open run left its record (a resumable failure), the word is a refusal, final for the
  // tag, and an administrator takes the record on: an aged token is met at the registration or the
  // pull request, after the copy, where no later run can take the record up, and one refused at
  // the preparation's clone ends the path the same way, the safe direction. Before the record, a
  // later run's token may yet be taken.
  if (
    (outcome.phase === "refused" || outcome.phase === "failed") &&
    !NOT_PROBED.has(outcome.code) &&
    (await appTokenRefused(ctx.dispatch.datasetId, process.env))
  ) {
    const recordLeft = spec.mode === "open" && outcome.phase === "failed" && outcome.exit === 3;
    outcome = {
      phase: recordLeft ? "refused" : "failed",
      code: "token-expired",
      exit: outcome.exit,
    };
  }
  if (outcome.phase !== "planned") {
    const answer = await reportDispatch(
      ctx,
      outcome.phase,
      outcome.phase === "opened"
        ? { repullId: outcome.repullId }
        : outcome.phase === "refused" || outcome.phase === "failed"
          ? { code: outcome.code }
          : {},
    );
    // A success the Worker did not store is a failure of the run, which the backstop reports;
    // a refusal or a failure keeps its own word for it.
    if (!answer.stored && (outcome.phase === "opened" || outcome.phase === "finished")) {
      outcome = { phase: "failed", code: answer.code, exit: 1 };
    }
  }
  end(sink, outcome, startedMs);
}

/** The catalog row and its versions, as the plan reads them; an API failure is a refusal. */
async function catalogOf(datasetId: string) {
  try {
    return await readCatalogFacts(datasetId);
  } catch (err) {
    if (err instanceof ApiError) {
      throw new ExecuteRefused("record-refused", "The NEMAR API did not answer for the dataset.");
    }
    throw err;
  }
}

/** The word a plan that is not executable is refused with: a refusal, a key with no pin, a check. */
export function notExecutableCode(file: PlanFile): string {
  const refusals = Array.isArray(file.body.refusals)
    ? (file.body.refusals as Array<{ code?: unknown }>)
    : [];
  const first = refusals.find((r) => typeof r?.code === "string");
  if (first) return first.code as string;
  const copy = file.body.copy as { unpinned?: unknown } | undefined;
  if (Array.isArray(copy?.unpinned) && copy.unpinned.length > 0) return "key-without-pin";
  const check = file.preflight.find((c) => c.status !== "ok");
  return check?.code ?? check?.name ?? "not-executable";
}

/** Refuse each option of `taken` that is set: the automatic mode does not take it. */
function refuseOptions(taken: ReadonlyArray<readonly [string, boolean]>): void {
  for (const [flag, set] of taken) if (set) throw optionRefused(flag, "not-taken");
}

export interface AutomaticPlanOptions {
  toTag?: string;
  fromTag?: string;
  out?: string;
  json?: boolean;
  counts?: boolean;
  keepWorkdir?: boolean;
  maxFetchGb: number;
  bucketListing?: boolean;
}

/** `nemar admin repull plan <id> --automatic-dispatch <n>`. */
export function automaticPlan(
  option: string,
  datasetId: string,
  options: AutomaticPlanOptions,
): Promise<void> {
  return runAutomatic({
    command: "plan",
    mode: "open",
    option,
    datasetOf: () => datasetId,
    reportsStart: true,
    async body(ctx) {
      refuseOptions([
        ["--json", options.json === true],
        ["--counts", options.counts === true],
        ["--keep-workdir", options.keepWorkdir === true],
        ["--from-tag", options.fromTag !== undefined],
      ]);
      if (!options.bucketListing) throw optionRefused("--bucket-listing", "required");
      if (!options.toTag) throw optionRefused("--to-tag", "required");
      if (!sameUpstreamTag(options.toTag, ctx.dispatch.toTag)) {
        throw new ExecuteRefused("dispatch-mismatch", "--to-tag is not the dispatch's tag.");
      }
      const since = tokenSince();
      const catalog = await catalogOf(datasetId);
      assertNotAnonymous(catalog);
      let planned: Awaited<ReturnType<typeof planRepull>>;
      const planStarted = Date.now();
      try {
        planned = await planRepull({
          datasetId,
          toTag: ctx.dispatch.toTag,
          maxFetchBytes: Math.floor(options.maxFetchGb * 1024 ** 3),
          keepWorkdir: false,
          catalog,
          github: { token: process.env.GH_TOKEN?.trim() ?? null, apiBase: githubApiBase() },
          environment: getApiUrl(),
          presence: "bucket-listing",
          openNeuroGraphqlUrl: openNeuroGraphqlUrl(process.env),
        });
      } catch (err) {
        // The remotes could not be read: nothing was planned, and a later run may plan.
        if (err instanceof RepullCannotPlan)
          return { phase: "failed", code: "not-planned", exit: 1 };
        throw err;
      } finally {
        ctx.sink.time("plan", secondsSince(planStarted));
      }
      if (!planned.planned) return { phase: "refused", code: planned.reason, exit: 1 };
      const file = planned.file;
      const facts = planFacts(file.body);
      if (
        facts.ds !== ctx.dispatch.upstreamDs ||
        !sameUpstreamTag(facts.fromTag, ctx.dispatch.fromTag)
      ) {
        return { phase: "refused", code: "dispatch-mismatch", exit: 1 };
      }
      writePlanFile(
        options.out ?? defaultPlanPath(getConfigDir(), datasetId, facts.toTag, file.digest),
        file,
      );
      const counts = planCounts(file.body);
      const fields: Record<string, LineValue> = { executable: file.executable };
      for (const k of ["delta_paths", "copy_items", "unexplained", "conflicts", "corrections"]) {
        if (counts[k] !== undefined) fields[k] = counts[k] as number;
      }
      ctx.sink.emit("plan", fields);
      if (!file.executable) return { phase: "refused", code: notExecutableCode(file), exit: 3 };
      try {
        assertAutomaticPlan(file);
      } catch (err) {
        if (err instanceof ExecuteRefused) return { phase: "refused", code: err.code, exit: 3 };
        throw err;
      }
      // What is left of the App token's hour must hold the copy, the pushes and the settle; the
      // execute checks again, before its record and before each of them.
      const late = tokenHourRefusal(since, Date.now(), planCopySeconds(file.body));
      if (late) return { phase: "refused", code: late.code, exit: 1 };
      return { phase: "planned" };
    },
  });
}

export interface AutomaticExecuteOptions {
  until: string;
  keepWorkdir?: boolean;
  normalizeMaxGb?: number;
  maxFetchGb: number;
  yes?: boolean;
  json?: boolean;
  settleMinutes?: number;
}

/** `nemar admin repull execute <plan> --automatic-dispatch <n>`. */
export function automaticExecute(
  option: string,
  planFile: string,
  options: AutomaticExecuteOptions,
): Promise<void> {
  return runAutomatic({
    command: "execute",
    mode: "open",
    option,
    datasetOf: () => peekPlan(planFile).datasetId,
    reportsStart: false,
    async body(ctx) {
      refuseOptions([
        ["--json", options.json === true],
        ["--keep-workdir", options.keepWorkdir === true],
        ["--until", options.until !== "pr_open"],
      ]);
      if (!options.yes) throw optionRefused("--yes", "required");
      // `datasetOf` read the file already (`peekPlan` proves its digest), so it is readable here.
      const facts = planFacts(readPlanFile(readFileSync(planFile, "utf8")).body);
      if (
        facts.ds !== ctx.dispatch.upstreamDs ||
        !sameUpstreamTag(facts.fromTag, ctx.dispatch.fromTag) ||
        !sameUpstreamTag(facts.toTag, ctx.dispatch.toTag)
      ) {
        throw new ExecuteRefused("dispatch-mismatch", "The plan is not for the dispatch's tags.");
      }
      const result = await executeRepull({
        planPath: planFile,
        until: "pr_open",
        keepWorkdir: false,
        ...(options.normalizeMaxGb !== undefined
          ? { normalizeMaxBytes: Math.floor(options.normalizeMaxGb * 1024 ** 3) }
          : {}),
        maxFetchBytes: Math.floor(options.maxFetchGb * 1024 ** 3),
        automatic: {
          dispatchId: ctx.dispatch.dispatchId,
          token: ctx.dispatch.token,
          repullId: ctx.dispatch.repullId,
          settle: {
            maxWaitMs: (options.settleMinutes ?? SETTLE_DEFAULT_MINUTES) * 60_000,
            quietMs: SETTLE_QUIET_MS,
            pollMs: pollMs(SETTLE_POLL_MS),
          },
          tokenSince: tokenSince(),
          measured: (step: MeasuredStep, seconds: number) => ctx.sink.time(step, seconds),
        },
        out: (line) => ctx.sink.drop(line),
      });
      const row = result.row;
      ctx.sink.emit("execute", { status: row.status, repull: row.id, pr: row.pr_number ?? 0 });
      if (result.settled) {
        const s = result.settled;
        ctx.sink.emit("settle", { reads: s.reads, moves: s.moves, unreadable: s.unreadable });
        if (s.outcome === "foreign") return { phase: "failed", code: "head-foreign", exit: 1 };
        // Nothing was read in the last quiet period, or the token's hour ended the settle first:
        // the pull request stays open and the gates read its head. No automatic run settles it
        // again; an administrator's resume is the only way to.
        if (s.outcome === "unreadable")
          return { phase: "failed", code: "head-unreadable", exit: 3 };
      }
      return { phase: "opened", repullId: row.id };
    },
  });
}

export interface AutomaticResumeOptions {
  waitMinutes: number;
  acknowledgeIdentifierScreen?: string;
  yes?: boolean;
  json?: boolean;
}

/** `nemar admin repull resume <id> --automatic-dispatch <n>`: a finish. */
export function automaticFinish(
  option: string,
  datasetId: string,
  options: AutomaticResumeOptions,
): Promise<void> {
  return runAutomatic({
    command: "resume",
    mode: "finish",
    option,
    datasetOf: () => datasetId,
    reportsStart: true,
    async body(ctx) {
      refuseOptions([
        ["--json", options.json === true],
        ["--acknowledge-identifier-screen", options.acknowledgeIdentifierScreen !== undefined],
      ]);
      if (!options.yes) throw optionRefused("--yes", "required");
      const repullId = ctx.dispatch.repullId as number;
      const result = await resumeRepull({
        datasetId,
        waitMinutes: options.waitMinutes,
        automaticFinish: { repullId },
        out: (line) => ctx.sink.drop(line),
        pollMs: pollMs(15_000),
      });
      ctx.sink.emit("resume", {
        status: result.row?.status ?? "none",
        outcome: result.outcome,
      });
      if (result.outcome === "complete") return { phase: "finished" };
      if (result.outcome === "ended" || result.outcome === "nothing") {
        return { phase: "refused", code: "finish-not-merged", exit: 1 };
      }
      return { phase: "failed", code: "finish-incomplete", exit: 3 };
    },
  });
}
