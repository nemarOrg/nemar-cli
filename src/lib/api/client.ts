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

import { getConfig } from "../config.js";
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

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch (fetchError) {
    // Network error - DNS resolution, connection refused, etc.
    throw new ApiError(0, `Network error: Could not connect to ${getApiUrl()}`, {
      originalError: fetchError instanceof Error ? fetchError.message : String(fetchError),
    });
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
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
