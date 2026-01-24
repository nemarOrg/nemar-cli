/**
 * Email service using Resend API
 *
 * Handles verification emails and approval notifications.
 * Uses fetch directly for better Cloudflare Workers compatibility.
 */

const FROM_EMAIL = "NEMAR <nemar@osc.earth>";
const RESEND_API_URL = "https://api.resend.com/emails";

interface ResendResponse {
  id?: string;
  error?: string;
  message?: string;
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
  <h1 style="color: #2563eb;">Welcome to NEMAR, ${username}!</h1>

  <p>Thank you for signing up for NEMAR (Neuroelectromagnetic Data Archive and Tools Resource).</p>

  <p>Please verify your email address by clicking the button below:</p>

  <p style="text-align: center; margin: 30px 0;">
    <a href="${verificationUrl}"
       style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
      Verify Email Address
    </a>
  </p>

  <p style="color: #666; font-size: 14px;">
    Or copy and paste this link into your browser:<br>
    <a href="${verificationUrl}" style="color: #2563eb; word-break: break-all;">${verificationUrl}</a>
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
 * Send approval notification with API key
 */
export async function sendApprovalEmail(
  to: string,
  username: string,
  apiKey: string,
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
  <h1 style="color: #16a34a;">Congratulations, ${username}!</h1>

  <p>Your NEMAR account has been approved. You can now upload and manage datasets.</p>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Your API Key</h2>

  <p>Use this key with the NEMAR CLI to authenticate:</p>

  <div style="background-color: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 14px; word-break: break-all; margin: 16px 0;">
    ${apiKey}
  </div>

  <p style="color: #dc2626; font-weight: bold;">
    Important: This key is shown only once. Store it securely.
  </p>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Getting Started</h2>

  <div style="background-color: #f4f4f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 13px; white-space: pre-line;">
# Install NEMAR CLI
bunx nemar-cli

# Login with your API key
nemar auth login

# Check your authentication status
nemar auth status

# Upload your first dataset
nemar dataset upload /path/to/bids-dataset
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
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">${user.username}</td>
    </tr>
    <tr>
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb; background: #f9fafb; font-weight: bold;">Email</td>
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">${user.email}</td>
    </tr>
    <tr>
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb; background: #f9fafb; font-weight: bold;">GitHub</td>
      <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">
        <a href="https://github.com/${user.github_username}" style="color: #2563eb;">${user.github_username}</a>
      </td>
    </tr>
  </table>

  <h2 style="color: #333; font-size: 18px; margin-top: 30px;">Reason for Access</h2>
  <div style="background-color: #f4f4f5; padding: 16px; border-radius: 8px; margin: 16px 0; white-space: pre-wrap;">${user.description}</div>

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

  <p>Hello ${username},</p>

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
