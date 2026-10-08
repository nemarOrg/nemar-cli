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
 *        [--proof-out git-verified.json]
 *   bun run scripts/scrub/git/git-scrub.ts verify --fresh-clone --repo FRESH_CLONE \
 *        --keymap keymap.json --plan git-plan.json --s3-plan plan.json [--proof-out F]
 *        [--allow-tag vX.Y.Z ...]
 *   bun run scripts/scrub/git/git-scrub.ts annex-registry --repo ANNEX_CLONE \
 *        --keymap keymap.json [--remote-uuid UUID ...] [--execute]
 *
 * `verify` removes the proof file (default: `git-verified.json` beside the keymap) when it starts
 * and writes it again only when every check passed; `drop-archives` and `delete-old` require one
 * made by `--fresh-clone`. `annex-registry` with no `--remote-uuid` uses this clone's `nemar-s3` remote.
 * `--allow-tag` (fresh-clone only) names a version tag the repository has and the S3 plan does not,
 * because it was never a published version; it is recorded in the proof and covers the name only.
 *
 * Output is counts and fixed words only: a path, a key or a file name can be the identifier. A
 * failure names the command that failed from a closed list (`failed: <word> (git rev-list)`).
 * Exit codes: 0 done; 1 failed (a command or the tool broke); 2 usage; 3 refused (an input or
 * the repository is not one this may act on; nothing was changed by the tool); 4 checked and not
 * clean (verify found failures, or annex-registry's read-back disagrees after --execute).
 */

import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { ContractError, type GitVerifiedFile } from "../contract";
import { VERSION_TAG } from "../ledger";
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

export const EXIT = { failed: 1, usage: 2, refused: 3, notClean: 4 } as const;

const USAGE = `usage: git-scrub <snapshot|rewrite|verify|annex-registry> --repo PATH [options]
  snapshot        --out FILE
  rewrite         --keymap FILE --plan FILE [--expect-remote URL (must be the plan's dataset)]
                  [--snapshot-out FILE]
                  [--refs REF...] [--report FILE]
  verify          --keymap FILE --plan FILE --s3-plan FILE --before FILE
                  [--allow-unparseable-json] [--proof-out FILE]
  verify          --fresh-clone --keymap FILE --plan FILE --s3-plan FILE
                  [--allow-unparseable-json] [--proof-out FILE] [--allow-tag vX.Y.Z ...]
  annex-registry  --keymap FILE [--remote-uuid UUID ...] [--execute]
exit: 0 done, 1 failed, 2 usage, 3 refused, 4 checked and not clean`;

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

const fileSha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** Write the proof atomically, owner-only: a reader sees the old file or the whole new one. */
function writeProof(path: string, proof: GitVerifiedFile): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeJson(tmp, proof);
  renameSync(tmp, path);
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command ? 0 : EXIT.usage;
  }
  try {
    let parsed: ReturnType<typeof parse>;
    try {
      parsed = parse(rest);
    } catch {
      throw new UsageError("bad arguments");
    }
    const { values, positionals } = parsed;
    const repo = need(values.repo, "--repo");
    if (positionals.length > 0 && !(command === "rewrite" && values.refs)) {
      throw new UsageError("unexpected argument");
    }
    switch (command) {
      case "snapshot": {
        const snapshot = await takeSnapshot(repo);
        writeJson(need(values.out, "--out"), snapshot);
        console.log(
          `snapshot: ok refs=${Object.keys(snapshot.refs).length} tags=${Object.keys(snapshot.tags).length} originTips=${Object.keys(snapshot.originTips).length}`,
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
        const s3PlanPath = need(values["s3-plan"], "--s3-plan");
        const fresh = values["fresh-clone"] === true;
        const proofPath = values["proof-out"] ?? join(dirname(keymapPath), "git-verified.json");
        // A proof from an earlier run must not outlive a run that does not pass, a usage error
        // raised below included: nothing below may leave one behind. A bad or missing flag above
        // is raised before the proof's path is known, so it leaves an earlier proof in place; run
        // verify again until it passes, and read the proof's `mode` before using it.
        rmSync(proofPath, { force: true });
        if (fresh && values.before) throw new UsageError("--fresh-clone takes no --before");
        // The names are never echoed: a tag name is part of what the output keeps to counts.
        const allowTags = [...new Set(values["allow-tag"] ?? [])].sort();
        if (allowTags.length > 0 && !fresh) {
          throw new UsageError("--allow-tag is for --fresh-clone only");
        }
        if (allowTags.some((t) => !VERSION_TAG.test(t))) {
          throw new UsageError("--allow-tag takes a version tag, vX.Y.Z or vX.Y.Z-pre");
        }
        const { keymap, plan } = readInputs(keymapPath, planPath);
        const s3Plan = readS3Plan(s3PlanPath);
        const result = await verifyRewrite({
          repo,
          keymap,
          plan,
          s3Plan,
          mode: fresh ? "fresh-clone" : "local",
          ...(fresh ? {} : { before: readSnapshot(need(values.before, "--before")) }),
          allowUnparseableJson: values["allow-unparseable-json"] === true,
          allowTags,
        });
        const mode = fresh ? "fresh-clone" : "local";
        // Printed only when there is one, so the line keeps its form for every other run.
        const shown =
          allowTags.length > 0
            ? { ...result.counts, allowedTags: allowTags.length }
            : result.counts;
        if (result.ok) {
          writeProof(proofPath, {
            version: 1,
            dataset: plan.dataset,
            mode,
            verifiedAt: new Date().toISOString(),
            keymapSha256: fileSha256(keymapPath),
            gitPlanSha256: fileSha256(planPath),
            s3PlanSha256: fileSha256(s3PlanPath),
            counts: result.counts,
            ...(allowTags.length > 0 ? { allowedTags: allowTags } : {}),
          });
          console.log(`verify: ok mode=${mode} ${fmt(shown)}`);
          return 0;
        }
        for (const f of result.failures)
          console.log(`verify: FAIL reason=${f.reason} count=${f.count}`);
        console.log(`verify: failed mode=${mode} ${fmt(shown)}`);
        return EXIT.notClean;
      }
      case "annex-registry": {
        const keymap = readKeymap(need(values.keymap, "--keymap"));
        const result = await annexRegistry({
          repo,
          keymap,
          remoteUuids: values["remote-uuid"] ?? [],
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
        const { holders, newToRegister, ...others } = result;
        console.log(
          `annex-registry: ${good ? "ok" : "FAILED"} ${fmt({ ...others, holdersRetracted: holders, newRegistered: newToRegister, executed: 1 })}`,
        );
        return good ? 0 : EXIT.notClean;
      }
      default:
        throw new UsageError("unknown command");
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (e instanceof ContractError) {
      console.log(`refused: contract (${e.message})`);
      return EXIT.refused;
    }
    if (e instanceof GitScrubError) {
      // The message is a fixed word ("refused: <word>", "bad-input: <word>", "failed: <word>",
      // or a bare word); the detail is the failed command, from a closed list.
      const detail = e.detail ? ` (${e.detail})` : "";
      if (e.message.startsWith("refused") || e.message.startsWith("bad-input")) {
        console.log(`${e.message}${detail}`);
        return EXIT.refused;
      }
      const word = e.message.startsWith("failed") ? e.message : `failed: ${e.message}`;
      console.log(`${word}${detail}`);
      return EXIT.failed;
    }
    console.log(`failed: ${e instanceof Error ? e.name : "unknown"}`);
    return EXIT.failed;
  }
}

function parse(args: string[]) {
  return parseArgs({
    args,
    options: {
      repo: { type: "string" },
      keymap: { type: "string" },
      plan: { type: "string" },
      "s3-plan": { type: "string" },
      before: { type: "string" },
      out: { type: "string" },
      "expect-remote": { type: "string" },
      "snapshot-out": { type: "string" },
      "proof-out": { type: "string" },
      report: { type: "string" },
      refs: { type: "string", multiple: true },
      "remote-uuid": { type: "string", multiple: true },
      execute: { type: "boolean", default: false },
      "fresh-clone": { type: "boolean", default: false },
      "allow-unparseable-json": { type: "boolean", default: false },
      "allow-tag": { type: "string", multiple: true },
    },
    // `--refs a b` lists several refs; the extras arrive as positionals.
    allowPositionals: true,
    strict: true,
  });
}

if (import.meta.main) {
  // Owner-only for every file this process and its children (git, git-filter-repo) create: the
  // clone and the reports hold paths that may be identifying.
  process.umask(0o077);
  process.exit(await main(process.argv.slice(2)));
}
