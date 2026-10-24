/**
 * Which upstream tag a re-pull starts from (ADR 0111, decisions 4 and 10): the Phase 2 seam.
 *
 * `from_tag` is the `source_version` of the dataset's highest version row (`mirroredTagOf`). When
 * that row was never examined (the backfill has not reached it) or the rows cannot be read at all
 * (a dev worker's 404, or an older backend without the field), the planner reads the same file the
 * backfill would, `v<version>/dataset_description.json` from NEMAR's clone, with the same parser
 * (`sourceSnapshotOf`), so there is still one parser and one answer.
 *
 * Unknown is never guessed: a row recorded `unknown`, or a tagged description that names no single
 * tag, refuses. `--from-tag` on such a mirror gives a dry run only (`from-tag-not-recorded`): the
 * plan is made and shown, is never executable, and its lineage is never recordable (ADR 0111's
 * Phase 5 amendment). `--from-tag` that disagrees with a recorded tag refuses, and one that is not
 * an upstream tag at all refuses as `from-tag-malformed`.
 */

import {
  type SourceVersionRow,
  compareSourceTags,
  mirroredTagOf,
  sourceSnapshotOf,
} from "../../../shared/source-snapshot.js";
import type { Check } from "./preflight.js";

export type FromTagSource = "version-row" | "tagged-description" | "flag";

export interface FromTagResolution {
  /** The tag to plan from, or null when no plan can be made. */
  tag: string | null;
  source: FromTagSource | null;
  check: Check;
}

/** A version as the API spells it (`v1.0.0`) or as the column stores it (`1.0.0`), bare. */
export function bareVersion(v: string): string {
  return v.replace(/^v/, "");
}

/**
 * Resolve `from_tag`. `rows` is null when the version rows could not be read. `highestTag` is the
 * highest `v*` tag on NEMAR's repository, which names the tagged description when no row does.
 * `readTagged(version)` returns the tagged description's parsed JSON, or undefined when the file
 * is absent at that tag.
 */
export async function resolveFromTag(args: {
  rows: SourceVersionRow[] | null;
  highestTag: string | null;
  flag: string | undefined;
  ds: string;
  readTagged: (version: string) => Promise<unknown | undefined>;
}): Promise<FromTagResolution> {
  const flag = args.flag?.trim() || undefined;
  if (flag !== undefined && compareSourceTags(flag, flag) === null) {
    return {
      tag: null,
      source: null,
      check: {
        name: "from-tag",
        status: "refused",
        code: "from-tag-malformed",
        detail: `${flag} is not an upstream tag (digits and dots, like 1.0.0)`,
      },
    };
  }
  let recorded: { tag: string; source: FromTagSource } | null = null;
  let unknownWhy: string | null = null;

  const rows = args.rows?.map((r) => ({ ...r, version: bareVersion(r.version) })) ?? null;
  const mirrored = rows ? mirroredTagOf(rows) : null;
  let taggedVersion: string | null = null;
  if (mirrored?.state === "known") {
    recorded = { tag: mirrored.tag, source: "version-row" };
  } else if (mirrored?.state === "unknown") {
    unknownWhy = `the version row ${mirrored.version} is recorded unknown`;
  } else if (mirrored?.state === "unexamined") {
    taggedVersion = mirrored.version;
  } else if (mirrored?.state === "none") {
    return {
      tag: null,
      source: null,
      check: {
        name: "from-tag",
        status: "refused",
        code: "never-released",
        detail: "no version row",
      },
    };
  } else {
    taggedVersion = args.highestTag ? bareVersion(args.highestTag) : null;
    if (taggedVersion === null) {
      return {
        tag: null,
        source: null,
        check: {
          name: "from-tag",
          status: "refused",
          code: "never-released",
          detail: "no version rows could be read and the repository has no v* tag",
        },
      };
    }
  }

  if (taggedVersion !== null) {
    const desc = await args.readTagged(taggedVersion);
    const snap = desc === undefined ? null : sourceSnapshotOf(desc, args.ds);
    if (snap?.source_version_basis === "doi") {
      recorded = { tag: snap.source_version, source: "tagged-description" };
    } else {
      unknownWhy =
        desc === undefined
          ? `v${taggedVersion} has no dataset_description.json`
          : `v${taggedVersion}'s dataset_description.json names no single upstream tag`;
    }
  }

  if (recorded) {
    if (flag !== undefined && flag !== recorded.tag) {
      return {
        tag: null,
        source: null,
        check: {
          name: "from-tag",
          status: "refused",
          code: "from-tag-disagrees",
          detail: `--from-tag ${flag} but the mirror records ${recorded.tag}`,
        },
      };
    }
    return {
      tag: recorded.tag,
      source: recorded.source,
      check: { name: "from-tag", status: "ok", detail: `${recorded.tag} (${recorded.source})` },
    };
  }
  if (flag !== undefined) {
    return {
      tag: flag,
      source: "flag",
      check: {
        name: "from-tag",
        status: "refused",
        code: "from-tag-not-recorded",
        detail: `${unknownWhy}; --from-tag ${flag} gives a dry run only`,
      },
    };
  }
  return {
    tag: null,
    source: null,
    check: {
      name: "from-tag",
      status: "refused",
      code: "from-tag-unknown",
      detail: `${unknownWhy}; a mirror whose tag is unknown is never re-pulled`,
    },
  };
}
