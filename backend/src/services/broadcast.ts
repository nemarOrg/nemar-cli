/**
 * Broadcast email service
 *
 * Handles sending admin announcements to user groups via Resend batch API.
 * Supports markdown body converted to styled HTML matching NEMAR email templates.
 */

import { z } from "zod";
import { applyDevWrap, parseEmailPreferences } from "./email";

export type RecipientGroup = "all" | "admins" | "members";

/**
 * Value stored in `broadcast_emails.recipient_group`. Either a named group
 * or a per-user target encoded as `user:<username>`.
 */
export type RecipientGroupOrUser = RecipientGroup | `user:${string}`;

/**
 * Zod schema for POST /admin/notify request bodies.
 *
 * Exactly one of `to` (group broadcast) or `user` (per-user transactional)
 * must be present. Exposed from the service module so unit tests can
 * exercise the mutual-exclusion refinement directly without spinning up
 * a Hono test app.
 */
export const broadcastRequestSchema = z
  .object({
    to: z.enum(["all", "admins", "members"]).optional(),
    user: z.string().min(3).max(30).optional(),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(10000),
    dry_run: z.boolean().optional().default(false),
  })
  .refine((value) => Boolean(value.to) !== Boolean(value.user), {
    message: "Provide exactly one of 'to' (group) or 'user' (username)",
    path: ["to"],
  });

export type SingleUserLookupError = "not_found" | "no_email" | "not_approved";

export type SingleUserLookupResult =
  | { ok: true; email: string; user_id: number; username: string }
  | { ok: false; error: SingleUserLookupError; user_id?: number; username?: string };

export interface BroadcastResult {
  broadcast_id: number;
  recipient_count: number;
  failure_count: number;
  failed_recipients: string[];
  /** Set when the send was aborted before reaching Resend (e.g. missing key). */
  error?: string;
}

interface UserRow {
  email: string;
  email_preferences: string | null;
}

interface SingleUserRow {
  id: number;
  username: string;
  email: string | null;
  status: string;
  email_preferences: string | null;
}

const RESEND_BATCH_URL = "https://api.resend.com/emails/batch";
const BATCH_SIZE = 100;

/**
 * Get recipient emails for a broadcast, filtered by group and announcement preference.
 */
export async function getBroadcastRecipients(
  db: D1Database,
  group: RecipientGroup,
): Promise<string[]> {
  let roleFilter: string;
  switch (group) {
    case "admins":
      roleFilter = "AND role IN ('owner', 'admin')";
      break;
    case "members":
      roleFilter = "AND role = 'member'";
      break;
    default:
      roleFilter = "";
  }

  const result = await db
    .prepare(
      `SELECT email, email_preferences FROM users
       WHERE status = 'approved' AND deleted_at IS NULL ${roleFilter}`,
    )
    .all<UserRow>();

  if (!result.results) return [];

  return result.results
    .filter((row) => {
      const prefs = parseEmailPreferences(row.email_preferences);
      return prefs.announcements;
    })
    .map((r) => r.email);
}

/**
 * Resolve a single user recipient by username.
 *
 * Returns either the resolved recipient (id, email, username) or a structured
 * error describing why the user can't receive a transactional email. Callers
 * map these errors to HTTP responses. Per-user transactional sends ignore the
 * `announcements` email preference (this is direct admin contact, not a broadcast).
 */
export async function getBroadcastRecipientByUsername(
  db: D1Database,
  username: string,
): Promise<SingleUserLookupResult> {
  const row = await db
    .prepare(
      "SELECT id, username, email, status, email_preferences FROM users WHERE username = ? AND deleted_at IS NULL",
    )
    .bind(username)
    .first<SingleUserRow>();

  if (!row) {
    return { ok: false, error: "not_found" };
  }

  if (row.status !== "approved") {
    return { ok: false, error: "not_approved", user_id: row.id, username: row.username };
  }

  if (!row.email || !row.email.trim()) {
    return { ok: false, error: "no_email", user_id: row.id, username: row.username };
  }

  return {
    ok: true,
    email: row.email,
    user_id: row.id,
    username: row.username,
  };
}

/**
 * Convert simple markdown to inline-styled HTML for email.
 *
 * Handles: headings, bold, italic, links, inline code, unordered lists,
 * horizontal rules, and paragraphs. Designed for admin-written announcements.
 */
export function markdownToEmailHtml(markdown: string): string {
  const blocks = markdown.trim().split(/\n{2,}/);
  const htmlBlocks: string[] = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Horizontal rule
    if (/^---+$/.test(trimmed)) {
      htmlBlocks.push('<hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">');
      continue;
    }

    // ATX headings
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const sizes = ["24px", "20px", "18px"];
      const text = inlineMarkdown(headingMatch[2]);
      htmlBlocks.push(
        `<h${level} style="color: #333; font-size: ${sizes[level - 1]}; margin: 24px 0 8px 0;">${text}</h${level}>`,
      );
      continue;
    }

    // Unordered list
    const lines = trimmed.split("\n");
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      const items = lines
        .map(
          (l) => `<li style="margin: 4px 0;">${inlineMarkdown(l.replace(/^\s*[-*]\s+/, ""))}</li>`,
        )
        .join("\n");
      htmlBlocks.push(`<ul style="margin: 12px 0; padding-left: 24px;">\n${items}\n</ul>`);
      continue;
    }

    // Paragraph (with single newlines as <br>)
    const paraHtml = lines.map((l) => inlineMarkdown(l)).join("<br>\n");
    htmlBlocks.push(`<p style="margin: 12px 0; line-height: 1.6;">${paraHtml}</p>`);
  }

  return htmlBlocks.join("\n\n");
}

/**
 * Process inline markdown: bold, italic, links, code spans.
 */
function inlineMarkdown(text: string): string {
  let result = escapeHtml(text);
  // Code spans (before bold/italic to avoid conflicts)
  result = result.replace(
    /`([^`]+)`/g,
    '<code style="background: #f4f4f5; padding: 2px 6px; border-radius: 4px; font-size: 13px;">$1</code>',
  );
  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Italic
  result = result.replace(/\*(.+?)\*/g, "<em>$1</em>");
  // Links (only allow http/https schemes)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    if (!/^https?:\/\//i.test(href)) return label;
    return `<a href="${href}" style="color: #2563eb;">${label}</a>`;
  });
  return result;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Wrap converted markdown HTML in the standard NEMAR email template.
 */
export function buildBroadcastHtml(subject: string, bodyHtml: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #2563eb;">${escapeHtml(subject)}</h1>

  ${bodyHtml}

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #999; font-size: 12px; margin-top: 30px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;
}

interface ResendBatchItem {
  from: string;
  to: string[];
  subject: string;
  html: string;
  reply_to?: string;
}

interface ResendBatchResponseItem {
  id?: string;
  error?: string;
}

/**
 * Send broadcast emails via Resend batch API in chunks of 100.
 * Records result in the broadcast_emails audit table.
 */
export async function sendBroadcast(
  db: D1Database,
  resendApiKey: string,
  fromEmail: string,
  params: {
    sentById: number;
    group: RecipientGroupOrUser;
    subject: string;
    bodyMarkdown: string;
    recipients: string[];
  },
  replyTo?: string,
  isDev?: boolean,
): Promise<BroadcastResult> {
  // Guard: Resend key must be non-empty before iterating recipients.
  // A missing or blank key would silently record every recipient as a
  // failure while returning 200 to the caller.
  if (!resendApiKey || !resendApiKey.trim()) {
    console.error("[broadcast] RESEND_API_KEY is not configured; aborting send", {
      group: params.group,
      subject: params.subject,
      recipientCount: params.recipients.length,
    });
    return {
      broadcast_id: -1,
      recipient_count: 0,
      failure_count: 0,
      failed_recipients: [],
      error: "email_service_unconfigured",
    };
  }

  const bodyHtml = markdownToEmailHtml(params.bodyMarkdown);
  const html = buildBroadcastHtml(params.subject, bodyHtml);
  const wrapped = applyDevWrap(params.subject, html, isDev);
  const failedRecipients: string[] = [];
  let totalSent = 0;

  // Send in chunks of BATCH_SIZE
  for (let i = 0; i < params.recipients.length; i += BATCH_SIZE) {
    const chunk = params.recipients.slice(i, i + BATCH_SIZE);
    const batch: ResendBatchItem[] = chunk.map((email) => ({
      from: fromEmail,
      to: [email],
      subject: wrapped.subject,
      html: wrapped.html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }));

    try {
      const response = await fetch(RESEND_BATCH_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batch),
      });

      if (!response.ok) {
        // Entire batch failed
        failedRecipients.push(...chunk);
        console.error(`Broadcast batch failed (${response.status}): ${await response.text()}`);
        continue;
      }

      const result = (await response.json()) as { data: ResendBatchResponseItem[] };
      if (result.data) {
        for (let j = 0; j < result.data.length; j++) {
          if (result.data[j].error) {
            failedRecipients.push(chunk[j]);
          } else {
            totalSent++;
          }
        }
        // Treat any recipients not covered by the response as failures
        if (result.data.length < chunk.length) {
          failedRecipients.push(...chunk.slice(result.data.length));
        }
      } else {
        console.warn("[broadcast] Resend response missing data array, assuming success for chunk");
        totalSent += chunk.length;
      }
    } catch (error) {
      failedRecipients.push(...chunk);
      console.error("Broadcast batch error:", error);
    }
  }

  // Record in audit table
  const auditResult = await db
    .prepare(
      `INSERT INTO broadcast_emails (sent_by, recipient_group, subject, body_markdown, recipient_count, failure_count, failed_recipients)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .bind(
      params.sentById,
      params.group,
      params.subject,
      params.bodyMarkdown,
      totalSent,
      failedRecipients.length,
      JSON.stringify(failedRecipients),
    )
    .first<{ id: number }>();

  if (!auditResult?.id) {
    console.error("[broadcast] Audit record not created; emails were sent but not logged", {
      group: params.group,
      subject: params.subject,
      recipientCount: totalSent,
    });
  }

  return {
    broadcast_id: auditResult?.id ?? 0,
    recipient_count: totalSent,
    failure_count: failedRecipients.length,
    failed_recipients: failedRecipients,
  };
}
