import { describe, expect, test } from "bun:test";
import { buildBidsFilterArgs } from "../src/lib/bids-filter";

describe("buildBidsFilterArgs — empty input", () => {
  test("no options yields no args and inactive", () => {
    const r = buildBidsFilterArgs({});
    expect(r.active).toBe(false);
    expect(r.args).toEqual([]);
    expect(r.summary).toEqual([]);
  });

  test("empty strings are inactive", () => {
    const r = buildBidsFilterArgs({ subjects: "", tasks: "" });
    expect(r.active).toBe(false);
    expect(r.args).toEqual([]);
  });
});

describe("buildBidsFilterArgs — subjects", () => {
  test("single subject with full prefix", () => {
    const r = buildBidsFilterArgs({ subjects: "sub-01" });
    expect(r.active).toBe(true);
    expect(r.args).toEqual(["--include", "sub-01/**"]);
  });

  test("single subject without prefix is normalized", () => {
    const r = buildBidsFilterArgs({ subjects: "01" });
    expect(r.args).toEqual(["--include", "sub-01/**"]);
  });

  test("multiple subjects are wrapped in OR group", () => {
    const r = buildBidsFilterArgs({ subjects: "sub-01,02,sub-03" });
    expect(r.args).toEqual([
      "-(",
      "--include",
      "sub-01/**",
      "--or",
      "--include",
      "sub-02/**",
      "--or",
      "--include",
      "sub-03/**",
      "-)",
    ]);
  });

  test("mixed prefix and bare are both normalized", () => {
    const r = buildBidsFilterArgs({ subjects: "sub-01, 02 ,sub-03" });
    expect(r.summary).toEqual(["subjects: sub-01, sub-02, sub-03"]);
  });

  test("dedupes equivalent inputs", () => {
    const r = buildBidsFilterArgs({ subjects: "sub-01,01" });
    expect(r.args).toEqual(["--include", "sub-01/**"]);
  });
});

describe("buildBidsFilterArgs — sessions / tasks / runs / datatypes", () => {
  test("sessions produce **/ses-X/** globs", () => {
    const r = buildBidsFilterArgs({ sessions: "pre,ses-post" });
    expect(r.args).toEqual([
      "-(",
      "--include",
      "**/ses-pre/**",
      "--or",
      "--include",
      "**/ses-post/**",
      "-)",
    ]);
  });

  test("tasks strip prefix and use *_task-X_* glob", () => {
    const r = buildBidsFilterArgs({ tasks: "rest,task-nback" });
    expect(r.args).toEqual([
      "-(",
      "--include",
      "**/*_task-rest_*",
      "--or",
      "--include",
      "**/*_task-nback_*",
      "-)",
    ]);
  });

  test("runs unpadded 1-9 expand to padded + unpadded", () => {
    const r = buildBidsFilterArgs({ runs: "1" });
    // 1 expands to ['1', '01']; both become globs
    expect(r.args).toEqual([
      "-(",
      "--include",
      "**/*_run-1_*",
      "--or",
      "--include",
      "**/*_run-01_*",
      "-)",
    ]);
  });

  test("runs 10+ are not expanded", () => {
    const r = buildBidsFilterArgs({ runs: "10" });
    expect(r.args).toEqual(["--include", "**/*_run-10_*"]);
  });

  test("runs with run- prefix are stripped first", () => {
    const r = buildBidsFilterArgs({ runs: "run-2" });
    expect(r.args).toEqual([
      "-(",
      "--include",
      "**/*_run-2_*",
      "--or",
      "--include",
      "**/*_run-02_*",
      "-)",
    ]);
  });

  test("datatypes produce **/<dt>/** globs", () => {
    const r = buildBidsFilterArgs({ datatypes: "eeg,emg" });
    expect(r.args).toEqual([
      "-(",
      "--include",
      "**/eeg/**",
      "--or",
      "--include",
      "**/emg/**",
      "-)",
    ]);
  });
});

describe("buildBidsFilterArgs — pass-through include / exclude", () => {
  test("include passes through globs verbatim", () => {
    const r = buildBidsFilterArgs({ include: "sub-01/eeg/*.edf,*.json" });
    expect(r.args).toEqual([
      "-(",
      "--include",
      "sub-01/eeg/*.edf",
      "--or",
      "--include",
      "*.json",
      "-)",
    ]);
  });

  test("exclude appends --exclude flags (default AND combining)", () => {
    const r = buildBidsFilterArgs({ exclude: "derivatives/**,sourcedata/**" });
    expect(r.args).toEqual([
      "--exclude",
      "derivatives/**",
      "--exclude",
      "sourcedata/**",
    ]);
  });
});

describe("buildBidsFilterArgs — composition", () => {
  test("subjects ∩ tasks emits two AND-combined OR groups", () => {
    const r = buildBidsFilterArgs({ subjects: "sub-01,02", tasks: "rest,nback" });
    expect(r.args).toEqual([
      // subjects group
      "-(",
      "--include",
      "sub-01/**",
      "--or",
      "--include",
      "sub-02/**",
      "-)",
      // tasks group (AND'd by git-annex default combining)
      "-(",
      "--include",
      "**/*_task-rest_*",
      "--or",
      "--include",
      "**/*_task-nback_*",
      "-)",
    ]);
  });

  test("includes + excludes coexist", () => {
    const r = buildBidsFilterArgs({
      subjects: "sub-01",
      exclude: "derivatives/**",
    });
    expect(r.args).toEqual([
      "--include",
      "sub-01/**",
      "--exclude",
      "derivatives/**",
    ]);
  });

  test("only-exclude is still active", () => {
    const r = buildBidsFilterArgs({ exclude: "derivatives/**" });
    expect(r.active).toBe(true);
  });
});

describe("buildBidsFilterArgs — stimuli/derivatives default-skip", () => {
  test("excludeStimuli adds stimuli excludes but does not set active", () => {
    const r = buildBidsFilterArgs({ excludeStimuli: true });
    expect(r.active).toBe(false);
    expect(r.args).toEqual([
      "--exclude",
      "stimuli/**",
      "--exclude",
      "**/stimuli/**",
    ]);
    expect(r.summary).toEqual(["skipping stimuli/ (use --stimuli to include)"]);
  });

  test("excludeDerivatives adds derivatives excludes but does not set active", () => {
    const r = buildBidsFilterArgs({ excludeDerivatives: true });
    expect(r.active).toBe(false);
    expect(r.args).toEqual([
      "--exclude",
      "derivatives/**",
      "--exclude",
      "**/derivatives/**",
    ]);
    expect(r.summary).toEqual([
      "skipping derivatives/ (use --derivatives to include)",
    ]);
  });

  test("both flags emit both exclude pairs in order", () => {
    const r = buildBidsFilterArgs({
      excludeStimuli: true,
      excludeDerivatives: true,
    });
    expect(r.args).toEqual([
      "--exclude",
      "stimuli/**",
      "--exclude",
      "**/stimuli/**",
      "--exclude",
      "derivatives/**",
      "--exclude",
      "**/derivatives/**",
    ]);
  });

  test("default-skip composes with positive filters (subjects ∩ ¬stimuli)", () => {
    const r = buildBidsFilterArgs({
      subjects: "sub-01",
      excludeStimuli: true,
    });
    expect(r.active).toBe(true);
    expect(r.args).toEqual([
      "--include",
      "sub-01/**",
      "--exclude",
      "stimuli/**",
      "--exclude",
      "**/stimuli/**",
    ]);
  });

  test("default-skip excludes precede user-provided excludes", () => {
    const r = buildBidsFilterArgs({
      excludeStimuli: true,
      exclude: "sourcedata/**",
    });
    expect(r.args).toEqual([
      "--exclude",
      "stimuli/**",
      "--exclude",
      "**/stimuli/**",
      "--exclude",
      "sourcedata/**",
    ]);
    // user-provided exclude is still active
    expect(r.active).toBe(true);
  });

  test("excludeStimuli=false (opt-in) emits no extra excludes", () => {
    const r = buildBidsFilterArgs({
      subjects: "sub-01",
      excludeStimuli: false,
      excludeDerivatives: false,
    });
    expect(r.args).toEqual(["--include", "sub-01/**"]);
  });
});
