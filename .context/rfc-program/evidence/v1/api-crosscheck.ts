// V1 cross-check: latest_version from the saved public-API pages, by prefix, against the D1 counts.
import { readFileSync } from "node:fs";
const api: any[] = [];
for (let o = 0; o <= 900; o += 100) api.push(...JSON.parse(readFileSync(`api-datasets-offset-${o}.json`, "utf8")).datasets);
const t: Record<string, number> = {};
for (const d of api) {
  const k = `${d.dataset_id.slice(0, 2)} latest=${d.latest_version === "v1.0.0" ? "1.0.0" : d.latest_version == null ? "null" : "above 1.0.0"}`;
  t[k] = (t[k] ?? 0) + 1;
}
const nm2 = api.filter((d) => d.dataset_id.startsWith("nm") && d.latest_version?.startsWith("v2.")).map((d) => d.dataset_id);
const on2 = api.filter((d) => d.dataset_id.startsWith("on") && d.latest_version?.startsWith("v2.")).map((d) => d.dataset_id);
console.log(JSON.stringify({ total: api.length, public: api.filter((d) => d.visibility === "public").length, with_doi: api.filter((d) => d.doi).length, t, nm2, on2 }, null, 1));
