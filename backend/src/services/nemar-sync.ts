/**
 * nemar.org Datapipeline Sync Service
 *
 * Pushes dataset metadata to the nemar.org database so that
 * https://nemar.org/dataexplorer/detail?dataset_id=... pages display correctly.
 *
 * The API follows a delete-then-insert pattern (no upsert). Four tables are populated:
 *   1. dataexplorer_dataset         (core metadata)
 *   2. dataexplorer_extra_dataset   (file metrics)
 *   3. dataexplorer_dataset_channel_count (per-channel-type counts)
 *   4. dataexplorer_supplementary_dataset (version/tag info)
 */

import type { NemarMetadataV2 } from "../../../shared/datacite-constants.js";
import { detectModalitiesFromTree } from "./datacite.js";
import type { TreeEntry } from "./github.js";
import { getBlobContent } from "./github.js";
import type { VersionManifest } from "./manifest.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEMAR_API_BASE = "https://nemar.org/api/dataexplorer/datapipeline";
const NEMAR_SEP = " ===NEMAR-SEP=== ";

const TABLE_DATASET = "dataexplorer_dataset";
const TABLE_EXTRA = "dataexplorer_extra_dataset";
const TABLE_CHANNEL_COUNT = "dataexplorer_dataset_channel_count";
const TABLE_SUPPLEMENTARY = "dataexplorer_supplementary_dataset";

// Data file extensions worth reporting (excludes metadata like .json, .tsv)
const DATA_EXTENSIONS = new Set([
  ".edf",
  ".bdf",
  ".set",
  ".fdt",
  ".fif",
  ".vhdr",
  ".vmrk",
  ".eeg",
  ".nwb",
  ".gdf",
  ".cnt",
  ".mff",
  ".ds",
]);

// Channel type mapping (TSV type column -> display name)
const CHANNEL_TYPE_MAP: Record<string, string> = {
  EEG: "EEG Channels",
  ECOG: "EEG Channels",
  MEG: "MEG Channels",
  MEGREF: "MEG REF Channels",
  MEGGRAD: "MEG Channels",
  MEGMAG: "MEG Channels",
  EMG: "EMG Channels",
  EOG: "EOG Channels",
  HEOG: "EOG Channels",
  VEOG: "EOG Channels",
  ECG: "ECG Channels",
  TRIG: "Trigger Channels",
  MISC: "MISC Channels",
  STIM: "Trigger Channels",
  REF: "REF Channels",
  SEEG: "SEEG Channels",
  DBS: "DBS Channels",
  NIRS: "NIRS Channels",
  AUDIO: "AUDIO Channels",
  PD: "PD Channels",
  SYSCLOCK: "SYSCLOCK Channels",
  ADC: "ADC Channels",
  DAC: "DAC Channels",
  HLU: "HLU Channels",
  OTHER: "OTHER Channels",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NemarSyncSource {
  datasetId: string;
  bidsDescription: Record<string, unknown>;
  nemarMetadata: NemarMetadataV2 | null;
  readme: string;
  tree: TreeEntry[];
  conceptDoi: string | null;
  latestVersionDoi: string | null;
  latestVersion: string | null;
  versionCreatedAt: string | null;
  ownerUsername: string;
  createdAt: string | null;
  publishDate: string | null;
  repoName: string;
  pat: string;
  /** Pre-loaded version manifest from S3 (has accurate file sizes from annex keys) */
  manifest?: VersionManifest | null;
  /** S3 object stats (totalSize in bytes, objectCount) -- most accurate size source */
  s3Stats?: { totalSize: number; objectCount: number } | null;
  /** Zip archive size in bytes from S3 archives/ prefix */
  zipFileSize?: number;
  /** GitHub repo creation date -- fallback when D1 dates are null (legacy datasets) */
  repoCreatedAt?: string | null;
}

export interface SyncResult {
  synced: boolean;
  errors: string[];
}

interface ParticipantStats {
  count: number;
  ageMin: number | null;
  ageMax: number | null;
}

interface ChannelCount {
  name: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(username: string, password: string): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
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
    console.warn(`[nemar-sync] Failed to parse JWT expiry, using 30min default: ${err}`);
  }

  cachedToken = { token, expiresAt };
  return token;
}

// Detect which key name the API expects
function tokenKeyName(token: string): string {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    // nemar.org tokens have iss = "https://nemar.org"
    if (payload.iss?.includes("nemar.org")) return "nemar_access_token";
  } catch (err) {
    console.warn(`[nemar-sync] Failed to parse token payload: ${err}`);
  }
  return "access_token";
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

async function insertRecord(
  token: string,
  tableName: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const keyName = tokenKeyName(token);
  const res = await fetch(NEMAR_API_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [keyName]: token, table_name: tableName, entry }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`nemar.org insert to ${tableName} failed: HTTP ${res.status} ${text}`);
  }
}

async function deleteRecords(token: string, tableName: string, datasetId: string): Promise<void> {
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

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / 1024 ** i;
  return `${Math.round(val * 10) / 10} ${units[i]}`;
}

/** Format date as "YYYY-MM-DD HH:MM:SS" (nemar.org expected format, not ISO 8601) */
function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return "";
    return d
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "");
  } catch {
    return "";
  }
}

function joinSep(value: unknown): string {
  if (!value) return "";
  if (Array.isArray(value)) return value.filter(Boolean).join(NEMAR_SEP);
  const str = String(value);
  // Normalize <br/> and semicolons to our separator
  return str
    .split(/\s*<br\s*\/?>\s*|\s*;\s*|\n/)
    .filter(Boolean)
    .join(NEMAR_SEP);
}

export function parseParticipantsTsv(content: string): ParticipantStats {
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return { count: 0, ageMin: null, ageMax: null };

  const headers = lines[0].split("\t").map((h) => h.trim().toLowerCase());
  const ageIdx = headers.indexOf("age");
  const rows = lines.slice(1);

  let ageMin: number | null = null;
  let ageMax: number | null = null;

  if (ageIdx >= 0) {
    for (const row of rows) {
      const cols = row.split("\t");
      const raw = cols[ageIdx]?.trim();
      if (!raw || raw === "n/a" || raw === "N/A") continue;
      const age = Number.parseFloat(raw);
      if (!Number.isNaN(age)) {
        ageMin = ageMin === null ? age : Math.min(ageMin, age);
        ageMax = ageMax === null ? age : Math.max(ageMax, age);
      }
    }
  }

  return { count: rows.length, ageMin, ageMax };
}

export function parseChannelsTsv(content: string): ChannelCount[] {
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split("\t").map((h) => h.trim().toLowerCase());
  const typeIdx = headers.indexOf("type");
  if (typeIdx < 0) return [];

  const counts: Record<string, number> = {};
  for (const row of lines.slice(1)) {
    const cols = row.split("\t");
    const rawType = cols[typeIdx]?.trim().toUpperCase();
    if (!rawType) continue;
    const displayName = CHANNEL_TYPE_MAP[rawType] || `${rawType} Channels`;
    counts[displayName] = (counts[displayName] || 0) + 1;
  }

  return Object.entries(counts).map(([name, count]) => ({ name, count }));
}

function detectFileFormats(tree: TreeEntry[]): string[] {
  const found = new Set<string>();
  for (const entry of tree) {
    if (entry.type !== "blob") continue;
    const dotIdx = entry.path.lastIndexOf(".");
    if (dotIdx < 0) continue;
    const ext = entry.path.substring(dotIdx).toLowerCase();
    if (DATA_EXTENSIONS.has(ext)) found.add(ext);
  }
  return [...found].sort();
}

function countRuns(tree: TreeEntry[]): number {
  const runPattern = /_run-\d+/;
  const runs = new Set<string>();
  for (const entry of tree) {
    const match = entry.path.match(runPattern);
    if (match) {
      // Unique by directory + run number
      const dir = entry.path.split("/").slice(0, -1).join("/");
      runs.add(`${dir}/${match[0]}`);
    }
  }
  return runs.size;
}

function countEventFiles(tree: TreeEntry[]): number {
  return tree.filter((e) => e.type === "blob" && e.path.endsWith("_events.tsv")).length;
}

function countSessions(tree: TreeEntry[]): number {
  const sessions = new Set<string>();
  for (const entry of tree) {
    const match = entry.path.match(/\/ses-([^/]+)\//);
    if (match) sessions.add(match[1]);
  }
  return sessions.size;
}

function extractTasks(tree: TreeEntry[]): string[] {
  const tasks = new Set<string>();
  for (const entry of tree) {
    const match = entry.path.match(/_task-([^_./]+)/);
    if (match) tasks.add(match[1]);
  }
  return [...tasks].sort();
}

/**
 * Get total dataset size. Prefers manifest data (accurate annex sizes)
 * over tree sizes (which are just pointer file sizes for annexed content).
 */
function totalFileSizeFromManifest(manifest?: VersionManifest | null): number {
  if (!manifest?.files) return 0;
  let total = 0;
  for (const file of Object.values(manifest.files)) {
    total += file.size;
  }
  return total;
}

function totalFileSizeFromTree(tree: TreeEntry[]): number {
  let total = 0;
  for (const entry of tree) {
    if (entry.size) total += entry.size;
  }
  return total;
}

function totalFileCount(tree: TreeEntry[]): number {
  return tree.filter((e) => e.type === "blob").length;
}

// ---------------------------------------------------------------------------
// Data mappers
// ---------------------------------------------------------------------------

function buildDataexplorerDataset(
  src: NemarSyncSource,
  participants: ParticipantStats,
): Record<string, unknown> {
  const bd = src.bidsDescription;
  const meta = src.nemarMetadata;
  const modalities =
    meta?.modalities?.join(",") ||
    detectModalitiesFromTree(src.tree.map((t) => t.path)).join(",") ||
    "EEG";

  // Size priority: S3 stats (most accurate) > manifest > tree (annex pointers, inaccurate)
  const fileSize =
    src.s3Stats?.totalSize ||
    totalFileSizeFromManifest(src.manifest) ||
    totalFileSizeFromTree(src.tree);

  // Date fallbacks: D1 dates > repo creation date > empty
  const created = formatDate(src.createdAt) || formatDate(src.repoCreatedAt);
  const published = formatDate(src.publishDate) || created;

  return {
    id: src.datasetId,
    created,
    uploader: src.ownerUsername,
    latestSnapshot: src.latestVersion || "1.0.0",
    name: (bd.Name as string) || src.datasetId,
    publishDate: published,
    onBrainlife: 0,
    sessionsNum: countSessions(src.tree),
    file_size: Math.round(fileSize),
    byte_size_format: formatBytes(fileSize),
    totalFiles: totalFileCount(src.tree),
    participants: participants.count,
    age_min: participants.ageMin ?? 0,
    age_max: participants.ageMax ?? 0,
    BIDSVersion: (bd.BIDSVersion as string) || "",
    License: (bd.License as string) || meta?.license || "",
    Authors: Array.isArray(bd.Authors)
      ? (bd.Authors as string[]).join(", ")
      : String(bd.Authors || ""),
    Acknowledgements: (bd.Acknowledgements as string) || "",
    HowToAcknowledge: (bd.HowToAcknowledge as string) || "",
    Funding: joinSep(bd.Funding),
    ReferencesAndLinks: joinSep(bd.ReferencesAndLinks),
    DatasetDOI: src.conceptDoi || "",
    EthicsApprovals: joinSep(bd.EthicsApprovals),
    tasks: extractTasks(src.tree).join(", "),
    HEDVersion: (bd.HEDVersion as string) || "",
    modalities,
    readme: src.readme,
    local_dataset: 1,
    processed: meta?.dataset_type === "derivative" ? 1 : 0,
    hedAnnotation: 0, // updated by caller (syncDatasetToNemar) if HED annotation detected
  };
}

function buildDataexplorerExtra(
  src: NemarSyncSource,
  channelCounts: ChannelCount[],
): Record<string, unknown> {
  const channelObj: Record<string, number> = {};
  for (const ch of channelCounts) {
    channelObj[ch.name] = ch.count;
  }

  return {
    id: src.datasetId,
    channel_counts: JSON.stringify(channelObj),
    runs_session: countRuns(src.tree),
    file_formats: detectFileFormats(src.tree).join(", "),
    data_pipeline: "",
    event_count: countEventFiles(src.tree),
    total_actual_file_size: Math.round(
      (src.s3Stats?.totalSize ||
        totalFileSizeFromManifest(src.manifest) ||
        totalFileSizeFromTree(src.tree)) / 1024,
    ), // KiB (bytes / 1024)
    zip_file_size: src.zipFileSize ? Math.round(src.zipFileSize / 1024) : 0, // KiB
  };
}

function buildSupplementary(src: NemarSyncSource): Record<string, unknown> {
  const modalities =
    src.nemarMetadata?.modalities || detectModalitiesFromTree(src.tree.map((t) => t.path));

  return {
    id: src.datasetId,
    latestSnapshot_created: formatDate(src.versionCreatedAt || src.createdAt || src.repoCreatedAt),
    description_name: (src.bidsDescription.Name as string) || src.datasetId,
    primaryModality: modalities[0] || "EEG",
    secondaryModalities: modalities.slice(1).join(","),
    issues: "[]",
    git_local_tag: src.latestVersion ? `v${src.latestVersion}` : "",
    git_remote_tag: src.latestVersion ? `v${src.latestVersion}` : "",
  };
}

// ---------------------------------------------------------------------------
// Channel count collection (reads first subject's channels.tsv)
// ---------------------------------------------------------------------------

async function collectChannelCounts(src: NemarSyncSource): Promise<ChannelCount[]> {
  // Find the first *_channels.tsv file in the tree
  const channelsFile = src.tree.find(
    (f) =>
      f.type === "blob" &&
      f.path.includes("/") &&
      f.path.endsWith("_channels.tsv") &&
      f.path.startsWith("sub-"),
  );

  if (!channelsFile) return [];

  try {
    const content = await getBlobContent(src.repoName, channelsFile.sha, src.pat);
    return parseChannelsTsv(content);
  } catch (err) {
    console.warn(`[nemar-sync] Failed to read channels file ${channelsFile.path}: ${err}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// HED annotation detection
// ---------------------------------------------------------------------------

async function detectHedAnnotation(src: NemarSyncSource): Promise<boolean> {
  // Check if any events.json file contains "HED" key
  const eventsJson = src.tree.find(
    (f) => f.type === "blob" && f.path.endsWith("_events.json") && f.path.startsWith("sub-"),
  );

  if (!eventsJson) return false;

  try {
    const content = await getBlobContent(src.repoName, eventsJson.sha, src.pat);
    return content.includes('"HED"');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Participants collection
// ---------------------------------------------------------------------------

async function collectParticipants(src: NemarSyncSource): Promise<ParticipantStats> {
  const pFile = src.tree.find((f) => f.type === "blob" && f.path === "participants.tsv");

  if (!pFile) return { count: 0, ageMin: null, ageMax: null };

  try {
    const content = await getBlobContent(src.repoName, pFile.sha, src.pat);
    return parseParticipantsTsv(content);
  } catch (err) {
    console.warn(`[nemar-sync] Failed to read participants.tsv: ${err}`);
    return { count: 0, ageMin: null, ageMax: null };
  }
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------

export async function syncDatasetToNemar(
  username: string,
  password: string,
  src: NemarSyncSource,
): Promise<SyncResult> {
  const errors: string[] = [];

  // 1. Get access token
  const token = await getAccessToken(username, password);

  // 2. Gather data that requires blob reads
  const [participants, channelCounts, hasHed] = await Promise.all([
    collectParticipants(src),
    collectChannelCounts(src),
    detectHedAnnotation(src),
  ]);

  // 3. Build payloads for all four tables
  const datasetEntry = buildDataexplorerDataset(src, participants);
  if (hasHed) datasetEntry.hedAnnotation = 1;

  const extraEntry = buildDataexplorerExtra(src, channelCounts);
  const supplementaryEntry = buildSupplementary(src);

  // 4. Delete existing records from all tables (order doesn't matter)
  const tables = [TABLE_DATASET, TABLE_EXTRA, TABLE_CHANNEL_COUNT, TABLE_SUPPLEMENTARY];
  for (const table of tables) {
    try {
      await deleteRecords(token, table, src.datasetId);
    } catch (err) {
      errors.push(`delete ${table}: ${err}`);
    }
  }

  // 5. Insert new records
  try {
    await insertRecord(token, TABLE_DATASET, datasetEntry);
  } catch (err) {
    errors.push(`insert ${TABLE_DATASET}: ${err}`);
  }

  try {
    await insertRecord(token, TABLE_EXTRA, extraEntry);
  } catch (err) {
    errors.push(`insert ${TABLE_EXTRA}: ${err}`);
  }

  // Channel counts: multiple rows
  for (const ch of channelCounts) {
    try {
      await insertRecord(token, TABLE_CHANNEL_COUNT, {
        id: src.datasetId,
        name: ch.name,
        count: ch.count,
      });
    } catch (err) {
      errors.push(`insert ${TABLE_CHANNEL_COUNT} (${ch.name}): ${err}`);
    }
  }

  try {
    await insertRecord(token, TABLE_SUPPLEMENTARY, supplementaryEntry);
  } catch (err) {
    errors.push(`insert ${TABLE_SUPPLEMENTARY}: ${err}`);
  }

  return { synced: errors.length === 0, errors };
}
