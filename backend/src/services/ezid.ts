/**
 * EZID API service
 *
 * Handles DOI registration and management for NEMAR datasets via EZID/DataCite.
 * NEMAR DOI prefix: doi:10.82901/NEMAR.
 *
 * DOI lifecycle:
 * - reserved: Pre-registered, not advertised, deletable
 * - public: Registered with DataCite, permanent, findable
 * - unavailable: Public but object inaccessible (tombstone)
 *
 * Uses ANVL (A Name-Value Language) for request/response format.
 * Rich metadata is passed as DataCite kernel-4 XML via the `datacite` ANVL key.
 */

export const EZID_BASE_URL = "https://ezid.cdlib.org";
export const PRODUCTION_SHOULDER = "doi:10.82901/NEMAR.";
export const TEST_SHOULDER = "doi:10.5072/FK2";

export type EzidStatus = "reserved" | "public" | "unavailable";

export interface EzidAuth {
  username: string;
  password: string;
}

export interface EzidMintOptions {
  shoulder: string;
  status?: EzidStatus;
  target?: string;
  profile?: string;
  dataciteXml?: string;
  /** Simple ANVL datacite fields (used when dataciteXml is not provided) */
  dataciteFields?: {
    creator: string;
    title: string;
    publisher: string;
    publicationyear: string;
    resourcetype: string;
  };
}

export interface EzidUpdateOptions {
  status?: EzidStatus;
  target?: string;
  dataciteXml?: string;
}

export interface EzidIdentifier {
  identifier: string;
  status: EzidStatus;
  target: string;
  profile: string;
  created: number;
  updated: number;
  owner: string;
  ownergroup: string;
  dataciteXml?: string;
  /** All raw ANVL fields */
  raw: Record<string, string>;
}

// ---------------------------------------------------------------------------
// ANVL encoding/decoding
// ---------------------------------------------------------------------------

/**
 * Percent-encode a string value for ANVL format.
 * Encodes: % -> %25, \n -> %0A, \r -> %0D
 */
export function percentEncode(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/\n/g, "%0A")
    .replace(/\r/g, "%0D");
}

/**
 * Percent-decode an ANVL value.
 */
export function percentDecode(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/**
 * Encode key-value pairs into ANVL format.
 */
export function encodeAnvl(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([key, value]) => `${percentEncode(key)}: ${percentEncode(value)}`)
    .join("\n");
}

/**
 * Decode an ANVL response body into key-value pairs.
 * First line is the status line (success/error).
 */
export function decodeAnvl(body: string): { status: string; fields: Record<string, string> } {
  const lines = body.split("\n");
  const statusLine = lines[0] || "";

  const fields: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // Continuation lines start with whitespace
    if (/^\s/.test(line) && i > 1) {
      const lastKey = Object.keys(fields).pop();
      if (lastKey) {
        fields[lastKey] += "\n" + percentDecode(line.trim());
      }
      continue;
    }

    const colonIdx = line.indexOf(": ");
    if (colonIdx === -1) continue;

    const key = percentDecode(line.substring(0, colonIdx));
    const value = percentDecode(line.substring(colonIdx + 2));
    fields[key] = value;
  }

  return { status: statusLine, fields };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function basicAuthHeader(auth: EzidAuth): string {
  const encoded = btoa(`${auth.username}:${auth.password}`);
  return `Basic ${encoded}`;
}

async function ezidRequest(
  method: string,
  path: string,
  auth: EzidAuth | null,
  body?: string,
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    Accept: "text/plain",
  };

  if (auth) {
    headers.Authorization = basicAuthHeader(auth);
  }

  if (body !== undefined) {
    headers["Content-Type"] = "text/plain; charset=UTF-8";
  }

  const response = await fetch(`${EZID_BASE_URL}${path}`, {
    method,
    headers,
    body: body || undefined,
  });

  const responseBody = await response.text();
  return { status: response.status, body: responseBody };
}

function parseStatusLine(body: string): { success: boolean; message: string } {
  const firstLine = body.split("\n")[0] || "";
  if (firstLine.startsWith("success: ")) {
    return { success: true, message: firstLine.substring(9) };
  }
  if (firstLine.startsWith("error: ")) {
    return { success: false, message: firstLine.substring(7) };
  }
  return { success: false, message: firstLine };
}

function parseIdentifier(anvlBody: string): EzidIdentifier {
  const { status, fields } = decodeAnvl(anvlBody);
  const parsed = parseStatusLine(status);

  return {
    identifier: parsed.message,
    status: (fields._status || "reserved") as EzidStatus,
    target: fields._target || "",
    profile: fields._profile || "datacite",
    created: parseInt(fields._created || "0", 10),
    updated: parseInt(fields._updated || "0", 10),
    owner: fields._owner || "",
    ownergroup: fields._ownergroup || "",
    dataciteXml: fields.datacite || undefined,
    raw: fields,
  };
}

// ---------------------------------------------------------------------------
// Core API operations
// ---------------------------------------------------------------------------

/**
 * Check if EZID server is up.
 */
export async function checkStatus(): Promise<boolean> {
  const { body } = await ezidRequest("GET", "/status", null);
  return body.includes("success: EZID is up");
}

/**
 * Mint a new identifier on a shoulder.
 * Returns the newly created identifier with its metadata.
 */
export async function mintIdentifier(
  auth: EzidAuth,
  options: EzidMintOptions,
): Promise<EzidIdentifier> {
  const anvlPairs: Record<string, string> = {};

  if (options.target) {
    anvlPairs._target = options.target;
  }
  anvlPairs._status = options.status || "reserved";
  anvlPairs._profile = options.profile || "datacite";

  if (options.dataciteXml) {
    anvlPairs.datacite = options.dataciteXml;
  } else if (options.dataciteFields) {
    anvlPairs["datacite.creator"] = options.dataciteFields.creator;
    anvlPairs["datacite.title"] = options.dataciteFields.title;
    anvlPairs["datacite.publisher"] = options.dataciteFields.publisher;
    anvlPairs["datacite.publicationyear"] = options.dataciteFields.publicationyear;
    anvlPairs["datacite.resourcetype"] = options.dataciteFields.resourcetype;
  }

  const body = encodeAnvl(anvlPairs);
  const response = await ezidRequest("POST", `/shoulder/${options.shoulder}`, auth, body);

  const parsed = parseStatusLine(response.body);
  if (!parsed.success) {
    throw new Error(`EZID mint error: ${parsed.message}`);
  }

  // The minted identifier is in the success message (e.g. "doi:10.5072/FK2XXXX | ark:/...")
  const identifier = parsed.message.split(" | ")[0];

  // Fetch the full record to return complete metadata
  return getIdentifier(auth, identifier);
}

/**
 * Get an identifier's metadata.
 * Does not require authentication for public identifiers.
 */
export async function getIdentifier(
  auth: EzidAuth | null,
  identifier: string,
): Promise<EzidIdentifier> {
  const response = await ezidRequest("GET", `/id/${identifier}`, auth);

  const parsed = parseStatusLine(response.body);
  if (!parsed.success) {
    throw new Error(`EZID get error: ${parsed.message}`);
  }

  return parseIdentifier(response.body);
}

/**
 * Update an identifier's metadata.
 * Only specified fields are updated; omitted fields remain unchanged.
 */
export async function updateIdentifier(
  auth: EzidAuth,
  identifier: string,
  options: EzidUpdateOptions,
): Promise<EzidIdentifier> {
  const anvlPairs: Record<string, string> = {};

  if (options.status) {
    anvlPairs._status = options.status;
  }
  if (options.target) {
    anvlPairs._target = options.target;
  }
  if (options.dataciteXml) {
    anvlPairs.datacite = options.dataciteXml;
  }

  const body = encodeAnvl(anvlPairs);
  const response = await ezidRequest("POST", `/id/${identifier}`, auth, body);

  const parsed = parseStatusLine(response.body);
  if (!parsed.success) {
    throw new Error(`EZID update error: ${parsed.message}`);
  }

  return getIdentifier(auth, identifier);
}

/**
 * Delete a reserved identifier.
 * Only reserved (unpublished) identifiers can be deleted.
 */
export async function deleteIdentifier(
  auth: EzidAuth,
  identifier: string,
): Promise<void> {
  const response = await ezidRequest("DELETE", `/id/${identifier}`, auth);

  const parsed = parseStatusLine(response.body);
  if (!parsed.success) {
    throw new Error(`EZID delete error: ${parsed.message}`);
  }
}

/**
 * Transition a reserved identifier to public.
 * This makes the DOI findable in DataCite and is PERMANENT.
 */
export async function makePublic(
  auth: EzidAuth,
  identifier: string,
  target: string,
): Promise<EzidIdentifier> {
  return updateIdentifier(auth, identifier, {
    status: "public",
    target,
  });
}

/**
 * Mark a public identifier as unavailable (tombstone).
 * The DOI still exists but resolves to a tombstone page.
 */
export async function makeUnavailable(
  auth: EzidAuth,
  identifier: string,
  reason?: string,
): Promise<EzidIdentifier> {
  const status = reason ? `unavailable | ${reason}` : "unavailable";
  const body = encodeAnvl({ _status: status });
  const response = await ezidRequest("POST", `/id/${identifier}`, auth, body);

  const parsed = parseStatusLine(response.body);
  if (!parsed.success) {
    throw new Error(`EZID unavailable error: ${parsed.message}`);
  }

  return getIdentifier(auth, identifier);
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Get the DOI resolver URL for an identifier.
 */
export function getDoiUrl(identifier: string): string {
  // Strip "doi:" prefix if present
  const doi = identifier.startsWith("doi:") ? identifier.substring(4) : identifier;
  return `https://doi.org/${doi}`;
}

/**
 * Extract the DOI value without the "doi:" prefix.
 */
export function extractDoi(identifier: string): string {
  return identifier.startsWith("doi:") ? identifier.substring(4) : identifier;
}

/**
 * Check if a shoulder is a test shoulder.
 */
export function isTestShoulder(shoulder: string): boolean {
  return shoulder === TEST_SHOULDER || shoulder.startsWith("doi:10.5072/");
}
