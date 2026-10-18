/**
 * Which datasets the review applies to (ADR 0107): the row-in-hand rule the ruleset tooling uses,
 * tied to the SQL rule the Worker uses, and the band of fixture ids the tooling never touches.
 *
 * The tie is the point of the first block. `isReviewableRow` and the Worker's
 * `REVIEWABLE_DATASET_PREDICATE` are two statements of one rule, and a ruleset put on a dataset
 * the Worker will not review (or left off one it will) is a required check that never comes, or a
 * review nobody requires. Both are run over the same rows, in a real SQLite database with every
 * migration applied, through `reviewableDataset`, the Worker's own function.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { reviewableDataset } from "../src/services/pr-review";
import {
  OUTSIDE_FIXTURE_BAND,
  REVIEWABLE_ROW_COLUMNS,
  type ReviewableRow,
  automaticReviewIntent,
  isAutoRequireEnabled,
  isRequirementTarget,
  isReviewEnabled,
  isReviewRulesetFixture,
  isReviewableRow,
  notReviewableReason,
  readReviewIntent,
  reviewIntentOf,
} from "../src/services/pr-review-eligibility";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1, wrapD1 } from "./helpers/d1";

const STATUSES = ["active", "archived", "deleted"] as const;
const VISIBILITIES = ["public", "private"] as const;
const ANONYMOUS = [0, 1] as const;
// A real stamp, an empty string (which SQL's IS NOT NULL calls set), and NULL.
const PUBLISHED = ["2026-01-01 00:00:00", "", null] as const;

function combinations(): ReviewableRow[] {
  const out: ReviewableRow[] = [];
  for (const status of STATUSES)
    for (const visibility of VISIBILITIES)
      for (const anonymous of ANONYMOUS)
        for (const first_published_at of PUBLISHED)
          out.push({ status, visibility, anonymous, first_published_at });
  return out;
}

function insert(db: Database, id: string, row: ReviewableRow): void {
  db.run(
    `INSERT OR IGNORE INTO users (id, username, email, password_hash, status, role, email_verified)
     VALUES (1, 'owner', 'owner@example.org', 'x', 'approved', 'member', 1)`,
  );
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, is_sandbox, github_repo,
                           status, visibility, anonymous, first_published_at)
     VALUES (?, ?, 1, 0, ?, ?, ?, ?, ?)`,
    [
      id,
      `Dataset ${id}`,
      `nemarDatasets/${id}`,
      row.status,
      row.visibility,
      row.anonymous,
      row.first_published_at,
    ],
  );
}

describe("isReviewableRow agrees with the Worker's SQL rule", () => {
  test("for every combination of status, visibility, anonymity and publication", async () => {
    const db = freshDb();
    // A published anonymous row cannot exist: these two triggers refuse it, which is the invariant
    // the rule leans on. The rule must still say no to one, so the triggers are dropped in this
    // scratch database to put the combination in front of the SQL as well.
    db.run("DROP TRIGGER datasets_anonymous_unpublished_ai");
    db.run("DROP TRIGGER datasets_anonymous_unpublished_au");

    const rows = combinations();
    const d1 = realD1(db);
    const disagreements: string[] = [];
    let reviewable = 0;
    for (const [i, row] of rows.entries()) {
      const id = `nm${String(300 + i).padStart(6, "0")}`;
      insert(db, id, row);
      const sql = (await reviewableDataset(d1, id)) === "reviewable";
      if (sql) reviewable++;
      if (sql !== isReviewableRow(row)) {
        disagreements.push(`${JSON.stringify(row)}: SQL ${sql}, row ${isReviewableRow(row)}`);
      }
    }

    expect(disagreements).toEqual([]);
    // Not vacuous: both answers occur, and exactly the rows that are active, public, named and
    // stamped (the stamp may be an empty string) are the reviewable ones.
    expect(rows.length).toBe(36);
    expect(reviewable).toBe(2);
  });

  test("a missing anonymity value is not reviewable, as SQL's anonymous = 0 is not true of NULL", () => {
    // The column is NOT NULL, so no row holds this; the function still has to say no.
    const row = {
      status: "active",
      visibility: "public",
      anonymous: null,
      first_published_at: "2026-01-01 00:00:00",
    };
    expect(isReviewableRow(row)).toBe(false);
  });
});

describe("notReviewableReason", () => {
  const reviewable: ReviewableRow = {
    status: "active",
    visibility: "public",
    anonymous: 0,
    first_published_at: "2026-01-01 00:00:00",
  };

  test("names the one condition a dataset fails", () => {
    expect(notReviewableReason(reviewable)).toBeNull();
    expect(notReviewableReason({ ...reviewable, status: "archived" })).toBe("inactive");
    expect(notReviewableReason({ ...reviewable, visibility: "private" })).toBe("private");
    expect(notReviewableReason({ ...reviewable, anonymous: 1, first_published_at: null })).toBe(
      "anonymous",
    );
    expect(notReviewableReason({ ...reviewable, first_published_at: null })).toBe("unpublished");
  });

  test("names the first one in a fixed order when a dataset fails several", () => {
    const nothing: ReviewableRow = {
      status: "deleted",
      visibility: "private",
      anonymous: 1,
      first_published_at: null,
    };
    expect(notReviewableReason(nothing)).toBe("inactive");
    expect(notReviewableReason({ ...nothing, status: "active" })).toBe("private");
    expect(notReviewableReason({ ...nothing, status: "active", visibility: "public" })).toBe(
      "anonymous",
    );
  });
});

describe("what a dataset row calls for", () => {
  const reviewable: ReviewableRow = {
    status: "active",
    visibility: "public",
    anonymous: 0,
    first_published_at: "2026-01-01 00:00:00",
  };

  test("a reviewed dataset is required while the review is on, and left alone while it is off", () => {
    expect(reviewIntentOf("nm000301", reviewable, true)).toBe("require");
    expect(reviewIntentOf("nm000301", reviewable, false)).toBeUndefined();
  });

  test("a dataset that is not reviewed has the ruleset removed, whether the review is on or off", () => {
    for (const row of [
      { ...reviewable, visibility: "private" },
      { ...reviewable, status: "archived" },
      { ...reviewable, anonymous: 1, first_published_at: null },
      { ...reviewable, first_published_at: null },
    ]) {
      expect(reviewIntentOf("nm000301", row, true)).toBe("remove");
      expect(reviewIntentOf("nm000301", row, false)).toBe("remove");
    }
  });

  test("a standing fixture calls for nothing, whatever its row says", () => {
    // A reviewed-looking row would be required, a private one removed: neither touches a fixture.
    for (const id of ["nm099999", "nm099998", "nm099900"]) {
      for (const row of [reviewable, { ...reviewable, visibility: "private" }]) {
        for (const enabled of [true, false]) {
          expect(
            reviewIntentOf(id, row, enabled),
            `${id} ${row.visibility} ${enabled}`,
          ).toBeUndefined();
        }
      }
    }
    // The staging exemplars are not fixtures to the tooling: they are where a ruleset is tried.
    expect(reviewIntentOf("xx099900", reviewable, true)).toBe("require");
  });

  test("the review is on only for exactly 1", () => {
    expect(isReviewEnabled({ PR_REVIEW_ENABLED: "1" })).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes", " 1", "01", "11"]) {
      expect(isReviewEnabled({ PR_REVIEW_ENABLED: value }), JSON.stringify(value)).toBe(false);
    }
  });

  test("is read from the catalog as it is now", async () => {
    const db = freshDb();
    insert(db, "nm000301", reviewable);
    insert(db, "nm000302", { ...reviewable, visibility: "private" });
    const env = (flag: string | undefined) =>
      ({ DB: realD1(db), PR_REVIEW_ENABLED: flag, PR_REVIEW_AUTO_REQUIRE: "1" }) as unknown as Pick<
        Bindings,
        "DB" | "PR_REVIEW_ENABLED" | "PR_REVIEW_AUTO_REQUIRE"
      >;

    expect(await readReviewIntent(env("1"), "nm000301")).toBe("require");
    expect(await readReviewIntent(env(undefined), "nm000301")).toBeUndefined();
    expect(await readReviewIntent(env("1"), "nm000302")).toBe("remove");
    // A dataset the catalog does not hold gets no answer, so nothing is touched.
    expect(await readReviewIntent(env("1"), "nm000399")).toBeUndefined();
    // Nor does a fixture, although its row is there and is reviewed.
    insert(db, "nm099950", reviewable);
    expect(await readReviewIntent(env("1"), "nm099950")).toBeUndefined();

    // And it follows the row: the same dataset, made private, no longer calls for the ruleset.
    db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000301'");
    expect(await readReviewIntent(env("1"), "nm000301")).toBe("remove");
  });

  test("a read that fails answers nothing, so the rest of the repository's work is not lost", async () => {
    const db = freshDb();
    insert(db, "nm000301", reviewable);
    const failing = wrapD1(realD1(db), (sql) => {
      if (sql.includes("FROM datasets")) throw new Error("D1 is unavailable");
    });

    // Both switches on, so that the only reason for an empty answer is the failed read.
    const intent = await readReviewIntent(
      { DB: failing, PR_REVIEW_ENABLED: "1", PR_REVIEW_AUTO_REQUIRE: "1" } as unknown as Pick<
        Bindings,
        "DB" | "PR_REVIEW_ENABLED" | "PR_REVIEW_AUTO_REQUIRE"
      >,
      "nm000301",
    );

    expect(intent).toBeUndefined();
  });

  test("the columns it selects are the ones the rule reads", () => {
    expect(
      REVIEWABLE_ROW_COLUMNS.split(",")
        .map((c) => c.trim())
        .sort(),
    ).toEqual(["anonymous", "first_published_at", "status", "visibility"]);
  });
});

describe("the automatic requirement switch (PR_REVIEW_AUTO_REQUIRE)", () => {
  const reviewable: ReviewableRow = {
    status: "active",
    visibility: "public",
    anonymous: 0,
    first_published_at: "2026-01-01 00:00:00",
  };
  type AutoEnv = Pick<Bindings, "DB" | "PR_REVIEW_ENABLED" | "PR_REVIEW_AUTO_REQUIRE">;

  test("is on only for exactly 1, and unset is off", () => {
    expect(isAutoRequireEnabled({ PR_REVIEW_AUTO_REQUIRE: "1" })).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes", " 1", "01", "11"]) {
      expect(isAutoRequireEnabled({ PR_REVIEW_AUTO_REQUIRE: value }), JSON.stringify(value)).toBe(
        false,
      );
    }
  });

  test("off, the automatic paths ask for no requirement, with the review on or off", () => {
    for (const review of ["1", undefined]) {
      const env = { PR_REVIEW_ENABLED: review, PR_REVIEW_AUTO_REQUIRE: undefined };
      expect(
        automaticReviewIntent(env, "nm000301", reviewable),
        `reviewable, review=${review}`,
      ).toBeUndefined();
    }
  });

  test("off, they still take the ruleset off a dataset that is not reviewed: the switch gates only the addition", () => {
    // A dataset made private while the switch is off must not keep a ruleset that nothing can
    // satisfy, so a row that is not reviewed is removed whatever the switch and the review say.
    const rows: ReviewableRow[] = [
      { ...reviewable, visibility: "private" },
      { ...reviewable, status: "archived" },
      { ...reviewable, first_published_at: null },
      { ...reviewable, anonymous: 1, first_published_at: null },
    ];
    for (const row of rows) {
      for (const review of ["1", undefined]) {
        for (const auto of [undefined, "0", "1"]) {
          const env = { PR_REVIEW_ENABLED: review, PR_REVIEW_AUTO_REQUIRE: auto };
          expect(
            automaticReviewIntent(env, "nm000301", row),
            `${JSON.stringify(row)} review=${review} auto=${auto}`,
          ).toBe("remove");
        }
      }
    }
  });

  test("a standing fixture is left alone with the switch off, as it is with it on", () => {
    const priv = { ...reviewable, visibility: "private" };
    for (const auto of [undefined, "1"]) {
      const env = { PR_REVIEW_ENABLED: "1", PR_REVIEW_AUTO_REQUIRE: auto };
      expect(automaticReviewIntent(env, "nm099998", priv), String(auto)).toBeUndefined();
      expect(automaticReviewIntent(env, "nm099999", reviewable), String(auto)).toBeUndefined();
    }
  });

  test("the requirement is the target only with the review on AND the switch on, each exactly 1", () => {
    expect(isRequirementTarget({ PR_REVIEW_ENABLED: "1", PR_REVIEW_AUTO_REQUIRE: "1" })).toBe(true);
    for (const [review, auto] of [
      ["1", undefined],
      [undefined, "1"],
      ["1", "0"],
      ["0", "1"],
      ["1", "true"],
      ["true", "1"],
      [undefined, undefined],
    ] as const) {
      expect(
        isRequirementTarget({ PR_REVIEW_ENABLED: review, PR_REVIEW_AUTO_REQUIRE: auto }),
        `${review}/${auto}`,
      ).toBe(false);
    }
  });

  test("on, they ask what the row calls for", () => {
    const on = { PR_REVIEW_AUTO_REQUIRE: "1" };
    expect(automaticReviewIntent({ ...on, PR_REVIEW_ENABLED: "1" }, "nm000301", reviewable)).toBe(
      "require",
    );
    // The review being off still keeps the requirement off, as it did before the switch existed.
    expect(automaticReviewIntent(on, "nm000301", reviewable)).toBeUndefined();
    const priv = { ...reviewable, visibility: "private" };
    expect(automaticReviewIntent({ ...on, PR_REVIEW_ENABLED: "1" }, "nm000301", priv)).toBe(
      "remove",
    );
    expect(automaticReviewIntent(on, "nm000301", priv)).toBe("remove");
    // And a standing fixture is still left alone.
    expect(
      automaticReviewIntent({ ...on, PR_REVIEW_ENABLED: "1" }, "nm099998", reviewable),
    ).toBeUndefined();
  });

  // The function the publication, visibility and orchestrator paths call, against a real catalog.
  describe("readReviewIntent, read from a real D1", () => {
    function seeded() {
      const db = freshDb();
      insert(db, "nm000301", reviewable);
      insert(db, "nm000302", { ...reviewable, visibility: "private" });
      const env = (review: string | undefined, auto: string | undefined) =>
        ({
          DB: realD1(db),
          PR_REVIEW_ENABLED: review,
          PR_REVIEW_AUTO_REQUIRE: auto,
        }) as unknown as AutoEnv;
      return { db, env };
    }

    test("off, a reviewable public dataset has no answer although the review is on", async () => {
      const { env } = seeded();
      expect(await readReviewIntent(env("1", undefined), "nm000301")).toBeUndefined();
    });

    test("on, a reviewable public dataset is required", async () => {
      const { env } = seeded();
      expect(await readReviewIntent(env("1", "1"), "nm000301")).toBe("require");
    });

    test("a private dataset has the requirement removed, with the switch on or off", async () => {
      const { env } = seeded();
      expect(await readReviewIntent(env("1", "1"), "nm000302")).toBe("remove");
      expect(await readReviewIntent(env("1", undefined), "nm000302")).toBe("remove");
    });

    test("anything but exactly 1 is off: no requirement, and the removal is still asked for", async () => {
      const { env } = seeded();
      for (const value of ["", "0", "true", "yes", " 1", "01", "11"]) {
        expect(
          await readReviewIntent(env("1", value), "nm000301"),
          `reviewable, ${JSON.stringify(value)}`,
        ).toBeUndefined();
        expect(
          await readReviewIntent(env("1", value), "nm000302"),
          `private, ${JSON.stringify(value)}`,
        ).toBe("remove");
      }
    });

    test("on with the review off keeps the requirement off, and still removes it", async () => {
      const { env } = seeded();
      expect(await readReviewIntent(env(undefined, "1"), "nm000301")).toBeUndefined();
      expect(await readReviewIntent(env(undefined, "1"), "nm000302")).toBe("remove");
    });

    test("it follows the row, switching the same dataset from require to remove", async () => {
      const { db, env } = seeded();
      expect(await readReviewIntent(env("1", "1"), "nm000301")).toBe("require");
      db.run("UPDATE datasets SET visibility = 'private' WHERE dataset_id = 'nm000301'");
      expect(await readReviewIntent(env("1", "1"), "nm000301")).toBe("remove");
      // Turned off again, the same row still has the ruleset taken off: the switch gates only the
      // addition.
      expect(await readReviewIntent(env("1", undefined), "nm000301")).toBe("remove");
    });
  });
});

describe("the fixture band the ruleset tooling never touches", () => {
  test("is the top 100 ids of the nm prefix, nm099900 to nm099999, named as a band", () => {
    for (let n = 99900; n <= 99999; n++) {
      expect(isReviewRulesetFixture(`nm${String(n).padStart(6, "0")}`), String(n)).toBe(true);
    }
    // The ids on either side of the band are ordinary datasets.
    expect(isReviewRulesetFixture("nm099899")).toBe(false);
    expect(isReviewRulesetFixture("nm000108")).toBe(false);
  });

  test("names the fixtures that matter, and not the five datasets the old rule protected", () => {
    expect(isReviewRulesetFixture("nm099999")).toBe(true); // the end-to-end dataset
    expect(isReviewRulesetFixture("nm099998")).toBe(true); // the standing anonymous deposit
    // More than 900 datasets are live, so no dataset is protected for being live. The five that
    // an earlier rule named are datasets like any other here.
    for (const id of ["nm000103", "nm000104", "nm000105", "nm000106", "nm000107"]) {
      expect(isReviewRulesetFixture(id), id).toBe(false);
    }
  });

  test("is the nm band only: the staging exemplars and imports are not in it", () => {
    for (const id of ["xx099900", "xx099999", "on099950", "on000001", "xx000001"]) {
      expect(isReviewRulesetFixture(id), id).toBe(false);
    }
  });

  test("is not fooled by something that is not an id", () => {
    for (const id of ["", "nm", "nm99999", "nm0999999", "NM099999", "nm099999 ", "x nm099999"]) {
      expect(isReviewRulesetFixture(id), JSON.stringify(id)).toBe(false);
    }
  });

  test("the WHERE condition and the function are one rule", () => {
    const db = freshDb();
    const ids = [
      "nm000001",
      "nm000103",
      "nm000108",
      "nm050000",
      "nm099899",
      "nm099900",
      "nm099901",
      "nm099950",
      "nm099997",
      "nm099998",
      "nm099999",
      "xx000001",
      "xx099900",
      "xx099999",
      "on000001",
      "on099950",
      "on099999",
    ];
    const outside = db.query<{ dataset_id: string }, [string, number]>(
      `SELECT dataset_id FROM (SELECT ? AS dataset_id) WHERE ${OUTSIDE_FIXTURE_BAND.sql}`,
    );
    for (const id of ids) {
      const kept = outside.all(id, OUTSIDE_FIXTURE_BAND.bind).length === 1;
      expect(kept, id).toBe(!isReviewRulesetFixture(id));
    }
    // Not vacuous: both outcomes occur.
    expect(ids.filter(isReviewRulesetFixture).length).toBeGreaterThan(0);
    expect(ids.filter((id) => !isReviewRulesetFixture(id)).length).toBeGreaterThan(0);
  });
});
