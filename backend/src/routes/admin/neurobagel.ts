/**
 * Admin routes for the Neurobagel artifact store (epic #1586, phase 4; ADR 0084):
 *
 *   GET  /admin/neurobagel/status        what is eligible, written, stale, waiting on a person
 *   POST /admin/neurobagel/regenerate    examine datasets and, on request, write what changed
 *   POST /admin/neurobagel/verify        run the verification sweep now (reports only)
 *
 * `regenerate` is a DRY RUN BY DEFAULT: it reports what it would write and remove
 * and touches nothing. Only an explicit boolean `execute: true` writes, and only when
 * the writer is enabled (`NEUROBAGEL_WRITER_ENABLED=1`); a string "true" is refused
 * rather than read as intent. The body is strict, so a misspelled key is a 400 and not
 * a silent dry run.
 *
 * The per-call work bound is the same one the cron honors (`NEUROBAGEL_RECONCILE_MAX`,
 * default 10), raisable per call with `limit` up to the hard ceiling of 50, because a
 * first backfill of every dataset is this route's second job and takes several calls.
 * A call that spends its operation budget first stops early and says so (`stopped`,
 * `unexamined`); run it again. `force` rewrites even when the
 * fingerprint matches, the one lever for a change the fingerprint cannot see (a new
 * data-plane metadata builder; see neurobagel-fingerprint.ts).
 *
 * `verify` runs the verification sweep on demand (epic #1586, phase 6) and works on staging:
 * the sweep function is unguarded, only its cron wrapper is production-only. It REPORTS and
 * never repairs, writes only its own heartbeat (as an `admin` run, which the weekly report
 * does not count) and returns counts, never a dataset id. It takes no body.
 *
 * Admin-only through the router's `authMiddleware` and `adminMiddleware`. The result
 * carries counts, dataset ids and codes, never participant data, and the anonymity-
 * class findings as a COUNT.
 */

import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { auditLogStatement } from "../../db/audit-log";
import { isValidDatasetId } from "../../services/datasetId";
import { neurobagelStatus } from "../../services/neurobagel-status";
import { runNeurobagelVerificationSweep } from "../../services/neurobagel-verify";
import {
  RECONCILE_HARD_LIMIT,
  neurobagelWriterMode,
  runNeurobagelWriter,
} from "../../services/neurobagel-writer";
import type { AdminRouter } from "./shared";

export const regenerateSchema = z
  .object({
    execute: z.boolean().optional(),
    datasets: z
      .array(z.string().refine(isValidDatasetId, "not a dataset id"))
      .min(1)
      .max(RECONCILE_HARD_LIMIT)
      .optional(),
    // The same ceiling the writer clamps to: a call runs inline in one request, so a larger
    // number is refused here rather than silently shortened (ADR 0084, "What a run costs").
    limit: z.number().int().min(1).max(RECONCILE_HARD_LIMIT).optional(),
    force: z.boolean().optional(),
  })
  .strict();

export function registerNeurobagelRoutes(admin: AdminRouter): void {
  admin.get("/neurobagel/status", async (c) => {
    try {
      return c.json(await neurobagelStatus(c.env));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[neurobagel] status failed:", message);
      return c.json({ error: `Neurobagel status failed: ${message}` }, 500);
    }
  });

  admin.post("/neurobagel/verify", async (c) => {
    // The sweep contains its own failures (a throw becomes an unknown verdict), so this
    // answers 200 whatever it found: the verdicts are the answer.
    return c.json(await runNeurobagelVerificationSweep(c.env, { trigger: "admin" }));
  });

  admin.post("/neurobagel/regenerate", zValidator("json", regenerateSchema), async (c) => {
    const body = c.req.valid("json");
    const execute = body.execute === true;
    const user = c.get("user");

    // A real run needs the switch. Say so with 409 before any work is planned.
    if (execute && neurobagelWriterMode(c.env) !== "enabled") {
      return c.json(
        {
          error:
            neurobagelWriterMode(c.env) === "disabled"
              ? "The Neurobagel writer is disabled: set NEUROBAGEL_WRITER_ENABLED to 1 to write. A dry run (omit execute) works without it."
              : "No NEUROBAGEL bucket is bound, so there is nothing to write to.",
          status: neurobagelWriterMode(c.env),
        },
        409,
      );
    }

    const waitUntil = (() => {
      try {
        const ctx = c.executionCtx;
        return (work: Promise<unknown>) => ctx.waitUntil(work);
      } catch {
        return undefined;
      }
    })();

    const result = await runNeurobagelWriter(c.env, {
      trigger: "admin",
      execute,
      only: body.datasets,
      // A list names its datasets, so it is bounded by its own length; without one the
      // per-tick bound applies. Either way the hard ceiling holds (the writer clamps).
      limit: body.limit ?? body.datasets?.length,
      force: body.force === true,
      waitUntil,
    });

    if (execute) {
      try {
        await auditLogStatement(c.env.DB, {
          userId: user?.id ?? null,
          action: "neurobagel_regenerate",
          resourceType: "neurobagel",
          resourceId: "admin",
          details: JSON.stringify({
            datasets: body.datasets ?? null,
            limit: result.limit,
            force: body.force === true,
            status: result.status,
            examined: result.examined,
            written: result.results.filter((r) => r.outcome === "written").length,
            removed: result.removed.length,
          }),
        }).run();
      } catch (err) {
        result.warnings.push(
          `audit row failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (result.status === "error") return c.json(result, 500);
    return c.json(result);
  });
}
