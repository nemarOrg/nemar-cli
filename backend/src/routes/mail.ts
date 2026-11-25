/**
 * Public mail routes, mounted at `/mail` on the `api` app and therefore also at `/nemar/mail`
 * (epic #2260 phase 2, ADR 0132). No session, no API key, no cookie: the link in the URL is the whole
 * authority, and it can do exactly one thing (see `services/mail-links.ts`).
 *
 *   GET  /mail/unsubscribe/:token        a 303 to the website page,
 *                                        `${APP_BASE_URL}/unsubscribe/<token>` (phase 5); NEVER
 *                                        changes state (mail scanners and link previews fetch every
 *                                        link they find) and reads nothing but the path
 *   GET  /mail/unsubscribe/:token/info   JSON for the website page: category, label, masked address, on
 *   POST /mail/unsubscribe/:token        the change. RFC 8058 one-click: the body is
 *                                        `List-Unsubscribe=One-Click` (urlencoded or multipart), the
 *                                        answer is 200 and NEVER a redirect, no cookie is read.
 *
 * What a POST turns off: only the message's category (owner decision D6). The website page's
 * second button posts `scope=all`, which turns off all three community categories. Recalls cannot
 * be turned off and have no link. Idempotent: a second POST changes nothing and answers the same.
 *
 * Every write goes through `saveEmailPreferences`, the one audited writer, with `via`:
 *   `one_click`  a mailbox client's RFC 8058 POST (nothing but the one-click field),
 *   `link`       the website page's category button (`from=page`),
 *   `link_all`   the website page's all-community-mail button (`scope=all`).
 *
 * Every refusal for a link looks the same: 410 `link_invalid`, whichever part failed (a bad token, a
 * deleted account, a changed address, a rotated secret). A missing secret is the one other answer, 503
 * `mail_links_unconfigured` from `/info` and the POST, because it is the server's fault and not the
 * link's; the redirecting GET needs no secret and forwards regardless. A rate-limit refusal
 * (429) is the limiter's own body, never this one's.
 *
 * Maintenance mode never blocks these routes (`middleware/maintenance.ts`, exact shapes, both mounts).
 *
 * LOGS. Nothing here logs a token or an address, and the Worker's own logs (the access log and the rate
 * limiter's lines) redact the token segment. App logs are redacted; Cloudflare invocation logs keep the
 * URL (observability samples every request and records it whole, and this code cannot change that); a
 * leaked token can only turn one category off for one person, who can turn it back on in settings.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import {
  type CommunityMailCategory,
  mailCategoryLabel,
} from "../../../shared/contract/mail-categories.js";
import { parseEmailPreferences } from "../services/email";
import { appBase } from "../services/environment";
import {
  type ResolvedMailLink,
  maskAddress,
  parseMailLinkToken,
  resolveMailLink,
} from "../services/mail-links";
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
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}}
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

/**
 * The link in the mail lands here and is sent on to the website page, which reads `/info` and
 * posts the change itself. Only a token that parses strictly is forwarded: the parser's alphabet is
 * digits, lowercase letters, `.`, `_`, `-` and base64url, all unreserved in a URL path, so the
 * token goes into `Location` as it is and nothing a sender typed (a `/`, `?`, `#`, `%` or space)
 * can reach the header. Anything else is the uniform 410 here, without a redirect.
 *
 * Neither the secret nor the database is read: a parsed token whose signature is bad, whose
 * account is gone, or which arrives while `MAIL_LINK_SECRET` is unset is still forwarded, and the
 * website page says so from `/info`. That keeps this GET free of any side effect and of any HMAC
 * cost.
 */
mailRoutes.get("/unsubscribe/:token", (c) => {
  const token = c.req.param("token") ?? "";
  if (!parseMailLinkToken(token)) return respondInvalid(c);
  return c.body(null, 303, {
    ...NO_LEAK_HEADERS,
    Location: `${appBase(c.env)}/unsubscribe/${token}`,
  });
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

/**
 * Read at most {@link MAX_BODY_BYTES} bytes of the request body, counting what actually arrives: the
 * declared Content-Length is a hint a client may lie about or omit (chunked), so it is never trusted.
 * Null when the body is larger, whatever its framing; the stream is cancelled at the first byte over.
 */
async function readBounded(request: Request): Promise<Uint8Array | null> {
  const stream = request.body;
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The two bodies RFC 8058 allows. The content type is checked first, then the size through a bounded
 * read, all before anything touches the database or computes an HMAC, so a refused body costs nothing.
 */
async function readBody(c: MailContext): Promise<ParsedBody> {
  // The type as sent: a multipart boundary is case-sensitive. Only the media type is compared in lowercase.
  const type = c.req.header("content-type") ?? "";
  const urlencoded = type.toLowerCase().startsWith("application/x-www-form-urlencoded");
  const multipart = type.toLowerCase().startsWith("multipart/form-data");
  if (!urlencoded && !multipart) return { status: 415, error: "unsupported_media_type" };
  // A declared length over the cap is refused without reading; an absent or understated one is caught
  // by the bounded read below.
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { status: 413, error: "body_too_large" };
  }
  const bytes = await readBounded(c.req.raw).catch(() => undefined);
  if (bytes === undefined) return { status: 400, error: "bad_request" };
  if (bytes === null) return { status: 413, error: "body_too_large" };
  try {
    if (urlencoded) return { fields: new URLSearchParams(new TextDecoder().decode(bytes)) };
    const form = await new Response(bytes, { headers: { "content-type": type } }).formData();
    const fields = new URLSearchParams();
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") fields.append(key, value);
    }
    return { fields };
  } catch {
    return { status: 400, error: "bad_request" };
  }
}

mailRoutes.post("/unsubscribe/:token", async (c) => {
  // Content type, size and shape first: a refused body costs no D1 read and no HMAC.
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

  const resolved = await resolve(c);
  if ("refusal" in resolved) return resolved.refusal;
  const { link } = resolved;

  const category: CommunityMailCategory = link.claims.category;
  const changes =
    scope === "all"
      ? { news: false, rfcs: false, maintenance: false }
      : ({ [category]: false } as Partial<Record<CommunityMailCategory, false>>);
  // `from=page` (category button) and `scope=all` (all-community button) are sent by the website's
  // unsubscribe page (website `src/lib/mail-unsubscribe-api.ts`); a mailbox client sends neither.
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

  // Always JSON: the website page reads it, and a one-click client ignores the body.
  return c.json({ status: "unsubscribed", scope, category }, 200, NO_LEAK_HEADERS);
});
