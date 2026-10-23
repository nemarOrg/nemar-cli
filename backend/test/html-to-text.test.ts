/**
 * The plain-text part of the Cloudflare path's mail (epic #1893).
 *
 * `htmlToText` is exercised on its own for the markup rules, then through real senders from
 * services/email.ts (the sign-in code, revocation and verification mails) so the text a recipient
 * gets is checked on the templates that are sent, with the code and the links in it.
 */

import { describe, expect, test } from "bun:test";
import { htmlToText } from "../src/lib/html-to-text";
import {
  type EmailDeliveryEnv,
  sendPasswordlessCodeEmail,
  sendRevocationEmail,
  sendVerificationEmail,
} from "../src/services/email";
import { recordingBinding } from "./helpers/cloudflare-email";
import { withFakeResend } from "./helpers/resend";

describe("htmlToText", () => {
  test("drops head, style, script and comments", () => {
    const html =
      "<html><head><title>t</title><style>p{color:red}</style></head><body><!-- c --><script>alert(1)</script><p>Hi</p></body></html>";
    expect(htmlToText(html)).toBe("Hi");
  });

  test("breaks lines at br, paragraphs, divs, list items, rows and headings", () => {
    expect(htmlToText("<h1>Title</h1><p>one</p><p>two<br>three</p>")).toBe(
      "Title\n\none\n\ntwo\nthree",
    );
    expect(htmlToText("<div>a</div><div>b</div>")).toBe("a\nb");
    expect(htmlToText("<ul><li>x</li><li>y</li></ul>")).toBe("- x\n- y");
    expect(
      htmlToText(
        "<table><tr><td>Account</td><td>u1</td></tr><tr><td>Email</td><td>e</td></tr></table>",
      ),
    ).toBe("Account u1\nEmail e");
  });

  test("writes a link as label (url) when they differ and once when they match", () => {
    expect(htmlToText('<a href="https://nemar.org" style="x">NEMAR</a>')).toBe(
      "NEMAR (https://nemar.org)",
    );
    expect(htmlToText("<a href='https://x.test/a?b=1&amp;c=2'>go</a>")).toBe(
      "go (https://x.test/a?b=1&c=2)",
    );
    expect(htmlToText('<a href="https://x.test">https://x.test</a>')).toBe("https://x.test");
    expect(htmlToText('<a href="https://x.test"><b>Bold</b> label</a>')).toBe(
      "Bold label (https://x.test)",
    );
    expect(htmlToText('<a href="#top">up</a>')).toBe("up");
  });

  test("decodes named and numeric entities once", () => {
    expect(
      htmlToText("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41;&#66; &nbsp;f &mdash; g"),
    ).toBe("a & b <c> \"d\" 'e' AB f — g");
    expect(htmlToText("&amp;lt;")).toBe("&lt;");
    expect(htmlToText("&unknown; &#0; &#xD800;")).toBe("&unknown; &#0; &#xD800;");
  });

  test("collapses spaces and blank lines and trims", () => {
    expect(htmlToText("  <p>  a \n\t b  </p>\n\n\n\n<p>c</p>  ")).toBe("a b\n\nc");
  });
});

const FROM = "NEMAR Staging <noreply@staging.nemar.test>";
const TO = "tester@nemar.test";

function staging(binding: ReturnType<typeof recordingBinding>["binding"]): EmailDeliveryEnv {
  return {
    ENVIRONMENT: "development",
    DEV_EMAIL_ALLOWLIST: "@nemar.test",
    EMAIL_PROVIDER: "cloudflare",
    EMAIL: binding,
  };
}

describe("the text part of real mails on the Cloudflare provider", () => {
  test("the sign-in code mail carries the code, the instructions and the footer link", async () => {
    const { binding, sent } = recordingBinding();
    await sendPasswordlessCodeEmail(
      TO,
      "483920",
      "unused",
      FROM,
      undefined,
      true,
      staging(binding),
    );
    const text = sent[0].text as string;
    expect(text).toContain("DEV BACKEND - NOT PRODUCTION");
    expect(text).toContain("Your NEMAR sign-in code");
    expect(text).toContain("Use the code below to finish signing in:");
    expect(text.split("\n")).toContain("483920");
    expect(text).toContain("This code expires in 10 minutes.");
    expect(text).toContain(
      "NEMAR (https://nemar.org) - Neuroelectromagnetic Data Archive and Tools Resource",
    );
    expect(text).not.toMatch(/<[a-z/]|&[a-z#]/i);
  });

  test("the revocation mail reads as sentences", async () => {
    const { binding, sent } = recordingBinding();
    await sendRevocationEmail(TO, "tester", "unused", FROM, undefined, true, staging(binding));
    const text = sent[0].text as string;
    expect(text).toContain("Account Access Revoked\n\nHello tester,");
    expect(text).toContain("Your NEMAR account access has been revoked by an administrator.");
    expect(text).not.toMatch(/<[a-z/]|&[a-z#]/i);
  });

  test("a verification link survives with its query string intact", async () => {
    const { binding, sent } = recordingBinding();
    const url = "https://nemar.org/verify?token=abc123&next=%2Fdashboard";
    await sendVerificationEmail(
      TO,
      "tester",
      url,
      "unused",
      FROM,
      undefined,
      true,
      staging(binding),
    );
    const text = sent[0].text as string;
    expect(text).toContain(`Verify Email Address (${url})`);
    expect(text).toContain(url);
  });

  test("the Resend request carries no text part", async () => {
    await withFakeResend(async (calls) => {
      await sendPasswordlessCodeEmail(TO, "483920", "k", FROM, undefined, true, {
        ENVIRONMENT: "development",
        DEV_EMAIL_ALLOWLIST: "@nemar.test",
      });
      expect(calls.length).toBe(1);
      expect(Object.keys(calls[0].body as object).sort()).toEqual([
        "from",
        "html",
        "subject",
        "to",
      ]);
    });
  });
});
