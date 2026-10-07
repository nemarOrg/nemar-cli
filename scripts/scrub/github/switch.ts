#!/usr/bin/env bun
/**
 * CLI over switch-lib: snapshot, switch, restore, check. Dry run unless --execute.
 *
 *   switch.ts snapshot --repo nemarDatasets/nm000348 --clone DIR --before before.json \
 *                      --out snapshot.json [--accept-disabled]
 *   switch.ts switch   --repo nemarDatasets/nm000348 --clone DIR --snapshot snapshot.json [--execute]
 *   switch.ts restore  --repo nemarDatasets/nm000348 --snapshot snapshot.json [--execute]
 *   switch.ts check    --repo nemarDatasets/nm000348 --snapshot snapshot.json
 *
 * `--before` is `git-scrub snapshot`'s before.json, taken in the clone BEFORE the rewrite: its
 * `originTips` are what the clone knew of the remote, and the snapshot refuses unless the remote
 * still holds exactly those (`remote-moved-since-clone`) and uses them as the push leases. The
 * snapshot is never written over an existing file (`snapshot-exists`), and a baseline in which a
 * ruleset that blocks the push is already off is refused (`ruleset-already-lifted`) unless
 * `--accept-disabled`.
 *
 * The API token comes from GITHUB_TOKEN or `gh auth token`; GITHUB_API_BASE overrides the host.
 * Exit codes: 0 done; 1 failed (a push failed part way: what was and was not pushed is printed);
 * 2 usage; 3 refused (nothing was changed); 5 a ruleset could NOT be restored (act on it now);
 * 129, 130, 143 ended by SIGHUP, SIGINT, SIGTERM after restoring.
 */

import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { ContractError } from "../contract";
import { readSnapshot as readGitSnapshot } from "../git/git-lib";
import {
  type Api,
  PushFailed,
  RestoreFailed,
  type Snapshot,
  SwitchRefused,
  adviseRestore,
  listRulesets,
  restoreSnapshot,
  switchRefs,
  takeSnapshot,
} from "./switch-lib";

// Owner-only for every file this process and its children (git) create.
process.umask(0o077);

const EXIT = { failed: 1, usage: 2, refused: 3, restoreFailed: 5 } as const;

function usage(message: string): never {
  console.error(`${message}\nusage: switch.ts snapshot|switch|restore|check --repo owner/name ...`);
  process.exit(EXIT.usage);
}

let parsed: ReturnType<typeof parse>;
function parse() {
  return parseArgs({
    args: process.argv.slice(2),
    options: {
      repo: { type: "string" },
      clone: { type: "string" },
      before: { type: "string" },
      out: { type: "string" },
      snapshot: { type: "string" },
      remote: { type: "string" },
      execute: { type: "boolean" },
      "accept-disabled": { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
}
try {
  parsed = parse();
} catch {
  usage("bad arguments");
}
const v = parsed.values;
const [command] = parsed.positionals;
const need = (name: keyof typeof v): string => {
  const value = v[name];
  if (typeof value !== "string" || value === "") usage(`missing --${name}`);
  return value;
};

async function token(): Promise<string> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  if (!out) usage("no GitHub token: set GITHUB_TOKEN or run gh auth login");
  return out;
}

/** A switch snapshot, refused unless it carries the origin tips the leases come from. */
function load(): Snapshot {
  const snap = JSON.parse(readFileSync(need("snapshot"), "utf8")) as Snapshot;
  if (
    snap.version !== 1 ||
    typeof snap.originTips !== "object" ||
    snap.originTips === null ||
    Array.isArray(snap.originTips)
  ) {
    throw new SwitchRefused("snapshot-invalid");
  }
  return snap;
}

const repo = need("repo");
/** The admin token goes to this base: GitHub's, or this machine (what the tests serve). */
function apiBase(): string {
  const raw = process.env.GITHUB_API_BASE ?? "https://api.github.com";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return usage("GITHUB_API_BASE is not a URL");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (raw !== "https://api.github.com" && !(url.protocol === "http:" && loopback)) {
    return usage("GITHUB_API_BASE must be https://api.github.com or a loopback http URL");
  }
  return raw;
}
const api: Api = { base: apiBase(), token: await token() };
const execute = v.execute === true;
const remote = v.remote ?? "origin";

try {
  if (command === "snapshot") {
    const out = need("out");
    // Every flag is resolved BEFORE the file is created: a usage error exits the process, and a
    // snapshot file created first would be left empty and refuse the corrected run.
    const beforePath = need("before");
    const cloneDir = need("clone");
    // Never over an existing file: it may be the only record of what a restore must put back.
    // Created exclusively FIRST, so nothing is read from GitHub for a snapshot that cannot be kept.
    let fd: number;
    try {
      fd = openSync(out, "wx", 0o600);
    } catch {
      throw new SwitchRefused("snapshot-exists");
    }
    try {
      const before = readGitSnapshot(beforePath);
      const snap = await takeSnapshot(api, repo, cloneDir, remote, before.originTips, {
        acceptDisabled: v["accept-disabled"] === true,
      });
      writeSync(fd, `${JSON.stringify(snap, null, 1)}\n`);
      closeSync(fd);
      console.log(
        `snapshot: ${snap.rulesets.length} ruleset(s), ${Object.keys(snap.refs).length} ref(s)`,
      );
    } catch (error) {
      // A refused or failed snapshot leaves no file behind, not an empty one.
      closeSync(fd);
      rmSync(out, { force: true });
      throw error;
    }
  } else if (command === "switch") {
    const report = await switchRefs({
      api,
      repo,
      cloneDir: need("clone"),
      remote,
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
    process.exit(drift.length === 0 ? 0 : EXIT.failed);
  } else {
    usage("unknown command");
  }
} catch (error) {
  if (error instanceof RestoreFailed) {
    adviseRestore(error.message);
    process.exit(EXIT.restoreFailed);
  }
  if (error instanceof PushFailed) {
    // Branch names are not participant data; tags are counted, not named.
    const branches = (refs: string[]) => refs.filter((r) => r.startsWith("refs/heads/"));
    const tags = (refs: string[]) => refs.filter((r) => r.startsWith("refs/tags/")).length;
    console.error(`switch: ${error.message}`);
    console.error(
      `switch: pushed branches=[${branches(error.pushed).join(",")}] tags=${tags(error.pushed)}`,
    );
    console.error(
      `switch: NOT pushed branches=[${branches(error.notPushed).join(",")}] tags=${tags(error.notPushed)}`,
    );
    console.error(
      "switch: the rulesets were restored; the remote may be half rewritten. Run `switch.ts check`, compare `git ls-remote` with before.json's originTips, fix the cause and re-run (the leases refuse to overwrite anything else).",
    );
    process.exit(EXIT.failed);
  }
  if (error instanceof SwitchRefused) {
    console.error(error.message);
    process.exit(EXIT.refused);
  }
  if (error instanceof ContractError) {
    console.error("switch refused: before-invalid");
    process.exit(EXIT.refused);
  }
  console.error("failed");
  process.exit(EXIT.failed);
}
