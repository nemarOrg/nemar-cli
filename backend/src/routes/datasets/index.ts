/**
 * Datasets router (#906, epic #902).
 *
 * The former monolithic routes/datasets.ts, split by concern. Each concern
 * file registers its handlers on this single shared router, so routing
 * semantics (path matching, per-route middleware) are identical to the
 * pre-split monolith. There is deliberately NO router-level middleware —
 * auth is wired per-route. The route inventory is pinned by
 * test/datasets-route-inventory.unit.test.ts.
 */

import { Hono } from "hono";
import { registerCatalogRoutes } from "./catalog";
import { registerCollaboratorRoutes } from "./collaborators";
import { registerDraftDeleteRoutes } from "./draft-delete";
import { registerManifestRoutes } from "./manifests";
import { registerPublicationRoutes } from "./publication";
import type { DatasetsRouter } from "./shared";
import { registerUploadRoutes } from "./upload";

export const datasetRoutes: DatasetsRouter = new Hono();

// Monolith registration order preserved within each concern file; across
// files only structurally disjoint paths interleave (see the inventory pin).
registerUploadRoutes(datasetRoutes);
registerCatalogRoutes(datasetRoutes);
registerCollaboratorRoutes(datasetRoutes);
registerDraftDeleteRoutes(datasetRoutes);
registerPublicationRoutes(datasetRoutes);
registerManifestRoutes(datasetRoutes);
