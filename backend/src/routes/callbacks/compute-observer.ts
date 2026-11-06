/**
 * The observer's post (epic #2005 phase A7, #2012; ADR 0118, decision 8; design section 8):
 *
 *   POST /compute/observer     Expanse's queue summary and `sacct` export, with a token for ONE run
 *
 * The observer runs on the cluster and holds no account: it is an UNSIGNED SENDER with a token an
 * administrator minted for one run (`mintObserverRun`), sent in the header `X-Compute-Observer-Token`
 * (never in a URL, which reaches logs). The route follows `routes/callbacks/repull-state.ts`: a bounded
 * body, a token checked in constant time against the run row, and ONE refusal for every reason the token
 * is not accepted (a wrong token, a spent run, an expired run, an unknown run, no header), the same
 * status and body, so the door says nothing about which runs exist or why it refused.
 *
 * Order: the token is checked FIRST, before a byte of the body is read (a door open to anyone must not
 * spend memory on a stranger's payload), then the body is read under 1 MiB, validated, and only then is
 * the run spent. A body that fails validation does not spend the run. Nothing is logged but counts: no
 * token, no job id, no body.
 */

import type { Hono } from "hono";
import {
  OBSERVER_BODY_MAX_BYTES,
  OBSERVER_TOKEN_HEADER,
  ObserverBodySchema,
  authorizeObserverRun,
  ingestObserverPost,
} from "../../services/compute-observer.js";
import type { Bindings, Variables } from "../../types/bindings.js";
import { readBoundedJsonObject } from "./bounded-json.js";

type Router = Hono<{ Bindings: Bindings; Variables: Variables }>;

/** The one refusal of a token: never says why. */
export const OBSERVER_REFUSAL = { error: "Not accepted.", code: "observer_refused" } as const;

export function registerComputeObserverRoute(router: Router): void {
  router.post("/observer", async (c) => {
    const run = await authorizeObserverRun(c.env, c.req.header(OBSERVER_TOKEN_HEADER) ?? "");
    if (run === null) return c.json(OBSERVER_REFUSAL, 403);
    const read = await readBoundedJsonObject(c, OBSERVER_BODY_MAX_BYTES);
    if (!read.ok) {
      return c.json(
        { error: "The post is not valid.", code: "invalid_post" },
        read.status === 413 ? 413 : 400,
      );
    }
    const parsed = ObserverBodySchema.safeParse(read.body);
    if (!parsed.success) {
      // The paths and codes of what is wrong, never a value the sender wrote.
      const fields = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "body"}: ${i.code}`);
      return c.json({ error: "The post is not valid.", code: "invalid_post", fields }, 400);
    }
    const result = await ingestObserverPost(c.env, run.id, parsed.data);
    if (result === null) return c.json(OBSERVER_REFUSAL, 403);
    console.log(
      `[compute-observer] ingested snapshots=${result.snapshots} rows=${result.sacctRows} matched=${result.matched} settled=${result.settled} mismatched=${result.mismatched} unmatched=${result.unmatched}`,
    );
    return c.json({ ok: true, ...result });
  });
}
