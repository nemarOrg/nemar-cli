/**
 * The web-button approval asks the installed CLI which approve path it has, by parsing help.
 *
 * nemarDatasets/.github `.github/workflows/approve-publication.yml` (about lines 347-351; the
 * workflow is not in this repository) runs `nemar admin repo --help`, strips color codes, and
 * picks `admin repo publish approve` only when a line of that help is an indented `publish`
 * command; otherwise it falls back to `admin publish approve`, which is a moved-command stub that
 * exits 1. So if `admin repo --help` ever stops printing `publish` on its own indented line (a
 * help fold, a rename that drops the `repo` alias), every web-button approval fails.
 *
 * This runs the workflow's own bash lines, copied verbatim below, against the real CLI's help.
 * If the workflow's probe changes, copy the new lines here.
 *
 * CI TIER: unit-pure. Hermetic: bash and the CLI are spawned with an environment built from
 * nothing; `--help` makes no request, and the account's apiUrl is a recording stand-in that
 * would show one.
 */

import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "bun";
import { startIsolatedCli } from "./helpers/isolated-cli";

setDefaultTimeout(30_000);

/** approve-publication.yml, the probe, verbatim (only `echo` added to report the choice). */
const WORKFLOW_PROBE = `repo_help="$(nemar admin repo --help 2>/dev/null | sed 's/\\x1b\\[[0-9;]*m//g' || true)"
if [[ "$repo_help" =~ (^|$'\\n')[[:space:]]+publish[[:space:]] ]]; then
  approve_cmd=(admin repo publish approve)
else
  approve_cmd=(admin publish approve)
fi
echo "\${approve_cmd[*]}"`;

const cli = startIsolatedCli();
afterAll(() => cli.stop());
beforeEach(() => cli.reset());

/**
 * Runs the probe in bash with `nemar` defined as a function: `help` replaces `nemar admin repo
 * --help` with another help invocation, or `fake` makes `nemar` print fixed text instead.
 */
async function probe(
  opts: { help?: string[]; fake?: string; color?: boolean } = {},
): Promise<string> {
  const nemar = opts.fake
    ? `nemar() { printf '%s\\n' "$FAKE_HELP"; }`
    : `nemar() { bun run "$CLI_ENTRY" ${opts.help ? `${opts.help.join(" ")} ` : ""}"$@"; }`;
  const script = opts.help
    ? WORKFLOW_PROBE.replace("nemar admin repo --help", "nemar")
    : WORKFLOW_PROBE;
  const proc = spawn({
    cmd: ["bash", "-c", `set -euo pipefail\n${nemar}\n${script}`],
    env: cli.env({
      CLI_ENTRY: cli.entry,
      FAKE_HELP: opts.fake ?? "",
      ...(opts.color ? { FORCE_COLOR: "1" } : {}),
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code, stderr).toBe(0);
  return stdout.trim();
}

describe("approve-publication.yml's help probe", () => {
  test("picks admin repo publish approve from the real admin repo --help", async () => {
    expect(await probe()).toBe("admin repo publish approve");
    expect(cli.requests).toEqual([]);
  });

  test("still picks it when the help is colored (the sed strip is what matches)", async () => {
    const raw = await cli.runRaw(["admin", "repo", "--help"], { FORCE_COLOR: "1" });
    // Control: the help really is colored, so the strip is exercised.
    expect(raw.stdout).toContain("\u001B[");
    expect(await probe({ color: true })).toBe("admin repo publish approve");
  });

  test("the same regex finds publish in admin dataset --help", async () => {
    expect(await probe({ help: ["admin", "dataset", "--help"] })).toBe(
      "admin repo publish approve",
    );
  });

  test("control: help that folds publish onto one line falls back to the dead path", async () => {
    const folded = [
      "Usage: nemar admin dataset|repo [options] [command]",
      "",
      "Commands:",
      "  unpublish [options] <dataset-id>  Authors pull a dataset back",
      "",
      "More commands (--help-all for details):",
      "  publish, restore, withdraw",
    ].join("\n");
    expect(await probe({ fake: folded })).toBe("admin publish approve");
  });

  test("the path it picks runs, and the fallback is a stub that exits 1", async () => {
    const live = await cli.run(["admin", "repo", "publish", "approve", "--help"]);
    expect(live.exitCode).toBe(0);
    // Commander answers --help under an unknown word with the parent's help and exit 0, so the
    // exit code alone cannot tell; the usage line names the command that answered.
    expect(live.stdout).toContain("Usage: nemar admin dataset publish approve");
    const dead = await cli.run(["admin", "publish", "approve", "nm000999", "--yes"]);
    expect(dead.exitCode).toBe(1);
    expect(dead.stderr).toContain("moved to 'nemar admin dataset publish'");
    expect(cli.requests).toEqual([]);
  });
});
