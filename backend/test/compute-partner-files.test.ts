/**
 * A partner's declared files (epic #2021 phase D4, #2025; the review round of PR #2077, findings M3 and m4
 * and the concurrent-copy minor): the first accepted list is pinned to the job, a digest is compared with the
 * store's where the store returns one, and a copy the locked destination refuses because a concurrent report
 * already wrote it counts as copied. Through the REAL Worker, the Tapis stand-in and Miniflare's R2.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type LifecycleFixture, startLifecycleFixture } from "./helpers/compute-lifecycle-fixture";
import {
  type Hold,
  type PartnerPerson,
  type PartnerWorld,
  type ReportUpload,
  buildPartnerWorld,
  newPartnerPerson,
  partnerCall,
  partnerLaunch,
  reserve,
  row,
} from "./helpers/compute-partner-world";

let fx: LifecycleFixture;
let w: PartnerWorld;
let person: PartnerPerson;

beforeAll(async () => {
  fx = await startLifecycleFixture();
}, 60_000);
afterAll(async () => {
  await fx?.dispose();
}, 30_000);
beforeEach(async () => {
  await fx.reset();
  w = await buildPartnerWorld(fx);
  person = await newPartnerPerson(w);
}, 60_000);

const report = (hold: Hold, body: unknown, who: PartnerPerson = person, key?: string | null) =>
  partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
    token: who.token,
    json: body,
    key,
  });

describe("a partner's declared files: pinned, compared, copied once", () => {
  const FILES = [
    { path: "params.json", body: '{"a":1}' },
    { path: "run.py", body: "print('hi')\n" },
  ];
  const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const declared = (list = FILES) =>
    list.map((f) => ({ path: f.path, size: f.body.length, sha256: sha(f.body) }));
  const submittedKeys = async (id: string) =>
    (await fx.harness.keys(fx.harness.records)).filter((k) =>
      k.startsWith(`records/${id}/submitted/`),
    );
  async function put(
    uploads: Array<{ path: string; url: string; headers: Record<string, string> }>,
  ) {
    for (const u of uploads) {
      const f = FILES.find((x) => x.path === u.path) as (typeof FILES)[number];
      expect((await fetch(u.url, { method: "PUT", headers: u.headers, body: f.body })).status).toBe(
        200,
      );
    }
  }
  const filesOf = (res: { json: Record<string, unknown> | null }) =>
    (res.json as { files: { state: string; uploads: ReportUpload[] } }).files;

  test("after a list was accepted only that list is accepted: another path set gets no new addresses (M3, Opus)", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    const first = await report(hold, { tapis_job_id: uuid, files: declared() });
    expect(first.status).toBe(200);
    expect(row(w, hold.job_id).partner_files_digest).toMatch(/^[0-9a-f]{64}$/);
    const other = await report(hold, {
      tapis_job_id: uuid,
      files: declared([{ path: "other.txt", body: "x" }]),
    });
    expect([other.status, other.json?.code, other.json?.field]).toEqual([
      400,
      "invalid_spec",
      "files",
    ]);
    expect(other.json?.files).toBeUndefined();
    // The same size with another digest is another list too.
    const reDigested = declared();
    (reDigested[0] as { sha256: string }).sha256 = sha("something else");
    expect((await report(hold, { tapis_job_id: uuid, files: reDigested })).status).toBe(400);
    // The accepted list again is fine, as often as it is sent.
    expect((await report(hold, { tapis_job_id: uuid, files: declared() })).status).toBe(200);
  });

  test("where the store knows an object's SHA-256 it must be the declared one: same size, other bytes, is refused and nothing is recorded (m4, Opus)", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    const first = await report(hold, { tapis_job_id: uuid, files: declared() });
    await put(filesOf(first).uploads.filter((u) => u.path === "run.py"));
    // params.json arrives with the right size and other bytes, stored with its own (true) checksum.
    const wrong = '{"a":2}';
    expect(wrong.length).toBe(FILES[0]?.body.length as number);
    await fx.harness.records.put(`incoming/${hold.job_id}/params.json`, wrong, {
      sha256: sha(wrong),
    });
    const second = await report(hold, { tapis_job_id: uuid, files: declared() });
    expect([second.status, second.json?.code, second.json?.field]).toEqual([
      400,
      "invalid_spec",
      "files.0.sha256",
    ]);
    expect(await submittedKeys(hold.job_id)).toEqual([]);
    expect(row(w, hold.job_id).records_written_at).toBeNull();
  });

  test("a copy the store refuses because a concurrent report already wrote the destination counts as copied (minor, Sonnet)", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    const first = await report(hold, { tapis_job_id: uuid, files: declared() });
    await put(filesOf(first).uploads);
    // The other report's copy of params.json lands while this one's is in flight; the locked destination
    // refuses the second write.
    fx.harness.standin.failWith({
      op: "CopyObject",
      keyIncludes: "params.json",
      status: 403,
      code: "AccessDenied",
      beforeAnswer: async () => {
        await fx.harness.records.put(
          `records/${hold.job_id}/submitted/params.json`,
          FILES[0]?.body as string,
        );
      },
    });
    const second = await report(hold, { tapis_job_id: uuid, files: declared() });
    expect([second.status, filesOf(second).state]).toEqual([200, "recorded"]);
    expect(await submittedKeys(hold.job_id)).toHaveLength(2);
    expect(row(w, hold.job_id).records_written_at).not.toBeNull();
  });

  test("a refused copy whose destination is NOT there is still a storage failure, and records nothing", async () => {
    const hold = await reserve(w, person);
    const uuid = await partnerLaunch(w, hold, person);
    const first = await report(hold, { tapis_job_id: uuid, files: declared() });
    await put(filesOf(first).uploads);
    fx.harness.standin.failWith({
      op: "CopyObject",
      keyIncludes: "params.json",
      status: 403,
      code: "AccessDenied",
    });
    const second = await report(hold, { tapis_job_id: uuid, files: declared() });
    expect([second.status, second.json?.code]).toEqual([503, "storage_unavailable"]);
    expect(row(w, hold.job_id).records_written_at).toBeNull();
  });
});
