/**
 * The reads behind the administrator's decision card (ADR 0142, decisions 3 and 4), kept apart from
 * the pure builder (`decision-card.ts`) and from the review's derivation, which makes no GitHub
 * call (`publication-review-view.ts`).
 *
 *  - The review in force's snapshot of what its job was served (`served_metadata`, migration 0163)
 *    and its `auto_deny_state`.
 *  - For a review without a snapshot (one from before the migration, or a request with no review
 *    served): the enrichment D1 holds now and `dataset_description.json` at the reviewed commit
 *    (or `main` with no review), which the card marks "not as reviewed".
 *  - When the review's lineage is `unresolved`: the lineage resolved again now, by the one Worker
 *    resolver (`resolveWorkerLineage`), over the same inputs the review's serve used (the
 *    description and README at the reviewed commit, D1's enrichment, the attestation's source), so
 *    the card can show it beside the review's own with both times.
 *
 * Read-only. A repository read that fails costs the card the fields it would have read (the
 * description, the fresher lineage), never the card and never the detail; it is logged with ids
 * and fixed words only.
 */

import type { DecisionCard } from "../../../shared/contract/decision-card.js";
import { permissionBasisOf } from "../../../shared/license-permission.js";
import { ENRICHMENT_SOURCE_RE } from "../../../shared/publication-review.js";
import { README_CANDIDATES } from "../../../shared/readme-candidates.js";
import type { Bindings } from "../types/bindings.js";
import { approvalInFlightSql } from "./approval-dispatch.js";
import {
  type CardDetail,
  type DecisionCardInput,
  buildDecisionCard,
  cardDescriptionOf,
  cardEnrichmentOf,
  cardLineageOf,
  parseServedMetadata,
} from "./decision-card.js";
import type { GateFacts } from "./decision-card.js";
import { getDatasetsToken } from "./github-auth.js";
import { LOOKUP_ONCE, getFileContent } from "./github/contents.js";
import { verifyScreenHead } from "./identifier-screen.js";
import { resolveWorkerLineage } from "./license-lineage-cache.js";
import { coveringPermission } from "./license-permission.js";
import { enrichmentFieldsOf } from "./publication-review-inputs.js";
import { errorWords } from "./publication-review-log.js";
import { extractRepoName } from "./repo-metadata.js";

function parseObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function upstreamSourceOf(attestation: string | null): string | null {
  const v = parseObject(attestation)?.upstream_source;
  return typeof v === "string" && v.trim() ? v : null;
}

/** The repository's description and README at `ref`, or null when the read failed. */
async function readRoot(
  env: Bindings,
  repo: string,
  ref: string,
  wantReadme: boolean,
): Promise<{ description: string | null; readme: string | null } | null> {
  try {
    const token = await getDatasetsToken(env);
    const description = await getFileContent(
      repo,
      "dataset_description.json",
      token,
      ref,
      LOOKUP_ONCE,
    );
    let readme: string | null = null;
    if (wantReadme) {
      for (const name of README_CANDIDATES) {
        readme = await getFileContent(repo, name, token, ref, LOOKUP_ONCE);
        if (readme !== null) break;
      }
    }
    return { description, readme };
  } catch (err) {
    console.error(`[decision-card] repository read failed (${errorWords(err)})`);
    return null;
  }
}

/**
 * The card's head lookup: one try, interactive, so a drained rate-limit bucket or a failing GitHub is
 * `unverified` at once instead of a sleep or a retry. The approval gate keeps its own default.
 */
export const CARD_HEAD_POLICY = LOOKUP_ONCE;

/**
 * What the approval's own gates read that the detail does not: whether the screened commit is still
 * `main`, by the approval path's own check (`verifyScreenHead`; a lookup that fails is
 * `unverified`, as the gate refuses it), and whether an approval run holds the request right now
 * (`approvalInFlightSql`, the dispatch claim's own test).
 */
async function gateFactsOf(env: Bindings, detail: CardDetail): Promise<GateFacts> {
  const r = await env.DB.prepare(
    `SELECT identifier_screen_status, identifier_screen_report, identifier_screen_ack_at,
            identifier_screen_ack_by, CASE WHEN ${approvalInFlightSql()} THEN 1 ELSE 0 END AS in_flight
       FROM publication_requests WHERE id = ?`,
  )
    .bind(detail.request_id)
    .first<{
      identifier_screen_status: string | null;
      identifier_screen_report: string | null;
      identifier_screen_ack_at: string | null;
      identifier_screen_ack_by: number | null;
      in_flight: number;
    }>();
  if (!r) return { head: "unverified", approvalInFlight: false };
  if (detail.screen_gate === "exempt")
    return { head: "exempt", approvalInFlight: r.in_flight === 1 };
  const outcome = await verifyScreenHead(env, detail.dataset_id, r, undefined, CARD_HEAD_POLICY);
  const head = outcome.ok ? "current" : outcome.refusal.gate === "stale" ? "stale" : "unverified";
  return { head, approvalInFlight: r.in_flight === 1 };
}

/** The card's inputs for one request's detail. Throws only when a D1 read fails. */
export async function decisionCardInputs(
  env: Bindings,
  detail: CardDetail,
): Promise<DecisionCardInput> {
  const db = env.DB;
  const review = detail.review;
  const row =
    review === null
      ? null
      : await db
          .prepare("SELECT served_metadata, auto_deny_state FROM publication_reviews WHERE id = ?")
          .bind(review.id)
          .first<{ served_metadata: string | null; auto_deny_state: string | null }>();
  const snapshot = parseServedMetadata(row?.served_metadata ?? null);
  const gate = await gateFactsOf(env, detail);

  const lineageOutcome = review?.evidence?.lineage?.outcome ?? snapshot?.lineage?.outcome ?? null;
  const needsFresh = lineageOutcome === "unresolved";
  if (snapshot !== null && !needsFresh) {
    return {
      detail,
      autoDenyState: row?.auto_deny_state ?? null,
      snapshot,
      current: null,
      freshLineage: null,
      freshCovered: false,
      gate,
    };
  }

  const dataset = await db
    .prepare(
      `SELECT github_repo, attestation, enrichment_json,
              json_extract(sweep_stamps, '$.enrichment_updated_at') AS enrichment_updated_at
         FROM datasets WHERE dataset_id = ?`,
    )
    .bind(detail.dataset_id)
    .first<{
      github_repo: string | null;
      attestation: string | null;
      enrichment_json: string | null;
      enrichment_updated_at: string | null;
    }>();
  const repo = dataset?.github_repo ? extractRepoName(dataset.github_repo) : null;
  const ref = review?.head_sha ?? "main";
  const root = repo === null ? null : await readRoot(env, repo, ref, needsFresh);

  let current: DecisionCardInput["current"] = null;
  if (snapshot === null) {
    const doc = parseObject(dataset?.enrichment_json ?? null);
    current = {
      enrichment: cardEnrichmentOf(doc === null ? null : enrichmentFieldsOf(doc, detail.anonymous)),
      enrichment_source:
        typeof dataset?.enrichment_updated_at === "string" &&
        ENRICHMENT_SOURCE_RE.test(dataset.enrichment_updated_at)
          ? dataset.enrichment_updated_at
          : null,
      dataset_description: cardDescriptionOf(root?.description ?? null, detail.anonymous),
    };
  }

  // Resolved again for the card (ADR 0142 decision 3): never from a read that failed.
  const fresh =
    needsFresh && root !== null
      ? await resolveWorkerLineage({
          datasetDescription: root.description,
          nemarMetadata: dataset?.enrichment_json ?? null,
          attestationUpstreamSource: upstreamSourceOf(dataset?.attestation ?? null),
          readme: root.readme,
        })
      : null;
  // A recorded permission counts for the fresher lineage only when it covers that lineage's own
  // basis (`permissionCovers`), never because it covered the review's.
  const freshCovered =
    fresh !== null &&
    (await coveringPermission(
      db,
      detail.dataset_id,
      detail.request_id,
      permissionBasisOf(fresh),
    )) !== null;

  return {
    detail,
    autoDenyState: row?.auto_deny_state ?? null,
    snapshot,
    current,
    freshLineage: fresh === null ? null : cardLineageOf(fresh),
    freshCovered,
    gate,
  };
}

/**
 * The decision card of a detail, or null when it could not be built (a D1 read failed): the detail
 * is still answered, without its card.
 */
export async function decisionCardFor(
  env: Bindings,
  detail: CardDetail,
): Promise<DecisionCard | null> {
  try {
    return buildDecisionCard(await decisionCardInputs(env, detail));
  } catch (err) {
    console.error(
      `[decision-card] could not build the card of ${detail.dataset_id} (${errorWords(err)})`,
    );
    return null;
  }
}
