/**
 * The Neurobagel node deployment (epic #1586, Phase 3, ADR 0082): script-level tests.
 *
 * These run the REAL scripts in deploy/neurobagel/bin against real directories and a real HTTP
 * server, and read real captured output of the stock containers and of a real node API
 * (test/fixtures/neurobagel-node/, provenance in PROVENANCE.md). Nothing replaces the loader's
 * logic, and there is no fake Docker. The decisions that drive containers (rollback target,
 * memory abort, hold, guard breaches, whether the node serves what it should, status verdicts) are
 * pure shell functions in bin/nb-decide.sh and are tested here against that real text.
 *
 * What these tests cannot reach is Docker itself: reload, status, guard and hold start and stop
 * containers, so they were exercised on the deployment host and the measured results are in the
 * pull request and in deploy/neurobagel/README.md.
 *
 * Tools: the loader tests need jq, curl, perl and bash; the compose tests need `docker compose`
 * 2.24 or later (no daemon); the hygiene test needs shellcheck. Where one is missing the tests
 * are skipped, visibly, on a developer machine. Under CI (the CI environment variable is set) a
 * missing tool is a FAILURE: a green run must not mean nothing was checked.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import schema from "../deploy/neurobagel/index.schema.json";
import {
  buildIndex,
  generateDataset,
  main as generatorMain,
  indexEntry,
  parseOptions,
} from "../deploy/neurobagel/tools/gen-synthetic-jsonld";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const DEPLOY = join(ROOT, "deploy/neurobagel");
const BIN = join(DEPLOY, "bin");
const FIX = join(import.meta.dir, "fixtures/neurobagel-node");
const GOLDEN = join(import.meta.dir, "neurobagel/golden");
const EXAMPLE = join(FIX, "example_synthetic_pheno-bids-derivatives.jsonld");
const EXAMPLE_SHA256 = "863ab09e08571ec4cb43c9237ab3e15a5b86823aaf9da1b4c174cd81cd842bd8";

function has(cmd: string, args: string[] = ["--version"]): boolean {
  return spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
}
const haveLoaderTools = has("jq") && has("curl") && has("perl") && has("bash", ["-c", "true"]);
const haveShellcheck = has("shellcheck");
const composeVersion = ((): string | null => {
  const r = spawnSync("docker", ["compose", "version", "--short"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().replace(/^v/, "") : null;
})();
const composeOk = (() => {
  if (!composeVersion) return false;
  const [maj, min] = composeVersion.split(".").map(Number);
  return maj > 2 || (maj === 2 && min >= 24);
})();

// A missing tool fails the whole file under CI instead of skipping its tests.
function requireOnCi(ok: boolean, what: string): void {
  if (!ok && process.env.CI) {
    throw new Error(`CI requires ${what} for the Neurobagel deployment tests`);
  }
}
requireOnCi(haveLoaderTools, "jq, curl, perl and bash");
requireOnCi(composeOk, "docker compose 2.24 or later");
requireOnCi(haveShellcheck, "shellcheck");

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `${prefix}-`));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

type Artifact = { name: string; kind: string; sha256: string; bytes?: number };
type IndexDataset = { id: string; fingerprint: string; artifacts: Artifact[] };
type ArtifactIndex = { schema: string; generated_at: string; datasets: IndexDataset[] };
type ComposeService = {
  mem_limit: number | string;
  memswap_limit: number | string;
  cpus: number | string;
  pids_limit: number;
  oom_score_adj?: number;
  cpu_shares?: number;
  security_opt?: string[];
  ports?: { host_ip: string; published: string | number }[];
  environment?: Record<string, string>;
  volumes?: { target: string; source: string; read_only?: boolean }[];
  networks?: Record<string, unknown>;
  build?: { additional_contexts?: Record<string, string> };
  restart?: string;
  healthcheck?: unknown;
  network_mode?: string;
  privileged?: boolean;
};
type ComposeConfig = {
  name: string;
  services: Record<string, ComposeService>;
  networks: Record<string, unknown>;
};

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** A fresh deployment directory: nothing in it but what the scripts create themselves. */
function newHome(): string {
  const home = tmp("nbhome");
  writeFileSync(join(home, ".env"), "COMPOSE_PROJECT_NAME=nemar-neurobagel\n");
  return home;
}

type Result = { status: number | null; out: string };
/**
 * Asynchronous on purpose: several tests serve the artifact store from THIS process, and a
 * blocking spawn would stop that server from answering the loader it is waiting for.
 */
function run(
  script: string,
  args: string[],
  home: string,
  env: Record<string, string> = {},
): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(join(BIN, script), args, {
      env: {
        ...process.env,
        NB_HOME: home,
        NB_VALIDATE: "jq",
        NB_RELOAD: "0",
        NB_SOURCE: "",
        NB_SOURCE_AUTH_HEADER_FILE: "",
        // The artifact store in these tests is a server on loopback, which is plain http.
        NB_ALLOW_HTTP: "1",
        ...env,
      },
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, out });
    });
  });
}

/** Source the library and run a snippet in bash; returns trimmed stdout and the status. */
function sh(
  snippet: string,
  opts: { home?: string; input?: string; env?: Record<string, string> } = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bash", ["-c", `. "${BIN}/nb-common.sh"; ${snippet}`], {
    input: opts.input,
    encoding: "utf8",
    env: { ...process.env, NB_HOME: opts.home ?? tmp("shhome"), ...opts.env },
  });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

/**
 * Real dataset documents for the loader to move around: Neurobagel's own example JSON-LD with its
 * dataset identifier and label rewritten per id, so that every file is a valid, distinct dataset
 * (the stock validator and the loader's own structure check both accept them) without any
 * invented content. `variant` changes the bytes of every file, standing in for a dataset that
 * was regenerated.
 */
function makeSource(dir: string, ids: string[], variant = "a", extra: string[] = []): void {
  mkdirSync(dir, { recursive: true });
  const base = JSON.parse(readFileSync(EXAMPLE, "utf8"));
  for (const id of ids) {
    const doc = { ...base };
    const h = sha256(`${id}:${variant}`);
    doc.identifier = `nb:${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
    doc.hasLabel = `${id} (${variant})`;
    writeFileSync(join(dir, `${id}.jsonld`), `${JSON.stringify(doc)}\n`);
  }
  for (const f of extra) writeFileSync(join(dir, f), `{"note":"${f}"}\n`);
  reindex(dir, "2026-10-02T03:00:00Z");
}

function reindex(dir: string, generatedAt: string): void {
  const r = spawnSync(join(DEPLOY, "tools/build-index.sh"), [dir, generatedAt], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`build-index failed: ${r.stderr}`);
}

const readIndex = (dir: string): ArtifactIndex =>
  JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
const writeIndex = (dir: string, idx: unknown) =>
  writeFileSync(join(dir, "index.json"), JSON.stringify(idx));

const currentRelease = (home: string): string | null => {
  const link = join(home, "data/current");
  return existsSync(link) ? readlinkSync(link).replace(/^releases\//, "") : null;
};
const releaseFiles = (home: string, name: string): string[] =>
  readdirSync(join(home, "data/releases", name)).sort();
const lastLoad = (home: string) =>
  JSON.parse(readFileSync(join(home, "state/last-load.json"), "utf8"));

/** A real HTTP server over a directory that records every request it answers. */
type Served = { path: string; headers: Record<string, string> };
function serve(
  dir: string,
  opts: {
    delayMs?: number;
    missing?: string[];
    corrupt?: string[];
    redirectIndexTo?: string;
    /** Answer every artifact (not the index) with a 302 to this base URL. */
    redirectArtifactsTo?: string;
    /** Serve /?token=...<name> as if the base URL carried a query string. */
    queryStyle?: boolean;
  } = {},
): { url: string; log: Served[]; stop: () => void } {
  const log: Served[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      let path = u.pathname.slice(1);
      if (opts.queryStyle && path === "" && u.search.startsWith("?token=")) {
        path = u.search.split("/")[1] ?? "";
      }
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      log.push({ path, headers });
      if (opts.redirectIndexTo && path === "index.json") {
        return new Response(null, { status: 302, headers: { location: opts.redirectIndexTo } });
      }
      if (opts.redirectArtifactsTo && path !== "index.json") {
        return new Response(null, {
          status: 302,
          headers: { location: `${opts.redirectArtifactsTo}/${path}` },
        });
      }
      if (opts.delayMs && path !== "index.json") await Bun.sleep(opts.delayMs);
      if (opts.missing?.includes(path)) return new Response("gone", { status: 404 });
      const file = Bun.file(join(dir, path));
      if (!path || !(await file.exists())) return new Response("not found", { status: 404 });
      if (opts.corrupt?.includes(path)) return new Response('{"truncated":');
      return new Response(file);
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, log, stop: () => server.stop(true) };
}

describe("shell hygiene", () => {
  test.skipIf(!haveShellcheck)(
    "every script is shellcheck-clean",
    () => {
      const files = [
        ...readdirSync(BIN).map((f) => join(BIN, f)),
        join(DEPLOY, "tools/build-index.sh"),
      ];
      // Everything except two info-level notes whose reports differ between shellcheck releases
      // and are intentional in these scripts: SC2015 (`A && B || C` used as a guard) and SC2317 (a
      // function reached through a trap). The notes that matter most, such as SC2086 on an
      // unquoted variable, stay on.
      const r = spawnSync(
        "shellcheck",
        ["--exclude=SC2015,SC2317", "-x", "-P", "SCRIPTDIR", "-s", "bash", ...files],
        { encoding: "utf8", timeout: 55_000 },
      );
      expect(r.stdout + r.stderr).toBe("");
      expect(r.status).toBe(0);
    },
    60_000,
  );

  test.skipIf(!haveLoaderTools)(
    "every script parses and prints its help without side effects",
    async () => {
      for (const s of [
        "nb-load",
        "nb-reload",
        "nb-backup",
        "nb-restore",
        "nb-guard",
        "nb-status",
        "nb-up",
        "nb-hold",
        "nb-rollback",
        "nb-cron-line",
        "nb-install",
        "nb",
      ]) {
        const home = newHome();
        const r = await run(s, ["--help"], home);
        expect(r.status, `${s} --help`).toBe(0);
        expect(r.out.length, s).toBeGreaterThan(40);
        expect(existsSync(join(home, "data")), s).toBe(false);
      }
    },
  );

  test("the library files are not executable, the commands are", () => {
    for (const lib of ["nb-common.sh", "nb-decide.sh"]) {
      expect(lstatSync(join(BIN, lib)).mode & 0o111, lib).toBe(0);
    }
    for (const cmd of readdirSync(BIN).filter((f) => !f.endsWith(".sh"))) {
      expect(lstatSync(join(BIN, cmd)).mode & 0o111, cmd).not.toBe(0);
    }
  });
});

describe("the public tree carries no host posture", () => {
  // This repository is public. Hosts, paths, crontabs and the neighbours of the node are
  // operations documentation, kept in the gated docs. The words are assembled from pieces so this
  // file does not match itself.
  const forbidden: Array<[string, RegExp]> = [
    ["a neighbouring service", new RegExp(["infis", "ical|um", "ami"].join(""), "i")],
    ["a host path under /opt", new RegExp(["/opt/", "nemar"].join(""))],
    ["a home directory", new RegExp(["/home/", "ya", "hya"].join(""))],
    ["the ssh alias", new RegExp(["ssh -[A-Za-z0-9 :.-]* ", "nemar", "ing"].join(""))],
    ["an operating system version", new RegExp(["Ubu", "ntu 2"].join(""))],
    [
      "a Docker or Compose version of the host",
      /\bDocker (version )?[0-9]+\.[0-9]+\.[0-9]+|\bCompose v?2\.[0-9]+\.[0-9]+/,
    ],
    ["a crontab listing", new RegExp(["crontab ", "-l"].join(""))],
    ["the host's CPU and memory", /\b[0-9]+ CPUs\b|GiB of RAM/],
    ["an ssh command to a literal host", /^[ \t]*(?:\$ )?ssh\s|`ssh\s+[^`]*`/m],
    [
      "a figure for another container's memory",
      /\b[0-9][0-9,.]*\s?(?:MiB|GiB|MB|GB)\b[^|\n]{0,30}\((?:no|none|unlimited)[^)]*\)|\|\s*[0-9.]+%\s*\|\s*[0-9][0-9,.]*\s?(?:MiB|GiB)|\b(?:neighbou?rs?|siblings?|other (?:containers?|projects?|services?)|existing containers?)\b[^.\n]{0,80}\b[0-9][0-9,.]*\s?(?:MiB|GiB|MB|GB)\b/i,
    ],
    [
      "a remark that something has no limit",
      /\bno (?:memory )?limits?\b|\bwithout (?:a )?(?:memory )?limits?\b|\bunlimited memory\b/i,
    ],
    [
      "a remark that a secret is visible to other processes",
      /\b(?:password|credential|secret|token)s?\b[^.\n]{0,60}\b(?:visible|shown|exposed|readable)\b[^.\n]{0,60}\bprocess|\bcan list (?:the )?processes\b|\bvisible in a process\b/i,
    ],
    ["a secrets store", /\bsecrets? (?:store|manager|vault)\b/i],
  ];
  function files(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...files(p));
      else out.push(p);
    }
    return out;
  }
  // Lines a careless edit could add, built from pieces so that this file states no host fact. The
  // scan must flag every one by the pattern named for it, and none of the sentences the docs really
  // contain: a scan that cannot fail, or that fails on the docs, is no scan.
  const planted: Array<[string, string]> = [
    ["an ssh command to a literal host", ["ssh ", "somehost"].join("")],
    ["an ssh command to a literal host", ["    ssh -L 1:127.0.0.1:1 ", "somehost"].join("")],
    ["an ssh command to a literal host", ["run `ssh ", "somehost` and look"].join("")],
    ["a figure for another container's memory", "| svc-one | 0.6% | 123 MiB | none |"],
    [
      "a figure for another container's memory",
      "svc-one uses 123 MiB (no limit) and svc-two 45 MiB",
    ],
    ["a figure for another container's memory", "the other container peaks at 123 MiB"],
    ["a remark that something has no limit", "the neighbour's backend has no memory limit"],
    ["a remark that something has no limit", "it runs without a limit"],
    [
      "a remark that a secret is visible to other processes",
      "the password is visible in a process listing",
    ],
    [
      "a remark that a secret is visible to other processes",
      "only the host's administrators can list processes",
    ],
    ["a secrets store", "the organisation's secrets store"],
  ];
  const legitimate = [
    "so the token never appears in a process listing, a log or a state file",
    "forward local ports to the same ports on the loopback with an ssh tunnel, then open the tool",
    "Every container has `mem_limit` equal to `memswap_limit` (no swap), a CPU limit and a pids limit",
    "| `graph` | 2048 MiB (heap 1.5 GiB) | 2.0 | Peak 1.9 GiB at 50,105 subjects |",
    "the host also runs other long-lived services, so the node runs under hard limits",
    "The archive contains the GraphDB passwords: copy it only to a credential store",
  ];
  test("the patterns flag the lines they exist for, and none of the docs' own sentences", () => {
    for (const [what, line] of planted) {
      const re = forbidden.find(([w]) => w === what)?.[1];
      expect(re, what).toBeDefined();
      expect(re?.test(line), `${what}: ${line}`).toBe(true);
    }
    for (const line of legitimate) {
      for (const [what, re] of forbidden) expect(re.test(line), `${what}: ${line}`).toBe(false);
    }
  });

  test("deploy/neurobagel, its fixtures and ADR 0082", () => {
    const candidates = [
      ...files(DEPLOY),
      ...files(FIX),
      ...files(join(ROOT, ".context/decisions")).filter((f) => f.includes("0082-")),
    ];
    const hits: string[] = [];
    for (const f of candidates) {
      const text = readFileSync(f, "utf8");
      for (const [what, re] of forbidden) {
        if (re.test(text)) hits.push(`${f.slice(ROOT.length + 1)}: ${what}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("pins and the settings template", () => {
  const pins = readFileSync(join(DEPLOY, "pins.env"), "utf8");
  const get = (k: string) => pins.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "";

  test("every image is pinned by tag and by digest", () => {
    for (const k of ["NB_NAPI_TAG", "NB_FAPI_TAG", "NB_QUERY_TAG"]) {
      expect(get(k), k).toMatch(/^v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
    }
    for (const k of ["NB_GRAPHDB_IMAGE", "NB_CLOUDFLARED_IMAGE"]) {
      expect(get(k), k).toMatch(/^[a-z0-9/.-]+:[0-9][0-9.]*@sha256:[0-9a-f]{64}$/);
    }
  });

  test("the validator's memory limit is one number in the loader, the overlay and the template", () => {
    const overlay = readFileSync(join(DEPLOY, "docker-compose.nemar.yml"), "utf8");
    const env = readFileSync(join(DEPLOY, ".env.example"), "utf8");
    const loader = readFileSync(join(BIN, "nb-load"), "utf8");
    expect(env).toMatch(/^NB_INIT_MEM_LIMIT=160m$/m);
    expect(overlay).toContain("${NB_INIT_MEM_LIMIT:-160m}");
    expect(loader).toContain("nb_env_get NB_INIT_MEM_LIMIT 160m");
  });

  test("the caps, the loader's time budget and the guard settings are the same in the loader, the template and the README", () => {
    const env = readFileSync(join(DEPLOY, ".env.example"), "utf8");
    const loader = readFileSync(join(BIN, "nb-load"), "utf8");
    const readme = readFileSync(join(DEPLOY, "README.md"), "utf8");
    for (const [key, value] of [
      ["NB_MAX_ARTIFACT_BYTES", 6 * 1024 * 1024],
      ["NB_MAX_TOTAL_BYTES", 192 * 1024 * 1024],
      ["NB_LOAD_BUDGET_S", 900],
    ] as const) {
      expect(env, key).toMatch(new RegExp(`^${key}=${value}$`, "m"));
      expect(loader, key).toContain(`nb_env_get ${key} ${value}`);
      expect(readme, key).toContain(key);
    }
    expect(env).toMatch(/^NB_GUARD_EXPECTED=1$/m);
    expect(env).toMatch(/^NB_GUARD_BOOT_SETTLE_S=180$/m);
    expect(readFileSync(join(BIN, "nb-status"), "utf8")).toContain("NB_GUARD_EXPECTED 1");
    expect(readFileSync(join(BIN, "nb-guard"), "utf8")).toContain("NB_GUARD_BOOT_SETTLE_S 180");
    for (const quoted of ["192 MiB", "6 MiB", "160 MiB", "3040 MiB", "2912 MiB"]) {
      expect(readme, quoted).toContain(quoted);
    }
  });

  test("recipes is pinned to a tag and a full commit hash", () => {
    expect(get("NB_RECIPES_TAG")).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(get("NB_RECIPES_COMMIT")).toMatch(/^[0-9a-f]{40}$/);
  });

  test("the .env template holds placeholders only and states the record rules", () => {
    const env = readFileSync(join(DEPLOY, ".env.example"), "utf8");
    expect(env).toContain("@NB_HOME@");
    expect(env).toMatch(/^NB_TUNNEL_TOKEN=$/m);
    expect(env).toMatch(/^NB_RETURN_AGG=true$/m);
    expect(env).toMatch(/^NB_MIN_CELL_SIZE=0$/m);
    expect(env).toMatch(/^NB_BACKUP_HOOK=$/m);
    expect(env).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/); // a pasted connector token
    expect(env).not.toMatch(/PASSWORD=.+/);
  });
});

describe("the index format has one source of truth", () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);

  function readmeExample(): unknown {
    const readme = readFileSync(join(DEPLOY, "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("## Artifact store interface"));
    const m = section.match(/```json\n([\s\S]*?)\n```/);
    if (!m) throw new Error("README has no JSON example under the artifact store interface");
    return JSON.parse(m[1]);
  }

  test("the README example is a valid index with full-length hashes", () => {
    const example = readmeExample() as ArtifactIndex;
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    for (const d of example.datasets) {
      for (const a of d.artifacts) expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test.skipIf(!haveLoaderTools)("tools/build-index.sh writes what the schema accepts", () => {
    const dir = tmp("idx");
    makeSource(dir, ["nm000001", "nm000002"], "a", [
      "nm000001_annotated.json",
      "nm000001_dataset_description.json",
    ]);
    const idx = readIndex(dir);
    expect(validate(idx), JSON.stringify(validate.errors)).toBe(true);
    expect(idx.datasets[0].fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(idx.schema).toBe(schema.properties.schema.const);
  });

  test.skipIf(!haveLoaderTools)(
    "the synthetic generator writes what the schema accepts, in the same fingerprint form",
    () => {
      const out = tmp("gen");
      generatorMain([
        "--context-from",
        EXAMPLE,
        "--out",
        out,
        "--datasets",
        "3",
        "--subjects",
        "2-4",
        "--index",
      ]);
      const idx = readIndex(out);
      expect(validate(idx), JSON.stringify(validate.errors)).toBe(true);
      expect(idx.datasets).toHaveLength(3);
      // The two producers agree on what a fingerprint is: sha256 of the artifacts' own hashes.
      const dir = tmp("same");
      cpSync(join(out, "sy000001.jsonld"), join(dir, "sy000001.jsonld"));
      reindex(dir, "2026-10-02T00:00:00Z");
      expect(readIndex(dir).datasets[0].fingerprint).toBe(idx.datasets[0].fingerprint);
    },
  );

  test("the generator refuses what it cannot generate, and is importable", () => {
    const base = ["--out", "x", "--context-from", "y"];
    expect(() => parseOptions([...base, "--datasets", "abc", "--subjects", "3"])).toThrow(
      /--datasets must be a positive whole number/,
    );
    expect(() => parseOptions([...base, "--datasets", "2", "--subjects", "9-3"])).toThrow(
      /MAX must not be below MIN/,
    );
    expect(() =>
      parseOptions([...base, "--datasets", "2", "--subjects", "3", "--profile", "huge"]),
    ).toThrow(/--profile/);
    const r = spawnSync(
      process.execPath,
      [
        join(DEPLOY, "tools/gen-synthetic-jsonld.ts"),
        "--out",
        tmp("g"),
        "--datasets",
        "abc",
        "--subjects",
        "3",
        "--context-from",
        EXAMPLE,
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--datasets must be a positive whole number");
    const opts = parseOptions([...base, "--datasets", "1", "--subjects", "2"]);
    const ctx = (JSON.parse(readFileSync(EXAMPLE, "utf8")) as { "@context": unknown })["@context"];
    const a = generateDataset(opts, 1, ctx);
    expect(generateDataset(opts, 1, ctx).body).toBe(a.body); // deterministic
    expect(validate(buildIndex([indexEntry(a.id, a.body)], "2026-10-02T00:00:00Z"))).toBe(true);
  });

  // Each of these is wrong in a way the schema can express, so the schema AND the loader must
  // both refuse it. If the loader's jq check and the schema ever drift apart, one says yes.
  const expressible: Array<[string, (i: ArtifactIndex) => void]> = [
    [
      "the wrong schema string",
      (i) => {
        i.schema = "something-else/1";
      },
    ],
    [
      "no generated_at",
      (i) => {
        (i as { generated_at?: string }).generated_at = undefined;
      },
    ],
    [
      "a generated_at that is not a UTC timestamp",
      (i) => {
        i.generated_at = "yesterday";
      },
    ],
    [
      "an id that starts with a dash",
      (i) => {
        i.datasets[0].id = "-bad";
      },
    ],
    [
      "an id containing two dots",
      (i) => {
        i.datasets[0].id = "a..b";
      },
    ],
    [
      "an id that is too long",
      (i) => {
        i.datasets[0].id = "a".repeat(65);
      },
    ],
    [
      "a fingerprint that is not sha256:<hex>",
      (i) => {
        i.datasets[0].fingerprint = "v1";
      },
    ],
    [
      "an empty fingerprint",
      (i) => {
        i.datasets[0].fingerprint = "";
      },
    ],
    [
      "an artifact name with a path",
      (i) => {
        i.datasets[0].artifacts[0].name = "../escape.jsonld";
      },
    ],
    [
      "an artifact name with two dots inside",
      (i) => {
        i.datasets[0].artifacts[0].name = "a..b.jsonld";
      },
    ],
    [
      "an unknown kind",
      (i) => {
        i.datasets[0].artifacts[0].kind = "report";
      },
    ],
    [
      "an upper-case sha256",
      (i) => {
        i.datasets[0].artifacts[0].sha256 = i.datasets[0].artifacts[0].sha256.toUpperCase();
      },
    ],
    [
      "a short sha256",
      (i) => {
        i.datasets[0].artifacts[0].sha256 = "abc";
      },
    ],
    [
      "a missing sha256",
      (i) => {
        (i.datasets[0].artifacts[0] as { sha256?: string }).sha256 = undefined;
      },
    ],
    [
      "zero bytes",
      (i) => {
        i.datasets[0].artifacts[0].bytes = 0;
      },
    ],
    [
      "fractional bytes",
      (i) => {
        i.datasets[0].artifacts[0].bytes = 1.5;
      },
    ],
    [
      "no artifacts",
      (i) => {
        i.datasets[0].artifacts = [];
      },
    ],
    [
      "four artifacts",
      (i) => {
        const a = i.datasets[0].artifacts[0];
        i.datasets[0].artifacts = [a, a, a, a];
      },
    ],
    [
      "more datasets than the cap",
      (i) => {
        i.datasets = Array.from({ length: 5001 }, (_, n) => ({ ...i.datasets[0], id: `x${n}` }));
      },
    ],
  ];
  test.skipIf(!haveLoaderTools).each(expressible)(
    "the schema and the loader both refuse %s",
    async (_name, mutate) => {
      const dir = tmp("src");
      makeSource(dir, ["nm000001", "nm000002"]);
      const idx = readIndex(dir);
      mutate(idx);
      expect(validate(idx), "the schema should refuse it").toBe(false);
      writeIndex(dir, idx);
      const home = newHome();
      const r = await run("nb-load", ["--source", dir], home);
      expect(r.status, r.out).toBe(3);
      expect(r.out).toContain("does not satisfy");
      expect(existsSync(join(home, "data/current"))).toBe(false);
    },
  );

  // These the schema cannot express (they relate fields to one another), so the schema accepts
  // them and the loader alone refuses them. They are listed in the schema under x-rules.
  const crossField: Array<[string, (i: ArtifactIndex) => void]> = [
    [
      "an artifact name that is not the id plus its suffix",
      (i) => {
        i.datasets[0].artifacts[0].name = "other.jsonld";
      },
    ],
    [
      "a dataset with no jsonld artifact",
      (i) => {
        i.datasets[0].artifacts[0].kind = "dictionary";
      },
    ],
    [
      "two datasets with the same id",
      (i) => {
        i.datasets[1].id = i.datasets[0].id;
      },
    ],
    [
      "two artifacts with the same name across the index",
      (i) => {
        i.datasets[1].artifacts[0].name = i.datasets[0].artifacts[0].name;
      },
    ],
  ];
  test.skipIf(!haveLoaderTools).each(crossField)(
    "only the loader refuses %s",
    async (_name, mutate) => {
      const dir = tmp("src");
      makeSource(dir, ["nm000001", "nm000002"]);
      const idx = readIndex(dir);
      mutate(idx);
      expect(validate(idx), "a schema cannot say this").toBe(true);
      writeIndex(dir, idx);
      const r = await run("nb-load", ["--source", dir], newHome());
      expect(r.status, r.out).toBe(3);
      expect(r.out).toContain("does not satisfy");
    },
  );

  test.skipIf(!haveLoaderTools)(
    "unknown fields at every level are ignored, by the schema and by the loader",
    async () => {
      const dir = tmp("src");
      makeSource(dir, ["nm000001"]);
      const idx = readIndex(dir) as ArtifactIndex & Record<string, unknown>;
      idx.producer = { name: "writer", version: 3 };
      (idx.datasets[0] as unknown as Record<string, unknown>).note = "extra";
      (idx.datasets[0].artifacts[0] as unknown as Record<string, unknown>).etag = "abc";
      expect(validate(idx)).toBe(true);
      writeIndex(dir, idx);
      const home = newHome();
      const r = await run("nb-load", ["--source", dir], home);
      expect(r.status, r.out).toBe(0);
      expect(currentRelease(home)).not.toBeNull();
    },
  );

  test.skipIf(!haveLoaderTools)(
    "exactly the maximum number of datasets passes the index check",
    async () => {
      const dir = tmp("src");
      makeSource(dir, ["nm000001"]);
      const idx = readIndex(dir);
      const first = idx.datasets[0];
      idx.datasets = Array.from({ length: 5000 }, (_, n) => ({
        ...first,
        id: `x${n}`,
        artifacts: [{ ...first.artifacts[0], name: `x${n}.jsonld` }],
      }));
      expect(validate(idx)).toBe(true);
      writeIndex(dir, idx);
      const r = await run("nb-load", ["--source", dir], newHome());
      // The index is accepted; the run then stops because the artifacts are not in the source.
      expect(r.status, r.out).toBe(3);
      expect(r.out).toContain("download failed");
      expect(r.out).not.toContain("does not satisfy");
    },
  );
});

describe.skipIf(!haveLoaderTools)("the loader, on a directory source", () => {
  test("first load builds a complete verified release and swaps data/current to it", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001", "nm000002", "nm000003"], "a", [
      "nm000001_annotated.json",
      "nm000001_dataset_description.json",
    ]);
    const r = await run("nb-load", ["--source", src], home);
    expect(r.status, r.out).toBe(0);
    const rel = currentRelease(home);
    expect(rel).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
    expect(releaseFiles(home, rel as string)).toEqual([
      "nm000001.jsonld",
      "nm000001_annotated.json",
      "nm000001_dataset_description.json",
      "nm000002.jsonld",
      "nm000003.jsonld",
    ]);
    // Every byte in the release is the byte the index promised.
    for (const d of readIndex(src).datasets) {
      for (const a of d.artifacts) {
        const got = sha256(readFileSync(join(home, "data/releases", rel as string, a.name)));
        expect(got, a.name).toBe(a.sha256);
      }
    }
    const manifest = JSON.parse(readFileSync(join(home, `data/manifests/${rel}.json`), "utf8"));
    expect(manifest.counts).toEqual({ datasets: 3, artifacts: 5, bytes: expect.any(Number) });
    expect(readFileSync(join(home, "state/pending-reload"), "utf8").trim()).toBe(rel as string);
    expect(lastLoad(home)).toMatchObject({ outcome: "staged", datasets: 3, added: 3, fetched: 5 });
    // Nothing is left behind in the data directory but the release area.
    expect(readdirSync(join(home, "data")).sort()).toEqual(["current", "manifests", "releases"]);
  });

  test("a second run with nothing changed makes no new release and fetches nothing", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001", "nm000002"]);
    expect((await run("nb-load", ["--source", src], home)).status).toBe(0);
    const first = currentRelease(home);
    // The first run wrote the marker. Put an old one in its place, so that only the idle run below
    // can have refreshed it: without this the assertion is satisfied by the first run.
    writeFileSync(join(home, "state/last-load-ok"), "1\n");
    const server = serve(src);
    const r = await run("nb-load", ["--source", server.url], home);
    expect(r.status, r.out).toBe(0);
    expect(currentRelease(home)).toBe(first);
    expect(readdirSync(join(home, "data/releases"))).toHaveLength(1);
    expect(lastLoad(home).outcome).toBe("unchanged");
    expect(server.log.map((l) => l.path)).toEqual(["index.json"]);
    // A run that found nothing to do still counts as a good run, for the stale-loader alarm: an idle
    // node must not raise a false "no successful loader run" alarm.
    expect(Number(readFileSync(join(home, "state/last-load-ok"), "utf8"))).toBeGreaterThan(
      1_700_000_000,
    );
  });

  test("a changed dataset is the only file fetched; unchanged files are reused", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001", "nm000002", "nm000003"], "a");
    expect((await run("nb-load", ["--source", src], home)).status).toBe(0);
    const before = currentRelease(home);
    // Regenerate one dataset only.
    const next = tmp("src2");
    cpSync(src, next, { recursive: true });
    const changed = tmp("one");
    makeSource(changed, ["nm000002"], "b");
    cpSync(join(changed, "nm000002.jsonld"), join(next, "nm000002.jsonld"));
    reindex(next, "2026-10-02T04:00:00Z");
    const server = serve(next);
    const r = await run("nb-load", ["--source", server.url], home);
    expect(r.status, r.out).toBe(0);
    expect(currentRelease(home)).not.toBe(before);
    expect(server.log.map((l) => l.path).sort()).toEqual(["index.json", "nm000002.jsonld"]);
    expect(lastLoad(home)).toMatchObject({ outcome: "staged", changed: 1, fetched: 1, reused: 2 });
    const rel = currentRelease(home) as string;
    expect(sha256(readFileSync(join(home, "data/releases", rel, "nm000002.jsonld")))).toBe(
      sha256(readFileSync(join(next, "nm000002.jsonld"))),
    );
    // The previous release is intact and still on disk for rollback.
    expect(releaseFiles(home, before as string)).toHaveLength(3);
    expect(readFileSync(join(home, "state/rollback-to"), "utf8").trim()).toBe(before as string);
  });

  test("a dataset that leaves the index leaves the next release", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001", "nm000002", "nm000003"]);
    expect((await run("nb-load", ["--source", src], home)).status).toBe(0);
    rmSync(join(src, "nm000003.jsonld"));
    reindex(src, "2026-10-02T05:00:00Z");
    const r = await run("nb-load", ["--source", src], home);
    expect(r.status, r.out).toBe(0);
    expect(releaseFiles(home, currentRelease(home) as string)).toEqual([
      "nm000001.jsonld",
      "nm000002.jsonld",
    ]);
    expect(lastLoad(home)).toMatchObject({ removed: 1 });
  });

  test("a sha256 mismatch aborts, leaves live data exactly as it was, and leaves no residue", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001", "nm000002"], "a");
    expect((await run("nb-load", ["--source", src], home)).status).toBe(0);
    const before = currentRelease(home);
    // The index promises regenerated content (variant b); the file on offer is the same length
    // but different bytes, so only the hash can tell.
    const bad = tmp("bad");
    makeSource(bad, ["nm000001", "nm000002"], "b");
    const promised = readFileSync(join(bad, "nm000002.jsonld"), "utf8");
    const tampered = promised.replace('"nm000002 (b)"', '"nm000002 (c)"');
    expect(tampered.length).toBe(promised.length);
    expect(tampered).not.toBe(promised);
    writeFileSync(join(bad, "nm000002.jsonld"), tampered);
    const r = await run("nb-load", ["--source", bad], home);
    expect(r.status, r.out).toBe(3);
    expect(r.out).toContain("sha256 mismatch");
    expect(currentRelease(home)).toBe(before);
    expect(readdirSync(join(home, "data/releases"))).toEqual([before as string]);
    expect(readdirSync(join(home, "data")).filter((f) => f.startsWith(".stage"))).toEqual([]);
    expect(lastLoad(home).outcome).toBe("source-failed");
  });

  test("a missing artifact and a truncated download are source failures, not partial releases", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001", "nm000002"], "a");
    expect((await run("nb-load", ["--source", src], home)).status).toBe(0);
    const before = currentRelease(home);
    const next = tmp("src2");
    makeSource(next, ["nm000001", "nm000002", "nm000003"], "a");
    for (const opts of [{ missing: ["nm000003.jsonld"] }, { corrupt: ["nm000003.jsonld"] }]) {
      const server = serve(next, opts);
      const r = await run("nb-load", ["--source", server.url], home, { NB_FETCH_TIMEOUT_S: "20" });
      expect(r.status, r.out).toBe(3);
      expect(currentRelease(home)).toBe(before);
      expect(readdirSync(join(home, "data/releases"))).toEqual([before as string]);
      expect(lastLoad(home).outcome).toBe("source-failed");
    }
  });

  test("an index that is not JSON, and an empty index, are refused", async () => {
    const home = newHome();
    const src = tmp("src");
    writeFileSync(join(src, "index.json"), "{not json");
    expect((await run("nb-load", ["--source", src], home)).status).toBe(3);
    writeIndex(src, {
      schema: schema.properties.schema.const,
      generated_at: "2026-10-02T00:00:00Z",
      datasets: [],
    });
    const r = await run("nb-load", ["--source", src], home);
    expect(r.status, r.out).toBe(3);
    expect(r.out).toContain("zero datasets");
  });

  test("a hostile artifact name cannot reach outside the release: the file is planted, and nothing moves", async () => {
    const home = newHome();
    const base = tmp("hostile");
    const src = join(base, "src");
    makeSource(src, ["victim"]);
    // A file OUTSIDE the source directory, whose hash and size the index states correctly. If the
    // loader ever followed the name, it would copy this in.
    const planted = `${JSON.stringify({ planted: true })}\n`;
    writeFileSync(join(base, "escape.jsonld"), planted);
    const idx = readIndex(src);
    idx.datasets[0].artifacts[0] = {
      name: "../escape.jsonld",
      kind: "jsonld",
      sha256: sha256(planted),
      bytes: Buffer.byteLength(planted),
    };
    writeIndex(src, idx);
    const before = new Set(readdirSync(base));
    const r = await run("nb-load", ["--source", src], home);
    expect(r.status, r.out).toBe(3);
    expect(r.out).toContain("does not satisfy");
    expect(existsSync(join(home, "data/current"))).toBe(false);
    expect(readFileSync(join(base, "escape.jsonld"), "utf8")).toBe(planted);
    expect(new Set(readdirSync(base))).toEqual(before);
    expect(
      readdirSync(join(home, "data")).filter((f) => f !== "releases" && f !== "manifests"),
    ).toEqual([]);
  });

  test("a dotted name is refused even when the id is innocent", async () => {
    // id "nm000001." plus ".jsonld" is "nm000001..jsonld": the id passes its own rule and only the
    // artifact-name rule can stop it.
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    writeFileSync(join(src, "nm000001..jsonld"), readFileSync(join(src, "nm000001.jsonld")));
    const idx = readIndex(src);
    idx.datasets[0].id = "nm000001.";
    idx.datasets[0].artifacts[0].name = "nm000001..jsonld";
    writeIndex(src, idx);
    const r = await run("nb-load", ["--source", src], newHome());
    expect(r.status, r.out).toBe(3);
    expect(r.out).toContain("does not satisfy");
  });

  test("a dataset document that is not a Neurobagel dataset is refused before publication", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    const doc = JSON.parse(readFileSync(join(src, "nm000001.jsonld"), "utf8"));
    doc.hasSamples = [];
    writeFileSync(join(src, "nm000001.jsonld"), JSON.stringify(doc));
    reindex(src, "2026-10-02T03:00:00Z");
    const r = await run("nb-load", ["--source", src], home);
    expect(r.status, r.out).toBe(4);
    expect(existsSync(join(home, "data/current"))).toBe(false);
  });

  test("two datasets with the same identifier are refused (the stock initialiser would keep one)", async () => {
    const src = tmp("src");
    makeSource(src, ["nm000001", "nm000002"]);
    const a = JSON.parse(readFileSync(join(src, "nm000001.jsonld"), "utf8"));
    const b = JSON.parse(readFileSync(join(src, "nm000002.jsonld"), "utf8"));
    b.identifier = a.identifier;
    writeFileSync(join(src, "nm000002.jsonld"), JSON.stringify(b));
    reindex(src, "2026-10-02T03:00:00Z");
    const r = await run("nb-load", ["--source", src], newHome());
    expect(r.status, r.out).toBe(4);
    expect(r.out).toContain("duplicate dataset identifier");
  });

  test("mass removal: refused past half of at least ten datasets, allowed at half and below ten", async () => {
    const home = newHome();
    const src = tmp("src");
    const ids = Array.from({ length: 10 }, (_, i) => `nm0000${String(i + 10)}`);
    makeSource(src, ids);
    expect((await run("nb-load", ["--source", src], home)).status).toBe(0);
    const before = currentRelease(home);
    const four = tmp("four"); // drops 6 of 10: more than half
    makeSource(four, ids.slice(0, 4));
    const refused = await run("nb-load", ["--source", four], home);
    expect(refused.status, refused.out).toBe(3);
    expect(refused.out).toContain("--allow-mass-removal");
    expect(currentRelease(home)).toBe(before);
    const five = tmp("five"); // drops exactly 5 of 10: half is allowed
    makeSource(five, ids.slice(0, 5));
    const atHalf = await run("nb-load", ["--source", five], home);
    expect(atHalf.status, atHalf.out).toBe(0);
    expect(releaseFiles(home, currentRelease(home) as string)).toHaveLength(5);

    // Below ten datasets the rule does not apply at all: 9 down to 1 is accepted.
    const home9 = newHome();
    const nine = tmp("nine");
    makeSource(nine, ids.slice(0, 9));
    expect((await run("nb-load", ["--source", nine], home9)).status).toBe(0);
    const one = tmp("one");
    makeSource(one, ids.slice(0, 1));
    const small = await run("nb-load", ["--source", one], home9);
    expect(small.status, small.out).toBe(0);

    // And past half it is accepted when asked for.
    const home10 = newHome();
    expect((await run("nb-load", ["--source", src], home10)).status).toBe(0);
    const forced = await run("nb-load", ["--source", four, "--allow-mass-removal"], home10);
    expect(forced.status, forced.out).toBe(0);
  });

  test("--dry-run prints the plan and changes nothing", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001", "nm000002"]);
    const r = await run("nb-load", ["--source", src, "--dry-run"], home);
    expect(r.status, r.out).toBe(0);
    const plan = JSON.parse(r.out.slice(r.out.indexOf("{")));
    expect(plan.plan.added).toEqual(["nm000001", "nm000002"]);
    expect(existsSync(join(home, "data/current"))).toBe(false);
    expect(existsSync(join(home, "state/last-load.json"))).toBe(false);
  });

  test("the auth header file is sent, and the token never appears in the loader's output", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    const token = "Bearer test-token-0123456789-abcdef";
    const hdr = join(home, "auth-header");
    writeFileSync(hdr, `Authorization: ${token}\n`, { mode: 0o600 });
    const server = serve(src);
    const r = await run("nb-load", ["--source", server.url], home, {
      NB_SOURCE_AUTH_HEADER_FILE: hdr,
    });
    expect(r.status, r.out).toBe(0);
    expect(server.log.length).toBeGreaterThan(1);
    for (const l of server.log) {
      expect(l.headers.authorization, l.path).toBe(token);
      expect(l.headers["user-agent"]).toContain("nemar-neurobagel-loader");
    }
    expect(r.out).not.toContain("test-token");
    expect(readFileSync(join(home, "state/last-load.json"), "utf8")).not.toContain("test-token");
    expect(lastLoad(home).warnings).toEqual([]); // mode 600: nothing to warn about
  });

  test("a header file other accounts can read is used, and the loader says it should be mode 600", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    const hdr = join(home, "auth-header");
    writeFileSync(hdr, "Authorization: Bearer x\n");
    chmodSync(hdr, 0o644);
    const server = serve(src);
    const r = await run("nb-load", ["--source", server.url], home, {
      NB_SOURCE_AUTH_HEADER_FILE: hdr,
    });
    expect(r.status, r.out).toBe(0);
    expect(lastLoad(home).warnings.join(" ")).toContain("mode 600");
  });
});

describe.skipIf(!haveLoaderTools)("what a source is allowed to be", () => {
  test("plain http is refused unless explicitly allowed", async () => {
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    const server = serve(src);
    const r = await run("nb-load", ["--source", server.url], newHome(), { NB_ALLOW_HTTP: "0" });
    expect(r.status, r.out).toBe(78);
    expect(r.out).toContain("must be https");
    expect(server.log).toHaveLength(0);
  });

  test("credentials in the source URL are refused and never echoed or recorded", async () => {
    const home = newHome();
    const r = await run(
      "nb-load",
      ["--source", "https://someone:hunter2@store.example/neurobagel"],
      home,
    );
    expect(r.status, r.out).toBe(78);
    expect(r.out).toContain("credentials");
    expect(r.out).not.toContain("hunter2");
    expect(existsSync(join(home, "state/last-load.json"))).toBe(false);
  });

  test("a redirect is refused, for the index and for an artifact, and nothing behind it is asked", async () => {
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    const target = serve(src);
    // The index redirects, to plain http and to a perfectly good copy of itself: both are refused.
    const first = serve(src, { redirectIndexTo: `${target.url}/index.json` });
    const r = await run("nb-load", ["--source", first.url], newHome());
    expect(r.status, r.out).toBe(3);
    expect(r.out).toContain("refused a redirect");
    expect(target.log).toHaveLength(0);
    // An artifact that redirects is refused the same way, with the header file in play: curl would
    // send a non-Authorization credential header on to the target.
    const hdr = join(tmp("hdr"), "header");
    writeFileSync(hdr, "X-Api-Key: not-a-secret\n", { mode: 0o600 });
    const second = serve(src, { redirectArtifactsTo: target.url });
    const r2 = await run("nb-load", ["--source", second.url], newHome(), {
      NB_SOURCE_AUTH_HEADER_FILE: hdr,
    });
    expect(r2.status, r2.out).toBe(3);
    expect(r2.out).toContain("refused a redirect");
    expect(target.log).toHaveLength(0);
    for (const l of target.log) expect(l.headers["x-api-key"]).toBeUndefined();
  });

  test("a query string in the source is never recorded", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    const server = serve(src, { queryStyle: true });
    const r = await run("nb-load", ["--source", `${server.url}/?token=sekrit`], home);
    expect(r.status, r.out).toBe(0);
    expect(lastLoad(home).source).toBe(`${server.url}/`);
    const rel = currentRelease(home);
    expect(readFileSync(join(home, `data/manifests/${rel}.json`), "utf8")).not.toContain("sekrit");
    expect(readFileSync(join(home, "state/last-load.json"), "utf8")).not.toContain("sekrit");
  });
});

describe.skipIf(!haveLoaderTools)("caps on what the source can make the host do", () => {
  test("the index size cap", async () => {
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    const size = readFileSync(join(src, "index.json")).length;
    const over = await run("nb-load", ["--source", src], newHome(), {
      NB_MAX_INDEX_BYTES: String(size - 1),
    });
    expect(over.status, over.out).toBe(3);
    const at = await run("nb-load", ["--source", src], newHome(), {
      NB_MAX_INDEX_BYTES: String(size),
    });
    expect(at.status, at.out).toBe(0);
  });

  test("the per-artifact cap, on a directory and on http, at the boundary", async () => {
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    const size = readFileSync(join(src, "nm000001.jsonld")).length;
    const server = serve(src);
    for (const source of [src, server.url]) {
      const refused = await run("nb-load", ["--source", source], newHome(), {
        NB_MAX_ARTIFACT_BYTES: String(size - 1),
      });
      expect(refused.status, `${source}: ${refused.out}`).toBe(3);
      const allowed = await run("nb-load", ["--source", source], newHome(), {
        NB_MAX_ARTIFACT_BYTES: String(size),
      });
      expect(allowed.status, `${source}: ${allowed.out}`).toBe(0);
    }
  });

  test("the total cap, from what the index promises and from what actually arrives", async () => {
    const src = tmp("src");
    makeSource(src, ["nm000001", "nm000002"]);
    const sizes = readIndex(src).datasets.map((d) => d.artifacts[0].bytes as number);
    const total = sizes[0] + sizes[1];
    // Over http, so that "before anything is downloaded" is observable: only the index is asked for.
    const server = serve(src);
    const promised = await run("nb-load", ["--source", server.url], newHome(), {
      NB_MAX_TOTAL_BYTES: String(total - 1),
    });
    expect(promised.status, promised.out).toBe(3);
    expect(promised.out).toContain("the index promises");
    expect(server.log.map((l) => l.path)).toEqual(["index.json"]);
    expect(
      (await run("nb-load", ["--source", src], newHome(), { NB_MAX_TOTAL_BYTES: String(total) }))
        .status,
    ).toBe(0);
    // An index that states no sizes cannot be checked up front; the running total catches it.
    const idx = readIndex(src);
    for (const d of idx.datasets) for (const a of d.artifacts) a.bytes = undefined;
    writeIndex(src, idx);
    const running = await run("nb-load", ["--source", src], newHome(), {
      NB_MAX_TOTAL_BYTES: String(total - 1),
    });
    expect(running.status, running.out).toBe(3);
    expect(running.out).toContain("add up to more than");
    expect(
      (await run("nb-load", ["--source", src], newHome(), { NB_MAX_TOTAL_BYTES: String(total) }))
        .status,
    ).toBe(0);
  });

  test("the free-disk floor refuses to stage anything and fetches nothing", async () => {
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    const server = serve(src);
    const home = newHome();
    const r = await run("nb-load", ["--source", server.url], home, {
      NB_MIN_FREE_DISK_MB: "999999999",
    });
    expect(r.status, r.out).toBe(8);
    expect(r.out).toContain("NB_MIN_FREE_DISK_MB");
    expect(server.log).toHaveLength(0);
    expect(existsSync(join(home, "data/current"))).toBe(false);
  });

  test("leftovers of a killed run are swept under the lock", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    mkdirSync(join(home, "data/.stage.dead01"), { recursive: true });
    writeFileSync(join(home, "data/.stage.dead01/part"), "half a download");
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "state/applied.json.tmp.4242"), "x");
    // A temp file of a writer that takes no lock (nb hold writes state/hold this way) may be
    // mid-write: only one that is more than a minute old is garbage.
    writeFileSync(join(home, "state/hold.tmp.4243"), "being written");
    const longAgo = new Date(Date.now() - 5 * 60_000);
    utimesSync(join(home, "state/applied.json.tmp.4242"), longAgo, longAgo);
    const r = await run("nb-load", ["--source", src], home);
    expect(r.status, r.out).toBe(0);
    expect(readdirSync(join(home, "data")).filter((f) => f.startsWith(".stage"))).toEqual([]);
    expect(existsSync(join(home, "state/applied.json.tmp.4242"))).toBe(false);
    expect(existsSync(join(home, "state/hold.tmp.4243"))).toBe(true);
  });
});

describe.skipIf(!haveLoaderTools)("each index rule fires on its own", () => {
  const SCHEMA_STRING: string = schema.properties.schema.const;
  const MIB = 1024 * 1024;

  /** Valid in every respect and needing no files: --dry-run reads the index and nothing else. */
  function validIndex(n: number): ArtifactIndex {
    const datasets: IndexDataset[] = [];
    for (let i = 0; i < n; i++) {
      const id = `x${String(i).padStart(5, "0")}`;
      const sha = sha256(id);
      datasets.push({
        id,
        fingerprint: `sha256:${sha}`,
        artifacts: [{ name: `${id}.jsonld`, kind: "jsonld", sha256: sha, bytes: 100 }],
      });
    }
    return { schema: SCHEMA_STRING, generated_at: "2026-10-02T03:00:00Z", datasets };
  }
  async function dryRun(idx: unknown, env: Record<string, string> = {}): Promise<Result> {
    const src = tmp("src");
    mkdirSync(src, { recursive: true });
    writeIndex(src, idx);
    return run("nb-load", ["--source", src, "--dry-run"], newHome(), env);
  }

  test("the dataset cap: exactly the cap passes, one more is refused, and only its sentence is printed", async () => {
    const cap: number = schema.properties.datasets.maxItems;
    const ok = await dryRun(validIndex(cap));
    expect(ok.status, ok.out.slice(0, 500)).toBe(0);
    const over = await dryRun(validIndex(cap + 1));
    expect(over.status, over.out.slice(-500)).toBe(3);
    expect(over.out).toContain(`more than ${cap} datasets`);
    expect(over.out.match(/index: /g)).toHaveLength(1);
  });

  test("the artifact cap: three artifacts pass, a fourth is refused and its sentence says so", async () => {
    const cap: number = schema.definitions.dataset.properties.artifacts.maxItems;
    const idx = validIndex(1);
    const d = idx.datasets[0];
    d.artifacts.push(
      { name: `${d.id}_annotated.json`, kind: "dictionary", sha256: sha256("d"), bytes: 10 },
      {
        name: `${d.id}_dataset_description.json`,
        kind: "description",
        sha256: sha256("e"),
        bytes: 10,
      },
    );
    expect(d.artifacts).toHaveLength(cap);
    const ok = await dryRun(idx);
    expect(ok.status, ok.out).toBe(0);
    d.artifacts.push({
      name: `${d.id}_annotated.json`,
      kind: "dictionary",
      sha256: sha256("f"),
      bytes: 10,
    });
    const r = await dryRun(idx);
    expect(r.status, r.out).toBe(3);
    expect(r.out).toContain(`more than ${cap} artifacts`);
  });

  // One mutation per rule. Each must be refused AND named by its own sentence, so that a rule that
  // stopped firing cannot hide behind the others that still do.
  const rules: Array<[string, string, (i: ArtifactIndex) => void]> = [
    [
      "the schema string",
      "schema is not",
      (i) => {
        i.schema = "other/1";
      },
    ],
    [
      "generated_at",
      "generated_at is missing",
      (i) => {
        i.generated_at = "yesterday";
      },
    ],
    [
      "an id",
      "is not allowed",
      (i) => {
        i.datasets[0].id = "-bad";
      },
    ],
    [
      "an id with a trailing newline",
      "is not allowed",
      (i) => {
        i.datasets[0].id = `${i.datasets[0].id}\n`;
      },
    ],
    [
      "a fingerprint",
      "fingerprint is not",
      (i) => {
        i.datasets[0].fingerprint = "md5:abc";
      },
    ],
    [
      "no artifacts",
      "no artifacts",
      (i) => {
        i.datasets[0].artifacts = [];
      },
    ],
    [
      "an artifact name with a path in it",
      "artifact name",
      (i) => {
        i.datasets[0].artifacts[0].name = "../x.jsonld";
      },
    ],
    [
      "an artifact name with a trailing newline",
      "artifact name",
      (i) => {
        i.datasets[0].artifacts[0].name = `${i.datasets[0].artifacts[0].name}\n`;
      },
    ],
    [
      "an artifact kind",
      "artifact kind",
      (i) => {
        i.datasets[0].artifacts[0].kind = "other";
      },
    ],
    [
      "a sha256",
      "has no valid sha256",
      (i) => {
        i.datasets[0].artifacts[0].sha256 = "abc";
      },
    ],
    [
      "a sha256 with a trailing newline",
      "has no valid sha256",
      (i) => {
        i.datasets[0].artifacts[0].sha256 = `${i.datasets[0].artifacts[0].sha256}\n`;
      },
    ],
    [
      "bytes of zero",
      "bytes is not a whole number",
      (i) => {
        i.datasets[0].artifacts[0].bytes = 0;
      },
    ],
    [
      "a name that is not the id plus its suffix",
      "is not the id plus the suffix",
      (i) => {
        i.datasets[0].artifacts[0].name = "other.jsonld";
      },
    ],
    [
      "no jsonld artifact",
      "needs exactly one jsonld",
      (i) => {
        i.datasets[0].artifacts[0].kind = "dictionary";
      },
    ],
    [
      "two datasets with one id",
      "dataset ids are not unique",
      (i) => {
        i.datasets.push(structuredClone(i.datasets[0]));
      },
    ],
    [
      "two artifacts with one name",
      "artifact names are not unique",
      (i) => {
        i.datasets.push(structuredClone(i.datasets[0]));
      },
    ],
  ];
  test.each(rules)(
    "%s is refused and its own sentence says why",
    async (_what, sentence, mutate) => {
      const idx = validIndex(2);
      mutate(idx);
      const r = await dryRun(idx);
      expect(r.status, r.out).toBe(3);
      expect(r.out).toContain("index: ");
      expect(r.out).toContain(sentence);
    },
  );

  test("the default total cap is 192 MiB: a promise at it passes, one byte over is refused", async () => {
    const at = validIndex(1);
    at.datasets[0].artifacts[0].bytes = 192 * MIB;
    expect((await dryRun(at)).status).toBe(0);
    const over = validIndex(1);
    over.datasets[0].artifacts[0].bytes = 192 * MIB + 1;
    const r = await dryRun(over);
    expect(r.status, r.out).toBe(3);
    expect(r.out).toContain("the index promises");
  });

  test("the default per-artifact cap is 6 MiB: a file of exactly that is fetched, one byte more is refused", async () => {
    const make = (size: number): string => {
      const src = tmp("src");
      mkdirSync(src, { recursive: true });
      const body = Buffer.alloc(size, "x");
      writeFileSync(join(src, "x00000.jsonld"), body);
      const idx = validIndex(1);
      idx.datasets[0].artifacts[0].sha256 = sha256(body);
      idx.datasets[0].artifacts[0].bytes = size;
      writeIndex(src, idx);
      return src;
    };
    // At the cap the file is accepted by the size rules and is then refused for what it is (not a
    // Neurobagel document: exit 4), which is how the two outcomes differ.
    const at = await run("nb-load", ["--source", make(6 * MIB)], newHome());
    expect(at.status, at.out.slice(-400)).toBe(4);
    const over = await run("nb-load", ["--source", make(6 * MIB + 1)], newHome());
    expect(over.status, over.out.slice(-400)).toBe(3);
    expect(over.out).toContain("unacceptable size");
  });
});

describe.skipIf(!haveLoaderTools)("what the loader refuses on its own", () => {
  test("a stated size that is not the file's size is refused although the hash is right", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    const idx = readIndex(src);
    idx.datasets[0].artifacts[0].bytes = (idx.datasets[0].artifacts[0].bytes as number) + 1;
    writeIndex(src, idx);
    const r = await run("nb-load", ["--source", src], home);
    expect(r.status, r.out).toBe(3);
    expect(r.out).toContain("the index says");
    expect(currentRelease(home)).toBeNull();
  });

  test("while the node is on hold the loader stages and publishes, and never reloads", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(
      join(home, "state/hold"),
      "2026-10-02T09:39:51Z by operator: a hold, as nb hold writes it\n",
    );
    // NB_RELOAD=1 asks for a reload; only the hold stands in its way.
    const r = await run("nb-load", ["--source", src], home, { NB_RELOAD: "1" });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("on hold");
    expect(lastLoad(home).outcome).toBe("staged");
    const release = currentRelease(home) as string;
    expect(release).toBeTruthy();
    expect(readFileSync(join(home, "state/pending-reload"), "utf8").trim()).toBe(release);
    expect(existsSync(join(home, "state/reload-history.jsonl"))).toBe(false);
  });

  test("the whole run has a time budget: a slow store ends it near the budget, retries included", async () => {
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    const server = serve(src, { delayMs: 20_000 });
    const t0 = Date.now();
    const r = await run("nb-load", ["--source", server.url], newHome(), {
      NB_LOAD_BUDGET_S: "3",
      NB_FETCH_TIMEOUT_S: "60",
    });
    const took = Date.now() - t0;
    expect(r.status, r.out).toBe(3);
    expect(r.out).toContain("time budget");
    expect(took).toBeLessThan(12_000);
  });

  test("a budget that is already spent fetches nothing at all", async () => {
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    const server = serve(src);
    const r = await run("nb-load", ["--source", server.url], newHome(), { NB_LOAD_BUDGET_S: "0" });
    expect(r.status, r.out).toBe(3);
    expect(r.out).toContain("time budget");
    expect(server.log).toHaveLength(0);
  });
});

describe.skipIf(!haveLoaderTools)("atomicity, the lock, freeze", () => {
  test("a reader that resolves data/current once always sees a complete, consistent release", async () => {
    const home = newHome();
    const src = tmp("src");
    const ids = Array.from({ length: 12 }, (_, i) => `nm0001${String(i).padStart(2, "0")}`);
    makeSource(src, ids, "a");
    expect((await run("nb-load", ["--source", src], home)).status).toBe(0);
    const next = tmp("src2");
    makeSource(next, ids, "b");
    const server = serve(next, { delayMs: 60 }); // the second load takes about a second

    let done = false;
    let reads = 0;
    let torn = 0;
    const seen = new Set<string>();
    const reader = (async () => {
      while (!done) {
        try {
          const rel = readlinkSync(join(home, "data/current")).replace(/^releases\//, "");
          const dir = join(home, "data/releases", rel);
          const files = readdirSync(dir).filter((f) => f.endsWith(".jsonld"));
          seen.add(rel);
          const manifest = JSON.parse(
            readFileSync(join(home, `data/manifests/${rel}.json`), "utf8"),
          );
          const complete = files.length === Object.keys(manifest.datasets).length;
          const intact = files.every((f) => {
            const id = f.replace(".jsonld", "");
            return sha256(readFileSync(join(dir, f))) === manifest.datasets[id].artifacts[f].sha256;
          });
          reads++;
          if (!complete || !intact) torn++;
        } catch {
          // The symlink is replaced by rename(2), so a missing link or manifest is a bug, not a race.
          torn++;
        }
        await Bun.sleep(1);
      }
    })();
    const child = spawn(join(BIN, "nb-load"), ["--source", server.url], {
      env: {
        ...process.env,
        NB_HOME: home,
        NB_VALIDATE: "jq",
        NB_RELOAD: "0",
        NB_SOURCE: "",
        NB_ALLOW_HTTP: "1",
      },
    });
    const code: number = await new Promise((res) => child.on("close", res));
    done = true;
    await reader;
    expect(code).toBe(0);
    expect(torn).toBe(0);
    expect(reads).toBeGreaterThan(20);
    expect(seen.size).toBe(2); // it observed both the old and the new release, never a half
  });

  test("the symlink swap is one rename: a tight reader never finds the link missing", async () => {
    // `ln -sfn` unlinks and then links, leaving a window in which the path does not exist. This
    // drives the real nb_atomic_symlink a thousand times while another process reads the link as
    // fast as it can; a single miss fails the test.
    const dir = tmp("swap");
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "b"));
    const link = join(dir, "current");
    symlinkSync("a", link);
    const reader = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require("fs");const link=process.env.LINK;const until=Date.now()+Number(process.env.MS);let n=0,bad=0;while(Date.now()<until){try{fs.readlinkSync(link)}catch{bad++}n++}console.log(JSON.stringify({n,bad}))`,
      ],
      { env: { ...process.env, LINK: link, MS: "6000" } },
    );
    let out = "";
    reader.stdout.on("data", (d) => {
      out += d;
    });
    const swapper = spawnSync(
      "bash",
      [
        "-c",
        `. "${BIN}/nb-common.sh"; for i in $(seq 1 1000); do if [ $((i % 2)) = 0 ]; then nb_atomic_symlink a "${link}"; else nb_atomic_symlink b "${link}"; fi; done`,
      ],
      { encoding: "utf8", env: { ...process.env, NB_HOME: tmp("h") } },
    );
    expect(swapper.status, swapper.stderr).toBe(0);
    await new Promise((res) => reader.on("close", res));
    const { n, bad } = JSON.parse(out.trim());
    expect(n).toBeGreaterThan(1000);
    expect(bad).toBe(0);
  });

  test("nb_write_atomic never installs an empty file over a good one", () => {
    const dir = tmp("w");
    const dest = join(dir, "state.json");
    writeFileSync(dest, '{"good":true}\n');
    const r = sh(`: | nb_write_atomic "${dest}"`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("refusing to install an empty");
    expect(readFileSync(dest, "utf8")).toBe('{"good":true}\n');
    expect(readdirSync(dir)).toEqual(["state.json"]); // no temp file left behind
    const ok = sh(`printf 'new\\n' | nb_write_atomic "${dest}"`);
    expect(ok.status).toBe(0);
    expect(readFileSync(dest, "utf8")).toBe("new\n");
  });

  test("two loaders at once: one runs, the other exits 75 and changes nothing", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001", "nm000002", "nm000003", "nm000004"]);
    const server = serve(src, { delayMs: 400 });
    const env = {
      ...process.env,
      NB_HOME: home,
      NB_VALIDATE: "jq",
      NB_RELOAD: "0",
      NB_SOURCE: "",
      NB_ALLOW_HTTP: "1",
    };
    const one = spawn(join(BIN, "nb-load"), ["--source", server.url], { env });
    await Bun.sleep(700); // the first holds the lock, mid-download
    const second = await run("nb-load", ["--source", server.url], home);
    const code: number = await new Promise((res) => one.on("close", res));
    expect(second.status, second.out).toBe(75);
    expect(second.out).toContain("another loader or reload is running");
    expect(second.out).toContain("nb-load"); // who holds it
    expect(code).toBe(0);
    expect(readdirSync(join(home, "data/releases"))).toHaveLength(1);
    expect(existsSync(join(home, "state/lock.info"))).toBe(false); // released on exit
  });

  test("a lock file left behind by a process that died blocks nothing", async () => {
    // The lock is flock(2): the kernel drops it when the holder dies, so a leftover file with a
    // dead process's name in it is just a file.
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    const dead = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "state/lock"), "");
    writeFileSync(join(home, "state/lock.info"), `${dead} nb-load 2026-10-02T00:00:00Z\n`);
    const r = await run("nb-load", ["--source", src], home);
    expect(r.status, r.out).toBe(0);
    expect(existsSync(join(home, "state/lock.info"))).toBe(false);
  });

  test("a lock that is genuinely held is respected, however old its file", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    mkdirSync(join(home, "state"), { recursive: true });
    const lock = join(home, "state/lock");
    const holder = spawn(
      "perl",
      [
        "-e",
        'open(my $f, ">>", $ARGV[0]) or die; flock($f, 2) or die; $| = 1; print "held\\n"; sleep 30',
        lock,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    cleanups.push(() => holder.kill());
    await new Promise<void>((res) => holder.stdout.once("data", () => res()));
    writeFileSync(
      join(home, "state/lock.info"),
      `${holder.pid} test-holder 2026-10-02T00:00:00Z\n`,
    );
    const r = await run("nb-load", ["--source", src], home);
    expect(r.status, r.out).toBe(75);
    expect(r.out).toContain("test-holder");
    expect(existsSync(join(home, "data/current"))).toBe(false);
  });

  test("a frozen loader fetches nothing until it is thawed", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "state/freeze"), "2026-10-02T00:00:00Z by test: rolled back\n");
    const server = serve(src);
    const frozen = await run("nb-load", ["--source", server.url], home);
    expect(frozen.status, frozen.out).toBe(0);
    expect(frozen.out).toContain("frozen");
    expect(server.log).toHaveLength(0);
    expect(lastLoad(home).outcome).toBe("frozen");
    expect((await run("nb-load", ["--thaw"], home)).status).toBe(0);
    expect(existsSync(join(home, "state/freeze"))).toBe(false);
    expect((await run("nb-load", ["--source", server.url], home)).status).toBe(0);
    expect(currentRelease(home)).not.toBeNull();
  });
});

describe.skipIf(!haveLoaderTools)("known-bad content", () => {
  /** What nb-reload leaves behind after a failed reload, written by the same shell function. */
  function recordFailure(home: string, release: string): void {
    const r = sh(`nb_init_dirs; nb_record_reload_failure "${release}" "synthetic reason"`, {
      home,
    });
    expect(r.status, r.stderr).toBe(0);
  }

  test("content that failed to reload is not retried until the TTL passes or --force", async () => {
    const home = newHome();
    const a = tmp("a");
    makeSource(a, ["nm000001", "nm000002"], "a");
    expect((await run("nb-load", ["--source", a], home)).status).toBe(0);
    const good = currentRelease(home) as string;
    const b = tmp("b");
    makeSource(b, ["nm000001", "nm000002"], "b");
    expect((await run("nb-load", ["--source", b], home)).status).toBe(0);
    const bad = currentRelease(home) as string;
    expect(bad).not.toBe(good);
    // The failed reload rolled back: the good release is live again, the bad content is remembered.
    rmSync(join(home, "data/current"));
    symlinkSync(`releases/${good}`, join(home, "data/current"));
    recordFailure(home, bad);

    const refused = await run("nb-load", ["--source", b], home);
    expect(refused.status, refused.out).toBe(5);
    expect(refused.out).toContain("not retrying");
    expect(currentRelease(home)).toBe(good);
    expect(lastLoad(home).outcome).toBe("known-bad");

    const forced = await run("nb-load", ["--source", b, "--force"], home);
    expect(forced.status, forced.out).toBe(0);
    expect(currentRelease(home)).not.toBe(good);

    // Back to the good release and an expired record: tried again without --force.
    rmSync(join(home, "data/current"));
    symlinkSync(`releases/${good}`, join(home, "data/current"));
    recordFailure(home, bad);
    const rec = JSON.parse(readFileSync(join(home, "state/reload-failed"), "utf8"));
    writeFileSync(join(home, "state/reload-failed"), JSON.stringify({ ...rec, epoch: 1 }));
    const retried = await run("nb-load", ["--source", b], home);
    expect(retried.status, retried.out).toBe(0);
  });
});

describe.skipIf(!haveLoaderTools)("seed, backup and restore", () => {
  test("the first release is Neurobagel's own example, validated, and never overwrites a live one", async () => {
    const home = newHome();
    mkdirSync(join(home, "recipes/data"), { recursive: true });
    cpSync(EXAMPLE, join(home, "recipes/data/example_synthetic_pheno-bids-derivatives.jsonld"));
    const r = await run("nb-load", ["--seed-example"], home);
    expect(r.status, r.out).toBe(0);
    const rel = currentRelease(home) as string;
    expect(releaseFiles(home, rel)).toEqual(["recipes-example.jsonld"]);
    expect(sha256(readFileSync(join(home, "data/releases", rel, "recipes-example.jsonld")))).toBe(
      EXAMPLE_SHA256,
    );
    expect(existsSync(join(home, "state/pending-reload"))).toBe(false); // nothing to reload yet
    const again = await run("nb-load", ["--seed-example"], home);
    expect(again.status).toBe(2);
    expect(currentRelease(home)).toBe(rel);
  });

  /** docker must not be on the PATH for restore tests: a restore refuses while this project's containers run. */
  function noDockerPath(): { PATH: string } {
    const bare = tmp("bare-path");
    for (const d of ["/usr/bin", "/bin"]) {
      for (const f of existsSync(d) ? readdirSync(d) : []) {
        if (f === "docker" || existsSync(join(bare, f))) continue;
        try {
          symlinkSync(join(d, f), join(bare, f));
        } catch {}
      }
    }
    const jq = spawnSync("sh", ["-c", "command -v jq"], { encoding: "utf8" }).stdout.trim();
    if (jq && !existsSync(join(bare, "jq"))) symlinkSync(jq, join(bare, "jq"));
    return { PATH: bare };
  }

  async function backedUpHome(): Promise<{
    home: string;
    archive: string;
    live: string;
    src: string;
  }> {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001", "nm000002"]);
    expect((await run("nb-load", ["--source", src], home)).status).toBe(0);
    mkdirSync(join(home, "secrets"), { mode: 0o700 });
    writeFileSync(join(home, "secrets/NB_GRAPH_PASSWORD.txt"), "placeholder-not-a-secret\n", {
      mode: 0o600,
    });
    writeFileSync(join(home, ".env"), "COMPOSE_PROJECT_NAME=nemar-neurobagel\nNB_X=original\n");
    const live = currentRelease(home) as string;
    const b = await run("nb-backup", [], home);
    expect(b.status, b.out).toBe(0);
    const archives = readdirSync(join(home, "backups")).filter((f) => f.endsWith(".tar.gz"));
    expect(archives).toHaveLength(1);
    return { home, archive: join(home, "backups", archives[0]), live, src };
  }

  test("a backup restores byte for byte, verifies itself, and keeps configuration it must not replace", async () => {
    const { home, archive, live, src } = await backedUpHome();
    expect(lstatSync(archive).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(home, "backups")).mode & 0o777).toBe(0o700);

    // Disaster: the release and the manifests are gone; .env was edited since.
    rmSync(join(home, "data"), { recursive: true });
    rmSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, ".env"), "COMPOSE_PROJECT_NAME=nemar-neurobagel\nNB_X=edited-since\n");
    const noDocker = noDockerPath();

    const bad = join(tmp("damaged"), "bad.tar.gz");
    writeFileSync(bad, "not an archive");
    expect((await run("nb-restore", [bad], home, noDocker)).status).not.toBe(0);

    const r = await run("nb-restore", [archive], home, noDocker);
    expect(r.status, r.out).toBe(0);
    expect(currentRelease(home)).toBe(live);
    for (const d of readIndex(src).datasets) {
      const a = d.artifacts[0];
      expect(sha256(readFileSync(join(home, "data/releases", live, a.name)))).toBe(a.sha256);
    }
    expect(readFileSync(join(home, ".env"), "utf8")).toContain("edited-since"); // kept
    expect(readFileSync(join(home, "secrets/NB_GRAPH_PASSWORD.txt"), "utf8")).toContain(
      "placeholder",
    );
    expect(readFileSync(join(home, "state/pending-reload"), "utf8").trim()).toBe(live);
    expect(existsSync(join(home, "state/applied.json"))).toBe(false); // not loaded on this host yet

    const o = await run("nb-restore", [archive, "--overwrite-config"], home, noDocker);
    expect(o.status, o.out).toBe(0);
    expect(readFileSync(join(home, ".env"), "utf8")).toContain("NB_X=original");
  });

  test("an archive whose contents were altered after it was written is refused, and nothing is restored", async () => {
    const { home, archive, live } = await backedUpHome();
    const work = tmp("tamper");
    expect(spawnSync("tar", ["-C", work, "-xzf", archive]).status).toBe(0);
    // Change one byte of a restored artifact; SHA256SUMS still states the original hash.
    const victim = join(work, "data/releases", live, "nm000001.jsonld");
    writeFileSync(victim, `${readFileSync(victim, "utf8")} `);
    const forged = join(tmp("forged"), "forged.tar.gz");
    expect(spawnSync("tar", ["-C", work, "-czf", forged, "."]).status).toBe(0);
    rmSync(join(home, "data"), { recursive: true });
    rmSync(join(home, "state"), { recursive: true });
    const r = await run("nb-restore", [forged], home, noDockerPath());
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toContain("checksum mismatch");
    expect(existsSync(join(home, "data/releases"))).toBe(false);
  });

  test("a release name in an archive that is not a release name is refused before any path is built", async () => {
    const { home, archive } = await backedUpHome();
    const work = tmp("evil");
    expect(spawnSync("tar", ["-C", work, "-xzf", archive]).status).toBe(0);
    const meta = JSON.parse(readFileSync(join(work, "BACKUP.json"), "utf8"));
    // A sentinel the restore must not touch, and a name that reaches it through the releases dir.
    const sentinel = join(home, "data/sentinel-dir");
    mkdirSync(sentinel, { recursive: true });
    writeFileSync(join(sentinel, "keep"), "do not delete");
    meta.live_release = "../sentinel-dir";
    writeFileSync(join(work, "BACKUP.json"), JSON.stringify(meta));
    mkdirSync(join(work, "data/sentinel-dir"), { recursive: true });
    const evil = join(tmp("evil2"), "evil.tar.gz");
    expect(spawnSync("tar", ["-C", work, "-czf", evil, "."]).status).toBe(0);
    const r = await run("nb-restore", [evil], home, noDockerPath());
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toContain("not a release name");
    expect(readFileSync(join(sentinel, "keep"), "utf8")).toBe("do not delete");
  });

  test("a rollback release name that is not a release name is refused before any path is built, whatever it holds", async () => {
    const { home, archive, live } = await backedUpHome();
    for (const evil of ["../..", `${live}\n../..`, "../sentinel-dir", `${live}/../..`]) {
      const work = tmp("evil");
      expect(spawnSync("tar", ["-C", work, "-xzf", archive]).status).toBe(0);
      const meta = JSON.parse(readFileSync(join(work, "BACKUP.json"), "utf8"));
      meta.rollback_release = evil;
      writeFileSync(join(work, "BACKUP.json"), JSON.stringify(meta));
      const forged = join(tmp("forged"), "forged.tar.gz");
      expect(spawnSync("tar", ["-C", work, "-czf", forged, "."]).status).toBe(0);
      // "../.." from the releases directory IS the deployment root: without the check the restore
      // would remove it. The sentinel is a file at that root.
      writeFileSync(join(home, "sentinel.txt"), "the deployment root still exists");
      const r = await run("nb-restore", [forged], home, noDockerPath());
      expect(r.status, `${JSON.stringify(evil)}: ${r.out}`).not.toBe(0);
      expect(r.out).toContain("not a release name");
      expect(readFileSync(join(home, "sentinel.txt"), "utf8")).toContain("still exists");
      expect(existsSync(join(home, "data/releases", live))).toBe(true);
    }
  });

  test("a live release name with a newline in it is refused the same way", async () => {
    const { home, archive, live } = await backedUpHome();
    const work = tmp("evil");
    expect(spawnSync("tar", ["-C", work, "-xzf", archive]).status).toBe(0);
    const meta = JSON.parse(readFileSync(join(work, "BACKUP.json"), "utf8"));
    meta.live_release = `${live}\n../..`;
    writeFileSync(join(work, "BACKUP.json"), JSON.stringify(meta));
    const forged = join(tmp("forged"), "forged.tar.gz");
    expect(spawnSync("tar", ["-C", work, "-czf", forged, "."]).status).toBe(0);
    writeFileSync(join(home, "sentinel.txt"), "the deployment root still exists");
    const r = await run("nb-restore", [forged], home, noDockerPath());
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toContain("not a release name");
    expect(readFileSync(join(home, "sentinel.txt"), "utf8")).toContain("still exists");
  });

  test("a hold in force when the backup was taken is in force after the restore", async () => {
    const { home } = await backedUpHome();
    const holdText = "2026-10-02T09:39:51Z by operator: a hold in force at backup time\n";
    writeFileSync(join(home, "state/hold"), holdText);
    await Bun.sleep(1100); // archive names carry the second
    expect((await run("nb-backup", [], home)).status).toBe(0);
    const newest = readdirSync(join(home, "backups"))
      .filter((f) => f.endsWith(".tar.gz"))
      .sort()
      .pop() as string;
    rmSync(join(home, "data"), { recursive: true });
    rmSync(join(home, "state"), { recursive: true });
    const r = await run("nb-restore", [join(home, "backups", newest)], home, noDockerPath());
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(home, "state/hold"), "utf8")).toBe(holdText);
  });

  test("two backups within one second do not overwrite each other", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    expect((await run("nb-load", ["--source", src], home)).status).toBe(0);
    const stampOf = (f: string) => f.replace(/^nb-/, "").replace(/\.tar\.gz$/, "");
    const seen = new Set<string>();
    for (let k = 0; k < 3; k++) {
      expect((await run("nb-backup", [], home)).status).toBe(0);
    }
    for (const f of readdirSync(join(home, "backups")).filter((x) => x.endsWith(".tar.gz"))) {
      seen.add(stampOf(f));
    }
    expect(seen.size).toBe(3);
  });

  test("backup retention keeps the newest N", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    expect((await run("nb-load", ["--source", src], home)).status).toBe(0);
    mkdirSync(join(home, "backups"), { mode: 0o700 });
    for (const d of ["20250101T000000Z", "20250102T000000Z", "20250103T000000Z"]) {
      writeFileSync(join(home, `backups/nb-${d}.tar.gz`), "old");
    }
    const r = await run("nb-backup", ["--keep", "2"], home);
    expect(r.status, r.out).toBe(0);
    const left = readdirSync(join(home, "backups")).filter((f) => f.endsWith(".tar.gz"));
    expect(left).toHaveLength(2);
    expect(left).not.toContain("nb-20250101T000000Z.tar.gz");
  });

  test("a hook written in .env as the template shows it, with no quotes around it, runs as written", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    expect((await run("nb-load", ["--source", src], home)).status).toBe(0);
    const copies = tmp("copies");
    writeFileSync(
      join(home, ".env"),
      `COMPOSE_PROJECT_NAME=nemar-neurobagel\nNB_BACKUP_HOOK=cp "$1" ${copies}/\n`,
    );
    const r = await run("nb-backup", [], home);
    expect(r.status, r.out).toBe(0);
    expect(readdirSync(copies)).toHaveLength(1);
    // Values are read literally, so a value wrapped in quotes keeps them: the template says not to.
    const quoted = newHome();
    writeFileSync(join(quoted, ".env"), "NB_BACKUP_HOOK='echo hi'\n");
    expect(sh("nb_env_get NB_BACKUP_HOOK", { home: quoted }).stdout).toBe("'echo hi'");
    const template = readFileSync(join(DEPLOY, ".env.example"), "utf8");
    expect(template).toMatch(/^# {3}NB_BACKUP_HOOK=[^'"]/m);
    expect(readFileSync(join(BIN, "nb-backup"), "utf8")).not.toContain("NB_BACKUP_HOOK='");
  });

  test("the off-host hook runs once per archive, and a failing hook is reported but keeps the archive", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    expect((await run("nb-load", ["--source", src], home)).status).toBe(0);
    const copies = tmp("copies");
    const ok = await run("nb-backup", [], home, { NB_BACKUP_HOOK: `cp "$1" "${copies}/"` });
    expect(ok.status, ok.out).toBe(0);
    expect(readdirSync(copies)).toHaveLength(1);
    const failing = await run("nb-backup", [], home, { NB_BACKUP_HOOK: "exit 3" });
    expect(failing.status, failing.out).toBe(9);
    expect(failing.out).toContain("off-host hook failed");
    expect(
      readdirSync(join(home, "backups")).filter((f) => f.endsWith(".tar.gz")).length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("the decisions, as pure functions over real text", () => {
  describe.skipIf(!haveLoaderTools)("rollback target", () => {
    /** Three releases published by the real loader; returns their names oldest first. */
    async function threeReleases(): Promise<{ home: string; r: string[]; dir: string }> {
      const home = newHome();
      const names: string[] = [];
      for (const v of ["a", "b", "c"]) {
        const src = tmp(`src-${v}`);
        makeSource(src, ["nm000001", "nm000002"], v);
        expect((await run("nb-load", ["--source", src], home)).status).toBe(0);
        names.push(currentRelease(home) as string);
        await Bun.sleep(1100); // release names carry the second they were made in
      }
      return { home, r: names, dir: join(home, "data/releases") };
    }

    test("a failed reload goes back to the last release that was LOADED, not the last one published", async () => {
      const { r, dir } = await threeReleases();
      // r[0] was loaded and verified; r[1] was published and never loaded; r[2] is the failing one.
      const out = sh(`nb_decide_rollback_target ${r[2]} ${r[0]} ${r[1]} "${dir}"`);
      expect(out.stdout).toBe(r[0]);
    });

    test("it falls back to the previously published release only when the loaded one is gone or is the failing one", async () => {
      const { home, r, dir } = await threeReleases();
      const target = (cur: string, applied: string, prev: string) =>
        sh(`nb_decide_rollback_target ${cur} "${applied}" "${prev}" "${dir}"`, { home }).stdout;
      expect(target(r[2], "", r[1])).toBe(r[1]);
      expect(target(r[2], r[2], r[1])).toBe(r[1]);
      rmSync(join(dir, r[0]), { recursive: true });
      expect(target(r[2], r[0], r[1])).toBe(r[1]);
      rmSync(join(dir, r[1]), { recursive: true });
      expect(target(r[2], r[0], r[1])).toBe("");
    });

    test("a name that is not a release name is never a target, whatever is on disk", async () => {
      const { home, r, dir } = await threeReleases();
      mkdirSync(join(home, "data/sentinel"), { recursive: true });
      expect(
        sh(`nb_decide_rollback_target ${r[2]} "../sentinel" "" "${dir}"`, { home }).stdout,
      ).toBe("");
      expect(sh(`nb_release_name_ok "../sentinel"`, { home }).status).not.toBe(0);
      expect(sh(`nb_release_name_ok "${r[0]}"`, { home }).status).toBe(0);
      // The whole string is matched, not one line of it: a valid name beside a path is not valid.
      for (const evil of [`${r[0]}\n../..`, `../..\n${r[0]}`, `${r[0]}\n`, `\n${r[0]}`]) {
        // $'...' makes the newline part of the value itself, with nothing to strip it.
        const ok = sh(`nb_release_name_ok $'${evil.replace(/\n/g, "\\n")}'`, { home });
        expect(ok.status, JSON.stringify(evil)).not.toBe(0);
      }
      expect(sh(`nb_release_name_ok "${r[0]}-2"`, { home }).status).toBe(0);
      expect(sh(`nb_release_name_ok ""`, { home }).status).not.toBe(0);
    });

    test("nb rollback's default: back to what was loaded before when the live release is the loaded one", async () => {
      const { home, r, dir } = await threeReleases();
      // live == applied == r[2]; loaded before that: r[0]; published before that: r[1].
      expect(
        sh(`nb_decide_manual_rollback_target ${r[2]} ${r[2]} ${r[0]} ${r[1]} "${dir}"`, { home })
          .stdout,
      ).toBe(r[0]);
      // live (r[2]) was staged but never loaded; the loaded one is r[0].
      expect(
        sh(`nb_decide_manual_rollback_target ${r[2]} ${r[0]} "" ${r[1]} "${dir}"`, { home }).stdout,
      ).toBe(r[0]);
    });

    test("pruning keeps the live, the loaded, the previously loaded and the rollback release", async () => {
      const home = newHome();
      const names: string[] = [];
      for (const v of ["a", "b", "c", "d", "e"]) {
        const src = tmp(`src-${v}`);
        makeSource(src, ["nm000001"], v);
        expect((await run("nb-load", ["--source", src], home)).status).toBe(0);
        names.push(currentRelease(home) as string);
        await Bun.sleep(1100);
      }
      // The oldest release is the one the node actually loaded; it must survive a keep of 2.
      writeFileSync(join(home, "state/applied.json"), JSON.stringify({ release: names[0] }));
      writeFileSync(join(home, "state/previous-loaded"), `${names[1]}\n`);
      const fn = readFileSync(join(BIN, "nb-load"), "utf8").match(
        /prune_releases\(\) \{[\s\S]*?\n\}\n/,
      )?.[0];
      expect(fn).toBeTruthy();
      const prune = sh(`keep_releases=2\n${fn}\nprune_releases`, { home });
      expect(prune.status, prune.stderr).toBe(0);
      const kept = readdirSync(join(home, "data/releases"));
      expect(kept).toContain(names[0]); // loaded and verified
      expect(kept).toContain(names[1]); // loaded before that
      expect(kept).toContain(currentRelease(home) as string); // live
      expect(kept).toContain(readFileSync(join(home, "state/rollback-to"), "utf8").trim());
      expect(kept).not.toContain(names[2]); // nothing protects it, and it is past the keep of 2
    });
  });

  describe("memory and hold", () => {
    test("the abort rule: below the threshold is a breach, at it is not, unknown never is", () => {
      const breach = (avail: string, abort: string) =>
        sh(`nb_decide_mem_breach "${avail}" "${abort}"`).status === 0;
      expect(breach("1535", "1536")).toBe(true);
      expect(breach("1536", "1536")).toBe(false);
      expect(breach("4000", "1536")).toBe(false);
      expect(breach("", "1536")).toBe(false);
    });

    test("the reload pre-flight: needs the minimum, and an unknown reading does not block", () => {
      const ok = (avail: string, min: string) =>
        sh(`nb_decide_mem_preflight_ok "${avail}" "${min}"`).status === 0;
      expect(ok("1799", "1800")).toBe(false);
      expect(ok("1800", "1800")).toBe(true);
      expect(ok("", "1800")).toBe(true);
    });

    // The text of a hold as `nb hold` writes it: UTC time, who, why.
    const holdA = "2026-10-02T09:39:51Z by operator: first hold";
    const holdB =
      "2026-10-02T09:41:13Z by operator: second hold, set while the node was coming back";

    test("a hold stops a reload; the hold an unhold is ending does not; a newer hold does", () => {
      const d = (present: string, unhold: string, ending: string, current: string) =>
        sh(`nb_decide_hold_stop ${present} ${unhold} "${ending}" "${current}"`).stdout;
      expect(d("0", "0", "", "")).toBe("go"); // no hold
      expect(d("1", "0", "", holdA)).toBe("stop"); // an ordinary reload on a held node
      expect(d("1", "1", holdA, holdA)).toBe("go"); // the unhold's own reload
      expect(d("1", "1", holdA, holdB)).toBe("stop"); // nb hold ran again during it
      expect(d("1", "1", "", holdA)).toBe("go"); // an unhold that does not say which hold
      expect(d("0", "1", holdA, "")).toBe("go");
    });

    test("an unhold ends the hold it read and no other", () => {
      const d = (read: string, now: string) =>
        sh(`nb_decide_unhold_flag "${read}" "${now}"`).stdout;
      expect(d(holdA, holdA)).toBe("remove");
      expect(d(holdA, holdB)).toBe("keep"); // a newer hold is not the unhold's to end
      expect(d(holdA, "")).toBe("gone");
    });

    test("a failed reload is held against the content unless a hold or a memory abort caused it", () => {
      const d = (held: string, mem: string) => sh(`nb_decide_blame_content ${held} ${mem}`).stdout;
      expect(d("0", "0")).toBe("yes");
      expect(d("1", "0")).toBe("no");
      expect(d("0", "1")).toBe("no");
      expect(d("1", "1")).toBe("no");
    });
  });

  describe("the scripts' own wiring of those decisions, run as they are written", () => {
    /** One function of a script, as written, to be defined in a bash snippet next to its inputs. */
    const fn = (file: string, name: string): string => {
      const m = readFileSync(join(BIN, file), "utf8").match(
        new RegExp(`\\n${name}\\(\\) \\{[\\s\\S]*?\\n\\}\\n`),
      );
      expect(m, `${name} in ${file}`).toBeTruthy();
      return m?.[0] ?? "";
    };
    const holdA = "2026-10-02T09:39:51Z by operator: first hold";
    const holdB =
      "2026-10-02T09:41:13Z by operator: second hold, set while the node was coming back";

    test("end_this_hold removes the hold it read, leaves a newer one in place, and accepts one that is gone", () => {
      const attempt = (flagText: string | null) => {
        const home = tmp("holdhome");
        mkdirSync(join(home, "state"), { recursive: true });
        const flag = join(home, "state/hold");
        if (flagText !== null) writeFileSync(flag, `${flagText}\n`);
        const r = sh(
          `held_text="${holdA}"\n${fn("nb-hold", "end_this_hold")}\nend_this_hold; echo rc=$?`,
          { home },
        );
        return {
          rc: r.stdout.match(/rc=(\d+)/)?.[1],
          left: existsSync(flag) ? readFileSync(flag, "utf8").trim() : null,
          strays: readdirSync(join(home, "state")).filter((f) => f.startsWith("hold.")),
        };
      };
      expect(attempt(holdA)).toEqual({ rc: "0", left: null, strays: [] });
      expect(attempt(holdB)).toEqual({ rc: "1", left: holdB, strays: [] }); // a newer hold stands
      expect(attempt(null)).toEqual({ rc: "0", left: null, strays: [] });
    });

    test("nb unhold hands its reload the text of the hold it is ending, and the reload judges a hold by it", () => {
      expect(readFileSync(join(BIN, "nb-hold"), "utf8")).toContain(
        'NB_ENDING_HOLD="$held_text" "$NB_CODE_DIR/bin/nb-reload" --from-unhold',
      );
      const stops = (fromUnhold: string, ending: string, flagText: string | null) => {
        const home = tmp("holdhome");
        mkdirSync(join(home, "state"), { recursive: true });
        if (flagText !== null) writeFileSync(join(home, "state/hold"), `${flagText}\n`);
        const r = sh(
          `from_unhold=${fromUnhold}; export NB_ENDING_HOLD="${ending}"\n${fn("nb-reload", "hold_stops")}\nhold_stops; echo rc=$?`,
          { home },
        );
        return r.stdout.match(/rc=(\d+)/)?.[1] === "0";
      };
      expect(stops("0", "", null)).toBe(false); // no hold
      expect(stops("0", "", holdA)).toBe(true); // an ordinary reload on a held node
      expect(stops("1", holdA, holdA)).toBe(false); // the reload that is ending this hold
      expect(stops("1", holdA, holdB)).toBe(true); // nb hold ran again while it worked
    });

    test("the guard's baseline: recorded when there is none or the host has rebooted, stamped when old, kept when current", () => {
      const state = join(FIX, "guard-state-before.txt");
      const entries = readFileSync(state, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("\t").slice(0, 3).join("\t"));
      const outcome = (existing: string | null, boot: string, uptime: string) => {
        const dir = tmp("guard");
        mkdirSync(join(dir, "state"), { recursive: true });
        const file = join(dir, "baseline.tsv");
        if (existing !== null) writeFileSync(file, existing);
        const r = sh(
          [
            `baseline_file="${file}"; settle_s=180; boot_note=""`,
            `neighbors() { cat "${state}"; }`,
            `nb_boot_id() { echo "${boot}"; }; nb_uptime_s() { echo "${uptime}"; }`,
            fn("nb-guard", "record_baseline"),
            fn("nb-guard", "settle_baseline"),
            "settle_baseline",
          ].join("\n"),
          { home: dir },
        );
        expect(r.status, r.stderr).toBe(0);
        return readFileSync(file, "utf8").trimEnd().split("\n");
      };
      const taken = (boot: string) => [`#boot_id\t${boot}`, ...entries];
      expect(readFileSync(join(BIN, "nb-guard"), "utf8")).toMatch(
        /settle_baseline\n {2}now_neighbors="\$\(neighbors\)"\n {2}neighbors_bad="/,
      );
      // None yet: recorded, with this boot's id.
      expect(outcome(null, "B", "5000")).toEqual(taken("B"));
      // Taken in an earlier boot: the host has rebooted, so it is taken again.
      expect(outcome("#boot_id\tA\nold-container\t2020-01-01T00:00:00Z\t0\n", "B", "5000")).toEqual(
        taken("B"),
      );
      // Taken in this boot, host up for long enough: untouched, whatever the containers are doing.
      expect(outcome("#boot_id\tB\nkept\t2020-01-01T00:00:00Z\t0\n", "B", "5000")).toEqual([
        "#boot_id\tB",
        "kept\t2020-01-01T00:00:00Z\t0",
      ]);
      // Taken in this boot but the host has only just come up: taken again as the containers appear.
      expect(outcome("#boot_id\tB\nkept\t2020-01-01T00:00:00Z\t0\n", "B", "60")).toEqual(
        taken("B"),
      );
      // From before boot ids existed: its entries are kept and it is stamped.
      expect(outcome("legacy\t2020-01-01T00:00:00Z\t0\n", "B", "5000")).toEqual([
        "#boot_id\tB",
        "legacy\t2020-01-01T00:00:00Z\t0",
      ]);
    });
  });

  describe("the guard", () => {
    const before = readFileSync(join(FIX, "guard-state-before.txt"), "utf8");
    const afterRestart = readFileSync(join(FIX, "guard-state-after-restart.txt"), "utf8");
    function baselineFile(text: string): string {
      const f = join(tmp("baseline"), "guard-baseline.tsv");
      const lines = text
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("\t").slice(0, 3).join("\t"));
      writeFileSync(f, `${lines.join("\n")}\n`);
      return f;
    }
    const breaches = (baseline: string, now: string) =>
      sh(`nb_guard_neighbor_breaches "${baselineFile(baseline)}"`, { input: now }).stdout;

    test("real container state, unchanged, is no breach", () => {
      expect(breaches(before, before)).toBe("");
    });

    test("a real restart (start time changed, restart count did not) is a breach", () => {
      expect(breaches(before, afterRestart)).toBe("svc-query_federation(restarted)");
    });

    test("a container that has vanished, one that turned unhealthy, and several at once", () => {
      const lines = before.split("\n").filter(Boolean);
      expect(breaches(before, lines.filter((l) => !l.startsWith("svc-api\t")).join("\n"))).toBe(
        "svc-api(gone)",
      );
      const unhealthy = lines.map((l) =>
        l.startsWith("svc-graph\t") ? l.replace("\thealthy\t", "\tunhealthy\t") : l,
      );
      expect(breaches(before, unhealthy.join("\n"))).toBe("svc-graph(unhealthy)");
      const both = afterRestart
        .split("\n")
        .filter(Boolean)
        .filter((l) => !l.startsWith("svc-federation\t"));
      expect(breaches(before, both.join("\n")).split(";").sort()).toEqual([
        "svc-federation(gone)",
        "svc-query_federation(restarted)",
      ]);
    });

    test("a container the baseline never saw is new, not a breach", () => {
      const withNew = `${before}svc-new\t2026-10-02T09:00:00Z\t0\thealthy\trunning\n`;
      expect(breaches(before, withNew)).toBe("");
    });

    test("load: a breach needs the configured number of consecutive samples above the threshold", () => {
      let streak = "0";
      const seq: string[] = [];
      for (const load of ["7", "7", "7", "7", "7", "7"]) {
        const r = sh(`nb_guard_load_rule ${load} ${streak} 6 6`).stdout;
        seq.push(r);
        streak = r.split(" ")[0];
      }
      expect(seq).toEqual(["1 ok", "2 ok", "3 ok", "4 ok", "5 ok", "6 breach"]);
      expect(sh("nb_guard_load_rule 2 5 6 6").stdout).toBe("0 ok"); // one calm sample resets it
      expect(sh("nb_guard_load_rule 6 5 6 6").stdout).toBe("0 ok"); // at the threshold is not above it
      expect(sh('nb_guard_load_rule "" 5 6 6').stdout).toBe("0 ok");
    });

    // The baseline belongs to one boot of the host. These use the real captured container state:
    // after a reboot every container has a new start time and a restart count of zero.
    const rebooted = before
      .split("\n")
      .filter(Boolean)
      .map((l, i) => {
        const f = l.split("\t");
        f[1] = `2026-10-03T00:00:0${i}.000000000Z`;
        f[2] = "0";
        return f.join("\t");
      })
      .join("\n");

    test("a baseline carries the boot id of the host it was taken in", () => {
      const text = sh('nb_guard_baseline_render "boot-A"', { input: before }).stdout;
      const lines = text.split("\n");
      expect(lines[0]).toBe("#boot_id\tboot-A");
      expect(lines.slice(1)).toEqual(
        before
          .split("\n")
          .filter(Boolean)
          .map((l) => l.split("\t").slice(0, 3).join("\t")),
      );
      expect(sh("nb_guard_baseline_boot_id", { input: text }).stdout).toBe("boot-A");
      expect(sh("nb_guard_baseline_boot_id", { input: before }).stdout).toBe(""); // none: an old one
    });

    test("what the guard does with its baseline: record after a reboot or just after boot, stamp an old one, keep otherwise", () => {
      const action = (present: string, bboot: string, cboot: string, up: string, settle = "180") =>
        sh(`nb_decide_baseline_action ${present} "${bboot}" "${cboot}" "${up}" ${settle}`).stdout;
      expect(action("0", "", "B", "5000")).toBe("record"); // none yet
      expect(action("1", "A", "B", "5000")).toBe("record"); // the host has rebooted
      expect(action("1", "A", "A", "5000")).toBe("keep");
      expect(action("1", "A", "A", "179")).toBe("record"); // up for less than the settle time
      expect(action("1", "A", "A", "180")).toBe("keep");
      expect(action("1", "", "B", "5000")).toBe("stamp"); // from before boot ids existed
      expect(action("1", "A", "", "")).toBe("keep"); // no /proc to compare with: never forced
    });

    test("the failure this prevents: a baseline from before a reboot reads every container as restarted", () => {
      const stale = sh(`nb_guard_neighbor_breaches "${baselineFile(before)}"`, {
        input: rebooted,
      }).stdout;
      expect(stale.split(";")).toHaveLength(before.split("\n").filter(Boolean).length);
      expect(stale).toContain("(restarted)");
      // The boot id differs, so the decision is to record again; judged against that, the same
      // state is no breach, and the header line is not mistaken for a container.
      expect(sh("nb_decide_baseline_action 1 A B 5000 180").stdout).toBe("record");
      const fresh = join(tmp("baseline"), "guard-baseline.tsv");
      writeFileSync(fresh, `${sh("nb_guard_baseline_render B", { input: rebooted }).stdout}\n`);
      expect(sh(`nb_guard_neighbor_breaches "${fresh}"`, { input: rebooted }).stdout).toBe("");
      // And a real restart AFTER the new baseline is still caught.
      const again = rebooted.replace(/(svc-api\t)[^\t]*/, "$12026-10-03T01:00:00.000000000Z");
      expect(sh(`nb_guard_neighbor_breaches "${fresh}"`, { input: again }).stdout).toBe(
        "svc-api(restarted)",
      );
    });

    test("the heartbeat: stale beyond the maximum age, silent before it and when there is none", () => {
      expect(sh("nb_guard_heartbeat_problem 1000 2200 1200 1").stdout).toBe("");
      expect(sh("nb_guard_heartbeat_problem 1000 2201 1200 1").stdout).toContain("last sampled");
      // No heartbeat at all: a problem while a guard is expected, nothing when the operator said
      // the node runs without one.
      expect(sh('nb_guard_heartbeat_problem "" 2201 1200 1').stdout).toContain("never started");
      expect(sh('nb_guard_heartbeat_problem "" 2201 1200 0').stdout).toBe("");
      expect(sh('nb_guard_heartbeat_problem "" 2201 1200').stdout).toBe("");
    });
  });

  describe.skipIf(!haveLoaderTools)("what status says", () => {
    const verdict = (problems: string, hold: string) =>
      sh(`nb_status_verdict "${problems}" "${hold}"`).stdout;

    test("verdicts and exit codes", () => {
      expect(verdict("", "")).toBe("healthy 0");
      expect(verdict("graph health is unhealthy", "")).toBe("degraded 1");
      expect(verdict("the last reload failed: x", "")).toBe("degraded 1");
      expect(verdict("service api has no container", "")).toBe("down 2");
      expect(verdict("graph is exited", "")).toBe("down 2");
      expect(verdict("", "2026-10-02 by test: reason")).toBe("hold 3");
      expect(verdict("the guard stopped the project", "2026-10-02 by test: reason")).toBe("hold 3");
    });

    test("a node on hold whose API still answers is degraded, not on hold", () => {
      expect(
        verdict(
          "the node is on hold but its API still answers on 127.0.0.1:18000",
          "2026-10-02 by test: reason",
        ),
      ).toBe("degraded 1");
    });

    test("the loader's own records, produced by the real loader, become problems", async () => {
      const home = newHome();
      const bad = tmp("bad");
      writeFileSync(join(bad, "index.json"), "{not json");
      expect((await run("nb-load", ["--source", bad], home)).status).toBe(3);
      const problems = (now: string, ok: string, set = "1", freeze = "") =>
        sh(
          `nb_loader_problems "${join(home, "state/last-load.json")}" "${ok}" ${now} ${set} 7200 "${freeze}"`,
          { home },
        ).stdout;
      // A failed load is a problem, with the outcome and the time in it.
      expect(problems("2000000000", "1999999000")).toContain(
        "the newest content is NOT being served",
      );
      expect(problems("2000000000", "1999999000")).toContain("source-failed");

      // After a good run the failure is gone, and a loader that is alive is not stale.
      const good = tmp("good");
      makeSource(good, ["nm000001"]);
      expect((await run("nb-load", ["--source", good], home)).status).toBe(0);
      const ok = readFileSync(join(home, "state/last-load-ok"), "utf8").trim();
      const now = String(Number(ok) + 100);
      expect(problems(now, ok)).toBe("");
      // A loader that has not had a good run for more than two hours is a problem; exactly two is not.
      expect(problems(String(Number(ok) + 7201), ok)).toContain("no successful loader run for");
      expect(problems(String(Number(ok) + 7200), ok)).toBe("");
      // No source configured: nobody expects a loader, so nothing is stale.
      expect(problems(String(Number(ok) + 99999), ok, "0")).toBe("");
      // Configured but never completed.
      expect(problems(now, "", "1")).toContain("has not completed a run yet");
      // Frozen is a problem, and says how to end it.
      expect(problems(now, ok, "1", "rolled back by test")).toContain("nb load --thaw");
    });
  });

  describe.skipIf(!haveLoaderTools)("does the node serve what it should", () => {
    const datasets = readFileSync(join(FIX, "node-datasets-goldens.json"), "utf8").trim();
    const protectedSubjects = readFileSync(
      join(FIX, "node-subjects-protected.json"),
      "utf8",
    ).trim();
    const unprotectedSubjects = readFileSync(
      join(FIX, "node-subjects-unprotected.json"),
      "utf8",
    ).trim();

    /** The release directory holds the real Phase 1 goldens the captured answers were produced from. */
    function goldenRelease(): string {
      const dir = tmp("release");
      for (const id of readdirSync(GOLDEN)) {
        const f = join(GOLDEN, id, `${id}.jsonld`);
        if (existsSync(f)) cpSync(f, join(dir, `${id}.jsonld`));
      }
      return dir;
    }
    const judge = (release: string, ds: string, subj: string) => {
      const dir = tmp("judge");
      writeFileSync(join(dir, "ds.json"), ds);
      writeFileSync(join(dir, "subj.json"), subj);
      return sh(
        `nb_verify_judge "${release}" "$(cat "${join(dir, "ds.json")}")" "$(cat "${join(dir, "subj.json")}")"; rc=$?; echo "$NB_VERIFY_EXPECTED $NB_VERIFY_SERVED"; echo "$NB_VERIFY_REASON"; exit $rc`,
      );
    };

    test("the real answers of a real node for the real goldens: exactly the release, protected", () => {
      const r = judge(goldenRelease(), datasets, protectedSubjects);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const [expected, served] = r.stdout.split("\n")[0].split(" ").map(Number);
      expect(served).toBe(expected);
      expect(expected).toBe((JSON.parse(datasets) as unknown[]).length);
    });

    test("a dataset the node does not serve is named", () => {
      const list = JSON.parse(datasets) as Array<{ dataset_uuid: string }>;
      const missing = list[3].dataset_uuid;
      const r = judge(
        goldenRelease(),
        JSON.stringify(list.filter((_, i) => i !== 3)),
        protectedSubjects,
      );
      expect(r.status).not.toBe(0);
      expect(r.stdout).toContain(`missing: ${missing}`);
    });

    test("a dataset the node serves that is not in the release is named", () => {
      const list = JSON.parse(datasets) as Array<Record<string, unknown>>;
      const extra = { ...list[0], dataset_uuid: "http://neurobagel.org/vocab/not-in-the-release" };
      const r = judge(goldenRelease(), JSON.stringify([...list, extra]), protectedSubjects);
      expect(r.status).not.toBe(0);
      expect(r.stdout).toContain("unexpected: http://neurobagel.org/vocab/not-in-the-release");
    });

    test("a node that returns participant rows fails, using a real answer from a node that does", () => {
      const r = judge(goldenRelease(), datasets, unprotectedSubjects);
      expect(r.status).not.toBe(0);
      expect(r.stdout).toContain("participant-level records");
    });

    test("a dataset not marked records_protected fails", () => {
      const list = JSON.parse(datasets) as Array<Record<string, unknown>>;
      list[0].records_protected = false;
      const r = judge(goldenRelease(), JSON.stringify(list), protectedSubjects);
      expect(r.status).not.toBe(0);
      expect(r.stdout).toContain("not marked records_protected");
    });

    test("an empty or malformed answer fails: nothing is protected by a silence", () => {
      const rel = goldenRelease();
      expect(judge(rel, "[]", protectedSubjects).stdout).toContain("no dataset at all");
      expect(judge(rel, datasets, "[]").stdout).toContain("could not be confirmed");
      expect(judge(rel, '{"detail":"error"}', protectedSubjects).stdout).toContain("not a list");
      expect(judge(rel, datasets, '{"detail":"error"}').stdout).toContain("not a list");
    });
  });

  describe.skipIf(!haveLoaderTools)(
    "reading what the stock containers print (real captured output)",
    () => {
      const fn = (name: string, input: string): string => {
        const r = sh(name, { input });
        expect(r.status, r.stderr).toBe(0);
        return r.stdout;
      };

      test("the graph log of a first start is a completed load", () => {
        expect(
          fn(
            "nb_graph_log_verdict",
            readFileSync(join(FIX, "graph-setup-first-start.txt"), "utf8"),
          ),
        ).toBe("loaded");
      });

      test("the same log cut before the end is still pending", () => {
        const log = readFileSync(join(FIX, "graph-setup-first-start.txt"), "utf8");
        expect(fn("nb_graph_log_verdict", log.split("\n").slice(0, 40).join("\n"))).toBe("pending");
        expect(fn("nb_graph_log_verdict", "")).toBe("pending");
      });

      test("the stock upload script's own failure output is a failed load although it exits 0", () => {
        const verdict = fn(
          "nb_graph_log_verdict",
          readFileSync(join(FIX, "graph-setup-upload-failure.txt"), "utf8"),
        );
        expect(verdict).toStartWith("failed: the graph reported upload errors");
        expect(verdict).toContain("Upload failed");
      });

      test("initialiser summaries parse to accepted and total counts", () => {
        const [a, t] = fn(
          "nb_init_counts",
          readFileSync(join(FIX, "init-all-accepted.txt"), "utf8"),
        )
          .split(" ")
          .map(Number);
        expect(a).toBe(t);
        expect(a).toBeGreaterThan(0);
        const [a2, t2] = fn(
          "nb_init_counts",
          readFileSync(join(FIX, "init-one-rejected.txt"), "utf8"),
        )
          .split(" ")
          .map(Number);
        expect(t2 - a2).toBe(1);
        expect(fn("nb_init_counts", "no summary here")).toBe("");
      });
    },
  );
});

describe.skipIf(!haveLoaderTools)("what nb hands to docker", () => {
  const refused = (...args: string[]) =>
    sh(`nb_compose_args_refused ${args.map((a) => `'${a}'`).join(" ")}`).stdout;

  test("nb compose refuses a global flag that names another project, and lets a subcommand's own flags through", () => {
    expect(refused("-p", "other", "ps")).toBe("-p");
    expect(refused("-pother", "ps")).toBe("-pother");
    expect(refused("--project-name=other", "ps")).toBe("--project-name=other");
    expect(refused("--project-name", "other", "ps")).toBe("--project-name");
    expect(refused("--project-directory", "/elsewhere", "ps")).toBe("--project-directory");
    expect(refused("-f", "other.yml", "config")).toBe("-f");
    expect(refused("--file=other.yml", "config")).toBe("--file=other.yml");
    expect(refused("--env-file", "other.env", "ps")).toBe("--env-file");
    // A flag that takes a value: the value is skipped, and what follows is still looked at.
    expect(refused("--profile", "portal", "-p", "other", "ps")).toBe("-p");
    expect(refused("--profile", "-p", "ps")).toBe("");
    // After the subcommand the same letters mean something else: logs -f is "follow".
    expect(refused("logs", "-f")).toBe("");
    expect(refused("up", "-p", "x")).toBe("");
    expect(refused("ps")).toBe("");
    expect(refused()).toBe("");
  });

  test("the nb command itself refuses it, before it looks for docker, and nb down takes no arguments", async () => {
    const home = newHome();
    const a = await run("nb", ["compose", "-p", "other", "ps"], home);
    expect(a.status, a.out).toBe(2);
    expect(a.out).toContain("does not take '-p'");
    const d = await run("nb", ["down", "-v"], home);
    expect(d.status, d.out).toBe(2);
    expect(d.out).toContain("takes no arguments");
  });

  test("the validator container: no network, memory without swap, CPU limits, first to be killed, this project's labels", () => {
    const lines = sh(
      "nb_validator_args img 160m 1.0 1000:1000 /in /out nemar-neurobagel-validate-1",
    ).stdout.split("\n");
    const pair = (flag: string, value: string) => {
      const at = lines.indexOf(flag);
      expect(at, flag).toBeGreaterThan(-1);
      expect(lines[at + 1], flag).toBe(value);
    };
    expect(lines[0]).toBe("run");
    expect(lines).toContain("--rm");
    pair("--network", "none");
    pair("--memory", "160m");
    pair("--memory-swap", "160m");
    pair("--cpus", "1.0");
    pair("--cpu-shares", "128");
    pair("--oom-score-adj", "500");
    pair("--pids-limit", "128");
    pair("--security-opt", "no-new-privileges:true");
    pair("--user", "1000:1000");
    pair("--name", "nemar-neurobagel-validate-1");
    expect(lines).toContain("com.docker.compose.project=nemar-neurobagel");
    expect(lines).toContain("/in:/input_data:ro");
    expect(lines).toContain("/out:/data");
    expect(lines.at(-1)).toBe("img");
  });

  test("the loader builds its one docker run from that function and from nothing else", () => {
    const src = readFileSync(join(BIN, "nb-load"), "utf8");
    expect(src).toContain("nb_validator_args");
    expect(src).not.toMatch(/docker run/);
  });
});

describe.skipIf(!composeOk)("the compose overlay, merged over the recipes file it pins", () => {
  // `docker compose config` needs no daemon. It validates the real merge: the overlay over the
  // real recipes v0.9.1 file, through the same wrapper every script uses.
  function configure(profiles: string[], envProfiles = "portal"): ComposeConfig {
    const home = tmp("compose-home");
    for (const d of ["recipes/init_data", "recipes/scripts", "recipes/vocab", "secrets"]) {
      mkdirSync(join(home, d), { recursive: true });
    }
    cpSync(
      join(FIX, "recipes-v0.9.1-docker-compose.yml"),
      join(home, "recipes/docker-compose.yml"),
    );
    const env = readFileSync(join(DEPLOY, ".env.example"), "utf8").replaceAll("@NB_HOME@", home);
    writeFileSync(
      join(home, ".env"),
      env
        .replace(/^NB_TUNNEL_TOKEN=$/m, "NB_TUNNEL_TOKEN=placeholder")
        .replace(/^COMPOSE_PROFILES=.*$/m, `COMPOSE_PROFILES=${envProfiles}`),
    );
    writeFileSync(join(home, "secrets/NB_GRAPH_ADMIN_PASSWORD.txt"), "x\n");
    writeFileSync(join(home, "secrets/NB_GRAPH_PASSWORD.txt"), "x\n");
    mkdirSync(join(home, "data/releases/r"), { recursive: true });
    symlinkSync("releases/r", join(home, "data/current"));
    writeFileSync(join(home, "recipes/local_nb_nodes.json"), "[]\n");
    const flags = profiles.flatMap((p) => ["--profile", `'${p}'`]);
    const r = spawnSync(
      "bash",
      ["-c", `. "${BIN}/nb-common.sh"; nb_compose ${flags.join(" ")} config --format json`],
      { encoding: "utf8", env: { ...process.env, NB_HOME: home } },
    );
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  }

  test("every container has a hard memory limit with no swap, a CPU limit and a pids limit", () => {
    const cfg = configure(["*"]);
    expect(cfg.name).toBe("nemar-neurobagel");
    for (const [name, svc] of Object.entries(cfg.services)) {
      expect(Number(svc.mem_limit), `${name} mem_limit`).toBeGreaterThan(0);
      expect(Number(svc.memswap_limit), `${name} memswap_limit`).toBe(Number(svc.mem_limit));
      expect(Number(svc.cpus), `${name} cpus`).toBeGreaterThan(0);
      expect(svc.pids_limit, `${name} pids_limit`).toBeGreaterThan(0);
      expect(svc.security_opt, name).toContain("no-new-privileges:true");
    }
  });

  test("every container is the first the kernel kills and the first to yield CPU", () => {
    const cfg = configure(["*"]);
    for (const [name, svc] of Object.entries(cfg.services)) {
      expect(svc.oom_score_adj, `${name} oom_score_adj`).toBe(500);
      expect(svc.cpu_shares, `${name} cpu_shares`).toBeLessThan(1024);
    }
  });

  test("the stack fits the 3 GiB ceiling at its peak: everything, the tunnel connector, and the helper that runs during a load", () => {
    const cfg = configure(["*"]);
    const MIB = 1024 * 1024;
    const limit = (name: string) => Number(cfg.services[name]?.mem_limit);
    const always = Object.entries(cfg.services)
      .filter(([name]) => name !== "init_data")
      .reduce((sum, [, svc]) => sum + Number(svc.mem_limit), 0);
    expect(always).toBe(2880 * MIB);
    // init_data (a reload) and the loader's validator (the same image and limit) run for seconds and
    // never together, because both run under one lock: the peak is the stack plus one of them.
    expect(always + limit("init_data")).toBe(3040 * MIB);
    expect(always + limit("init_data")).toBeLessThan(3 * 1024 * MIB);
    expect(always + limit("init_data") - limit("cloudflared")).toBe(2912 * MIB);
    // The GraphDB heap must fit its container with room for the JVM's own memory.
    const heap = Number.parseInt(
      readFileSync(join(DEPLOY, ".env.example"), "utf8").match(/^NB_GRAPH_MEMORY=(\d+)M$/m)?.[1] ??
        "0",
      10,
    );
    expect(heap * 1024 * 1024).toBeLessThan(Number(cfg.services.graph?.mem_limit) * 0.8);
  });

  test("ports are loopback-only, avoid Neurobagel's stock defaults, and GraphDB publishes none", () => {
    const cfg = configure(["*"]);
    const stockDefaults = new Set([8000, 8080, 3000, 7200]);
    for (const [name, svc] of Object.entries(cfg.services)) {
      for (const p of svc.ports ?? []) {
        expect(p.host_ip, `${name} ${p.published}`).toBe("127.0.0.1");
        expect(stockDefaults.has(Number(p.published)), `${name} publishes ${p.published}`).toBe(
          false,
        );
      }
    }
    expect(cfg.services.graph?.ports ?? []).toEqual([]);
    expect(cfg.services.cloudflared?.ports ?? []).toEqual([]);
  });

  test("the tunnel connector shares a network with the API and with nothing else", () => {
    const cfg = configure(["*"]);
    expect(Object.keys(cfg.networks).sort()).toEqual(["default", "tunnel"]);
    expect(Object.keys(cfg.services.cloudflared?.networks ?? {})).toEqual(["tunnel"]);
    const onTunnel = Object.entries(cfg.services)
      .filter(([, svc]) => Object.keys(svc.networks ?? {}).includes("tunnel"))
      .map(([name]) => name)
      .sort();
    expect(onTunnel).toEqual(["api", "cloudflared"]);
    // GraphDB is on the project network alone, so the connector is never one route away from it.
    expect(Object.keys(cfg.services.graph?.networks ?? {})).toEqual(["default"]);
  });

  test("the settings that must not be left to a file are fixed in the overlay", () => {
    const cfg = configure(["*"]);
    expect(cfg.services.api?.environment?.NB_RETURN_AGG).toBe("true");
    expect(cfg.services.federation?.environment?.NB_FEDERATE_REMOTE_PUBLIC_NODES).toBe("False");
    const input = cfg.services.init_data?.volumes?.find((v) => v.target === "/input_data");
    expect(input?.read_only).toBe(true);
    expect(input?.source).toEndWith("/data/current");
    for (const svc of Object.values(cfg.services)) {
      expect(svc.network_mode).toBeUndefined();
      expect(svc.privileged).toBeUndefined();
    }
  });

  test("the init image's base is pinned by digest, so a moved tag cannot change what validates a release", () => {
    const cfg = configure(["*"]);
    const contexts = cfg.services.init_data?.build?.additional_contexts ?? {};
    expect(contexts["python:3.11-slim"]).toMatch(/^docker-image:\/\/python@sha256:[0-9a-f]{64}$/);
  });

  test("the portal and the tunnel are profiles, off unless asked for", () => {
    const off = configure([], "");
    expect(Object.keys(off.services).sort()).toEqual(["api", "graph", "init_data"]);
    const portal = configure(["portal"], "");
    expect(Object.keys(portal.services).sort()).toEqual([
      "api",
      "federation",
      "graph",
      "init_data",
      "query_federation",
    ]);
    const tunnel = configure(["tunnel"], "");
    expect(Object.keys(tunnel.services)).toContain("cloudflared");
    expect(tunnel.services.cloudflared?.environment?.TUNNEL_TOKEN).toBeDefined();
    // The shipped .env enables the portal and leaves the tunnel off.
    expect(Object.keys(configure([]).services).sort()).toEqual([
      "api",
      "federation",
      "graph",
      "init_data",
      "query_federation",
    ]);
  });

  test("every long-running service has a restart policy and a health check", () => {
    const cfg = configure(["*"]);
    for (const [name, svc] of Object.entries(cfg.services)) {
      if (name === "init_data") {
        expect(svc.restart).toBe("no");
        continue;
      }
      expect(svc.restart, name).toBe("unless-stopped");
      expect(svc.healthcheck, name).toBeDefined();
    }
  });
});
