/**
 * The credential scan (epic #2021 phase D3b, #2024; `src/lib/compute/secret-scan.ts`).
 *
 * THIS IS A PUBLIC REPOSITORY and secret scanners read it: no credential-shaped literal is written in this
 * file. Every fake is assembled at run time from fragments (`join`), so the source holds only pieces that
 * match no scanner's pattern. The process-level proof that a finding ends a command with exit 2 BEFORE any
 * request reaches a server is `compute-submit-cli.test.ts`.
 *
 * What is pinned: each rule fires on its own fake and only on it; the value, the matching text and the line
 * never appear in a finding or in what describes one; a clean folder and the near-misses pass; the NEMAR
 * key rule agrees with the Worker's own key generator; and every rule is exercised, so deleting one fails
 * a test (the mutation of the phase report, "skip one rule").
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateApiKey } from "../backend/src/services/token";
import { OIDC_ACCESS_TOKEN_PREFIX, OIDC_REFRESH_TOKEN_PREFIX } from "../shared/oidc";
import { collectFolder, packCollected } from "../src/lib/compute/pack";
import {
  SECRET_RULE_NAMES,
  type SecretRuleName,
  describeFinding,
  isCredentialFileName,
  scanFile,
  scanValue,
} from "../src/lib/compute/secret-scan";

const enc = (text: string) => new TextEncoder().encode(text);
const rep = (ch: string, n: number) => ch.repeat(n);

/** One fake per CONTENT rule, assembled from pieces. */
const FAKES: Record<Exclude<SecretRuleName, "credential_file_name">, string> = {
  private_key_block: ["-----", "BEGIN RSA ", "PRIVATE", " KEY", "-----"].join(""),
  aws_access_key_id: ["AK", "IA", rep("Q", 16)].join(""),
  aws_secret_access_key: ["aws_secret", "_access_key", " = ", rep("a", 40)].join(""),
  google_api_key: ["AI", "za", rep("b", 35)].join(""),
  azure_storage_key: ["Account", "Key=", rep("c", 70), "=="].join(""),
  github_token: ["gh", "p_", rep("d", 36)].join(""),
  gitlab_token: ["gl", "pat-", rep("e", 24)].join(""),
  huggingface_token: ["h", "f_", rep("f", 36)].join(""),
  slack_token: ["xo", "xb-", rep("1", 12)].join(""),
  nemar_api_key: ["n", "m_", rep("g", 43)].join(""),
  nemar_oidc_token: [OIDC_ACCESS_TOKEN_PREFIX, rep("h", 24)].join(""),
};

describe("each rule fires on its own fake", () => {
  for (const [rule, fake] of Object.entries(FAKES)) {
    test(rule, () => {
      const found = scanFile("src/run.py", enc(`import os\n\n# note\nvalue = "${fake}"\n`));
      expect(found.map((f) => f.rule)).toContain(rule);
      const own = found.find((f) => f.rule === rule);
      expect(own).toEqual({ rule, where: "src/run.py", line: 4 });
    });
  }

  test("every content rule has a fake, and every rule in the list is one of them or the name rule", () => {
    expect([...SECRET_RULE_NAMES].sort()).toEqual(
      [...Object.keys(FAKES), "credential_file_name"].sort(),
    );
  });

  test("a fake fires ONLY its own rule (a skipped or merged rule would show here)", () => {
    for (const [rule, fake] of Object.entries(FAKES)) {
      const found = scanFile("a.txt", enc(fake)).map((f) => f.rule);
      expect(found).toEqual([rule as SecretRuleName]);
    }
  });

  test("a refresh token and a bare NEMAR key are found anywhere in a binary file", () => {
    const refresh = [OIDC_REFRESH_TOKEN_PREFIX, rep("i", 24)].join("");
    const bytes = new Uint8Array([0, 255, 1, 2, ...enc(refresh), 200, 0]);
    expect(scanFile("model.bin", bytes).map((f) => f.rule)).toEqual(["nemar_oidc_token"]);
  });

  test("the NEMAR key rule agrees with the Worker's own key generator", () => {
    for (let i = 0; i < 50; i++) {
      const { apiKey } = generateApiKey();
      expect(scanFile("k.txt", enc(`KEY=${apiKey}\n`)).map((f) => f.rule)).toEqual([
        "nemar_api_key",
      ]);
    }
  });
});

describe("the value never appears", () => {
  test("not in a finding, not in the description, not in any serialization of either", () => {
    for (const [rule, fake] of Object.entries(FAKES)) {
      const found = scanFile("secret-here.py", enc(`x = 1\ntoken = '${fake}'\n`));
      const everything = JSON.stringify(found) + found.map(describeFinding).join("\n");
      expect(everything).not.toContain(fake);
      // not even the last part of it (the first part of some fakes is the rule's own words)
      expect(everything).not.toContain(fake.slice(-20));
      expect(describeFinding(found.find((f) => f.rule === rule) as never)).toBe(
        `secret-here.py:2  ${rule}`,
      );
    }
  });

  test("a finding has exactly three fields", () => {
    const [f] = scanFile("x", enc(FAKES.github_token));
    expect(Object.keys(f as object).sort()).toEqual(["line", "rule", "where"]);
  });

  test("a value on the command line is reported by place, with no line", () => {
    const found = scanValue("argument 2", `--token=${FAKES.github_token}`);
    expect(found).toEqual([{ rule: "github_token", where: "argument 2", line: null }]);
    expect(describeFinding(found[0] as never)).toBe("argument 2  github_token");
  });

  test("a rule is reported once per file, at its first line", () => {
    const many = Array.from({ length: 20 }, () => FAKES.github_token).join("\n");
    expect(scanFile("keys.txt", enc(`\n\n${many}`))).toEqual([
      { rule: "github_token", where: "keys.txt", line: 3 },
    ]);
  });
});

describe("a clean folder passes, and so do the near-misses", () => {
  test("an ordinary analysis script and its data are not findings", () => {
    const script = [
      "import numpy as np",
      "import mne",
      "# /// nemar",
      "# cores = 4",
      "# ///",
      "raw = mne.io.read_raw_edf('data.edf')",
      "api_key_name = 'not a key'",
      "path = '/home/user/.config/tool'",
      "print(np.arange(10))",
    ].join("\n");
    expect(scanFile("run.py", enc(script))).toEqual([]);
    expect(scanFile("table.csv", enc("a,b,c\n1,2,3\n"))).toEqual([]);
  });

  test("short or malformed look-alikes of each token are not findings", () => {
    const near = [
      ["AK", "IA", rep("Q", 8)].join(""),
      ["gh", "p_", rep("d", 10)].join(""),
      ["h", "f_", rep("f", 10)].join(""),
      ["n", "m_", rep("g", 20)].join(""),
      "nm_compute_the_average_of_all_channels",
      ["-----", "BEGIN CERTIFICATE", "-----"].join(""),
      ["-----", "BEGIN PUBLIC KEY", "-----"].join(""),
      `${OIDC_ACCESS_TOKEN_PREFIX}short`,
    ];
    for (const text of near) expect(scanFile("a.txt", enc(text))).toEqual([]);
  });

  test("a token glued to a longer identifier is not a token", () => {
    expect(scanFile("a.txt", enc(`x${FAKES.github_token}`))).toEqual([]);
    expect(scanFile("a.txt", enc(`my_${FAKES.huggingface_token}`))).toEqual([]);
  });
});

describe("text in other encodings", () => {
  const body = `# settings\nname = x\ntoken = '${FAKES.github_token}'\n`;
  const utf16le = (text: string, bom: boolean) =>
    new Uint8Array([...(bom ? [0xff, 0xfe] : []), ...Buffer.from(text, "utf16le")]);
  const utf16be = (text: string, bom: boolean) => {
    const le = Buffer.from(text, "utf16le");
    for (let i = 0; i + 1 < le.length; i += 2) {
      const a = le[i] as number;
      le[i] = le[i + 1] as number;
      le[i + 1] = a;
    }
    return new Uint8Array([...(bom ? [0xfe, 0xff] : []), ...le]);
  };

  for (const [what, bytes] of [
    ["UTF-16LE with a byte-order mark", utf16le(body, true)],
    ["UTF-16LE without one", utf16le(body, false)],
    ["UTF-16BE with a byte-order mark", utf16be(body, true)],
    ["UTF-16BE without one", utf16be(body, false)],
  ] as const) {
    test(`${what}: found, at its line`, () => {
      expect(scanFile("config.txt", bytes)).toEqual([
        { rule: "github_token", where: "config.txt", line: 3 },
      ]);
    });
  }

  test("a key among NUL bytes in a binary file is found, and clean text in UTF-16 is not a finding", () => {
    const bytes = new Uint8Array([0, 0, 1, ...enc("x"), 0, ...enc(FAKES.google_api_key), 0, 0]);
    expect(scanFile("blob.bin", bytes).map((f) => f.rule)).toEqual(["google_api_key"]);
    expect(scanFile("clean.txt", utf16le("just some text\nwith lines\n", true))).toEqual([]);
  });

  test("a token after a character outside Latin-1 is found by the decoded view (NUL stripping alone would miss it)", () => {
    const bytes = utf16le(`\u65e5${FAKES.github_token}\n`, true);
    expect(scanFile("cjk.txt", bytes).map((f) => f.rule)).toEqual(["github_token"]);
  });

  test("UTF-16 text inside a mostly ASCII file is found by the NUL-stripped view", () => {
    const bytes = new Uint8Array([
      ...enc("plain ascii line\n".repeat(40)),
      ...utf16le(`${FAKES.gitlab_token}\n`, false),
    ]);
    expect(scanFile("mixed.bin", bytes).map((f) => f.rule)).toEqual(["gitlab_token"]);
  });

  test("a rule found in two views is one finding", () => {
    const both = new Uint8Array([...enc(`${FAKES.github_token}\n`), 0, ...enc("tail")]);
    expect(scanFile("both.txt", both)).toEqual([
      { rule: "github_token", where: "both.txt", line: 1 },
    ]);
  });
});

describe("credential file names", () => {
  const credentialNames = [
    ".env",
    ".ENV",
    "sub/.env",
    ".env.local",
    ".env.production",
    ".netrc",
    "_netrc",
    ".pgpass",
    ".git-credentials",
    ".pypirc",
    ".npmrc",
    "id_rsa",
    "keys/id_ed25519",
    "id_ecdsa",
    "server.pem",
    "deep/private.KEY",
    "store.p12",
    "cert.pfx",
    "app.jks",
    ".aws/credentials",
    "home/.aws/credentials",
    "secrets.json",
    "config/secrets.yaml",
    ".envrc",
    "prod.env",
    "deploy/staging.ENV",
    "credentials.json",
    "gcp/service-account.json",
  ];
  for (const name of credentialNames) {
    test(`${name} is refused by name, whatever it holds`, () => {
      expect(scanFile(name, enc("harmless text\n"))).toEqual([
        { rule: "credential_file_name", where: name, line: null },
      ]);
    });
  }

  test("templates and look-alikes are not", () => {
    for (const name of [
      ".env.example",
      ".env.sample",
      ".env.template",
      "env.py",
      "environment.yml",
      "id_rsa.pub",
      "monkey.py",
      "key.py",
      "aws/credentials.md",
      "secrets.md",
      "environment.py",
      "my-env-notes.txt",
      "credentials.md",
      "service-account.md",
      "envrc-notes.md",
      "README.md",
    ]) {
      expect(isCredentialFileName(name)).toBe(false);
    }
  });
});

describe("in the packer: the scan sees the exact bytes and stops the archive", () => {
  const dir = mkdtempSync(join(tmpdir(), "nemar-scan-"));
  test("a folder with a secret in one file is not packed; a clean one is; .nemarignore leaves the file out", () => {
    writeFileSync(join(dir, "run.py"), "print(1)\n");
    writeFileSync(join(dir, "notes.txt"), `line one\nthe key ${FAKES.gitlab_token}\n`);
    const collect = () => {
      const r = collectFolder(dir);
      if (!r.ok) throw new Error("ignore file");
      return r.collected;
    };
    const findings: ReturnType<typeof scanFile> = [];
    const inspect = (path: string, bytes: Uint8Array) => {
      const f = scanFile(path, bytes);
      findings.push(...f);
      return f.length;
    };
    expect(packCollected(collect(), { entry: "run.py", inspect })).toEqual({
      ok: false,
      reason: "inspected",
      inspected: 1,
    });
    expect(findings).toEqual([{ rule: "gitlab_token", where: "notes.txt", line: 2 }]);

    writeFileSync(join(dir, ".nemarignore"), "notes.txt\n");
    findings.length = 0;
    const packed = packCollected(collect(), { entry: "run.py", inspect });
    expect(packed.ok).toBe(true);
    expect(findings).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
