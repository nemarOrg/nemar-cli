/**
 * Email service using Resend API
 *
 * Handles verification emails and approval notifications.
 * Uses fetch directly for better Cloudflare Workers compatibility.
 */

const FROM_EMAIL = "NEMAR <nemar@osc.earth>";
const RESEND_API_URL = "https://api.resend.com/emails";

export type EmailCategory = "user_approval" | "publication_request";

export interface EmailPreferences {
  user_approval: boolean;
  publication_request: boolean;
}

export const DEFAULT_EMAIL_PREFERENCES: EmailPreferences = {
  user_approval: true,
  publication_request: true,
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
function parseEmailPreferences(raw: string | null): EmailPreferences {
  if (!raw) return { ...DEFAULT_EMAIL_PREFERENCES };
  try {
    const parsed = JSON.parse(raw);
    return {
      user_approval: parsed.user_approval !== false,
      publication_request: parsed.publication_request !== false,
    };
  } catch {
    return { ...DEFAULT_EMAIL_PREFERENCES };
  }
}

/**
 * Get admin/owner emails filtered by notification category.
 * Returns at least one recipient if any admins exist (the first admin
 * in the list always receives emails regardless of preferences).
 */
export async function getAdminEmailsForCategory(
  db: D1Database,
  category: EmailCategory,
): Promise<string[]> {
  const result = await db
    .prepare(
      "SELECT email, email_preferences FROM users WHERE role IN ('owner', 'admin') AND status = 'approved'",
    )
    .all<AdminRow>();

  if (!result.results || result.results.length === 0) return [];

  const opted = result.results.filter((row) => {
    const prefs = parseEmailPreferences(row.email_preferences);
    return prefs[category];
  });

  // Safety: at least one admin must receive each category
  if (opted.length === 0) {
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
): Promise<void> {
  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const error: ResendResponse = await response.json();
    throw new Error(`Failed to send email: ${error.message || response.statusText}`);
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
    NEMAR - Neuroelectromagnetic Data Archive and Tools Resource<br>
    Part of <a href="https://osc.earth" style="color: #999;">Open Science Collective</a><br>
    If you didn't create this account, you can safely ignore this email.
  </p>
</body>
</html>
  `;

  await sendEmail(to, "Verify your NEMAR account", html, resendApiKey);
}

/**
 * Send approval notification (without API key for security).
 * Instructs user to retrieve their key via CLI.
 */
export async function sendKeyReadyEmail(
  to: string,
  username: string,
  resendApiKey: string,
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
    NEMAR - Neuroelectromagnetic Data Archive and Tools Resource<br>
    Part of <a href="https://osc.earth" style="color: #999;">Open Science Collective</a>
  </p>
</body>
</html>
  `;

  await sendEmail(to, "Your NEMAR account has been approved!", html, resendApiKey);
}

/**
 * Send key regeneration verification email
 */
export async function sendKeyRegenerationVerificationEmail(
  to: string,
  username: string,
  confirmUrl: string,
  resendApiKey: string,
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
    NEMAR - Neuroelectromagnetic Data Archive and Tools Resource<br>
    Part of <a href="https://osc.earth" style="color: #999;">Open Science Collective</a>
  </p>
</body>
</html>
  `;

  await sendEmail(to, "NEMAR API Key Regeneration", html, resendApiKey);
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
    NEMAR - Neuroelectromagnetic Data Archive and Tools Resource<br>
    Part of <a href="https://osc.earth" style="color: #999;">Open Science Collective</a>
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
      );
    } catch (error) {
      console.error(`Failed to send admin notification to ${adminEmail}:`, error);
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
    NEMAR - Neuroelectromagnetic Data Archive and Tools Resource<br>
    Part of <a href="https://osc.earth" style="color: #999;">Open Science Collective</a>
  </p>
</body>
</html>
  `;

  await sendEmail(to, "NEMAR account access revoked", html, resendApiKey);
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
    NEMAR - Neuroelectromagnetic Data Archive and Tools Resource<br>
    Part of <a href="https://osc.earth" style="color: #999;">Open Science Collective</a>
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
      );
    } catch (error) {
      console.error(`Failed to send publication request email to ${adminEmail}:`, error);
    }
  }
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
    NEMAR - Neuroelectromagnetic Data Archive and Tools Resource<br>
    Part of <a href="https://osc.earth" style="color: #999;">Open Science Collective</a>
  </p>
</body>
</html>
  `;

  await sendEmail(to, `Publication request denied: ${datasetId}`, html, resendApiKey);
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
    NEMAR - Neuroelectromagnetic Data Archive and Tools Resource<br>
    Part of <a href="https://osc.earth" style="color: #999;">Open Science Collective</a>
  </p>
</body>
</html>
  `;

  await sendEmail(to, `Dataset published: ${datasetId}`, html, resendApiKey);
}
