#!/usr/bin/env bun
/**
 * The git stage of the privacy scrub, over LOCAL clones only. Nothing here contacts GitHub or
 * pushes; the operator pushes, after `verify` passes.
 *
 *   bun run scripts/scrub/git/git-scrub.ts snapshot --repo CLONE --out before.json
 *   bun run scripts/scrub/git/git-scrub.ts rewrite  --repo CLONE --keymap keymap.json \
 *        --plan git-plan.json [--expect-remote URL] [--snapshot-out before.json]
 *      (the clone's origin must be nemarDatasets/<the plan's dataset>; --expect-remote is
 *       optional, and when given must name that same repository)
 *   bun run scripts/scrub/git/git-scrub.ts verify   --repo CLONE --keymap keymap.json \
 *        --plan git-plan.json --s3-plan plan.json --before before.json [--allow-unparseable-json]
 *   bun run scripts/scrub/git/git-scrub.ts annex-registry --repo ANNEX_CLONE \
 *        --keymap keymap.json --remote-uuid UUID [--remote-uuid UUID ...] [--execute]
 *
 * Output is counts and fixed words only: a path, a key or a file name can be the identifier.
 * Exit codes: 0 done, 1 refused or failed, 2 usage.
 */

import { parseArgs } from "node:util";
import { ContractError } from "../contract";
import {
  GitScrubError,
  annexRegistry,
  readInputs,
  readKeymap,
  readS3Plan,
  readSnapshot,
  rewriteHistory,
  takeSnapshot,
  verifyRewrite,
  writeJson,
} from "./git-lib";

const USAGE = `usage: git-scrub <snapshot|rewrite|verify|annex-registry> --repo PATH [options]
  snapshot        --out FILE
  rewrite         --keymap FILE --plan FILE [--expect-remote URL (must be the plan's dataset)]
                  [--snapshot-out FILE]
                  [--refs REF...] [--report FILE]
  verify          --keymap FILE --plan FILE --s3-plan FILE --before FILE
                  [--allow-unparseable-json]
  annex-registry  --keymap FILE --remote-uuid UUID [--remote-uuid UUID ...] [--execute]`;

class UsageError extends Error {}

function need(value: string | undefined, flag: string): string {
  if (!value) throw new UsageError(`missing ${flag}`);
  return value;
}

function fmt(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      repo: { type: "string" },
      keymap: { type: "string" },
      plan: { type: "string" },
      "s3-plan": { type: "string" },
      before: { type: "string" },
      out: { type: "string" },
      "expect-remote": { type: "string" },
      "snapshot-out": { type: "string" },
      report: { type: "string" },
      refs: { type: "string", multiple: true },
      "remote-uuid": { type: "string", multiple: true },
      execute: { type: "boolean", default: false },
      "allow-unparseable-json": { type: "boolean", default: false },
    },
    // `--refs a b` lists several refs; the extras arrive as positionals.
    allowPositionals: true,
    strict: true,
  });

  try {
    const repo = need(values.repo, "--repo");
    if (positionals.length > 0 && !(command === "rewrite" && values.refs)) {
      throw new UsageError("unexpected argument");
    }
    switch (command) {
      case "snapshot": {
        const snapshot = await takeSnapshot(repo);
        writeJson(need(values.out, "--out"), snapshot);
        console.log(
          `snapshot: ok refs=${Object.keys(snapshot.refs).length} tags=${Object.keys(snapshot.tags).length}`,
        );
        return 0;
      }
      case "rewrite": {
        const keymapPath = need(values.keymap, "--keymap");
        const planPath = need(values.plan, "--plan");
        readInputs(keymapPath, planPath);
        if (values["snapshot-out"]) writeJson(values["snapshot-out"], await takeSnapshot(repo));
        const result = await rewriteHistory({
          repo,
          keymapPath,
          planPath,
          ...(values["expect-remote"] ? { expectRemote: values["expect-remote"] } : {}),
          ...(values.refs ? { refs: [...values.refs, ...positionals] } : {}),
          ...(values.report ? { reportPath: values.report } : {}),
        });
        console.log(`rewrite: ok ${fmt(result.counts)}`);
        console.log(`commit-map: ${result.commitMap}`);
        return 0;
      }
      case "verify": {
        const keymapPath = need(values.keymap, "--keymap");
        const planPath = need(values.plan, "--plan");
        const { keymap, plan } = readInputs(keymapPath, planPath);
        const result = await verifyRewrite({
          repo,
          keymap,
          plan,
          s3Plan: readS3Plan(need(values["s3-plan"], "--s3-plan")),
          before: readSnapshot(need(values.before, "--before")),
          allowUnparseableJson: values["allow-unparseable-json"] === true,
        });
        if (result.ok) {
          console.log(`verify: ok ${fmt(result.counts)}`);
          return 0;
        }
        for (const f of result.failures)
          console.log(`verify: FAIL reason=${f.reason} count=${f.count}`);
        console.log(`verify: failed ${fmt(result.counts)}`);
        return 1;
      }
      case "annex-registry": {
        const keymap = readKeymap(need(values.keymap, "--keymap"));
        const remoteUuids = values["remote-uuid"] ?? [];
        if (remoteUuids.length === 0) throw new UsageError("missing --remote-uuid");
        const result = await annexRegistry({
          repo,
          keymap,
          remoteUuids,
          execute: values.execute === true,
        });
        if (!result.executed) {
          console.log(
            `annex-registry: dry-run oldKeys=${result.oldKeys} holdersToRetract=${result.holders} newKeys=${result.newKeys} newToRegister=${result.newToRegister} (pass --execute)`,
          );
          return 0;
        }
        const good =
          result.oldStillHeld === 0 &&
          result.oldDead === result.oldKeys &&
          result.newPresent === result.newKeys &&
          result.newForeignHolders === 0 &&
          result.deadRefused === 0;
        const { holders, newToRegister, ...rest } = result;
        console.log(
          `annex-registry: ${good ? "ok" : "FAILED"} ${fmt({ ...rest, holdersRetracted: holders, newRegistered: newToRegister, executed: 1 })}`,
        );
        return good ? 0 : 1;
      }
      default:
        throw new UsageError("unknown command");
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n${USAGE}`);
      return 2;
    }
    if (e instanceof ContractError) {
      console.log(`refused: contract (${e.message})`);
      return 1;
    }
    if (e instanceof GitScrubError) {
      console.log(e.message.startsWith("refused") ? e.message : `failed: ${e.message}`);
      return 1;
    }
    console.log(`failed: ${e instanceof Error ? e.name : "unknown"}`);
    return 1;
  }
}

if (import.meta.main) {
  // Owner-only for every file this process and its children (git, git-filter-repo) create: the
  // clone and the reports hold paths that may be identifying.
  process.umask(0o077);
  process.exit(await main(process.argv.slice(2)));
}
