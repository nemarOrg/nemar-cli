/**
 * The Neurobagel node deployment (epic #1586, Phase 3, ADR 0082): script-level tests.
 *
 * These run the REAL scripts in deploy/neurobagel/bin against real directories and a real HTTP
 * server, and read real captured output of the stock containers. Nothing replaces the loader's
 * logic. What they cannot reach is Docker itself: the reload, the status command and the guard
 * drive containers, so they were exercised on nemaring and the measured results are recorded in
 * the pull request and in deploy/neurobagel/README.md. The compose validation below runs wherever
 * `docker compose` exists (a laptop with Docker, CI, the host) and is skipped, visibly, elsewhere.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DEPLOY = join(ROOT, "deploy/neurobagel");
const BIN = join(DEPLOY, "bin");
const FIX = join(import.meta.dir, "fixtures/neurobagel-node");
const EXAMPLE = join(FIX, "example_synthetic_pheno-bids-derivatives.jsonld");

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

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `${prefix}-`));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

type Artifact = { name: string; kind: string; sha256?: string; bytes: number };
type IndexDataset = { id: string; fingerprint: string; artifacts: Artifact[] };
type ArtifactIndex = { schema: string; generated_at: string; datasets: IndexDataset[] };
type ComposeService = {
  mem_limit: number | string;
  memswap_limit: number | string;
  cpus: number | string;
  pids_limit: number;
  security_opt?: string[];
  ports?: { host_ip: string; published: string | number }[];
  environment?: Record<string, string>;
  volumes?: { target: string; source: string; read_only?: boolean }[];
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
  const r = spawnSync(join(DEPLOY, "tools/build-index.sh"), [dir, "2026-10-02T03:00:00Z"], {
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
  opts: { delayMs?: number; missing?: string[]; corrupt?: string[] } = {},
): { url: string; log: Served[]; stop: () => void } {
  const log: Served[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname.slice(1);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      log.push({ path, headers });
      if (opts.delayMs && path !== "index.json") await Bun.sleep(opts.delayMs);
      if (opts.missing?.includes(path)) return new Response("gone", { status: 404 });
      const file = Bun.file(join(dir, path));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      if (opts.corrupt?.includes(path)) return new Response('{"truncated":');
      return new Response(file);
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, log, stop: () => server.stop(true) };
}

describe("shell hygiene", () => {
  test.skipIf(!haveShellcheck)("every script is shellcheck-clean", async () => {
    const files = [
      ...readdirSync(BIN).map((f) => join(BIN, f)),
      join(DEPLOY, "tools/build-index.sh"),
    ];
    const r = spawnSync("shellcheck", ["-x", "-P", "SCRIPTDIR", "-s", "bash", ...files], {
      encoding: "utf8",
    });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

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
      ]) {
        const home = newHome();
        const r = await run(s, ["--help"], home);
        expect(r.status, `${s} --help`).toBe(0);
        expect(r.out.length).toBeGreaterThan(40);
        expect(existsSync(join(home, "data"))).toBe(false);
      }
    },
  );
});

describe("pins", () => {
  const pins = readFileSync(join(DEPLOY, "pins.env"), "utf8");
  const get = (k: string) => pins.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "";

  test("every image is pinned by tag and by digest", async () => {
    for (const k of ["NB_NAPI_TAG", "NB_FAPI_TAG", "NB_QUERY_TAG"]) {
      expect(get(k), k).toMatch(/^v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
    }
    for (const k of ["NB_GRAPHDB_IMAGE", "NB_CLOUDFLARED_IMAGE"]) {
      expect(get(k), k).toMatch(/^[a-z0-9/.-]+:[0-9][0-9.]*@sha256:[0-9a-f]{64}$/);
    }
  });

  test("recipes is pinned to a tag and a full commit hash", async () => {
    expect(get("NB_RECIPES_TAG")).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(get("NB_RECIPES_COMMIT")).toMatch(/^[0-9a-f]{40}$/);
  });

  test("the .env template holds placeholders only", async () => {
    const env = readFileSync(join(DEPLOY, ".env.example"), "utf8");
    expect(env).toContain("@NB_HOME@");
    expect(env).toMatch(/^NB_TUNNEL_TOKEN=$/m);
    expect(env).toMatch(/^NB_RETURN_AGG=true$/m);
    expect(env).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/); // a pasted connector token
    expect(env).not.toMatch(/PASSWORD=.+/);
  });
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
    const server = serve(src);
    const r = await run("nb-load", ["--source", server.url], home);
    expect(r.status, r.out).toBe(0);
    expect(currentRelease(home)).toBe(first);
    expect(readdirSync(join(home, "data/releases"))).toHaveLength(1);
    expect(lastLoad(home).outcome).toBe("unchanged");
    expect(server.log.map((l) => l.path)).toEqual(["index.json"]);
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
    spawnSync(join(DEPLOY, "tools/build-index.sh"), [next, "2026-10-02T04:00:00Z"]);
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
    spawnSync(join(DEPLOY, "tools/build-index.sh"), [src, "2026-10-02T05:00:00Z"]);
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

  test.each([
    ["the wrong schema", (i: ArtifactIndex) => ({ ...i, schema: "something-else/1" })],
    [
      "a path traversal in an artifact name",
      (i: ArtifactIndex) => {
        i.datasets[0].artifacts[0].name = "../escape.jsonld";
        return i;
      },
    ],
    [
      "a name that does not match the dataset id",
      (i: ArtifactIndex) => {
        i.datasets[0].artifacts[0].name = "other.jsonld";
        return i;
      },
    ],
    [
      "a duplicate dataset id",
      (i: ArtifactIndex) => ({ ...i, datasets: [i.datasets[0], i.datasets[0]] }),
    ],
    [
      "a missing sha256",
      (i: ArtifactIndex) => {
        i.datasets[0].artifacts[0].sha256 = undefined;
        return i;
      },
    ],
    [
      "a dataset with no jsonld artifact",
      (i: ArtifactIndex) => {
        i.datasets[0].artifacts[0].kind = "dictionary";
        return i;
      },
    ],
    [
      "an empty fingerprint",
      (i: ArtifactIndex) => {
        i.datasets[0].fingerprint = "";
        return i;
      },
    ],
  ])("an index with %s is refused and nothing is touched", async (_name, mutate) => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001", "nm000002"]);
    writeIndex(src, mutate(readIndex(src)));
    const r = await run("nb-load", ["--source", src], home);
    expect(r.status, r.out).toBe(3);
    expect(existsSync(join(home, "data/current"))).toBe(false);
    expect(lastLoad(home).outcome).toBe("source-failed");
  });

  test("an index that is not JSON, and an empty index, are refused", async () => {
    const home = newHome();
    const src = tmp("src");
    writeFileSync(join(src, "index.json"), "{not json");
    expect((await run("nb-load", ["--source", src], home)).status).toBe(3);
    writeIndex(src, { schema: "nemar-neurobagel-artifact-index/1", datasets: [] });
    const r = await run("nb-load", ["--source", src], home);
    expect(r.status, r.out).toBe(3);
    expect(r.out).toContain("zero datasets");
  });

  test("a dataset document that is not a Neurobagel dataset is refused before publication", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    const doc = JSON.parse(readFileSync(join(src, "nm000001.jsonld"), "utf8"));
    doc.hasSamples = [];
    writeFileSync(join(src, "nm000001.jsonld"), JSON.stringify(doc));
    spawnSync(join(DEPLOY, "tools/build-index.sh"), [src, "2026-10-02T03:00:00Z"]);
    const r = await run("nb-load", ["--source", src], home);
    expect(r.status, r.out).toBe(4);
    expect(existsSync(join(home, "data/current"))).toBe(false);
  });

  test("two datasets with the same identifier are refused (the stock initialiser would keep one)", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001", "nm000002"]);
    const a = JSON.parse(readFileSync(join(src, "nm000001.jsonld"), "utf8"));
    const b = JSON.parse(readFileSync(join(src, "nm000002.jsonld"), "utf8"));
    b.identifier = a.identifier;
    writeFileSync(join(src, "nm000002.jsonld"), JSON.stringify(b));
    spawnSync(join(DEPLOY, "tools/build-index.sh"), [src, "2026-10-02T03:00:00Z"]);
    const r = await run("nb-load", ["--source", src], home);
    expect(r.status, r.out).toBe(4);
    expect(r.out).toContain("duplicate dataset identifier");
  });

  test("mass removal is refused, and accepted only when asked for", async () => {
    const home = newHome();
    const src = tmp("src");
    const ids = Array.from({ length: 10 }, (_, i) => `nm0000${String(i + 10)}`);
    makeSource(src, ids);
    expect((await run("nb-load", ["--source", src], home)).status).toBe(0);
    const before = currentRelease(home);
    const small = tmp("small");
    makeSource(small, ids.slice(0, 2));
    const refused = await run("nb-load", ["--source", small], home);
    expect(refused.status, refused.out).toBe(3);
    expect(refused.out).toContain("--allow-mass-removal");
    expect(currentRelease(home)).toBe(before);
    const accepted = await run("nb-load", ["--source", small, "--allow-mass-removal"], home);
    expect(accepted.status, accepted.out).toBe(0);
    expect(releaseFiles(home, currentRelease(home) as string)).toHaveLength(2);
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
  });
});

describe.skipIf(!haveLoaderTools)("atomicity, lock, freeze", () => {
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
      env: { ...process.env, NB_HOME: home, NB_VALIDATE: "jq", NB_RELOAD: "0", NB_SOURCE: "" },
    });
    const code: number = await new Promise((res) => child.on("close", res));
    done = true;
    await reader;
    expect(code).toBe(0);
    expect(torn).toBe(0);
    expect(reads).toBeGreaterThan(20);
    expect(seen.size).toBe(2); // it observed both the old and the new release, never a half
  });

  test("two loaders at once: one runs, the other exits 75 and changes nothing", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001", "nm000002", "nm000003", "nm000004"]);
    const server = serve(src, { delayMs: 400 });
    const env = { ...process.env, NB_HOME: home, NB_VALIDATE: "jq", NB_RELOAD: "0", NB_SOURCE: "" };
    const one = spawn(join(BIN, "nb-load"), ["--source", server.url], { env });
    await Bun.sleep(700); // the first holds the lock, mid-download
    const second = await run("nb-load", ["--source", server.url], home);
    const code: number = await new Promise((res) => one.on("close", res));
    expect(second.status, second.out).toBe(75);
    expect(second.out).toContain("another loader or reload is running");
    expect(code).toBe(0);
    expect(readdirSync(join(home, "data/releases"))).toHaveLength(1);
    expect(existsSync(join(home, "state/lock.d"))).toBe(false); // released on exit
  });

  test("a lock whose holder has died is taken over, once", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    const dead = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" });
    const pid = dead.stdout.trim(); // that process has exited
    mkdirSync(join(home, "state/lock.d"), { recursive: true });
    writeFileSync(join(home, "state/lock.d/pid"), `${pid}\n`);
    const r = await run("nb-load", ["--source", src], home);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("taking over a stale lock");
    expect(existsSync(join(home, "state/lock.d"))).toBe(false);
  });

  test("a live lock is respected even when its directory is old", async () => {
    const home = newHome();
    const src = tmp("src");
    makeSource(src, ["nm000001"]);
    mkdirSync(join(home, "state/lock.d"), { recursive: true });
    writeFileSync(join(home, "state/lock.d/pid"), `${process.pid}\n`); // this test process is alive
    const r = await run("nb-load", ["--source", src], home);
    expect(r.status, r.out).toBe(75);
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
    const r = spawnSync(
      "bash",
      [
        "-c",
        `. "${BIN}/nb-common.sh"; nb_init_dirs; nb_record_reload_failure "$1" "$2"`,
        "x",
        release,
        "synthetic reason",
      ],
      { encoding: "utf8", env: { ...process.env, NB_HOME: home } },
    );
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
    symlinkSync(`releases/${good}`, join(home, "data/current.tmp"));
    rmSync(join(home, "data/current"));
    spawnSync("mv", [join(home, "data/current.tmp"), join(home, "data/current")]);
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
      "863ab09e08571ec4cb43c9237ab3e15a5b86823aaf9da1b4c174cd81cd842bd8",
    );
    expect(existsSync(join(home, "state/pending-reload"))).toBe(false); // nothing to reload yet
    const again = await run("nb-load", ["--seed-example"], home);
    expect(again.status).toBe(2);
    expect(currentRelease(home)).toBe(rel);
  });

  test("a backup restores byte for byte, verifies itself, and keeps configuration it must not replace", async () => {
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
    const archive = join(home, "backups", archives[0]);
    expect(lstatSync(archive).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(home, "backups")).mode & 0o777).toBe(0o700);

    // Disaster: the release and the manifests are gone; .env was edited since.
    rmSync(join(home, "data"), { recursive: true });
    rmSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, ".env"), "COMPOSE_PROJECT_NAME=nemar-neurobagel\nNB_X=edited-since\n");

    // docker must not be on the PATH here: a restore refuses while this project's containers run,
    // and on a machine that has the real node running that check would (rightly) fire.
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
    const noDocker = { PATH: bare };

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
});

describe("reading what the stock containers print (real captured output)", () => {
  const fn = (name: string, input: string): string => {
    const r = spawnSync("bash", ["-c", `. "${BIN}/nb-common.sh"; ${name}`], {
      input,
      encoding: "utf8",
      env: { ...process.env, NB_HOME: tmp("h") },
    });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };

  test.skipIf(!has("bash", ["-c", "true"]))(
    "the graph log of a first start is a completed load",
    async () => {
      const log = readFileSync(join(FIX, "graph-setup-first-start.log"), "utf8");
      expect(fn("nb_graph_log_verdict", log)).toBe("loaded");
    },
  );

  test.skipIf(!has("bash", ["-c", "true"]))(
    "the same log cut before the end is still pending",
    async () => {
      const log = readFileSync(join(FIX, "graph-setup-first-start.log"), "utf8");
      const cut = log.split("\n").slice(0, 40).join("\n");
      expect(fn("nb_graph_log_verdict", cut)).toBe("pending");
      expect(fn("nb_graph_log_verdict", "")).toBe("pending");
    },
  );

  test.skipIf(!has("bash", ["-c", "true"]))(
    "the stock upload script's own failure output is a failed load although it exits 0",
    async () => {
      const fixture = join(FIX, "graph-setup-upload-failure.log");
      if (!existsSync(fixture)) throw new Error(`missing fixture ${fixture}`);
      const verdict = fn("nb_graph_log_verdict", readFileSync(fixture, "utf8"));
      expect(verdict).toStartWith("failed: the graph reported upload errors");
      expect(verdict).toContain("Upload failed");
    },
  );

  test.skipIf(!has("bash", ["-c", "true"]))(
    "initialiser summaries parse to accepted and total counts",
    async () => {
      const ok = readFileSync(join(FIX, "init-all-accepted.log"), "utf8");
      const [a, t] = fn("nb_init_counts", ok).split(" ").map(Number);
      expect(a).toBe(t);
      expect(a).toBeGreaterThan(0);
      const skipped = readFileSync(join(FIX, "init-one-rejected.log"), "utf8");
      const [a2, t2] = fn("nb_init_counts", skipped).split(" ").map(Number);
      expect(t2 - a2).toBe(1);
      expect(fn("nb_init_counts", "no summary here")).toBe("");
    },
  );
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

  test("every container has a hard memory limit with no swap, a CPU limit and a pids limit", async () => {
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

  test("the always-on stack fits the 3 GiB ceiling, tunnel connector included", async () => {
    const cfg = configure(["*"]);
    const total = Object.entries(cfg.services)
      .filter(([name]) => name !== "init_data") // runs for seconds; measured 30 MiB
      .reduce((sum, [, svc]) => sum + Number(svc.mem_limit), 0);
    expect(total).toBeLessThanOrEqual(3 * 1024 * 1024 * 1024);
    // The GraphDB heap must fit its container with room for the JVM's own memory.
    const heap = Number.parseInt(
      readFileSync(join(DEPLOY, ".env.example"), "utf8").match(/^NB_GRAPH_MEMORY=(\d+)M$/m)?.[1] ??
        "0",
      10,
    );
    expect(heap * 1024 * 1024).toBeLessThan(Number(cfg.services.graph.mem_limit) * 0.8);
  });

  test("ports are loopback-only, avoid the ports Infisical and Umami hold, and GraphDB publishes none", async () => {
    const cfg = configure(["*"]);
    const taken = new Set([8080, 3000]);
    for (const [name, svc] of Object.entries(cfg.services)) {
      for (const p of svc.ports ?? []) {
        expect(p.host_ip, `${name} ${p.published}`).toBe("127.0.0.1");
        expect(taken.has(Number(p.published)), `${name} publishes ${p.published}`).toBe(false);
      }
    }
    expect(cfg.services.graph.ports ?? []).toEqual([]);
    expect(cfg.services.cloudflared.ports ?? []).toEqual([]);
    expect(Object.keys(cfg.networks)).toEqual(["default"]);
  });

  test("the settings that must not be left to a file are fixed in the overlay", async () => {
    const cfg = configure(["*"]);
    expect(cfg.services.api.environment.NB_RETURN_AGG).toBe("true");
    expect(cfg.services.federation.environment.NB_FEDERATE_REMOTE_PUBLIC_NODES).toBe("False");
    const input = cfg.services.init_data.volumes.find((v) => v.target === "/input_data");
    expect(input.read_only).toBe(true);
    expect(input.source).toEndWith("/data/current");
    for (const svc of Object.values(cfg.services)) {
      expect(svc.network_mode).toBeUndefined();
      expect(svc.privileged).toBeUndefined();
    }
  });

  test("the portal and the tunnel are profiles, off unless asked for", async () => {
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

  test("every long-running service has a restart policy and a health check", async () => {
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
