/**
 * The job environment help and the dry-run line are built from one module
 * (`src/lib/compute/job-environment.ts`), and that module's facts are held to the
 * contract the launcher reads (issue #2092). These tests read the real module and the
 * real contract; nothing is stubbed.
 */
import { describe, expect, test } from "bun:test";
import {
  JOB_ENV_ALLOWLIST,
  LAUNCHER_ENV,
  LAUNCHER_OUTPUTS_DIR,
  LAUNCHER_WORK_DIR,
} from "../shared/contract/compute";
import {
  JOB_ENVIRONMENT_HELP,
  JOB_OUT_ENV,
  JOB_PATHS,
  JOB_PATHS_SUMMARY,
  JOB_SETTABLE_ENV,
} from "../src/lib/compute/job-environment";

describe("job environment facts match the launcher contract", () => {
  test("the output variable is the one the launcher sets", () => {
    expect(JOB_OUT_ENV).toBe(LAUNCHER_ENV.OUT);
  });

  test("the output directory is the work directory plus the launcher's outputs folder", () => {
    // The contract spells these relative to the node's job directory ("work/outputs");
    // inside the container the work directory is mounted at /work.
    expect(LAUNCHER_OUTPUTS_DIR).toBe(`${LAUNCHER_WORK_DIR}/outputs`);
    expect(JOB_PATHS.outputs).toBe(`/${LAUNCHER_OUTPUTS_DIR}`);
    expect(JOB_PATHS.work).toBe(`/${LAUNCHER_WORK_DIR}`);
  });

  test("the settable variables are exactly the contract's allowlist", () => {
    expect([...JOB_SETTABLE_ENV]).toEqual([...JOB_ENV_ALLOWLIST]);
  });
});

describe("the help block and the dry-run line say the same paths", () => {
  test("the help names every path, the output variable and every settable name", () => {
    for (const path of [
      JOB_PATHS.work,
      JOB_PATHS.code,
      JOB_PATHS.outputs,
      `${JOB_PATHS.data}/<id>`,
    ]) {
      expect(JOB_ENVIRONMENT_HELP).toContain(path);
    }
    expect(JOB_ENVIRONMENT_HELP).toContain(`$${JOB_OUT_ENV}`);
    for (const name of JOB_ENV_ALLOWLIST) expect(JOB_ENVIRONMENT_HELP).toContain(name);
  });

  test("the help marks the page as under development and promises nothing about the unknowns", () => {
    expect(JOB_ENVIRONMENT_HELP).toContain("under development");
    expect(JOB_ENVIRONMENT_HELP).toContain("Not promised yet:");
    expect(JOB_ENVIRONMENT_HELP).toContain("network access");
  });

  test("the dry-run line names the code, data and results paths", () => {
    expect(JOB_PATHS_SUMMARY).toContain(JOB_PATHS.code);
    expect(JOB_PATHS_SUMMARY).toContain(`${JOB_PATHS.data}/<id>`);
    expect(JOB_PATHS_SUMMARY).toContain(JOB_PATHS.outputs);
  });

  test("the help block names no host, home directory or allocation", () => {
    expect(JOB_ENVIRONMENT_HELP).not.toMatch(/expanse|tapis|\/home\/|\/Users\/|@/i);
  });
});
