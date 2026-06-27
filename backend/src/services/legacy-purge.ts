/**
 * Legacy nemar.org datapipeline — delete-only client.
 *
 * One-time purge utility for epic #837 Phase 4: removes NEMAR's records from the
 * retired `nemar.org/dataexplorer` datapipeline tables so the legacy site stops
 * showing our datasets. Extracted from the deleted nemar-sync.ts — only the auth
 * + DELETE path remains (the outgoing push is gone). Removed in Phase 5 once the
 * purge has run.
 */

const NEMAR_API_BASE = "https://nemar.org/api/dataexplorer/datapipeline";

/** The four legacy dataexplorer tables a dataset's rows live in. */
export const LEGACY_TABLES = [
  "dataexplorer_dataset",
  "dataexplorer_extra_dataset",
  "dataexplorer_dataset_channel_count",
  "dataexplorer_supplementary_dataset",
] as const;

export async function getAccessToken(
  username: string,
  password: string,
  cache: { token: string; expiresAt: number } | null = null,
): Promise<{ token: string; cache: { token: string; expiresAt: number } }> {
  if (cache && Date.now() < cache.expiresAt - 60_000) {
    return { token: cache.token, cache };
  }

  const res = await fetch(`${NEMAR_API_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to get nemar.org access token: HTTP ${res.status} ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const token = (data.nemar_access_token as string) || (data.access_token as string);
  if (!token) {
    throw new Error("nemar.org /token response missing access token");
  }

  // Attempt to read JWT exp; default to 30 min if we can't parse it
  let expiresAt = Date.now() + 30 * 60 * 1000;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (payload.exp) expiresAt = payload.exp * 1000;
  } catch (err) {
    console.warn(`[legacy-purge] Failed to parse JWT expiry, using 30min default: ${err}`);
  }

  const newCache = { token, expiresAt };
  return { token, cache: newCache };
}

// Detect which key name the API expects
function tokenKeyName(token: string): string {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    // nemar.org tokens have iss = "https://nemar.org"
    if (payload.iss?.includes("nemar.org")) return "nemar_access_token";
  } catch (err) {
    console.warn(`[legacy-purge] Failed to parse token payload: ${err}`);
  }
  return "access_token";
}

export async function deleteRecords(
  token: string,
  tableName: string,
  datasetId: string,
): Promise<void> {
  const keyName = tokenKeyName(token);
  const res = await fetch(`${NEMAR_API_BASE}/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      [keyName]: token,
      table_name: tableName,
      dataset_id: datasetId,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`nemar.org delete from ${tableName} failed: HTTP ${res.status} ${text}`);
  }
}
