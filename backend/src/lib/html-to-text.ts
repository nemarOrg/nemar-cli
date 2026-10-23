/**
 * A plain-text alternative for one of NEMAR's own HTML mails (epic #1893).
 *
 * Small and dependency-free on purpose: the inputs are the fixed templates in services/email.ts
 * and services/broadcast.ts, whose variable parts are already escaped, so this is a reader for
 * that markup and not a general HTML parser. A sign-in code and every link survive: a link is
 * written as "label (url)" when the two differ.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  copy: "©",
  rarr: "→",
};

/** Decode named and numeric entities in one pass, so `&amp;lt;` becomes `&lt;` and no further. */
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g,
    (whole, dec, hex, name) => {
      if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
      const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    },
  );
}

const stripTags = (html: string): string => html.replace(/<\/?[a-zA-Z][^>]*>/g, "");

/** The plain-text rendering of `html`, with blank lines collapsed and no trailing space. */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<head\b[\s\S]*?<\/head>/gi, "")
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, "")
    // Source line breaks are whitespace, as in a browser; only the tags below make new lines.
    .replace(/\s+/g, " ");

  // Links first, while their markup is still intact: "label (url)" unless the label is the url.
  text = text.replace(
    /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, dq, sq, inner) => {
      const url = decodeEntities(dq ?? sq ?? "").trim();
      const label = decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
      if (!url || url.startsWith("#") || label === url) return label || url;
      return label ? `${label} (${url})` : url;
    },
  );

  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(?:p|h[1-6]|table|ul|ol|blockquote|pre)\s*>/gi, "\n\n")
    .replace(/<\/(?:div|tr)\s*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " ");

  text = decodeEntities(stripTags(text));

  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
