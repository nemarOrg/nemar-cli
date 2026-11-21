/**
 * `POST /admin/notify` for a group send: the category rules (epic #2260 phase 3, ADR 0132).
 *
 * A group send names a category. This module holds everything that decides whether and to whom it
 * goes, and hands the actual sending to {@link sendBroadcast}, the one send path (the outbox
 * producer and consumer; there is no second path). In order:
 *
 *  1. the category is required, and a recall is the OWNER's alone (the table says who may send);
 *  2. a recall needs a reference of a recognized shape (a dataset also has to exist), carries the
 *     fixed subject prefix, must have the two fixed headings, and, when it is sent for real,
 *     the typed confirmation: the reference typed back (the CLI asks for it; the server insists);
 *  3. the audience is `communityRecipients`, the only place a categorized send selects people;
 *  4. a dry run answers counts, never addresses outside production (dev D1 holds real addresses);
 *  5. the same category, subject and group within 24 hours is refused unless `allow_repeat` is set,
 *     so a re-run command cannot mail everyone twice; the refusal is made by the insert itself
 *     (`enqueueBroadcast`), atomically, and the dry run only reports it;
 *  6. the send itself refuses (nothing written, nothing queued) when the outbox or, for a non-recall,
 *     the link secret is unusable;
 *  7. a recall also publishes a site notice, so the record is public and misuse is visible (D4).
 *
 * Every refusal is a code the CLI can print; none carries an address.
 */

import {
  MAIL_CATEGORY_TABLE,
  MAIL_RECIPIENT_GROUPS,
  type MailCategory,
  type MailRecipientGroup,
  RECALL_CATEGORY,
  RECALL_REFERENCE_REFUSAL,
  RECALL_REQUIRED_HEADINGS,
  mailCategoryLabel,
  missingRecallHeadings,
  parseRecallReference,
  recallSubject,
} from "../../../shared/contract/mail-categories.js";
import {
  type BroadcastEnv,
  type BroadcastResult,
  DUPLICATE_SEND_WINDOW_HOURS,
  categorizedSendBlockers,
  findRecentDuplicate,
  sendBroadcast,
} from "./broadcast";
import { isEmailDeliveryAllowed, redactRecipient, resolveEmailConfig } from "./email";
import { type MailRecipient, communityRecipients } from "./mail-recipients";
import { createNotice } from "./notices";

export interface CategorizedNotifyInput {
  to: MailRecipientGroup;
  category: MailCategory | undefined;
  subject: string;
  body: string;
  recallReference?: string;
  confirmRecall?: string;
  allowRepeat: boolean;
  dryRun: boolean;
}

export interface Actor {
  id: number;
  role: string;
}

/** What the route answers: a status and a JSON body. */
export interface NotifyAnswer {
  status: 200 | 400 | 403 | 404 | 409 | 500 | 503;
  body: Record<string, unknown>;
}

const refuse = (
  status: NotifyAnswer["status"],
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
): NotifyAnswer => ({ status, body: { error, message, ...extra } });

/** Only the literal `production` environment may return addresses; any other value is not it. */
const isProduction = (env: BroadcastEnv): boolean =>
  (env.ENVIRONMENT ?? "").trim().toLowerCase() === "production";

const BLOCKER_MESSAGE = {
  outbox_required:
    "A categorized send needs the Cloudflare mail provider and the announcement outbox, which this environment does not have.",
  mail_link_secret_unset:
    "MAIL_LINK_SECRET is unset or too short, so unsubscribe links cannot be signed. Nothing was queued. The owner sets it with: bunx cfman wrangler --account sccn secret put MAIL_LINK_SECRET",
  mail_link_base_unusable:
    "API_BASE_URL is not an https URL, so the unsubscribe link cannot be built. Nothing was queued.",
} as const;

/** The notice text of a recall: what it is about and where the detail is; never the body. */
function duplicateMessage(category: MailCategory, id: number): string {
  return `A ${category} message with this subject and group was already sent in the last ${DUPLICATE_SEND_WINDOW_HOURS} hours (ID ${id}). Use --allow-repeat to send it again.`;
}

function recallNoticeMessage(subject: string, reference: string): string {
  const text = `${subject} (reference: ${reference}). We emailed every account holder what is affected and what to do.`;
  return text.length <= 1000 ? text : `${text.slice(0, 997)}...`;
}

interface DatasetRow {
  found: number;
}

export async function handleCategorizedNotify(
  db: D1Database,
  env: BroadcastEnv & { RESEND_API_KEY: string },
  actor: Actor,
  input: CategorizedNotifyInput,
): Promise<NotifyAnswer> {
  const { category } = input;
  if (!category) {
    return refuse(
      400,
      "category_required",
      "A group send must name a category: news, rfcs, maintenance or recall. Upgrade the CLI if it does not offer --category.",
    );
  }
  const rule = MAIL_CATEGORY_TABLE[category];
  if (rule.sender === "owner" && actor.role !== "owner") {
    return refuse(403, "owner_only", "Only an owner may send a recall.");
  }

  const isRecall = category === RECALL_CATEGORY;
  let subject = input.subject;
  const reference = input.recallReference?.trim();
  if (!isRecall) {
    if (input.recallReference !== undefined || input.confirmRecall !== undefined) {
      return refuse(
        400,
        "recall_fields_not_allowed",
        "A recall reference and confirmation belong to a recall only.",
      );
    }
  } else {
    if (!reference) {
      return refuse(400, "recall_reference_required", RECALL_REFERENCE_REFUSAL);
    }
    const parsed = parseRecallReference(reference);
    if (!parsed) return refuse(400, "recall_reference_invalid", RECALL_REFERENCE_REFUSAL);
    if (parsed.kind === "dataset") {
      const exists = await db
        .prepare("SELECT 1 AS found FROM datasets WHERE dataset_id = ?")
        .bind(parsed.datasetId)
        .first<DatasetRow>();
      if (!exists) {
        return refuse(404, "recall_dataset_not_found", `No dataset ${parsed.datasetId} exists.`);
      }
    }
    const missing = missingRecallHeadings(input.body);
    if (missing.length > 0) {
      return refuse(
        400,
        "recall_headings_missing",
        `A recall body has the headings ${RECALL_REQUIRED_HEADINGS.map((h) => `"${h}"`).join(" and ")} and nothing else is required. Missing: ${missing.map((h) => `"${h}"`).join(", ")}.`,
        { missing },
      );
    }
    if (!input.dryRun && input.confirmRecall?.trim() !== reference) {
      return refuse(
        400,
        "recall_confirmation_required",
        "A recall is sent only with its reference typed back as the confirmation.",
      );
    }
    subject = recallSubject(subject);
  }

  const recipients = await communityRecipients(db, category, input.to);
  if (recipients.length === 0) {
    return refuse(
      404,
      "no_recipients",
      `No account in the ${mailCategoryLabel(category)} audience matches the selected group.`,
    );
  }
  const deliverable = recipients.filter((r) => isEmailDeliveryAllowed(r.email, env));
  const blockers = categorizedSendBlockers(env, category);

  if (input.dryRun) {
    const counts: Record<string, number> = {};
    for (const group of MAIL_RECIPIENT_GROUPS) {
      counts[group] = (await communityRecipients(db, category, group)).length;
    }
    const duplicate = input.allowRepeat
      ? null
      : await findRecentDuplicate(db, category, subject, input.to);
    return {
      status: 200,
      body: {
        dry_run: true,
        // The id of the send a real run would be refused as a repeat of; absent when none.
        ...(duplicate === null
          ? {}
          : {
              would_refuse: "duplicate_send",
              duplicate_of: duplicate,
              message: duplicateMessage(category, duplicate),
            }),
        category,
        recipient_group: input.to,
        recipient_count: recipients.length,
        // What the delivery fence would let through. Equal to recipient_count in production.
        deliverable_count: deliverable.length,
        counts,
        sample: recipients.slice(0, 3).map((r) => redactRecipient(r.email)),
        // Addresses only in production; elsewhere the database holds real people's addresses.
        ...(isProduction(env) ? { recipients: recipients.map((r) => r.email) } : {}),
        blockers,
        subject,
      },
    };
  }

  const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
  const userIds = new Map<string, number>(
    recipients.map((r: MailRecipient) => [r.email.trim().toLowerCase(), r.userId]),
  );
  const result: BroadcastResult = await sendBroadcast(
    db,
    env.RESEND_API_KEY,
    fromEmail,
    {
      sentById: actor.id,
      group: input.to,
      subject,
      bodyMarkdown: input.body,
      recipients: recipients.map((r) => r.email),
      category,
      recallReference: reference,
      userIds,
      allowRepeat: input.allowRepeat,
    },
    replyTo,
    isDev,
    env,
  );

  if (result.error === "email_service_unconfigured") {
    return refuse(500, "email_service_unconfigured", "The mail provider is not configured.");
  }
  if (result.error === "duplicate_send") {
    return refuse(409, "duplicate_send", duplicateMessage(category, result.broadcast_id), {
      broadcast_id: result.broadcast_id,
    });
  }
  if (result.error === "all_recipients_fenced") {
    return refuse(
      409,
      "all_recipients_fenced",
      "Every recipient is withheld by the non-production delivery fence. Nothing was queued and nothing was recorded as sent.",
      { suppressed_count: result.suppressed_count },
    );
  }
  if (result.error && result.error in BLOCKER_MESSAGE) {
    const code = result.error as keyof typeof BLOCKER_MESSAGE;
    return refuse(code === "outbox_required" ? 409 : 503, code, BLOCKER_MESSAGE[code]);
  }

  const answer: Record<string, unknown> = { ...result, category };
  if (isRecall && result.broadcast_id > 0) {
    try {
      const notice = await createNotice(
        db,
        {
          message: recallNoticeMessage(subject, reference ?? ""),
          level: "critical",
          scope: "all",
        },
        actor.id,
      );
      answer.notice_id = notice.id;
    } catch (error) {
      console.error(
        "[notify] the recall was queued but its site notice could not be created:",
        error instanceof Error ? error.message : String(error),
      );
      answer.notice_error = "notice_failed";
    }
  }
  return { status: 200, body: answer };
}
