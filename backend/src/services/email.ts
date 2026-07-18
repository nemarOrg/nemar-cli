/**
 * Email service using Resend API
 *
 * Handles email notifications (verification, approval, publication, revocation)
 * and admin email preference management.
 * Uses fetch directly for Cloudflare Workers compatibility.
 */

import { STALENESS_LIMIT_DAYS } from "./staleness";

/** Fallback sender when FROM_EMAIL env var is unset. Mirrors the FROM_EMAIL set
 *  in wrangler-sccn.toml (prod + dev); the retired osc.earth address is gone. */
export const DEFAULT_FROM_EMAIL = "NEMAR Archive <noreply@nemar.org>";
const RESEND_API_URL = "https://api.resend.com/emails";

let warnedMissingFromEmail = false;

/**
 * Resolve sender + reply-to from Workers env.
 * `fromEmail` falls back to DEFAULT_FROM_EMAIL when unset, empty, or whitespace.
 * `replyTo` passes through as-is (undefined when unset or empty/whitespace).
 * Callers pass `c.env` to avoid repeating the fallback at every site.
 *
 * NOTE: The domain in FROM_EMAIL must be verified in the Resend account tied
 * to RESEND_API_KEY, otherwise Resend will reject the send. A deploy that
 * forgets FROM_EMAIL falls back to DEFAULT_FROM_EMAIL (nemar.org); if that
 * domain is not verified on the account, every send fails. We log once per
 * worker instance to surface this in Workers Logs.
 */
export function resolveEmailConfig(env: {
  FROM_EMAIL?: string;
  REPLY_TO?: string;
  ENVIRONMENT?: string;
}): {
  fromEmail: string;
  replyTo?: string;
  isDev: boolean;
} {
  const from = env.FROM_EMAIL?.trim();
  const reply = env.REPLY_TO?.trim();
  if (!from && !warnedMissingFromEmail) {
    warnedMissingFromEmail = true;
    console.error(
      `FROM_EMAIL env var is unset; falling back to ${DEFAULT_FROM_EMAIL}. If the Resend account tied to this worker does not verify nemar.org, every email will fail. Set FROM_EMAIL in wrangler config.`,
    );
  }
  return {
    fromEmail: from || DEFAULT_FROM_EMAIL,
    replyTo: reply || undefined,
    isDev: env.ENVIRONMENT?.trim().toLowerCase() === "development",
  };
}

/**
 * Red banner injected into every email body when sent from the dev backend,
 * so recipients (mostly admins via testAdmin@nemar.org / testOwner@nemar.org)
 * never confuse a dev send with a real production notification.
 */
const DEV_BANNER_HTML = `
<div style="background:#dc2626;color:#ffffff;padding:14px 20px;border-radius:8px;margin:0 0 20px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;">
  <div style="font-size:16px;font-weight:bold;letter-spacing:0.5px;">DEV BACKEND - NOT PRODUCTION</div>
  <div style="font-size:13px;margin-top:4px;">Sent from the NEMAR development backend. Do not act on this email.</div>
</div>
`;

export function applyDevWrap(
  subject: string,
  html: string,
  isDev: boolean | undefined,
): { subject: string; html: string } {
  if (!isDev) return { subject, html };
  const wrappedHtml = html.replace(/<body([^>]*)>/i, (match) => `${match}${DEV_BANNER_HTML}`);
  return {
    subject: `[DEV] ${subject}`,
    html: wrappedHtml === html ? `${DEV_BANNER_HTML}${html}` : wrappedHtml,
  };
}

export interface EmailPreferences {
  user_approval: boolean;
  publication_request: boolean;
  announcements: boolean;
}

export type EmailCategory = keyof EmailPreferences;

export const DEFAULT_EMAIL_PREFERENCES: EmailPreferences = {
  user_approval: true,
  publication_request: true,
  announcements: true,
};

interface ResendResponse {
  id?: string;
  error?: string;
  message?: string;
}

interface AdminRow {
  email: string;
  email_preferences: string | null;
}

/**
 * Parse email preferences from DB JSON string, defaulting to all enabled
 */
export function parseEmailPreferences(raw: string | null): EmailPreferences {
  if (!raw) return { ...DEFAULT_EMAIL_PREFERENCES };
  try {
    const parsed = JSON.parse(raw);
    return {
      user_approval: parsed.user_approval !== false,
      publication_request: parsed.publication_request !== false,
      announcements: parsed.announcements !== false,
    };
  } catch (err) {
    console.error("Corrupt email_preferences JSON, defaulting to all enabled:", raw, err);
    return { ...DEFAULT_EMAIL_PREFERENCES };
  }
}

/**
 * Get admin/owner emails filtered by notification category.
 * If all admins have opted out, falls back to the first admin
 * to ensure at least one recipient.
 */
export async function getAdminEmailsForCategory(
  db: D1Database,
  category: EmailCategory,
): Promise<string[]> {
  const result = await db
    .prepare(
      "SELECT email, email_preferences FROM users WHERE role IN ('owner', 'admin') AND status = 'approved' AND deleted_at IS NULL",
    )
    .all<AdminRow>();

  if (!result.results || result.results.length === 0) return [];

  const opted = result.results.filter((row) => {
    const prefs = parseEmailPreferences(row.email_preferences);
    return prefs[category];
  });

  // Safety: at least one admin must receive each category
  if (opted.length === 0) {
    console.warn(
      `All admins opted out of "${category}" notifications. Falling back to: ${result.results[0].email}`,
    );
    return [result.results[0].email];
  }

  return opted.map((r) => r.email);
}

/**
 * Send email via Resend API
 */
async function sendEmail(
  to: string,
  subject: string,
  html: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
): Promise<void> {
  const wrapped = applyDevWrap(subject, html, isDev);
  const body: Record<string, unknown> = {
    from: fromEmail,
    to: [to],
    subject: wrapped.subject,
    html: wrapped.html,
  };
  if (replyTo) body.reply_to = replyTo;
  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error: ResendResponse = await response.json();
    throw new Error(
      `Failed to send email from ${fromEmail} to ${to}: ${error.message || response.statusText}`,
    );
  }
}

/**
 * Send email verification link to new user
 */
export async function sendVerificationEmail(
  to: string,
  username: string,
  verificationUrl: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #2563eb;">Welcome to NEMAR, ${escapeHtml(username)}!</h1>

  <p>Thank you for signing up for NEMAR (Neuroelectromagnetic Data Archive and Tools Resource).</p>

  <p>Please verify your email address by clicking the button below:</p>

  <p style="text-align: center; margin: 30px 0;">
    <a href="${escapeHtml(verificationUrl)}"
       style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
      Verify Email Address
    </a>
  </p>

  <p style="color: #666; font-size: 14px;">
    Or copy and paste this link into your browser:<br>
    <a href="${escapeHtml(verificationUrl)}" style="color: #2563eb; word-break: break-all;">${escapeHtml(verificationUrl)}</a>
  </p>

  <p style="color: #666; font-size: 14px;">This link expires in 24 hours.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #666; font-size: 14px;">
    <strong>What happens next?</strong><br>
    After verifying your email, an administrator will review your account.
    Once approved, you'll receive your API key and can start uploading datasets.
  </p>

  <p style="color: #999; font-size: 12px; margin-top: 30px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource<br>
    If you didn't create this account, you can safely ignore this email.
  </p>
</body>
</html>
  `;

  await sendEmail(to, "Verify your NEMAR account", html, resendApiKey, fromEmail, replyTo, isDev);
}

/**
 * Send approval notification (without API key for security).
 * Instructs user to retrieve their key via CLI.
 */
export async function sendKeyReadyEmail(
  to: string,
  username: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #16a34a;">Congratulations, ${escapeHtml(username)}!</h1>

  <p>Your NEMAR account has been approved. You can now upload and manage datasets.</p>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Retrieve Your API Key</h2>

  <p>For security, your API key is not sent via email. Use the CLI to retrieve it:</p>

  <div style="background-color: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 13px; white-space: pre-line;">
# Install NEMAR CLI
bunx nemar-cli

# Retrieve your API key (requires your email and password)
nemar auth retrieve-key

# Then login with the key
nemar auth login
  </div>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #666; font-size: 14px;">
    <strong>Need help?</strong><br>
    Check out the documentation at <a href="https://nemar-cli.pages.dev" style="color: #2563eb;">nemar-cli.pages.dev</a>
  </p>

  <p style="color: #999; font-size: 12px; margin-top: 30px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    "Your NEMAR account has been approved!",
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
  );
}

/**
 * Send key regeneration verification email
 */
export async function sendKeyRegenerationVerificationEmail(
  to: string,
  username: string,
  confirmUrl: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #f59e0b;">API Key Regeneration Request</h1>

  <p>Hello ${escapeHtml(username)},</p>

  <p>You requested a new API key for your NEMAR account. Click the button below to confirm and generate a new key.</p>

  <p style="color: #dc2626; font-weight: bold; font-size: 14px;">
    This will revoke your current API key. You will need to login again with the new key.
  </p>

  <p style="text-align: center; margin: 30px 0;">
    <a href="${escapeHtml(confirmUrl)}"
       style="background-color: #f59e0b; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
      Generate New API Key
    </a>
  </p>

  <p style="color: #666; font-size: 14px;">
    Or copy and paste this link into your browser:<br>
    <a href="${escapeHtml(confirmUrl)}" style="color: #2563eb; word-break: break-all;">${escapeHtml(confirmUrl)}</a>
  </p>

  <p style="color: #666; font-size: 14px;">This link expires in 1 hour. If you did not request this, you can safely ignore this email.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #999; font-size: 12px; margin-top: 30px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  await sendEmail(to, "NEMAR API Key Regeneration", html, resendApiKey, fromEmail, replyTo, isDev);
}

/**
 * Notify admins that a user needs approval
 * Called when a user verifies their email address
 */
export async function sendAdminNotificationEmail(
  adminEmails: string[],
  user: {
    username: string;
    email: string;
    github_username: string;
    description: string;
  },
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #f59e0b;">New User Awaiting Approval</h1>

  <p>A new user has verified their email and is waiting for admin approval to access NEMAR.</p>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">User Details</h2>

  <table style="border-collapse: collapse; width: 100%; margin: 16px 0;">
    <tr>
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb; background: #f9fafb; font-weight: bold;">Username</td>
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">${escapeHtml(user.username)}</td>
    </tr>
    <tr>
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb; background: #f9fafb; font-weight: bold;">Email</td>
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">${escapeHtml(user.email)}</td>
    </tr>
    <tr>
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb; background: #f9fafb; font-weight: bold;">GitHub</td>
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">
        <a href="https://github.com/${escapeHtml(user.github_username)}" style="color: #2563eb;">${escapeHtml(user.github_username)}</a>
      </td>
    </tr>
  </table>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Reason for Access</h2>
  <div style="background-color: #f4f4f5; padding: 16px; border-radius: 8px; margin: 16px 0; white-space: pre-wrap;">${escapeHtml(user.description)}</div>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Action Required</h2>
  <p>Review this user and approve or deny their access using the CLI:</p>

  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    <span style="color: #16a34a;">nemar admin approve</span> ${user.username}
  </div>

  <p style="color: #666; font-size: 14px;">
    To see all pending users:<br>
    <code style="background: #f4f4f5; padding: 2px 6px; border-radius: 4px;">nemar admin users --verified</code>
  </p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  // Send to all admins
  for (const adminEmail of adminEmails) {
    try {
      await sendEmail(
        adminEmail,
        `[NEMAR] New user awaiting approval: ${user.username}`,
        html,
        resendApiKey,
        fromEmail,
        replyTo,
        isDev,
      );
    } catch (error) {
      console.error(`Failed to send admin notification to ${adminEmail}:`, error);
    }
  }
}

/**
 * Alert admins that an OpenNeuro import failed and was quarantined (#754).
 * Sent on a terminal import failure that left an orphan; the admin reviews it
 * in `nemar admin import status` and clears it with `nemar admin import
 * rollback <id>` (or it is auto-rolled-back when IMPORT_AUTO_ROLLBACK is on).
 * Best-effort: per-recipient try/catch like sendAdminNotificationEmail.
 */
export async function sendImportQuarantineEmail(
  adminEmails: string[],
  details: {
    datasetId: string;
    sourceId: string;
    stage: string;
    reason: string;
    workflowRunUrl: string | null;
  },
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
): Promise<void> {
  const runRow = details.workflowRunUrl
    ? `<tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:bold;">Workflow run</td><td style="padding:8px 12px;border:1px solid #e5e7eb;"><a href="${escapeHtml(details.workflowRunUrl)}" style="color:#2563eb;">${escapeHtml(details.workflowRunUrl)}</a></td></tr>`
    : "";
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #dc2626;">Import quarantined</h1>
  <p>An OpenNeuro import failed and was quarantined so it would not leave a silent orphan. Review it and decide whether to roll it back (delete the empty repo + partial S3 + D1 row) or retry.</p>
  <table style="border-collapse: collapse; width: 100%; margin: 16px 0;">
    <tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:bold;">Dataset</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${escapeHtml(details.datasetId)} (from ${escapeHtml(details.sourceId)})</td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:bold;">Failed stage</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${escapeHtml(details.stage)}</td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:bold;">Reason</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">${escapeHtml(details.reason)}</td></tr>
    ${runRow}
  </table>
  <p style="font-family: monospace; background:#f3f4f6; padding:12px; border-radius:6px;">nemar admin import status ${escapeHtml(details.datasetId)}<br>nemar admin import rollback ${escapeHtml(details.datasetId)}</p>
</body>
</html>`;
  for (const adminEmail of adminEmails) {
    try {
      await sendEmail(
        adminEmail,
        `NEMAR import quarantined: ${details.datasetId}`,
        html,
        resendApiKey,
        fromEmail,
        replyTo,
        isDev,
      );
    } catch (error) {
      console.error(`Failed to send import-quarantine alert to ${adminEmail}:`, error);
    }
  }
}

/**
 * Send revocation notification
 */
export async function sendRevocationEmail(
  to: string,
  username: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #dc2626;">Account Access Revoked</h1>

  <p>Hello ${escapeHtml(username)},</p>

  <p>Your NEMAR account access has been revoked by an administrator.</p>

  <p>If you believe this was done in error, please contact the NEMAR administrators.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    "NEMAR account access revoked",
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
  );
}

/**
 * Escape HTML special characters to prevent XSS in email templates
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Notify admins that a user has requested publication of a dataset
 */
export async function sendPublicationRequestEmail(
  adminEmails: string[],
  datasetId: string,
  username: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #2563eb;">Publication Request</h1>

  <p>User <strong>${escapeHtml(username)}</strong> has requested publication of dataset <strong>${escapeHtml(datasetId)}</strong>.</p>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Action Required</h2>
  <p>Review the dataset and approve or deny the request:</p>

  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    <span style="color: #16a34a;">nemar admin publish approve</span> ${escapeHtml(datasetId)}<br>
    <span style="color: #dc2626;">nemar admin publish deny</span> ${escapeHtml(datasetId)} --reason "..."
  </div>

  <p style="color: #666; font-size: 14px;">
    To see all pending requests:<br>
    <code style="background: #f4f4f5; padding: 2px 6px; border-radius: 4px;">nemar admin publish list</code>
  </p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  for (const adminEmail of adminEmails) {
    try {
      await sendEmail(
        adminEmail,
        `[NEMAR] Publication request: ${datasetId} by ${username}`,
        html,
        resendApiKey,
        fromEmail,
        replyTo,
        isDev,
      );
    } catch (error) {
      console.error(`Failed to send publication request email to ${adminEmail}:`, error);
    }
  }
}

/**
 * Notify a dataset owner that a user has requested collaborator access to their
 * (private/unpublished) dataset and is awaiting approval.
 */
export async function sendAccessRequestEmail(
  ownerEmail: string,
  datasetId: string,
  datasetName: string,
  requesterUsername: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #2563eb;">Access Request</h1>

  <p>User <strong>${escapeHtml(requesterUsername)}</strong> has requested collaborator access to your dataset <strong>${escapeHtml(datasetName)}</strong> (<strong>${escapeHtml(datasetId)}</strong>).</p>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Action Required</h2>
  <p>Approve or deny the request:</p>

  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    <span style="color: #16a34a;">nemar dataset access approve</span> ${escapeHtml(requesterUsername)} ${escapeHtml(datasetId)}<br>
    <span style="color: #dc2626;">nemar dataset access deny</span> ${escapeHtml(requesterUsername)} ${escapeHtml(datasetId)}
  </div>

  <p style="color: #666; font-size: 14px;">
    To see all pending requests:<br>
    <code style="background: #f4f4f5; padding: 2px 6px; border-radius: 4px;">nemar dataset access list ${escapeHtml(datasetId)}</code>
  </p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  await sendEmail(
    ownerEmail,
    `[NEMAR] Access request: ${datasetId} by ${requesterUsername}`,
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
  );
}

/**
 * Notify user that their publication request was denied
 */
export async function sendPublicationDeniedEmail(
  to: string,
  username: string,
  datasetId: string,
  reason: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #f59e0b;">Publication Request Denied</h1>

  <p>Hello ${escapeHtml(username)},</p>

  <p>Your publication request for dataset <strong>${escapeHtml(datasetId)}</strong> has been reviewed and denied.</p>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Reason</h2>
  <div style="background-color: #fef3c7; padding: 16px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #f59e0b;">
    ${escapeHtml(reason)}
  </div>

  <p>You can address the issues and submit a new request:</p>
  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    nemar dataset publish request ${escapeHtml(datasetId)}
  </div>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    `Publication request denied: ${datasetId}`,
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
  );
}

/**
 * Notify a user that the automated pre-screen blocked their publication
 * request (issue #666). Unlike a manual denial, this is a self-serve gate:
 * the listed gaps are the publisher-minimum checks, and a fix + re-request
 * re-runs them automatically.
 */
export async function sendPublicationBlockedEmail(
  to: string,
  username: string,
  datasetId: string,
  reasons: string[],
  issueUrl: string | null,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
): Promise<void> {
  const reasonItems =
    reasons.length > 0
      ? reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")
      : "<li>The dataset did not meet the minimum publication requirements.</li>";
  const issueBlock = issueUrl
    ? `<p>Details and step-by-step fixes are in the tracking issue on your dataset repository:</p>
  <p><a href="${escapeHtml(issueUrl)}" style="color: #2563eb;">${escapeHtml(issueUrl)}</a></p>`
    : "";
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #f59e0b;">Publication on hold: ${escapeHtml(datasetId)}</h1>

  <p>Hello ${escapeHtml(username)},</p>

  <p>Thanks for submitting <strong>${escapeHtml(datasetId)}</strong> for publication on NEMAR.
  NEMAR is a <strong>publisher, not a peer reviewer</strong>; we don't evaluate scientific merit.
  We only check that each dataset carries the bare minimum so others can find, understand, and reuse it.
  The automated pre-screen flagged the following before this could go to an admin:</p>

  <ul style="background-color: #fef3c7; padding: 16px 16px 16px 36px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #f59e0b;">
    ${reasonItems}
  </ul>

  ${issueBlock}

  <p>After addressing these, re-request publication and the checks will re-run automatically:</p>
  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    nemar dataset publish request ${escapeHtml(datasetId)}
  </div>

  <p style="font-size: 13px; color: #666;">If you believe this was flagged in error, reply to this email and we'll take a look.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    `Publication on hold: ${datasetId}`,
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
  );
}

/**
 * Notify user that their dataset has been published
 */
export async function sendPublicationApprovedEmail(
  to: string,
  username: string,
  datasetId: string,
  doi: string | null,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
): Promise<void> {
  const safeDoi = doi ? escapeHtml(doi) : "";
  const doiSection = doi
    ? `<h2 style="color: #333; font-size: 18px; margin-top: 30px;">DOI</h2>
       <p>Your dataset has been assigned the following DOI:</p>
       <div style="background-color: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
         <a href="https://doi.org/${safeDoi}" style="color: #2563eb;">${safeDoi}</a>
       </div>`
    : "";

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #16a34a;">Dataset Published!</h1>

  <p>Hello ${escapeHtml(username)},</p>

  <p>Your dataset <strong>${escapeHtml(datasetId)}</strong> has been published and is now publicly available.</p>

  ${doiSection}

  <p>You can check the status of your dataset:</p>
  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    nemar dataset publish status ${escapeHtml(datasetId)}
  </div>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    `Dataset published: ${datasetId}`,
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
  );
}

/**
 * Send a 6-digit passwordless sign-in code to the web dashboard user
 * (#569). The code is the user-facing secret; the email is the only
 * channel that delivers it. Templates intentionally include "didn't
 * request this? ignore" footer to dissuade panic when an attacker
 * triggers a request against someone else's email.
 */
export async function sendPasswordlessCodeEmail(
  to: string,
  code: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #2563eb;">Your NEMAR sign-in code</h1>

  <p>Use the code below to finish signing in:</p>

  <p style="text-align: center; margin: 30px 0;">
    <span style="display: inline-block; font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 32px; letter-spacing: 8px; padding: 16px 24px; background-color: #f4f4f5; border-radius: 8px; color: #111;">
      ${escapeHtml(code)}
    </span>
  </p>

  <p style="color: #666; font-size: 14px;">This code expires in 10 minutes. After 5 incorrect attempts the code is invalidated; request a new one if that happens.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource<br>
    Didn't request this? You can safely ignore this email. Your account has not been changed.
  </p>
</body>
</html>
  `;

  // Generic subject — keeping the code out of the subject line means
  // it doesn't get echoed into provider-side / client-side mail logs
  // that often retain subjects long after the body is purged.
  await sendEmail(to, "Your NEMAR sign-in code", html, resendApiKey, fromEmail, replyTo, isDev);
}

/**
 * Warn a dataset owner that their private, unpublished dataset is approaching
 * the 90-day inactivity deadline and will be removed unless they act (#662).
 * Sent at 30/14/7/2/1 days remaining; the 1-day notice uses urgent red styling
 * and a "Final notice" subject prefix (when `daysLeft` is 1 or less).
 */
export async function sendStalenessWarningEmail(
  to: string,
  datasetId: string,
  datasetName: string,
  daysLeft: number,
  deletionDate: string,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
): Promise<void> {
  const isFinal = daysLeft <= 1;
  const accent = isFinal ? "#dc2626" : "#f59e0b";
  const dayLabel = daysLeft === 1 ? "1 day" : `${daysLeft} days`;
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: ${accent};">${isFinal ? "Final notice: " : ""}Your dataset will be removed in ${escapeHtml(dayLabel)}</h1>

  <p>Your NEMAR dataset <strong>${escapeHtml(datasetId)}</strong>${
    datasetName ? ` (${escapeHtml(datasetName)})` : ""
  } is private, has no DOI, and has had no activity for over ${STALENESS_LIMIT_DAYS - daysLeft} days (approaching the 90-day removal deadline).</p>

  <p>Under NEMAR's cleanup policy it is scheduled for removal on
     <strong>${escapeHtml(deletionDate)}</strong> (in ${escapeHtml(dayLabel)})
     unless you act. <strong>Removal deletes the GitHub repository, the stored
     data, and all records.</strong></p>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">How to keep this dataset</h2>
  <p>Do any one of the following before the deadline:</p>
  <ul>
    <li>Request publication (recommended): <code style="background:#f4f4f5;padding:2px 6px;border-radius:4px;">nemar dataset publish request ${escapeHtml(datasetId)}</code></li>
    <li>Push an update or new version so the dataset is no longer inactive.</li>
    <li>Reply to this email and ask the NEMAR admins to keep it.</li>
  </ul>

  <p style="color: #666; font-size: 14px;">A dataset with a DOI, or one that is published, is never auto-removed.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  await sendEmail(
    to,
    `${isFinal ? "[NEMAR] Final notice: " : "[NEMAR] Action needed: "}${datasetId} will be removed in ${dayLabel}`,
    html,
    resendApiKey,
    fromEmail,
    replyTo,
    isDev,
  );
}

/**
 * Notify admins that a stale dataset has passed its 90-day deadline (#662).
 * The cron deliberately does NOT auto-delete `nm` datasets; this email asks an
 * admin to delete manually so a human always confirms removal of real archive
 * data. `warnStageReached` is the owner's last delivered warning stage (in
 * days remaining), or null if no warning was delivered, so the body can state
 * accurately how far the runway actually progressed. Returns the number of
 * admin recipients the message was successfully delivered to.
 */
export async function sendStalenessAdminReviewEmail(
  adminEmails: string[],
  datasetId: string,
  datasetName: string,
  ownerEmail: string | null,
  warnStageReached: number | null,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
): Promise<number> {
  const warningSummary =
    warnStageReached !== null
      ? `The most recent warning delivered to the owner was the ${escapeHtml(String(warnStageReached))}-day notice.`
      : "No warning was delivered to the owner (check <code>staleness_warn_stage</code> in D1 before deleting).";
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #dc2626;">Stale dataset awaiting manual review</h1>

  <p>Dataset <strong>${escapeHtml(datasetId)}</strong>${
    datasetName ? ` (${escapeHtml(datasetName)})` : ""
  } is private, has no DOI, and has been inactive past the 90-day cleanup deadline.</p>

  <p>The owner${
    ownerEmail ? ` (${escapeHtml(ownerEmail)})` : ""
  } was sent removal warnings as the deadline approached. ${warningSummary} The
  cron does <strong>not</strong> auto-delete <code>nm</code> datasets &mdash;
  deletion is a manual admin step so a human always confirms it.</p>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Action Required</h2>
  <p>Review the dataset, then keep or delete it:</p>
  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    <span style="color: #dc2626;">nemar admin delete-dataset</span> ${escapeHtml(datasetId)}
  </div>
  <p style="color: #666; font-size: 14px;">To keep it instead, help the owner publish it or mint a DOI; either removes it from cleanup permanently.</p>

  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;

  let delivered = 0;
  for (const adminEmail of adminEmails) {
    try {
      await sendEmail(
        adminEmail,
        `[NEMAR] Stale dataset past deadline: ${datasetId} (awaiting manual deletion)`,
        html,
        resendApiKey,
        fromEmail,
        replyTo,
        isDev,
      );
      delivered++;
    } catch (error) {
      console.error(`Failed to send staleness review email to ${adminEmail}:`, error);
    }
  }
  return delivered;
}

/**
 * Alert admins that the staging-only exemplar invariant was violated: an
 * `is_exemplar=1` row exists in PRODUCTION D1 (epic #923). Phase 4's visibility
 * carve-outs admit such rows with no runtime env check, so one in prod is
 * silently public across catalog/search/data-index. This is structurally
 * impossible under normal operation (the creation endpoint 403s in prod), so if
 * it fires a gate was bypassed — page a human, don't just log.
 */
export async function sendExemplarInvariantAlertEmail(
  adminEmails: string[],
  count: number,
  resendApiKey: string,
  fromEmail: string,
  replyTo?: string,
  isDev?: boolean,
): Promise<number> {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #dc2626;">Exemplar invariant violated in production</h1>
  <p><strong>${escapeHtml(String(count))}</strong> dataset row(s) with <code>is_exemplar = 1</code>
  exist in the <strong>production</strong> database. Exemplars are a staging-only fleet and the
  creation endpoint 403s in production, so this should be impossible.</p>
  <p>These rows are <strong>silently public</strong> across the catalog, search, and data index (the
  Phase 4 visibility carve-outs admit <code>is_exemplar = 1</code> with no runtime environment check).
  A gate was bypassed &mdash; investigate immediately.</p>
  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Action Required</h2>
  <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; margin: 16px 0;">
    SELECT dataset_id FROM datasets WHERE is_exemplar = 1;
  </div>
  <p style="color: #666; font-size: 14px;">Confirm each row, delete it (or clear the flag), and audit the exemplar creation gate.</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #999; font-size: 12px;"><a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource</p>
</body>
</html>
  `;
  let delivered = 0;
  for (const adminEmail of adminEmails) {
    try {
      await sendEmail(
        adminEmail,
        `[NEMAR] ALERT: ${count} exemplar row(s) leaked into production`,
        html,
        resendApiKey,
        fromEmail,
        replyTo,
        isDev,
      );
      delivered++;
    } catch (error) {
      console.error(`Failed to send exemplar-invariant alert to ${adminEmail}:`, error);
    }
  }
  return delivered;
}
