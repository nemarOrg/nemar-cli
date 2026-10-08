/**
 * A publication request made while BIDS validation is still pending or running
 * must still meet the submission minimums (ADR 0026) and the anonymity blind
 * check (ADR 0065), at both places a request is decided: the request route and
 * the blocked-request sweep that releases it once CI passes.
 *
 * A request right after an upload is nearly always pending, so the sweep is the
 * default path to `requested`. Before the shared gate, that path skipped the
 * minimums altogether: a named depositor could be released under the blind
 * label, which cannot be undone, and a request that met no minimum was queued
 * for an administrator anyway.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the
 * real auth middleware, the real route through Hono's `app.request()`, and the
 * real exported sweep. GitHub is a `Bun.serve()` stand-in for api.github.com
 * (NEMAR_GITHUB_API_URL) whose workflow runs and dataset_description.json the
 * tests change between a request and the sweep, which is the case that matters.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { datasetRoutes } from "../src/routes/datasets";
import { sweepBlockedBidsValidationRequests } from "../src/services/publication-sweep";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { withFakeResend } from "./helpers/resend";

const OWNER_KEY = "pending-gate-owner-key-0123456789abcdef0123456789abcdef";
const NAMELESS_KEY = "pending-gate-nameless-key-0123456789abcdef0123456789abcdef";
const DATASET = "nm000480";
const OWNER_EMAIL = "pendinggate@example.org";

const NAME = "A sufficiently descriptive dataset title";
const ETHICS = ["Approved by an institutional review board"];
const describe_ = (name: string, authors: string[]) =>
  JSON.stringify({ Name: name, Authors: authors, EthicsApprovals: ETHICS });
const NAMED = describe_(NAME, ["Ada Lovelace"]);
const BLINDED = describe_(NAME, ["Anonymous"]);
const SHORT_NAME = describe_("Short", ["Ada Lovelace"]);

type Runs = "none" | "running" | "success" | "failure";

let server: Server;
let runs: Runs = "none";
let descriptionBody: string | null = NAMED;
let descriptionStatus = 200;
let dispatches = 0;

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let ownerId: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      if (req.method === "POST" && p === "/repos/nemarDatasets/.github/dispatches") {
        dispatches++;
        return new Response(null, { status: 204 });
      }
      if (/\/contents\/\.github\/workflows\/bids-validation\.yml$/.test(p)) {
        return Response.json({ name: "bids-validation.yml" });
      }
      if (/\/actions\/workflows\/bids-validation\.yml\/runs$/.test(p)) {
        const workflow_runs =
          runs === "none"
            ? []
            : [
                {
                  status: runs === "running" ? "in_progress" : "completed",
                  conclusion: runs === "running" ? null : runs,
                  html_url: "x",
                },
              ];
        return Response.json({ workflow_runs });
      }
      if (/\/contents\/dataset_description\.json$/.test(p)) {
        if (descriptionStatus !== 200) return new Response("no", { status: descriptionStatus });
        if (descriptionBody === null) return new Response("not found", { status: 404 });
        return Response.json({ encoding: "base64", content: btoa(descriptionBody) });
      }
      if (/\/contents\/README\.md$/.test(p)) {
        return Response.json({ encoding: "base64", content: btoa("# README") });
      }
      return new Response("not found", { status: 404 });
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  server.stop(true);
});

afterEach(() => {
  runs = "none";
  descriptionBody = NAMED;
  descriptionStatus = 200;
  dispatches = 0;
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_pending_gate_test",
    PRESCREEN_CALLBACK_SECRET: "pending-gate-secret",
    API_BASE_URL: "https://api.test.nemar.org",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
  } as Bindings;
}

async function seedUser(username: string, key: string, names: boolean): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified,
                        service_access, sandbox_completed, given_name, family_name)
     VALUES (?, ?, 'x', 'approved', 'member', 1, 1, 1, ?, ?)`,
    [username, `${username}@example.org`, names ? "Ada" : null, names ? "Lovelace" : null],
  );
  const id = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username)?.id as number;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    id,
    await hashApiKey(key),
    key.slice(0, 8),
  );
  return id;
}

function seedDataset(
  id: string,
  opts: { owner?: number; source?: string | null; exemplar?: boolean } = {},
): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                           github_repo, is_exemplar, source)
     VALUES (?, ?, ?, 'active', 'private', 0, ?, ?, ?)`,
    [
      id,
      `A sufficiently descriptive title for ${id}`,
      opts.owner ?? ownerId,
      `nemarDatasets/${id}`,
      opts.exemplar ? 1 : 0,
      opts.source ?? null,
    ],
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/datasets", datasetRoutes);
  ownerId = await seedUser("pendinggate", OWNER_KEY, true);
  seedDataset(DATASET);
});

interface RequestBody {
  status?: string;
  block_reason?: string;
  message?: string;
  anonymous?: boolean;
  reasons?: string[];
  details?: { reasons?: string[]; policy_url?: string };
  policy_url?: string;
}

async function requestPublication(
  opts: { id?: string; key?: string; anonymous?: boolean } = {},
): Promise<{ status: number; body: RequestBody }> {
  const res = await app.request(
    `/datasets/${opts.id ?? DATASET}/publish/request`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.key ?? OWNER_KEY}`,
        ...(opts.anonymous ? { "Content-Type": "application/json" } : {}),
      },
      ...(opts.anonymous ? { body: JSON.stringify({ anonymous: true }) } : {}),
    },
    env(),
  );
  return { status: res.status, body: (await res.json()) as RequestBody };
}

interface Row {
  id: number;
  status: string;
  block_reason: string | null;
  min_requirements_reasons: string | null;
  anonymous: number;
}

function row(id = DATASET): Row {
  return db
    .query<Row, [string]>(
      `SELECT id, status, block_reason, min_requirements_reasons, anonymous
         FROM publication_requests WHERE dataset_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(id) as Row;
}

const reasonsOf = (r: Row): string[] =>
  r.min_requirements_reasons ? (JSON.parse(r.min_requirements_reasons) as string[]) : [];

describe("the request route checks the minimums while CI is pending", () => {
  test("pending validation and a too-short Name: min_requirements_failed with its reasons", async () => {
    runs = "none";
    descriptionBody = SHORT_NAME;
    const { status, body } = await requestPublication();
    expect(status).toBe(422);
    expect(body.block_reason).toBe("min_requirements_failed");
    expect(body.reasons?.join(" ")).toContain("Dataset Name must be a descriptive title");
    expect(body.details?.reasons).toEqual(body.reasons);
    expect(body.policy_url).toBeTruthy();
    const r = row();
    expect(r.status).toBe("blocked");
    expect(r.block_reason).toBe("min_requirements_failed");
    expect(reasonsOf(r)).toEqual(body.reasons ?? []);
  });

  test("control: the same dataset with a valid description is only pending, with no reasons", async () => {
    // Proves the gate ran and passed, so the test above is not just "pending
    // always answers min_requirements_failed".
    runs = "none";
    descriptionBody = NAMED;
    const { status, body } = await requestPublication();
    expect(status).toBe(422);
    expect(body.block_reason).toBe("bids_validation_pending");
    expect(body.reasons).toBeUndefined();
    expect(row().min_requirements_reasons).toBeNull();
  });

  test("a validation run still in progress is checked the same way", async () => {
    runs = "running";
    descriptionBody = SHORT_NAME;
    const { body } = await requestPublication();
    expect(body.block_reason).toBe("min_requirements_failed");
    descriptionBody = NAMED;
    const again = await requestPublication();
    expect(again.body.block_reason).toBe("bids_validation_in_progress");
  });

  test("an anonymous request whose Authors still names someone is refused, not left pending", async () => {
    runs = "none";
    descriptionBody = NAMED;
    const { status, body } = await requestPublication({ anonymous: true });
    expect(status).toBe(422);
    expect(body.block_reason).toBe("min_requirements_failed");
    expect(body.anonymous).toBe(true);
    expect(body.reasons?.join(" ")).toContain("still names Ada Lovelace");
    expect(row().anonymous).toBe(1);
  });

  test("control: a blinded anonymous request is only pending", async () => {
    runs = "none";
    descriptionBody = BLINDED;
    const { body } = await requestPublication({ anonymous: true });
    expect(body.block_reason).toBe("bids_validation_pending");
    expect(body.anonymous).toBe(true);
  });

  test("an anonymous request whose blind cannot be read is not granted", async () => {
    // 403, not 5xx: GitHub's retry loop sleeps between 5xx attempts.
    runs = "none";
    descriptionStatus = 403;
    const { status, body } = await requestPublication({ anonymous: true });
    expect(status).toBe(422);
    expect(body.block_reason).toBe("min_requirements_failed");
    expect(body.reasons?.join(" ")).toContain("could not read dataset_description.json");
  });

  test("a native request whose description cannot be read stays pending (fail-open, as before)", async () => {
    runs = "none";
    descriptionStatus = 403;
    const { body } = await requestPublication();
    expect(body.block_reason).toBe("bids_validation_pending");
  });

  test("a failed validation is reported as such; the minimums are not read", async () => {
    runs = "failure";
    descriptionBody = SHORT_NAME;
    const { body } = await requestPublication();
    expect(body.block_reason).toBe("bids_validation_failed");
    expect(body.reasons).toBeUndefined();
    expect(row().min_requirements_reasons).toBeNull();
  });

  test("a missing owner name is reported as such; the minimums are not read", async () => {
    const nameless = await seedUser("nameless", NAMELESS_KEY, false);
    seedDataset("nm000481", { owner: nameless });
    descriptionBody = SHORT_NAME;
    const { body } = await requestPublication({ id: "nm000481", key: NAMELESS_KEY });
    expect(body.block_reason).toBe("owner_name_missing");
    expect(body.reasons).toBeUndefined();
  });

  test("an OpenNeuro import and an exemplar keep their exemption", async () => {
    descriptionBody = SHORT_NAME;
    seedDataset("nm000482", { source: "openneuro" });
    seedDataset("nm000483", { exemplar: true });
    for (const id of ["nm000482", "nm000483"]) {
      const { body } = await requestPublication({ id });
      expect(body.block_reason, id).toBe("bids_validation_pending");
    }
  });

  test("an anonymous request is checked even for an OpenNeuro import or an exemplar", async () => {
    // For an anonymous release the gate is the blind check, and an upstream
    // review says a dataset was curated, never that it was blinded.
    descriptionBody = NAMED;
    seedDataset("nm000484", { source: "openneuro" });
    seedDataset("nm000485", { exemplar: true });
    for (const id of ["nm000484", "nm000485"]) {
      const { body } = await requestPublication({ id, anonymous: true });
      expect(body.block_reason, id).toBe("min_requirements_failed");
      expect(body.reasons?.join(" "), id).toContain("still names Ada Lovelace");
    }
  });

  test("re-requesting while CI runs keeps the minimums verdict instead of erasing it", async () => {
    runs = "running";
    descriptionBody = SHORT_NAME;
    const first = await requestPublication();
    expect(first.body.block_reason).toBe("min_requirements_failed");
    const recorded = reasonsOf(row());
    expect(recorded.length).toBeGreaterThan(0);

    // Same data, asked again: the verdict is re-recorded, not replaced by NULL.
    const second = await requestPublication();
    expect(second.body.block_reason).toBe("min_requirements_failed");
    expect(reasonsOf(row())).toEqual(recorded);

    // Fixed and asked again: now it is only waiting for CI, and the old
    // reasons are gone.
    descriptionBody = NAMED;
    const third = await requestPublication();
    expect(third.body.block_reason).toBe("bids_validation_in_progress");
    expect(row().min_requirements_reasons).toBeNull();
  });
});

describe("the sweep checks the same minimums before it releases a request", () => {
  test("a request whose description was edited after it was made is re-blocked with the reasons", async () => {
    runs = "none";
    descriptionBody = NAMED;
    const made = await requestPublication();
    expect(made.body.block_reason).toBe("bids_validation_pending");

    // CI passes, but the depositor has since shortened the Name.
    runs = "success";
    descriptionBody = SHORT_NAME;
    const result = await sweepBlockedBidsValidationRequests(env());
    expect(result.unblocked).toBe(0);
    expect(result.reblocked).toBe(1);
    expect(dispatches).toBe(0);
    const r = row();
    expect(r.status).toBe("blocked");
    expect(r.block_reason).toBe("min_requirements_failed");
    expect(reasonsOf(r).join(" ")).toContain("Dataset Name must be a descriptive title");

    // And it is no longer a candidate: the depositor fixes the data and asks.
    const again = await sweepBlockedBidsValidationRequests(env());
    expect(again.scanned).toBe(0);
  });

  test("control: an unchanged, valid description is released and screened", async () => {
    runs = "none";
    descriptionBody = NAMED;
    await requestPublication();
    runs = "success";
    await withFakeResend(async () => {
      const result = await sweepBlockedBidsValidationRequests(env());
      expect(result.unblocked).toBe(1);
      expect(result.reblocked).toBe(0);
    });
    expect(row().status).toBe("requested");
    expect(row().block_reason).toBeNull();
    expect(dispatches).toBe(1);
  });

  test("an anonymous request whose Authors now names the depositor is NOT released", async () => {
    // The irreversible case: released as requested, the real name would be
    // served under the blind label.
    runs = "none";
    descriptionBody = BLINDED;
    const made = await requestPublication({ anonymous: true });
    expect(made.body.block_reason).toBe("bids_validation_pending");
    expect(row().anonymous).toBe(1);

    runs = "success";
    descriptionBody = NAMED;
    const result = await sweepBlockedBidsValidationRequests(env());
    expect(result.unblocked).toBe(0);
    expect(result.reblocked).toBe(1);
    expect(dispatches).toBe(0);
    const r = row();
    expect(r.status).toBe("blocked");
    expect(r.block_reason).toBe("min_requirements_failed");
    expect(reasonsOf(r).join(" ")).toContain("still names Ada Lovelace");
  });

  test("control: an anonymous request that stays blinded is released", async () => {
    runs = "none";
    descriptionBody = BLINDED;
    await requestPublication({ anonymous: true });
    runs = "success";
    await withFakeResend(async () => {
      const result = await sweepBlockedBidsValidationRequests(env());
      expect(result.unblocked).toBe(1);
    });
    expect(row().status).toBe("requested");
    expect(row().anonymous).toBe(1);
  });

  test("an anonymous blind that cannot be read is left blocked for the next run, not released", async () => {
    runs = "none";
    descriptionBody = BLINDED;
    await requestPublication({ anonymous: true });
    runs = "success";
    descriptionStatus = 403;
    const result = await sweepBlockedBidsValidationRequests(env());
    expect(result.unblocked).toBe(0);
    expect(result.errors).toBe(1);
    // No verdict was reached, so the request still waits on CI alone.
    expect(row().status).toBe("blocked");
    expect(row().block_reason).toBe("bids_validation_pending");

    // The next run, with GitHub answering, releases it.
    descriptionStatus = 200;
    await withFakeResend(async () => {
      expect((await sweepBlockedBidsValidationRequests(env())).unblocked).toBe(1);
    });
  });

  test("a native request whose description cannot be read is released, as the route would", async () => {
    runs = "none";
    await requestPublication();
    runs = "success";
    descriptionStatus = 403;
    await withFakeResend(async () => {
      expect((await sweepBlockedBidsValidationRequests(env())).unblocked).toBe(1);
    });
  });

  test("an OpenNeuro import and an exemplar are released without the check", async () => {
    descriptionBody = SHORT_NAME;
    seedDataset("nm000482", { source: "openneuro" });
    seedDataset("nm000483", { exemplar: true });
    for (const id of ["nm000482", "nm000483"]) {
      expect((await requestPublication({ id })).body.block_reason).toBe("bids_validation_pending");
    }
    runs = "success";
    await withFakeResend(async () => {
      const result = await sweepBlockedBidsValidationRequests(env());
      expect(result.unblocked).toBe(2);
      expect(result.reblocked).toBe(0);
    });
  });

  test("an anonymous exemplar or OpenNeuro import is still checked by the sweep", async () => {
    descriptionBody = BLINDED;
    seedDataset("nm000484", { source: "openneuro" });
    seedDataset("nm000485", { exemplar: true });
    for (const id of ["nm000484", "nm000485"]) {
      const { body } = await requestPublication({ id, anonymous: true });
      expect(body.block_reason, id).toBe("bids_validation_pending");
    }
    runs = "success";
    descriptionBody = NAMED;
    const result = await sweepBlockedBidsValidationRequests(env());
    expect(result.unblocked).toBe(0);
    expect(result.reblocked).toBe(2);
    for (const id of ["nm000484", "nm000485"]) {
      expect(row(id).block_reason, id).toBe("min_requirements_failed");
    }
  });

  test("the route and the sweep agree on every description", async () => {
    // One function decides both, so no description can pass one and fail the
    // other. Drive each with the same set and compare the verdicts.
    const cases: Array<[string, string | null]> = [
      ["valid", NAMED],
      ["short name", SHORT_NAME],
      ["no authors", describe_(NAME, [])],
      ["placeholder author", describe_(NAME, ["TBD"])],
      ["missing file", null],
    ];
    for (const [label, body] of cases) {
      const id = `nm0005${cases.findIndex((c) => c[0] === label)}0`;
      seedDataset(id);
      runs = "none";
      descriptionBody = body;
      const routeVerdict = (await requestPublication({ id })).body.block_reason;
      // Now let the sweep decide the same request.
      db.run(
        `UPDATE publication_requests SET status = 'blocked', block_reason = 'bids_validation_pending',
                min_requirements_reasons = NULL WHERE dataset_id = ?`,
        [id],
      );
      runs = "success";
      await withFakeResend(async () => {
        await sweepBlockedBidsValidationRequests(env());
      });
      const swept = row(id);
      const sweepVerdict =
        swept.status === "requested" ? "bids_validation_pending" : swept.block_reason;
      expect(sweepVerdict, label).toBe(routeVerdict ?? "");
    }
  });
});
