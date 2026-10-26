/**
 * Screening of inbound mail before and after it is stored (epic #1893 follow-up, ADR 0113).
 *
 * Email Routing does no content filtering, so the Worker adds four cheap protections:
 *   1. a sender blocklist, checked at delivery, which refuses a message and stores nothing;
 *   2. detection of bulk, automatic and bounce mail, which is filed quietly (see tickets.ts);
 *   3. a per-sender hourly cap, whose overflow is filed the same way;
 *   4. quiet queues (ticket-notify.ts).
 *
 * This module holds the parts that need no ticket: the pure classifier, the address parsing, the
 * rules for what may be blocked, and the delivery-time lookup. Everything here fails open: a
 * lookup that throws is the caller's to log, and the message is stored as usual.
 */

import { addressParser } from "postal-mime";
import {
  BLOCK_KINDS,
  type BlockKind,
  type FilterReason,
} from "../../../shared/contract/mail-admin";

/** Header names and values come from postal-mime: `{ key, value }`, key in any case. */
export interface HeaderLike {
  key: string;
  value: string;
}

/** The default of `MAIL_SENDER_HOURLY_CAP`, used when it is unset or not a usable number. */
export const DEFAULT_SENDER_HOURLY_CAP = 20;
const MAX_SENDER_HOURLY_CAP = 100_000;

/** `MAIL_SENDER_HOURLY_CAP` as a whole number from 1 to 100000, else the default. */
export function senderHourlyCap(raw: string | undefined): number {
  const text = (raw ?? "").trim();
  if (!/^\d{1,6}$/.test(text)) return DEFAULT_SENDER_HOURLY_CAP;
  const n = Number(text);
  return n >= 1 && n <= MAX_SENDER_HOURLY_CAP ? n : DEFAULT_SENDER_HOURLY_CAP;
}

// ---------------------------------------------------------------------------------------------
// Automatic and bulk mail
// ---------------------------------------------------------------------------------------------

function headerValues(headers: readonly HeaderLike[], name: string): string[] {
  return headers.filter((h) => h.key.toLowerCase() === name).map((h) => h.value.trim());
}

const BOT_LOCAL_PARTS: ReadonlySet<string> = new Set(["mailer-daemon", "postmaster"]);

/**
 * Whether a message is automatic, bulk or a bounce, from its headers and envelope sender alone.
 * Most specific first: a bounce, then an automatic reply, then bulk or list mail. `null` is mail
 * a person may have written.
 *
 * - bounce: an empty or `<>` envelope sender, a `mailer-daemon` or `postmaster` local part on
 *   either sender address, or a `multipart/report` content type (a delivery status notification);
 * - auto_reply: `Auto-Submitted` present and not `no`, `X-Autoreply` or `X-Autorespond` present,
 *   or `Precedence: auto_reply`. `X-Auto-Response-Suppress` is NOT read: help desks and ticketing
 *   systems set it on genuine messages to stop OTHERS auto-replying to them;
 * - bulk: `Precedence` of bulk, list or junk,
 *   or a `List-Id` or `List-Unsubscribe` header.
 *
 * A sender controls every one of these headers, so this only files mail more quietly; it never
 * hides a ticket and a person can always find it with the `filtered` list option.
 */
export function classifyAutomatedMail(
  headers: readonly HeaderLike[],
  envelopeFrom: string,
  fromAddress = "",
): Exclude<FilterReason, "rate_limited"> | null {
  const envelope = envelopeFrom.trim().toLowerCase();
  const envelopeLocal = envelope.split("@")[0] ?? "";
  const headerLocal = fromAddress.toLowerCase().split("@")[0] ?? "";
  const contentType = headerValues(headers, "content-type")[0]?.toLowerCase() ?? "";
  if (
    envelope === "" ||
    envelope === "<>" ||
    BOT_LOCAL_PARTS.has(envelopeLocal) ||
    BOT_LOCAL_PARTS.has(headerLocal) ||
    /^multipart\/report\b/.test(contentType)
  ) {
    return "bounce";
  }

  const autoSubmitted = headerValues(headers, "auto-submitted");
  const precedence = headerValues(headers, "precedence").map((v) => v.toLowerCase());
  if (
    autoSubmitted.some((v) => v.toLowerCase() !== "no") ||
    headerValues(headers, "x-autoreply").length > 0 ||
    headerValues(headers, "x-autorespond").length > 0 ||
    precedence.includes("auto_reply")
  ) {
    return "auto_reply";
  }
  if (
    precedence.some((v) => v === "bulk" || v === "list" || v === "junk") ||
    headerValues(headers, "list-id").length > 0 ||
    headerValues(headers, "list-unsubscribe").length > 0
  ) {
    return "bulk";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------

/** The domain of an address, lowercased; "" when there is none. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).toLowerCase();
}

/**
 * Every address in a `From` (or other address) header value, lowercased, groups flattened. A value
 * that does not parse, or names no address, gives none. `Name <a@b>` and a bare `a@b` both work;
 * a display name that itself looks like an address (`"x@y" <a@b>`) is not an address.
 */
export function addressesIn(value: string | null | undefined): string[] {
  if (!value) return [];
  let parsed: ReturnType<typeof addressParser>;
  try {
    parsed = addressParser(value, { flatten: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of parsed) {
    const address = "address" in entry && typeof entry.address === "string" ? entry.address : "";
    const clean = address.trim().toLowerCase();
    if (clean.includes("@") && !out.includes(clean)) out.push(clean);
  }
  return out;
}

/** `a.b.example` gives `a.b.example`, `b.example`, `example`: the domain and every parent. */
function domainChain(domain: string): string[] {
  const labels = domain.split(".").filter(Boolean);
  const chain: string[] = [];
  for (let i = 0; i < labels.length; i++) chain.push(labels.slice(i).join("."));
  return chain;
}

// ---------------------------------------------------------------------------------------------
// What may be blocked
// ---------------------------------------------------------------------------------------------

/** The domain that is ours; a block here would refuse our own staff and every reply. */
export const OWN_DOMAIN = "nemar.org";

/** Mailbox providers shared by unrelated people: their domain is never blocked, an address may be. */
const SHARED_PROVIDERS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "qq.com",
  "163.com",
  "126.com",
  "web.de",
  "mail.ru",
  "naver.com",
  "zoho.com",
  "fastmail.com",
  "pm.me",
  "msn.com",
  "ymail.com",
]);
/** Providers that run one service under many country domains (`yahoo.co.uk`, `outlook.fr`). */
const PROVIDER_FAMILIES = /^(?:gmx|yahoo|hotmail|outlook|live|yandex)\.[a-z]{2,3}(?:\.[a-z]{2})?$/;

/**
 * Domains under which unrelated parties register their own names, so blocking one blocks everybody
 * beneath it: second-level labels that ccTLDs reserve (`co.uk`, `ac.jp`, `edu.au`, `com.br`), and
 * hosting suffixes. A bare TLD is refused by the shape rule (a domain needs two labels).
 */
const SECOND_LEVEL_LABELS: ReadonlySet<string> = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "gov",
  "org",
  "net",
  "ne",
  "or",
  "go",
  "mil",
]);
const HOSTING_SUFFIXES: ReadonlySet<string> = new Set([
  "github.io",
  "pages.dev",
  "workers.dev",
  "herokuapp.com",
  "vercel.app",
  "netlify.app",
]);

function isPublicSuffix(domain: string): boolean {
  if (HOSTING_SUFFIXES.has(domain)) return true;
  const labels = domain.split(".");
  return labels.length === 2 && SECOND_LEVEL_LABELS.has(labels[0]) && /^[a-z]{2}$/.test(labels[1]);
}

function isOwnDomain(domain: string, extra: readonly string[]): boolean {
  return [OWN_DOMAIN, ...extra].some(
    (own) => own !== "" && (domain === own || domain.endsWith(`.${own}`)),
  );
}

function isSharedProvider(domain: string): boolean {
  return domainChain(domain).some((d) => SHARED_PROVIDERS.has(d) || PROVIDER_FAMILIES.test(d));
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_SHAPE = new RegExp(`^(?:${LABEL}\\.)+[a-z0-9-]{2,63}$`);
const ADDRESS_SHAPE = /^[^\s@<>,;:"()[\]\\]{1,64}@[a-z0-9.-]{1,253}$/;

export interface BlockCandidate {
  kind: BlockKind;
  value: string;
}

/**
 * The value to store for a requested block: trimmed and lowercased, with a leading `@` of a domain
 * dropped. Returns a sentence when the request is not blockable (malformed, our own domain, or a
 * shared mailbox provider's domain), else the normalized candidate.
 */
export function normalizeBlock(
  kind: string,
  rawValue: string,
  ownDomains: readonly string[] = [],
): BlockCandidate | { refusal: string; malformed: boolean } {
  if (!(BLOCK_KINDS as readonly string[]).includes(kind)) {
    return { refusal: `kind must be one of ${BLOCK_KINDS.join(", ")}.`, malformed: true };
  }
  let value = rawValue.trim().toLowerCase();
  if (kind === "domain") {
    value = value.replace(/^@/, "");
    if (!DOMAIN_SHAPE.test(value)) {
      return { refusal: "That is not a domain name (like spam.example).", malformed: true };
    }
    if (isOwnDomain(value, ownDomains)) {
      return { refusal: "Our own domain and its subdomains cannot be blocked.", malformed: false };
    }
    if (isPublicSuffix(value)) {
      return {
        refusal:
          "That is a public suffix (like co.uk or edu.au): blocking it would block every organisation under it.",
        malformed: false,
      };
    }
    if (isSharedProvider(value)) {
      return {
        refusal:
          "That domain is a shared mailbox provider: block the address, not the whole provider.",
        malformed: false,
      };
    }
    return { kind: "domain", value };
  }
  const domain = domainOf(value);
  if (!ADDRESS_SHAPE.test(value) || !DOMAIN_SHAPE.test(domain)) {
    return {
      refusal: "That is not an email address (like someone@spam.example).",
      malformed: true,
    };
  }
  if (isOwnDomain(domain, ownDomains)) {
    return { refusal: "Addresses on our own domain cannot be blocked.", malformed: false };
  }
  return { kind: "address", value };
}

// ---------------------------------------------------------------------------------------------
// Delivery-time check
// ---------------------------------------------------------------------------------------------

export interface BlockMatch {
  kind: BlockKind;
  value: string;
}

/**
 * The first blocklist entry that covers any of `addresses`: the address itself, its domain, or
 * any parent domain of it (blocking `spam.example` covers `a.spam.example`). Empty addresses are
 * skipped, so a bounce (empty envelope sender) matches nothing. Throws when the lookup fails;
 * the delivery path catches that and stores the message (fail open).
 */
export async function findBlock(
  db: D1Database,
  addresses: readonly string[],
): Promise<BlockMatch | null> {
  const exact = new Set<string>();
  const domains = new Set<string>();
  for (const raw of addresses) {
    const address = raw.trim().toLowerCase();
    if (!address.includes("@")) continue;
    exact.add(address);
    for (const d of domainChain(domainOf(address))) if (d.includes(".")) domains.add(d);
  }
  if (exact.size === 0) return null;
  const addrList = [...exact];
  const domList = [...domains];
  const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");
  const clauses = [`(kind = 'address' AND value IN (${marks(addrList.length)}))`];
  if (domList.length > 0) clauses.push(`(kind = 'domain' AND value IN (${marks(domList.length)}))`);
  return db
    .prepare(`SELECT kind, value FROM mail_blocklist WHERE ${clauses.join(" OR ")} LIMIT 1`)
    .bind(...addrList, ...domList)
    .first<BlockMatch>();
}
