/**
 * Public surface of the Neurobagel transform (epic #1586).
 * Everything here is pure: no I/O, no Node-only APIs, no wasm, so it runs in the
 * Cloudflare Worker and in Bun scripts alike.
 */

export { canonicalJson } from "./canonical-json";
export { NEMAR_NEUROBAGEL_NAMESPACE, nbIdentifier, uuid5 } from "./identifiers";
export {
  metadataSchema,
  type NemarMetadata,
  type NeurobagelInput,
  participantsJsonSchema,
} from "./input-schema";
export type { ColumnReport, NeurobagelReport, TableStatus } from "./report";
export {
  artifactFileNames,
  buildNeurobagelArtifacts,
  type NeurobagelArtifacts,
  NeurobagelRefusal,
  type RefusalCode,
} from "./transform";
export { NEUROBAGEL_TRANSFORM_VERSION } from "./version";
export { VOCAB } from "./vocab";
