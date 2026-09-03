/**
 * Table tests for the shared escape/unescape helpers (issue #1226, phase 3
 * of epic #1225). This is a supplement, not the coverage -- per
 * .rules/testing.md the real coverage is the entry points these helpers
 * feed, exercised in:
 *
 *   - test/data-route.unit.test.ts (served HTML, data.nemar.org directory
 *     listing) -- run directly, not duplicated here.
 *   - test/broadcast.test.ts-adjacent case added below, driving
 *     broadcast.ts's exported, pure buildBroadcastHtml. Every send*Email
 *     builder in backend/src/services/email.ts inlines its HTML into a
 *     local variable and immediately hands it to the private (non-exported)
 *     sendEmail(), which performs a real network fetch to Resend -- there is
 *     no way to obtain the built HTML without sending mail. buildBroadcastHtml
 *     is the pure email-template entry point the brief calls out as the
 *     fallback for exactly this shape.
 *   - test/datacite.test.ts, extended below with a creator-name case
 *     covering all five characters through the real buildDataCiteXml.
 *   - this file, case 5: parseDeleteObjectsResponse (extracted from
 *     deleteObjects in backend/src/services/s3.ts, the same way
 *     mergeObjectSizesPage was extracted from listObjectSizes) driven with a
 *     real <DeleteResult> document.
 */

import { describe, expect, test } from "bun:test";
import { escapeHtml, escapeXml, unescapeXml } from "../src/lib/escape";
import { buildBroadcastHtml } from "../src/services/broadcast";
import { parseDeleteObjectsResponse } from "../src/services/s3";

// ---------------------------------------------------------------------------
// Case 1: table test on the helpers themselves.
// ---------------------------------------------------------------------------

// A payload containing all five special characters, an already-escaped
// `&amp;` (to prove a single pass doesn't get confused by pre-existing
// entity-shaped text -- it only ever sees raw characters), and a full
// <script> fragment.
const PAYLOAD = `already &amp; escaped <script>alert("x")</script>&'`;

describe("escapeHtml", () => {
  test("escapes all five HTML characters, the literal & inside an already-escaped &amp;, and neutralises a <script> fragment", () => {
    expect(escapeHtml(PAYLOAD)).toBe(
      "already &amp;amp; escaped &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;",
    );
  });

  test("apostrophe maps to &#39; (no leading zero), matching data-router.ts's existing golden assertions", () => {
    expect(escapeHtml("'")).toBe("&#39;");
  });
});

describe("escapeXml", () => {
  test("escapes all five XML characters, the literal & inside an already-escaped &amp;, and neutralises a <script> fragment, with &apos; for the apostrophe", () => {
    expect(escapeXml(PAYLOAD)).toBe(
      "already &amp;amp; escaped &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&apos;",
    );
  });

  test("apostrophe maps to &apos;, NOT &#39; -- the only difference from escapeHtml", () => {
    expect(escapeXml("'")).toBe("&apos;");
    expect(escapeXml("'")).not.toBe(escapeHtml("'"));
  });
});

describe("unescapeXml(escapeXml(x)) round-trip", () => {
  const cases: Record<string, string> = {
    "bare ampersand": "&",
    "literal &amp; text (not an escaped ampersand)": "&amp;",
    "literal &lt; text (not an escaped less-than)": "&lt;",
    "double quote": '"',
    apostrophe: "'",
    "mixed sentence with all five characters plus literal entity-shaped text": `Tom & Jerry's "great" <adventure> &amp; &lt;more&gt;`,
  };

  for (const [name, input] of Object.entries(cases)) {
    test(`round-trips: ${name}`, () => {
      expect(unescapeXml(escapeXml(input))).toBe(input);
    });
  }

  // The case that fails if &amp; is decoded before the other four entities:
  // escapeXml("&lt;") (four literal characters: & l t ;) only has its
  // leading "&" escaped, producing "&amp;lt;". Decoding &amp; FIRST would
  // turn that into "&lt;", which a subsequent &lt; -> "<" step would then
  // misread as an escaped less-than, corrupting a string that only ever
  // contained an escaped ampersand followed by literal text "lt;".
  test("&amp; is decoded LAST: &amp;lt; round-trips to the literal text &lt;, not <", () => {
    const literalAmpLt = "&lt;"; // four literal characters, no real "<"
    const escaped = escapeXml(literalAmpLt);
    expect(escaped).toBe("&amp;lt;");
    expect(unescapeXml(escaped)).toBe(literalAmpLt);
    expect(unescapeXml(escaped)).not.toBe("<");
  });
});

// ---------------------------------------------------------------------------
// Case 3 (entry point, email): broadcast.ts's exported, pure
// buildBroadcastHtml. See the file header comment for why this is the
// email entry point used instead of an email.ts send*Email builder.
// ---------------------------------------------------------------------------

describe("buildBroadcastHtml (email entry point)", () => {
  test("an apostrophe in the subject renders as &#39; and a <script> tag is neutralised", () => {
    const html = buildBroadcastHtml(
      `O'Brien's dataset <script>alert(1)</script> update`,
      "<p>body</p>",
    );
    expect(html).toContain(
      "O&#39;Brien&#39;s dataset &lt;script&gt;alert(1)&lt;/script&gt; update",
    );
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

// ---------------------------------------------------------------------------
// Case 5 (entry point, S3 error round-trip): parseDeleteObjectsResponse,
// driven with a real <DeleteResult> document the way
// backend/test/s3-list-object-sizes.test.ts drives mergeObjectSizesPage --
// synthetic XML fed to the exported parser, no live bucket and no mock
// standing in for deleteObjects's own business logic (only the network
// call around the parser is skipped, since deleteObjects performs a real
// fetch that this suite does not reach).
// ---------------------------------------------------------------------------

describe("parseDeleteObjectsResponse", () => {
  test("decodes an XML-escaped <Key> and <Message> in an <Error> block back to their real bytes", () => {
    // deleteObjects escapes every key with escapeXml before sending the
    // request ("a&b.txt" -> "a&amp;b.txt"), so S3 echoes the escaped key
    // back in its response. The <Message> below carries its own escaped
    // entity too (S3 error messages that quote a key are XML-escaped the
    // same way), representing an original message of
    // `Object key "a&b.txt" is denied`.
    const xml = `<?xml version="1.0" encoding="UTF-8"?><DeleteResult>
      <Deleted><Key>nm000123/sub-01/ok.txt</Key></Deleted>
      <Error>
        <Key>nm000123/sub-01/a&amp;b.txt</Key>
        <Code>AccessDenied</Code>
        <Message>Object key &quot;a&amp;b.txt&quot; is denied</Message>
      </Error>
    </DeleteResult>`;

    const batch = ["nm000123/sub-01/ok.txt", "nm000123/sub-01/a&b.txt"];
    const result = parseDeleteObjectsResponse(xml, batch, 0);

    expect(result.deleted).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].key).toBe("nm000123/sub-01/a&b.txt");
    expect(result.failed[0].error).toBe('AccessDenied: Object key "a&b.txt" is denied');
  });

  test("a key with no special characters is unaffected by the decode step", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><DeleteResult>
      <Error>
        <Key>nm000123/sub-01/plain.txt</Key>
        <Code>InternalError</Code>
        <Message>We encountered an internal error</Message>
      </Error>
    </DeleteResult>`;

    const result = parseDeleteObjectsResponse(xml, ["nm000123/sub-01/plain.txt"], 0);
    expect(result.failed[0].key).toBe("nm000123/sub-01/plain.txt");
    expect(result.failed[0].error).toBe("InternalError: We encountered an internal error");
  });
});
