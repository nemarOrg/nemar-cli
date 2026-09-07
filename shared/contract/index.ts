/**
 * NEMAR wire contract — single source of truth for the response shapes the CLI,
 * website, data plane, and third parties exchange (epic #896, #898).
 *
 * Authored in Zod, zero deps beyond zod, no imports from src/ or backend/ — so
 * this whole directory lifts verbatim into a standalone @nemar/contract package
 * (follow-up: publish to npm + emit OpenAPI/JSON-Schema at api.nemar.org).
 *
 * The dataset shape conforms to neuroschema v0.4.0 (NEUROSCHEMA_VERSION),
 * enforced against the vendored JSON Schema in the contract tests.
 */

export * from "./version.js";
export * from "./user.js";
export * from "./dataset.js";
export * from "./publication.js";
export * from "./identity.js";
// Zero-dep string tables, not zod shapes: the copy every surface prints for a
// tier, an upload-access state or a missing profile field, and the matrix that
// decides which fields are missing (#1268, ADR 0045).
export * from "./account-copy.js";
export * from "./profile-gaps.js";
