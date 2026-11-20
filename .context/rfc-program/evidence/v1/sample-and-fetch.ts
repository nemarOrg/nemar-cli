// V1 item 4 and item 5. Read-only: reads saved public-API pages and a saved D1 result,
// picks a seeded sample, then issues GitHub GET requests only (gh api, no -X other than GET).
// Usage: bun sample-and-fetch.ts   (run from this directory)
import { readFileSync, writeFileSync } from "node:fs";

const SEED = 20261120; // dispatch date
const PER_PREFIX = 15;

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const api: any[] = [];
for (let o = 0; o <= 900; o += 100) {
  api.push(...JSON.parse(readFileSync(`api-datasets-offset-${o}.json`, "utf8")).datasets);
}
const raw = readFileSync("q4a-multiversion-datasets.raw", "utf8");
const d1: any[] = JSON.parse(raw.slice(raw.indexOf("\n[\n") + 1, raw.lastIndexOf("\n]") + 2))[0].results;
const versions = new Map<string, any[]>();
for (const r of d1) (versions.get(r.dataset_id) ?? versions.set(r.dataset_id, []).get(r.dataset_id)!).push(r);

// Item 5: HED, re-measured from the public API.
const hed: Record<string, { total: number; hed: number }> = {};
for (const d of api) {
  const p = d.dataset_id.slice(0, 2);
  hed[p] ??= { total: 0, hed: 0 };
  hed[p].total++;
  if (d.has_hed === 1) hed[p].hed++;
}
const anonymous = api.filter((d) => d.anonymous).length;
writeFileSync("q5-hed-and-totals.json", JSON.stringify({ total: api.length, hed, anonymous }, null, 2));

// Item 4: pool = public, non-anonymous (ADR 0065), more than one version row in D1.
const pool = api
  .filter((d) => d.visibility === "public" && !d.anonymous && (versions.get(d.dataset_id)?.length ?? 0) > 1)
  .map((d) => d.dataset_id)
  .sort();
const rand = mulberry32(SEED);
function pick(prefix: string) {
  const ids = pool.filter((i) => i.startsWith(prefix));
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return { poolSize: ids.length, picked: ids.slice(0, PER_PREFIX).sort() };
}
const nm = pick("nm");
const on = pick("on");
console.log("pool", { nm: nm.poolSize, on: on.poolSize });

async function gh(path: string): Promise<{ ok: boolean; body: any }> {
  const p = Bun.spawn(["gh", "api", path], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  if (p.exitCode !== 0) return { ok: false, body: { error: err.trim().slice(0, 300) } };
  return { ok: true, body: JSON.parse(out) };
}

const result: any[] = [];
for (const id of [...nm.picked, ...on.picked]) {
  const meta = api.find((d) => d.dataset_id === id);
  const entry: any = { dataset_id: id, owner_username: meta.owner_username, versions: [] };
  const collab = await gh(`repos/nemarDatasets/${id}/collaborators?per_page=100`);
  entry.collaborators = collab.ok ? collab.body.map((c: any) => ({ login: c.login, permission: c.role_name })) : { error: collab.body };
  for (const v of versions.get(id)!) {
    const tag = `v${v.version}`;
    const c = await gh(`repos/nemarDatasets/${id}/commits/${tag}`);
    const row: any = { version: v.version, tag, created_at: v.created_at, source_version: v.source_version, source_version_basis: v.source_version_basis };
    if (!c.ok) {
      row.error = c.body.error;
    } else {
      row.sha = c.body.sha;
      row.commit_date = c.body.commit?.committer?.date;
      row.commit_message_first_line = String(c.body.commit?.message ?? "").split("\n")[0];
      row.upstream_snapshot_trailer = /^Upstream-Snapshot:/m.test(c.body.commit?.message ?? "");
      row.parents = c.body.parents?.length;
      const prs = await gh(`repos/nemarDatasets/${id}/commits/${c.body.sha}/pulls`);
      if (!prs.ok) row.pulls_error = prs.body.error;
      else
        row.pulls = prs.body.map((p: any) => ({
          number: p.number, title: p.title, author: p.user?.login, author_type: p.user?.type,
          merged_by: p.merged_by?.login ?? null, merged_at: p.merged_at, state: p.state, base: p.base?.ref,
        }));
    }
    entry.versions.push(row);
  }
  result.push(entry);
  console.error("done", id);
}
writeFileSync("q4b-sample-github-raw.json", JSON.stringify({ seed: SEED, per_prefix: PER_PREFIX, pool: { nm: nm.poolSize, on: on.poolSize }, sample: result }, null, 2));
