/**
 * The credential scan: a bundle that holds a secret never leaves the machine (epic #2021 phase D3b, #2024;
 * the design's Protection Level 4: secrets are REFUSED, never stored).
 *
 * The scan runs on the exact bytes that are packed (`pack.ts` hands each file to it as it is read), before
 * any request is made, and a finding ends the command with exit 2. THERE IS NO OVERRIDE: the remedy is
 * to leave the file out (`.nemarignore`) or to take the secret out of it, and the output says so.
 *
 * WHAT IT NEVER DOES. A finding is a RULE NAME and a place (`path:line`, or the path alone for a file name,
 * or "argument 2" for the command line); it never carries the value, the matching text or the line it was
 * found on, and nothing here returns them, so no caller can print one. A finding is reported once per rule
 * and file (the first line), so a file full of keys is one line of output, not a column of secrets' places.
 *
 * WHAT IT LOOKS FOR, by rule name:
 *  - `private_key_block`: the BEGIN line of a PEM or PGP private key;
 *  - `aws_access_key_id`, `aws_secret_access_key`, `google_api_key`, `azure_storage_key`: cloud keys;
 *  - `github_token`, `gitlab_token`, `huggingface_token`, `slack_token`: source-host and service tokens;
 *  - `nemar_api_key`, `nemar_oidc_token`: NEMAR's own (`nm_` and 43 characters of base64url, the format of
 *    `generateApiKey` in the Worker, which a test holds this to; the `nmo_at_` and `nmo_rt_` prefixes are
 *    `shared/oidc.ts`'s);
 *  - `credential_file_name`: a file called `.env` (but not `.env.example`), `.netrc`, `id_rsa`, `*.pem`,
 *    `*.key`, `.aws/credentials` and the like, whatever is inside.
 *
 * TEXT ENCODINGS. A file is looked at three ways: as Latin-1 (every byte a character), as UTF-16 when it
 * starts with a byte-order mark or is mostly NUL bytes (decoded little or big endian by where the NULs
 * fall), and with its NUL bytes removed (which reads UTF-16 and UTF-32 text of ASCII characters whatever
 * the mark). A rule found in any view is one finding.
 *
 * WHAT IT DOES NOT CATCH, said plainly: a token wrapped across lines, a token split into pieces and
 * joined by the program, one hidden in an archive, an image or any compressed or encrypted file, and a
 * bare 40-character AWS secret key with no field name near it. It is a net for the common mistakes, not a
 * proof that a bundle holds no secret.
 */

import { OIDC_ACCESS_TOKEN_PREFIX, OIDC_REFRESH_TOKEN_PREFIX } from "../../../shared/oidc.js";

export interface Finding {
  /** One of {@link SECRET_RULE_NAMES}. */
  rule: SecretRuleName;
  /** The file's path in the bundle, or "argument N" / "environment NAME" for the command line. */
  where: string;
  /** The 1-based line of the first match; null for a file name or a command-line value. */
  line: number | null;
}

interface ContentRule {
  name: string;
  pattern: RegExp;
}

// The flags are `g` (so `exec` walks matches) and nothing else but where a rule says. No pattern has a
// nested quantifier: each is linear in the input.
const CONTENT_RULES = [
  {
    name: "private_key_block",
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    name: "aws_access_key_id",
    pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  },
  {
    name: "aws_secret_access_key",
    pattern: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/gi,
  },
  { name: "google_api_key", pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { name: "azure_storage_key", pattern: /AccountKey=[A-Za-z0-9+/]{60,}={0,2}/g },
  {
    name: "github_token",
    pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})/g,
  },
  { name: "gitlab_token", pattern: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/g },
  { name: "huggingface_token", pattern: /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{34,}/g },
  { name: "slack_token", pattern: /(?<![A-Za-z0-9])xox[abeprs]-[0-9A-Za-z-]{10,}/g },
  {
    name: "nemar_api_key",
    pattern: /(?<![A-Za-z0-9_-])nm_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
  },
  {
    name: "nemar_oidc_token",
    pattern: new RegExp(
      `(?<![A-Za-z0-9_])(?:${OIDC_ACCESS_TOKEN_PREFIX}|${OIDC_REFRESH_TOKEN_PREFIX})[A-Za-z0-9_-]{16,}`,
      "g",
    ),
  },
] as const satisfies readonly ContentRule[];

/** The one rule that looks at a file's NAME. */
const NAME_RULE = "credential_file_name";

export const SECRET_RULE_NAMES = [...CONTENT_RULES.map((r) => r.name), NAME_RULE] as const;

export type SecretRuleName = (typeof SECRET_RULE_NAMES)[number];

// --- File names ----------------------------------------------------------------------------------

const EXACT_NAMES = new Set([
  ".netrc",
  "_netrc",
  ".envrc",
  "credentials.json",
  "service-account.json",
  ".pgpass",
  ".git-credentials",
  ".htpasswd",
  ".pypirc",
  ".npmrc",
  ".dockercfg",
  ".secrets",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "secrets.toml",
]);

/** File name endings: `*.pem`, `*.key`, `prod.env` and the key stores. `environment.py` and `my-env-notes.txt` are not. */
const SUFFIXES = [".pem", ".key", ".env", ".p12", ".pfx", ".jks", ".keystore", ".ppk", ".kdbx"];

/** `.env` files that hold no secret by convention: a template. */
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);

/** Whether a path's file NAME is one that holds credentials. Pure. */
export function isCredentialFileName(path: string): boolean {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (ENV_TEMPLATES.has(name)) return false;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (EXACT_NAMES.has(name)) return true;
  if (SUFFIXES.some((s) => name.endsWith(s))) return true;
  return lower === ".aws/credentials" || lower.endsWith("/.aws/credentials");
}

// --- Content -------------------------------------------------------------------------------------

function lineOf(text: string, index: number): number {
  let line = 1;
  let at = text.indexOf("\n");
  while (at !== -1 && at < index) {
    line++;
    at = text.indexOf("\n", at + 1);
  }
  return line;
}

/**
 * Scans text for the content rules. `where` names the place for a finding; `withLines` says whether the
 * text has lines worth naming (a file does, an argument does not).
 */
function scanString(where: string, text: string, withLines: boolean): Finding[] {
  const found: Finding[] = [];
  for (const rule of CONTENT_RULES) {
    rule.pattern.lastIndex = 0;
    const match = rule.pattern.exec(text);
    if (match === null) continue;
    found.push({
      rule: rule.name,
      where,
      line: withLines ? lineOf(text, match.index) : null,
    });
  }
  return found;
}

/**
 * The findings for one file of the bundle: its NAME first, then its bytes. A bundle file is read as bytes
 * and looked at as Latin-1 text, which keeps every byte a character, so a key inside a binary file is
 * still found and no byte sequence can fail to decode.
 */
export function scanFile(path: string, bytes: Uint8Array): Finding[] {
  const found: Finding[] = [];
  if (isCredentialFileName(path)) found.push({ rule: NAME_RULE, where: path, line: null });
  const seen = new Set<string>();
  for (const view of textViews(bytes)) {
    for (const finding of scanString(path, view, true)) {
      if (seen.has(finding.rule)) continue;
      seen.add(finding.rule);
      found.push(finding);
    }
  }
  return found;
}

/**
 * The ways a file's bytes read as text: Latin-1; UTF-16 decoded when there is a byte-order mark or the
 * file is mostly NUL bytes; and the bytes with every NUL removed (when there are any).
 */
function textViews(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const views = [buffer.toString("latin1")];
  let nuls = 0;
  let evenNuls = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      nuls++;
      if (i % 2 === 0) evenNuls++;
    }
  }
  if (nuls === 0) return views;
  const bom16le = bytes[0] === 0xff && bytes[1] === 0xfe;
  const bom16be = bytes[0] === 0xfe && bytes[1] === 0xff;
  if (bom16le || bom16be || nuls / bytes.length >= 0.25) {
    const bigEndian = bom16be || (!bom16le && evenNuls > nuls / 2);
    views.push(new TextDecoder((bigEndian ? "utf-16be" : "utf-16le") as "utf-16le").decode(bytes));
  }
  views.push(Buffer.from(bytes.filter((b) => b !== 0)).toString("latin1"));
  return views;
}

/** The findings for a value that is sent in the request itself (an argument, an environment value, a name). */
export function scanValue(where: string, text: string): Finding[] {
  return scanString(where, text, false);
}

/** `path:line  rule`, `path  rule` for a name or a value: a place and a rule, never a value. */
export function describeFinding(finding: Finding): string {
  const place = finding.line === null ? finding.where : `${finding.where}:${finding.line}`;
  return `${place}  ${finding.rule}`;
}

/** What to do about a finding. Said once, after the list. */
export const SECRET_REMEDY =
  "Nothing was sent. Take the secret out of the file, or leave the file out of the bundle by adding its path to .nemarignore. A job cannot be given a secret this way; there is no override.";
