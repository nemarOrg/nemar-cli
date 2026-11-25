// V1 item 4 secondary measure (not the card's rule): for a version whose tagged commit has no pull request,
// list merged pull requests whose merge commit lies between the previous version's tag and this tag.
// GET requests only. Output: q4e-range-prs.json
import { readFileSync, writeFileSync } from "node:fs";
const j = JSON.parse(readFileSync("q4b-sample-github-raw.json", "utf8"));
async function gh(path: string) {
  const p = Bun.spawn(["gh", "api", "--paginate", path], { stdout: "pipe", stderr: "pipe" });
  const t = await new Response(p.stdout).text(); await p.exited;
  // --paginate concatenates JSON arrays/objects; normalize
  return t;
}
const out: any[] = [];
for (const e of j.sample) {
  const vs = e.versions;
  let prs: any[] | null = null;
  for (let i = 1; i < vs.length; i++) {
    const v = vs[i];
    if (!v.pulls || v.pulls.length) continue;
    if (prs === null) {
      const t = await gh(`repos/nemarDatasets/${e.dataset_id}/pulls?state=closed&per_page=100`);
      prs = JSON.parse(t.replace(/\]\s*\[/g, ",")).filter((p: any) => p.merged_at);
    }
    const prev = vs[i - 1];
    const cmp = JSON.parse(await gh(`repos/nemarDatasets/${e.dataset_id}/compare/${prev.tag}...${v.tag}`));
    const shas = new Set<string>((cmp.commits ?? []).map((c: any) => c.sha));
    const hit = prs.filter((p) => shas.has(p.merge_commit_sha)).map((p) => ({ number: p.number, author: p.user.login, title: p.title }));
    out.push({ dataset_id: e.dataset_id, version: v.version, prev: prev.version, compare_status: cmp.status, commits_in_range: cmp.total_commits, prs_in_range: hit });
  }
}
writeFileSync("q4e-range-prs.json", JSON.stringify(out, null, 2));
console.log(out.length);
