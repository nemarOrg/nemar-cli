/**
 * NEMAR wire contract — single source of truth for the response shapes the CLI,
 * website, data plane, and third parties exchange (epic #896, #898).
 *
 * Authored in Zod, zero deps beyond zod, no imports from src/ or backend/ — so
 * this whole directory lifts verbatim into a standalone @nemar/contract package
 * (follow-up: publish to npm + emit OpenAPI/JSON-Schema at api.nemar.org).
 *
 * The dataset shape conforms to neuroschema v0.4.1 (NEUROSCHEMA_VERSION),
 * enforced against the vendored JSON Schema in the contract tests.
 */

export * from "./version.js";
export * from "./user.js";
export * from "./dataset.js";
export * from "./publication.js";
export * from "./identity.js";
export * from "./device-auth.js";
// Zero-dep string tables, not zod shapes: the copy every surface prints for a
// tier, an upload-access state or a missing profile field, and the matrix that
// decides which fields are missing (#1268, ADR 0045).
export * from "./account-copy.js";
export * from "./profile-gaps.js";
// Zarr serving index v3 reader and the MCP server's wire contract (issue
// #1293, phase 1 of epic #1065; ADR 0049).
export * from "./zarr-index.js";
export * from "./mcp.js";
// Zero-dep literals and types for the private site's session handoff and the
// service-binding entrypoint its Worker calls (ADR 0078, ADR 0079).
export * from "./private-site.js";
// The compute gateway: the job specification, partition and rate tables, owner policy and the
// launcher's file shapes (epic #2005, ADR 0118). Its words live in `../compute-state.ts`.
export * from "./compute.js";
// The routes of the compute allocation ledger and owner policy: error words, request shapes and
// the OPEN response schemas the CLI parses (epic #2005 phase A2).
export * from "./compute-admin.js";
// Compute access: a person's one request and an administrator's decisions (epic #2021 phase D1).
export * from "./compute-access.js";
export * from "./compute-terms.js";
// A person's compute read routes and the partner's aggregate: bounds, error words and the OPEN response
// schemas (epic #2021 phase D2).
export * from "./compute-user.js";
// A person's job submission and the code bundle it carries: the caps, the manifest rule, the request and
// the OPEN responses (epic #2021 phase D3, #2024).
export * from "./compute-bundle.js";
export * from "./compute-submit.js";
// The strict-by-design REQUESTS of the same routes (the Worker validates them as they come in).
export * from "./compute-submit-request.js";
// The partner contract: a partner's reserve, report and release, the OPEN responses, the refusal words
// and their sentences (epic #2021 phase D4, #2025), and the strict-by-design REQUESTS beside them.
export * from "./compute-partner.js";
export * from "./compute-partner-request.js";
