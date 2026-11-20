// V1 item 4: classify each sampled version's origin by the rules in research/rfc-mechanics.md B6.
// Inputs are saved raw reads (q4b, q4c, q4e from GitHub GET; q4c-repull, q4d, q4e-collab, q4f from D1 SELECT).
// Output: q4f-classification.json, q4f-classification.tsv, printed summary.
import { readFileSync, writeFileSync } from "node:fs";

const rd = (f: string) => readFileSync(f, "utf8");
const d1 = (f: string) => { const r = rd(f); return JSON.parse(r.slice(r.indexOf("\n[\n") + 1, r.lastIndexOf("\n]") + 2))[0].results as any[]; };

const q4b = JSON.parse(rd("q4b-sample-github-raw.json"));
const nopr = JSON.parse(rd("q4c-nopr-commits.json")) as any[];
const ranges = JSON.parse(rd("q4e-range-prs.json")) as any[];
const repulls = d1("q4c-repull-records.raw");
const owners = new Map(d1("q4d-owners.raw").map((r) => [r.dataset_id, r]));
const collabs = d1("q4e-collaborators.raw");
const roles = new Map(d1("q4f-author-roles.raw").map((r) => [r.github, r.role]));

type Cls = "source" | "nemar" | "community" | "unknown";

function byAuthor(dataset: string, login: string, literal: boolean): { cls: Cls; basis: string } {
  const lc = login.toLowerCase();
  const o = owners.get(dataset)!;
  const isMirror = dataset.startsWith("on");
  const role = roles.get(lc);
  const ownerIsAuthor = (o.owner_github ?? "").toLowerCase() === lc;
  const granted = collabs.some((c) => c.dataset_id === dataset && (c.collab_github ?? "").toLowerCase() === lc);
  // A mirror's source is upstream; its NEMAR owner is the import account, not the source (applied unless `literal`).
  if (ownerIsAuthor && (!isMirror || literal)) return { cls: "source", basis: "pr-author (dataset owner)" };
  if (granted && (!isMirror || literal)) return { cls: "source", basis: "pr-author (granted collaborator)" };
  if (role === "owner" || role === "admin") return { cls: "nemar", basis: `pr-author (NEMAR ${role})` };
  if (role) return { cls: "community", basis: "pr-author (other authenticated user)" };
  return { cls: "community", basis: "pr-author (no NEMAR account match)" };
}

const rows: any[] = [];
for (const e of q4b.sample) {
  e.versions.forEach((v: any, i: number) => {
    const row: any = { dataset_id: e.dataset_id, version: v.version, created_at: v.created_at, initial: i === 0 };
    const rec = repulls.find((r) => r.dataset_id === e.dataset_id && r.to_version === v.version);
    const prs: any[] = v.pulls ?? [];
    const np = nopr.find((n) => n.dataset_id === e.dataset_id && n.version === v.version);
    const rg = ranges.find((r) => r.dataset_id === e.dataset_id && r.version === v.version);
    row.tag_commit_prs = prs.map((p) => `#${p.number}:${p.author}`).join(",") || "none";
    if (rec && v.version.endsWith(".0.0")) {
      row.cls = "source"; row.basis = `repull-record (PR #${rec.pr_number}${v.upstream_snapshot_trailer ? ", Upstream-Snapshot trailer" : ", no trailer"})`;
      row.literal_cls = "source";
    } else if (prs.length) {
      const logins = [...new Set(prs.map((p) => p.author))];
      const rs = logins.map((l) => byAuthor(e.dataset_id, l, false));
      const lit = logins.map((l) => byAuthor(e.dataset_id, l, true));
      row.cls = new Set(rs.map((r) => r.cls)).size === 1 ? rs[0].cls : "unknown";
      row.basis = rs[0].basis; row.literal_cls = lit[0].cls;
    } else {
      row.cls = "unknown"; row.literal_cls = "unknown";
      row.basis = np ? `no PR on tag commit (${np.author_login ?? "no linked account"}; ${np.verified ? "signed" : "unsigned"}; "${np.message_first_line.slice(0, 40)}")` : "no PR on tag commit";
      if (rg) {
        const logins = [...new Set(rg.prs_in_range.map((p: any) => p.author))] as string[];
        row.range_prs = logins.length ? rg.prs_in_range.map((p: any) => `#${p.number}:${p.author}`).join(",") : "none";
        if (logins.length) {
          const rs = logins.map((l) => byAuthor(e.dataset_id, l, false).cls);
          row.range_cls = new Set(rs).size === 1 ? rs[0] : "mixed";
        } else row.range_cls = "unknown";
      }
    }
    rows.push(row);
  });
}
writeFileSync("q4f-classification.json", JSON.stringify(rows, null, 2));
const tsv = ["dataset\tversion\tinitial\tclass\tliteral_B6_class\tbasis\ttag_commit_prs\trange_prs\trange_class"].concat(
  rows.map((r) => [r.dataset_id, r.version, r.initial ? "yes" : "", r.cls, r.literal_cls, r.basis, r.tag_commit_prs, r.range_prs ?? "", r.range_cls ?? ""].join("\t")));
writeFileSync("q4f-classification.tsv", tsv.join("\n") + "\n");

const tally = (pred: (r: any) => boolean, key: (r: any) => string) => {
  const t: Record<string, number> = {};
  for (const r of rows.filter(pred)) t[key(r)] = (t[key(r)] ?? 0) + 1;
  return t;
};
const out = {
  rows: rows.length,
  initial_rows: rows.filter((r) => r.initial).length,
  later_nm: tally((r) => !r.initial && r.dataset_id.startsWith("nm"), (r) => r.cls),
  later_on: tally((r) => !r.initial && r.dataset_id.startsWith("on"), (r) => r.cls),
  later_nm_literal: tally((r) => !r.initial && r.dataset_id.startsWith("nm"), (r) => r.literal_cls),
  later_on_literal: tally((r) => !r.initial && r.dataset_id.startsWith("on"), (r) => r.literal_cls),
  later_nopr_range_nm: tally((r) => !r.initial && r.dataset_id.startsWith("nm") && r.cls === "unknown", (r) => r.range_cls ?? "n/a"),
  later_nopr_range_on: tally((r) => !r.initial && r.dataset_id.startsWith("on") && r.cls === "unknown", (r) => r.range_cls ?? "n/a"),
  initial_with_pr: rows.filter((r) => r.initial && r.tag_commit_prs !== "none").length,
};
writeFileSync("q4f-classification-summary.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
