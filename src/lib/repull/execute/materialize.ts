/**
 * Materialize a re-pull's delta in the working clone (ADR 0111, decisions 1 and 2; epic #1046
 * phase 6): every path the plan writes or deletes is put in the index and the working tree, with
 * the plan's target and nothing else, before the scrub runs on them.
 *
 * Each target is written from where the planner says it comes from, and proved by its id:
 *  - an annex key is a symlink to that key (`git annex fromkey`), whose content is not local; the
 *    copy brings it;
 *  - a git blob is upstream's blob, read from the planner's clone of upstream (fetched by id when
 *    the clone lacks it), or the bytes the planner computed (`collect`); either way its git id must
 *    be the target's, or the path refuses (`target-mismatch`);
 *  - a git blob NEMAR's policy annexes (`annex-from-git`) is staged as git for now: the scrub reads
 *    it as a git-held file, and what the scrub does not take is annexed and uploaded after it;
 *  - root metadata upstream annexed (`unannex`) is read from upstream's pinned object at its version
 *    and must hash to the key, then is kept in git with any ADR 0085 sentences appended;
 *  - `dataset_description.json` is the plan's merged description, as the plan holds it;
 *  - `.nemar/metadata.json`'s `IsIdenticalTo` names the new snapshot (the NEMAR-owned edit).
 * The index is written with the exact ids (`update-index --index-info`), never with `git add`, so
 * no attribute, filter or line-ending rule can change what is staged. `git add -A` is never used:
 * what is staged comes only from here and from the scrub.
 *
 * A path the plan does not list keeps NEMAR's side, by the planner's rule, and is not touched.
 * Nothing here pushes, uploads or copies; messages name counts, never a path or a key.
 */

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { listAnnexedKeys } from "../../git-annex/transfer.js";
import type { UpstreamReader } from "../../import-scrub.js";
import type { PlanBody } from "../digest.js";
import { gitBlobOid, keyMatchesBytes, stripBom } from "../edits.js";
import { isNemarOwnedPath } from "../overlay.js";
import { readOnlyGit } from "../read-only.js";
import { missingBlobs } from "../sources.js";
import { type PlanPath, copyItems, nemarOwnedEdits, planFacts, planPaths } from "./body.js";
import { ExecuteRefused } from "./verify-plan.js";
import { REPULL_IDENTITY, WORK_BRANCH, git } from "./workdir.js";

export const NEMAR_METADATA_PATH = ".nemar/metadata.json";
const ZERO_OID = "0".repeat(40);

export interface MaterializeResult {
  written: number;
  deleted: number;
  /** Git blobs NEMAR's policy annexes, staged as git for the scrub; annexed and uploaded after it. */
  annexFromGit: Array<{ path: string; size: number }>;
  /**
   * Every path written or deleted, the NEMAR-owned edit included: the scrub's scope, with the
   * provenance files the caller adds.
   */
  deltaPaths: Set<string>;
  /**
   * What each written or deleted path holds before the scrub, as the planner spells an identity
   * (`A:<key>`, `G:<mode>:<oid>`, `absent`), and `L:<oid>` for a blob to be annexed from git.
   */
  expected: Map<string, string>;
  /**
   * NEMAR-owned edits applied, and those the plan listed with another status, left as they are
   * and reported by their status (`absent`, `unparseable`, `no-is-identical-to`, ...).
   */
  nemarOwned: { applied: number; left: string[] };
}

/** A path the plan may write: relative, inside the tree, not git's own, not NEMAR's. */
export function isWritablePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || /[\0\n\r]/.test(path)) return false;
  if (isNemarOwnedPath(path)) return false;
  return path
    .split("/")
    .every((seg) => seg !== "" && seg !== "." && seg !== ".." && seg.toLowerCase() !== ".git");
}

function refuse(code: string, message: string): ExecuteRefused {
  return new ExecuteRefused(code, message);
}

/** Remove what stands at `path` in the working tree: a file or a symlink, or an empty directory. */
function clearPath(work: string, path: string): void {
  const abs = join(work, path);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(abs);
  } catch {
    mkdirSync(dirname(abs), { recursive: true });
    return;
  }
  if (st.isDirectory()) {
    try {
      rmdirSync(abs);
    } catch {
      throw refuse(
        "path-conflict",
        "A path the plan writes is a directory that still holds files.",
      );
    }
  } else {
    rmSync(abs, { force: true });
  }
  mkdirSync(dirname(abs), { recursive: true });
}

/** Remove the directories a deletion left empty, up to the clone's root. */
function pruneEmptyParents(work: string, path: string): void {
  for (let dir = dirname(path); dir !== "." && dir !== ""; dir = dirname(dir)) {
    const abs = join(work, dir);
    try {
      if (readdirSync(abs).length > 0) return;
      rmdirSync(abs);
    } catch {
      return;
    }
  }
}

/** Stage exact entries: `mode oid path`, mode `0` and a zero id removing the path. */
async function indexInfo(
  work: string,
  entries: Array<{ mode: string; oid: string; path: string }>,
): Promise<void> {
  if (entries.length === 0) return;
  await git(work, ["update-index", "-z", "--index-info"], {
    stdin: entries.map((e) => `${e.mode} ${e.oid}\t${e.path}\0`).join(""),
    code: "materialize-failed",
    step: "update-index",
  });
}

/** Write each file's bytes into the clone's object store, as they are, and return their ids. */
async function hashObjects(work: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const r = await git(work, ["hash-object", "-w", "--no-filters", "--stdin-paths"], {
    stdin: `${paths.join("\n")}\n`,
    code: "materialize-failed",
    step: "hash-object",
  });
  const oids = r.stdout.split("\n").filter((l) => l !== "");
  if (oids.length !== paths.length) {
    throw refuse("materialize-failed", "git hash-object did not answer for every file.");
  }
  return oids;
}

/** One blob of the planner's upstream clone, streamed to a file. */
async function catBlob(repo: string, oid: string, dest: string): Promise<void> {
  const proc = Bun.spawn(["git", "cat-file", "blob", oid], {
    cwd: repo,
    stdout: Bun.file(dest),
    stderr: "pipe",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw refuse("blob-unavailable", "An upstream blob the plan names is not in the clone.");
  }
}

/**
 * Make sure the planner's upstream clone holds every blob in `oids`: fetch the missing ones by id
 * (the planner's own fetch, through its read-only guard), and refuse when one still is not there.
 */
async function ensureBlobs(
  repo: string,
  toCommit: string,
  oids: Set<string>,
  env: Record<string, string> | undefined,
): Promise<void> {
  if (oids.size === 0) return;
  const want = [...(await missingBlobs(repo, [toCommit]))].filter((o) => oids.has(o));
  if (want.length === 0) return;
  const fetched = await readOnlyGit(
    [
      "-c",
      "fetch.negotiationAlgorithm=noop",
      "fetch",
      "--quiet",
      "origin",
      "--no-tags",
      "--no-write-fetch-head",
      "--recurse-submodules=no",
      "--filter=blob:none",
      "--stdin",
    ],
    { cwd: repo, env, stdin: `${want.join("\n")}\n` },
  );
  if (fetched.exitCode !== 0) {
    throw refuse("blob-unavailable", `${want.length} upstream blob(s) could not be fetched.`);
  }
  const still = [...(await missingBlobs(repo, [toCommit]))].filter((o) => oids.has(o));
  if (still.length > 0) {
    throw refuse("blob-unavailable", `${still.length} upstream blob(s) were not delivered.`);
  }
}

const GIT_MODES = new Set(["100644", "100755", "120000"]);

/**
 * Materialize the plan's delta in `work` (checked out at the base). See the module comment.
 * `upstreamBare` is the planner's clone of upstream; `scratch` a private directory outside the
 * clone for downloads.
 */
export async function materializeDelta(args: {
  work: string;
  body: PlanBody;
  upstreamBare: string;
  upstreamEnv: Record<string, string> | undefined;
  computed: Map<string, Buffer>;
  reader: UpstreamReader;
  scratch: string;
}): Promise<MaterializeResult> {
  const { work, body } = args;
  const facts = planFacts(body);
  const rows = planPaths(body).filter((r) => r.delta || r.deleted);
  const unsafe = rows.filter((r) => !isWritablePath(r.path)).length;
  if (unsafe > 0) {
    throw refuse(
      "path-unsafe",
      `${unsafe} path(s) of the plan are not ones a re-pull writes (outside the tree, git's own, or NEMAR's).`,
    );
  }
  const items = new Map(copyItems(body).map((i) => [i.key, i]));
  const deltaPaths = new Set<string>();
  const expected = new Map<string, string>();

  // 1. Deletions first, so a path upstream turned from a file into a directory (or back) is free.
  const deletions = rows.filter((r) => r.deleted);
  for (const r of deletions) {
    rmSync(join(work, r.path), { force: true });
    pruneEmptyParents(work, r.path);
    deltaPaths.add(r.path);
    expected.set(r.path, "absent");
  }
  await indexInfo(
    work,
    deletions.map((r) => ({ mode: "0", oid: ZERO_OID, path: r.path })),
  );

  // 2. The upstream blobs the writes read, fetched by id when the planner's clone lacks them.
  const writes = rows.filter((r) => r.delta);
  const needed = new Set<string>();
  for (const r of writes) {
    const t = r.target;
    if (t.kind === "annex-from-git") needed.add(t.oid);
    if (t.kind === "git" && !args.computed.has(t.oid)) {
      if (t.computed !== undefined) {
        throw refuse(
          "computed-missing",
          "A target the planner computed was not handed to execution; plan again.",
        );
      }
      needed.add(t.oid);
    }
  }
  await ensureBlobs(args.upstreamBare, facts.toCommit, needed, args.upstreamEnv);

  // 3. Each write. Files are written, then hashed as they are and staged with their exact id.
  const annex: Array<{ path: string; key: string }> = [];
  const hashed: Array<{ path: string; oid: string; mode: string }> = [];
  const symlinks: Array<{ path: string; oid: string; target: Buffer }> = [];
  const annexFromGit: Array<{ path: string; size: number }> = [];
  const writeBytes = (r: PlanPath, mode: string, bytes: Buffer, oid: string) => {
    const abs = join(work, r.path);
    if (mode === "120000") {
      symlinkSync(bytes.toString("utf8"), abs);
      symlinks.push({ path: r.path, oid, target: bytes });
    } else {
      writeFileSync(abs, bytes, { mode: mode === "100755" ? 0o755 : 0o644 });
      chmodSync(abs, mode === "100755" ? 0o755 : 0o644);
      hashed.push({ path: r.path, oid, mode });
    }
    expected.set(r.path, `G:${mode}:${oid}`);
  };
  for (const r of writes) {
    const t = r.target;
    clearPath(work, r.path);
    deltaPaths.add(r.path);
    switch (t.kind) {
      case "annex":
        annex.push({ path: r.path, key: t.key });
        expected.set(r.path, `A:${t.key}`);
        break;
      case "annex-from-git": {
        const abs = join(work, r.path);
        await catBlob(args.upstreamBare, t.oid, abs);
        // Proved by its id below, with every other written file.
        hashed.push({ path: r.path, oid: t.oid, mode: "100644" });
        annexFromGit.push({ path: r.path, size: lstatSync(abs).size });
        expected.set(r.path, `L:${t.oid}`);
        break;
      }
      case "unannex": {
        const item = items.get(t.key);
        if (!item?.pin || item.purpose !== "unannex") {
          throw refuse("unpinned-key", "Root metadata to un-annex has no pinned upstream version.");
        }
        const dir = mkdtempSync(join(args.scratch, "unannex-"));
        try {
          const tmp = join(dir, "object");
          const got = await args.reader.download(
            {
              kind: "pinned",
              bucket: item.pin.bucket,
              object: item.pin.object,
              versionId: item.pin.version,
            },
            tmp,
          );
          if (!got.ok) {
            throw refuse(
              "unannex-unreadable",
              `Root metadata could not be read at its pinned version: ${got.failure}.`,
            );
          }
          const bytes = readFileSync(tmp);
          if (!keyMatchesBytes(t.key, bytes)) {
            throw refuse(
              "unannex-content-mismatch",
              "Root metadata read at its pinned version does not hash to its key.",
            );
          }
          const full = Buffer.concat([bytes, Buffer.from((t.append ?? []).join(""))]);
          writeBytes(r, "100644", full, gitBlobOid(full));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
        break;
      }
      case "git": {
        if (!GIT_MODES.has(t.mode)) {
          throw refuse("target-mismatch", "A git target has a mode a re-pull does not write.");
        }
        const bytes = args.computed.get(t.oid);
        if (bytes) {
          // Proved by its id below, as git computes it, with every other written file.
          writeBytes(r, t.mode, bytes, t.oid);
        } else if (t.mode === "120000") {
          const dir = mkdtempSync(join(args.scratch, "link-"));
          try {
            await catBlob(args.upstreamBare, t.oid, join(dir, "target"));
            const target = readFileSync(join(dir, "target"));
            if (gitBlobOid(target) !== t.oid) {
              throw refuse(
                "target-mismatch",
                "An upstream blob does not have the id the plan names.",
              );
            }
            writeBytes(r, t.mode, target, t.oid);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        } else {
          const abs = join(work, r.path);
          await catBlob(args.upstreamBare, t.oid, abs);
          chmodSync(abs, t.mode === "100755" ? 0o755 : 0o644);
          hashed.push({ path: r.path, oid: t.oid, mode: t.mode });
          expected.set(r.path, `G:${t.mode}:${t.oid}`);
        }
        break;
      }
      case "description": {
        if (facts.mergedDescription === null) {
          throw refuse("target-unknown", "The plan holds no merged dataset_description.json.");
        }
        const bytes = Buffer.from(facts.mergedDescription);
        writeBytes(r, "100644", bytes, gitBlobOid(bytes));
        break;
      }
      default:
        // `unknown` (a plan that could not compute it is never executable) and anything else.
        throw refuse(
          "target-unknown",
          "A delta path's N.0.0 content was not computed by the plan.",
        );
    }
  }

  // Every file is hashed as it is on disk, with no filter, and must be the id the plan names.
  const oids = await hashObjects(
    work,
    hashed.map((h) => h.path),
  );
  const mismatched = hashed.filter((h, i) => oids[i] !== h.oid).length;
  if (mismatched > 0) {
    throw refuse(
      "target-mismatch",
      `${mismatched} written file(s) do not have the id the plan names.`,
    );
  }
  for (const s of symlinks) {
    const r = await git(work, ["hash-object", "-w", "--no-filters", "--stdin"], {
      stdin: s.target.toString("utf8"),
      code: "materialize-failed",
      step: "hash-object",
    });
    if (r.stdout.trim() !== s.oid) {
      throw refuse("target-mismatch", "A symlink target does not have the id the plan names.");
    }
  }
  await indexInfo(work, [
    ...hashed.map((h) => ({ mode: h.mode, oid: h.oid, path: h.path })),
    ...symlinks.map((s) => ({ mode: "120000", oid: s.oid, path: s.path })),
  ]);

  // Annex symlinks, staged by git-annex itself; their content is not local, and the copy brings it.
  if (annex.length > 0) {
    await git(work, ["annex", "fromkey", "--force", "--batch"], {
      stdin: annex.map((a) => `${a.key} ${a.path}\n`).join(""),
      code: "materialize-failed",
      step: "annex fromkey",
    });
    const named = await listAnnexedKeys(work);
    const wrong = annex.filter((a) => named.get(a.path) !== a.key).length;
    if (wrong > 0) {
      throw refuse(
        "target-mismatch",
        `${wrong} annexed path(s) do not name the key the plan names.`,
      );
    }
  }

  // 4. The NEMAR-owned edit: `.nemar/metadata.json`'s IsIdenticalTo names the new snapshot.
  const nemarOwned: MaterializeResult["nemarOwned"] = { applied: 0, left: [] };
  for (const edit of nemarOwnedEdits(body)) {
    if (
      edit.path !== NEMAR_METADATA_PATH ||
      edit.edit !== "is-identical-to" ||
      edit.status !== "ok"
    ) {
      nemarOwned.left.push(edit.status === "ok" ? "unknown-edit" : edit.status);
      continue;
    }
    const abs = join(work, NEMAR_METADATA_PATH);
    let meta: { related_identifiers?: Array<{ relation_type?: string; identifier?: unknown }> };
    // A byte-order mark is read as the planner reads it (stripped), and kept where it was.
    const raw = readFileSync(abs, "utf8");
    const bom = raw.charCodeAt(0) === 0xfeff ? String.fromCharCode(0xfeff) : "";
    try {
      meta = JSON.parse(stripBom(raw));
    } catch {
      throw refuse("nemar-owned-moved", "NEMAR's .nemar/metadata.json no longer parses.");
    }
    const hit = Array.isArray(meta.related_identifiers)
      ? meta.related_identifiers.find((r) => r?.relation_type === "IsIdenticalTo")
      : undefined;
    if (!hit || hit.identifier !== edit.from) {
      throw refuse(
        "nemar-owned-moved",
        "NEMAR's .nemar/metadata.json no longer names what the plan read; plan again.",
      );
    }
    hit.identifier = edit.to;
    const bytes = Buffer.from(`${bom}${JSON.stringify(meta, null, 2)}\n`);
    writeFileSync(abs, bytes);
    const [oid] = await hashObjects(work, [NEMAR_METADATA_PATH]);
    if (oid !== gitBlobOid(bytes)) {
      throw refuse("materialize-failed", "The NEMAR-owned edit was not hashed as written.");
    }
    await indexInfo(work, [{ mode: "100644", oid, path: NEMAR_METADATA_PATH }]);
    deltaPaths.add(NEMAR_METADATA_PATH);
    expected.set(NEMAR_METADATA_PATH, `G:100644:${oid}`);
    nemarOwned.applied++;
  }

  return {
    written: writes.length,
    deleted: deletions.length,
    annexFromGit,
    deltaPaths,
    expected,
    nemarOwned,
  };
}

/**
 * Commit the materialized index on the work branch, locally, so the scrub works on it as the
 * importer's scrub works on a clone: on committed paths. That commit is never pushed and is never
 * an ancestor of the synthesized commit, whose only parent is the base (the synthesis shows the
 * originals it held are unreachable). Before it, every path that differs from the base, in the
 * index or as an untracked file, must be in `scope`, or the scrub would never read it
 * (`scope-incomplete`): the check the scrub makes of its own scope, made here because once the
 * index is committed the scrub sees no change to check.
 */
export async function commitMaterialized(
  work: string,
  baseSha: string,
  scope: ReadonlySet<string>,
  when: Date,
): Promise<string> {
  const listed = [
    await git(work, ["diff", "--cached", "--name-only", "-z", "--no-renames", baseSha, "--"], {
      code: "materialize-failed",
      step: "diff",
    }),
    await git(work, ["diff", "--name-only", "-z", "--no-renames", "--"], {
      code: "materialize-failed",
      step: "diff",
    }),
    await git(work, ["ls-files", "--others", "--exclude-standard", "-z"], {
      code: "materialize-failed",
      step: "ls-files",
    }),
  ];
  const outside = new Set(
    listed.flatMap((r) => r.stdout.split("\0")).filter((p) => p !== "" && !scope.has(p)),
  ).size;
  if (outside > 0) {
    throw refuse(
      "scope-incomplete",
      `${outside} path(s) differ from the base outside the delta the scrub reads.`,
    );
  }
  const tree = (
    await git(work, ["write-tree"], { code: "materialize-failed", step: "write-tree" })
  ).stdout.trim();
  const at = `${Math.floor(when.getTime() / 1000)} +0000`;
  const commit = (
    await git(work, ["commit-tree", "--no-gpg-sign", tree, "-p", baseSha, "-F", "-"], {
      stdin: "Re-pull delta, before the scrub (local, never pushed)\n",
      code: "materialize-failed",
      step: "commit-tree",
      env: {
        GIT_AUTHOR_NAME: REPULL_IDENTITY.name,
        GIT_AUTHOR_EMAIL: REPULL_IDENTITY.email,
        GIT_AUTHOR_DATE: at,
        GIT_COMMITTER_NAME: REPULL_IDENTITY.name,
        GIT_COMMITTER_EMAIL: REPULL_IDENTITY.email,
        GIT_COMMITTER_DATE: at,
      },
    })
  ).stdout.trim();
  await git(work, ["update-ref", `refs/heads/${WORK_BRANCH}`, commit], {
    code: "materialize-failed",
    step: "update-ref",
  });
  return commit;
}
