/**
 * The identifier preflight through the real CLI entry point (epic #1610 phase 3, ADR 0087).
 *
 * A real subprocess (`bun run src/index.ts dataset upload <dir>`) against a local HTTP server
 * that records every request, with an isolated config. Each test here ends AT the preflight, by
 * design: a run that went past it would go on to talk to GitHub and git-annex with whatever
 * credentials the machine holds, so the proceeding paths are covered at the step level
 * (upload-identifier-preflight.test.ts) and on the wire (upload-preflight-recording.test.ts).
 *
 * What is asserted is what a person and a CI log would see, and what left the machine: the
 * verdict in fixed words, no value and no path in the output, no request that carries dataset
 * content, and no git repository created in the dataset.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn } from "bun";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

interface Recorded {
  method: string;
  pathname: string;
}

function startServer() {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push({ method: req.method, pathname: url.pathname });
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) };
}

/** A port nothing listens on: the API is unreachable, as on a machine with no network. */
function closedPort(): string {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const url = `http://localhost:${server.port}`;
  server.stop(true);
  return url;
}

let configDir: string;
let dataset: string;
/** An empty directory: the PATH of a run that must not get past the preflight. */
let emptyPath: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "nemar-preflight-cli-cfg-"));
  emptyPath = mkdtempSync(join(tmpdir(), "nemar-preflight-cli-path-"));
  // A parent named after nobody, and a dataset directory whose own name must not be printed.
  dataset = join(mkdtempSync(join(tmpdir(), "nemar-preflight-cli-")), "Quillfeather-study");
  mkdirSync(dataset);
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(emptyPath, { recursive: true, force: true });
  rmSync(dirname(dataset), { recursive: true, force: true });
});

/** The account the child signs in with, pointed at `apiUrl` through the config file. */
function configure(apiUrl: string): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "preflight",
      // The sandbox flag is a cache the upload reads before asking the backend, so the run gets
      // to the preflight without one.
      accounts: { preflight: { apiKey: "k", apiUrl, sandboxCompleted: true } },
    }),
  );
}

/**
 * The child's environment: this process's, with every `TEST_`-prefixed variable removed, so a
 * run in CI's live tier cannot inherit that tier's backend or keys, and the config file above is
 * the only place the API is named. `PATH` is replaced by an empty directory when asked: a run
 * that gets past the preflight then stops at the required-tools check, before any step that
 * could reach GitHub or git-annex.
 */
function childEnv(options: { noTools?: boolean } = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("TEST_")) continue;
    if (key === "FORCE_COLOR" || key === "CLICOLOR_FORCE") continue;
    env[key] = value;
  }
  env.NEMAR_CONFIG_DIR = configDir;
  env.NEMAR_NO_UPDATE_CHECK = "1";
  env.NO_COLOR = "1";
  if (options.noTools) env.PATH = emptyPath;
  return env;
}

async function upload(args: string[], apiUrl: string, options: { noTools?: boolean } = {}) {
  configure(apiUrl);
  const proc = spawn({
    // The absolute path of this bun, so the run does not need PATH to start.
    cmd: [process.execPath, "run", CLI_ENTRY, "dataset", "upload", dataset, ...args],
    cwd: REPO_ROOT,
    env: childEnv(options),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { output: `${stdout}\n${stderr}`, exitCode: await proc.exited };
}

/**
 * Drives the upload at a real terminal: a pseudo-terminal from Python's `pty`, the CLI's real
 * prompt, and an answer typed when `Upload anyway?` appears. Nothing is replaced; the only stand-in
 * is the person.
 */
const PTY_DRIVER = `
import fcntl, os, pty, select, signal, struct, sys, termios, time
answer = os.environ.pop("PREFLIGHT_ANSWER").encode().decode("unicode_escape").encode()
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
# A terminal with a size: a zero-column terminal makes a spinner redraw without end.
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
out, sent, deadline = b"", False, time.time() + 90
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.5)
    if fd not in ready:
        if os.waitpid(pid, os.WNOHANG) != (0, 0):
            break
        continue
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    if not sent and b"Upload anyway?" in out:
        time.sleep(0.3)
        os.write(fd, answer)
        sent = True
try:
    os.kill(pid, signal.SIGKILL)
except ProcessLookupError:
    pass
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.exit(1 if not sent else (status >> 8) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
`;

const PYTHON = Bun.which("python3");

async function uploadAtTerminal(answer: string, apiUrl: string) {
  configure(apiUrl);
  const driver = join(configDir, "pty-driver.py");
  writeFileSync(driver, PTY_DRIVER);
  const proc = spawn({
    cmd: [
      PYTHON as string,
      driver,
      process.execPath,
      "run",
      CLI_ENTRY,
      "dataset",
      "upload",
      dataset,
    ],
    cwd: REPO_ROOT,
    // TERM=dumb: spinners print their result lines instead of animating; the prompt still runs.
    env: { ...childEnv({ noTools: true }), TERM: "dumb", PREFLIGHT_ANSWER: answer },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const raw = await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  // Terminal control sequences out, so what is asserted is the text a person reads.
  const output = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  return { output, exitCode: await proc.exited };
}

function put(out: Uint8Array, text: string, start: number, width: number): void {
  out.fill(0x20, start, start + width);
  out.set(new TextEncoder().encode(text).subarray(0, width), start);
}

function recording(patient: string, startdate = "01.01.85"): Uint8Array {
  const out = new Uint8Array(1024).fill(0x20);
  put(out, "0", 0, 8);
  put(out, patient, 8, 80);
  put(out, "Startdate X X X X", 88, 80);
  put(out, startdate, 168, 8);
  return out;
}

function write(rel: string, content: string | Uint8Array): void {
  const path = join(dataset, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Hostile on purpose: a surname with an apostrophe and quotes in the header's name slot, the
 * same surname as a subject label in the paths, and quotes in a file name.
 */
function namedDataset(): void {
  write("dataset_description.json", JSON.stringify({ Name: "Fixture", BIDSVersion: "1.9.0" }));
  write("participants.tsv", "participant_id\tage\nsub-Quillfeather\t30\n");
  write(
    `sub-Quillfeather/eeg/sub-Quillfeather_task-"rest"_eeg.edf`,
    recording(`P01 F X O'Brien-"Quillfeather"`),
  );
}

function brainVisionDataset(): void {
  write("dataset_description.json", JSON.stringify({ Name: "Fixture", BIDSVersion: "1.9.0" }));
  write("sub-01/eeg/sub-01_task-rest_eeg.vhdr", "Brain Vision Data Exchange Header File\n");
  write("sub-01/eeg/sub-01_task-rest_eeg.eeg", new Uint8Array(64));
}

/**
 * Acquisition dates finer than year: two EDF headers and one scans-table row, so three entries.
 * No name anywhere, so the verdict is dates-only and the gate clears it (ADR 0087, ADR 0090).
 */
function datedDataset(): void {
  write("dataset_description.json", JSON.stringify({ Name: "Fixture", BIDSVersion: "1.9.0" }));
  write("sub-01/eeg/sub-01_task-rest_eeg.edf", recording("P01 F X X", "15.03.85"));
  write("sub-02/eeg/sub-02_task-rest_eeg.edf", recording("P02 M X X", "02.11.91"));
  write(
    "sub-01/sub-01_scans.tsv",
    "filename\tacq_time\neeg/sub-01_task-rest_eeg.edf\t1985-03-15T10:00:00\n",
  );
}

/** The warning ADR 0090 words, for a count of `n`. */
const dateWarning = (n: number) => [
  `Warning: acquisition dates finer than year and month were found in recording headers or scans tables (${n} ${n === 1 ? "entry" : "entries"}).`,
  "NEMAR does not change them.",
  "A date can help identify a participant when it is combined with other information.",
  "Remove or coarsen any date that could identify someone before uploading or requesting publication.",
  "An administrator reviews these before a dataset is made public.",
];

/** No date, no path and no file name in what the warning printed, and no digit but its count. */
function expectWarningCarriesOnlyItsCount(output: string, n: number): void {
  const printed = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => dateWarning(n).includes(line));
  expect(printed).toEqual(dateWarning(n));
  const withoutCount = printed.join("\n").replace(`(${n} entries)`, "()");
  expect(withoutCount).not.toMatch(/\d/);
  for (const part of ["1985", "1991", "15.03", "02.11", "03-15", "sub-01", "_scans", ".edf"]) {
    expect(printed.join("\n")).not.toContain(part);
  }
}

/** Nothing a person could be named by: not the surname, not a path, not the directory. */
function expectNoValue(output: string): void {
  for (const part of ["Quillfeather", "Brien", '"rest"', "sub-Quill", basename(dirname(dataset))]) {
    expect(output).not.toContain(part);
  }
}

/** The request the upload makes first with dataset content, and every step after it. */
function expectNothingSent(requests: Recorded[]): void {
  expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  expect(requests.map((r) => r.pathname).filter((p) => p.startsWith("/datasets"))).toEqual([]);
  expect(existsSync(join(dataset, ".git"))).toBe(false);
}

describe("nemar dataset upload: direct identifiers", () => {
  test("refused in kinds and counts, before anything is sent or any tool runs", async () => {
    namedDataset();
    const server = startServer();
    try {
      const r = await upload(["--yes", "--skip-validation"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain("Identifier preflight: FOUND IDENTIFIERS");
      expect(r.output).toContain("Findings by kind:");
      expect(r.output).toContain("edf-patient-name x1");
      expect(r.output).toContain("Upload refused");
      expect(r.output).toContain("Nothing was sent");
      // A refusal is the answer, not a bug: no invitation to attach a debug log.
      expect(r.output).not.toContain("attach the log to a new issue");
      // It ran before the tool checks, the prerequisite check and validation.
      expect(r.output).not.toContain("Checking prerequisites");
      expect(r.output).not.toContain("Missing required tools");
      expect(r.output).not.toContain("Validating BIDS");
      expectNoValue(r.output);
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });

  test("--dry-run is refused too: the preview says what a real upload would do", async () => {
    namedDataset();
    const server = startServer();
    try {
      const r = await upload(["--dry-run", "--yes"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain("Upload refused");
      expectNoValue(r.output);
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });

  test("no flag acknowledges a direct identifier, and naming the verdict is not allowed", async () => {
    namedDataset();
    const server = startServer();
    try {
      const flagged = await upload(
        ["--yes", "--acknowledge-identifier-preflight", "review"],
        server.url,
      );
      expect(flagged.exitCode).toBe(1);
      expect(flagged.output).toContain("Upload refused");
      const direct = await upload(
        ["--yes", "--acknowledge-identifier-preflight", "direct-identifiers"],
        server.url,
      );
      expect(direct.exitCode).not.toBe(0);
      expect(direct.output).toContain("Allowed verdicts are");
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });

  test("offline: the preflight needs no network to reach its verdict", async () => {
    namedDataset();
    const r = await upload(["--yes"], closedPort());
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("Identifier preflight: FOUND IDENTIFIERS");
    expect(r.output).toContain("Upload refused");
    expect(existsSync(join(dataset, ".git"))).toBe(false);
  });
});

describe("nemar dataset upload: a verdict that needs an acknowledgment", () => {
  test("the flag naming it lets the run past the preflight, and nothing is sent by it", async () => {
    brainVisionDataset();
    const server = startServer();
    try {
      // No tools on PATH: past the preflight, the run stops at the required-tools check.
      const r = await upload(
        ["--yes", "--acknowledge-identifier-preflight", "not-screened"],
        server.url,
        { noTools: true },
      );
      expect(r.output).toContain(
        "Acknowledged with --acknowledge-identifier-preflight not-screened",
      );
      expect(r.output).toContain("Missing required tools");
      expect(r.exitCode).not.toBe(0);
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });

  test("a comma-separated flag naming more than was found is not an acknowledgment", async () => {
    brainVisionDataset();
    const server = startServer();
    try {
      const r = await upload(
        ["--yes", "--acknowledge-identifier-preflight", "not-screened,review"],
        server.url,
        { noTools: true },
      );
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain("must name exactly what was found, which is: not-screened");
      expect(r.output).not.toContain("Missing required tools");
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });

  test("--yes does not acknowledge it; without a terminal or the flag, the upload stops", async () => {
    brainVisionDataset();
    const server = startServer();
    try {
      const r = await upload(["--yes"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain("Identifier preflight: recordings NOT screened");
      // The walk is sorted, so the order is the same on APFS and ext4.
      expect(r.output).toContain("Not screened (format x files): .eeg x1, .vhdr x1.");
      expect(r.output).toContain("--yes does not acknowledge a finding");
      expect(r.output).toContain("--acknowledge-identifier-preflight not-screened");
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });

  test("a flag naming another verdict does not acknowledge this one", async () => {
    brainVisionDataset();
    const server = startServer();
    try {
      const r = await upload(["--yes", "--acknowledge-identifier-preflight", "review"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain("must name exactly what was found, which is: not-screened");
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });

  test("--no declines it", async () => {
    brainVisionDataset();
    const server = startServer();
    try {
      const r = await upload(["--no"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain("Declined (--no)");
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });
});

describe("nemar dataset upload: acquisition dates are warned about and gate nothing (ADR 0090)", () => {
  test("dates only: clean, the warning with its count, no prompt, and the run goes on", async () => {
    datedDataset();
    const server = startServer();
    try {
      // No tools on PATH: past the preflight, the run stops at the required-tools check.
      const r = await upload(["--yes"], server.url, { noTools: true });
      expect(r.output).toContain("Identifier preflight: clean (acquisition dates only)");
      expect(r.output).toContain("Findings by kind: edf-startdate x2, acq-time-dated x1.");
      expectWarningCarriesOnlyItsCount(r.output, 3);
      // Nothing to acknowledge: no refusal, no prompt, no condition named, and it went on.
      expect(r.output).not.toContain("Upload refused");
      expect(r.output).not.toContain("Upload anyway?");
      expect(r.output).not.toContain("acknowledg");
      expect(r.output).toContain("Missing required tools");
      expectNoValue(r.output);
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });

  test("--dry-run shows the same warning", async () => {
    datedDataset();
    const server = startServer();
    try {
      const r = await upload(["--dry-run", "--yes"], server.url, { noTools: true });
      expectWarningCarriesOnlyItsCount(r.output, 3);
      expect(r.output).not.toContain("Upload refused");
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });

  test("no date finding, no warning", async () => {
    write("dataset_description.json", JSON.stringify({ Name: "Fixture", BIDSVersion: "1.9.0" }));
    // 1 January is a year-only date, which the scanner does not count.
    write("sub-01/eeg/sub-01_task-rest_eeg.edf", recording("P01 F X X"));
    const server = startServer();
    try {
      const r = await upload(["--yes"], server.url, { noTools: true });
      expect(r.output).toContain("Identifier preflight: clean");
      expect(r.output).not.toContain("clean (acquisition dates only)");
      expect(r.output).not.toContain("Warning: acquisition dates");
      expect(r.output).not.toContain("NEMAR does not change them");
      expect(r.output).toContain("Missing required tools");
    } finally {
      server.stop();
    }
  });

  test("dates beside a condition that needs an acknowledgment add no condition to it", async () => {
    datedDataset();
    // A recording format the scanner cannot read: the verdict is its own, and dates are not part of it.
    write("sub-03/eeg/sub-03_task-rest_eeg.vhdr", "Brain Vision Data Exchange Header File\n");
    const server = startServer();
    try {
      const stopped = await upload(["--yes"], server.url);
      expect(stopped.exitCode).toBe(1);
      expect(stopped.output).toContain(
        "Identifier preflight: EDF/BDF clean, other recordings NOT screened",
      );
      expectWarningCarriesOnlyItsCount(stopped.output, 3);
      expect(stopped.output).toContain(
        "--acknowledge-identifier-preflight clean-edf-only-others-unscreened",
      );
      expect(stopped.output).not.toContain("dates-only");
      expectNothingSent(server.requests);

      // The flag that names exactly that one condition is accepted, with the warning printed.
      const named = await upload(
        ["--yes", "--acknowledge-identifier-preflight", "clean-edf-only-others-unscreened"],
        server.url,
        { noTools: true },
      );
      expect(named.output).toContain(
        "Acknowledged with --acknowledge-identifier-preflight clean-edf-only-others-unscreened",
      );
      expectWarningCarriesOnlyItsCount(named.output, 3);
      expect(named.output).toContain("Missing required tools");
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });

  test("dates-only is not a verdict a flag can name: there is nothing to acknowledge", async () => {
    datedDataset();
    const server = startServer();
    try {
      const r = await upload(
        ["--yes", "--acknowledge-identifier-preflight", "dates-only"],
        server.url,
      );
      expect(r.exitCode).not.toBe(0);
      expect(r.output).toContain("Allowed verdicts are");
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });

  test("a direct identifier beside dates is still refused, with the warning above the refusal", async () => {
    datedDataset();
    write("sub-04/eeg/sub-04_task-rest_eeg.edf", recording("P04 F X Quillfeather", "09.09.90"));
    const server = startServer();
    try {
      const r = await upload(["--yes"], server.url);
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain("Identifier preflight: FOUND IDENTIFIERS");
      expect(r.output).toContain("Upload refused");
      // Three dated headers now, and the scans-table row.
      expectWarningCarriesOnlyItsCount(r.output, 4);
      expect(r.output.indexOf("Warning: acquisition dates")).toBeLessThan(
        r.output.indexOf("Upload refused"),
      );
      expectNoValue(r.output);
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  });
});

describe.skipIf(PYTHON === null)("nemar dataset upload at a terminal: the prompt", () => {
  test("Enter takes the default, which is no", async () => {
    brainVisionDataset();
    const server = startServer();
    try {
      const r = await uploadAtTerminal("\\r", server.url);
      expect(r.output).toContain("Upload anyway?");
      expect(r.output).toContain("Upload cancelled. Nothing was sent.");
      expect(r.output).not.toContain("Acknowledged at the prompt");
      expect(r.exitCode).toBe(1);
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  }, 120_000);

  test("y acknowledges, and the run goes past the preflight", async () => {
    brainVisionDataset();
    const server = startServer();
    try {
      const r = await uploadAtTerminal("y\\r", server.url);
      expect(r.output).toContain("Acknowledged at the prompt.");
      expect(r.output).toContain("Missing required tools");
      expect(r.output).not.toContain("Upload cancelled");
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  }, 120_000);

  test("Ctrl+C is not an acknowledgment", async () => {
    brainVisionDataset();
    const server = startServer();
    try {
      const r = await uploadAtTerminal("\\x03", server.url);
      expect(r.output).toContain("Upload anyway?");
      expect(r.output).not.toContain("Acknowledged at the prompt");
      expect(r.output).not.toContain("Missing required tools");
      expect(r.output).toContain("Upload cancelled. Nothing was sent.");
      expect(r.exitCode).toBe(130);
      expectNothingSent(server.requests);
    } finally {
      server.stop();
    }
  }, 120_000);
});

describe("the upload action hands the record to the create call (source-level supplement)", () => {
  // Every subprocess test above ends at the preflight, because a run past it would reach GitHub
  // and git-annex with this machine's credentials. So nothing above can see whether the action
  // passes the record on to createOrResumeDataset; the wire is tested in
  // upload-preflight-recording.test.ts from that function down. This pins the one hop between.
  test("the step runs first, is screened again before create, and that record is sent", async () => {
    const source = await Bun.file(join(REPO_ROOT, "src", "commands", "dataset.ts")).text();
    const action = source.slice(source.indexOf("export function createUploadCommand"));
    const step = action.indexOf("await identifierPreflightStep(absolutePath, options)");
    expect(step).toBeGreaterThan(0);
    for (const later of [
      'checkPrerequisitesForCommand("upload")',
      "collectAuthorOrcids(",
      "createOrResumeDataset(",
    ]) {
      expect(action.indexOf(later)).toBeGreaterThan(step);
    }
    const recheck = action.indexOf(
      "await recheckIdentifierPreflight(absolutePath, identifierPreflight)",
    );
    expect(recheck).toBeGreaterThan(action.indexOf('"Proceed with upload?"'));
    expect(recheck).toBeLessThan(action.indexOf("createOrResumeDataset("));
    const call = action.slice(action.indexOf("createOrResumeDataset("));
    const args = call.slice(0, call.indexOf(");"));
    expect(args).toContain("rechecked.value");
  });
});
