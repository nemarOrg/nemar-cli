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

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkObject, isSafeKey, retrieveObject, sizeOfKey } from "../src/lib/data-host-remote";
import { type VettedOrigin, allowedDataHosts } from "../src/lib/data-hosts";
import { DataHostStandin, type StandinOptions, patternBytes } from "./helpers/data-host-standin";
import { fakeApiKey, makeConfigDir } from "./helpers/nemar-account";
import { Session, useSessions } from "./helpers/remote-session";

// a child process for every session: a slow runner needs more than the default 5 seconds.
setDefaultTimeout(60_000);

const open = useSessions();

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

function outFile(name: string): string {
  return join(root, `${name}-${crypto.randomUUID()}`);
}

describe("the protocol", () => {
  test("starts with VERSION 1 and ends cleanly when git-annex closes its side", async () => {
    const s = open({ hosts: host.origin, config: configDir });
    expect(await s.next()).toBe("VERSION 1");
    expect((await s.close()).code).toBe(0);
  });

  test("answers cost, availability, configs and extensions, and refuses what it does not know", async () => {
    const s = open({ hosts: host.origin, config: configDir });
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
    const s = open({ hosts: host.origin, config: configDir });
    expect(await s.next()).toBe("VERSION 1");
    s.send("ERROR the protocol went wrong");
    expect((await s.close()).code).toBe(1);
  });

  test("a line that arrives while a GETCONFIG waits for its VALUE is handled afterwards, in order", async () => {
    const s = open({ hosts: host.origin, config: configDir });
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
    const s = open({ hosts: host.origin, config: configDir });
    expect(await s.next()).toBe("VERSION 1");
    s.send("VALUE stray");
    s.send("GETCOST");
    expect(await s.next()).toBe("COST 200");
    await s.close();
  });

  test("GETINFO reports the host and dataset once prepared", async () => {
    const s = open({ hosts: host.origin, config: configDir });
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
    const s = open({ hosts: host.origin, config: configDir });
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
    const s = open({ hosts: host.origin, config: configDir });
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
      const s = open({ hosts: host.origin, config: configDir });
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
    const s = open({ hosts: "", config: configDir });
    expect(await s.next()).toBe("VERSION 1");
    const reply = await s.configure("INITREMOTE", host.origin, DATASET);
    expect(reply.startsWith("INITREMOTE-FAILURE ")).toBe(true);
    await s.close();
  });

  test("an environment entry that is not a loopback http or an https origin adds nothing", async () => {
    const s = open({
      hosts: "http://example.com,http://192.168.0.5:8080,https://x.example/path",
      config: configDir,
    });
    expect(await s.next()).toBe("VERSION 1");
    for (const value of ["http://example.com", "http://192.168.0.5:8080", "https://x.example"]) {
      const reply = await s.configure("INITREMOTE", value, DATASET);
      expect([value, reply.startsWith("INITREMOTE-FAILURE ")]).toEqual([value, true]);
    }
    await s.close();
  });

  test("a dataset setting that is not a dataset id is refused", async () => {
    const s = open({ hosts: host.origin, config: configDir });
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
    const s = open({ hosts: host.origin, config: configDir });
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
    const s = open({ hosts: host.origin, config: signedOutDir });
    expect(await s.next()).toBe("VERSION 1");
    const reply = await s.configure("PREPARE", host.origin, DATASET);
    expect(reply.startsWith("PREPARE-FAILURE ")).toBe(true);
    expect(reply).toContain("nemar auth login");
    await s.close();
  });

  test("a key the data host refuses is reported as refused, for a transfer and for a check", async () => {
    const wrongKey = makeConfigDir(fakeApiKey());
    try {
      const s = open({ hosts: host.origin, config: wrongKey });
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
    const s = open({ hosts: host.origin, config: configDir });
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
    const s = open({ hosts: host.origin, config: configDir });
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
    const s = open({ hosts: host.origin, config: configDir });
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
      const s = open({ hosts: own.origin, config: configDir });
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
      const s = open({ hosts: own.origin, config: configDir });
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
    const s = open({ hosts: host.origin, config: configDir });
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
    const s = open({ hosts: host.origin, config: configDir });
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
      const s = open({ hosts: own.origin, config: configDir });
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
      const s = open({ hosts: own.origin, config: configDir });
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
      const s = open({ hosts: own.origin, config: configDir });
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
      const s = open({ hosts: own.origin, config: configDir });
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

  test("a chunk key's own size field is not interpreted, so any length is accepted", async () => {
    const chunkKey = "SHA256E-s40-S20-C1--0a1b2c3d4e5f6071.bin";
    const own = standin({ objects: new Map([[chunkKey, patternBytes(15, 9)]]) });
    try {
      const s = open({ hosts: own.origin, config: configDir });
      await s.ready(own.origin);
      const file = outFile("chunk");
      s.send(`TRANSFER RETRIEVE ${chunkKey} ${file}`);
      expect((await s.until("TRANSFER-")).line).toBe(`TRANSFER-SUCCESS RETRIEVE ${chunkKey}`);
      expect(new Uint8Array(readFileSync(file))).toEqual(patternBytes(15, 9));
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
      const s = open({ hosts: own.origin, config: configDir });
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
      const s = open({ hosts: own.origin, config: configDir });
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
        const s = open({ hosts: own.origin, config: configDir });
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
        const s = open({ hosts: own.origin, config: configDir });
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
    const s = open({ hosts: origin, config: configDir });
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
    const s = open({ hosts: host.origin, config: configDir });
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
      const s = open({ hosts: own.origin, config: configDir });
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
        const s = open({ hosts: own.origin, config: configDir });
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
    const s = open({ hosts: origin, config: configDir });
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
      const s = open({ hosts: own.origin, config: configDir });
      await s.ready(own.origin);
      s.send(`CHECKPRESENT ${SMALL_KEY}`);
      expect((await s.next()).startsWith(`CHECKPRESENT-UNKNOWN ${SMALL_KEY} `)).toBe(true);
      expect(own.storageSeen).toEqual([]);
      await s.close();
    } finally {
      own.stop();
    }
  });

  test("a key that cannot be on a data host is unknown, not absent, and makes no request", async () => {
    const before = host.dataSeen.length;
    const s = open({ hosts: host.origin, config: configDir });
    await s.ready();
    for (const key of [
      "a/b",
      "WORM-s40-m17--note.txt",
      "URL--http&c%3A%2F%2Fx",
      "SHA256E-s5--a+b.bin",
    ]) {
      s.send(`CHECKPRESENT ${key}`);
      const reply = await s.next();
      expect([key, reply.startsWith(`CHECKPRESENT-UNKNOWN ${key} `)]).toEqual([key, true]);
    }
    await s.close();
    expect(host.dataSeen.length).toBe(before);
  });
});

describe("read-only for now", () => {
  test("TRANSFER STORE and REMOVE are refused, and nothing is sent to the data host", async () => {
    const before = host.dataSeen.length;
    const s = open({ hosts: host.origin, config: configDir });
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
      const s = open({ hosts: own.origin, config: configDir });
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

describe("where a redirect may lead", () => {
  test("a scheme-relative or backslash Location is resolved first, then judged", async () => {
    // Each resolves, against the data host's http://127.0.0.1 URL, to plain http on a host that
    // is not on this machine, which is refused without a request.
    for (const location of [
      "//example.invalid/blob/x?sig=abc",
      "\\\\example.invalid\\blob\\x?sig=abc",
      "/\\example.invalid/blob/x?sig=abc",
    ]) {
      const own = standin({
        override: (_req, key) =>
          key === SMALL_KEY
            ? new Response(null, { status: 302, headers: { Location: location } })
            : undefined,
      });
      try {
        const s = open({ hosts: own.origin, config: configDir });
        await s.ready(own.origin);
        s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${outFile("relative")}`);
        const failure = (await s.until("TRANSFER-")).line;
        expect([location, failure.includes("not https")]).toEqual([location, true]);
        expect(failure).not.toContain("sig=abc");
      } finally {
        own.stop();
      }
    }
  });

  test("a scheme-relative Location to another loopback origin is followed without the key", async () => {
    const own = standin({
      override: (_req, key, storage) =>
        key === BIG_KEY
          ? new Response(null, {
              status: 302,
              headers: { Location: `//${new URL(storage).host}/blob/${BIG_KEY}?X-Signature=s1` },
            })
          : undefined,
    });
    try {
      const s = open({ hosts: own.origin, config: configDir });
      await s.ready(own.origin);
      const file = outFile("relative-ok");
      s.send(`TRANSFER RETRIEVE ${BIG_KEY} ${file}`);
      expect((await s.until("TRANSFER-")).line).toBe(`TRANSFER-SUCCESS RETRIEVE ${BIG_KEY}`);
      expect(new Uint8Array(readFileSync(file))).toEqual(BIG);
      expect(own.storageSeen.map((r) => r.authorization)).toEqual([null]);
    } finally {
      own.stop();
    }
  });

  test("data host to another origin and back: the key is attached only at the data host's own origin", async () => {
    // Pinned: a chain that returns to the configured origin carries the key there again, and
    // never carries it to the origin in between.
    const bounce = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        bounced.push(req.headers.get("authorization"));
        return new Response(null, {
          status: 302,
          headers: { Location: `${own.origin}/o/${DATASET}/${SMALL_KEY}?via=back` },
        });
      },
    });
    const bounced: (string | null)[] = [];
    const own: DataHostStandin = standin({
      override: (req, key) => {
        if (key !== SMALL_KEY) return undefined;
        if (new URL(req.url).searchParams.get("via") === "back") {
          return new Response(SMALL, { headers: { "Content-Length": String(SMALL.byteLength) } });
        }
        return new Response(null, {
          status: 302,
          headers: { Location: `http://127.0.0.1:${bounce.port}/hop` },
        });
      },
    });
    try {
      const s = open({ hosts: own.origin, config: configDir });
      await s.ready(own.origin);
      const file = outFile("chain");
      s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${file}`);
      expect((await s.until("TRANSFER-")).line).toBe(`TRANSFER-SUCCESS RETRIEVE ${SMALL_KEY}`);
      expect(new Uint8Array(readFileSync(file))).toEqual(SMALL);
      expect(bounced).toEqual([null]);
      expect(own.dataSeen.map((r) => r.authorization)).toEqual([
        `Bearer ${API_KEY}`,
        `Bearer ${API_KEY}`,
      ]);
    } finally {
      bounce.stop(true);
      own.stop();
    }
  });
});

describe("a body that never ends", () => {
  test("is cut off as soon as it passes the key's size, and the connection is cancelled", async () => {
    let cancelled = false;
    let sent = 0;
    const own = standin({
      override: (_req, key) =>
        key === SMALL_KEY
          ? new Response(
              new ReadableStream({
                async pull(controller) {
                  await Bun.sleep(2);
                  sent += 10;
                  controller.enqueue(patternBytes(10, sent));
                },
                cancel() {
                  cancelled = true;
                },
              }),
            )
          : undefined,
    });
    try {
      const s = open({ hosts: own.origin, config: configDir });
      await s.ready(own.origin);
      const file = outFile("endless");
      s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${file}`);
      const failure = (await s.until("TRANSFER-")).line;
      expect(failure).toBe(
        `TRANSFER-FAILURE RETRIEVE ${SMALL_KEY} More bytes arrived than the key's 29.`,
      );
      expect(existsSync(file)).toBe(false);
      for (let i = 0; i < 200 && !cancelled; i++) await Bun.sleep(10);
      expect(cancelled).toBe(true);
      // Cut off near the limit, not drained: a handful of chunks, not an endless stream.
      expect(sent).toBeLessThan(500);
    } finally {
      own.stop();
    }
  });
});

describe("a host that does not answer", () => {
  /** A TCP listener that accepts connections and never writes a byte. */
  function silentHost(): { origin: string; stop: () => void } {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    return { origin: `http://127.0.0.1:${listener.port}`, stop: () => listener.stop(true) };
  }
  const SHORT = { NEMAR_DATA_HOST_TIMEOUT_MS: "300" };

  test("a transfer and a check time out, with a message that says so", async () => {
    const silent = silentHost();
    try {
      const s = open({ hosts: silent.origin, config: configDir, env: SHORT });
      await s.ready(silent.origin);
      const file = outFile("silent");
      s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${file}`);
      const failure = (await s.until("TRANSFER-")).line;
      expect(failure).toBe(`TRANSFER-FAILURE RETRIEVE ${SMALL_KEY} The request timed out.`);
      expect(existsSync(file)).toBe(false);
      s.send(`CHECKPRESENT ${SMALL_KEY}`);
      expect(await s.next()).toBe(`CHECKPRESENT-UNKNOWN ${SMALL_KEY} The request timed out.`);
    } finally {
      silent.stop();
    }
  });

  test("a body that stalls after the headers times out and leaves no file", async () => {
    const own = standin({
      override: (_req, key) =>
        key === SMALL_KEY
          ? new Response(
              new ReadableStream({
                pull(controller) {
                  controller.enqueue(SMALL.slice(0, 5));
                  return new Promise(() => {});
                },
              }),
            )
          : undefined,
    });
    try {
      const s = open({ hosts: own.origin, config: configDir, env: SHORT });
      await s.ready(own.origin);
      const file = outFile("stalled");
      s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${file}`);
      const failure = (await s.until("TRANSFER-")).line;
      expect(failure).toBe(
        `TRANSFER-FAILURE RETRIEVE ${SMALL_KEY} The transfer stalled and timed out.`,
      );
      expect(existsSync(file)).toBe(false);
    } finally {
      own.stop();
    }
  });

  test("a host that is down is reported with the error's code, never its address", async () => {
    const down = standin();
    const origin = down.origin;
    down.stop();
    const s = open({ hosts: origin, config: configDir });
    await s.ready(origin);
    s.send(`TRANSFER RETRIEVE ${SMALL_KEY} ${outFile("down-code")}`);
    const failure = (await s.until("TRANSFER-")).line;
    expect(failure).toMatch(/\(\w+ ECONNREFUSED\)\.$/);
    expect(failure).not.toContain(origin);
    s.send(`CHECKPRESENT ${SMALL_KEY}`);
    expect(await s.next()).toMatch(/ECONNREFUSED/);
  });
});

describe("a caller that hands over an origin the list does not have", () => {
  const forged = (origin: string) => ({
    origin: origin as VettedOrigin,
    dataset: DATASET,
    options: { env: {}, isDevBuild: false },
  });

  test("a transfer and a check refuse it and make no request", async () => {
    const own = standin();
    try {
      const file = outFile("forged");
      const retrieved = await retrieveObject(
        forged(own.origin),
        SMALL_KEY,
        API_KEY,
        file,
        () => {},
      );
      expect(retrieved).toEqual({
        ok: false,
        message: "The host is not on this CLI's list of data hosts.",
      });
      const checked = await checkObject(forged(own.origin), SMALL_KEY, API_KEY);
      expect(checked.state).toBe("unknown");
      expect(own.dataSeen).toEqual([]);
      expect(existsSync(file)).toBe(false);
    } finally {
      own.stop();
    }
  });
});

describe("the key rule is the data host's", () => {
  const HASH = "0123456789abcdef";
  /** A key of exactly `length` characters: the fixed part, then a name that fills the rest. */
  const keyOfLength = (length: number): string => {
    const head = "SHA256E-s5--";
    return head + "a".repeat(length - head.length);
  };

  test("accepted: upper-case backends with digits and underscores, names of letters, digits . _ -", () => {
    for (const key of [
      `SHA256E-s29--${HASH}.bin`,
      `SHA3_256E-s29--${HASH}.tar.gz`,
      `SHA256-s0--${HASH}`,
      "BLAKE2B_512E-s7--a_b-c.d",
      "MD5E-s1--X",
      `SHA256E-s40-S20-C1--${HASH}.bin`,
    ]) {
      expect([key, isSafeKey(key)]).toEqual([key, true]);
    }
  });

  test("refused: lower-case or empty backends, missing or malformed fields, other name characters", () => {
    for (const key of [
      `sha256e-s29--${HASH}.bin`,
      `Sha256E-s29--${HASH}.bin`,
      `_SHA256E-s29--${HASH}`,
      `-s29--${HASH}`,
      `SHA256E--${HASH}`,
      `SHA256E-s--${HASH}`,
      `SHA256E-s29-${HASH}`,
      "SHA256E-s29--",
      `SHA256E-S29--${HASH}`,
      `SHA256E-s29-S5--${HASH}`,
      `SHA256E-s29-S5-C--${HASH}`,
      `SHA256E-s29-C1-S5--${HASH}`,
      "SHA256E-s29--a+b",
      "SHA256E-s29--a b",
      "SHA256E-s29--a/b",
      "SHA256E-s29--a%2Fb",
      "SHA256E-s29--a\nb",
      "WORM-s40-m17--note.txt",
    ]) {
      expect([key, isSafeKey(key)]).toEqual([key, false]);
    }
  });

  test("a size and each chunk field may have 16 digits and no more", () => {
    const sixteen = "1234567890123456";
    const seventeen = "12345678901234567";
    expect(isSafeKey(`SHA256E-s${sixteen}--x`)).toBe(true);
    expect(isSafeKey(`SHA256E-s${seventeen}--x`)).toBe(false);
    expect(isSafeKey(`SHA256E-s5-S${sixteen}-C1--x`)).toBe(true);
    expect(isSafeKey(`SHA256E-s5-S${seventeen}-C1--x`)).toBe(false);
    expect(isSafeKey(`SHA256E-s5-S1-C${sixteen}--x`)).toBe(true);
    expect(isSafeKey(`SHA256E-s5-S1-C${seventeen}--x`)).toBe(false);
  });

  test("the whole key is at most 255 characters", () => {
    expect(keyOfLength(255)).toHaveLength(255);
    expect(isSafeKey(keyOfLength(255))).toBe(true);
    expect(isSafeKey(keyOfLength(256))).toBe(false);
    expect(sizeOfKey(keyOfLength(255))).toBe(5);
    expect(sizeOfKey(keyOfLength(256))).toBeNull();
  });

  test("sizeOfKey reads the size from the anchored pattern's groups", () => {
    expect(sizeOfKey(`SHA256E-s29--${HASH}.bin`)).toBe(29);
    expect(sizeOfKey(`SHA3_256E-s1048576--${HASH}`)).toBe(1048576);
    expect(sizeOfKey(`SHA256E-s0--${HASH}`)).toBe(0);
    // A chunk key's own size field is not interpreted.
    expect(sizeOfKey(`SHA256E-s40-S20-C1--${HASH}`)).toBeNull();
    // Not a key the data host serves, so no size.
    expect(sizeOfKey("WORM-s40-m17--note.txt")).toBeNull();
    // Too large for an exact number: no size check rather than a wrong one.
    expect(sizeOfKey("SHA256E-s9999999999999999--x")).toBeNull();
  });

  test("a name that merely contains chunk-like text keeps its size check", () => {
    const key = "SHA256E-s5--x-S1-C1-y";
    expect(isSafeKey(key)).toBe(true);
    expect(sizeOfKey(key)).toBe(5);
  });

  test("a name containing chunk-like text is held to its size through the remote", async () => {
    const key = "SHA256E-s5--x-S1-C1-y";
    const own = standin({ objects: new Map([[key, patternBytes(9, 4)]]) });
    try {
      const s = open({ hosts: own.origin, config: configDir });
      await s.ready(own.origin);
      const file = outFile("name-chunky");
      s.send(`TRANSFER RETRIEVE ${key} ${file}`);
      const failure = (await s.until("TRANSFER-")).line;
      expect(failure.startsWith(`TRANSFER-FAILURE RETRIEVE ${key} `)).toBe(true);
      expect(existsSync(file)).toBe(false);
    } finally {
      own.stop();
    }
  });

  test("a lower-case backend is refused through the remote without a request", async () => {
    const before = host.dataSeen.length;
    const key = `sha256e-s29--${HASH}.bin`;
    const s = open({ hosts: host.origin, config: configDir });
    await s.ready();
    s.send(`TRANSFER RETRIEVE ${key} ${outFile("lower")}`);
    expect((await s.until("TRANSFER-")).line.startsWith(`TRANSFER-FAILURE RETRIEVE ${key} `)).toBe(
      true,
    );
    s.send(`CHECKPRESENT ${key}`);
    expect((await s.next()).startsWith(`CHECKPRESENT-UNKNOWN ${key} `)).toBe(true);
    expect(host.dataSeen.length).toBe(before);
  });

  test("SHA3_256E keys are transferred", async () => {
    const key = `SHA3_256E-s29--${HASH}.bin`;
    const own = standin({ objects: new Map([[key, SMALL]]) });
    try {
      const s = open({ hosts: own.origin, config: configDir });
      await s.ready(own.origin);
      const file = outFile("sha3");
      s.send(`TRANSFER RETRIEVE ${key} ${file}`);
      expect((await s.until("TRANSFER-")).line).toBe(`TRANSFER-SUCCESS RETRIEVE ${key}`);
      expect(new Uint8Array(readFileSync(file))).toEqual(SMALL);
    } finally {
      own.stop();
    }
  });
});

describe("the timeout comes from the environment the settings carry", () => {
  test("a transfer and a check use options.env, whatever the process environment holds", async () => {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    try {
      const origin = `http://127.0.0.1:${listener.port}`;
      const options = {
        env: {
          NEMAR_DATA_HOSTS: origin,
          NEMAR_DATA_HOSTS_ONLY: "1",
          NEMAR_DATA_HOST_TIMEOUT_MS: "300",
        },
        isDevBuild: false,
      };
      const [vetted] = allowedDataHosts(options);
      const settings = { origin: vetted, dataset: DATASET, options };
      const started = performance.now();
      const retrieved = await retrieveObject(
        settings,
        SMALL_KEY,
        API_KEY,
        outFile("env"),
        () => {},
      );
      expect(retrieved).toEqual({ ok: false, message: "The request timed out." });
      const checked = await checkObject(settings, SMALL_KEY, API_KEY);
      expect(checked).toEqual({ state: "unknown", message: "The request timed out." });
      expect(performance.now() - started).toBeLessThan(5000);
    } finally {
      listener.stop(true);
    }
  });
});
