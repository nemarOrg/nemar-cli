/**
 * Deterministic Neurobagel identifiers (RFC 4122 version 5, SHA-1).
 *
 * Neurobagel's own tools mint a random uuid4 for every node, so two runs over
 * the same dataset give two disjoint graphs.
 * NEMAR instead derives every identifier from a name, so regenerating a
 * dataset can never churn an id and a node that reloads yesterday's file next
 * to today's sees the same nodes.
 *
 * Names are URLs under https://nemar.org/dataset/<id>:
 *   dataset            https://nemar.org/dataset/nm000132
 *   subject            .../nm000132/sub-001
 *   phenotypic session .../nm000132/sub-001/phenotypic/ses-unnamed
 *   imaging session    .../nm000132/sub-001/imaging/ses-unnamed
 *   acquisition        .../nm000132/sub-001/imaging/ses-unnamed/eeg
 * The kind segment keeps a phenotypic and an imaging session that share a
 * label from colliding on one id.
 *
 * SHA-1 comes from Web Crypto, so the same module runs in the Worker and in
 * Bun with no dependency and no wasm.
 * Version 5 only needs SHA-1 as a name hash, not for security.
 */

/**
 * The namespace every NEMAR Neurobagel identifier is derived under.
 *
 * COMMITTED ONCE. Changing this value changes every identifier in every
 * dataset graph at once: a node loaded from the old files and the new files
 * would hold two copies of every dataset, and anything that remembered an id
 * (a registered node, a bookmark, a diff) would silently point at nothing.
 * It is a random version 4 UUID chosen for this purpose, not derived from
 * anything, and it is not a secret.
 */
export const NEMAR_NEUROBAGEL_NAMESPACE = "df8e9091-cb02-4426-ba88-973cf2e050f9";

/** Neurobagel's identifier prefix: `nb:` followed by a UUID. */
const NB_IDENTIFIER_PREFIX = "nb:";

/** The name every identifier of one dataset extends. */
export function datasetName(datasetId: string): string {
  return `https://nemar.org/dataset/${datasetId}`;
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`not a UUID: ${uuid}`);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** RFC 4122 section 4.3: the UUID a namespace and a name determine. */
export async function uuid5(namespace: string, name: string): Promise<string> {
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(16 + nameBytes.length);
  input.set(uuidToBytes(namespace), 0);
  input.set(nameBytes, 16);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

/** `nb:<uuid5>` for a name under the NEMAR namespace. */
export async function nbIdentifier(name: string): Promise<string> {
  return `${NB_IDENTIFIER_PREFIX}${await uuid5(NEMAR_NEUROBAGEL_NAMESPACE, name)}`;
}
