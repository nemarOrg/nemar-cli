/**
 * A person's cancel, log and results (epic #2021 phase D3, #2024; ADR 0118, the amendment of this
 * phase), through the REAL compute router with its real authentication over real migrated SQLite,
 * Miniflare's R2 and the real local S3 interface. The Tapis stand-in was built from Tapis's published
 * specifications; no response of it was recorded from a real tenant. The launcher's end of a job is
 * played by `playLauncher` (the lifecycle fixture states its scope).
 *
 * What is pinned: another person's job is the same 404 on every route; a cancel of a job that had ended
 * is 200 with `cancelled: false`; the log is plain text of at most 1 MiB with `X-Nemar-Truncated`, from
 * the records once they hold it and from Tapis before, `logs_not_available` before the job started and
 * never a line of it in a Worker log; results are seven-day BEARER links with the declared SHA-256,
 * 410 `results_expired` after the retention or once the objects are gone, and renewed while they exist.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ComputeCancelResponseSchema } from "../../shared/contract/compute-responses";
import {
  COMPUTE_LOG_MAX_BYTES,
  ComputeResultsResponseSchema,
} from "../../shared/contract/compute-submit";
import { advanceComputeJob, submitComputeJob } from "../src/services/compute-lifecycle";
import { logKey } from "../src/services/compute-records";
import { hashApiKey } from "../src/services/token";
import {
  MINUTE,
  type MadeJob,
  makeJob,
  playLauncher,
  reread,
  setTapisTimes,
} from "./helpers/compute-lifecycle-fixture";
import { setPolicy } from "./helpers/compute-seed";
import {
  type World,
  bundleRequest,
  call,
  cookieFor,
  makeBundle,
  newPerson,
  resetWorld,
  sha256,
  startWorld,
} from "./helpers/compute-submit-world";
import { logged } from "./helpers/logs";

let w: World;

beforeAll(async () => {
  w = await startWorld();
}, 120_000);

beforeEach(async () => {
  await resetWorld(w);
});

afterAll(async () => {
  await w?.fx.dispose();
}, 30_000);

let seq = 0;
async function keyFor(accountId: number): Promise<string> {
  const key = `cmp-person-key-${++seq}-0123456789abcdef0123456789abcdef`;
  w.fx.harness.db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(accountId, await hashApiKey(key), key.slice(0, 8));
  return key;
}

interface Mine extends MadeJob {
  key: string;
}

/** A job made through the lifecycle (its hold and records), with a key for its owner. */
async function mine(): Promise<Mine> {
  const made = await makeJob(w.fx);
  return { ...made, key: await keyFor(made.accountId) };
}

/** A running job: submitted and read back as RUNNING. */
async function running(): Promise<Mine & { uuid: string }> {
  const j = await mine();
  await submitComputeJob(j.env, j.job.id);
  const uuid = (await reread(j.env, j.job.id)).tapis_uuid as string;
  w.fx.tapis.advance(uuid, "RUNNING");
  await advanceComputeJob(j.env, j.job.id);
  return { ...j, uuid };
}

/** A job that ran, uploaded and finished, verified. */
async function finished(files = [{ path: "report.txt", content: "the report" }]) {
  const j = await running();
  await playLauncher(w.fx, j.env, await reread(j.env, j.job.id), j.uuid, { outputs: files });
  w.fx.tapis.advance(j.uuid, "FINISHED");
  setTapisTimes(w.fx, j.uuid, 30 * MINUTE, 0);
  await advanceComputeJob(j.env, j.job.id);
  expect((await reread(j.env, j.job.id)).state).toBe("finished");
  return j;
}

const get = (path: string, key: string | null) => call(w, "GET", path, { key });
const post = (path: string, key: string | null, json?: unknown) =>
  call(w, "POST", path, { key, json });

describe("whose job it is: one 404 on every route", () => {
  test("another person, an administrator, an absent job and a malformed id answer the same bytes", async () => {
    const j = await mine();
    const stranger = await newPerson(w);
    const admin = await newPerson(w);
    w.fx.harness.db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
    const routes: Array<["GET" | "POST", string]> = [
      ["POST", "cancel"],
      ["POST", "finalize"],
      ["GET", "logs"],
      ["GET", "results"],
      ["POST", "results/renew"],
    ];
    for (const [method, route] of routes) {
      const ask = (id: string, key: string) =>
        call(w, method, `/compute/jobs/${id}/${route}`, { key });
      const none = await ask("job_000000000000000000000000", j.key);
      const attempts = [
        await ask(j.job.id, stranger.key),
        await ask(j.job.id, admin.key),
        await ask("nope", j.key),
        none,
      ];
      for (const a of attempts) expect([route, a.status, a.text]).toEqual([route, 404, none.text]);
      expect(none.body.code).toBe("job_not_found");
    }
  });

  test("no credential is 401 on every route, and an OpenID Connect token is not a credential here", async () => {
    const j = await mine();
    for (const [method, route] of [
      ["POST", "cancel"],
      ["POST", "finalize"],
      ["GET", "logs"],
      ["GET", "results"],
      ["POST", "results/renew"],
    ] as const) {
      const none = await call(w, method, `/compute/jobs/${j.job.id}/${route}`, {});
      expect([route, none.status]).toEqual([route, 401]);
      const oidc = await call(w, method, `/compute/jobs/${j.job.id}/${route}`, {
        key: "nmo_at_not-a-real-access-token-0123456789",
      });
      expect([route, oidc.status]).toEqual([route, 401]);
    }
  });
});

describe("cancel", () => {
  test("a running job: the intent is recorded, Tapis is asked, and the answer says cancelled", async () => {
    const j = await running();
    const r = await post(`/compute/jobs/${j.job.id}/cancel`, j.key);
    expect(r.status).toBe(200);
    expect(ComputeCancelResponseSchema.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({ ok: true, outcome: "cancel_requested", cancelled: true });
    expect((await reread(j.env, j.job.id)).cancel_reason).toBe("user");
  });

  test("a job that never started is cancelled here and its hold is released", async () => {
    const p = await newPerson(w, { grant: 5000 });
    const bundle = makeBundle();
    const made = await call(w, "POST", "/compute/jobs", {
      key: p.key,
      json: bundleRequest(bundle),
    });
    const id = made.body.job_id as string;
    const held = () =>
      w.fx.harness.db
        .query(
          "SELECT held_milli FROM compute_pools WHERE holder_kind = 'account' AND holder_ref = ?",
        )
        .get(String(p.id)) as { held_milli: number };
    expect(held().held_milli).toBe(1000);
    const r = await post(`/compute/jobs/${id}/cancel`, p.key);
    expect(r.body).toMatchObject({ ok: true, state: "cancelled", cancelled: true });
    expect(held().held_milli).toBe(0);
  });

  test("a job that had finished or failed: 200 with its state unchanged and cancelled false", async () => {
    const done = await finished();
    const r = await post(`/compute/jobs/${done.job.id}/cancel`, done.key);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      state: "finished",
      outcome: "already_ended",
      cancelled: false,
    });
    expect((await reread(done.env, done.job.id)).state).toBe("finished");

    const bad = await mine();
    w.fx.harness.db
      .query(
        "UPDATE compute_jobs SET state = 'failed', failure_code = 'runtime_error' WHERE id = ?",
      )
      .run(bad.job.id);
    const f = await post(`/compute/jobs/${bad.job.id}/cancel`, bad.key);
    expect(f.body).toMatchObject({ state: "failed", outcome: "already_ended", cancelled: false });
  });

  test("a job already cancelled is answered as it was", async () => {
    const j = await mine();
    await post(`/compute/jobs/${j.job.id}/cancel`, j.key);
    const again = await post(`/compute/jobs/${j.job.id}/cancel`, j.key);
    expect(again.body).toMatchObject({
      outcome: "already_cancelled",
      state: "cancelled",
      cancelled: true,
    });
  });

  test("the cookie path needs a NEMAR Origin", async () => {
    const j = await mine();
    const cookie = await cookieFor(w, { id: j.accountId, key: j.key });
    const refused = await call(w, "POST", `/compute/jobs/${j.job.id}/cancel`, {
      cookie,
      origin: "https://evil.example",
    });
    expect([refused.status, refused.body.code]).toEqual([403, "origin_not_allowed"]);
    expect((await reread(j.env, j.job.id)).cancel_requested_at).toBeNull();
  });
});

describe("logs", () => {
  test("a running job's log comes from Tapis as plain text, never cached or sniffed", async () => {
    const j = await running();
    w.fx.tapis.setOutput(j.uuid, "tapisjob.out", "line one\nline two\n");
    const r = await get(`/compute/jobs/${j.job.id}/logs`, j.key);
    expect(r.status).toBe(200);
    expect(r.text).toBe("line one\nline two\n");
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-nemar-truncated")).toBeNull();
  });

  test("a log over 1 MiB is cut at exactly 1 MiB and says so, from Tapis and from the records alike", async () => {
    const big = "x".repeat(1024 * 1024 + 4096);
    const j = await running();
    w.fx.tapis.setOutput(j.uuid, "tapisjob.out", big);
    const live = await get(`/compute/jobs/${j.job.id}/logs`, j.key);
    expect(live.status).toBe(200);
    expect(live.bytes.length).toBe(COMPUTE_LOG_MAX_BYTES);
    expect(live.headers.get("x-nemar-truncated")).toBe("true");

    // A copy in the records (the job ended and its files were copied): served from there, read by range.
    const k = await mine();
    w.fx.harness.db
      .query(
        "UPDATE compute_jobs SET state = 'failed', failure_code = 'runtime_error', result_records_at = datetime('now') WHERE id = ?",
      )
      .run(k.job.id);
    await w.fx.harness.records.put(logKey(k.job.id, "tapisjob.out"), new TextEncoder().encode(big));
    w.fx.tapis.down();
    const copy = await get(`/compute/jobs/${k.job.id}/logs`, k.key);
    w.fx.tapis.up();
    expect(copy.status).toBe(200);
    expect(copy.bytes.length).toBe(COMPUTE_LOG_MAX_BYTES);
    expect(copy.headers.get("x-nemar-truncated")).toBe("true");
    // A log of exactly the bound is not truncated.
    await w.fx.harness.records.put(
      logKey(k.job.id, "tapisjob.out"),
      new Uint8Array(COMPUTE_LOG_MAX_BYTES).fill(65),
    );
    const exact = await get(`/compute/jobs/${k.job.id}/logs`, k.key);
    expect([exact.bytes.length, exact.headers.get("x-nemar-truncated")]).toEqual([
      COMPUTE_LOG_MAX_BYTES,
      null,
    ]);
  });

  test("before the job started: 404 logs_not_available", async () => {
    const p = await newPerson(w);
    const made = await call(w, "POST", "/compute/jobs", {
      key: p.key,
      json: bundleRequest(makeBundle()),
    });
    const uploading = await get(`/compute/jobs/${made.body.job_id}/logs`, p.key);
    expect([uploading.status, uploading.body.code]).toEqual([404, "logs_not_available"]);
    const created = await mine();
    expect((await get(`/compute/jobs/${created.job.id}/logs`, created.key)).body.code).toBe(
      "logs_not_available",
    );
    // Submitted at Tapis but nothing written yet.
    const sub = await mine();
    await submitComputeJob(sub.env, sub.job.id);
    expect((await get(`/compute/jobs/${sub.job.id}/logs`, sub.key)).status).toBe(404);
  });

  test("an ended job whose files were copied and that wrote no log is logs_not_available", async () => {
    const k = await mine();
    w.fx.harness.db
      .query(
        "UPDATE compute_jobs SET state = 'failed', failure_code = 'runtime_error', result_records_at = datetime('now') WHERE id = ?",
      )
      .run(k.job.id);
    expect((await get(`/compute/jobs/${k.job.id}/logs`, k.key)).body.code).toBe(
      "logs_not_available",
    );
  });

  test("a Tapis that cannot be reached is 503 storage_unavailable, not a missing log", async () => {
    const j = await running();
    w.fx.tapis.down();
    const r = await get(`/compute/jobs/${j.job.id}/logs`, j.key);
    w.fx.tapis.up();
    expect([r.status, r.body.code]).toEqual([503, "storage_unavailable"]);
  });

  test("a line of the job is never in a Worker log", async () => {
    const j = await running();
    const marker = "a-line-the-code-printed-zq7";
    w.fx.tapis.setOutput(j.uuid, "tapisjob.out", `${marker}\n`);
    const lines = await logged(async () => {
      expect((await get(`/compute/jobs/${j.job.id}/logs`, j.key)).text).toContain(marker);
      w.fx.tapis.down();
      await get(`/compute/jobs/${j.job.id}/logs`, j.key);
      w.fx.tapis.up();
    });
    expect(lines.join("\n")).not.toContain(marker);
  });
});

describe("results", () => {
  test("seven-day bearer links with the declared checksum, which download to the bytes", async () => {
    const j = await finished([
      { path: "report.txt", content: "the report" },
      { path: "sub/data.csv", content: "a,b\n1,2\n" },
    ]);
    const before = Date.now();
    const r = await get(`/compute/jobs/${j.job.id}/results`, j.key);
    expect(r.status).toBe(200);
    expect(ComputeResultsResponseSchema.safeParse(r.body).success).toBe(true);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body.bearer_links).toBe(true);
    expect(r.body.notice).toContain("Anyone who holds a link");
    expect(r.body.total).toBe(2);
    expect(r.body.truncated).toBe(false);
    expect(r.body.next_after).toBeNull();
    const lives = Date.parse(r.body.expires_at) - before;
    expect(lives).toBeGreaterThan(7 * 86_400_000 - 60_000);
    expect(lives).toBeLessThanOrEqual(7 * 86_400_000 + 60_000);
    expect(r.body.files.map((f: any) => f.path)).toEqual(["report.txt", "sub/data.csv"]);
    for (const f of r.body.files) {
      expect(new URL(f.url).searchParams.get("X-Amz-Expires")).toBe("604800");
      const got = new Uint8Array(await (await fetch(f.url)).arrayBuffer());
      expect([f.path, got.length, sha256(got)]).toEqual([f.path, f.size, f.sha256]);
    }
    expect(r.body.files[0].sha256).toBe(sha256("the report"));
  });

  test("a job that has not finished is 409 bad_state", async () => {
    const j = await running();
    const r = await get(`/compute/jobs/${j.job.id}/results`, j.key);
    expect([r.status, r.body.code]).toEqual([409, "bad_state"]);
  });

  test("410 results_expired once the retention has passed, though the objects are still there; 200 just inside it", async () => {
    const j = await finished();
    const endedAgo = (days: number, extraMinutes = 0) =>
      w.fx.harness.db
        .query("UPDATE compute_jobs SET ended_at = datetime('now', ?, ?) WHERE id = ?")
        .run(`-${days} days`, `-${extraMinutes} minutes`, j.job.id);
    endedAgo(29);
    expect((await get(`/compute/jobs/${j.job.id}/results`, j.key)).status).toBe(200);
    endedAgo(30, 5);
    const gone = await get(`/compute/jobs/${j.job.id}/results`, j.key);
    expect([gone.status, gone.body.code]).toEqual([410, "results_expired"]);
    expect((await post(`/compute/jobs/${j.job.id}/results/renew`, j.key)).status).toBe(410);
    // The owner's retention is the clock, not a constant: 14 days is the shortest it may be.
    await setPolicy(w.env().DB, w.fx.ownerId, {
      retention: { recordsYears: 7, logsDays: 365, resultsDays: 14 },
    });
    endedAgo(15);
    expect((await get(`/compute/jobs/${j.job.id}/results`, j.key)).status).toBe(410);
    endedAgo(13);
    expect((await get(`/compute/jobs/${j.job.id}/results`, j.key)).status).toBe(200);
  });

  test("410 once the objects are gone, whatever the clock says", async () => {
    const j = await finished();
    const listed = await w.fx.harness.results.list({ prefix: `jobs/${j.job.id}/outputs/` });
    await w.fx.harness.results.delete(listed.objects.map((o) => o.key));
    expect((await get(`/compute/jobs/${j.job.id}/results`, j.key)).body.code).toBe(
      "results_expired",
    );
  });

  test("renew makes working links again while the objects exist", async () => {
    const j = await finished();
    const first = await get(`/compute/jobs/${j.job.id}/results`, j.key);
    const renewed = await post(`/compute/jobs/${j.job.id}/results/renew`, j.key);
    expect(renewed.status).toBe(200);
    expect(renewed.body.bearer_links).toBe(true);
    expect(renewed.body.files.map((f: any) => f.path)).toEqual(
      first.body.files.map((f: any) => f.path),
    );
    expect(Date.parse(renewed.body.expires_at)).toBeGreaterThanOrEqual(
      Date.parse(first.body.expires_at),
    );
    const got = await fetch(renewed.body.files[0].url);
    expect(got.status).toBe(200);
  });

  test("a cursor pages on; one that could leave the job is refused; the cookie path needs an Origin", async () => {
    const j = await finished([
      { path: "a.txt", content: "a" },
      { path: "b.txt", content: "b" },
    ]);
    const page = await get(`/compute/jobs/${j.job.id}/results?after=a.txt`, j.key);
    expect(page.body.files.map((f: any) => f.path)).toEqual(["b.txt"]);
    for (const after of ["../x", "/abs", "a/../b"]) {
      const r = await get(
        `/compute/jobs/${j.job.id}/results?after=${encodeURIComponent(after)}`,
        j.key,
      );
      expect([after, r.status, r.body.field]).toEqual([after, 400, "after"]);
    }
    const cookie = await cookieFor(w, { id: j.accountId, key: j.key });
    const renew = await call(w, "POST", `/compute/jobs/${j.job.id}/results/renew`, {
      cookie,
      origin: "https://evil.example",
    });
    expect([renew.status, renew.body.code]).toEqual([403, "origin_not_allowed"]);
    // A read (the links are fetched with GET) needs no Origin: it changes nothing.
    expect((await call(w, "GET", `/compute/jobs/${j.job.id}/results`, { cookie })).status).toBe(
      200,
    );
  });

  test("a link is never in a Worker log", async () => {
    const j = await finished();
    const lines = await logged(async () => {
      const r = await get(`/compute/jobs/${j.job.id}/results`, j.key);
      expect(r.body.files[0].url).toContain("X-Amz-Signature");
    });
    expect(lines.join("\n")).not.toContain("X-Amz-Signature");
  });
});
