// Shared fixtures for the support-ticket tests (epic #1893 phase 3): real users in a real
// migrated database, and RFC 5322 messages written out as text for the real MIME parser.

import type { Database } from "bun:sqlite";

let counter = 0;

/** Insert a user and return its id. Addresses are example/test domains only. */
export function seedUser(
  db: Database,
  opts: {
    username?: string;
    role?: "owner" | "admin" | "member";
    status?: "approved" | "verified" | "pending" | "revoked";
    email?: string;
    accountKind?: "person" | "service" | "test";
  } = {},
): number {
  counter += 1;
  const username = opts.username ?? `ticketuser${counter}`;
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, account_kind)
     VALUES (?, ?, 'x', ?, ?, 1, ?)`,
    [
      username,
      opts.email ?? `${username}@example.com`,
      opts.status ?? "approved",
      opts.role ?? "admin",
      opts.accountKind ?? "person",
    ],
  );
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error("seed: user insert failed");
  return row.id;
}

export interface EmlOptions {
  from?: string;
  to?: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  /** The Authentication-Results value; null omits the header. */
  auth?: string | null;
  /** Extra headers placed after the Authentication-Results header. */
  extraHeaders?: string[];
  body?: string;
  html?: string;
}

export const PASS =
  "mx.cloudflare.net; spf=pass smtp.mailfrom=sender.example; dkim=pass header.d=sender.example; dmarc=pass header.from=sender.example";

/** A message as text, CRLF line ends, parsed by the real parser in the tests. */
export function eml(o: EmlOptions = {}): Uint8Array {
  const lines: string[] = [];
  if (o.auth !== null) lines.push(`Authentication-Results: ${o.auth ?? PASS}`);
  lines.push(...(o.extraHeaders ?? []));
  lines.push(`From: ${o.from ?? "Ada Sender <ada@sender.example>"}`);
  lines.push(`To: ${o.to ?? "support@staging.nemar.test"}`);
  lines.push(`Subject: ${o.subject ?? "Help with an upload"}`);
  lines.push(`Message-ID: ${o.messageId ?? `<m${++counter}@sender.example>`}`);
  if (o.inReplyTo) lines.push(`In-Reply-To: ${o.inReplyTo}`);
  if (o.references) lines.push(`References: ${o.references}`);
  lines.push("Date: Sat, 24 Oct 2026 10:00:00 +0000", "MIME-Version: 1.0");
  if (o.html !== undefined) {
    lines.push("Content-Type: text/html; charset=utf-8", "", o.html, "");
  } else {
    lines.push("Content-Type: text/plain; charset=utf-8", "", o.body ?? "Hello team.", "");
  }
  return new TextEncoder().encode(lines.join("\r\n"));
}
