/**
 * Admin alerts about the shared S3 bucket policy (#2497, ADR 0145).
 *
 * Three conditions, each logged with a stable tag every time and mailed to
 * the admins at most once a day:
 *
 *  - `near_cap`: a policy write left it above 80% of AWS's 20,480-byte cap,
 *    escalated under its own stamp above 95%, so each level mails once a day;
 *  - `full`: a dataset creation was refused because one more carve-out would
 *    not fit;
 *  - `rollback_incomplete`: a creation whose carve-out failed could not be
 *    rolled back completely (keyed per dataset, so each leftover is mailed).
 *
 * The once-a-day stamp is an `audit_log` row (action `storage_policy_alert`,
 * `resource_id` the condition key), claimed by one conditional INSERT before
 * anything is sent, so concurrent requests do not both mail; a claim that
 * reached nobody (no recipients, or every send failed) is released so the
 * next occurrence tries again. Recipients come
 * from `getAdminEmailsForCategory`, which is production-only, under the
 * `storage_alerts` category. A failure here never fails the caller.
 */

import type { Bindings } from "../types/bindings.js";
import { MAX_BUCKET_POLICY_BYTES, POLICY_FULL_TAG, isPolicyNearCap } from "./bucket-policy.js";
import {
  type AdminAlertCategory,
  getAdminEmailsForCategory,
  isAdminNotificationAllowed,
  resolveEmailConfig,
  sendStoragePolicyAlertEmail,
} from "./email.js";
import { BucketPolicyFullError } from "./s3.js";

export const STORAGE_POLICY_ALERT_ACTION = "storage_policy_alert";

/** The admin category the alert is mailed under. */
export const STORAGE_POLICY_ALERT_CATEGORY: AdminAlertCategory = "storage_alerts";

/** Fraction of the cap above which `near_cap` escalates to its own stamp. */
export const POLICY_ESCALATE_FRACTION = 0.95;

function isEscalated(bytes: number, capBytes: number): boolean {
  return bytes > capBytes * POLICY_ESCALATE_FRACTION;
}

export type StoragePolicyAlert =
  | { condition: "near_cap"; bytes: number; capBytes: number }
  | { condition: "full"; bytes: number; capBytes: number }
  | { condition: "rollback_incomplete"; datasetId: string; leftovers: string[] };

function alertKey(alert: StoragePolicyAlert): string {
  if (alert.condition === "rollback_incomplete") return `rollback_incomplete:${alert.datasetId}`;
  if (alert.condition === "near_cap" && isEscalated(alert.bytes, alert.capBytes)) {
    return "near_cap_95";
  }
  return alert.condition;
}

function describe(alert: StoragePolicyAlert): {
  subject: string;
  headline: string;
  lines: string[];
} {
  switch (alert.condition) {
    case "near_cap":
      return {
        subject: isEscalated(alert.bytes, alert.capBytes)
          ? "[NEMAR] ALERT: bucket policy above 95% of its size cap"
          : "[NEMAR] Bucket policy above 80% of its size cap",
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

/**
 * Claim today's stamp for this alert: the new `audit_log` row id for the first
 * claim in 24 hours, null otherwise.
 */
async function claimDailyStamp(
  db: D1Database,
  key: string,
  details: string,
): Promise<number | null> {
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
  if ((result.meta?.changes ?? 0) === 0) return null;
  return Number(result.meta?.last_row_id);
}

/** Give a claim back, so the next occurrence of the alert tries again. */
async function releaseStamp(db: D1Database, stampId: number): Promise<void> {
  try {
    await db
      .prepare("DELETE FROM audit_log WHERE id = ? AND action = ?")
      .bind(stampId, STORAGE_POLICY_ALERT_ACTION)
      .run();
  } catch (err) {
    console.error(
      `[bucket-policy:alert] could not release stamp ${stampId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Mail the admins about `alert`, at most once a day per condition. Returns the
 * number of admins reached (0 when suppressed, already sent today, or failed).
 */
export async function notifyStoragePolicyAlert(
  env: Bindings,
  alert: StoragePolicyAlert,
): Promise<number> {
  let stampId: number | null = null;
  let delivered = 0;
  try {
    if (!isAdminNotificationAllowed(env)) return 0;
    const text = describe(alert);
    stampId = await claimDailyStamp(env.DB, alertKey(alert), JSON.stringify(alert));
    if (stampId === null) return 0;
    const adminEmails = await getAdminEmailsForCategory(env.DB, STORAGE_POLICY_ALERT_CATEGORY, env);
    if (adminEmails.length === 0) {
      console.error(`[bucket-policy:alert] no admin recipients for ${alertKey(alert)}`);
    } else {
      const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
      delivered = await sendStoragePolicyAlertEmail(
        adminEmails,
        text,
        env.RESEND_API_KEY ?? "",
        fromEmail,
        replyTo,
        isDev,
        env,
      );
    }
  } catch (err) {
    console.error(
      `[bucket-policy:alert] could not notify admins of ${alertKey(alert)}:`,
      err instanceof Error ? err.message : err,
    );
  }
  if (stampId !== null && delivered === 0) await releaseStamp(env.DB, stampId);
  return delivered;
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

/**
 * When `err` is a visibility transition refused at the cap, log it with the
 * stable tag and send the `full` alert. Callers still handle (or rethrow) the
 * error themselves; this only makes sure the admins hear of it.
 */
export async function alertIfPolicyFull(env: Bindings, err: unknown): Promise<void> {
  if (!(err instanceof BucketPolicyFullError)) return;
  console.error(`${POLICY_FULL_TAG} ${err.message}`);
  await notifyStoragePolicyAlert(env, {
    condition: "full",
    bytes: err.bytes,
    capBytes: MAX_BUCKET_POLICY_BYTES,
  });
}
