/**
 * Admin routes: the record of an upstream re-pull (epic #1046 phase 6, #1912; ADR 0111,
 * decision 3).
 *
 *   POST /admin/repulls                  create the record, or return the open one for the same plan
 *   GET  /admin/repulls                  list (`dataset`, `open`, `after`, `limit` up to 50)
 *   GET  /admin/repulls/switches         what the Worker reads of the automatic re-pull's
 *                                        switches and open cap (before `:id`, which would answer
 *                                        400 for "switches")
 *   GET  /admin/repulls/:id              one record
 *   POST /admin/repulls/:id/transition   move it along one allowed edge (the claim to merge is the
 *                                        gates-clear self-edge: screened head, dataset fences, a
 *                                        unit of REPULL_DAILY_MERGE_CAP; an administrator's claim
 *                                        may name a merge over a failed BIDS validation, whose
 *                                        facts it reads at the claimed head)
 *   GET  /admin/repulls/:id/screens      its identifier screens, newest first
 *   POST /admin/repulls/:id/screen       dispatch the screen of a pull request's recorded head
 *   POST /admin/repulls/:id/screen/acknowledge   record a reason on a screen that asks for one
 *   POST /admin/repulls/:id/merge-claim/release  clear a claim that was not sent, was refused, or
 *                                        is stuck (expired: its outcome unknown, long past)
 *   POST /admin/repulls/:id/merge-claim/check    whether a merge may be sent again under a held
 *                                        claim: the claim's age, the dataset fences, the screen
 *                                        for this administrator, the live head (writes nothing)
 *   POST /admin/repulls/:id/merged       record a merge, after reading it on GitHub
 *   POST /admin/repulls/:id/released     record a release, after reading the version row and tag
 *
 * These routes record, verify and refuse. They copy nothing, push nothing, open, merge or close
 * no pull request and send no mail: execution and the merge run on an administrator's machine
 * and report here, the Worker reads GitHub only to verify what it records, and the dev database
 * holds real addresses, so nothing here is allowed to reach a person. A refusal is
 * `{ error, code }`, a malformed request included (`invalid-body`, `invalid-query`, `invalid-id`);
 * the codes are the API. Admin role, as every `/admin` route.
 *
 * `lineage_recordable` on create is the administrator's assertion that the plan compared the
 * from-version's tree with upstream's. The Worker holds neither tree and cannot check it; it
 * records the assertion in the audit row and upgrades the version row only when that row names
 * the same tag (or none). An open record never expires by itself: a stuck claim is expired
 * through the claim's release (`expired`), which `nemar admin repull resume` sends.
 */

import { zValidator } from "@hono/zod-validator";
import { isValidDatasetId } from "../../services/datasetId";
import { repullSwitchesReport } from "../../services/repull-switches";
import {
  REPULL_PAGE_DEFAULT,
  REPULL_PAGE_MAX,
  type RepullRefusal,
  acknowledgeRepullScreen,
  acknowledgeScreenSchema,
  createRepull,
  createRepullSchema,
  dispatchRepullScreen,
  getRepull,
  isRefusal,
  listRepullScreens,
  listRepulls,
  screenTargetSchema,
  transitionRepull,
  transitionSchema,
} from "../../services/upstream-repull";
import { bidsOverrideRefusal } from "../../services/upstream-repull-merge";
import {
  checkHeldClaim,
  claimCheckSchema,
  mergedSchema,
  recordRepullMerged,
  recordRepullReleased,
  releaseClaimSchema,
  releaseMergeClaim,
  releasedSchema,
} from "../../services/upstream-repull-verified";
import type { AdminRouter } from "./shared";

/** A refusal as the API speaks it: the code, the message, and what it is about when that helps. */
function refusalBody(r: RepullRefusal) {
  return {
    error: r.message,
    code: r.code,
    repull: r.row,
    ...(r.screen ? { screen: r.screen } : {}),
    ...(r.merge_cap ? { merge_cap: r.merge_cap } : {}),
  };
}

/** Only a missing table or column suggests the migration is not applied; any other error is not that. */
function failure(what: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[upstream-repulls] ${what} failed:`, msg);
  const hint = /no such (table|column)/i.test(msg) ? " (is migration 0105 applied?)" : "";
  return `Failed to ${what}${hint}: ${msg}`;
}

function parseId(raw: string): number | null {
  return /^[1-9]\d{0,14}$/.test(raw) ? Number(raw) : null;
}

/** A zod failure as `{ error, code }`, naming the fields and never echoing a value. */
const invalidBody = (
  result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } },
  c: { json: (body: unknown, status: 400) => Response },
) => {
  if (result.success) return undefined;
  const issues = (result.error?.issues ?? [])
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`);
  return c.json(
    { error: `The request body is not valid: ${issues.join("; ")}`, code: "invalid-body" },
    400,
  );
};

export function registerUpstreamRepullRoutes(admin: AdminRouter): void {
  admin.post("/repulls", zValidator("json", createRepullSchema, invalidBody), async (c) => {
    const user = c.get("user");
    try {
      const result = await createRepull(c.env, { id: user.id }, c.req.valid("json"));
      if (isRefusal(result)) return c.json(refusalBody(result), result.status);
      return c.json(
        { repull: result.row, created: result.created, lineage_rows: result.lineage_rows },
        result.created ? 201 : 200,
      );
    } catch (err) {
      return c.json({ error: failure("record the re-pull", err) }, 500);
    }
  });

  admin.get("/repulls", async (c) => {
    const dataset = c.req.query("dataset");
    if (dataset !== undefined && !isValidDatasetId(dataset)) {
      return c.json({ error: "`dataset` must be a dataset id", code: "invalid-query" }, 400);
    }
    const openRaw = c.req.query("open");
    if (openRaw !== undefined && !["1", "true", "0", "false"].includes(openRaw)) {
      return c.json({ error: "`open` must be 1, true, 0 or false", code: "invalid-query" }, 400);
    }
    const afterRaw = c.req.query("after");
    const after = afterRaw === undefined ? undefined : parseId(afterRaw);
    if (after === null)
      return c.json({ error: "`after` must be a re-pull id", code: "invalid-query" }, 400);
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (
      limit !== undefined &&
      !(Number.isInteger(limit) && limit >= 1 && limit <= REPULL_PAGE_MAX)
    ) {
      return c.json(
        {
          error: `\`limit\` must be an integer from 1 to ${REPULL_PAGE_MAX}`,
          code: "invalid-query",
        },
        400,
      );
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
        next_after:
          repulls.length === (limit ?? REPULL_PAGE_DEFAULT) ? (repulls.at(-1)?.id ?? null) : null,
      });
    } catch (err) {
      return c.json({ error: failure("read the re-pulls", err) }, 500);
    }
  });

  // Registered before `/repulls/:id`: Hono matches in registration order, and `:id` would answer
  // 400 `invalid-id` for "switches". It reads the bindings and writes nothing; the answer holds
  // booleans and a cap reading, never a binding's raw value or a secret.
  admin.get("/repulls/switches", (c) => c.json({ switches: repullSwitchesReport(c.env) }));

  admin.get("/repulls/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null)
      return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
    try {
      const row = await getRepull(c.env.DB, id);
      if (!row) return c.json({ error: `No re-pull #${id}.`, code: "not-found" }, 404);
      return c.json({ repull: row });
    } catch (err) {
      return c.json({ error: failure("read the re-pull", err) }, 500);
    }
  });

  admin.post(
    "/repulls/:id/transition",
    zValidator("json", transitionSchema, invalidBody),
    async (c) => {
      const id = parseId(c.req.param("id"));
      if (id === null)
        return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
      const user = c.get("user");
      try {
        // A claim to merge that names a merge over a failed BIDS validation has its facts read
        // here, at the claimed head; no other caller of the transition passes the reader.
        const result = await transitionRepull(c.env, { id: user.id }, id, c.req.valid("json"), {
          verifyBidsOverride: bidsOverrideRefusal,
        });
        if (isRefusal(result)) return c.json(refusalBody(result), result.status);
        return c.json({ repull: result.row });
      } catch (err) {
        return c.json({ error: failure("move the re-pull", err) }, 500);
      }
    },
  );

  admin.get("/repulls/:id/screens", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null)
      return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
    try {
      const result = await listRepullScreens(c.env.DB, id);
      if (isRefusal(result)) return c.json(refusalBody(result), result.status);
      return c.json(result);
    } catch (err) {
      return c.json({ error: failure("read the re-pull's screens", err) }, 500);
    }
  });

  admin.post(
    "/repulls/:id/screen",
    zValidator("json", screenTargetSchema, invalidBody),
    async (c) => {
      const id = parseId(c.req.param("id"));
      if (id === null)
        return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
      const user = c.get("user");
      try {
        const result = await dispatchRepullScreen(c.env, { id: user.id }, id, c.req.valid("json"));
        if (isRefusal(result)) return c.json(refusalBody(result), result.status);
        const o = result.outcome;
        switch (o.kind) {
          case "exempt":
            return c.json({ exempt: true, dispatched: false, screen: null });
          case "dispatched":
            return c.json({ exempt: false, dispatched: true, screen: o.screen }, 202);
          case "exists":
            return c.json(
              {
                error: `A screen of this commit is ${o.screen.waiting ? "running" : "recorded"} (gate: ${o.screen.gate}); it is dispatched again only when it produced no verdict.`,
                code: "screen-exists",
                screen: o.screen,
              },
              409,
            );
          case "failed":
            return c.json(
              {
                error:
                  o.error === "dispatch-unconfigured"
                    ? "The screen could not be started: the Worker lacks the callback secret, the API base or a GitHub credential. It is recorded as an error, which no gate passes."
                    : "The screen could not be dispatched to GitHub. It is recorded as an error, which no gate passes; dispatch it again.",
                code: o.error,
                screen: o.screen,
              },
              o.error === "dispatch-unconfigured" ? 503 : 502,
            );
        }
      } catch (err) {
        return c.json({ error: failure("screen the re-pull", err) }, 500);
      }
    },
  );

  admin.post(
    "/repulls/:id/screen/acknowledge",
    zValidator("json", acknowledgeScreenSchema, invalidBody),
    async (c) => {
      const id = parseId(c.req.param("id"));
      if (id === null)
        return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
      const user = c.get("user");
      try {
        const result = await acknowledgeRepullScreen(
          c.env,
          { id: user.id },
          id,
          c.req.valid("json"),
        );
        if (isRefusal(result)) return c.json(refusalBody(result), result.status);
        return c.json({ screen: result.screen });
      } catch (err) {
        return c.json({ error: failure("acknowledge the screen", err) }, 500);
      }
    },
  );

  admin.post(
    "/repulls/:id/merge-claim/release",
    zValidator("json", releaseClaimSchema, invalidBody),
    async (c) => {
      const id = parseId(c.req.param("id"));
      if (id === null)
        return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
      const user = c.get("user");
      try {
        const result = await releaseMergeClaim(c.env, { id: user.id }, id, c.req.valid("json"));
        if (isRefusal(result)) return c.json(refusalBody(result), result.status);
        return c.json({ repull: result.row });
      } catch (err) {
        return c.json({ error: failure("release the claim", err) }, 500);
      }
    },
  );

  admin.post(
    "/repulls/:id/merge-claim/check",
    zValidator("json", claimCheckSchema, invalidBody),
    async (c) => {
      const id = parseId(c.req.param("id"));
      if (id === null)
        return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
      const user = c.get("user");
      try {
        const result = await checkHeldClaim(c.env, { id: user.id }, id, c.req.valid("json"));
        if (isRefusal(result)) return c.json(refusalBody(result), result.status);
        return c.json({ repull: result.row });
      } catch (err) {
        return c.json({ error: failure("check the claim", err) }, 500);
      }
    },
  );

  admin.post("/repulls/:id/merged", zValidator("json", mergedSchema, invalidBody), async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null)
      return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
    const user = c.get("user");
    try {
      const result = await recordRepullMerged(c.env, { id: user.id }, id, c.req.valid("json"));
      if (isRefusal(result)) return c.json(refusalBody(result), result.status);
      return c.json({
        repull: result.row,
        merged_outside_tool: result.merged_outside_tool,
        merged_unscreened_head: result.merged_unscreened_head,
        replayed: result.replayed,
      });
    } catch (err) {
      return c.json({ error: failure("record the merge", err) }, 500);
    }
  });

  admin.post(
    "/repulls/:id/released",
    zValidator("json", releasedSchema, invalidBody),
    async (c) => {
      const id = parseId(c.req.param("id"));
      if (id === null)
        return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
      const user = c.get("user");
      try {
        const result = await recordRepullReleased(c.env, { id: user.id }, id, c.req.valid("json"));
        if (isRefusal(result)) return c.json(refusalBody(result), result.status);
        return c.json({
          repull: result.row,
          lineage_rows: result.lineage_rows,
          stamps_rearmed: result.stamps_rearmed,
          replayed: result.replayed,
        });
      } catch (err) {
        return c.json({ error: failure("record the release", err) }, 500);
      }
    },
  );
}
