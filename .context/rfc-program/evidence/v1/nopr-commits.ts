// V1 item 4 follow-up: for tagged commits with no producing pull request, read what GitHub itself
// authenticates about the commit (GET /commits/{sha}); author fields are recorded but are not evidence.
import { readFileSync, writeFileSync } from "node:fs";
const j = JSON.parse(readFileSync("q4b-sample-github-raw.json", "utf8"));
const out: any[] = [];
for (const e of j.sample) for (const v of e.versions) {
  if (!v.pulls || v.pulls.length) continue;
  const p = Bun.spawn(["gh", "api", `repos/nemarDatasets/${e.dataset_id}/commits/${v.sha}`], { stdout: "pipe", stderr: "pipe" });
  const t = await new Response(p.stdout).text(); await p.exited;
  const c = JSON.parse(t);
  out.push({
    dataset_id: e.dataset_id, version: v.version, sha: v.sha,
    author_login: c.author?.login ?? null, committer_login: c.committer?.login ?? null,
    git_author_name: c.commit.author.name, git_committer_name: c.commit.committer.name,
    verified: c.commit.verification?.verified, verification_reason: c.commit.verification?.reason,
    message_first_line: v.commit_message_first_line,
  });
}
writeFileSync("q4c-nopr-commits.json", JSON.stringify(out, null, 2));
console.log(out.length);
