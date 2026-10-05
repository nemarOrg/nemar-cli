#!/usr/bin/env bun
/**
 * CLI over switch-lib: snapshot, switch, restore, check. Dry run unless --execute.
 *
 *   switch.ts snapshot --repo nemarDatasets/nm000348 --clone DIR --out snapshot.json
 *   switch.ts switch   --repo nemarDatasets/nm000348 --clone DIR --snapshot snapshot.json [--execute]
 *   switch.ts restore  --repo nemarDatasets/nm000348 --snapshot snapshot.json [--execute]
 *   switch.ts check    --repo nemarDatasets/nm000348 --snapshot snapshot.json
 *
 * The API token comes from GITHUB_TOKEN or `gh auth token`; GITHUB_API_BASE overrides the host.
 * Exit codes: 0 done, 1 refused or failed, 5 a ruleset could NOT be restored (act on it now).
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  type Api,
  RestoreFailed,
  type Snapshot,
  SwitchRefused,
  listRulesets,
  restoreFailedAdvice,
  restoreSnapshot,
  switchRefs,
  takeSnapshot,
} from "./switch-lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const need = (name: string): string => {
  const v = arg(name);
  if (!v) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
};

async function token(): Promise<string> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  if (!out) {
    console.error("no GitHub token: set GITHUB_TOKEN or run gh auth login");
    process.exit(2);
  }
  return out;
}

const command = process.argv[2];
const repo = need("repo");
const api: Api = {
  base: process.env.GITHUB_API_BASE ?? "https://api.github.com",
  token: await token(),
};
const execute = process.argv.includes("--execute");
const load = (): Snapshot => JSON.parse(readFileSync(need("snapshot"), "utf8")) as Snapshot;

try {
  if (command === "snapshot") {
    const snap = await takeSnapshot(api, repo, need("clone"), arg("remote") ?? "origin");
    writeFileSync(need("out"), `${JSON.stringify(snap, null, 1)}\n`);
    console.log(
      `snapshot: ${snap.rulesets.length} ruleset(s), ${Object.keys(snap.refs).length} ref(s)`,
    );
  } else if (command === "switch") {
    const report = await switchRefs({
      api,
      repo,
      cloneDir: need("clone"),
      remote: arg("remote") ?? "origin",
      snapshot: load(),
      execute,
      log: (l) => console.log(l),
    });
    console.log(
      `${report.executed ? "done" : "dry run"}: lifted=${report.lifted.length} pushed=${report.pushed.length} restored=${report.restored.length}`,
    );
  } else if (command === "restore") {
    const ids = await restoreSnapshot(api, repo, load(), execute);
    console.log(`${execute ? "restored" : "would restore"} ${ids.length} ruleset(s)`);
  } else if (command === "check") {
    const snap = load();
    const live = await listRulesets(api, repo);
    const drift = snap.rulesets.filter(
      (s) => live.find((l) => l.id === s.id)?.enforcement !== s.enforcement,
    );
    console.log(
      drift.length === 0 ? "protection matches the snapshot" : `${drift.length} ruleset(s) differ`,
    );
    process.exit(drift.length === 0 ? 0 : 1);
  } else {
    console.error("usage: switch.ts snapshot|switch|restore|check --repo owner/name ...");
    process.exit(2);
  }
} catch (error) {
  if (error instanceof RestoreFailed) {
    console.error(restoreFailedAdvice(error));
    process.exit(5);
  }
  console.error(error instanceof SwitchRefused ? error.message : "failed");
  process.exit(1);
}
