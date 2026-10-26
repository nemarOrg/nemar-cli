/**
 * The unattended run of an automatic re-pull (ADR 0111, decision 6 and the Phase 7d amendment;
 * epic #1046 phase 7, #1913), driven through the real entry point as the central
 * `run-upstream-repull` workflow drives it: `plan`, `execute` and `resume` with
 * `--automatic-dispatch <id>`, the dispatch read from an event file, `GH_TOKEN` the App's token.
 *
 * Everything NEMAR's is real (`repull-pr-world.ts`): the mirror and its upstream are real git and
 * git-annex repositories served as bare `file://` origins; the NEMAR API is the REAL datasets,
 * admin and users routers and the REAL report callback (`POST /webhooks/repull-state`) over
 * bun:sqlite with every migration applied, as `production` with the open switch on, reached
 * through TEST_API_URL; the dispatch is claimed by the Worker's own `claimOpenDispatch` and its
 * payload built by the Worker's own `buildUpstreamRepullPayload`. S3 is the scrub's stand-in driven
 * by the real `aws` CLI; GitHub is the suites' stand-in, which records the token of every request.
 * No mocks. `nemarDatasets/on099999` answered 404 to an organization administrator on 2026-10-25,
 * so no stand-in here names a real repository, and every GitHub base is the loopback stand-in.
 *
 * The CLI is this checkout's source with a release version (`release-cli.ts`): an automatic run
 * refuses any CLI that is not the release its dispatch names, which a test below shows for the
 * checkout's own development version.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - a clean plan reaches `pr_open` with the App's token, the record is the automatic path's, and
 *    the dispatch ends `opened` with its run's page; the run prints only the fixed lines, and none
 *    of the fixture's paths, keys, file names, subject labels or secrets;
 *  - a plan with a correction is refused before anything is written, by `plan` and, from its
 *    live plan, by `execute`, and so is a record taken up past `prepared` whose plan has one;
 *  - a copy the estimate puts past the App token's hour is refused at plan time; a run whose
 *    token has too little of its usable hour left is refused at the plan, at the execute before
 *    its record, and before a push, without writing what it could not finish; a run that outlived
 *    its token is reported `token-expired`;
 *  - the quiet line says how long the token was held and how long each step took, in seconds;
 *  - the token on the command line (checked before the plan file is read), no App token, a
 *    development build, a finish dispatch fed to `plan`, another dataset and other tags are each
 *    refused and reported (the token's report ends the dispatch); a tenth key, no event file, an
 *    unknown option and an API that is not production's are refused and NOT reported by the CLI,
 *    which ends with the failed result line (the workflow's backstop may report a shape-valid one);
 *  - a rerun finds its dispatch started and goes on;
 *  - an administrator's record of the same plan is never taken up by a run, and a create that
 *    answers with an administrator's or another record is refused;
 *  - an enrichment-shaped commit on the release branch while the run settles is recorded, and any
 *    other is `head-foreign`, recorded on the row and reported `failed`; the settle waits for the
 *    branch to be quiet by what was read, and a branch that cannot be read is `head-unreadable`;
 *    the token's hour ends the settle, which is then `head-unreadable`;
 *  - a finish takes a merged re-pull to `complete` and reports `finished` (again, after it
 *    completed), and refuses one that has not merged, another record or an administrator's,
 *    without touching it.
 *
 * What only the first production runs can check: that GitHub answers the dispatch with 204 and the
 * runner masks the token as the workflow asks; that the App token GitHub mints opens and pushes as
 * the stand-in lets it, and how GitHub refuses a push with one past its hour (simulated here by a
 * hook that turns the push away while the stand-in answers the token 401); how soon enrichment
 * commits after a push; how long a real copy takes against the estimate; and that the anonymous
 * clones of OpenNeuroDatasets the plan makes hold up on a runner.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
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
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { which } from "bun";
import { signRepullDispatchToken } from "../backend/src/services/github/callback-tokens";
import {
  type UpstreamRepullDispatchFields,
  buildUpstreamRepullPayload,
} from "../backend/src/services/github/dispatch";
import {
  claimFinishDispatch,
  claimOpenDispatch,
} from "../backend/src/services/upstream-repull-dispatch";
import type { DispatchRow, RepullRow } from "../shared/repull-state";
import { getRepull } from "../src/lib/api/repull";
import { type PlanFile, defaultPlanPath, writePlanFile } from "../src/lib/repull/digest";
import { AUTOMATIC_LINE_RE, RESULT_LINE_RE } from "../src/lib/repull/execute/automatic";
import { type OriginScratch, openOriginScratch } from "../src/lib/repull/execute/origin";
import {
  type SettleOptions,
  type Settled,
  settleReleaseHead,
} from "../src/lib/repull/execute/settle";
import { planRepull } from "../src/lib/repull/plan";
import { ADMIN_TOKEN, APP_TOKEN } from "./helpers/github-standin";
import { type ReleaseCli, releaseCli } from "./helpers/release-cli";
import { CONCEPT_DOI, PATHS, TAG_A, TAG_B, UPSTREAM_ID, gitIn } from "./helpers/repull-fixture";
import {
  ADMIN_KEY,
  type RepullWorld,
  enrichedMetadata,
  startRepullWorld,
} from "./helpers/repull-pr-world";
import { toolOrFail } from "./scrub/helpers/require-tools";

setDefaultTimeout(600_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);

const SOURCE_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const CALLBACK_SECRET = "repull-world-callback-secret";
const RUN_ID = "4242";
const RUN_URL = `https://github.com/nemarDatasets/.github/actions/runs/${RUN_ID}`;
const RELEASE_REF = "refs/heads/release/v2.0.0";

let release: ReleaseCli;
let w: RepullWorld;
/** The runner's own temp directory for the test: the event file, the plan, the marker. */
let runner: string;
const temps: string[] = [];

beforeAll(async () => {
  if (!awsInstalled) return;
  release = releaseCli();
  w = await startRepullWorld({
    fixture: { noContributorEdits: true },
    execute: false,
    cliEntry: release.entry,
  });
});

afterAll(() => {
  w?.stop();
  release?.cleanup();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!awsInstalled) return;
  await w.restore();
  w.workerEnv.AUTO_REPULL_ENABLED = "1";
  Bun.spawnSync(["chmod", "-R", "u+w", join(w.configDir, "repull")]);
  rmSync(join(w.configDir, "repull"), { recursive: true, force: true });
  runner = mkdtempSync(join(tmpdir(), "nemar-repull-auto-runner-"));
  temps.push(runner);
});

interface Claim {
  id: number;
  token: string;
}

/** A first dispatch, claimed by the Worker's own claim. */
async function claimOpen(): Promise<Claim> {
  const r = await claimOpenDispatch(w.bindings(), {
    datasetId: w.fx.datasetId,
    upstreamDs: UPSTREAM_ID,
    fromTag: TAG_A,
    toTag: TAG_B,
  });
  if (!("id" in r)) throw new Error(`nothing was claimed: ${JSON.stringify(r)}`);
  return r;
}

/** The event GitHub delivers for a dispatch, as the Worker builds its payload. */
function writeEvent(
  c: Claim,
  over: Partial<UpstreamRepullDispatchFields> = {},
  extraKeys: Record<string, string> = {},
): string {
  const payload = buildUpstreamRepullPayload({
    mode: "open",
    datasetId: w.fx.datasetId,
    upstreamDs: UPSTREAM_ID,
    fromTag: TAG_A,
    toTag: TAG_B,
    dispatchId: c.id,
    repullId: null,
    token: c.token,
    cliVersion: release.version,
    ...over,
  }).client_payload;
  const path = join(runner, "event.json");
  writeFileSync(
    path,
    JSON.stringify({
      action: "run-upstream-repull",
      client_payload: { ...payload, ...extraKeys },
      repository: { full_name: "nemarDatasets/.github" },
    }),
  );
  return path;
}

/** A command of the run, with the runner's environment. */
function auto(args: string[], extra: Record<string, string | undefined> = {}, entry?: string) {
  return w.cli(
    ["repull", ...args],
    {
      GITHUB_EVENT_PATH: join(runner, "event.json"),
      RUNNER_TEMP: runner,
      GITHUB_RUN_ID: RUN_ID,
      GITHUB_REPOSITORY: "nemarDatasets/.github",
      GITHUB_SERVER_URL: "https://github.com",
      GH_TOKEN: APP_TOKEN,
      NEMAR_REPULL_POLL_MS: "100",
      // The workflow notes the mint just before it, as `date +%s`.
      NEMAR_REPULL_TOKEN_SINCE: mintedAgo(0),
      ...extra,
    },
    undefined,
    entry,
  );
}

/** The mint's time as the workflow notes it, `minutes` before now. */
function mintedAgo(minutes: number): string {
  return String(Math.floor(Date.now() / 1000) - minutes * 60);
}

const planArgs = (c: Claim, extra: string[] = []) => [
  "plan",
  w.fx.datasetId,
  "--to-tag",
  TAG_B,
  "--bucket-listing",
  "--out",
  join(runner, "plan.json"),
  "--automatic-dispatch",
  String(c.id),
  ...extra,
];

const executeArgs = (c: Claim, plan = join(runner, "plan.json")) => [
  "execute",
  plan,
  "--automatic-dispatch",
  String(c.id),
  "--settle-minutes",
  "0",
  "--yes",
];

const dispatchRow = (id: number) =>
  w.db().query("SELECT * FROM upstream_repull_dispatches WHERE id = ?").get(id) as DispatchRow;

interface RecordRow {
  id: number;
  status: string;
  origin: string;
  head_sha: string | null;
  last_error: string | null;
}

const repullRows = () =>
  w.db().query("SELECT * FROM upstream_repulls ORDER BY id").all() as RecordRow[];

/** The commit the release branch names on the bare origin. */
const releaseHead = async () => (await gitIn(w.fx.originRepo, ["rev-parse", RELEASE_REF])).trim();

/** What none of a run's output may hold: the fixture's names and every secret the run handles. */
function forbidden(c: Claim): string[] {
  const out = [
    c.token,
    APP_TOKEN,
    ADMIN_TOKEN,
    ADMIN_KEY,
    CALLBACK_SECRET,
    "dummySecretAccessKeyForRepullWorld",
    "dummy-session-token-for-repull-world",
    w.configDir,
    runner,
    "sub-01",
    "sub-02",
    "sub-03",
    "sub-04",
    "Qwfixturelast",
    "Zxfixturename",
  ];
  for (const p of Object.values(PATHS)) out.push(p, basename(p));
  for (const k of Object.values(w.fx.keys)) if (k) out.push(k);
  return out;
}

/** The run printed only the fixed lines, ending with its result, and none of `forbidden`. */
function expectQuiet(run: { all: string; stderr: string }, c: Claim, phase: string): void {
  const lines = run.all.split("\n").filter((l) => l !== "");
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) expect([line, AUTOMATIC_LINE_RE.test(line)]).toEqual([line, true]);
  const last = lines.at(-1) ?? "";
  expect(last).toMatch(RESULT_LINE_RE);
  expect(RESULT_LINE_RE.exec(last)?.[1]).toBe(phase);
  expect(run.stderr).toBe("");
  for (const s of forbidden(c)) expect([s, run.all.includes(s)]).toEqual([s, false]);
}

/** The GitHub stand-in's requests that are not reads. */
const ghWrites = () => w.gh.seen.filter((s) => s.method !== "GET");
/** The S3 stand-in's requests that are not reads. */
const s3Writes = () =>
  w.s3.log.filter((e) => !["GetObject", "HeadObject", "ListObjectsV2"].includes(e.op));

/** Plan and execute a first dispatch to `pr_open`. */
async function opened(): Promise<{ c: Claim; row: RecordRow }> {
  const c = await claimOpen();
  writeEvent(c);
  const plan = await auto(planArgs(c));
  expect(plan.exitCode, plan.all).toBe(0);
  const exec = await auto(executeArgs(c));
  expect(exec.exitCode, exec.all).toBe(0);
  const row = repullRows()[0];
  if (!row) throw new Error("no record");
  return { c, row };
}

/** A plan file made by the planner itself, as the automatic plan would not have written it. */
async function libraryPlan(): Promise<{ path: string; file: PlanFile }> {
  const scratch = mkdtempSync(join(tmpdir(), "nemar-repull-auto-plan-"));
  temps.push(scratch);
  const made = await planRepull({
    datasetId: w.fx.datasetId,
    toTag: TAG_B,
    catalog: {
      dataset: { source: "openneuro", source_id: UPSTREAM_ID, concept_doi: CONCEPT_DOI },
      versions: [{ version: "1.0.0", source_version: TAG_A, source_version_basis: "doi" }],
    },
    github: { token: APP_TOKEN, apiBase: w.gh.url },
    env: w.fx.env,
    environment: w.apiUrl,
    workRoot: scratch,
    openNeuroGraphqlUrl: w.openNeuro.url,
  });
  if (!made.planned || !made.file.executable) throw new Error("the plan was not made");
  const path = defaultPlanPath(w.configDir, w.fx.datasetId, TAG_B, made.file.digest);
  writePlanFile(path, made.file);
  return { path, file: made.file };
}

/** A dispatch no claim would make (a finish of an unmerged record, say), written as one. */
async function dispatchFor(kind: "open" | "finish", repullId: number | null): Promise<Claim> {
  const nonce = crypto.randomUUID();
  w.db().run(
    `INSERT INTO upstream_repull_dispatches (kind, dataset_id, upstream_ds, from_tag, to_tag, repull_id, nonce, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'dispatched')`,
    [kind, w.fx.datasetId, UPSTREAM_ID, TAG_A, TAG_B, repullId, nonce],
  );
  const { id } = w.db().query("SELECT last_insert_rowid() AS id").get() as { id: number };
  return {
    id,
    token: await signRepullDispatchToken(
      { dispatchId: id, datasetId: w.fx.datasetId, nonce },
      CALLBACK_SECRET,
    ),
  };
}

const finishArgs = (c: Claim) => [
  "resume",
  w.fx.datasetId,
  "--automatic-dispatch",
  String(c.id),
  "--wait-minutes",
  "1",
  "--yes",
];

describe.skipIf(!awsInstalled)("what a run checks before it acts", () => {
  test("an API that is not production's is refused before anything is sent, and not reported", async () => {
    const c = await claimOpen();
    writeEvent(c);
    const plan = await auto(planArgs(c), { TEST_API_URL: "https://api.nemar.org.evil.example" });
    expect(plan.exitCode, plan.all).toBe(1);
    expectQuiet(plan, c, "failed");
    expect(plan.all).toContain("code=auto-api-not-production");
    expect(dispatchRow(c.id)).toMatchObject({ status: "dispatched" });
    expect(w.apiWrites).toEqual([]);
  });

  test("the token on the command line is refused before a plan file that cannot be read", async () => {
    const c = await claimOpen();
    writeEvent(c);
    const exec = await auto([
      "execute",
      join(runner, `${c.token}.json`),
      "--automatic-dispatch",
      String(c.id),
      "--yes",
    ]);
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({
      status: "refused",
      code: "auto-token-on-argv",
      nonce: null,
    });
  });

  test("an unknown option, or no event file, still ends with the failed result line", async () => {
    const c = await claimOpen();
    writeEvent(c);
    for (const run of [
      await auto([...planArgs(c), "--no-such-option"]),
      await auto(planArgs(c), { GITHUB_EVENT_PATH: join(runner, "absent.json") }),
    ]) {
      expect(run.exitCode, run.all).toBe(1);
      expectQuiet(run, c, "failed");
      expect(run.all.trim().split("\n").at(-1)).toBe(
        "repull-auto: result phase=failed code=runner-failed",
      );
    }
    expect(dispatchRow(c.id)).toMatchObject({ status: "dispatched" });
    expect(w.apiWrites).toEqual([]);
  });

  test("a finish dispatch fed to plan, or a plan of another dataset, is dispatch-mismatch", async () => {
    const c = await claimOpen();
    writeEvent(c, { mode: "finish", repullId: 1 });
    const finishFed = await auto(planArgs(c));
    expect(finishFed.exitCode, finishFed.all).toBe(1);
    expectQuiet(finishFed, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "dispatch-mismatch" });

    const other = await claimOpen();
    writeEvent(other);
    const args = planArgs(other);
    args[1] = "on004362";
    const otherDataset = await auto(args);
    expect(otherDataset.exitCode, otherDataset.all).toBe(1);
    expectQuiet(otherDataset, other, "refused");
    expect(dispatchRow(other.id)).toMatchObject({ status: "refused", code: "dispatch-mismatch" });
    expect(repullRows()).toEqual([]);
  });

  test("a --to-tag, or a plan file, for other tags than the dispatch's is dispatch-mismatch", async () => {
    const c = await claimOpen();
    writeEvent(c);
    const args = planArgs(c);
    args[3] = "1.2.0";
    const plan = await auto(args);
    expect(plan.exitCode, plan.all).toBe(1);
    expectQuiet(plan, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "dispatch-mismatch" });

    // A dispatch for upstream's 1.2.0, and a plan file for 1.1.0.
    const { path } = await libraryPlan();
    const later = await claimOpenDispatch(w.bindings(), {
      datasetId: w.fx.datasetId,
      upstreamDs: UPSTREAM_ID,
      fromTag: TAG_A,
      toTag: "1.2.0",
    });
    if (!("id" in later)) throw new Error(`nothing was claimed: ${JSON.stringify(later)}`);
    writeEvent(later, { toTag: "1.2.0" });
    const exec = await auto(executeArgs(later, path));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, later, "refused");
    expect(dispatchRow(later.id)).toMatchObject({ status: "refused", code: "dispatch-mismatch" });
    // The run refused it itself, before the create: the Worker was not asked.
    expect(w.apiWrites).not.toContain("POST /admin/repulls");
    expect(repullRows()).toEqual([]);
  });

  test("a rerun of the same run finds its dispatch started and goes on", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    const again = await auto(planArgs(c));
    expect(again.exitCode, again.all).toBe(0);
    expectQuiet(again, c, "planned");
    expect(again.all).toContain("repull-auto: report phase=started answer=already-started");
    expect(dispatchRow(c.id).status).toBe("started");
  });

  test("a create that answers with an administrator's record is not taken as the run's", async () => {
    // The Worker records the run's create as automatic; a create that answered otherwise (a
    // Worker at fault) must not be acted on as the run's.
    w.setApiAfter((req) => {
      if (req.method !== "POST" || new URL(req.url).pathname !== "/admin/repulls") return null;
      const row = w.db().query("SELECT * FROM upstream_repulls ORDER BY id DESC LIMIT 1").get() as
        | (Record<string, unknown> & { counts: string })
        | null;
      if (!row) return null;
      return Response.json({
        repull: { ...row, counts: JSON.parse(row.counts), origin: "administrator" },
        created: true,
        lineage_rows: 0,
      });
    });
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "repull-in-flight" });
    expect(repullRows()).toMatchObject([{ status: "planned" }]);
    expect(ghWrites()).toEqual([]);
  });

  test("a dispatch that continues one record and is answered with another is repull-mismatch", async () => {
    const c = await claimOpen();
    // The run is handed a dispatch that says it continues re-pull #4242.
    writeEvent(c, { repullId: 4242 });
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "repull-mismatch" });
    expect(repullRows()).toMatchObject([{ status: "planned" }]);
    expect(ghWrites()).toEqual([]);
  });

  test("a record taken up past prepared is refused when its plan has a correction", async () => {
    await w.commitOnto("refs/heads/main", PATHS.sidecar, '{"TaskName":"rest","edited":true}\n');
    const { path, file } = await libraryPlan();
    expect(file.body.counts).toMatchObject({ corrections: 1 });
    // An administrator executes it through its copy; the record is then the automatic path's (no
    // create makes such a record, which is why the run reads the counts again).
    const admin = await w.cli(
      ["repull", "execute", path, "--until", "copied", "--yes"],
      {},
      undefined,
      SOURCE_ENTRY,
    );
    expect(admin.exitCode, admin.all).toBe(0);
    w.db().run("UPDATE upstream_repulls SET origin = 'automatic'");
    const [row] = repullRows();
    const c = await claimOpenDispatch(w.bindings(), {
      datasetId: w.fx.datasetId,
      upstreamDs: UPSTREAM_ID,
      fromTag: TAG_A,
      toTag: TAG_B,
      repullId: row?.id ?? 0,
    });
    if (!("id" in c)) throw new Error(`nothing was claimed: ${JSON.stringify(c)}`);
    writeEvent(c, { repullId: row?.id ?? 0 });
    const exec = await auto(executeArgs(c, path));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-not-clean-plan" });
    expect(repullRows()).toMatchObject([{ status: "copied" }]);
    expect(ghWrites()).toEqual([]);
  });
});

describe.skipIf(!awsInstalled)("an automatic run opens its pull request", () => {
  test("a clean plan reaches pr_open as the App, recorded automatic, reported opened, printing only fixed lines", async () => {
    const c = await claimOpen();
    writeEvent(c);
    const plan = await auto(planArgs(c));
    expect(plan.exitCode, plan.all).toBe(0);
    expectQuiet(plan, c, "planned");
    expect(plan.all).toContain("repull-auto: report phase=started answer=stored");
    // How long the token was held when the command started, and each step, in seconds.
    expect(plan.all).toMatch(
      /^repull-auto: quiet suppressed=\d+ token_age_s=\d+ plan_s=\d+ run_s=\d+$/m,
    );
    expect(dispatchRow(c.id).status).toBe("started");
    // The plan never left the runner, and nothing was written but the report.
    expect(readFileSync(join(runner, "plan.json"), "utf8")).toContain('"dataset": "on099999"');
    expect(w.apiWrites).toEqual(["POST /webhooks/repull-state"]);
    expect(ghWrites()).toEqual([]);
    expect(s3Writes()).toEqual([]);

    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(0);
    expectQuiet(exec, c, "opened");
    expect(exec.all).toMatch(
      /^repull-auto: quiet suppressed=\d+ token_age_s=\d+ replan_s=\d+ clone_s=\d+ prepare_s=\d+ copy_s=\d+ register_s=\d+ pr_s=\d+ settle_s=\d+ run_s=\d+$/m,
    );
    const [row] = repullRows();
    expect(row).toMatchObject({ status: "pr_open", origin: "automatic" });
    const d = dispatchRow(c.id);
    expect(d).toMatchObject({
      status: "opened",
      repull_id: row?.id,
      nonce: null,
      workflow_run_url: RUN_URL,
      code: null,
    });
    // The pull request was opened, and the branch pushed, with the App's token.
    const created = w.gh.seen.filter(
      (s) => s.method === "POST" && s.path === `/repos/nemarDatasets/${w.fx.datasetId}/pulls`,
    );
    expect(created.map((s) => s.token)).toEqual([APP_TOKEN]);
    // The token reached the Worker only in the create's body and the reports' header.
    expect(readFileSync(join(runner, "repull-reported"), "utf8")).toBe("opened\n");
  });

  test("a plan with one correction is refused by plan before anything is written", async () => {
    // A NEMAR edit of a path upstream did not change: a correction.
    await w.commitOnto("refs/heads/main", PATHS.sidecar, '{"TaskName":"rest","edited":true}\n');
    const c = await claimOpen();
    writeEvent(c);
    const plan = await auto(planArgs(c));
    expect(plan.exitCode, plan.all).toBe(3);
    expectQuiet(plan, c, "refused");
    expect(plan.all).toContain("code=auto-not-clean-plan");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-not-clean-plan" });
    expect(repullRows()).toEqual([]);
    expect(w.apiWrites).toEqual(["POST /webhooks/repull-state", "POST /webhooks/repull-state"]);
    expect(ghWrites()).toEqual([]);
    expect(s3Writes()).toEqual([]);
  });

  test("execute refuses a plan with a correction from its live plan, before the record", async () => {
    await w.commitOnto("refs/heads/main", PATHS.sidecar, '{"TaskName":"rest","edited":true}\n');
    // A plan file the automatic plan would have refused, made by the planner itself.
    const { path, file } = await libraryPlan();
    expect(file.body.counts).toMatchObject({ corrections: 1 });
    const c = await claimOpen();
    writeEvent(c);
    const exec = await auto(executeArgs(c, path));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-not-clean-plan" });
    expect(w.apiWrites).toEqual(["POST /webhooks/repull-state"]);
    expect(repullRows()).toEqual([]);
    expect(ghWrites()).toEqual([]);
    expect(s3Writes()).toEqual([]);
  });

  test("the token on the command line is refused, and the report ends the dispatch so it is dead", async () => {
    const c = await claimOpen();
    writeEvent(c);
    const plan = await auto([
      ...planArgs(c).slice(0, 6),
      join(runner, `${c.token}.json`),
      ...planArgs(c).slice(7),
    ]);
    expect(plan.exitCode, plan.all).toBe(1);
    expectQuiet(plan, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({
      status: "refused",
      code: "auto-token-on-argv",
      nonce: null,
    });
    expect(w.apiWrites).toEqual(["POST /webhooks/repull-state"]);
  });

  test("a run with no App token is refused", async () => {
    const c = await claimOpen();
    writeEvent(c);
    const plan = await auto(planArgs(c), { GH_TOKEN: "" });
    expect(plan.exitCode, plan.all).toBe(1);
    expectQuiet(plan, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-no-app-token" });
  });

  test("a tenth key is dispatch-invalid, and nothing is reported or written", async () => {
    const c = await claimOpen();
    writeEvent(c, {}, { callback_url: "https://example.org/hook" });
    const plan = await auto(planArgs(c));
    expect(plan.exitCode, plan.all).toBe(1);
    expectQuiet(plan, c, "failed");
    expect(plan.all).toContain("code=dispatch-invalid");
    expect(dispatchRow(c.id)).toMatchObject({ status: "dispatched" });
    expect(w.apiWrites).toEqual([]);
  });

  test("a development build is refused, and says so to the Worker", async () => {
    const c = await claimOpen();
    writeEvent(c);
    const plan = await auto(planArgs(c), {}, SOURCE_ENTRY);
    expect(plan.exitCode, plan.all).toBe(1);
    expectQuiet(plan, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-cli-version" });
    expect(ghWrites()).toEqual([]);
  });

  test("an administrator's record of the same plan is never taken up by the run", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    // The administrator executes the very plan file, through its copy.
    const admin = await w.cli(
      ["repull", "execute", join(runner, "plan.json"), "--until", "copied", "--yes"],
      {},
      undefined,
      SOURCE_ENTRY,
    );
    expect(admin.exitCode, admin.all).toBe(0);
    expect(repullRows()).toMatchObject([{ status: "copied", origin: "administrator" }]);
    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "repull-in-flight" });
    expect(repullRows()).toMatchObject([{ status: "copied", origin: "administrator" }]);
    expect(w.gh.seen.filter((s) => s.token === APP_TOKEN && s.method !== "GET")).toEqual([]);
  });

  test("a copy the estimate puts past the App token's hour is refused at plan time", async () => {
    const c = await claimOpen();
    writeEvent(c);
    // The fixture's copy is small; the budget is shortened, which may only ever refuse more.
    const plan = await auto(planArgs(c), { NEMAR_REPULL_COPY_BUDGET_SECONDS: "1" });
    expect(plan.exitCode, plan.all).toBe(3);
    expectQuiet(plan, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-copy-too-long" });
    expect(repullRows()).toEqual([]);
    expect(ghWrites()).toEqual([]);
    expect(s3Writes()).toEqual([]);
  });

  test("a run with too little of the token's hour left is refused at the plan, nothing written", async () => {
    const c = await claimOpen();
    writeEvent(c);
    const plan = await auto(planArgs(c), { NEMAR_REPULL_TOKEN_SINCE: mintedAgo(56) });
    expect(plan.exitCode, plan.all).toBe(1);
    expectQuiet(plan, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-token-hour" });
    expect(repullRows()).toEqual([]);
    expect(ghWrites()).toEqual([]);
    expect(s3Writes()).toEqual([]);
  });

  test("a run that cannot tell when its token was minted is refused before it reads anything", async () => {
    const c = await claimOpen();
    writeEvent(c);
    const plan = await auto(planArgs(c), { NEMAR_REPULL_TOKEN_SINCE: "" });
    expect(plan.exitCode, plan.all).toBe(1);
    expectQuiet(plan, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-token-clock" });
    expect(w.apiWrites).toEqual(["POST /webhooks/repull-state"]);
  });

  test("an execute with too little of the token's hour left is refused before its record", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    const exec = await auto(executeArgs(c), { NEMAR_REPULL_TOKEN_SINCE: mintedAgo(50) });
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-token-hour" });
    expect(w.apiWrites).not.toContain("POST /admin/repulls");
    expect(repullRows()).toEqual([]);
    expect(ghWrites()).toEqual([]);
    expect(s3Writes()).toEqual([]);
  });

  /**
   * An automatic record an administrator took through `until`, and a resume dispatch of it run
   * with the token's hour nearly gone: the next push is refused before it starts.
   */
  async function lateResume(until: "copied" | "registered", step: string): Promise<void> {
    const { path } = await libraryPlan();
    const admin = await w.cli(
      ["repull", "execute", path, "--until", until, "--yes"],
      {},
      undefined,
      SOURCE_ENTRY,
    );
    expect(admin.exitCode, admin.all).toBe(0);
    w.db().run("UPDATE upstream_repulls SET origin = 'automatic'");
    const [row] = repullRows();
    const c = await claimOpenDispatch(w.bindings(), {
      datasetId: w.fx.datasetId,
      upstreamDs: UPSTREAM_ID,
      fromTag: TAG_A,
      toTag: TAG_B,
      repullId: row?.id ?? 0,
    });
    if (!("id" in c)) throw new Error(`nothing was claimed: ${JSON.stringify(c)}`);
    writeEvent(c, { repullId: row?.id ?? 0 });
    const head = (await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/git-annex"])).trim();
    w.gh.seen.length = 0;
    const exec = await auto(executeArgs(c, path), { NEMAR_REPULL_TOKEN_SINCE: mintedAgo(50) });
    expect(exec.exitCode, exec.all).toBe(3);
    expectQuiet(exec, c, "failed");
    expect(dispatchRow(c.id)).toMatchObject({ status: "failed", code: "auto-token-hour" });
    const [after] = repullRows();
    expect(after?.status).toBe(until);
    expect(after?.last_error).toStartWith(`[${step}:auto-token-hour]`);
    // Nothing was pushed: origin's git-annex branch did not move, and GitHub saw no write.
    expect((await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/git-annex"])).trim()).toBe(head);
    expect(ghWrites()).toEqual([]);
  }

  test("a resume with too little of the token's hour left is refused before the registration's push", async () => {
    await lateResume("copied", "register");
  });

  test("a resume with too little of the token's hour left is refused before the pull request", async () => {
    await lateResume("registered", "pr");
  });

  test("a run that outlived its App token is reported token-expired, whatever its step called it", async () => {
    // From the copy on, the token is past its hour: GitHub answers it 401, and the registration's
    // push to the origin is turned away as an expired token's would be.
    const hook = join(w.fx.originRepo, "hooks", "pre-receive");
    let armed = false;
    w.setApiHook(async (req) => {
      if (armed || req.method !== "POST" || !/\/admin\/repulls\/\d+\/transition$/.test(req.url))
        return;
      const body = (await req.json()) as { from?: string; to?: string };
      if (body.from !== "prepared" || body.to !== "copied") return;
      armed = true;
      writeFileSync(hook, "#!/bin/sh\necho 'Invalid username or token.' >&2\nexit 1\n");
      chmodSync(hook, 0o755);
      w.gh.expiredTokens.add(APP_TOKEN);
    });
    try {
      const c = await claimOpen();
      writeEvent(c);
      expect((await auto(planArgs(c))).exitCode).toBe(0);
      const exec = await auto(executeArgs(c));
      expect(armed).toBe(true);
      expect(exec.exitCode, exec.all).toBe(3);
      expectQuiet(exec, c, "failed");
      expect(exec.all).toContain("code=token-expired");
      expect(dispatchRow(c.id)).toMatchObject({ status: "failed", code: "token-expired" });
      // The record stays where the step left it, with the step's own error on it.
      const [row] = repullRows();
      expect(row?.status).toBe("copied");
      expect(row?.last_error).toStartWith("[register:");
    } finally {
      rmSync(hook, { force: true });
    }
  });
});

describe.skipIf(!awsInstalled)("the release head settles before the run reports", () => {
  /** Move the release branch the moment the run records its pull request open. */
  function moveAtPrOpen(path: string, content: (head: string) => Promise<string>): void {
    let moved = false;
    w.setApiHook(async (req) => {
      if (moved || req.method !== "POST" || !/\/admin\/repulls\/\d+\/transition$/.test(req.url))
        return;
      const body = (await req.json()) as { from?: string; to?: string };
      if (body.from !== "registered" || body.to !== "pr_open") return;
      moved = true;
      await w.commitOnto(RELEASE_REF, path, await content(RELEASE_REF));
    });
  }

  test("an enrichment-shaped commit on the release branch during the settle is recorded", async () => {
    moveAtPrOpen(".nemar/metadata.json", (ref) => enrichedMetadata(w.fx.originRepo, ref));
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(0);
    expectQuiet(exec, c, "opened");
    expect(exec.all).toContain("repull-auto: settle reads=1 moves=1 unreadable=0");
    expect(repullRows()).toMatchObject([
      { status: "pr_open", head_sha: await releaseHead(), last_error: null },
    ]);
    expect(dispatchRow(c.id).status).toBe("opened");
  });

  test("a commit enrichment does not make is head-foreign: recorded on the row, reported failed", async () => {
    moveAtPrOpen("README.md", async () => "A README someone else changed.\n");
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "failed");
    const [row] = repullRows();
    expect(row?.status).toBe("pr_open");
    expect(row?.last_error).toStartWith("[auto:head-foreign]");
    expect(row?.head_sha).not.toBe(await releaseHead());
    expect(dispatchRow(c.id)).toMatchObject({ status: "failed", code: "head-foreign" });
  });

  /**
   * The library's settle on the world's record, in this process, against the world's API as the
   * administrator, on a virtual clock: `sleep` advances it, and `onTick` may move the branch at a
   * virtual instant, so nothing here waits on the machine's clock.
   */
  async function withSettle(
    fn: (s: {
      live: RepullRow;
      scratch: OriginScratch;
      settle: (
        row: RepullRow,
        opts: SettleOptions,
        onTick?: (t: number) => Promise<void>,
        deadlineAfterMs?: number,
      ) => Promise<{ result: Settled; took: number }>;
    }) => Promise<void>,
    scratchEnv: Record<string, string> = w.fx.env,
  ): Promise<void> {
    const { row } = await opened();
    const saved = { url: process.env.TEST_API_URL, dir: process.env.NEMAR_CONFIG_DIR };
    process.env.TEST_API_URL = w.apiUrl;
    process.env.NEMAR_CONFIG_DIR = w.configDir;
    const digest = JSON.parse(readFileSync(join(runner, "plan.json"), "utf8")).digest as string;
    const scratch = await openOriginScratch({
      configDir: w.configDir,
      datasetId: w.fx.datasetId,
      digest,
      purpose: "settle",
      env: scratchEnv,
      token: null,
    });
    try {
      const live = (await getRepull(row.id)) as RepullRow;
      await fn({
        live,
        scratch,
        async settle(r, opts, onTick, deadlineAfterMs) {
          let t = 1_000_000;
          const start = t;
          const result = await settleReleaseHead({
            scratch,
            row: r,
            opts,
            out: () => {},
            ...(deadlineAfterMs === undefined ? {} : { deadlineMs: start + deadlineAfterMs }),
            now: () => t,
            sleep: async (ms) => {
              t += ms;
              await onTick?.(t - start);
            },
          });
          return { result, took: t - start };
        },
      });
    } finally {
      scratch.close();
      for (const [k, v] of [
        ["TEST_API_URL", saved.url],
        ["NEMAR_CONFIG_DIR", saved.dir],
      ] as const) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
    }
  }

  const QUIET = 5 * 60_000;
  const POLL = 15_000;

  test("a branch quiet from the start settles after the quiet period, on the virtual clock", async () => {
    await withSettle(async ({ live, settle }) => {
      const { result, took } = await settle(live, {
        maxWaitMs: 30 * 60_000,
        quietMs: QUIET,
        pollMs: POLL,
      });
      expect(result).toMatchObject({ outcome: "settled", moves: 0, unreadable: 0, cause: null });
      expect(took).toBe(QUIET);
      expect(result.reads).toBe(QUIET / POLL + 1);
    });
  });

  test("a move that lands while it waits is recorded, and the quiet period counts again from it", async () => {
    await withSettle(async ({ live, settle }) => {
      let landedAt = -1;
      const { result, took } = await settle(
        live,
        { maxWaitMs: 30 * 60_000, quietMs: QUIET, pollMs: POLL },
        async (elapsed) => {
          if (landedAt >= 0 || elapsed < 2 * 60_000) return;
          landedAt = elapsed;
          await w.commitOnto(
            RELEASE_REF,
            ".nemar/metadata.json",
            await enrichedMetadata(w.fx.originRepo, RELEASE_REF, "2026-10-25T01:00:00Z"),
          );
        },
      );
      expect(result).toMatchObject({ outcome: "settled", moves: 1, unreadable: 0 });
      expect(landedAt).toBe(2 * 60_000);
      expect(took).toBe(landedAt + QUIET);
      expect(result.row.head_sha).toBe(await releaseHead());
      expect(repullRows()[0]?.head_sha).toBe(await releaseHead());
    });
  });

  test("a bound shorter than the quiet period ends the settle at the bound", async () => {
    await withSettle(async ({ live, settle }) => {
      const { result, took } = await settle(live, {
        maxWaitMs: 60_000,
        quietMs: QUIET,
        pollMs: POLL,
      });
      expect(result.outcome).toBe("settled");
      expect(took).toBe(60_000);
    });
  });

  test("a branch that cannot be read is never settled: head-unreadable, recorded with its cause", async () => {
    await withSettle(
      async ({ live, settle }) => {
        const { result, took } = await settle(live, {
          maxWaitMs: 10 * 60_000,
          quietMs: QUIET,
          pollMs: POLL,
        });
        expect(result).toMatchObject({ outcome: "unreadable", moves: 0 });
        expect(result.unreadable).toBe(result.reads);
        expect(result.cause).toBe("origin-unreadable");
        expect(took).toBe(10 * 60_000);
        const [row] = repullRows();
        expect(row?.status).toBe("pr_open");
        expect(row?.head_sha).toBe(live.head_sha);
        expect(row?.last_error).toStartWith("[auto:head-unreadable]");
        expect(row?.last_error).toContain("(origin-unreadable)");
        expect(row?.last_error).not.toContain("abandon a record is built");
        // No later run settles it: the record says who does.
        expect(row?.last_error).not.toContain("later run");
        expect(row?.last_error).toContain("an administrator's resume settles it");
      },
      { ...w.fx.env, NEMAR_REPULL_ORIGIN_BASE: join(runner, "no-such-origins") },
    );
  });

  test("the token's hour ends a settle before the branch is quiet: head-unreadable, never past it", async () => {
    await withSettle(async ({ live, settle }) => {
      const { result, took } = await settle(
        live,
        { maxWaitMs: 30 * 60_000, quietMs: QUIET, pollMs: POLL },
        undefined,
        2 * 60_000,
      );
      expect(result).toMatchObject({ outcome: "unreadable", cause: "token-hour", unreadable: 0 });
      expect(took).toBe(2 * 60_000);
      expect(result.reads).toBe((2 * 60_000) / POLL + 1);
      const [row] = repullRows();
      expect(row?.status).toBe("pr_open");
      expect(row?.last_error).toStartWith("[auto:head-unreadable]");
      expect(row?.last_error).toContain("(token-hour)");
    });
  });

  test("a token whose hour is over reads nothing, and a later end leaves the settle as it was", async () => {
    await withSettle(async ({ live, settle }) => {
      const opts = { maxWaitMs: 30 * 60_000, quietMs: QUIET, pollMs: POLL };
      const over = await settle(live, opts, undefined, 0);
      expect(over.result).toMatchObject({ outcome: "unreadable", cause: "token-hour", reads: 0 });
      expect(over.took).toBe(0);
      const later = await settle(live, opts, undefined, 10 * 60_000);
      expect(later.result).toMatchObject({ outcome: "settled", cause: null });
      expect(later.took).toBe(QUIET);
    });
  });

  test("through the CLI, the settle of a run past the token's hour reads nothing", async () => {
    // A run that takes up a record already at `pr_open` goes straight to the settle, so the
    // settle's own end at the token's hour is all that stands between it and an expired token.
    const { row } = await opened();
    const c = await dispatchFor("open", row.id);
    writeEvent(c, { repullId: row.id });
    const exec = await auto(executeArgs(c), { NEMAR_REPULL_TOKEN_SINCE: mintedAgo(56) });
    expect(exec.exitCode, exec.all).toBe(3);
    expectQuiet(exec, c, "failed");
    expect(exec.all).toContain("repull-auto: settle reads=0 moves=0 unreadable=0");
    expect(dispatchRow(c.id)).toMatchObject({ status: "failed", code: "head-unreadable" });
    expect(repullRows()[0]?.last_error).toContain("(token-hour)");
  });

  test("reads that stop succeeding for a whole quiet period do not settle the branch", async () => {
    await withSettle(async ({ live, settle, scratch }) => {
      let broken = false;
      const { result } = await settle(
        live,
        { maxWaitMs: 10 * 60_000, quietMs: QUIET, pollMs: POLL },
        async (elapsed) => {
          // From the second read on, origin's address is one that cannot be read.
          if (broken || elapsed < POLL) return;
          broken = true;
          await Bun.$`git -C ${scratch.dir} remote set-url origin ${join(runner, "gone")}`.quiet();
        },
      );
      expect(result.outcome).toBe("unreadable");
      expect(result.reads).toBeGreaterThan(result.unreadable);
    });
  });

  test("through the CLI, a release branch that cannot be read is reported head-unreadable, not opened", async () => {
    const moved = `${w.fx.originRepo}.away`;
    let away = false;
    w.setApiHook(async (req) => {
      if (away || req.method !== "POST" || !/\/admin\/repulls\/\d+\/transition$/.test(req.url))
        return;
      const body = (await req.json()) as { from?: string; to?: string };
      if (body.from !== "registered" || body.to !== "pr_open") return;
      away = true;
      renameSync(w.fx.originRepo, moved);
    });
    try {
      const c = await claimOpen();
      writeEvent(c);
      expect((await auto(planArgs(c))).exitCode).toBe(0);
      const exec = await auto(executeArgs(c));
      expect(away).toBe(true);
      expect(exec.exitCode, exec.all).toBe(3);
      expectQuiet(exec, c, "failed");
      expect(dispatchRow(c.id)).toMatchObject({ status: "failed", code: "head-unreadable" });
      expect(repullRows()[0]?.last_error).toStartWith("[auto:head-unreadable]");
    } finally {
      if (away) renameSync(moved, w.fx.originRepo);
    }
  });
});

describe.skipIf(!awsInstalled)("a finish", () => {
  test("at pr_open it is finish-not-merged, and nothing is touched", async () => {
    const { row } = await opened();
    const c = await dispatchFor("finish", row.id);
    writeEvent(c, { mode: "finish", repullId: row.id });
    w.apiWrites.length = 0;
    w.gh.seen.length = 0;
    const run = await auto(finishArgs(c));
    expect(run.exitCode, run.all).toBe(1);
    expectQuiet(run, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "finish-not-merged" });
    expect(repullRows()).toMatchObject([{ status: "pr_open" }]);
    expect(w.apiWrites).toEqual(["POST /webhooks/repull-state", "POST /webhooks/repull-state"]);
    expect(ghWrites()).toEqual([]);
  });

  test("a merged automatic re-pull is walked to complete and reported finished", async () => {
    const { row } = await opened();
    // An administrator merges it through the one gate, as the Worker's merge is not built yet.
    const resume = () =>
      w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes"]);
    expect((await resume()).exitCode).toBe(3);
    const head = repullRows()[0]?.head_sha as string;
    await w.reportScreen(head, "clean");
    expect((await resume()).exitCode).toBe(0);
    const merge = await w.cli(["repull", "merge", w.fx.datasetId, "--yes"]);
    expect(merge.exitCode, merge.all).toBe(0);
    expect(repullRows()[0]?.status).toBe("merged");
    // The dataset workflow tags the merge, and the DOI's callback writes the version row.
    await w.tagMain("2.0.0");
    w.insertVersionRow("2.0.0");

    const claimed = await claimFinishDispatch(
      w.bindings(),
      w.db().query("SELECT * FROM upstream_repulls WHERE id = ?").get(row.id) as RepullRow,
    );
    if (!("id" in claimed)) throw new Error(`no finish claim: ${JSON.stringify(claimed)}`);
    writeEvent(claimed, { mode: "finish", repullId: row.id });
    const run = await auto(finishArgs(claimed));
    expect(run.exitCode, run.all).toBe(0);
    expectQuiet(run, claimed, "finished");
    expect(repullRows()).toMatchObject([{ status: "complete", origin: "automatic" }]);
    expect(dispatchRow(claimed.id)).toMatchObject({
      status: "finished",
      nonce: null,
      workflow_run_url: RUN_URL,
    });

    // A finish of the same record after it completed (an earlier run whose report was lost):
    // there is no open record, the dataset's latest is the dispatch's and complete, so it is finished.
    const again = await dispatchFor("finish", row.id);
    writeEvent(again, { mode: "finish", repullId: row.id });
    const rerun = await auto(finishArgs(again));
    expect(rerun.exitCode, rerun.all).toBe(0);
    expectQuiet(rerun, again, "finished");
    expect(dispatchRow(again.id)).toMatchObject({ status: "finished" });
  });

  test("a finish naming another record, or an administrator's, is repull-mismatch and touches nothing", async () => {
    const { row } = await opened();
    w.apiWrites.length = 0;
    w.gh.seen.length = 0;
    const another = await dispatchFor("finish", row.id + 1);
    writeEvent(another, { mode: "finish", repullId: row.id + 1 });
    const r1 = await auto(finishArgs(another));
    expect(r1.exitCode, r1.all).toBe(1);
    expectQuiet(r1, another, "refused");
    expect(dispatchRow(another.id)).toMatchObject({ status: "refused", code: "repull-mismatch" });

    w.db().run("UPDATE upstream_repulls SET origin = 'administrator' WHERE id = ?", [row.id]);
    const admins = await dispatchFor("finish", row.id);
    writeEvent(admins, { mode: "finish", repullId: row.id });
    const r2 = await auto(finishArgs(admins));
    expect(r2.exitCode, r2.all).toBe(1);
    expectQuiet(r2, admins, "refused");
    expect(dispatchRow(admins.id)).toMatchObject({ status: "refused", code: "repull-mismatch" });

    expect(repullRows()).toMatchObject([{ status: "pr_open" }]);
    // Only the reports were written: no screen, no transition.
    expect(w.apiWrites.every((p) => p === "POST /webhooks/repull-state")).toBe(true);
    expect(ghWrites()).toEqual([]);
  });

  test("with no open record and none complete, a finish is finish-not-merged", async () => {
    const c = await dispatchFor("finish", 1);
    writeEvent(c, { mode: "finish", repullId: 1 });
    const run = await auto(finishArgs(c));
    expect(run.exitCode, run.all).toBe(1);
    expectQuiet(run, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "finish-not-merged" });
  });
});
