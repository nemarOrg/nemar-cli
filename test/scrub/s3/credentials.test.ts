/**
 * The credential source: one serialized `aws configure export-credentials` shared by every `aws`
 * child. The export runs the REAL CLI against credentials in its environment, wrapped only to
 * count how often it ran.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AwsCliError,
  cliCredentialSource,
  createAwsRunner,
} from "../../../scripts/scrub/s3/s3-lib";
import { type S3Standin, startS3Standin } from "../helpers/s3-standin";
import { BUCKET, SLOW } from "./support";

let standin: S3Standin | undefined;
const dirs: string[] = [];
afterEach(() => {
  standin?.stop();
  standin = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HERMETIC = {
  PATH: process.env.PATH ?? "",
  HOME: "/nonexistent",
  AWS_CONFIG_FILE: "/dev/null",
  AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
};

function counted(creds: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "scrub-creds-"));
  dirs.push(dir);
  const count = path.join(dir, "count");
  return {
    // The real export, preceded by one line appended to a file so a test can count runs.
    command: [
      "sh",
      "-c",
      `echo run >> '${count}'; exec aws configure export-credentials --format process`,
    ],
    commandEnv: { ...HERMETIC, ...creds },
    runs: () => {
      try {
        return readFileSync(count, "utf8").trim().split("\n").length;
      } catch {
        return 0;
      }
    },
  };
}

const future = () => new Date(Date.now() + 3_600_000).toISOString();

describe("cliCredentialSource", () => {
  test(
    "twenty concurrent calls make one export and share its result",
    async () => {
      const c = counted({
        AWS_ACCESS_KEY_ID: "ASIATESTTESTTESTTEST",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_SESSION_TOKEN: "token",
        AWS_CREDENTIAL_EXPIRATION: future(),
      });
      const source = cliCredentialSource({ command: c.command, commandEnv: c.commandEnv });
      const results = await Promise.all(Array.from({ length: 20 }, () => source.env()));
      expect(c.runs()).toBe(1);
      for (const r of results) expect(r.AWS_ACCESS_KEY_ID).toBe("ASIATESTTESTTESTTEST");
      // A later call, still well inside the lifetime, reuses it.
      await source.env();
      expect(c.runs()).toBe(1);
    },
    SLOW,
  );

  test(
    "credentials inside the refresh window are exported again, once for concurrent callers",
    async () => {
      const c = counted({
        AWS_ACCESS_KEY_ID: "ASIATESTTESTTESTTEST",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_SESSION_TOKEN: "token",
        AWS_CREDENTIAL_EXPIRATION: future(),
      });
      // The clock says the credentials are about to expire, so every round must refresh.
      let clock = Date.now();
      const source = cliCredentialSource({
        command: c.command,
        commandEnv: c.commandEnv,
        now: () => clock,
        skewMs: 3_600_000 * 2,
      });
      await Promise.all(Array.from({ length: 10 }, () => source.env()));
      expect(c.runs()).toBe(1);
      clock += 1000;
      await Promise.all(Array.from({ length: 10 }, () => source.env()));
      expect(c.runs()).toBe(2);
    },
    SLOW,
  );

  test(
    "a long-lived key is refused and its secret appears nowhere in the error",
    async () => {
      const c = counted({
        AWS_ACCESS_KEY_ID: "AKIATESTTESTTESTTEST",
        AWS_SECRET_ACCESS_KEY: "do-not-print-this-secret",
      });
      const source = cliCredentialSource({ command: c.command, commandEnv: c.commandEnv });
      const err = await source.env().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AwsCliError);
      expect((err as AwsCliError).code).toBe("long-lived-credentials");
      expect(String((err as Error).message)).not.toContain("do-not-print");
      expect(String((err as Error).message)).not.toContain("AKIA");
    },
    SLOW,
  );

  test(
    "a failed export is a fixed-word error, and the next call tries again",
    async () => {
      const c = counted({});
      const source = cliCredentialSource({ command: c.command, commandEnv: c.commandEnv });
      for (let i = 1; i <= 2; i++) {
        const err = await source.env().then(
          () => null,
          (e: unknown) => e,
        );
        expect((err as AwsCliError).code).toBe("credentials");
        expect(c.runs()).toBe(i);
      }
    },
    SLOW,
  );
});

describe("the runner with a credential source", () => {
  test(
    "signs every call with the source's credentials, not the ambient ones",
    async () => {
      standin = startS3Standin();
      const c = counted({
        AWS_ACCESS_KEY_ID: "ASIASOURCESOURCESOURC",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_SESSION_TOKEN: "token",
        AWS_CREDENTIAL_EXPIRATION: future(),
      });
      const aws = createAwsRunner({
        region: "us-east-2",
        timeoutMs: 60_000,
        endpointUrl: standin.url,
        // The ambient environment carries a DIFFERENT key; the source must win over it.
        env: {
          ...HERMETIC,
          AWS_ACCESS_KEY_ID: "ASIAAMBIENTAMBIENTAMB",
          AWS_SECRET_ACCESS_KEY: "ambient",
          AWS_SESSION_TOKEN: "ambient",
        },
        credentials: cliCredentialSource({ command: c.command, commandEnv: c.commandEnv }),
      });
      await Promise.all(
        Array.from({ length: 6 }, () => aws.api("list-object-versions", ["--bucket", BUCKET])),
      );
      expect(c.runs()).toBe(1);
      const ids = new Set(standin.log.map((e) => e.keyId));
      expect([...ids]).toEqual(["ASIASOURCESOURCESOURC"]);
    },
    SLOW,
  );
});
