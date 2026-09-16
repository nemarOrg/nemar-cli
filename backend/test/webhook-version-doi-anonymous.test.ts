/**
 * A version DOI is never dispatched for an anonymous deposit (#1408, epic
 * #1406).
 *
 * `services/doi.ts` mints AND publishes a version DOI in one pass -- the call
 * to `makePublic` is unconditional -- so a dispatch here puts a resolving,
 * harvested DataCite record into the world. For an anonymous deposit that is
 * the one thing the whole feature exists to prevent, and it is not reachable
 * through the publication orchestrator (which drops `version_doi` from the
 * step set) but through the depositor's own `nemar dataset release`, which
 * pushes exactly the `v*` tag this handler listens for.
 *
 * Dev-range (`xx09`) dataset ids, because the worker short-circuits a
 * prod-range repo on a non-production worker before any of this
 * (`prod_range_repo_on_dev_worker`, epic #923) and the anonymity gate would
 * never be reached. The gate itself does not care which band the id is in.
 *
 * Real Hono app, real WebCrypto HMAC, real bun:sqlite with every migration.
 * The anonymous path returns before `triggerVersionDoiRun`, so no network call
 * is made; the non-anonymous control reaches the trigger and fails there,
 * which is what makes it a control -- it proves the gate, and not the absence
 * of a GitHub token, is what stopped the first case.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerGithubWebhookRoutes } from "../src/routes/webhooks/github";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const SECRET = "test-webhook-secret";

async function sign(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return `sha256=${Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

function seed(db: Database, datasetId: string, anonymous: number): void {
  db.run(
    `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
     VALUES (11, 'tagger', 'tagger@example.org', 'x', 'approved', 'member', 1)
     ON CONFLICT(id) DO NOTHING`,
  );
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                           github_repo, anonymous, concept_doi)
     VALUES (?, 'A sufficiently descriptive dataset title', 11, 'active', 'public', 0, ?, ?, ?)`,
  ).run(datasetId, `nemarDatasets/${datasetId}`, anonymous, "10.82901/reserved-test");
}

/** A `v*` tag push, the shape `nemar dataset release` produces. */
function tagPush(datasetId: string) {
  return {
    ref: "refs/tags/v1.0.0",
    deleted: false,
    repository: { name: datasetId, owner: { login: "nemarDatasets" } },
    commits: [],
  };
}

interface WebhookAnswer {
  status: number;
  errors?: Record<string, string>;
  runs?: Record<string, unknown>;
}

async function post(db: Database | null, payload: unknown): Promise<WebhookAnswer> {
  const app = new Hono<{ Bindings: Bindings }>();
  registerGithubWebhookRoutes(app);
  const body = JSON.stringify(payload);
  const req = new Request("http://localhost/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-GitHub-Event": "push",
      "X-GitHub-Delivery": "anon-version-doi",
      "X-Hub-Signature-256": await sign(body, SECRET),
    },
    body,
  });
  const ctx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const res = await app.fetch(
    req,
    {
      GITHUB_WEBHOOK_SECRET: SECRET,
      ENVIRONMENT: "test",
      ...(db ? { DB: realD1(db) } : {}),
    } as Bindings,
    ctx,
  );
  // A request that gets PAST the gate goes on to fetch GitHub credentials,
  // which this environment does not have, so it 500s with a non-JSON body.
  // That is the control's signal, not a failure of the test: it is how we can
  // tell "refused before any credential was needed" from "allowed through".
  const text = await res.text();
  try {
    return { status: res.status, ...(JSON.parse(text) as Omit<WebhookAnswer, "status">) };
  } catch {
    return { status: res.status };
  }
}

describe("a pushed version tag does not mint a DOI for a concealed deposit", () => {
  test("an anonymous deposit is refused before a credential is even fetched", async () => {
    // 200 with the reason, and no dispatch. The refusal costs no GitHub token,
    // which is deliberate: a token outage must not be able to change this
    // answer into a mint.
    const db = freshDb();
    seed(db, "xx090890", 1);
    const answer = await post(db, tagPush("xx090890"));
    expect(answer.status).toBe(200);
    expect(answer.errors?.version_doi).toBe("anonymous_deposit");
    expect(answer.runs?.version_doi).toBeUndefined();
    db.close();
  });

  test("an ordinary dataset is let through, which is what makes that a gate", async () => {
    // The discriminating control. Without it a handler that refused EVERY
    // version-DOI dispatch would satisfy the assertion above. This one is not
    // refused: it goes on to fetch GitHub credentials, which this environment
    // does not have, so it fails there instead -- past the gate, and for a
    // different reason.
    const db = freshDb();
    seed(db, "xx090891", 0);
    const answer = await post(db, tagPush("xx090891"));
    expect(answer.errors?.version_doi).toBeUndefined();
    expect(answer.status).toBe(500);
    db.close();
  });

  test("a dataset row that cannot be read is refused too", async () => {
    // Fail closed. Unreadable state is not permission to mint: a version DOI
    // is permanent, and skipping one costs a re-pushed tag. A row that is
    // simply absent takes the same branch for the same reason.
    const db = freshDb();
    const answer = await post(db, tagPush("xx090892"));
    expect(answer.status).toBe(200);
    expect(answer.errors?.version_doi).toBe("anonymous_deposit");
    db.close();
  });

  test("a throwing database is refused rather than treated as not anonymous", async () => {
    // The catch at the gate. With no DB binding at all the read throws, and
    // the handler must still refuse.
    const answer = await post(null, tagPush("xx090893"));
    expect(answer.status).toBe(200);
    expect(answer.errors?.version_doi).toBe("anonymous_deposit");
  });

  test("a tag DELETE is still ignored, before any of this", async () => {
    // The pre-existing rule this gate must not have disturbed.
    const db = freshDb();
    seed(db, "xx090894", 1);
    const answer = await post(db, { ...tagPush("xx090894"), deleted: true });
    expect(answer.errors?.version_doi).toBeUndefined();
    db.close();
  });
});
