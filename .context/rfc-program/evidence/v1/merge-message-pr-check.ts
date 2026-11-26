// V1 item 4 follow-up: for tagged commits with no pull request whose message is "Merge pull request #N ...",
// read that pull request (GET /pulls/N) and record whether its merge commit is the tagged commit.
// Run from this directory: bun merge-message-pr-check.ts [output-file]   (default: q4d-merge-message-pr-check.json)
// Input: q4c-nopr-commits.json (from nopr-commits.ts). GET requests only.
import { readFileSync, writeFileSync } from "node:fs";
const rows = JSON.parse(readFileSync("q4c-nopr-commits.json", "utf8")) as any[];
const out: any[] = [];
for (const r of rows) {
  const m = /^Merge pull request #(\d+)/.exec(r.message_first_line);
  if (!m) continue;
  const n = Number(m[1]);
  const p = Bun.spawn(["gh", "api", `repos/nemarDatasets/${r.dataset_id}/pulls/${n}`], { stdout: "pipe", stderr: "pipe" });
  const t = await new Response(p.stdout).text(); await p.exited;
  const pr = JSON.parse(t);
  out.push({
    dataset_id: r.dataset_id, version: r.version, sha: r.sha, message_pr: n,
    pr_author: pr.user?.login ?? null, pr_state: pr.state, merged: pr.merged,
    merge_commit_sha: pr.merge_commit_sha, sha_matches: pr.merge_commit_sha === r.sha,
  });
}
writeFileSync(process.argv[2] ?? "q4d-merge-message-pr-check.json", JSON.stringify(out, null, 2));
console.log(out.length);
