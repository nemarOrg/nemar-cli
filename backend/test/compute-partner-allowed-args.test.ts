/**
 * The options an app or a system adds, which Tapis merges into a job record (epic #2021 phase D4, #2025; the
 * second review round of PR #2077, item 2): accepted only as the exact strings the owner listed in
 * `policy.partner.allowedSchedulerArgs`, in addition to at most one `--gpus=N` within the hold.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_COMPUTE_POLICY } from "../../shared/contract/compute";
import { putPolicy } from "../src/services/compute-policy";
import { PARAMETER_SET_MAX_CHARS, schedulerArgsOf } from "../src/services/tapis/schemas";
import { type LifecycleFixture, startLifecycleFixture } from "./helpers/compute-lifecycle-fixture";
import {
  type Hold,
  PARTNER_CONFIRMED,
  type PartnerPerson,
  type PartnerWorld,
  buildPartnerWorld,
  newPartnerPerson,
  partnerCall,
  partnerLaunch,
  reserve,
  setPartnerPolicy,
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

const report = (hold: Hold, uuid: string) =>
  partnerCall(w, "POST", `/compute/jobs/${hold.job_id}/report`, {
    token: person.token,
    json: { tapis_job_id: uuid },
  });

describe("the options an app or a system adds are the owner's exact strings (item 2)", () => {
  const withAllowed = (allowed?: string[]) =>
    setPartnerPolicy(w.env().DB, fx.ownerId, {
      partner: {
        ...PARTNER_CONFIRMED,
        ...(allowed === undefined ? {} : { allowedSchedulerArgs: allowed }),
      },
      clients: { [w.client.clientId]: { maxOpenReservations: 20, maxReservedMilliPerDay: 1e9 } },
    });

  test("by default none is accepted; listed exactly, they are, with at most one GPU option", async () => {
    const attempt = async (args: string[]) => {
      const hold = await reserve(w, person);
      const uuid = await partnerLaunch(w, hold, person, { schedulerArgs: args });
      const res = await report(hold, uuid);
      return res.status === 200 ? "verified" : (res.json?.mismatch as string);
    };
    expect(await attempt(["--account=proj-1"])).toBe("resources_mismatch");
    await withAllowed(["--account=proj-1", "--tapis-profile=expanse"]);
    expect(await attempt(["--account=proj-1"])).toBe("verified");
    expect(await attempt(["--account=proj-1", "--tapis-profile=expanse", "--gpus=0"])).toBe(
      "verified",
    );
    // Exact, not a prefix; another value of the same option is another option.
    expect(await attempt(["--account=proj-2"])).toBe("resources_mismatch");
    expect(await attempt(["--account=proj-10"])).toBe("resources_mismatch");
    // A listed option does not make room for an unlisted one, or for a second GPU option.
    expect(await attempt(["--account=proj-1", "--exclusive"])).toBe("resources_mismatch");
    expect(await attempt(["--gpus=0", "--gpus=0"])).toBe("resources_mismatch");
    // The hold still bounds the GPUs.
    expect(await attempt(["--account=proj-1", "--gpus=4"])).toBe("resources_mismatch");
  });

  test("the policy refuses a GPU option in the list, a malformed string and more than twenty", async () => {
    const put = (allowed: unknown) =>
      putPolicy(
        w.env().DB,
        fx.ownerId,
        {
          ...DEFAULT_COMPUTE_POLICY,
          partner: { ...PARTNER_CONFIRMED, allowedSchedulerArgs: allowed },
        },
        "test",
      );
    for (const bad of [
      ["-G"],
      ["-G2"],
      ["-Ggpu:2"],
      ["--gpus-per-node=2"],
      ["--gpus-per-task=1"],
      ["--tres-per-node=gres/gpu:2"],
      ["--TRES=x"],
      ["--GPU=1"],
      ["--Gres=gpu:1"],
      ["--mem-per-gpu=2G"],
      ["--gres-flags=x"],
      ["--g"],
      ["--gp"],
      ["--gpu"],
      ["--gre"],
      ["--tre"],
      ["--gpus=8"],
      ["--gres=gpu:8"],
      ["has space"],
      [""],
      Array.from({ length: 21 }, (_, i) => `--a=${i}`),
      "--account=x",
    ]) {
      expect([JSON.stringify(bad).slice(0, 30), (await put(bad)).ok]).toEqual([
        JSON.stringify(bad).slice(0, 30),
        false,
      ]);
    }
    // What a tenant really merges in is fine, including near neighbors of the refused names.
    for (const good of [
      "--account=proj-1",
      "--tapis-profile=expanse",
      "-A",
      "--gid=100",
      "--tmp=10G",
    ]) {
      expect([good, (await put([good])).ok]).toEqual([good, true]);
    }
  });
});
