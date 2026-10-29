/**
 * N.0.1 after an N.0.0 merge made outside NEMAR's gate and accepted (`nemar admin repull resume
 * <id> --accept-merge-trailers "<reason>"`; epic #1046; ADR 0111, the amendment of 2026-10-29;
 * issue #1996), driven through the real entry point against `repull-pr-world.ts` with a plan that
 * has corrections and a conflict, and a delta whose scrub writes a `repull-scrubbed` line, so the
 * accepted merge needs the ledger line that names it.
 *
 * The acceptance's line is a commit of NEMAR's own on `main` after the N.0.0 merge, before N.0.1
 * is made. N.0.1 reads `main` as the N.0.0 merge or a descendant of it moved only by enrichment, and
 * that commit is not enrichment's, so this suite shows that N.0.1 takes it (`checkMain` with
 * `acceptances`) and that a run that pushed N.0.1 over it and could not record it is taken up by
 * the next run (`findPatchCommit`), each failing when the acceptance shape is taken away.
 *
 * Everything NEMAR's is real (the CLI, the Worker's routes over bun:sqlite, `git` and `git-annex`);
 * GitHub and S3 are the suites' stand-ins. No mocks.
 *
 * CI TIER: unit-pure. Hermetic: every server the suite starts or reaches listens on loopback.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { which } from "bun";
import { gitIn } from "./helpers/repull-fixture";
import { type RepullWorld, type WorldPoint, startRepullWorld } from "./helpers/repull-pr-world";
import { toolOrFail } from "./scrub/helpers/require-tools";

setDefaultTimeout(600_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);
const REASON = "Merged with GitHub's button; read and found to be the re-pull's own squash merge";

let w: RepullWorld;
/** N.0.0 merged on GitHub's page, accepted with its line on main, released and locked. */
let accepted: WorldPoint;
/** The acceptance's commit on main. */
let attestation: string;

beforeAll(async () => {
  if (!awsInstalled) return;
  w = await startRepullWorld({ fixture: { identifierJsonB: true } });
  const head = w.row().head_sha as string;
  expect((await resume()).exitCode).toBe(3);
  await w.reportScreen(head, "clean");
  expect((await resume()).exitCode).toBe(0);
  const merge = await w.mergeOnGitHub();
  await w.tagMain("2.0.0");
  w.insertVersionRow("2.0.0");
  // Accepted, released and locked; then it waits for a decision on the plan's conflict.
  const run = await resume(["--accept-merge-trailers", REASON]);
  expect(run.exitCode, run.all).toBe(3);
  expect(run.all).toContain(`the line that names ${merge.slice(0, 12)}`);
  expect(w.row().status).toBe("released");
  expect(JSON.parse(w.row().counts).locked).toBeGreaterThan(0);
  attestation = await mainHead();
  expect((await gitIn(w.fx.originRepo, ["rev-parse", `${attestation}^`])).trim()).toBe(merge);
  accepted = await w.save();
});
afterAll(() => w?.stop());
beforeEach(async () => {
  if (awsInstalled) await w.restore();
});

function resume(extra: string[] = []) {
  return w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes", ...extra]);
}
async function mainHead(): Promise<string> {
  return (await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/main"])).trim();
}

describe.skipIf(!awsInstalled)("N.0.1 after an accepted N.0.0 merge", () => {
  test("N.0.1 is made on a main that holds NEMAR's acceptance commit, which is its parent", async () => {
    await w.restore(accepted);
    const made = await resume(["--keep-upstream"]);
    expect(made.exitCode, made.all).toBe(3);
    expect(made.all).not.toContain("main-moved");
    const row = w.row();
    expect(row).toMatchObject({ status: "patch_synthesized", patch_base_sha: attestation });
    const patch = (await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/release/v2.0.1"])).trim();
    expect((await gitIn(w.fx.originRepo, ["rev-parse", `${patch}^`])).trim()).toBe(attestation);
    // N.0.1 keeps main's ledger, the acceptance's line included.
    const ledger = ".nemar/corrections.jsonl";
    expect(await gitIn(w.fx.originRepo, ["show", `${patch}:${ledger}`])).toBe(
      await gitIn(w.fx.originRepo, ["show", `${attestation}:${ledger}`]),
    );
  });

  test("a run that pushed N.0.1 over the acceptance and could not record it is taken up by the next", async () => {
    await w.restore(accepted);
    let armed = false;
    w.setApiHook(async (req) => {
      if (req.method !== "POST" || !new URL(req.url).pathname.endsWith("/transition")) return;
      if (((await req.json()) as { to?: string }).to === "patch_synthesized") armed = true;
    });
    w.setApiOverride((req) => {
      if (!armed || req.method !== "POST") return null;
      armed = false;
      return Response.json({ error: "unavailable" }, { status: 503 });
    });
    const first = await resume(["--keep-upstream"]);
    expect(first.exitCode, first.all).toBe(3);
    expect(w.row().status).toBe("released");
    const pushed = (
      await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/release/v2.0.1"])
    ).trim();
    w.setApiHook(null);
    w.setApiOverride(null);
    const same = await resume(["--keep-upstream"]);
    expect(same.exitCode, same.all).toBe(3);
    expect(same.all).toContain("already this re-pull's N.0.1 commit");
    expect(w.row()).toMatchObject({ status: "patch_synthesized", patch_head_sha: pushed });
  });
});
