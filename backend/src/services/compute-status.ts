/**
 * What `GET /admin/compute/status` answers (epic #2005 phase A4, #2009; ADR 0118): the owner's way to
 * check, once the secrets are set, that the Worker can reach and sign in to the Tapis tenant and
 * reach its storage, without a shell.
 *
 * BOOLEANS AND FIXED WORDS ONLY. Nothing here is a secret value, an address, a tenant name or a
 * username: each piece is `true` or `false`, the environment is one of three words, and the two
 * calls are `ok`, `unconfigured`, `skipped` or the KIND of the error they failed with
 * (`TapisError.kind`, never its message). The names of what is missing (`TAPIS_PASSWORD:missing`)
 * are the Worker's own binding names, which this repository publishes.
 *
 * ONE MINT AND ONE HEALTH CALL, made now: the token is minted afresh (`mintTapisToken`, which asks
 * Tapis whatever the cache holds and keeps nothing), so the answer is about the credential, not
 * about a cache; the health call is the unauthenticated `GET /v3/jobs/healthcheck`, so it says the
 * tenant can be reached, and the mint says the credential works. They run together, each with a short
 * timeout and a single attempt, so the route answers within a few seconds whatever Tapis does. This
 * route writes nothing.
 *
 * `runtime_image` (round 1 of #2041) says whether the owner has set `COMPUTE_RUNTIME_IMAGE`, whether
 * what is set is a digest-pinned reference, and its digest: a `python` job is not submitted until it is
 * `valid`. The reference itself is never echoed.
 */

import type { ComputeStatusResponse } from "../../../shared/contract/compute-admin";
import type { Bindings } from "../types/bindings";
import { readRuntimeImage } from "./compute-runtime-image";
import { computeS3 } from "./compute-s3";
import { computeEnabled, computePipelinesDispatchEnabled } from "./compute-switches";
import { mintTapisToken } from "./tapis/auth";
import { tapisHealth } from "./tapis/client";
import { tapisConfig } from "./tapis/config";
import { TapisError } from "./tapis/errors";
import { TAPIS_OWNER_RE } from "./tapis/schemas";

/** How long each of the two calls may take: short, so an admin's request is never held for long. */
export const STATUS_TIMEOUT_MS = 8000;

const present = (value: string | undefined): boolean =>
  typeof value === "string" && value.trim() !== "";

/** The environment as one of three words, so an unexpected value is never echoed. */
function environmentWord(
  env: Pick<Bindings, "ENVIRONMENT">,
): "production" | "development" | "other" {
  return env.ENVIRONMENT === "production" || env.ENVIRONMENT === "development"
    ? env.ENVIRONMENT
    : "other";
}

/** A call's outcome as a fixed word: `ok`, or the kind it failed with. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (err) {
    if (err instanceof TapisError) return err.kind;
    // Not something Tapis said: log the class only (never a message), and report the call as not working.
    console.error(
      "[compute-status] unexpected failure:",
      err instanceof Error ? err.name : typeof err,
    );
    return "unavailable";
  }
}

/** Whether `COMPUTE_RUNTIME_IMAGE` is set, whether it is a digest-pinned reference, and its digest; never the reference. */
function runtimeImageStatus(env: Bindings): ComputeStatusResponse["runtime_image"] {
  const image = readRuntimeImage(env);
  return {
    set: image.state !== "unset",
    valid: image.state === "ok",
    digest: image.state === "ok" ? image.digest : null,
  };
}

export interface StatusOptions {
  /** The timeout of each call, at most the client's own 15 seconds. */
  timeoutMs?: number;
}

export async function computeStatus(
  env: Bindings,
  options: StatusOptions = {},
): Promise<ComputeStatusResponse> {
  const timeoutMs = options.timeoutMs ?? STATUS_TIMEOUT_MS;
  const config = tapisConfig(env);

  // The user a token is minted for: the configured account under `password`, and under `service` the
  // NEMAR service identity when one is configured (without it the credential cannot be probed).
  let probeUser: string | undefined;
  if (!config.unconfigured) {
    probeUser = config.username;
    if (
      config.strategy === "service" &&
      probeUser !== undefined &&
      !TAPIS_OWNER_RE.test(probeUser)
    ) {
      probeUser = undefined;
    }
  }

  const [token, health] = await Promise.all([
    config.unconfigured
      ? "unconfigured"
      : probeUser === undefined
        ? "skipped"
        : outcome(() => mintTapisToken(env, { owner: probeUser as string, timeoutMs })),
    outcome(() => tapisHealth(env, { timeoutMs, maxAttempts: 1 })),
  ]);

  return {
    switches: {
      environment: environmentWord(env),
      compute_enabled: computeEnabled(env),
      pipelines_dispatch_enabled: computePipelinesDispatchEnabled(env),
    },
    tapis: {
      configured: !config.unconfigured,
      strategy: config.unconfigured ? null : config.strategy,
      problems: config.unconfigured ? [...config.problems] : [],
      token,
      health,
    },
    storage: {
      records_binding: Boolean(env.COMPUTE_RECORDS),
      results_binding: Boolean(env.COMPUTE_RESULTS),
      signing_configured: computeS3(env) !== null,
    },
    // PRESENCE ONLY, never a value. The ACCESS reports wait until BOTH are set (`accessReportConfig`), so
    // the answer says each: a key without a resource name must not read as "configured".
    access: {
      key_configured: present(env.ACCESS_GATEWAY_ATTRIBUTES_KEY),
      resource_name_configured: present(env.ACCESS_RESOURCE_NAME),
    },
    runtime_image: runtimeImageStatus(env),
  };
}
