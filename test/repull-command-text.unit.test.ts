/**
 * What `nemar admin repull` tells an administrator (ADR 0111; epic #1046 phase 6, #1912): the
 * confirmation names only what the run will do up to `--until`, and no help, output or pull request
 * body names a command that does not exist (an abandon command is not built; `plan`, `execute`,
 * `status`, `resume`, `merge` and `canary` are).
 */

import { describe, expect, test } from "bun:test";
import { confirmQuestion, repullCommand } from "../src/commands/admin-repull";
import { releaseBody } from "../src/lib/repull/execute/pull-request";
import type { ExecuteSummary } from "../src/lib/repull/execute/run";

const SUMMARY: ExecuteSummary = {
  datasetId: "on004362",
  fromTag: "1.0.0",
  toTag: "1.1.0",
  toVersion: "2.0.0",
  doiCount: 2,
  copyItems: 17,
  status: null,
  until: "pr_open",
};

describe("the confirmation depends on --until", () => {
  test("pr_open names the copy, the registration, the push and the pull request", () => {
    const q = confirmQuestion(SUMMARY);
    expect(q).toContain("copy up to 17 object(s) from upstream by version");
    expect(q).toContain("push release/v2.0.0 and open its pull request");
    expect(q).toContain("stop at pr_open");
    expect(q).toContain("never merges");
    expect(q).toContain("2 version DOI(s)");
  });

  test("an earlier stop does not promise a later write", () => {
    const planned = confirmQuestion({ ...SUMMARY, until: "planned" });
    expect(planned).toContain("record the re-pull and stop at planned");
    expect(planned).not.toMatch(/copy|push|pull request|register/);

    const prepared = confirmQuestion({ ...SUMMARY, until: "prepared" });
    expect(prepared).toContain("stop at prepared");
    expect(prepared).toContain("prepare it");
    expect(prepared).not.toMatch(/copy up to|push release|open its pull request|register the keys/);

    const copied = confirmQuestion({ ...SUMMARY, until: "copied" });
    expect(copied).toContain("copy up to 17 object(s)");
    expect(copied).not.toMatch(/push release|open its pull request|register the keys/);

    const registered = confirmQuestion({ ...SUMMARY, until: "registered" });
    expect(registered).toContain("register the keys");
    expect(registered).not.toMatch(/push release|open its pull request/);
  });

  test("a continued run says where it continues from", () => {
    expect(confirmQuestion({ ...SUMMARY, status: "copied" })).toContain("from copied");
  });
});

function helpOf(name: string): string {
  const sub = repullCommand.commands.find((c) => c.name() === name);
  if (!sub) throw new Error(`no ${name} command`);
  const chunks: string[] = [];
  sub.configureOutput({ writeOut: (s) => chunks.push(s), writeErr: (s) => chunks.push(s) });
  sub.outputHelp();
  return chunks.join("").replace(/\s+/g, " ");
}

describe("no text names a command that does not exist", () => {
  test("the commands that exist are plan, execute, status, resume, merge and canary", () => {
    expect(repullCommand.commands.map((c) => c.name()).sort()).toEqual([
      "canary",
      "execute",
      "merge",
      "plan",
      "resume",
      "status",
    ]);
  });

  test("the execute help names resume and merge, and says abandon is not built", () => {
    const help = helpOf("execute");
    expect(help).toContain("nemar admin repull resume <id>");
    expect(help).toContain("nemar admin repull merge <id>");
    expect(help).not.toMatch(/repull abandon/);
    expect(help).toContain("Abandoning a re-pull is not built yet");
    expect(help).toContain("a message that ends with the commit's two trailers");
  });

  test("the resume and merge help say what each writes, and that resume never merges", () => {
    const resume = helpOf("resume");
    expect(resume).toContain("It never merges");
    expect(resume).toContain("--acknowledge-identifier-screen");
    const merge = helpOf("merge");
    expect(merge).toContain("squash-merges at the screened commit");
    expect(merge).toContain("today's re-pull merge cap");
  });

  test("the canary help names the scratch prefix and bucket rules", () => {
    const help = helpOf("canary");
    expect(help).toContain("xx099900 to xx099999");
    expect(help).toContain("--bucket must be nemar");
  });
});

describe("the pull request body", () => {
  const body = releaseBody({
    datasetId: "on004362",
    repullId: 4,
    ds: "ds004362",
    fromTag: "1.0.0",
    toTag: "1.1.0",
    toVersion: "2.0.0",
    patchVersion: "2.0.1",
    digest: `sha256:${"ab".repeat(32)}`,
    doiCount: 2,
    counts: { delta_paths: 3 },
  });

  test("names the commands that take it on and merge it, and none that does not exist", () => {
    expect(body).toContain("nemar admin repull resume on004362");
    expect(body).toContain("nemar admin repull merge on004362");
    expect(body).toContain("nemar admin pr-reviews");
    expect(body).not.toMatch(/repull abandon/);
  });

  test("states that the squash message must end with both trailers, then gives them", () => {
    expect(body).toContain("The squash commit message must end with both trailers");
    expect(body).toContain("as its last paragraph");
    expect(body).toContain("the merge path writes that message itself");
    expect(body).toContain("Upstream-Snapshot: ds004362@1.1.0");
    expect(body).toContain(`Repull-Plan: sha256:${"ab".repeat(32)}`);
    expect(body).toContain("Do not merge this from GitHub's page.");
  });

  test("names counts and the digest, never a path or a key", () => {
    expect(body).not.toMatch(/SHA256E|sub-\d|\.edf/);
  });
});
