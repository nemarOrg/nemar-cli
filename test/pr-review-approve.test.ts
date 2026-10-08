/**
 * Approving a dataset pull request as the administrator themselves (ADR 0093): the GitHub side,
 * driven against a local `Bun.serve()` stand-in for api.github.com that answers by WHO is asking.
 *
 * What is pinned is what keeps an approval honest: only a person's token is accepted, the approval
 * is recorded on the commit that was shown, the answer is checked rather than assumed, and a
 * merge needs GitHub's own word that it is clean and never goes around the ruleset.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  adminGitHubToken,
  approvalGate,
  fetchPullRequest,
  githubApiBase,
  identityMatches,
  manualApprovalCommand,
  mergeWhenClean,
  pullRequestUrl,
  refusalFor,
  submitApproval,
  whoAmI,
} from "../src/lib/pr-review-approve";
import {
  ADMIN_TOKEN,
  APP_TOKEN,
  BOT_LOGIN_TOKEN,
  BOT_TOKEN,
  BOT_TYPE_TOKEN,
  type GitHubStandin,
  OTHER_TOKEN,
  startGitHubStandin,
} from "./helpers/github-standin";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const gh: GitHubStandin = startGitHubStandin();
const base = () => gh.url;

afterAll(() => gh.stop());
beforeEach(() => gh.reset());

describe("the GitHub origin", () => {
  test("is api.github.com unless a loopback http origin is given for a test", () => {
    expect(githubApiBase({})).toBe("https://api.github.com");
    expect(githubApiBase({ NEMAR_GITHUB_API_URL: "http://127.0.0.1:4010/" })).toBe(
      "http://127.0.0.1:4010",
    );
    expect(githubApiBase({ NEMAR_GITHUB_API_URL: "http://localhost:4010" })).toBe(
      "http://localhost:4010",
    );
  });

  test("never sends an administrator's token to a host that is not this machine", () => {
    for (const evil of [
      "http://evil.test",
      "https://evil.test",
      "https://127.0.0.1:4010",
      "http://127.0.0.1.evil.test",
      "http://localhost.evil.test",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(githubApiBase({ NEMAR_GITHUB_API_URL: evil })).toBe("https://api.github.com");
    }
  });
});

describe("the administrator's own token", () => {
  const ghThatFails = async () => {
    throw new Error("gh must not be run when GH_TOKEN is set");
  };

  test("GH_TOKEN wins and gh is not asked", async () => {
    const r = await adminGitHubToken({ GH_TOKEN: " tok " }, ghThatFails as never);
    expect(r).toEqual({ ok: true, token: "tok", source: "GH_TOKEN" });
  });

  test("GITHUB_TOKEN is never read: in a workflow it is the Actions bot's", async () => {
    const run = (async () => ({ stdout: "", stderr: "not logged in", exitCode: 1 })) as never;
    const r = await adminGitHubToken({ GITHUB_TOKEN: "ghs_actions" }, run);
    expect(r.ok).toBe(false);
  });

  test("falls back to the token gh holds, and says why when it has none", async () => {
    const good = (async () => ({ stdout: "gho_from_gh\n", stderr: "", exitCode: 0 })) as never;
    expect(await adminGitHubToken({}, good)).toEqual({
      ok: true,
      token: "gho_from_gh",
      source: "gh",
    });
    const signedOut = (async () => ({
      stdout: "",
      stderr: "You are not logged into any GitHub hosts.\nmore",
      exitCode: 1,
    })) as never;
    const out = await adminGitHubToken({}, signedOut);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("not logged into any GitHub hosts");
    const missing = (async () => {
      throw new Error("ENOENT: no such file or directory, posix_spawn 'gh'");
    }) as never;
    const none = await adminGitHubToken({}, missing);
    expect(none).toEqual({ ok: false, reason: "The GitHub CLI (gh) is not installed." });
  });
});

describe("who a token is", () => {
  test("a person's token names the login", async () => {
    expect(await whoAmI(ADMIN_TOKEN, base())).toEqual({
      ok: true,
      user: { login: "queueadmin-gh", id: 9001 },
    });
  });

  test("an app installation token is refused, not accepted as someone", async () => {
    const r = await whoAmI(APP_TOKEN, base());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("not_a_person");
      expect(r.reason).toContain("app or workflow token cannot approve for you");
    }
  });

  test("a bot account and a rejected token are not people either", async () => {
    // Refused by its login (`[bot]`) AND, independently, by its account type.
    const bot = await whoAmI(BOT_TOKEN, base());
    expect(bot).toMatchObject({ ok: false, kind: "not_a_person" });
    const botByType = await whoAmI(BOT_TYPE_TOKEN, base());
    expect(botByType).toMatchObject({ ok: false, kind: "not_a_person" });
    const botByLogin = await whoAmI(BOT_LOGIN_TOKEN, base());
    expect(botByLogin).toMatchObject({ ok: false, kind: "not_a_person" });
    const bad = await whoAmI("nonsense", base());
    expect(bad).toMatchObject({
      ok: false,
      kind: "not_a_person",
      reason: "GitHub rejected this token.",
    });
  });

  test("an unreachable GitHub is said to be unreachable, which is not a verdict on the token", async () => {
    const r = await whoAmI(ADMIN_TOKEN, "http://127.0.0.1:1");
    expect(r).toMatchObject({ ok: false, kind: "unreachable" });
  });

  test("the NEMAR-linked login must match, ignoring case; an unlinked account is not a mismatch", () => {
    expect(identityMatches("Queueadmin-GH", "queueadmin-gh")).toBe("match");
    expect(identityMatches("someone", "queueadmin-gh")).toBe("mismatch");
    expect(identityMatches(null, "queueadmin-gh")).toBe("unlinked");
    expect(identityMatches("", "queueadmin-gh")).toBe("unlinked");
    // Not a different person's login that merely contains it.
    expect(identityMatches("queueadmin", "queueadmin-gh")).toBe("mismatch");
  });
});

describe("what the review's verdict allows", () => {
  test("a pass proceeds; a failure and a review still running need --force; the rest ask first", () => {
    expect(approvalGate({ verdict: "pass", staleVerdict: null })).toEqual({ kind: "proceed" });
    expect(approvalGate({ verdict: "fail", staleVerdict: null }).kind).toBe("needs_force");
    expect(approvalGate({ verdict: "in_progress", staleVerdict: null }).kind).toBe("needs_force");
    for (const v of ["uncertain", "could_not_decide", "not_reviewed"] as const) {
      expect(approvalGate({ verdict: v, staleVerdict: null }).kind).toBe("confirm");
    }
  });

  test("a stale review says which earlier verdict it was, so a stale pass is not read as a pass", () => {
    const gate = approvalGate({ verdict: "not_reviewed", staleVerdict: "pass" });
    expect(gate.kind).toBe("confirm");
    if (gate.kind === "confirm") expect(gate.warning).toContain("earlier commit");
    expect(gate.kind).not.toBe("proceed");
  });
});

describe("a pull request that cannot be approved", () => {
  const open = {
    open: true,
    merged: false,
    draft: false,
    baseRef: "main",
    headSha: SHA_A,
    authorLogin: "contributor",
    mergeableState: "clean",
  };
  test("is refused for the right reason, and an ordinary one is not", () => {
    expect(refusalFor(open)).toBeNull();
    expect(refusalFor({ ...open, merged: true })).toContain("already merged");
    expect(refusalFor({ ...open, open: false })).toContain("closed");
    expect(refusalFor({ ...open, baseRef: "dev" })).toContain("not main");
    expect(refusalFor({ ...open, draft: true })).toContain("draft");
  });

  test("the fallback names the link and the equivalent gh command", () => {
    expect(pullRequestUrl("nm000201", 7)).toBe("https://github.com/nemarDatasets/nm000201/pull/7");
    expect(manualApprovalCommand("nm000201", 7)).toBe(
      "gh pr review 7 --repo nemarDatasets/nm000201 --approve",
    );
  });
});

describe("reading the pull request", () => {
  test("returns what GitHub says now", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, author: "alice", mergeableState: "blocked" };
    const r = await fetchPullRequest(ADMIN_TOKEN, "nm000201", 7, base());
    expect(r).toEqual({
      ok: true,
      value: {
        open: true,
        merged: false,
        draft: false,
        baseRef: "main",
        headSha: SHA_A,
        authorLogin: "alice",
        mergeableState: "blocked",
      },
    });
  });

  test("a pull request you cannot see is a 404 that says so", async () => {
    const r = await fetchPullRequest(ADMIN_TOKEN, "nm000201", 99, base());
    expect(r).toMatchObject({ ok: false, status: 404 });
    if (!r.ok) expect(r.reason).toContain("has no pull request #99");
  });
});

describe("approving", () => {
  const approve = (sha = SHA_A, login = "queueadmin-gh") =>
    submitApproval(ADMIN_TOKEN, "nm000201", 7, sha, login, "Looks right.", base());

  test("is recorded on the exact commit shown, under the administrator's token", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A };
    expect(await approve()).toEqual({ ok: true });
    const post = gh.seen.find((s) => s.method === "POST" && s.path.endsWith("/reviews"));
    expect(post?.token).toBe(ADMIN_TOKEN);
    expect(post?.body).toEqual({ commit_id: SHA_A, event: "APPROVE", body: "Looks right." });
  });

  test("an approval of an older commit stays on that commit when the branch has moved", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_B }; // the head moved on after the administrator looked
    expect(await approve(SHA_A)).toEqual({ ok: true });
    const post = gh.seen.find((s) => s.path.endsWith("/reviews"));
    expect((post?.body as { commit_id: string }).commit_id).toBe(SHA_A);
  });

  test("trusts GitHub's answer, not the request: a review that is not an approval is a failure", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A };
    gh.reviewState = "COMMENTED";
    const r = await approve();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not the approval that was asked for");
  });

  test("an approval recorded under a different login than the one checked is a failure", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A };
    const r = await approve(SHA_A, "someone-else");
    expect(r.ok).toBe(false);
  });

  test("GitHub's refusal comes through in plain words", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A };
    gh.reviewStatus = 422;
    const r = await approve();
    expect(r).toMatchObject({ ok: false, status: 422 });
    if (!r.ok) expect(r.reason).toContain("Can not approve your own pull request");
  });
});

describe("merging", () => {
  const merge = (method: "merge" | "squash" | "rebase" = "merge", sha = SHA_A) =>
    mergeWhenClean(ADMIN_TOKEN, "nm000201", 7, sha, method, {
      base: base(),
      sleep: async () => {},
    });
  const puts = () => gh.seen.filter((s) => s.method === "PUT");

  test("merges the approved commit when GitHub says it is clean, with the chosen method", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, mergeableState: "clean" };
    expect(await merge("squash")).toEqual({ ok: true });
    expect(puts()).toHaveLength(1);
    expect(puts()[0].token).toBe(ADMIN_TOKEN);
    expect(puts()[0].body).toEqual({ sha: SHA_A, merge_method: "squash" });
  });

  test("asks again while GitHub is still working out mergeability, then merges", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, mergeableState: "clean", unknownReads: 2 };
    let slept = 0;
    const r = await mergeWhenClean(ADMIN_TOKEN, "nm000201", 7, SHA_A, "merge", {
      base: base(),
      sleep: async () => {
        slept++;
      },
    });
    expect(r).toEqual({ ok: true });
    expect(slept).toBe(2);
  });

  test("never merges around the ruleset: anything but clean is reported and nothing is sent", async () => {
    for (const state of ["blocked", "behind", "dirty", "unstable", "draft"]) {
      gh.reset();
      gh.pulls["nm000201#7"] = { sha: SHA_A, mergeableState: state };
      const r = await merge();
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.mergeableState).toBe(state);
        expect(r.reason).toContain("The approval stands");
      }
      expect(puts()).toHaveLength(0);
    }
  });

  test("gives up on a mergeability GitHub never settles, rather than guessing", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, unknownReads: 99 };
    const r = await mergeWhenClean(ADMIN_TOKEN, "nm000201", 7, SHA_A, "merge", {
      base: base(),
      sleep: async () => {},
      tries: 3,
    });
    expect(r.ok).toBe(false);
    expect(puts()).toHaveLength(0);
  });

  test("does not merge a branch that moved after the approval", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_B, mergeableState: "clean" };
    const r = await merge("merge", SHA_A);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(puts()).toHaveLength(0);
  });

  test("a refusal from GitHub at the last step is reported, not swallowed", async () => {
    gh.pulls["nm000201#7"] = { sha: SHA_A, mergeableState: "clean" };
    gh.mergeStatus = 405;
    const r = await merge();
    expect(r).toMatchObject({ ok: false, status: 405 });
    if (!r.ok) expect(r.reason).toContain("not mergeable");
  });
});

// A different person's token is a person, which is why identity is matched against the NEMAR link.
test("another person's token is a person: the NEMAR link is what tells them apart", async () => {
  expect(await whoAmI(OTHER_TOKEN, base())).toMatchObject({
    ok: true,
    user: { login: "someone-else" },
  });
});
