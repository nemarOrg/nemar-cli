/**
 * Admin routes: the record of an upstream re-pull (epic #1046 phase 6, #1912; ADR 0111,
 * decision 3).
 *
 *   POST /admin/repulls                  create the record, or return the open one for the same plan
 *   GET  /admin/repulls                  list (`dataset`, `open`, `after`, `limit` up to 50)
 *   GET  /admin/repulls/:id              one record
 *   POST /admin/repulls/:id/transition   move it along one allowed edge
 *
 * These routes record and refuse. They copy nothing, push nothing, open no pull request and send
 * no mail: execution runs on an administrator's machine and reports each step here, and the dev
 * database holds real addresses, so nothing here is allowed to reach a person. A refusal is
 * `{ error, code }`; the codes are the API. Admin role, as every `/admin` route.
 */

import { zValidator } from "@hono/zod-validator";
import { isValidDatasetId } from "../../services/datasetId";
import {
  createRepull,
  createRepullSchema,
  getRepull,
  isRefusal,
  listRepulls,
  transitionRepull,
  transitionSchema,
} from "../../services/upstream-repull";
import type { AdminRouter } from "./shared";

function failure(what: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[upstream-repulls] ${what} failed:`, msg);
  return `Failed to ${what} (is migration 0105 applied?): ${msg}`;
}

function parseId(raw: string): number | null {
  return /^[1-9]\d{0,14}$/.test(raw) ? Number(raw) : null;
}

export function registerUpstreamRepullRoutes(admin: AdminRouter): void {
  admin.post("/repulls", zValidator("json", createRepullSchema), async (c) => {
    const user = c.get("user");
    try {
      const result = await createRepull(c.env, { id: user.id }, c.req.valid("json"));
      if (isRefusal(result)) {
        return c.json(
          { error: result.message, code: result.code, repull: result.row },
          result.status,
        );
      }
      return c.json({ repull: result.row, created: result.created }, result.created ? 201 : 200);
    } catch (err) {
      return c.json({ error: failure("record the re-pull", err) }, 500);
    }
  });

  admin.get("/repulls", async (c) => {
    const dataset = c.req.query("dataset");
    if (dataset !== undefined && !isValidDatasetId(dataset)) {
      return c.json({ error: "`dataset` must be a dataset id" }, 400);
    }
    const openRaw = c.req.query("open");
    if (openRaw !== undefined && !["1", "true", "0", "false"].includes(openRaw)) {
      return c.json({ error: "`open` must be 1, true, 0 or false" }, 400);
    }
    const afterRaw = c.req.query("after");
    const after = afterRaw === undefined ? undefined : parseId(afterRaw);
    if (after === null) return c.json({ error: "`after` must be a re-pull id" }, 400);
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 50)) {
      return c.json({ error: "`limit` must be an integer from 1 to 50" }, 400);
    }
    try {
      const repulls = await listRepulls(c.env.DB, {
        dataset,
        open: openRaw === "1" || openRaw === "true",
        after,
        limit,
      });
      return c.json({
        repulls,
        next_after: repulls.length === (limit ?? 25) ? (repulls.at(-1)?.id ?? null) : null,
      });
    } catch (err) {
      return c.json({ error: failure("read the re-pulls", err) }, 500);
    }
  });

  admin.get("/repulls/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "the id must be a re-pull id" }, 400);
    try {
      const row = await getRepull(c.env.DB, id);
      if (!row) return c.json({ error: `No re-pull #${id}.`, code: "not-found" }, 404);
      return c.json({ repull: row });
    } catch (err) {
      return c.json({ error: failure("read the re-pull", err) }, 500);
    }
  });

  admin.post("/repulls/:id/transition", zValidator("json", transitionSchema), async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "the id must be a re-pull id" }, 400);
    const user = c.get("user");
    try {
      const result = await transitionRepull(c.env, { id: user.id }, id, c.req.valid("json"));
      if (isRefusal(result)) {
        return c.json(
          { error: result.message, code: result.code, repull: result.row },
          result.status,
        );
      }
      return c.json({ repull: result.row });
    } catch (err) {
      return c.json({ error: failure("move the re-pull", err) }, 500);
    }
  });
}
