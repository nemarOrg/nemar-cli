/**
 * The Tapis client the compute gateway uses to talk to the tenant (epic #2005 phase A4, #2009; ADR
 * 0118). Typed calls over `/v3/jobs/...`, built from Tapis's published OpenAPI specifications and
 * tested against a local stand-in (`backend/test/helpers/tapis-standin.ts`). NOTHING HERE HAS BEEN
 * VERIFIED AGAINST A REAL TENANT; the pull request that added it lists what is unverified.
 *
 * THE OWNER IS A PARAMETER. Every call takes a context with `owner`, the Tapis username the call is
 * made for: under the `service` strategy a token is minted for it, and for `submitJob` it is the
 * request's `owner`. There is one NEMAR tenant and NEMAR owns every Tapis job (the repository owner's
 * decision, 2026-11-04), so a caller passes a NEMAR service identity from configuration, never a
 * constant of this module and never a person.
 *
 * WHO CAN READ A JOB'S `parameterSet`, and with it the job's token. The launch specification, which
 * holds `job_token`, travels in the environment variable `NEMAR_LAUNCH_SPEC`, which Tapis keeps in the
 * job record's `parameterSet.envVariables`. From the Jobs specification and documentation, the roles
 * that can read it are: the job's owner, its creator (`createdby`) and a tenant administrator, through
 * `GET /v3/jobs/{uuid}` and the search with every attribute; a user the job's `JOB_RESUBMIT_REQUEST`
 * resource was shared with, through `GET /v3/jobs/{uuid}/resubmit_request`, which is the whole
 * submission request; and a user its `JOB_OUTPUT` resource was shared with, through the archived
 * `tapisjob.env`, which Tapis archives unless `archiveFilter.includeLaunchFiles` is false. The list
 * endpoint (`JobListDTO`) has no such field, and the status and history calls do not either. The
 * client never returns `parameterSet` or `subscriptions` (their addresses carry a token): see
 * `withoutSecretFields`. Which roles a real tenant grants is part of what is unverified.
 *
 * RULES, each pinned by a test:
 *  - every call has a 15-second timeout and a bounded body read (http.ts);
 *  - reads retry through `isRetryable` (up to three attempts); `submitJob`, `cancelJob` and
 *    `subscribeWebhook` NEVER retry inside the client, because a lost answer says nothing about
 *    whether the call took effect (the caller searches by tag first, or its sweep decides);
 *  - a 401 refreshes the token once and retries once, for every call: a refused credential did
 *    nothing, so repeating it is safe; a second 401 is `unauthorized`;
 *  - a response that fails its schema is `invalid_response`, never partly trusted;
 *  - no token, password, launch specification or webhook address is ever in an error or a log line.
 */

import { isSafeComputePath } from "../../../../shared/contract/compute";
import { COMPUTE_JOB_ID_RE } from "../../../../shared/contract/compute";
import type { PartitionName } from "../../../../shared/contract/compute";
import { withRetry } from "../retry";
import { getTapisToken, invalidateTapisToken, requireTapisConfig } from "./auth";
import { type TapisEnv, tapisBaseOrProblem } from "./config";
import { TapisError, invalidResponse } from "./errors";
import {
  TAPIS_MAX_JSON_BYTES,
  TAPIS_TIMEOUT_MS,
  effectiveTimeoutMs,
  parseJsonBody,
  send,
} from "./http";
import {
  LAUNCH_SPEC_ENV_KEY,
  SubmitJobRequestSchema,
  SubscribeRequestSchema,
  TAPIS_JOB_UUID_RE,
  TAPIS_OWNER_RE,
  TAPIS_TAG_RE,
  TapisCancelResponseSchema,
  type TapisFileInfo,
  TapisHealthResponseSchema,
  type TapisHistoryEvent,
  TapisHistoryResponseSchema,
  type TapisJob,
  TapisJobResponseSchema,
  TapisJobsResponseSchema,
  TapisOutputListResponseSchema,
  type TapisSubscription,
  TapisSubscriptionResponseSchema,
  withoutSecretFields,
} from "./schemas";

export { TAPIS_MAX_JSON_BYTES, TAPIS_TIMEOUT_MS, effectiveTimeoutMs };
export type { TapisFileInfo, TapisHistoryEvent, TapisJob, TapisSubscription };

/** What every call is made with. */
export interface TapisContext {
  env: TapisEnv;
  /** The Tapis username the call is made for (see the header). */
  owner: string;
  /** At most 15 seconds, which is also the default. */
  timeoutMs?: number;
  /** The wait between the attempts of a read. Default 500 ms. */
  retryDelayMs?: number;
  /** How many times a read is tried, 1 to 3. Default 3. */
  maxAttempts?: number;
  /** The clock, for the token cache: a test moves it. */
  now?: () => number;
}

/** The `listType` values of Tapis's job list and search. */
export const TAPIS_LIST_TYPES = ["MY_JOBS", "SHARED_JOBS", "ALL_JOBS"] as const;
export type TapisListType = (typeof TAPIS_LIST_TYPES)[number];

const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_ATTEMPTS = 3;
const LIST_LIMIT_MAX = 1000;

/** The tag every NEMAR job carries, so a retried submission finds its job instead of making two. */
export const TAPIS_JOB_TAG_PREFIX = "nemar_job:";

export function nemarJobTag(jobId: string): string {
  if (typeof jobId !== "string" || !COMPUTE_JOB_ID_RE.test(jobId)) {
    throw new RangeError("a NEMAR job id is job_ and 24 lowercase hex digits");
  }
  return `${TAPIS_JOB_TAG_PREFIX}${jobId}`;
}

/**
 * The attributes a tag search asks for: what NEMAR reads of a job, and not `parameterSet`,
 * `subscriptions`, `fileInputs` or `notes`, so a search never carries a launch specification into
 * the Worker.
 */
const SEARCH_SELECT = [
  "uuid",
  "name",
  "owner",
  "createdby",
  "status",
  "condition",
  "lastMessage",
  "created",
  "ended",
  "lastUpdated",
  "tags",
  "appId",
  "appVersion",
  "remoteJobId",
  "remoteQueue",
  "remoteSubmitted",
  "remoteStarted",
  "remoteEnded",
  "execSystemLogicalQueue",
  "nodeCount",
  "coresPerNode",
  "memoryMB",
  "maxMinutes",
].join(",");

// --- Arguments ---------------------------------------------------------------------------------

function assertOwner(owner: string): void {
  if (typeof owner !== "string" || !TAPIS_OWNER_RE.test(owner)) {
    throw new RangeError("owner is not a Tapis username NEMAR will send");
  }
}

function assertUuid(uuid: string): void {
  if (typeof uuid !== "string" || !TAPIS_JOB_UUID_RE.test(uuid)) {
    throw new RangeError("not a Tapis job uuid");
  }
}

function assertPage(limit: number | undefined, skip: number | undefined): void {
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= LIST_LIMIT_MAX)) {
    throw new RangeError(`limit is a whole number from 1 to ${LIST_LIMIT_MAX}`);
  }
  if (
    skip !== undefined &&
    !(Number.isInteger(skip) && skip >= 0 && skip <= Number.MAX_SAFE_INTEGER)
  ) {
    throw new RangeError("skip is a whole number from 0");
  }
}

function assertListType(listType: string): asserts listType is TapisListType {
  if (!(TAPIS_LIST_TYPES as readonly string[]).includes(listType)) {
    throw new RangeError("listType is MY_JOBS, SHARED_JOBS or ALL_JOBS");
  }
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

/** A file path as URL segments, each encoded once. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

// --- One call ----------------------------------------------------------------------------------

interface Call {
  /** A fixed phrase naming the call, for errors and the retry log. */
  what: string;
  method: "GET" | "POST";
  /** Below `/v3`, with its query. */
  path: string;
  /** A JSON text, sent as it is. */
  body?: string;
  /** Whether a failure that may clear is tried again. Never for a call that changes something. */
  retry: boolean;
  maxBytes: number;
}

/**
 * Send one call with a token, refresh the token once on a 401 and retry once, and try a read again
 * when its failure may clear. Returns the bytes of the 2xx answer.
 */
async function perform(ctx: TapisContext, call: Call): Promise<Uint8Array> {
  assertOwner(ctx.owner);
  const config = requireTapisConfig(ctx.env);
  const authOptions = { owner: ctx.owner, timeoutMs: ctx.timeoutMs, now: ctx.now };
  const sendWith = (token: string) =>
    send({
      url: `${config.baseUrl}/v3${call.path}`,
      method: call.method,
      headers: {
        "X-Tapis-Token": token,
        Accept: call.maxBytes === TAPIS_MAX_JSON_BYTES ? "application/json" : "*/*",
        ...(call.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: call.body,
      what: call.what,
      timeoutMs: ctx.timeoutMs,
      maxBytes: call.maxBytes,
    });

  const attempt = async (): Promise<Uint8Array> => {
    const token = await getTapisToken(ctx.env, authOptions);
    try {
      return await sendWith(token);
    } catch (err) {
      // Only a 401 is a token that stopped working; a 403 is a permission a new token would not change.
      if (!(err instanceof TapisError) || err.status !== 401) throw err;
      invalidateTapisToken(ctx.env, ctx.owner);
      return await sendWith(await getTapisToken(ctx.env, authOptions));
    }
  };

  const maxAttempts = call.retry
    ? Math.min(Math.max(Math.floor(ctx.maxAttempts ?? MAX_ATTEMPTS), 1), MAX_ATTEMPTS)
    : 1;
  const { result } = await withRetry(attempt, `tapis ${call.what}`, {
    maxAttempts,
    delayMs: ctx.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    isRetryable: (err) => err instanceof TapisError && err.retryable,
  });
  return result;
}

/** One call whose answer is JSON: parse it and check it against `schema`, or `invalid_response`. */
async function performJson<T>(
  ctx: TapisContext,
  call: Omit<Call, "maxBytes">,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T> {
  const bytes = await perform(ctx, { ...call, maxBytes: TAPIS_MAX_JSON_BYTES });
  const parsed = schema.safeParse(parseJsonBody(bytes, call.what));
  if (!parsed.success) throw invalidResponse(call.what, null);
  return parsed.data;
}

// --- Jobs --------------------------------------------------------------------------------------

/** What `submitJob` builds the request from. The owner is the context's. */
export interface SubmitJobInput {
  /** The NEMAR job id (`job_` and 24 hex digits): the job's name and, as a tag, how it is found again. */
  jobId: string;
  /** The Tapis application and its version (the launcher: `nemar-launch`). */
  appId: string;
  appVersion: string;
  /** The partition word, sent as the logical queue. */
  partition: PartitionName;
  nodes: number;
  coresPerNode: number;
  /** Per node, in MB; omitted, the application's own default applies. */
  memoryMb?: number;
  gpus: number;
  minutes: number;
  /** The exact text of `NEMAR_LAUNCH_SPEC` (`encodeLaunchSpec`): printable ASCII, within 64 KiB. */
  launchSpec: string;
}

/** The request `submitJob` sends, so a test and a reader see exactly what it is. */
export function buildSubmitRequest(owner: string, input: SubmitJobInput) {
  const candidate = {
    name: input.jobId,
    appId: input.appId,
    appVersion: input.appVersion,
    owner,
    execSystemLogicalQueue: input.partition,
    nodeCount: input.nodes,
    coresPerNode: input.coresPerNode,
    ...(input.memoryMb === undefined ? {} : { memoryMB: input.memoryMb }),
    maxMinutes: input.minutes,
    parameterSet: {
      envVariables: [{ key: LAUNCH_SPEC_ENV_KEY, value: input.launchSpec }],
      // `ReqSubmitJob` has no field for GPUs, so they are a scheduler option, and the SPELLING
      // (`--gpus=N`, as Expanse's user guide writes it) is UNVERIFIED against a real tenant: a
      // system's scheduler profile may hide or rename it.
      ...(input.gpus > 0 ? { schedulerOptions: [{ arg: `--gpus=${input.gpus}` }] } : {}),
    },
    tags: [nemarJobTag(input.jobId)],
  };
  if (!Number.isInteger(input.gpus) || input.gpus < 0) {
    throw new RangeError("gpus is a whole number from 0");
  }
  const checked = SubmitJobRequestSchema.safeParse(candidate);
  if (!checked.success) {
    // The fields, never the values: a launch specification holds a token.
    const fields = checked.error.issues.map((i) => i.path.join(".") || "request");
    throw new RangeError(
      `the job request is not one NEMAR sends: ${[...new Set(fields)].join(", ")}`,
    );
  }
  return checked.data;
}

/**
 * `POST /v3/jobs/submit`. Never retried inside the client: Tapis has no idempotency key, so after a
 * lost answer the caller searches by tag (`searchJobsByTag`) before it submits again.
 */
export async function submitJob(ctx: TapisContext, input: SubmitJobInput): Promise<TapisJob> {
  assertOwner(ctx.owner);
  const request = buildSubmitRequest(ctx.owner, input);
  const answer = await performJson(
    ctx,
    {
      what: "submit job",
      method: "POST",
      path: "/jobs/submit",
      body: JSON.stringify(request),
      retry: false,
    },
    TapisJobResponseSchema,
  );
  return withoutSecretFields(answer.result);
}

/** `GET /v3/jobs/{uuid}`. */
export async function getJob(ctx: TapisContext, uuid: string): Promise<TapisJob> {
  assertUuid(uuid);
  const answer = await performJson(
    ctx,
    { what: "get job", method: "GET", path: `/jobs/${encodeURIComponent(uuid)}`, retry: true },
    TapisJobResponseSchema,
  );
  return withoutSecretFields(answer.result);
}

/** `GET /v3/jobs/{uuid}/history`: the events of a job, oldest first as Tapis lists them. */
export async function getJobHistory(
  ctx: TapisContext,
  uuid: string,
  page: { limit?: number; skip?: number } = {},
): Promise<TapisHistoryEvent[]> {
  assertUuid(uuid);
  assertPage(page.limit, page.skip);
  const answer = await performJson(
    ctx,
    {
      what: "get job history",
      method: "GET",
      path: `/jobs/${encodeURIComponent(uuid)}/history${query({ limit: page.limit, skip: page.skip })}`,
      retry: true,
    },
    TapisHistoryResponseSchema,
  );
  return answer.result;
}

/**
 * `POST /v3/jobs/{uuid}/cancel`. A job already terminal is a 409, which is `rejected` with status
 * 409. Not retried inside the client: whether a lost cancel took effect is for the caller's sweep.
 */
export async function cancelJob(
  ctx: TapisContext,
  uuid: string,
): Promise<{ message?: string | null }> {
  assertUuid(uuid);
  const answer = await performJson(
    ctx,
    {
      what: "cancel job",
      method: "POST",
      path: `/jobs/${encodeURIComponent(uuid)}/cancel`,
      retry: false,
    },
    TapisCancelResponseSchema,
  );
  return answer.result;
}

/**
 * `POST /v3/jobs/search` with the documented body, `{ "search": ["tags IN ('<tag>')"] }`. The shape
 * of that body is the Jobs documentation's example and UNVERIFIED against a real tenant. `listType`
 * defaults to `ALL_JOBS`, because the job being looked for may belong to anyone; whether a tenant
 * returns every person's jobs for it is also unverified.
 */
export async function searchJobsByTag(
  ctx: TapisContext,
  tag: string,
  options: { listType?: TapisListType; limit?: number; skip?: number } = {},
): Promise<TapisJob[]> {
  if (typeof tag !== "string" || !TAPIS_TAG_RE.test(tag)) {
    throw new RangeError("a tag to search is letters, digits and _ : . - only");
  }
  const listType = options.listType ?? "ALL_JOBS";
  assertListType(listType);
  assertPage(options.limit, options.skip);
  const answer = await performJson(
    ctx,
    {
      what: "search jobs",
      method: "POST",
      path: `/jobs/search${query({ listType, limit: options.limit, skip: options.skip, select: SEARCH_SELECT })}`,
      body: JSON.stringify({ search: [`tags IN ('${tag}')`] }),
      retry: true,
    },
    TapisJobsResponseSchema,
  );
  return answer.result.map(withoutSecretFields);
}

/** `GET /v3/jobs/list`: a page of jobs, without the fields a full record has. */
export async function listJobs(
  ctx: TapisContext,
  options: { listType: TapisListType; limit: number; skip: number },
): Promise<TapisJob[]> {
  assertListType(options.listType);
  assertPage(options.limit, options.skip);
  const answer = await performJson(
    ctx,
    {
      what: "list jobs",
      method: "GET",
      path: `/jobs/list${query({ listType: options.listType, limit: options.limit, skip: options.skip })}`,
      retry: true,
    },
    TapisJobsResponseSchema,
  );
  return answer.result.map(withoutSecretFields);
}

/**
 * `POST /v3/jobs/subscribe/{uuid}`: a webhook for every status change of a job. The address carries a
 * token and goes to Tapis only; it is never in an error or a log line. `ttlMinutes` is 1 to 40,320
 * (four weeks, Tapis's own limit), sent as `ttlminutes`, the way the specification spells it.
 * Not retried inside the client (a lost answer would make a second subscription).
 */
export async function subscribeWebhook(
  ctx: TapisContext,
  uuid: string,
  address: string,
  ttlMinutes: number,
): Promise<TapisSubscription> {
  assertUuid(uuid);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 40_320) {
    throw new RangeError("ttlMinutes is a whole number from 1 to 40320");
  }
  let protocol: string;
  try {
    protocol = new URL(address).protocol;
  } catch {
    throw new RangeError("a webhook address is an absolute URL");
  }
  if ((protocol !== "https:" && protocol !== "http:") || address.length > 2048) {
    throw new RangeError("a webhook address is an http(s) URL of at most 2048 characters");
  }
  const body = SubscribeRequestSchema.parse({
    description: "NEMAR status hint",
    enabled: true,
    eventCategoryFilter: "JOB_NEW_STATUS",
    deliveryTargets: [{ deliveryMethod: "WEBHOOK", deliveryAddress: address }],
    ttlminutes: ttlMinutes,
  });
  const answer = await performJson(
    ctx,
    {
      what: "subscribe webhook",
      method: "POST",
      path: `/jobs/subscribe/${encodeURIComponent(uuid)}`,
      body: JSON.stringify(body),
      retry: false,
    },
    TapisSubscriptionResponseSchema,
  );
  return answer.result;
}

// --- Output ------------------------------------------------------------------------------------

/** A path below a job's output directory, or the `RangeError`; `allowRoot` lets it be empty. */
function assertOutputPath(path: string, allowRoot: boolean): void {
  if (typeof path !== "string") throw new RangeError("not an output path");
  if (allowRoot && path === "") return;
  if (!isSafeComputePath(path, 512)) throw new RangeError("not a path below the output directory");
}

/**
 * `GET /v3/jobs/{uuid}/output/list/{path}`: the entries below `path` (`""` is the root). Tapis wants
 * a directory path to end in a slash, so one is added.
 */
export async function listOutputs(
  ctx: TapisContext,
  uuid: string,
  path: string,
): Promise<TapisFileInfo[]> {
  assertUuid(uuid);
  const directory = path.endsWith("/") ? path.slice(0, -1) : path;
  assertOutputPath(directory, true);
  const answer = await performJson(
    ctx,
    {
      what: "list outputs",
      method: "GET",
      path: `/jobs/${encodeURIComponent(uuid)}/output/list/${directory === "" ? "" : `${encodePath(directory)}/`}`,
      retry: true,
    },
    TapisOutputListResponseSchema,
  );
  return answer.result;
}

/**
 * `GET /v3/jobs/{uuid}/output/download/{path}`: one file's bytes, at most `maxBytes` (a larger one is
 * `invalid_response` and is not read to its end).
 */
export async function downloadOutput(
  ctx: TapisContext,
  uuid: string,
  path: string,
  maxBytes: number,
): Promise<Uint8Array> {
  assertUuid(uuid);
  assertOutputPath(path, false);
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes is a whole number from 1");
  }
  return perform(ctx, {
    what: "download output",
    method: "GET",
    path: `/jobs/${encodeURIComponent(uuid)}/output/download/${encodePath(path)}`,
    retry: true,
    maxBytes,
  });
}

// --- Health ------------------------------------------------------------------------------------

/**
 * `GET /v3/jobs/healthcheck`, which the specification says needs no authorization: it answers
 * whether the tenant's Jobs service can be reached, and says nothing about a credential. Throws
 * `unconfigured` when there is no usable address, and any other `TapisError` as the call failed.
 */
export async function tapisHealth(
  env: TapisEnv,
  options: { timeoutMs?: number; retryDelayMs?: number; maxAttempts?: number } = {},
): Promise<void> {
  const base = tapisBaseOrProblem(env);
  if ("problem" in base) throw new TapisError("unconfigured", "health check");
  const what = "health check";
  const { result } = await withRetry(
    () =>
      send({
        url: `${base.baseUrl}/v3/jobs/healthcheck`,
        method: "GET",
        headers: { Accept: "application/json" },
        what,
        timeoutMs: options.timeoutMs,
        maxBytes: TAPIS_MAX_JSON_BYTES,
      }),
    `tapis ${what}`,
    {
      maxAttempts: Math.min(
        Math.max(Math.floor(options.maxAttempts ?? MAX_ATTEMPTS), 1),
        MAX_ATTEMPTS,
      ),
      delayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      isRetryable: (err) => err instanceof TapisError && err.retryable,
    },
  );
  if (!TapisHealthResponseSchema.safeParse(parseJsonBody(result, what)).success) {
    throw invalidResponse(what, null);
  }
}
