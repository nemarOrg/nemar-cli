/**
 * The git-annex special remote for an authenticated NEMAR data host, driven the way git-annex
 * drives it: a real child process (`src/git-annex-remote-nemar.ts`) whose stdin and stdout
 * carry the protocol, talking to real HTTP servers on loopback (test/helpers/data-host-standin).
 *
 * The property under test is where the API key goes. The data host answers a Bearer request,
 * a second server on another port (another origin) stands for the storage address a large
 * object redirects to and refuses any request that carries `Authorization`, and every request
 * to either is recorded with the credential header it carried.
 *
 * ADR 0114. The end-to-end run with real git and git-annex is test/data-host-e2e.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataHostStandin, type StandinOptions, patternBytes } from "./helpers/data-host-standin";
import { fakeApiKey, makeConfigDir } from "./helpers/nemar-account";

const REMOTE = join(import.meta.dir, "..", "src", "git-annex-remote-nemar.ts");
const DATASET = "np099999";
const API_KEY = fakeApiKey();

const SMALL_KEY =
  "SHA256E-s29--0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9.bin";
const BIG_KEY =
  "SHA256E-s5000--1f2e3d4c5b6a79880716253443526170899a8b7c6d5e4f30211203948576a6b5.bin";
const SMALL = patternBytes(29, 1);
const BIG = patternBytes(5000, 2);

let root: string;
let configDir: string;
let signedOutDir: string;
let host: DataHostStandin;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nemar-remote-test-"));
  configDir = makeConfigDir(API_KEY);
  signedOutDir = makeConfigDir(null);
  host = standin();
});

afterAll(() => {
  host.stop();
  rmSync(root, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  rmSync(signedOutDir, { recursive: true, force: true });
});

function standin(extra: Partial<StandinOptions> = {}): DataHostStandin {
  return new DataHostStandin({
    apiKey: API_KEY,
    datasetId: DATASET,
    objects: new Map([
      [SMALL_KEY, SMALL],
      [BIG_KEY, BIG],
    ]),
    ...extra,
  });
}

/**
 * A body that is sent in pieces with a pause before the last, so the server cannot know its
 * length up front and answers chunked, with no Content-Length: the client sees the size only
 * by counting what arrives.
 */
function chunked(...pieces: Uint8Array[]): Response {
  let at = 0;
  return new Response(
    new ReadableStream({
      async pull(controller) {
        if (at < pieces.length) {
          controller.enqueue(pieces[at++]);
          return;
        }
        await Bun.sleep(20);
        controller.close();
      },
    }),
  );
}

/** git-annex's side of the conversation, over the real child process. */
class Session {
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private readonly queue: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;
  private ended = false;
  /** Everything the process wrote on stdout, in order. */
  readonly transcript: string[] = [];
  private stderrText: Promise<string>;
  private pump: Promise<void>;

  constructor(options: { hosts?: string; config?: string } = {}) {
    this.proc = Bun.spawn(["bun", "run", REMOTE], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NEMAR_CONFIG_DIR: options.config ?? configDir,
        NEMAR_DATA_HOSTS: options.hosts ?? host.origin,
        NEMAR_NO_UPDATE_CHECK: "1",
      },
    });
    this.stderrText = new Response(this.proc.stderr as ReadableStream).text();
    this.pump = this.read();
  }

  private async read(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        this.push(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
      }
    }
    if (buffer !== "") this.push(buffer);
    this.ended = true;
    this.waiter?.(null);
  }

  private push(line: string): void {
    this.transcript.push(line);
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(line);
    } else {
      this.queue.push(line);
    }
  }

  send(line: string): void {
    const stdin = this.proc.stdin as { write: (s: string) => number; flush: () => unknown };
    stdin.write(`${line}\n`);
    stdin.flush();
  }

  /** The next line git-annex would read; fails the test when none comes in time. */
  async next(timeoutMs = 20_000): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    if (this.ended) throw new Error("the remote closed its output");
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`no line from the remote within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiter = (line) => {
        clearTimeout(timer);
        if (line === null) reject(new Error("the remote closed its output"));
        else resolve(line);
      };
    });
  }

  /** Read lines until one starts with `prefix`; the lines before it are returned too. */
  async until(prefix: string): Promise<{ line: string; before: string[] }> {
    const before: string[] = [];
    while (true) {
      const line = await this.next();
      if (line.startsWith(prefix)) return { line, before };
      before.push(line);
    }
  }

  /** Answer the GETCONFIG requests of INITREMOTE or PREPARE and return the final reply. */
  async configure(command: "INITREMOTE" | "PREPARE", hostValue: string, dataset: string) {
    this.send(command);
    const answers: Record<string, string> = { host: hostValue, dataset };
    for (let i = 0; i < 2; i++) {
      const request = await this.next();
      const name = request.replace(/^GETCONFIG /, "");
      expect(request.startsWith("GETCONFIG ")).toBe(true);
      this.send(`VALUE ${answers[name] ?? ""}`);
    }
    return await this.next();
  }

  /** The first line, then PREPARE with the configured host. */
  async ready(hostValue = host.origin, dataset = DATASET): Promise<void> {
    expect(await this.next()).toBe("VERSION 1");
    expect(await this.configure("PREPARE", hostValue, dataset)).toBe("PREPARE-SUCCESS");
  }

  /** Close git-annex's side and wait for the process; returns its exit code and stderr. */
  async close(): Promise<{ code: number; stderr: string }> {
    (this.proc.stdin as { end: () => unknown }).end();
    const code = await this.proc.exited;
    await this.pump;
    return { code, stderr: await this.stderrText };
  }

  async everything(): Promise<string> {
    const { stderr } = await this.close();
    return `${this.transcript.join("\n")}\n${stderr}`;
  }
}

function outFile(name: string): string {
  return join(root, `${name}-${crypto.randomUUID()}`);
}

describe("the protocol", () => {
  test("starts with VERSION 1 and ends cleanly when git-annex closes its side", async () => {
    const s = new Session();
    expect(await s.next()).toBe("VERSION 1");
    expect((await s.close()).code).toBe(0);
  });

  test("answers cost, availability, configs and extensions, and refuses what it does not know", async () => {
    const s = new Session();
    expect(await s.next()).toBe("VERSION 1");
    s.send("EXTENSIONS INFO ASYNC");
    expect(await s.next()).toBe("EXTENSIONS");
    s.send("GETCOST");
    expect(await s.next()).toBe("COST 200");
    s.send("GETAVAILABILITY");
    expect(await s.next()).toBe("AVAILABILITY GLOBAL");
    s.send("LISTCONFIGS");
    const configs: string[] = [];
    for (let line = await s.next(); line !== "CONFIGEND"; line = await s.next()) configs.push(line);
    expect(configs.map((l) => l.split(" ")[1])).toEqual(["host", "dataset"]);
    s.send("EXPORTSUPPORTED");
    expect(await s.next()).toBe("EXPORTSUPPORTED-FAILURE");
    s.send("IMPORTSUPPORTED");
    expect(await s.next()).toBe("IMPORTSUPPORTED-FAILURE");
    s.send("WHEREIS somekey");
    expect(await s.next()).toBe("WHEREIS-FAILURE");
    s.send("CLAIMURL https://example.org/x");
    expect(await s.next()).toBe("CLAIMURL-FAILURE");
    s.send("SOMETHING-NEW with arguments");
    expect(await s.next()).toBe("UNSUPPORTED-REQUEST");
    s.send("");
    s.send("GETCOST");
    expect(await s.next()).toBe("COST 200");
    expect((await s.close()).code).toBe(0);
  });

  test("an ERROR from git-annex ends the remote with a failure status", async () => {
    const s = new Session();
    expect(await s.next()).toBe("VERSION 1");
    s.send("ERROR the protocol went wrong");
    expect((await s.close()).code).toBe(1);
  });

  test("a line that arrives while a GETCONFIG waits for its VALUE is handled afterwards, in order", async () => {
    const s = new Session();
    expect(await s.next()).toBe("VERSION 1");
    s.send("PREPARE");
    expect(await s.next()).toBe("GETCONFIG host");
    // Interleaved: a request lands before the reply to the question the remote asked.
    s.send("GETCOST");
    s.send(`VALUE ${host.origin}`);
    expect(await s.next()).toBe("GETCONFIG dataset");
    s.send(`VALUE ${DATASET}`);
    expect(await s.next()).toBe("PREPARE-SUCCESS");
    expect(await s.next()).toBe("COST 200");
    expect((await s.close()).code).toBe(0);
  });

  test("a VALUE nobody asked for is ignored", async () => {
    const s = new Session();
    expect(await s.next()).toBe("VERSION 1");
    s.send("VALUE stray");
    s.send("GETCOST");
    expect(await s.next()).toBe("COST 200");
    await s.close();
  });

  test("GETINFO reports the host and dataset once prepared", async () => {
    const s = new Session();
    await s.ready();
    s.send("GETINFO");
    const lines: string[] = [];
    for (let line = await s.next(); line !== "INFOEND"; line = await s.next()) lines.push(line);
    expect(lines).toEqual([
      "INFOFIELD host",
      `INFOVALUE ${host.origin}`,
      "INFOFIELD dataset",
      `INFOVALUE ${DATASET}`,
    ]);
    await s.close();
  });
});

describe("what the repository's configuration may name", () => {
  test("a host on the CLI's list and a well-formed dataset id initialize without a request", async () => {
    const before = host.dataSeen.length;
    const s = new Session();
    expect(await s.next()).toBe("VERSION 1");
    expect(await s.configure("INITREMOTE", "https://private.nemar.org", DATASET)).toBe(
      "INITREMOTE-SUCCESS",
    );
    await s.close();
    expect(host.dataSeen.length).toBe(before);
  });

  test("the list's own exact spelling is required: path, userinfo, a lookalike or another scheme", async () => {
    const refused = [
      "https://private.nemar.org/extra",
      "https://private.nemar.org/",
      "https://user:pw@private.nemar.org",
      "https://private.nemar.org.evil.example",
      "https://evilprivate.nemar.org",
      "http://private.nemar.org",
      "http://example.com",
      "ftp://private.nemar.org",
      "private.nemar.org",
      "not a url",
    ];
    // The one spelling with a trailing slash is the same origin, so it is the exception.
    const s = new Session();
    expect(await s.next()).toBe("VERSION 1");
    for (const value of refused.filter((v) => v !== "https://private.nemar.org/")) {
      const reply = await s.configure("INITREMOTE", value, DATASET);
      expect([value, reply.startsWith("INITREMOTE-FAILURE ")]).toEqual([value, true]);
    }
    expect(await s.configure("INITREMOTE", "https://private.nemar.org/", DATASET)).toBe(
      "INITREMOTE-SUCCESS",
    );
    await s.close();
  });

  test("a host that is not on the list gets no request, however the rest of the conversation goes", async () => {
    const foreign = standin();
    try {
      const s = new Session({ hosts: host.origin });
      expect(await s.next()).toBe("VERSION 1");
      // A real loopback server, but its origin is not on this CLI's list.
      const reply = await s.configure("PREPARE", foreign.origin, DATASET);
      expect(reply.startsWith("PREPARE-FAILURE ")).toBe(true);
      s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${outFile("refused")}`);
      expect((await s.next()).startsWith(`TRANSFER-FAILURE RETRIEVE ${SMALL_KEY} `)).toBe(true);
      s.send(`CHECKPRESENT ${SMALL_KEY}`);
      expect((await s.next()).startsWith(`CHECKPRESENT-UNKNOWN ${SMALL_KEY} `)).toBe(true);
      await s.close();
      expect(foreign.dataSeen).toEqual([]);
      expect(foreign.storageSeen).toEqual([]);
    } finally {
      foreign.stop();
    }
  });

  test("an http host is refused even when it is on this machine, unless the environment lists it", async () => {
    const s = new Session({ hosts: "" });
    expect(await s.next()).toBe("VERSION 1");
    const reply = await s.configure("INITREMOTE", host.origin, DATASET);
    expect(reply.startsWith("INITREMOTE-FAILURE ")).toBe(true);
    await s.close();
  });

  test("an environment entry that is not a loopback http or an https origin adds nothing", async () => {
    const s = new Session({
      hosts: "http://example.com,http://192.168.0.5:8080,https://x.example/path",
    });
    expect(await s.next()).toBe("VERSION 1");
    for (const value of ["http://example.com", "http://192.168.0.5:8080", "https://x.example"]) {
      const reply = await s.configure("INITREMOTE", value, DATASET);
      expect([value, reply.startsWith("INITREMOTE-FAILURE ")]).toEqual([value, true]);
    }
    await s.close();
  });

  test("a dataset setting that is not a dataset id is refused", async () => {
    const s = new Session();
    expect(await s.next()).toBe("VERSION 1");
    for (const dataset of [
      "NP099999",
      "np99999",
      "np0999999",
      "n1099999",
      "../x",
      "np099999/x",
      "",
    ]) {
      const reply = await s.configure("INITREMOTE", host.origin, dataset);
      expect([dataset, reply.startsWith("INITREMOTE-FAILURE ")]).toEqual([dataset, true]);
    }
    await s.close();
  });

  test("a missing host or dataset setting is refused", async () => {
    const s = new Session();
    expect(await s.next()).toBe("VERSION 1");
    expect((await s.configure("PREPARE", "", DATASET)).startsWith("PREPARE-FAILURE ")).toBe(true);
    expect((await s.configure("PREPARE", host.origin, "")).startsWith("PREPARE-FAILURE ")).toBe(
      true,
    );
    await s.close();
  });
});

describe("the stored API key", () => {
  test("PREPARE without a stored key fails and says how to sign in", async () => {
    const s = new Session({ config: signedOutDir });
    expect(await s.next()).toBe("VERSION 1");
    const reply = await s.configure("PREPARE", host.origin, DATASET);
    expect(reply.startsWith("PREPARE-FAILURE ")).toBe(true);
    expect(reply).toContain("nemar auth login");
    await s.close();
  });

  test("a key the data host refuses is reported as refused, for a transfer and for a check", async () => {
    const wrongKey = makeConfigDir(fakeApiKey());
    try {
      const s = new Session({ config: wrongKey });
      await s.ready();
      const file = outFile("wrong-key");
      s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${file}`);
      const failure = await s.next();
      expect(failure.startsWith(`TRANSFER-FAILURE RETRIEVE ${SMALL_KEY} `)).toBe(true);
      expect(failure).toContain("refused the API key");
      expect(existsSync(file)).toBe(false);
      s.send(`CHECKPRESENT ${SMALL_KEY}`);
      expect((await s.next()).startsWith(`CHECKPRESENT-UNKNOWN ${SMALL_KEY} `)).toBe(true);
      await s.close();
    } finally {
      rmSync(wrongKey, { recursive: true, force: true });
    }
  });

  test("a request before PREPARE is answered as not prepared, with no request made", async () => {
    const before = host.dataSeen.length;
    const s = new Session();
    expect(await s.next()).toBe("VERSION 1");
    s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${outFile("early")}`);
    expect((await s.next()).startsWith(`TRANSFER-FAILURE RETRIEVE ${SMALL_KEY} `)).toBe(true);
    s.send(`CHECKPRESENT ${SMALL_KEY}`);
    expect((await s.next()).startsWith(`CHECKPRESENT-UNKNOWN ${SMALL_KEY} `)).toBe(true);
    await s.close();
    expect(host.dataSeen.length).toBe(before);
  });
});

describe("TRANSFER RETRIEVE", () => {
  test("a small object is read from the data host with the Bearer key", async () => {
    const s = new Session();
    await s.ready();
    const file = outFile("small");
    const before = host.dataSeen.length;
    s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${file}`);
    const { line } = await s.until("TRANSFER-");
    expect(line).toBe(`TRANSFER-SUCCESS RETRIEVE ${SMALL_KEY}`);
    expect(new Uint8Array(readFileSync(file))).toEqual(SMALL);
    const requests = host.dataSeen.slice(before);
    expect(requests).toEqual([
      { method: "GET", path: `/o/${DATASET}/${SMALL_KEY}`, authorization: `Bearer ${API_KEY}` },
    ]);
    await s.close();
  });

  test("a file name with spaces is written where git-annex said", async () => {
    const s = new Session();
    await s.ready();
    const file = `${outFile("with space")} and more`;
    s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${file}`);
    expect((await s.until("TRANSFER-")).line).toBe(`TRANSFER-SUCCESS RETRIEVE ${SMALL_KEY}`);
    expect(new Uint8Array(readFileSync(file))).toEqual(SMALL);
    await s.close();
  });

  test("a large object is redirected to another origin, which is sent no Authorization", async () => {
    const own = standin();
    try {
      const s = new Session({ hosts: own.origin });
      await s.ready(own.origin);
      const file = outFile("big");
      s.send(`TRANSFER RETRIEVE ${BIG_KEY} ${file}`);
      const { line, before } = await s.until("TRANSFER-");
      expect(line).toBe(`TRANSFER-SUCCESS RETRIEVE ${BIG_KEY}`);
      // Progress ends at the full size.
      const progress = before
        .filter((l) => l.startsWith("PROGRESS "))
        .map((l) => Number(l.slice(9)));
      expect(progress.at(-1)).toBe(BIG.byteLength);
      expect(new Uint8Array(readFileSync(file))).toEqual(BIG);

      expect(own.dataSeen.map((r) => [r.method, r.authorization])).toEqual([
        ["GET", `Bearer ${API_KEY}`],
      ]);
      expect(own.storageSeen).toHaveLength(1);
      expect(own.storageSeen[0].authorization).toBeNull();
      expect(JSON.stringify(own.storageSeen)).not.toContain(API_KEY);

      // Nothing the remote printed holds the key or the address it was redirected to.
      const output = await s.everything();
      expect(output).not.toContain(API_KEY);
      for (const token of own.redirectTokens) expect(output).not.toContain(token);
      expect(output).not.toContain(own.storageOrigin);
    } finally {
      own.stop();
    }
  });

  test("a storage address that answers 404 fails the transfer without naming the address", async () => {
    const own = standin({
      override: (_req, key, storage) =>
        key === BIG_KEY
          ? new Response(null, {
              status: 302,
              headers: { Location: `${storage}/blob/missing?X-Signature=secretsig` },
            })
          : undefined,
    });
    try {
      const s = new Session({ hosts: own.origin });
      await s.ready(own.origin);
      s.send(`TRANSFER RETRIEVE ${BIG_KEY} ${outFile("storage-404")}`);
      const failure = (await s.until("TRANSFER-")).line;
      expect(failure.startsWith(`TRANSFER-FAILURE RETRIEVE ${BIG_KEY} `)).toBe(true);
      expect(failure).toContain("status 404");
      expect(failure).not.toContain("secretsig");
      expect(failure).not.toContain(own.storageOrigin);
      await s.close();
    } finally {
      own.stop();
    }
  });

  test("an object the data host does not have is reported as missing", async () => {
    const s = new Session();
    await s.ready();
    const absent =
      "SHA256E-s3--aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bin";
    const file = outFile("absent");
    s.send(`TRANSFER RETRIEVE ${absent} ${file}`);
    const failure = (await s.until("TRANSFER-")).line;
    expect(failure.startsWith(`TRANSFER-FAILURE RETRIEVE ${absent} `)).toBe(true);
    expect(failure).toContain("no such object");
    expect(existsSync(file)).toBe(false);
    await s.close();
  });

  test("a key that is not safe in a URL path is refused before any request", async () => {
    const before = host.dataSeen.length;
    const s = new Session();
    await s.ready();
    for (const key of [
      "../../etc/passwd",
      "a/b",
      "key%2Fescape",
      "key?x=1",
      "key#frag",
      ".hidden",
    ]) {
      s.send(`TRANSFER RETRIEVE ${key} ${outFile("unsafe")}`);
      const reply = (await s.until("TRANSFER-")).line;
      expect([key, reply.startsWith(`TRANSFER-FAILURE RETRIEVE ${key} `)]).toEqual([key, true]);
    }
    await s.close();
    expect(host.dataSeen.length).toBe(before);
  });

  test("a body shorter than the key's size fails and leaves no file", async () => {
    // Chunked, no Content-Length: ending after 10 of 29 bytes.
    const own = standin({
      override: (_req, key) => (key === SMALL_KEY ? chunked(SMALL.slice(0, 10)) : undefined),
    });
    try {
      const s = new Session({ hosts: own.origin });
      await s.ready(own.origin);
      const file = outFile("short");
      s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${file}`);
      const failure = (await s.until("TRANSFER-")).line;
      expect(failure.startsWith(`TRANSFER-FAILURE RETRIEVE ${SMALL_KEY} `)).toBe(true);
      expect(failure).toContain("10 bytes");
      expect(existsSync(file)).toBe(false);
      await s.close();
    } finally {
      own.stop();
    }
  });

  test("a body longer than the key's size fails at once and leaves no file", async () => {
    const own = standin({
      override: (_req, key) =>
        key === SMALL_KEY ? chunked(patternBytes(20, 3), patternBytes(20, 4)) : undefined,
    });
    try {
      const s = new Session({ hosts: own.origin });
      await s.ready(own.origin);
      const file = outFile("long");
      s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${file}`);
      const failure = (await s.until("TRANSFER-")).line;
      expect(failure.startsWith(`TRANSFER-FAILURE RETRIEVE ${SMALL_KEY} `)).toBe(true);
      expect(existsSync(file)).toBe(false);
      await s.close();
    } finally {
      own.stop();
    }
  });

  test("a Content-Length that disagrees with the key's size is refused before the body is read", async () => {
    const own = standin({
      override: (_req, key) => (key === SMALL_KEY ? new Response(SMALL.slice(0, 10)) : undefined),
    });
    try {
      const s = new Session({ hosts: own.origin });
      await s.ready(own.origin);
      const file = outFile("cl-mismatch");
      s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${file}`);
      const failure = (await s.until("TRANSFER-")).line;
      expect(failure.startsWith(`TRANSFER-FAILURE RETRIEVE ${SMALL_KEY} `)).toBe(true);
      expect(failure).toContain("29");
      expect(existsSync(file)).toBe(false);
      await s.close();
    } finally {
      own.stop();
    }
  });

  test("an empty object is written as an empty file", async () => {
    const emptyKey =
      "SHA256E-s0--e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.bin";
    // A 200 with no body at all, as a server may send for an empty object.
    const own = standin({
      override: (_req, key) => (key === emptyKey ? new Response(null, { status: 200 }) : undefined),
    });
    try {
      const s = new Session({ hosts: own.origin });
      await s.ready(own.origin);
      const file = outFile("empty");
      s.send(`TRANSFER RETRIEVE ${emptyKey} ${file}`);
      expect((await s.until("TRANSFER-")).line).toBe(`TRANSFER-SUCCESS RETRIEVE ${emptyKey}`);
      expect(readFileSync(file).byteLength).toBe(0);
      await s.close();
    } finally {
      own.stop();
    }
  });

  test("an object whose key declares no size is accepted at whatever length it has", async () => {
    const keyNoSize = "WORM-m1700000000--note.txt";
    const own = standin({
      objects: new Map([[keyNoSize, patternBytes(40, 9)]]),
    });
    try {
      const s = new Session({ hosts: own.origin });
      await s.ready(own.origin);
      const file = outFile("no-size");
      s.send(`TRANSFER RETRIEVE ${keyNoSize} ${file}`);
      expect((await s.until("TRANSFER-")).line).toBe(`TRANSFER-SUCCESS RETRIEVE ${keyNoSize}`);
      expect(new Uint8Array(readFileSync(file))).toEqual(patternBytes(40, 9));
      await s.close();
    } finally {
      own.stop();
    }
  });

  test("more than three redirects fails: one request and three redirects are made, no more", async () => {
    let requests = 0;
    const own = standin({
      override: (req, key) => {
        if (key !== SMALL_KEY) return undefined;
        requests++;
        return new Response(null, {
          status: 302,
          headers: { Location: new URL(req.url).pathname },
        });
      },
    });
    try {
      const s = new Session({ hosts: own.origin });
      await s.ready(own.origin);
      s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${outFile("loop")}`);
      const failure = (await s.until("TRANSFER-")).line;
      expect(failure.startsWith(`TRANSFER-FAILURE RETRIEVE ${SMALL_KEY} `)).toBe(true);
      expect(failure).toContain("redirects");
      expect(requests).toBe(4);
      await s.close();
    } finally {
      own.stop();
    }
  });

  test("three redirects are followed, and each one to the data host's own origin carries the key", async () => {
    let requests = 0;
    const own = standin({
      override: (req, key) => {
        if (key !== SMALL_KEY) return undefined;
        requests++;
        if (requests <= 3) {
          return new Response(null, {
            status: 302,
            headers: { Location: new URL(req.url).pathname },
          });
        }
        return new Response(SMALL, { headers: { "Content-Length": String(SMALL.byteLength) } });
      },
    });
    try {
      const s = new Session({ hosts: own.origin });
      await s.ready(own.origin);
      const file = outFile("three");
      s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${file}`);
      expect((await s.until("TRANSFER-")).line).toBe(`TRANSFER-SUCCESS RETRIEVE ${SMALL_KEY}`);
      expect(new Uint8Array(readFileSync(file))).toEqual(SMALL);
      expect(own.dataSeen.map((r) => r.authorization)).toEqual(Array(4).fill(`Bearer ${API_KEY}`));
      await s.close();
    } finally {
      own.stop();
    }
  });

  test("a redirect to a plain-http address that is not on this machine, or to another scheme, is not followed", async () => {
    for (const target of [
      "http://example.invalid/blob/x?sig=abc",
      "ftp://example.invalid/x",
      "file:///etc/passwd",
    ]) {
      const own = standin({
        override: (_req, key) =>
          key === SMALL_KEY
            ? new Response(null, { status: 302, headers: { Location: target } })
            : undefined,
      });
      try {
        const s = new Session({ hosts: own.origin });
        await s.ready(own.origin);
        s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${outFile("scheme")}`);
        const failure = (await s.until("TRANSFER-")).line;
        expect([target, failure.startsWith(`TRANSFER-FAILURE RETRIEVE ${SMALL_KEY} `)]).toEqual([
          target,
          true,
        ]);
        expect(failure).toContain("not https");
        expect(failure).not.toContain("sig=abc");
        await s.close();
      } finally {
        own.stop();
      }
    }
  });

  test("a redirect with no Location, or one that is not a URL, fails", async () => {
    for (const headers of [{}, { Location: "http://[bad" }] as Record<string, string>[]) {
      const own = standin({
        override: (_req, key) =>
          key === SMALL_KEY ? new Response(null, { status: 302, headers }) : undefined,
      });
      try {
        const s = new Session({ hosts: own.origin });
        await s.ready(own.origin);
        s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${outFile("badloc")}`);
        expect((await s.until("TRANSFER-")).line.startsWith("TRANSFER-FAILURE RETRIEVE ")).toBe(
          true,
        );
        await s.close();
      } finally {
        own.stop();
      }
    }
  });

  test("a data host that is down fails the transfer and names no address", async () => {
    const down = standin();
    const origin = down.origin;
    down.stop();
    const s = new Session({ hosts: origin });
    await s.ready(origin);
    s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${outFile("down")}`);
    const failure = (await s.until("TRANSFER-")).line;
    expect(failure.startsWith(`TRANSFER-FAILURE RETRIEVE ${SMALL_KEY} `)).toBe(true);
    expect(failure).not.toContain(origin);
    await s.close();
  });
});

describe("CHECKPRESENT", () => {
  test("200 is present, 404 is absent, and the check is a HEAD", async () => {
    const s = new Session();
    await s.ready();
    const before = host.dataSeen.length;
    s.send(`CHECKPRESENT ${SMALL_KEY}`);
    expect(await s.next()).toBe(`CHECKPRESENT-SUCCESS ${SMALL_KEY}`);
    const absent =
      "SHA256E-s3--bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.bin";
    s.send(`CHECKPRESENT ${absent}`);
    expect(await s.next()).toBe(`CHECKPRESENT-FAILURE ${absent}`);
    const requests = host.dataSeen.slice(before);
    expect(requests.map((r) => r.method)).toEqual(["HEAD", "HEAD"]);
    expect(requests.every((r) => r.authorization === `Bearer ${API_KEY}`)).toBe(true);
    await s.close();
  });

  test("a large object is present by HEAD alone: no redirect is followed and nothing is downloaded", async () => {
    const own = standin();
    try {
      const s = new Session({ hosts: own.origin });
      await s.ready(own.origin);
      s.send(`CHECKPRESENT ${BIG_KEY}`);
      expect(await s.next()).toBe(`CHECKPRESENT-SUCCESS ${BIG_KEY}`);
      expect(own.storageSeen).toEqual([]);
      await s.close();
    } finally {
      own.stop();
    }
  });

  test("a server fault, a refused key and an unreachable host are unknown, never absent", async () => {
    for (const status of [500, 503, 401, 403, 429]) {
      const own = standin({
        override: (_req, key) =>
          key === SMALL_KEY ? new Response("fault", { status }) : undefined,
      });
      try {
        const s = new Session({ hosts: own.origin });
        await s.ready(own.origin);
        s.send(`CHECKPRESENT ${SMALL_KEY}`);
        const reply = await s.next();
        expect([status, reply.startsWith(`CHECKPRESENT-UNKNOWN ${SMALL_KEY} `)]).toEqual([
          status,
          true,
        ]);
        await s.close();
      } finally {
        own.stop();
      }
    }
    const down = standin();
    const origin = down.origin;
    down.stop();
    const s = new Session({ hosts: origin });
    await s.ready(origin);
    s.send(`CHECKPRESENT ${SMALL_KEY}`);
    expect((await s.next()).startsWith(`CHECKPRESENT-UNKNOWN ${SMALL_KEY} `)).toBe(true);
    await s.close();
  });

  test("a redirect answer to a HEAD is unknown and is not followed", async () => {
    const own = standin({
      override: (_req, key, storage) =>
        key === SMALL_KEY
          ? new Response(null, { status: 302, headers: { Location: `${storage}/blob/x` } })
          : undefined,
    });
    try {
      const s = new Session({ hosts: own.origin });
      await s.ready(own.origin);
      s.send(`CHECKPRESENT ${SMALL_KEY}`);
      expect((await s.next()).startsWith(`CHECKPRESENT-UNKNOWN ${SMALL_KEY} `)).toBe(true);
      expect(own.storageSeen).toEqual([]);
      await s.close();
    } finally {
      own.stop();
    }
  });

  test("a key that cannot be on a data host is absent without a request", async () => {
    const before = host.dataSeen.length;
    const s = new Session();
    await s.ready();
    s.send("CHECKPRESENT a/b");
    expect(await s.next()).toBe("CHECKPRESENT-FAILURE a/b");
    await s.close();
    expect(host.dataSeen.length).toBe(before);
  });
});

describe("read-only for now", () => {
  test("TRANSFER STORE and REMOVE are refused, and nothing is sent to the data host", async () => {
    const before = host.dataSeen.length;
    const s = new Session();
    await s.ready();
    const source = outFile("store-source");
    writeFileSync(source, "payload");
    s.send(`TRANSFER STORE ${SMALL_KEY} ${source}`);
    const store = await s.next();
    expect(store.startsWith(`TRANSFER-FAILURE STORE ${SMALL_KEY} `)).toBe(true);
    expect(store).toContain("read-only");
    s.send(`REMOVE ${SMALL_KEY}`);
    const remove = await s.next();
    expect(remove.startsWith(`REMOVE-FAILURE ${SMALL_KEY} `)).toBe(true);
    expect(remove).toContain("read-only");
    await s.close();
    expect(host.dataSeen.length).toBe(before);
  });
});

describe("what the remote prints", () => {
  test("no line of a whole session holds the API key", async () => {
    const own = standin();
    try {
      const s = new Session({ hosts: own.origin });
      await s.ready(own.origin);
      s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${outFile("hygiene-small")}`);
      await s.until("TRANSFER-");
      s.send(`TRANSFER RETRIEVE ${BIG_KEY} ${outFile("hygiene-big")}`);
      await s.until("TRANSFER-");
      s.send(`CHECKPRESENT ${SMALL_KEY}`);
      await s.next();
      s.send(`TRANSFER RETRIEVE ${"SHA256E-s1--cc.bin"} ${outFile("hygiene-missing")}`);
      await s.until("TRANSFER-");
      const output = await s.everything();
      expect(output).not.toContain(API_KEY);
      expect(output).not.toContain(own.storageOrigin);
      for (const token of own.redirectTokens) expect(output).not.toContain(token);
    } finally {
      own.stop();
    }
  });
});
