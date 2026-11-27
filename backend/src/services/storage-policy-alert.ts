/**
 * Admin alerts about the shared S3 bucket policy (#2497, ADR 0145).
 *
 * Three conditions, each logged with a stable tag every time and mailed to
 * the admins at most once a day:
 *
 *  - `near_cap`: a policy write left it above 80% of AWS's 20,480-byte cap;
 *  - `full`: a dataset creation was refused because one more carve-out would
 *    not fit;
 *  - `rollback_incomplete`: a creation whose carve-out failed could not be
 *    rolled back completely (keyed per dataset, so each leftover is mailed).
 *
 * The once-a-day stamp is an `audit_log` row (action `storage_policy_alert`,
 * `resource_id` the condition key), claimed by one conditional INSERT before
 * anything is sent, so concurrent requests do not both mail. Recipients come
 * from `getAdminEmailsForCategory`, which is production-only; the category is
 * `publication_request`, the one the exemplar-invariant alert in index.ts
 * already uses for operational alerts. A failure here never fails the caller.
 */

import type { Bindings } from "../types/bindings.js";
import { MAX_BUCKET_POLICY_BYTES, isPolicyNearCap } from "./bucket-policy.js";
import {
  type AdminAlertCategory,
  getAdminEmailsForCategory,
  isAdminNotificationAllowed,
  resolveEmailConfig,
  sendStoragePolicyAlertEmail,
} from "./email.js";

export const STORAGE_POLICY_ALERT_ACTION = "storage_policy_alert";

/** The admin category the alert is mailed under (see the file header). */
export const STORAGE_POLICY_ALERT_CATEGORY: AdminAlertCategory = "publication_request";

export type StoragePolicyAlert =
  | { condition: "near_cap"; bytes: number; capBytes: number }
  | { condition: "full"; bytes: number; capBytes: number }
  | { condition: "rollback_incomplete"; datasetId: string; leftovers: string[] };

function alertKey(alert: StoragePolicyAlert): string {
  return alert.condition === "rollback_incomplete"
    ? `rollback_incomplete:${alert.datasetId}`
    : alert.condition;
}

function describe(alert: StoragePolicyAlert): {
  subject: string;
  headline: string;
  lines: string[];
} {
  switch (alert.condition) {
    case "near_cap":
      return {
        subject: "[NEMAR] Bucket policy above 80% of its size cap",
        headline: "The S3 bucket policy is nearly full",
        lines: [
          `The policy is ${alert.bytes} of ${alert.capBytes} bytes (${Math.round((alert.bytes / alert.capBytes) * 100)}%).`,
          "At the cap, every new dataset is refused with 503 until space is freed.",
        ],
      };
    case "full":
      return {
        subject: "[NEMAR] ALERT: bucket policy full, dataset creation refused",
        headline: "Dataset creation is refused: the S3 bucket policy is full",
        lines: [
          `One more private carve-out would make the policy ${alert.bytes} of ${alert.capBytes} bytes.`,
          "No dataset was created; creations keep being refused until space is freed.",
        ],
      };
    case "rollback_incomplete":
      return {
        subject: `[NEMAR] ALERT: incomplete rollback of ${alert.datasetId}`,
        headline: `A refused creation of ${alert.datasetId} left something behind`,
        lines: [
          `Could not remove: ${alert.leftovers.join(", ")}.`,
          "The dataset row is kept with its repository name when the repository could not be deleted; delete the dataset once the cause is fixed.",
        ],
      };
  }
}

/** Claim today's stamp for this alert; true only for the first claim in 24 hours. */
async function claimDailyStamp(db: D1Database, key: string, details: string): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO audit_log (action, resource_type, resource_id, details)
       SELECT ?, 'bucket_policy', ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM audit_log
         WHERE action = ? AND resource_id = ? AND timestamp > datetime('now', '-1 day')
       )`,
    )
    .bind(STORAGE_POLICY_ALERT_ACTION, key, details, STORAGE_POLICY_ALERT_ACTION, key)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Mail the admins about `alert`, at most once a day per condition. Returns the
 * number of admins reached (0 when suppressed, already sent today, or failed).
 */
export async function notifyStoragePolicyAlert(
  env: Bindings,
  alert: StoragePolicyAlert,
): Promise<number> {
  try {
    if (!isAdminNotificationAllowed(env)) return 0;
    const text = describe(alert);
    if (!(await claimDailyStamp(env.DB, alertKey(alert), JSON.stringify(alert)))) return 0;
    const adminEmails = await getAdminEmailsForCategory(env.DB, STORAGE_POLICY_ALERT_CATEGORY, env);
    if (adminEmails.length === 0) {
      console.error(`[bucket-policy:alert] no admin recipients for ${alertKey(alert)}`);
      return 0;
    }
    const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
    return await sendStoragePolicyAlertEmail(
      adminEmails,
      text,
      env.RESEND_API_KEY ?? "",
      fromEmail,
      replyTo,
      isDev,
      env,
    );
  } catch (err) {
    console.error(
      `[bucket-policy:alert] could not notify admins of ${alertKey(alert)}:`,
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}

/**
 * After a carve-out write, alert when the written policy (`bytes`, null when
 * nothing was written) is above 80% of the cap. The stable log line is
 * written by `putBucketPolicy` itself; this adds the once-a-day mail.
 */
export async function notifyIfPolicyNearCap(env: Bindings, bytes: number | null): Promise<void> {
  if (bytes === null || !isPolicyNearCap(bytes)) return;
  await notifyStoragePolicyAlert(env, {
    condition: "near_cap",
    bytes,
    capBytes: MAX_BUCKET_POLICY_BYTES,
  });
}
