/**
 * The compute gateway's routes, mounted at `/compute` (epic #2005 phase A5, #2010; ADR 0118).
 *
 *   POST /compute/jobs/:id/bundle             the launcher, with its job token (no session)
 *   POST /compute/jobs/:id/outputs            the launcher, with its job token (no session)
 *   POST /compute/jobs/:id/outputs/complete   the launcher, with its job token (no session)
 *
 * The callbacks are registered FIRST and carry no middleware of their own beyond the Worker's global
 * ones: the launcher has no account. Every route that has a person behind it declares its own
 * authentication on the route (there is no `use("*")` here, which would put a session in front of a
 * launcher). `backend/test/compute-route-inventory.test.ts` pins every entry of this router.
 */

import { Hono } from "hono";
import type { Bindings, Variables } from "../types/bindings.js";
import { registerComputeJobCallbackRoutes } from "./callbacks/compute-job-callbacks.js";

export const computeRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

registerComputeJobCallbackRoutes(computeRoutes);
