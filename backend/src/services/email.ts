/**
 * Email service using Resend
 *
 * Handles verification emails and approval notifications.
 */

import { Resend } from "resend";

const FROM_EMAIL = "NEMAR <noreply@nemar.org>";

/**
 * Send email verification link to new user
 */
export async function sendVerificationEmail(
  to: string,
  username: string,
  verificationUrl: string,
  resendApiKey: string
): Promise<void> {
  const resend = new Resend(resendApiKey);

  await resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: "Verify your NEMAR account",
    html: `
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
    If you didn't create this account, you can safely ignore this email.
  </p>
</body>
</html>
    `,
  });
}

/**
 * Send approval notification with API key
 */
export async function sendApprovalEmail(
  to: string,
  username: string,
  apiKey: string,
  resendApiKey: string
): Promise<void> {
  const resend = new Resend(resendApiKey);

  await resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: "Your NEMAR account has been approved!",
    html: `
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
    Check out the documentation at <a href="https://nemar.org/docs" style="color: #2563eb;">nemar.org/docs</a>
  </p>

  <p style="color: #999; font-size: 12px; margin-top: 30px;">
    NEMAR - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
    `,
  });
}

/**
 * Send revocation notification
 */
export async function sendRevocationEmail(
  to: string,
  username: string,
  resendApiKey: string
): Promise<void> {
  const resend = new Resend(resendApiKey);

  await resend.emails.send({
    from: FROM_EMAIL,
    to: [to],
    subject: "NEMAR account access revoked",
    html: `
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
    NEMAR - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
    `,
  });
}
