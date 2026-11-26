/**
 * The footer and headers of community mail (epic #2260 phase 3, ADR 0132 decision 7).
 *
 * Every recipient of a categorized message gets a footer and headers of their own, because the
 * unsubscribe link is signed for one account, one category and one broadcast (`services/mail-links.ts`).
 * A non-recall message carries:
 *   - the category's label and the reason the person receives it,
 *   - the unsubscribe link, visible in the body, and the same URL in the RFC 8058 headers,
 *   - a link to manage every preference,
 *   - the postal address (owner decision D7).
 * A RECALL carries none of the unsubscribe parts, because nothing may turn a recall off: no link, no
 * headers, no address. It says why it cannot be turned off and links the definition instead.
 *
 * The words that name a category or explain a recall come from `shared/contract/account-copy.ts` (ADR
 * 0045); what is written here is mail layout, which is not account copy.
 */

import {
  type MailCategory,
  RECALL_CATEGORY,
  mailCategoryLabel,
  mailRecallWhy,
} from "../../../shared/contract/mail-categories.js";
import { escapeHtml } from "../lib/escape";
import { LIST_UNSUBSCRIBE_POST_VALUE } from "./email";

/** Owner decision D7 (2026-11-20): the postal address CAN-SPAM wants in every non-recall footer. */
export const MAIL_POSTAL_ADDRESS =
  "Swartz Center for Computational Neuroscience, University of California San Diego, 9836 Hopkins Dr, La Jolla, CA 92093";

/** Where a recall footer sends the reader for what a recall is (the page phase 6 publishes). */
export const COMMUNITY_MAIL_DOCS_URL = "https://docs.nemar.org/policies/community-mail";

const DEFAULT_APP_BASE_URL = "https://app.nemar.org";

/** Where a person manages every community category (the website's settings page). */
export function preferencesUrl(appBaseUrl: string | undefined): string {
  const base = (appBaseUrl ?? "").trim().replace(/\/+$/, "") || DEFAULT_APP_BASE_URL;
  return `${base}/settings`;
}

export interface CategoryFooterInput {
  category: MailCategory;
  /** The signed unsubscribe URL. Required for every category but a recall, refused for a recall. */
  unsubscribeUrl?: string;
  appBaseUrl?: string;
}

/** The footer's HTML. Throws when a non-recall has no link or a recall has one: both are bugs. */
export function buildCategoryFooter(input: CategoryFooterInput): string {
  const { category, unsubscribeUrl } = input;
  const label = escapeHtml(mailCategoryLabel(category));
  const manage = escapeHtml(preferencesUrl(input.appBaseUrl));
  const style = 'style="color: #999; font-size: 12px; margin: 8px 0;"';
  const link = 'style="color: #999;"';

  if (category === RECALL_CATEGORY) {
    if (unsubscribeUrl !== undefined) {
      throw new Error("a recall footer has no unsubscribe link");
    }
    return `
  <p ${style}>You are receiving this recall notice because you hold, or held, a NEMAR account.</p>
  <p ${style}>${escapeHtml(mailRecallWhy())}</p>
  <p ${style}><a href="${escapeHtml(COMMUNITY_MAIL_DOCS_URL)}" ${link}>What a NEMAR recall is</a> &middot; <a href="${manage}" ${link}>Manage your email preferences</a></p>`;
  }

  if (!unsubscribeUrl || !unsubscribeUrl.startsWith("https://")) {
    throw new Error("a community mail footer needs an https unsubscribe link");
  }
  const unsubscribe = escapeHtml(unsubscribeUrl);
  return `
  <p ${style}>You are receiving this NEMAR ${label} message because you have a NEMAR account and ${label} mail is turned on for it.</p>
  <p ${style}><a href="${unsubscribe}" ${link}>Unsubscribe from ${label} mail</a> &middot; <a href="${manage}" ${link}>Manage your email preferences</a></p>
  <p ${style}>${escapeHtml(MAIL_POSTAL_ADDRESS)}</p>`;
}

/**
 * The RFC 8058 headers of a non-recall message: `List-Unsubscribe` with the one HTTPS URI and the
 * `List-Unsubscribe-Post` one-click marker. A recall has none, and this refuses to produce them.
 */
export function categoryMailHeaders(
  category: MailCategory,
  unsubscribeUrl: string | undefined,
): Record<string, string> | undefined {
  if (category === RECALL_CATEGORY) return undefined;
  if (!unsubscribeUrl) throw new Error("a community mail message needs an unsubscribe URL");
  return {
    "List-Unsubscribe": `<${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": LIST_UNSUBSCRIBE_POST_VALUE,
  };
}
