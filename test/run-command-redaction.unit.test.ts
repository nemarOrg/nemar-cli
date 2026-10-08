/**
 * What `--verbose` shows of a subprocess's output is credential-free.
 *
 * A failed S3 request makes git-annex print the request it built, and that dump carries
 * the session token in a header tuple; `runCommand` logs a subprocess's stdout and stderr
 * under `--verbose`, so the log is where it would surface. The command here is a plain
 * shell that prints what git-annex would, so no AWS call is made.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { credentialValues, runCommand } from "../src/lib/git-annex/run-command";
import { setVerbose } from "../src/lib/verbose";

const TOKEN = "FAKE-SESSION-TOKEN-0123456789";
const SECRET = "fakesecretkeyfakesecretkey";
const DUMP = `HttpExceptionRequest Request { requestHeaders = [("Authorization","<REDACTED>"),("X-Amz-Security-Token","${TOKEN}"),("User-Agent","git-annex")] }`;

/** Run `fn` with verbose on, collecting what is written to stderr. */
async function verboseLog<T>(fn: () => Promise<T>): Promise<{ value: T; log: string }> {
  const chunks: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  setVerbose(true);
  try {
    return { value: await fn(), log: chunks.join("") };
  } finally {
    setVerbose(false);
    process.stderr.write = write;
  }
}

const printing = ["sh", "-c", 'printf "%s\\n" "$1"; printf "%s\\n" "$2" >&2', "_", DUMP];

afterEach(() => setVerbose(false));

describe("runCommand under --verbose", () => {
  test("the header dump a failed request prints is logged without its session token", async () => {
    // Guards the redaction of stdout in the verbose log. The call's own result stays raw;
    // the callers that print it redact it themselves.
    const { value, log } = await verboseLog(() =>
      runCommand([...printing, "plain stderr line"], {
        env: { AWS_SESSION_TOKEN: TOKEN },
      }),
    );
    expect(value.stdout).toContain(TOKEN);
    expect(log).toContain("X-Amz-Security-Token");
    expect(log).not.toContain(TOKEN);
    expect(log).toContain("<redacted>");
  });

  test("a secret that is not in a header is blanked from stderr too, given or inherited", async () => {
    // Guards stderr, and credentialValues reading the process environment: the import path
    // runs on ambient AWS_* variables and hands the command none.
    const before = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = SECRET;
    try {
      const { log } = await verboseLog(() =>
        runCommand([...printing, `signing with ${SECRET} failed`]),
      );
      expect(log).toContain("signing with <redacted> failed");
      expect(log).not.toContain(SECRET);
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "AWS_SECRET_ACCESS_KEY");
      else process.env.AWS_SECRET_ACCESS_KEY = before;
    }

    const { log: given } = await verboseLog(() =>
      runCommand([...printing, `signing with ${SECRET} failed`], {
        env: { AWS_SECRET_ACCESS_KEY: SECRET },
      }),
    );
    expect(given).toContain("signing with <redacted> failed");
    expect(given).not.toContain(SECRET);
  });

  test("without --verbose nothing is logged at all", async () => {
    const chunks: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await runCommand([...printing, "x"], { env: { AWS_SESSION_TOKEN: TOKEN } });
    } finally {
      process.stderr.write = write;
    }
    expect(chunks.join("")).toBe("");
  });
});

describe("credentialValues", () => {
  test("collects the given and the inherited AWS values, once each, and skips empty ones", () => {
    const keys = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"] as const;
    const saved = keys.map((k) => process.env[k]);
    for (const k of keys) Reflect.deleteProperty(process.env, k);
    process.env.AWS_ACCESS_KEY_ID = "INHERITED-KEY-ID-0001";
    try {
      const values = credentialValues({
        AWS_SECRET_ACCESS_KEY: SECRET,
        AWS_SESSION_TOKEN: "",
        AWS_ACCESS_KEY_ID: "INHERITED-KEY-ID-0001",
      });
      expect(values.sort()).toEqual(["INHERITED-KEY-ID-0001", SECRET].sort());
    } finally {
      for (const [i, k] of keys.entries()) {
        const v = saved[i];
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
    }
  });
});
