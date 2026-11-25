/**
 * Unsubscribe link tokens (epic #2260 phase 2, ADR 0132): `services/mail-links.ts`.
 *
 * The signature is pinned against a message typed out HERE, byte for byte and with its own HMAC, not
 * against the signer's own encoder: a change of domain tag, field order or separator must fail.
 *
 * MUTATIONS (each makes a test below fail): drop the address from the signed message; accept `recall`
 * in the parser or the signer; make `verifyMailLinkSignature` return true; stop trying the previous
 * secret; treat a short secret as set; compare signatures with `===` instead of `timingSafeEqual`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MIN_MAIL_LINK_SECRET_LENGTH,
  type MailLinkClaims,
  MailLinkSecretUnsetError,
  encodeMailLinkPayload,
  mailLinkSecrets,
  mailUnsubscribeUrl,
  maskAddress,
  parseMailLinkToken,
  requireMailLinkSecret,
  signMailLinkToken,
  verifyMailLinkSignature,
} from "../src/services/mail-links";

const SECRET_A = "a".repeat(64);
const SECRET_B = "b".repeat(64);
const ADDRESS = "Person@Example.test";
const CLAIMS: MailLinkClaims = { userId: 7, category: "news", broadcastId: 42 };

/** HMAC-SHA256 base64url over a message typed by hand, independent of the module under test. */
async function handSign(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return Buffer.from(mac).toString("base64url");
}

async function verifies(token: string, address: string, secrets: string[]): Promise<boolean> {
  const parsed = parseMailLinkToken(token);
  return parsed ? verifyMailLinkSignature(parsed, address, secrets) : false;
}

describe("the signed message", () => {
  test("is the domain tag, version, ids, category and normalized address, one per line", async () => {
    const token = await signMailLinkToken(CLAIMS, ADDRESS, SECRET_A);
    const expected = await handSign(
      "mail-unsubscribe\nv1\n7\nnews\n42\nperson@example.test",
      SECRET_A,
    );
    expect(token).toBe(`v1.7.news.42.${expected}`);
    expect(encodeMailLinkPayload(CLAIMS, `  ${ADDRESS} `)).toBe(
      "mail-unsubscribe\nv1\n7\nnews\n42\nperson@example.test",
    );
  });

  test("a signature made under another purpose's domain tag does not verify", async () => {
    const forged = await handSign(
      "compute-webhook\nv1\n7\nnews\n42\nperson@example.test",
      SECRET_A,
    );
    expect(await verifies(`v1.7.news.42.${forged}`, ADDRESS, [SECRET_A])).toBe(false);
  });

  test("the address is not in the token", async () => {
    const token = await signMailLinkToken(CLAIMS, ADDRESS, SECRET_A);
    expect(token.toLowerCase()).not.toContain("example");
    expect(token).not.toContain("@");
  });
});

describe("verification", () => {
  test("a token verifies for the address it was signed for, whatever its case or padding", async () => {
    const token = await signMailLinkToken(CLAIMS, ADDRESS, SECRET_A);
    expect(await verifies(token, "person@example.test", [SECRET_A])).toBe(true);
    expect(await verifies(token, "  PERSON@EXAMPLE.TEST ", [SECRET_A])).toBe(true);
  });

  test("a changed address fails", async () => {
    const token = await signMailLinkToken(CLAIMS, ADDRESS, SECRET_A);
    expect(await verifies(token, "other@example.test", [SECRET_A])).toBe(false);
    // The tombstone's masked address is a changed address too.
    expect(await verifies(token, "deleted-7@deleted.invalid", [SECRET_A])).toBe(false);
  });

  test("each field tampered fails", async () => {
    const token = await signMailLinkToken(CLAIMS, ADDRESS, SECRET_A);
    const [v, user, category, broadcast, sig] = token.split(".") as [
      string,
      string,
      string,
      string,
      string,
    ];
    const flipped = `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    for (const tampered of [
      `${v}.8.${category}.${broadcast}.${sig}`,
      `${v}.${user}.rfcs.${broadcast}.${sig}`,
      `${v}.${user}.maintenance.${broadcast}.${sig}`,
      `${v}.${user}.${category}.43.${sig}`,
      `${v}.${user}.${category}.${broadcast}.${flipped}`,
    ]) {
      expect(await verifies(tampered, ADDRESS, [SECRET_A]), tampered).toBe(false);
    }
  });

  test("another secret fails, and no secret verifies nothing", async () => {
    const token = await signMailLinkToken(CLAIMS, ADDRESS, SECRET_A);
    expect(await verifies(token, ADDRESS, [SECRET_B])).toBe(false);
    expect(await verifies(token, ADDRESS, [])).toBe(false);
  });

  test("a rotated secret: the previous value keeps old links working, and only while it is offered", async () => {
    const old = await signMailLinkToken(CLAIMS, ADDRESS, SECRET_A);
    const fresh = await signMailLinkToken(CLAIMS, ADDRESS, SECRET_B);
    expect(await verifies(old, ADDRESS, [SECRET_B, SECRET_A])).toBe(true);
    expect(await verifies(fresh, ADDRESS, [SECRET_B, SECRET_A])).toBe(true);
    expect(await verifies(old, ADDRESS, [SECRET_B])).toBe(false);
  });

  test("an address with a line break verifies nothing", async () => {
    const token = await signMailLinkToken(CLAIMS, ADDRESS, SECRET_A);
    expect(await verifies(token, "a@b.test\nnews", [SECRET_A])).toBe(false);
  });

  test("the comparison is the shared constant-time one", () => {
    const source = readFileSync(join(import.meta.dir, "../src/services/mail-links.ts"), "utf8");
    expect(source).toContain('import { timingSafeEqual } from "../lib/constant-time.js"');
    expect(source).toContain("timingSafeEqual(parsed.signature, expected)");
    expect(source).not.toMatch(/signature\s*[!=]==/);
  });
});

describe("recalls have no link", () => {
  test("the signer refuses recall, and any other category", async () => {
    for (const category of ["recall", "announcements", "user_approval", ""]) {
      await expect(
        signMailLinkToken({ ...CLAIMS, category } as unknown as MailLinkClaims, ADDRESS, SECRET_A),
        category,
      ).rejects.toThrow();
    }
  });

  test("the parser answers null for a recall token even when its signature is valid", async () => {
    const sig = await handSign(
      "mail-unsubscribe\nv1\n7\nrecall\n42\nperson@example.test",
      SECRET_A,
    );
    expect(parseMailLinkToken(`v1.7.recall.42.${sig}`)).toBeNull();
    expect(await verifies(`v1.7.recall.42.${sig}`, ADDRESS, [SECRET_A])).toBe(false);
  });
});

describe("parsing", () => {
  const SIG = "A".repeat(43);

  test("a well-formed token parses to its claims", () => {
    expect(parseMailLinkToken(`v1.7.rfcs.42.${SIG}`)).toEqual({
      claims: { userId: 7, category: "rfcs", broadcastId: 42 },
      signature: SIG,
    });
  });

  test("anything else is null", () => {
    for (const bad of [
      "",
      "v1",
      `v2.7.news.42.${SIG}`,
      `v1.7.news.42.${SIG}.x`,
      `v1.7.news.${SIG}`,
      `v1..news.42.${SIG}`,
      `v1.-7.news.42.${SIG}`,
      `v1.7.NEWS.42.${SIG}`,
      `v1.0.news.42.${SIG}`,
      `v1.7.news.0.${SIG}`,
      `v1.7.news.42.${"A".repeat(42)}`,
      `v1.7.news.42.${"A".repeat(44)}`,
      `v1.7.news.42.${"A".repeat(42)}=`,
      `v1.99999999999999999999.news.42.${SIG}`,
      `v1.7.news.42.${SIG}\n`,
      ` v1.7.news.42.${SIG}`,
      `v1.7.news.42.${SIG}/info`,
    ]) {
      expect(parseMailLinkToken(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseMailLinkToken(undefined as unknown as string)).toBeNull();
  });

  test("a line break in the address, a bad id or an empty secret is refused at signing", async () => {
    await expect(signMailLinkToken(CLAIMS, "a@b.test\nrecall", SECRET_A)).rejects.toThrow();
    await expect(signMailLinkToken(CLAIMS, "   ", SECRET_A)).rejects.toThrow();
    await expect(signMailLinkToken({ ...CLAIMS, userId: 0 }, ADDRESS, SECRET_A)).rejects.toThrow();
    await expect(
      signMailLinkToken({ ...CLAIMS, broadcastId: 1.5 }, ADDRESS, SECRET_A),
    ).rejects.toThrow();
    await expect(signMailLinkToken(CLAIMS, ADDRESS, "")).rejects.toThrow(MailLinkSecretUnsetError);
  });
});

describe("the secrets", () => {
  test("current first, previous second, and a secret that is too short is unset", () => {
    expect(mailLinkSecrets({ MAIL_LINK_SECRET: SECRET_A })).toEqual([SECRET_A]);
    expect(
      mailLinkSecrets({ MAIL_LINK_SECRET: SECRET_B, MAIL_LINK_SECRET_PREVIOUS: SECRET_A }),
    ).toEqual([SECRET_B, SECRET_A]);
    expect(mailLinkSecrets({})).toEqual([]);
    expect(mailLinkSecrets({ MAIL_LINK_SECRET: "   " })).toEqual([]);
    expect(
      mailLinkSecrets({ MAIL_LINK_SECRET: "a".repeat(MIN_MAIL_LINK_SECRET_LENGTH - 1) }),
    ).toEqual([]);
    expect(
      mailLinkSecrets({ MAIL_LINK_SECRET: "a".repeat(MIN_MAIL_LINK_SECRET_LENGTH) }),
    ).toHaveLength(1);
  });

  test("a previous secret alone is not a configuration, and an equal pair counts once", () => {
    expect(mailLinkSecrets({ MAIL_LINK_SECRET_PREVIOUS: SECRET_A })).toEqual([]);
    expect(
      mailLinkSecrets({ MAIL_LINK_SECRET: SECRET_A, MAIL_LINK_SECRET_PREVIOUS: SECRET_A }),
    ).toEqual([SECRET_A]);
  });

  test("a send asks for the signing secret and is refused when there is none", () => {
    expect(requireMailLinkSecret({ MAIL_LINK_SECRET: SECRET_A })).toBe(SECRET_A);
    expect(() => requireMailLinkSecret({})).toThrow(MailLinkSecretUnsetError);
    expect(() => requireMailLinkSecret({ MAIL_LINK_SECRET_PREVIOUS: SECRET_A })).toThrow(
      MailLinkSecretUnsetError,
    );
    try {
      requireMailLinkSecret({});
    } catch (err) {
      expect((err as MailLinkSecretUnsetError).code).toBe("mail_link_secret_unset");
    }
  });
});

describe("helpers", () => {
  test("the URL is the API origin, the route and the token, once", () => {
    expect(mailUnsubscribeUrl("https://api.nemar.org", "tok")).toBe(
      "https://api.nemar.org/mail/unsubscribe/tok",
    );
    expect(mailUnsubscribeUrl("https://api-test.nemar.org/", "tok")).toBe(
      "https://api-test.nemar.org/mail/unsubscribe/tok",
    );
  });

  test("a masked address keeps its first letter and its domain only", () => {
    expect(maskAddress("person@example.test")).toBe("p***@example.test");
    expect(maskAddress("nonsense")).toBe("***");
    expect(maskAddress("@example.test")).toBe("***");
  });
});
