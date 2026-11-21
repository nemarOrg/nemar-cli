/**
 * Public mail routes, mounted at `/mail` on the `api` app and therefore also at `/nemar/mail`
 * (epic #2260 phase 2, ADR 0132). No session, no API key, no cookie: the link in the URL is the whole
 * authority, and it can do exactly one thing (see `services/mail-links.ts`).
 *
 *   GET  /mail/unsubscribe/:token        the interim confirmation page; NEVER changes state (mail
 *                                        scanners and link previews fetch every link they find)
 *   GET  /mail/unsubscribe/:token/info   JSON for the website page: category, label, masked address, on
 *   POST /mail/unsubscribe/:token        the change. RFC 8058 one-click: the body is
 *                                        `List-Unsubscribe=One-Click` (urlencoded or multipart), the
 *                                        answer is 200 and NEVER a redirect, no cookie is read.
 *
 * What a POST turns off: only the message's category (owner decision D6). The page's second button
 * posts `scope=all`, which turns off all three community categories. Recalls cannot be turned off and
 * have no link. Idempotent: a second POST changes nothing and answers the same.
 *
 * Every write goes through `saveEmailPreferences`, the one audited writer, with `via`:
 *   `one_click`  a mailbox client's RFC 8058 POST (nothing but the one-click field),
 *   `link`       the page's category button (`from=page`),
 *   `link_all`   the page's all-community-mail button (`scope=all`).
 *
 * Every refusal for a link looks the same: 410 `link_invalid`, whichever part failed (a bad token, a
 * deleted account, a changed address, a rotated secret). A missing secret is the one other answer, 503
 * `mail_links_unconfigured`, because it is the server's fault and not the link's. A rate-limit refusal
 * (429) is the limiter's own body, never this one's.
 *
 * Nothing here logs a token or an address; `middleware/access-log.ts` redacts the token segment from
 * the access log.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import {
  type CommunityMailCategory,
  mailCategoryLabel,
  mailRecallWhy,
} from "../../../shared/contract/mail-categories.js";
import { parseEmailPreferences } from "../services/email";
import { type ResolvedMailLink, maskAddress, resolveMailLink } from "../services/mail-links";
import { type MailChangeVia, saveEmailPreferences } from "../services/mail-preferences";
import type { Bindings, Variables } from "../types/bindings";

export const mailRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/** A one-click body is one short field; anything bigger is not a request this route answers. */
const MAX_BODY_BYTES = 4096;

const NO_LEAK_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

type MailContext = Context<{ Bindings: Bindings; Variables: Variables }>;

const wantsHtml = (c: MailContext): boolean => (c.req.header("accept") ?? "").includes("text/html");

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
button{font:inherit;padding:.6rem 1rem;margin:.25rem 0;cursor:pointer}
form{margin:.5rem 0}
.note{color:#555;font-size:.9rem}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}.note{color:#aaa}}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function respondInvalid(c: MailContext) {
  const message = "This unsubscribe link is not valid.";
  if (wantsHtml(c)) {
    return c.html(
      page("Unsubscribe", `<h1>Unsubscribe</h1><p>${message}</p>`),
      410,
      NO_LEAK_HEADERS,
    );
  }
  return c.json({ error: "link_invalid", message }, 410, NO_LEAK_HEADERS);
}

function respondUnconfigured(c: MailContext) {
  const message = "Unsubscribe links are not available right now. Please try again later.";
  if (wantsHtml(c)) {
    return c.html(
      page("Unsubscribe", `<h1>Unsubscribe</h1><p>${message}</p>`),
      503,
      NO_LEAK_HEADERS,
    );
  }
  return c.json({ error: "mail_links_unconfigured", message }, 503, NO_LEAK_HEADERS);
}

/** Resolve the token or produce the refusal to return. */
async function resolve(
  c: MailContext,
): Promise<{ link: ResolvedMailLink } | { refusal: Response }> {
  const resolution = await resolveMailLink(c.env.DB, c.env, c.req.param("token") ?? "");
  if (resolution.status === "unconfigured") return { refusal: respondUnconfigured(c) };
  if (resolution.status === "invalid") return { refusal: respondInvalid(c) };
  return { link: resolution.link };
}

const isOn = (link: ResolvedMailLink): boolean =>
  parseEmailPreferences(link.user.emailPreferences)[link.claims.category];

mailRoutes.get("/unsubscribe/:token", async (c) => {
  const resolved = await resolve(c);
  if ("refusal" in resolved) return resolved.refusal;
  const { link } = resolved;
  const label = escapeHtml(mailCategoryLabel(link.claims.category));
  const masked = escapeHtml(maskAddress(link.user.email));
  const already = !isOn(link);
  const oneClick = '<input type="hidden" name="List-Unsubscribe" value="One-Click">';
  const body = `<h1>Unsubscribe</h1>
<p>${
    already
      ? `${masked} already does not receive NEMAR ${label} mail.`
      : `Stop NEMAR ${label} mail to ${masked}?`
  }</p>
<form method="post">${oneClick}<input type="hidden" name="from" value="page"><button type="submit">Unsubscribe from ${label}</button></form>
<form method="post">${oneClick}<input type="hidden" name="scope" value="all"><button type="submit">Unsubscribe from all NEMAR community mail</button></form>
<p class="note">${escapeHtml(mailRecallWhy())}</p>
<p class="note">Nothing changes until you press a button.</p>`;
  return c.html(page("Unsubscribe", body), 200, NO_LEAK_HEADERS);
});

mailRoutes.get("/unsubscribe/:token/info", async (c) => {
  const resolved = await resolve(c);
  if ("refusal" in resolved) return resolved.refusal;
  const { link } = resolved;
  return c.json(
    {
      category: link.claims.category,
      label: mailCategoryLabel(link.claims.category),
      masked_email: maskAddress(link.user.email),
      on: isOn(link),
    },
    200,
    NO_LEAK_HEADERS,
  );
});

type ParsedBody = { fields: URLSearchParams } | { status: 400 | 413 | 415; error: string };

/** The two bodies RFC 8058 allows, read with a size cap and no cookie or header beyond the type. */
async function readBody(c: MailContext): Promise<ParsedBody> {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { status: 413, error: "body_too_large" };
  }
  try {
    if (type.startsWith("application/x-www-form-urlencoded")) {
      const text = await c.req.text();
      if (text.length > MAX_BODY_BYTES) return { status: 413, error: "body_too_large" };
      return { fields: new URLSearchParams(text) };
    }
    if (type.startsWith("multipart/form-data")) {
      const form = await c.req.formData();
      const fields = new URLSearchParams();
      for (const [key, value] of form.entries()) {
        if (typeof value === "string") fields.append(key, value);
      }
      return { fields };
    }
  } catch {
    return { status: 400, error: "bad_request" };
  }
  return { status: 415, error: "unsupported_media_type" };
}

mailRoutes.post("/unsubscribe/:token", async (c) => {
  const resolved = await resolve(c);
  if ("refusal" in resolved) return resolved.refusal;
  const { link } = resolved;

  const body = await readBody(c);
  if ("status" in body) return c.json({ error: body.error }, body.status, NO_LEAK_HEADERS);
  const { fields } = body;
  // RFC 8058: the body is `List-Unsubscribe=One-Click`. Anything else is not a one-click request.
  if (fields.get("List-Unsubscribe") !== "One-Click") {
    return c.json(
      { error: "bad_request", message: "Missing List-Unsubscribe=One-Click." },
      400,
      NO_LEAK_HEADERS,
    );
  }
  const scope = fields.get("scope") ?? "category";
  if (scope !== "category" && scope !== "all") {
    return c.json({ error: "bad_request", message: "Unknown scope." }, 400, NO_LEAK_HEADERS);
  }

  const category: CommunityMailCategory = link.claims.category;
  const changes =
    scope === "all"
      ? { news: false, rfcs: false, maintenance: false }
      : ({ [category]: false } as Partial<Record<CommunityMailCategory, false>>);
  const via: MailChangeVia =
    scope === "all" ? "link_all" : fields.get("from") === "page" ? "link" : "one_click";

  // The person changes their own preferences: actor and target are the same account.
  const written = await saveEmailPreferences(c.env.DB, {
    targetId: link.user.id,
    targetUsername: link.user.username ?? "",
    actorId: link.user.id,
    changes,
    via,
  });
  // Deleted between the read and the write: the same answer as any other dead link.
  if (!written) return respondInvalid(c);

  const label = mailCategoryLabel(category);
  if (wantsHtml(c)) {
    const what = scope === "all" ? "all NEMAR community mail" : `NEMAR ${escapeHtml(label)} mail`;
    return c.html(
      page(
        "Unsubscribed",
        `<h1>Unsubscribed</h1><p>${escapeHtml(maskAddress(link.user.email))} will no longer receive ${what}.</p><p class="note">${escapeHtml(mailRecallWhy())}</p>`,
      ),
      200,
      NO_LEAK_HEADERS,
    );
  }
  return c.json({ status: "unsubscribed", scope, category }, 200, NO_LEAK_HEADERS);
});
