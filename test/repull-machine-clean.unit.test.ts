/**
 * The machine-clean rule of the automatic re-pull, as a pure function (`shared/repull-machine-clean.ts`;
 * epic #1046 phase 7, #1913; ADR 0111, decision 7).
 *
 * A SUPPLEMENT. The rule's entry point is the fact gathering it runs on
 * (`backend/test/upstream-repull-facts.test.ts` drives that against a GitHub stand-in and the real
 * database, one fact flipped at a time). This file pins what only a table can: every hold word the
 * rule can answer is reached by flipping one fact of a clean set, the order is the one the rule
 * states (of any two failures the earlier word wins), and no value that means "not read" or "not
 * there" is ever clean.
 *
 * CI TIER: unit-pure. No server, no database.
 */

import { describe, expect, test } from "bun:test";
import {
  NEMAR_APP_BOT_LOGIN,
  NEMAR_APP_BOT_TYPE,
  NEMAR_APP_BOT_USER_ID,
} from "../shared/nemar-app";
import {
  type CheckFact,
  MACHINE_CLEAN_HOLDS,
  type MachineCleanFacts,
  type ReviewFact,
  type ScreenFact,
  machineClean,
} from "../shared/repull-machine-clean";
import { REPULL_HOLD_REASONS } from "../shared/repull-state";

const HEAD = "1".repeat(40);
const BASE = "2".repeat(40);
const OTHER = "3".repeat(40);
const DS = "on004362";

const success: CheckFact = { status: "completed", conclusion: "success" };

/** A fact set that is machine clean at the gates. */
function clean(): MachineCleanFacts {
  return {
    stage: "gates",
    switches: { production: true, enabled: true, merge: true },
    dataset: { anonymous: 0, withdrawn: false, importInFlight: false, mirror: true },
    row: {
      origin: "automatic",
      dataset_id: DS,
      branch: "release/v2.0.0",
      pr_number: 4,
      head_sha: HEAD,
      gates_sha: HEAD,
      base_sha: BASE,
      patch_version: null,
      counts: { unexplained: 0, conflicts: 0, corrections: 0, copy_bytes: 10 },
    },
    pr: {
      state: "open",
      merged: false,
      draft: false,
      number: 4,
      authorLogin: NEMAR_APP_BOT_LOGIN,
      authorId: NEMAR_APP_BOT_USER_ID,
      authorType: NEMAR_APP_BOT_TYPE,
      headRef: "release/v2.0.0",
      headSha: HEAD,
      headRepo: `nemarDatasets/${DS}`,
      baseRepo: `nemarDatasets/${DS}`,
      baseRef: "main",
      mergeableState: "clean",
    },
    mainSha: BASE,
    checks: { bids: { ...success }, versionCheck: { ...success } },
    screen: "clear",
    review: "pass",
  };
}

/** The pull request of a fact set that has one (every flip below keeps or replaces it whole). */
function pr(f: MachineCleanFacts) {
  if (f.pr === "unreadable") throw new Error("this flip needs a readable pull request");
  return f.pr;
}

/**
 * One flip per word: the smallest change to a clean set that makes that rule fail. Applied in the
 * order "later rule first", every pair below also tests the order.
 */
const FLIPS: Record<(typeof MACHINE_CLEAN_HOLDS)[number], (f: MachineCleanFacts) => void> = {
  "not-production": (f) => {
    f.switches.production = false;
  },
  "switch-off": (f) => {
    f.switches.enabled = false;
  },
  "merge-switch-off": (f) => {
    f.stage = "merge";
    f.switches.merge = false;
  },
  "not-automatic": (f) => {
    f.row.origin = "administrator";
  },
  "has-corrections": (f) => {
    f.row.counts = { ...f.row.counts, corrections: 1 };
  },
  "dataset-anonymous": (f) => {
    f.dataset.anonymous = 1;
  },
  "dataset-withdrawn": (f) => {
    f.dataset.withdrawn = true;
  },
  "import-in-flight": (f) => {
    f.dataset.importInFlight = true;
  },
  "dataset-not-mirror": (f) => {
    f.dataset.mirror = false;
  },
  "pr-unreadable": (f) => {
    f.pr = "unreadable";
  },
  "pr-closed": (f) => {
    pr(f).state = "closed";
  },
  "pr-mismatch": (f) => {
    pr(f).number = 5;
  },
  "pr-draft": (f) => {
    pr(f).draft = true;
  },
  "pr-not-app": (f) => {
    pr(f).authorId = 1;
  },
  "head-moved": (f) => {
    pr(f).headSha = OTHER;
  },
  "main-unreadable": (f) => {
    f.mainSha = "unreadable";
  },
  "main-moved": (f) => {
    f.mainSha = OTHER;
  },
  "checks-unreadable": (f) => {
    f.checks.bids = { status: "unreadable", conclusion: null };
  },
  "bids-pending": (f) => {
    f.checks.bids = { status: "in_progress", conclusion: null };
  },
  "bids-failed": (f) => {
    f.checks.bids = { status: "completed", conclusion: "failure" };
  },
  "version-check-pending": (f) => {
    f.checks.versionCheck = { status: "queued", conclusion: null };
  },
  "version-check-failed": (f) => {
    f.checks.versionCheck = { status: "completed", conclusion: "failure" };
  },
  "screen-pending": (f) => {
    f.screen = "pending";
  },
  "screen-unreported": (f) => {
    f.screen = "unreported";
  },
  "screen-acknowledge": (f) => {
    f.screen = "acknowledge";
  },
  "screen-blocks": (f) => {
    f.screen = "blocks";
  },
  "screen-unchecked": (f) => {
    f.screen = "unchecked";
  },
  "screen-rerun": (f) => {
    f.screen = "absent";
  },
  "screen-error": (f) => {
    f.screen = "error";
  },
  "screen-unreadable": (f) => {
    f.screen = "unreadable";
  },
  "screen-exempt": (f) => {
    f.screen = "exempt";
  },
  "review-absent": (f) => {
    f.review = "absent";
  },
  "review-running": (f) => {
    f.review = "running";
  },
  "review-not-pass": (f) => {
    f.review = "fail";
  },
  "review-exempt": (f) => {
    f.review = "exempt";
  },
  "review-unreadable": (f) => {
    f.review = "unreadable";
  },
  "not-clean": (f) => {
    pr(f).mergeableState = "unknown";
  },
};

function verdict(...flips: Array<(f: MachineCleanFacts) => void>) {
  const f = clean();
  for (const flip of flips) flip(f);
  return machineClean(f);
}

const holdOf = (...flips: Array<(f: MachineCleanFacts) => void>) => {
  const v = verdict(...flips);
  return v.clean ? "clean" : v.hold;
};

describe("a clean set of facts", () => {
  test("is clean at the gates and at the merge", () => {
    expect(verdict()).toEqual({ clean: true });
    expect(
      verdict((f) => {
        f.stage = "merge";
      }),
    ).toEqual({ clean: true });
  });
});

describe("every rule, flipped alone, holds with its own word", () => {
  test("every word the rule answers is a stored hold word, and none repeats", () => {
    const stored = new Set<string>(REPULL_HOLD_REASONS);
    for (const w of MACHINE_CLEAN_HOLDS) expect([w, stored.has(w)]).toEqual([w, true]);
    expect(new Set(MACHINE_CLEAN_HOLDS).size).toBe(MACHINE_CLEAN_HOLDS.length);
  });

  for (const word of MACHINE_CLEAN_HOLDS) {
    test(word, () => {
      expect(holdOf(FLIPS[word])).toBe(word);
    });
  }

  test("of any two failures, the earlier rule's word wins", () => {
    const wrong: string[] = [];
    for (let i = 0; i < MACHINE_CLEAN_HOLDS.length; i++) {
      for (let j = i + 1; j < MACHINE_CLEAN_HOLDS.length; j++) {
        const early = MACHINE_CLEAN_HOLDS[i] as (typeof MACHINE_CLEAN_HOLDS)[number];
        const late = MACHINE_CLEAN_HOLDS[j] as (typeof MACHINE_CLEAN_HOLDS)[number];
        // The later flip first, so the earlier one is the last word on any field they share.
        const got = holdOf(FLIPS[late], FLIPS[early]);
        if (got !== early) wrong.push(`${early} + ${late} -> ${got}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("unknown is never clean", () => {
  test("GitHub's mergeable state: only `clean` is clean", () => {
    for (const state of [
      "unknown",
      null,
      "unstable",
      "blocked",
      "behind",
      "dirty",
      "draft",
      "has_hooks",
      "",
      "CLEAN",
    ]) {
      expect([
        state,
        holdOf((f) => {
          pr(f).mergeableState = state;
        }),
      ]).toEqual([state, "not-clean"]);
    }
  });

  test("a check is green only completed with `success`", () => {
    for (const conclusion of ["neutral", "skipped", "failure", "cancelled", "timed_out", null]) {
      expect([
        conclusion,
        holdOf((f) => {
          f.checks.versionCheck = { status: "completed", conclusion };
        }),
      ]).toEqual([conclusion, "version-check-failed"]);
    }
    for (const status of ["absent", "queued", "in_progress"] as const) {
      expect([
        status,
        holdOf((f) => {
          f.checks.bids = { status, conclusion: "success" };
        }),
      ]).toEqual([status, "bids-pending"]);
    }
    expect(
      holdOf((f) => {
        f.checks.versionCheck = { status: "unreadable", conclusion: null };
      }),
    ).toBe("checks-unreadable");
  });

  test("an acknowledged screen and an exempt review are never clean", () => {
    // `acknowledge` needs a person (ADR 0086) even when one has recorded a reason, and an
    // exempt review is no review: neither is a gate the Worker may pass.
    expect(
      holdOf((f) => {
        f.screen = "acknowledge";
      }),
    ).toBe("screen-acknowledge");
    expect(
      holdOf((f) => {
        f.review = "exempt";
      }),
    ).toBe("review-exempt");
  });

  test("every screen fact but `clear` holds, `absent` as one to screen", () => {
    const facts: ScreenFact[] = [
      "acknowledge",
      "blocks",
      "unchecked",
      "pending",
      "unreported",
      "error",
      "exempt",
      "absent",
      "unreadable",
    ];
    for (const s of facts)
      expect(
        holdOf((f) => {
          f.screen = s;
        }),
      ).not.toBe("clean");
    expect(
      holdOf((f) => {
        f.screen = "absent";
      }),
    ).toBe("screen-rerun");
  });

  test("every review fact but `pass` holds", () => {
    const facts: ReviewFact[] = [
      "fail",
      "uncertain",
      "running",
      "error",
      "declined",
      "unreported",
      "exempt",
      "absent",
      "unreadable",
    ];
    for (const r of facts)
      expect(
        holdOf((f) => {
          f.review = r;
        }),
      ).not.toBe("clean");
    for (const r of ["uncertain", "error", "declined", "unreported"] as const) {
      expect(
        holdOf((f) => {
          f.review = r;
        }),
      ).toBe("review-not-pass");
    }
  });

  test("a value outside the types holds rather than passing", () => {
    expect(
      holdOf((f) => {
        f.screen = "bogus" as ScreenFact;
      }),
    ).toBe("screen-unreadable");
    expect(
      holdOf((f) => {
        f.review = "bogus" as ReviewFact;
      }),
    ).toBe("review-unreadable");
    expect(
      holdOf((f) => {
        f.screen = "toString" as ScreenFact;
      }),
    ).toBe("screen-unreadable");
    expect(
      holdOf((f) => {
        f.checks.bids = { status: "bogus" as "completed", conclusion: "success" };
      }),
    ).toBe("bids-pending");
  });

  test("anonymity that could not be read holds as anonymous", () => {
    expect(
      holdOf((f) => {
        f.dataset.anonymous = null;
      }),
    ).toBe("dataset-anonymous");
  });

  test("a plan count left out is not zero, and an N.0.1 is a correction", () => {
    for (const key of ["unexplained", "conflicts", "corrections"]) {
      expect([key, holdOf((f) => delete f.row.counts[key])]).toEqual([key, "has-corrections"]);
      expect([
        key,
        holdOf((f) => {
          f.row.counts[key] = 2;
        }),
      ]).toEqual([key, "has-corrections"]);
    }
    expect(
      holdOf((f) => {
        f.row.patch_version = "2.0.1";
      }),
    ).toBe("has-corrections");
  });
});

describe("the pull request is the recorded one, opened by the App", () => {
  test("a record without its pull request is a mismatch, before GitHub is read", () => {
    for (const col of ["branch", "pr_number", "head_sha"] as const) {
      expect([
        col,
        holdOf((f) => {
          (f.row as Record<string, unknown>)[col] = null;
        }),
      ]).toEqual([col, "pr-mismatch"]);
    }
  });

  test("an `xx` record is never machine clean, whatever its origin says", () => {
    expect(
      holdOf((f) => {
        f.row.dataset_id = "xx090123";
      }),
    ).toBe("not-automatic");
  });

  test("a merged pull request is closed, whatever its state says", () => {
    expect(
      holdOf((f) => {
        pr(f).merged = true;
      }),
    ).toBe("pr-closed");
  });

  test("another branch, another base, a fork, or a deleted fork is a mismatch", () => {
    expect(
      holdOf((f) => {
        pr(f).headRef = "release/v3.0.0";
      }),
    ).toBe("pr-mismatch");
    expect(
      holdOf((f) => {
        pr(f).baseRef = "dev";
      }),
    ).toBe("pr-mismatch");
    expect(
      holdOf((f) => {
        pr(f).headRepo = `someone/${DS}`;
      }),
    ).toBe("pr-mismatch");
    expect(
      holdOf((f) => {
        pr(f).headRepo = null;
      }),
    ).toBe("pr-mismatch");
    expect(
      holdOf((f) => {
        pr(f).baseRepo = "nemarDatasets/on000001";
      }),
    ).toBe("pr-mismatch");
    // GitHub's case is not NEMAR's to insist on: the repository is the same one.
    expect(
      holdOf((f) => {
        pr(f).headRepo = `NemarDatasets/${DS.toUpperCase()}`;
      }),
    ).toBe("clean");
  });

  test("the App is its login AND its numeric id AND its type", () => {
    expect(
      holdOf((f) => {
        pr(f).authorLogin = "nemar-publish-bot";
      }),
    ).toBe("pr-not-app");
    expect(
      holdOf((f) => {
        pr(f).authorLogin = "dependabot[bot]";
      }),
    ).toBe("pr-not-app");
    expect(
      holdOf((f) => {
        pr(f).authorId = NEMAR_APP_BOT_USER_ID + 1;
      }),
    ).toBe("pr-not-app");
    expect(
      holdOf((f) => {
        pr(f).authorType = "User";
      }),
    ).toBe("pr-not-app");
  });
});

describe("the head the stage is about", () => {
  const atMerge = (f: MachineCleanFacts) => {
    f.stage = "merge";
  };

  test("the merge reads the screened head the gates recorded", () => {
    expect(
      holdOf(atMerge, (f) => {
        f.row.gates_sha = null;
      }),
    ).toBe("head-moved");
    // GitHub's head is the recorded one, but the gates screened another.
    expect(
      holdOf(atMerge, (f) => {
        f.row.gates_sha = OTHER;
      }),
    ).toBe("head-moved");
    // The gates screened GitHub's head, but the record's head is another.
    expect(
      holdOf(
        atMerge,
        (f) => {
          f.row.gates_sha = OTHER;
        },
        (f) => {
          pr(f).headSha = OTHER;
        },
      ),
    ).toBe("head-moved");
  });

  test("the gates do not read the screened head, which is not recorded yet", () => {
    expect(
      holdOf((f) => {
        f.row.gates_sha = null;
      }),
    ).toBe("clean");
  });

  test("a stage that is neither is read as the merge, so the merge switch is needed", () => {
    expect(
      holdOf(
        (f) => {
          f.stage = "later" as "merge";
        },
        (f) => {
          f.switches.merge = false;
        },
      ),
    ).toBe("merge-switch-off");
  });
});
