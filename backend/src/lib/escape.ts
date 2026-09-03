/**
 * Shared HTML/XML entity escaping (issue #1226, phase 3 of epic #1225).
 *
 * Consolidates six near-duplicate hand-rolled implementations that had
 * drifted: three `escapeHtml` copies used `&#039;` for the apostrophe
 * (backend/src/routes/auth.ts, backend/src/services/broadcast.ts,
 * backend/src/services/email.ts), one used `&#39;`
 * (backend/src/services/data-router.ts), and two `escapeXml` copies
 * (backend/src/services/s3.ts, backend/src/services/datacite.ts) used
 * `&apos;`. This module is the single source for all three operations;
 * every prior local copy has been deleted in favor of importing from here.
 *
 * `escape-html` (npm) was considered and declined: it only covers the HTML
 * half, so `escapeXml` and `unescapeXml` would still be bespoke, and it
 * would add a CommonJS dependency to a Workers bundle for five
 * `String.replace` calls. See the phase 3 PR body for the full writeup
 * (ADR 0037).
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape the five HTML special characters (`& < > " '`) for safe inclusion
 * in HTML markup, mapping the apostrophe to `&#39;` (no leading zero).
 *
 * A single pass over a character class -- rather than five chained
 * `.replace()` calls -- so a character produced by one substitution (e.g.
 * the `&` inside `&lt;`) can never be re-scanned and double-escaped. Chained
 * replaces only avoid that trap because escaping `&` happens to run first;
 * this form does not depend on ordering at all.
 */
export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/**
 * Escape the same five characters for safe inclusion in XML markup
 * (DataCite metadata records, S3 Multi-Object Delete request bodies),
 * mapping the apostrophe to `&apos;` instead.
 *
 * Kept as a separate function from `escapeHtml` rather than a shared
 * implementation with an "apostrophe style" parameter: `&apos;` is a
 * predefined XML entity but is NOT one of the entities HTML 4 recognizes,
 * so it must never leak into an HTML page or email body (some parsers
 * would render the literal text "&apos;" instead of an apostrophe). Two
 * distinct functions make that impossible to get backwards at a call site.
 */
export function escapeXml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/**
 * Decode exactly the five entities `escapeXml` produces. This is the
 * inverse of `escapeXml`, not a general HTML/XML entity decoder: it does
 * not touch numeric character references or any other named entity. A
 * partial general decoder would silently mishandle inputs it wasn't built
 * for while looking complete; an honest narrow decoder that only undoes
 * `escapeXml` is safer.
 *
 * `&amp;` MUST be decoded LAST. Decoding it first turns the literal text
 * `&amp;lt;` (an escaped `&` followed by the literal characters `lt;`) into
 * `&lt;` after the `&amp;` -> `&` step, and if the `&lt;` -> `<` step then
 * runs afterward, that newly-formed `&lt;` gets misread as an escaped `<`,
 * silently corrupting a string that only ever contained an escaped
 * ampersand followed by literal text. Decoding `&amp;` last means any `&`
 * it produces is never re-scanned for the other four entities (each
 * `.replace(...)` call is a single non-overlapping pass, so a `&` produced
 * by the final step is never re-examined either).
 */
export function unescapeXml(str: string): string {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
