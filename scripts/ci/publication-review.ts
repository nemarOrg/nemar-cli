#!/usr/bin/env bun
/**
 * The publication review job's script (ADR 0102). Run by the central workflow
 * `run-publication-review.yml` in `nemarDatasets/.github`, after the workflow has claimed the
 * review. This step's environment holds a federated Anthropic identity and the one-shot callback
 * token, and no GitHub credential, and neither does the clone: an earlier step fetched the
 * repository, and with it the blobs this script reads, giving its read-only token to each git
 * command through that command's own environment and writing it nowhere. This script's git calls
 * need nothing from the network and, with lazy fetching off, cannot ask for it, and no git child
 * process inherits any token.
 *
 *   bun run scripts/ci/publication-review.ts review \
 *     --repo-dir DIR --head SHA --fetched-head SHA --tags-file FILE --bids-runs-file FILE \
 *     --review-id N --request-id N --dataset nmNNNNNN --anonymous true|false \
 *     --environment production|dev [--license-scan-dir DIR]
 *
 * **LICENSE is identified by a pinned matcher** (ADR 0142, section 1). `--license-scan-dir` names the
 * directory the workflow's sandboxed ScanCode step wrote (`scripts/ci/license-file-fact.ts` reads
 * it); without it, the identification is `unreadable` (or `absent`, or `annexed`) and the matcher
 * word `unavailable`, and LICENSE is sent as ADR 0102 sends it. The report is version 3: it carries
 * the identification (`evidence.license_file`) and the matcher word (`record.license_matcher`). A
 * conclusive identification sends the model no LICENSE text, or only the text the file adds beyond
 * the license (the whole file when the license's own text is not all there), and the facts block
 * names the identification (`publication-review-evidence.ts`, `licenseDocumentFor`). The script
 * logs one fixed line, `license_file <state>; matcher <word>`, never the SPDX identifier or any text.
 *
 * The callback token comes from the environment (PUBLICATION_REVIEW_CALLBACK_TOKEN), never argv. A
 * job that fails before this script can report is reported by the workflow's own curl step, which
 * needs nothing installed.
 *
 * `calibrate` is the offline calibration run from an operator's machine
 * (`publication-review-calibrate.ts`): the same pre-send, prompt, model call and report assembly
 * over a corpus of published datasets, and it posts nothing.
 *
 * **Nothing in the dispatch is trusted for a decision.** The ref the workflow fetched is GitHub's
 * own record of `main`, and it must be the commit the review was dispatched for before a model is
 * called (`stale_head` otherwise). The callback goes to an origin chosen from a fixed table by the
 * environment's NAME, so a payload cannot steer the report to a host of its choosing. The report
 * echoes the head and the release kind, and the Worker refuses one that does not match its row.
 *
 * **The metadata comes from the Worker.** After the workflow's claim and before anything is
 * examined, the script asks the Worker for the review's widened inputs
 * (`POST /webhooks/publication-review-inputs`, with the same callback token; ADR 0139, decision 6):
 * the enrichment as D1 holds it at review time, the license lineage, the resubmission note, the
 * previous denial's closed reason codes and the screen's coverage counts. A failed call, or any
 * answer but a 200 that parses, is the run error `inputs_unavailable`: the review never runs on
 * part of its inputs. The body is never logged: it is the dataset's metadata.
 *
 * **The model sees only cleared text.** Every document, and every section of the inputs, goes
 * through `publication-review-presend.ts` (`presend`, `presendInputs`), and the prompt builder
 * accepts nothing else (ADR 0102, section 2).
 *
 * **The public log carries no value.** `nemarDatasets/.github` is public, so this prints a review
 * id, a request id and a fixed word, never a dataset's text, an input the Worker served, a finding, a count of findings, the
 * model's output or a token. Every error is reported as a closed word, and only the words a job
 * may post: the Worker's own (`dispatch_failed`, `dispatch_unconfigured`, `review_disabled`) are
 * not in this script's vocabulary.
 *
 * Exits 0 when the callback was delivered (whatever it said), 1 when it could not be, and 2 for
 * bad arguments or a missing callback token.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { CONFIRMING_EFFORT, CONFIRMING_MODEL } from "../../shared/publication-auto-deny";
import {
  PUBLICATION_REVIEW_EFFORT,
  type PublicationReviewReport,
  PublicationReviewReportError,
  type PublicationRunError,
  ReviewInputsError,
  type ReviewerModel,
  type WORKER_ONLY_RUN_ERRORS,
  lineageCredited,
  parseReviewInputs,
} from "../../shared/publication-review";
import {
  type LicenseIdentification,
  type ReadScanOptions,
  identifyLicenseFile,
  licenseFieldOf,
  readScanOutput,
} from "./license-file-fact";
import {
  PublicationEvidenceError,
  SHA40,
  evidenceFromDocuments,
  readRootDocuments,
  readTree,
  structuralSummary,
} from "./publication-review-evidence";
import { presendInputs } from "./publication-review-presend";
import {
  PUBLICATION_OUTPUT_SCHEMA,
  PUBLICATION_REVIEW_MODEL,
  assemblePublicationReport,
  buildPublicationReviewMessages,
  publicationInputDigest,
} from "./publication-review-prompt";

// RunFailure, mapError, describeError, the callback poster, flag and need, and CALLBACK_ORIGINS
// below are copies of the ones in pr-review.ts, on purpose: the live pull-request review stays
// untouched.

/** The API origin for each environment NAME. A payload never supplies a URL. */
export const CALLBACK_ORIGINS = {
  production: "https://api.nemar.org",
  dev: "https://api-test.nemar.org",
} as const;
export type Environment = keyof typeof CALLBACK_ORIGINS;

const DATASET_ID = /^(nm|xx|on)\d{6}$/;

/**
 * Output budget: Haiku 5.5's whole 128,000 tokens. Adaptive thinking at `max` counts toward it, and
 * 64,000 cut a real review off before it answered (2026-11-27). A call this large streams.
 */
export const MAX_TOKENS = 128_000;

/**
 * The confirming run's budget (ADR 0139, decision 1): the same 128,000 tokens as the first run,
 * because both think at `max` and thinking counts toward the budget (64,000 cut a real review off,
 * 2026-11-27). Both stream (the SDK refuses a request this large that does not).
 */
export const CONFIRM_MAX_TOKENS = 128_000;

/**
 * Every call's deadline, the first run's and the confirming run's. It keeps the call inside the
 * workflow's limit with the steps before it (20 minutes, and 28 once the license matcher's steps
 * of ADR 0142 are deployed: 8 more for their own limits); a run that reaches it ends
 * `model_unavailable`, and a confirming run that does not report never confirms anything. A job
 * that still runs past its limit is cancelled, reports `workflow_failed`, and the Worker's
 * 30-minute watchdog is behind that.
 */
export const CONFIRM_DEADLINE_MS = 12 * 60_000;

/** How one call is made: the review's own effort and budget, or the confirming run's. */
export interface ModelCallShape {
  effort: "high" | "max";
  maxTokens: number;
  /** Set for a streamed call: abort it after this long. */
  deadlineMs?: number;
}

/** The review's own call. */
export const REVIEW_CALL: ModelCallShape = {
  effort: PUBLICATION_REVIEW_EFFORT,
  maxTokens: MAX_TOKENS,
  deadlineMs: CONFIRM_DEADLINE_MS,
};

/** The run errors this script may post: everything the Worker does not write itself. */
export type JobRunError = Exclude<PublicationRunError, (typeof WORKER_ONLY_RUN_ERRORS)[number]>;

export type PublicationReviewResult = (
  | { outcome: "reported"; report: PublicationReviewReport }
  | { outcome: "error"; error: JobRunError; diag?: string }
) & {
  /**
   * LICENSE's identification, when the run got as far as reading the root documents. The report
   * carries its fact; the leftover and the `partial` flag stay here, internal to the job.
   */
  licenseFile?: LicenseIdentification;
};

class RunFailure extends Error {
  readonly error: JobRunError;
  constructor(error: JobRunError) {
    super(error);
    this.error = error;
  }
}

export interface ReviewArgs {
  repoDir: string;
  /** The commit the review was dispatched for. */
  head: string;
  /** The commit the workflow fetched as `main`: GitHub's own record. */
  fetchedHead: string;
  /** `git ls-remote --tags` output, one line per ref. */
  tagsFile: string;
  /** The BIDS validation workflow's runs at `head`, or `{"unavailable":true}`. */
  bidsRunsFile: string;
  anonymous: boolean;
  /**
   * Fetch the widened inputs from the Worker (`POST /webhooks/publication-review-inputs`), for this
   * claimed review. Resolves to the body of a 200; anything else rejects, and the review is
   * `inputs_unavailable`.
   */
  fetchInputs: () => Promise<unknown>;
  /** The workflow's license scan directory (ADR 0142), or undefined when the job ran no scan. */
  licenseScanDir?: string;
  /** Tests only: the owners the scan files must have (the job's defaults otherwise). */
  scanOptions?: ReadScanOptions;
  /** Where the fixed log line goes; the job's standard output. */
  log?: (line: string) => void;
}

/**
 * LICENSE's identification for one review. The scan directory is read only for a LICENSE that is
 * text in git and was read in full; its blob id ties the scan to this commit's file.
 */
export function identifyReviewLicense(
  args: Pick<ReviewArgs, "licenseScanDir" | "scanOptions">,
  tree: Awaited<ReturnType<typeof readTree>>,
  docs: ReturnType<typeof readRootDocuments>,
): LicenseIdentification {
  const document = docs.license;
  const entry = tree.entries.find((e) => e.path === "LICENSE");
  const oid = document.state === "present" && entry !== undefined ? entry.oid : null;
  return identifyLicenseFile({
    document: { state: document.state, text: document.text },
    licenseField: licenseFieldOf(docs.dataset_description.text),
    scan:
      args.licenseScanDir === undefined
        ? null
        : readScanOutput(args.licenseScanDir, oid, args.scanOptions),
  });
}

/** Map anything that went wrong to a fixed word. The error's text is never forwarded. */
export function mapError(e: unknown): JobRunError {
  if (e instanceof RunFailure) return e.error;
  if (e instanceof ReviewInputsError) return "inputs_unavailable";
  if (e instanceof PublicationEvidenceError) return "evidence_unavailable";
  // Our own evidence block failing the parser is a bug on this side, not the model's doing.
  if (e instanceof PublicationReviewReportError) {
    return e.code === "bad_evidence" ? "report_invalid" : "model_invalid";
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return "auth_failed";
  }
  // The SDK's federation failures (an identity token it cannot read, an exchange the rule
  // rejects) are plain AnthropicErrors named "Error", not API errors: there is no HTTP response of
  // the messages API yet.
  if (e instanceof Anthropic.AnthropicError && !(e instanceof Anthropic.APIError)) {
    return "auth_failed";
  }
  if (e instanceof Anthropic.BadRequestError) return "model_invalid";
  if (e instanceof Anthropic.APIError) return "model_unavailable";
  return "workflow_failed";
}

/**
 * Why a run failed, in words that are safe in a public log: class names the SDK and this module
 * define, HTTP status numbers, parser codes, and the fixed strings of {@link PublicationEvidenceError}.
 * Never the text of an error that could carry a dataset's content.
 */
export function describeError(e: unknown): string {
  const cls = e instanceof Error ? e.constructor.name : typeof e;
  if (e instanceof Anthropic.APIError) return `${cls} status=${e.status ?? "none"}`;
  if (e instanceof PublicationReviewReportError) return `${cls} code=${e.code}`;
  if (e instanceof PublicationEvidenceError) return `${cls}: ${e.message}`;
  if (e instanceof RunFailure) return `${cls} ${e.error}`;
  return cls;
}

/** What one call to the model cost, in the units the API counts. */
export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * One call to the model: Haiku 5.5 at max effort, streamed, no tools, a schema-constrained answer. The
 * model can read the prompt and write a JSON object; it cannot do anything else. `model` and
 * `onUsage` are for the offline calibration only; the review never passes them. `onUsage` is told
 * the call's token counts as soon as the answer arrives, before the answer is judged, so a call the
 * job then refuses (a refusal, a cut-off answer) still reports what it cost.
 */
export async function callPublicationReviewModel(
  system: string,
  user: string,
  model: ReviewerModel = PUBLICATION_REVIEW_MODEL,
  onUsage?: (usage: ModelUsage) => void,
  shape: ModelCallShape = REVIEW_CALL,
): Promise<unknown> {
  // The documents are bounded in characters, not tokens, and the estimate behind the daily caps
  // assumes four characters to a token. Rare characters can cost more, so an adversarial document
  // may cost more than estimated or exceed the model's input limit; the API's refusal of that is a
  // BadRequestError, which `mapError` turns into `model_invalid` (it fails closed), and the daily
  // caps bound the spend. Accepted.
  // A client given no credentials resolves workload identity federation from the environment
  // (ANTHROPIC_FEDERATION_RULE_ID, _ORGANIZATION_ID, _SERVICE_ACCOUNT_ID, _WORKSPACE_ID and
  // ANTHROPIC_IDENTITY_TOKEN_FILE), exchanges the job's OIDC token, and refreshes it.
  const client = new Anthropic({ maxRetries: 2, timeout: 180_000 });
  const params = {
    model,
    max_tokens: shape.maxTokens,
    system,
    messages: [{ role: "user" as const, content: user }],
    output_config: {
      effort: shape.effort,
      format: { type: "json_schema" as const, schema: PUBLICATION_OUTPUT_SCHEMA },
    },
  };
  const res =
    shape.deadlineMs === undefined
      ? await client.messages.create(params)
      : await client.messages
          .stream(params, { signal: AbortSignal.timeout(shape.deadlineMs) })
          .finalMessage();
  if (
    onUsage &&
    Number.isFinite(res.usage?.input_tokens) &&
    Number.isFinite(res.usage?.output_tokens)
  ) {
    onUsage({ input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens });
  }
  if (res.stop_reason === "refusal") throw new RunFailure("model_refused");
  if (res.stop_reason === "max_tokens") throw new RunFailure("model_truncated");
  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new RunFailure("model_invalid");
  try {
    return JSON.parse(text.text);
  } catch {
    throw new RunFailure("model_invalid");
  }
}

/** A file the workflow wrote, as text, or null when it cannot be read. */
function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Review one publication request. Never throws: every failure is a fixed word.
 *
 * The order is the safety argument. The dispatched commit is checked against GitHub's `main` before
 * anything is read, so a model is never called about a commit nobody will publish. The tree, the
 * root documents, the minimums, the version, the tag and the BIDS run are read from git and the
 * runs file, none of which touches a model. Then the pre-send check examines each document, the
 * evidence is built and parsed, the prompt is built from the evidence and the cleared text alone,
 * and only then is the model called.
 */
export async function runPublicationReview(args: ReviewArgs): Promise<PublicationReviewResult> {
  let licenseFile: LicenseIdentification | undefined;
  const result = await reviewOnce(args, (id) => {
    licenseFile = id;
  });
  return licenseFile === undefined ? result : { ...result, licenseFile };
}

async function reviewOnce(
  args: ReviewArgs,
  onLicense: (id: LicenseIdentification) => void,
): Promise<PublicationReviewResult> {
  try {
    if (!SHA40.test(args.head) || !SHA40.test(args.fetchedHead)) {
      throw new RunFailure("evidence_unavailable");
    }
    // `main` moved on since the dispatch, so the review is for a commit that is no longer the
    // screened one.
    if (args.fetchedHead !== args.head) throw new RunFailure("stale_head");

    // The widened inputs, from the Worker that owns them, before anything is examined. A failure
    // here reviews nothing: never a review over part of its inputs.
    let body: ReturnType<typeof parseReviewInputs>;
    try {
      body = parseReviewInputs(await args.fetchInputs());
    } catch {
      throw new RunFailure("inputs_unavailable");
    }
    const inputs = {
      presend: presendInputs(body),
      lineage: {
        outcome: body.lineage.outcome,
        credited: lineageCredited(body.lineage.sources),
        // When the Worker resolved it (ADR 0142, decision 3), copied as the inputs give it.
        resolved_at: body.lineage.resolved_at,
      },
    };

    const tree = await readTree(args.repoDir, args.head);
    const docs = readRootDocuments(args.repoDir, tree);
    const license = identifyReviewLicense(args, tree, docs);
    // Fixed words only: never the SPDX identifier, the expression or any leftover text.
    (args.log ?? console.log)(`license_file ${license.fact.state}; matcher ${license.matcher}`);
    onLicense(license);
    const {
      facts,
      cleared,
      clearedInputs,
      license: licenseView,
    } = evidenceFromDocuments(docs, {
      head: args.head,
      anonymous: args.anonymous,
      tagsText: readText(args.tagsFile),
      bidsRuns: readText(args.bidsRunsFile),
      summary: structuralSummary(args.repoDir, tree),
      inputs,
      licenseFile: license,
    });
    const { system, user } = buildPublicationReviewMessages({
      facts,
      cleared,
      clearedInputs,
      license: licenseView,
      nonce: randomUUID().replaceAll("-", ""),
    });
    const inputDigest = publicationInputDigest({
      facts,
      cleared,
      clearedInputs,
      license: licenseView,
    });
    // A confirming run (ADR 0139, decision 1) is told its model by the Worker, in the inputs; the
    // inputs, the prompt and so the digest are the first run's, and only the model and its effort
    // differ. Any other pair is refused, so the inputs can never pick an arbitrary call.
    const confirm = confirmingCallOf(body.confirm);
    const model = confirm?.model ?? PUBLICATION_REVIEW_MODEL;
    const modelOutput = await callPublicationReviewModel(
      system,
      user,
      model,
      undefined,
      confirm?.shape ?? REVIEW_CALL,
    );
    return {
      outcome: "reported",
      report: assemblePublicationReport(modelOutput, facts, model, {
        inputDigest,
        resolverVersion: body.lineage.resolver_version,
        enrichmentSource: body.enrichment?.source ?? null,
        effort: confirm?.shape.effort ?? PUBLICATION_REVIEW_EFFORT,
        licenseMatcher: license.matcher,
      }),
    };
  } catch (e) {
    return { outcome: "error", error: mapError(e), diag: describeError(e) };
  }
}

/**
 * The confirming call the inputs name, or null for the review's own. Exactly the confirming model
 * at the confirming effort; anything else the inputs name is refused as inputs the job cannot use.
 */
export function confirmingCallOf(
  confirm: ReturnType<typeof parseReviewInputs>["confirm"],
): { model: ReviewerModel; shape: ModelCallShape } | null {
  if (confirm === undefined) return null;
  if (confirm.model !== CONFIRMING_MODEL || confirm.effort !== CONFIRMING_EFFORT) {
    throw new ReviewInputsError();
  }
  return {
    model: CONFIRMING_MODEL,
    shape: {
      effort: CONFIRMING_EFFORT,
      maxTokens: CONFIRM_MAX_TOKENS,
      deadlineMs: CONFIRM_DEADLINE_MS,
    },
  };
}

/** The answer of the inputs route that is not a body: a fixed word, never the route's text. */
class InputsUnavailable extends Error {}

/**
 * Fetch the widened inputs of a claimed review from the Worker, retrying a network failure or a
 * 5xx as the callback does. Resolves to the parsed JSON of a 200 and rejects on anything else. The
 * body is returned, never logged: it holds the dataset's metadata.
 */
export async function fetchPublicationReviewInputs(
  origin: string,
  token: string,
  ids: { reviewId: number; datasetId: string },
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(2 ** attempt * 1000);
    let res: Response;
    try {
      res = await fetch(`${origin}/webhooks/publication-review-inputs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Token": token },
        body: JSON.stringify({ review_id: ids.reviewId, dataset_id: ids.datasetId }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      continue;
    }
    if (res.status === 200) return await res.json();
    if (res.status < 500) break;
  }
  throw new InputsUnavailable("inputs_unavailable");
}

/** POST the result, retrying a network failure or a 5xx. A 4xx will not improve and is not retried. */
export async function postPublicationCallback(
  origin: string,
  token: string,
  body: Record<string, unknown>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ delivered: boolean; status: number | null }> {
  let status: number | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(2 ** attempt * 1000);
    try {
      const res = await fetch(`${origin}/webhooks/publication-review-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Token": token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      status = res.status;
      if (res.ok) return { delivered: true, status };
      if (res.status < 500) return { delivered: false, status };
    } catch {
      status = null;
    }
  }
  return { delivered: false, status };
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** A flag that is not there: exit 2, and the message is the flag's own name, never a value. */
class UsageError extends Error {}

function need(argv: string[], name: string): string {
  const v = flag(argv, name);
  if (!v) throw new UsageError(`missing --${name}`);
  return v;
}

function positive(value: string): number | null {
  const n = Number(value);
  return /^\d{1,12}$/.test(value) && Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * Run the script. `origins` is the callback table; production code never passes it, and a test
 * points it at a server of its own, which is the only way to run this end to end without sending
 * a report to a real Worker.
 */
export async function main(
  argv: string[],
  origins: Record<Environment, string> = CALLBACK_ORIGINS,
): Promise<number> {
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (cmd === "calibrate") {
    // The offline calibration: its own module, loaded only here, so the review's load path is
    // unchanged. It posts nothing and takes no origin table: `origins` is not passed on.
    const { calibrateMain } = await import("./publication-review-calibrate");
    return calibrateMain(rest);
  }
  if (cmd !== "review") {
    console.error("usage: publication-review.ts review|calibrate ...");
    return 2;
  }
  let flags: Record<
    | "dataset"
    | "review-id"
    | "request-id"
    | "environment"
    | "anonymous"
    | "repo-dir"
    | "head"
    | "fetched-head"
    | "tags-file"
    | "bids-runs-file",
    string
  >;
  const licenseScanDir = flag(rest, "license-scan-dir");
  if (rest.includes("--license-scan-dir") && !licenseScanDir) {
    console.error("missing --license-scan-dir");
    return 2;
  }
  try {
    flags = {
      dataset: need(rest, "dataset"),
      "review-id": need(rest, "review-id"),
      "request-id": need(rest, "request-id"),
      environment: need(rest, "environment"),
      anonymous: need(rest, "anonymous"),
      "repo-dir": need(rest, "repo-dir"),
      head: need(rest, "head"),
      "fetched-head": need(rest, "fetched-head"),
      "tags-file": need(rest, "tags-file"),
      "bids-runs-file": need(rest, "bids-runs-file"),
    };
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(e.message);
    return 2;
  }
  const { dataset, environment, anonymous } = flags;
  const reviewId = positive(flags["review-id"]);
  const requestId = positive(flags["request-id"]);
  const token = process.env.PUBLICATION_REVIEW_CALLBACK_TOKEN;
  if (!DATASET_ID.test(dataset) || reviewId === null || requestId === null) {
    console.error("bad --dataset, --review-id or --request-id");
    return 2;
  }
  if (environment !== "production" && environment !== "dev") {
    console.error("bad --environment");
    return 2;
  }
  if (anonymous !== "true" && anonymous !== "false") {
    console.error("bad --anonymous");
    return 2;
  }
  if (!token) {
    console.error("PUBLICATION_REVIEW_CALLBACK_TOKEN is unset");
    return 2;
  }

  const result: PublicationReviewResult = await runPublicationReview({
    repoDir: flags["repo-dir"],
    head: flags.head,
    fetchedHead: flags["fetched-head"],
    tagsFile: flags["tags-file"],
    bidsRunsFile: flags["bids-runs-file"],
    anonymous: anonymous === "true",
    licenseScanDir,
    fetchInputs: () =>
      fetchPublicationReviewInputs(origins[environment], token, { reviewId, datasetId: dataset }),
  });

  const body: Record<string, unknown> = {
    review_id: reviewId,
    dataset_id: dataset,
    outcome: result.outcome,
    ...(result.outcome === "reported" ? { report: result.report } : { error: result.error }),
  };
  const sent = await postPublicationCallback(origins[environment], token, body);
  // Ids and fixed words only: this log is public.
  console.log(
    `review ${reviewId} (request ${requestId}): ${result.outcome}${
      result.outcome === "error" ? ` (${result.error}${result.diag ? `; ${result.diag}` : ""})` : ""
    }; callback ${sent.delivered ? "delivered" : `not delivered (${sent.status ?? "no response"})`}`,
  );
  return sent.delivered ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      // A fixed word: the text of an unexpected error is not ours to put in a public log.
      console.error(
        `publication-review failed: ${e instanceof Error ? e.constructor.name : "unknown"}`,
      );
      process.exit(1);
    });
}
