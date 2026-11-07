/**
 * How a partner's Tapis job record is read for its scheduler options (epic #2021 phase D4, #2025; the second
 * review round of PR #2077): the Jobs specification types `parameterSet` as a JSON STRING and the
 * documentation's examples show an object, so BOTH are read (the stand-in serves the string by default, so
 * every happy path in the partner suites covers the specification's form); an unreadable one is never
 * verified.
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

/** Valid JSON, one character over the bound: only the bound refuses it. */
const BIG = JSON.stringify({ schedulerOptions: [], pad: "x".repeat(PARAMETER_SET_MAX_CHARS) });

describe("both wire forms of parameterSet are read (item 1)", () => {
  test("the accessor reads an object, a JSON string, and refuses what it cannot read", () => {
    const set = { schedulerOptions: [{ arg: "--gpus=1" }, { arg: "--account=p1" }] };
    expect(schedulerArgsOf(set)).toEqual(["--gpus=1", "--account=p1"]);
    expect(schedulerArgsOf(JSON.stringify(set))).toEqual(["--gpus=1", "--account=p1"]);
    expect(schedulerArgsOf(JSON.stringify({}))).toEqual([]);
    expect(schedulerArgsOf(undefined)).toBeUndefined();
    for (const bad of [
      "{not json",
      "[]",
      "7",
      7,
      [],
      JSON.stringify({ schedulerOptions: "x" }),
      JSON.stringify({ schedulerOptions: [{ arg: 5 }] }),
      BIG,
    ]) {
      expect([typeof bad, schedulerArgsOf(bad)]).toEqual([typeof bad, null]);
    }
  });

  test("a record served as the specification types it (a string) is verified, and so is the examples' form (an object)", async () => {
    for (const form of ["string", "object"] as const) {
      fx.tapis.parameterSetAs(form);
      const hold = await reserve(w, person);
      const uuid = await partnerLaunch(w, hold, person, { schedulerArgs: ["--gpus=0"] });
      const res = await report(hold, uuid);
      expect([form, res.status, res.json?.verification]).toEqual([form, 200, "verified"]);
    }
  });

  test("a string that is not JSON, or is over the bound, is never verified", async () => {
    for (const parameterSet of ["{not json", BIG]) {
      const hold = await reserve(w, person);
      const uuid = await partnerLaunch(w, hold, person);
      const record = fx.tapis.jobs.get(uuid)?.record as Record<string, unknown>;
      fx.tapis.respond(
        "GET /v3/jobs/:uuid",
        200,
        {
          result: { ...record, parameterSet },
          status: "success",
          message: "",
          version: "",
          metadata: null,
        },
        1,
      );
      const res = await report(hold, uuid);
      expect([parameterSet.length > 100, res.status, res.json?.mismatch]).toEqual([
        parameterSet.length > 100,
        409,
        "resources_mismatch",
      ]);
    }
  });
});
