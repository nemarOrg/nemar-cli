/**
 * The Neurobagel artifact store, read side (epic #1586, phase 4; ADR 0084):
 *
 *   GET /neurobagel/index.json     the index the node's loader reads
 *   GET /neurobagel/<name>         one artifact: <id>.jsonld, <id>_annotated.json,
 *                                  or <id>_dataset_description.json
 *
 * Flat on purpose: the loader builds `<base>/index.json` and `<base>/<name>`, with no
 * sub-directory (deploy/neurobagel/README.md, "Artifact store interface").
 *
 * AUTHENTICATED by one shared bearer secret, `NEUROBAGEL_READ_TOKEN`, compared in
 * constant time. It is a DEPLOYMENT secret, not an account credential: no user, key
 * or session mints it, so ending an account's credentials has nothing to cascade to
 * here (AGENTS.md, "Revocation cascades, always"; ADR 0084). The owner rotates it by
 * changing the Worker secret and the loader's header file together.
 *
 * Reads the bucket and nothing else. It never lists the bucket, never serves a name
 * the strict pattern does not accept (404 for everything else), and NEVER SERVES A
 * DATASET THE PREDICATE REJECTS AT REQUEST TIME: eligibility is re-checked against D1
 * on every artifact request, and the index is served filtered by the same check, so a
 * dataset that went private disappears from what the node reads the moment it does,
 * without waiting for the writer (ADR 0066's amendment makes the same argument for the
 * data plane's caches: the gate runs on every request, so nothing needs purging).
 *
 * `no-store` everywhere: every answer depends on a check made now.
 */

import { Hono } from "hono";
import { timingSafeEqual } from "../lib/constant-time.js";
import {
  eligibleAmong,
  federationContext,
  loadEligibleRow,
} from "../services/neurobagel-eligibility.js";
import {
  ARTIFACT_CONTENT_TYPE,
  META,
  NEUROBAGEL_INDEX_KEY,
  parseArtifactName,
  parseStoredIndex,
} from "../services/neurobagel-store.js";
import type { Bindings, Variables } from "../types/bindings.js";

export const neurobagelRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

function notFound(): Response {
  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: { "Content-Type": "application/json", ...HEADERS },
  });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": "Bearer",
      ...HEADERS,
    },
  });
}

/**
 * Configuration, then authentication, before anything else is read. With no bucket
 * or no token configured the route does not exist as far as a caller can tell (404):
 * an unconfigured deployment advertises nothing.
 */
neurobagelRoutes.use("*", async (c, next) => {
  const token = c.env.NEUROBAGEL_READ_TOKEN;
  if (!token || !c.env.NEUROBAGEL) return notFound();
  const match = /^Bearer (.+)$/.exec(c.req.header("Authorization") ?? "");
  if (!match || !timingSafeEqual(match[1] as string, token)) return unauthorized();
  await next();
});

neurobagelRoutes.get("/index.json", async (c) => {
  const bucket = c.env.NEUROBAGEL as R2Bucket;
  const object = await bucket.get(NEUROBAGEL_INDEX_KEY);
  if (!object) return notFound();
  const document = parseStoredIndex(await object.text());
  if (!document) {
    // Present and unusable is not "absent": the loader must fail this run, not read an empty release.
    return new Response(JSON.stringify({ error: "index_unreadable" }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...HEADERS },
    });
  }
  // The index as the writer last wrote it, minus every dataset the predicate rejects NOW.
  const eligible = await eligibleAmong(
    c.env.DB,
    document.datasets.map((d) => d.id),
    federationContext(c.env),
  );
  const served = { ...document, datasets: document.datasets.filter((d) => eligible.has(d.id)) };
  return new Response(`${JSON.stringify(served)}\n`, {
    status: 200,
    headers: { "Content-Type": "application/json", ...HEADERS },
  });
});

neurobagelRoutes.get("/:name", async (c) => {
  const parsed = parseArtifactName(c.req.param("name"));
  if (!parsed) return notFound();

  // The predicate, re-checked against D1 for THIS request.
  const { eligible } = await loadEligibleRow(c.env.DB, parsed.datasetId, federationContext(c.env));
  if (!eligible) return notFound();

  const object = await (c.env.NEUROBAGEL as R2Bucket).get(c.req.param("name"));
  // Only what the writer stamped: an object that merely has an artifact-shaped name is not one.
  if (!object || object.customMetadata?.[META.kind] !== parsed.kind) return notFound();

  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": ARTIFACT_CONTENT_TYPE[parsed.kind],
      "Content-Length": String(object.size),
      ETag: object.httpEtag,
      ...HEADERS,
    },
  });
});
