/**
 * NEMAR API client: transport core.
 *
 * Split from lib/api.ts by endpoint group (#908, epic #902); bodies moved
 * verbatim. `request` is exported for the sibling endpoint-group modules
 * (internal wiring, not part of the CLI-facing API surface pinned by
 * test/api-export-surface.unit.test.ts).
 *
 * DEFAULT_API_URL's literal is rewritten in dist/index.js by the dev-build
 * sed in .github/workflows/npm-publish.yml; keep the literal and the
 * IS_DEV_BUILD `.includes` expression exactly as they are.
 */

import type { ZodType } from "zod";
import { getConfig } from "../config.js";
import { isDebugEnabled, recordHttpExchange } from "../debug-log.js";
import { printMaintenanceBanner } from "../maintenance-banner.js";
import { version } from "../version.js";
import { ApiError, MaintenanceError } from "./errors.js";

const DEFAULT_API_URL = "https://api.nemar.org";

export const IS_DEV_BUILD = DEFAULT_API_URL.includes("workers.dev");

/**
 * Get the API base URL from config or default.
 * Dev builds (injected URL) always use the dev backend regardless of stored config.
 */
function getApiUrl(): string {
  if (process.env.TEST_API_URL) {
    return process.env.TEST_API_URL;
  }
  if (IS_DEV_BUILD) {
    return DEFAULT_API_URL;
  }
  const config = getConfig();
  return config.apiUrl || DEFAULT_API_URL;
}

/**
 * Make an authenticated or unauthenticated API request
 */
export async function request<T>(
  path: string,
  options: RequestInit = {},
  authenticated: boolean | "optional" = false,
  // Optional wire-contract schema (epic #896, #898). When provided, the parsed
  // response is validated against it and the VALIDATED value is returned, so a
  // shape drift fails loudly here instead of silently casting to a malformed T
  // (the getCurrentUser class of bug). Endpoints opt in by passing a schema from
  // shared/contract; passthrough schemas keep additive backend fields safe.
  schema?: ZodType<T>,
): Promise<T> {
  const url = `${getApiUrl()}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-CLI-Version": version,
    ...(options.headers as Record<string, string>),
  };

  if (authenticated) {
    const config = getConfig();
    if (!config.apiKey && authenticated === true) {
      throw new ApiError(401, "Not authenticated. Run 'nemar auth login' first.");
    }
    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
  }

  const method = options.method || "GET";
  const requestBody = typeof options.body === "string" ? options.body : undefined;
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch (fetchError) {
    // Network error - DNS resolution, connection refused, etc.
    if (isDebugEnabled()) {
      recordHttpExchange({
        method,
        url,
        status: null,
        durationMs: Date.now() - startedAt,
        requestHeaders: headers,
        requestBody,
        error: fetchError instanceof Error ? fetchError.message : String(fetchError),
      });
    }
    throw new ApiError(0, `Network error: Could not connect to ${getApiUrl()}`, {
      originalError: fetchError instanceof Error ? fetchError.message : String(fetchError),
    });
  }

  // Read the body as text once (a Response body can only be consumed once)
  // so it's available both for parsing below and for the debug log entry,
  // including the "invalid JSON" failure case.
  //
  // Wrapped in its own try/catch (review finding, PR #1257): this used to
  // run unguarded for EVERY caller, debug on or off, so a body-stream
  // failure (connection dropped mid-response, etc.) escaped as a raw
  // TypeError instead of an ApiError -- breaking the `instanceof ApiError`
  // checks roughly 20 call sites rely on (e.g. publish's isRetryable
  // classifier), regardless of whether --debug was ever involved.
  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch (readError) {
    if (isDebugEnabled()) {
      recordHttpExchange({
        method,
        url,
        status: response.status,
        durationMs: Date.now() - startedAt,
        requestHeaders: headers,
        requestBody,
        error: readError instanceof Error ? readError.message : String(readError),
      });
    }
    // statusCode 0, not response.status: a stream dying mid-body is a
    // network-layer drop regardless of what status line the server sent,
    // and 0 is this codebase's convention for exactly that (review finding,
    // PR #1257) -- see the network-error branch above, and
    // isRetryablePublishError, which treats statusCode 0 as retryable. The
    // status line the server DID send is preserved in `details` for anyone
    // reading the error, not lost.
    throw new ApiError(0, "Failed to read response body", {
      httpStatus: response.status,
      originalError: readError instanceof Error ? readError.message : String(readError),
    });
  }
  if (isDebugEnabled()) {
    recordHttpExchange({
      method,
      url,
      status: response.status,
      durationMs: Date.now() - startedAt,
      requestHeaders: headers,
      requestBody,
      responseBody: rawBody,
    });
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    // Response wasn't valid JSON
    throw new ApiError(response.status, `Invalid response from server (status ${response.status})`);
  }

  if (!response.ok) {
    if (response.status === 503 && (data.mode === "read-only" || data.mode === "full")) {
      const message =
        typeof data.message === "string"
          ? data.message
          : "NEMAR is in maintenance mode. Please retry shortly.";
      const eta = typeof data.eta === "string" ? data.eta : null;
      const maintErr = new MaintenanceError(data.mode, message, eta, data.details);
      printMaintenanceBanner(maintErr);
      throw maintErr;
    }
    throw new ApiError(
      response.status,
      (data.error as string) || (data.message as string) || "Request failed",
      data.details,
      typeof data.step === "string" ? data.step : undefined,
    );
  }

  if (schema) {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new ApiError(
        response.status,
        `Response for ${path} did not match the expected NEMAR contract`,
        { issues: result.error.issues },
      );
    }
    return result.data;
  }

  return data as T;
}

// ============================================================================
// Health
// ============================================================================

export interface HealthResponse {
  status: string;
  timestamp: string;
  version: string;
}

/**
 * Check API health
 */
export async function checkHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/health");
}
