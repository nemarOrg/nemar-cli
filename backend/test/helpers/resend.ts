// Real-boundary email capture for backend tests.
//
// Not a mock of the email service: services/email.ts runs unchanged, builds
// its real HTML, applies the real delivery fence, and issues a real `fetch`.
// Only the DESTINATION moves -- `api.resend.com` is redirected to a local
// Bun.serve() instance -- so a test can read exactly what would have been
// mailed (recipient, subject, body) without touching the live internet.
// Mirrors the redirect pattern in zarr-index-v3.test.ts's `getZarrIndex`
// tests; extracted here from email-delivery-fence.test.ts (#1252) once a
// second and third suite needed it.
//
// Sends still have to pass the fence to arrive: outside production that means
// ENVIRONMENT plus a DEV_EMAIL_ALLOWLIST entry covering the recipient. A test
// that expects mail and sees none should check those before suspecting the
// route.

export interface CapturedEmail {
  path: string;
  body: unknown;
}

/** A single-recipient Resend send, as this helper's callers assert on it. */
export interface ResendSendBody {
  from: string;
  to: string[];
  subject: string;
  html: string;
}

/** Narrow a captured call to the single-send shape (`POST /emails`). */
export function asSend(call: CapturedEmail): ResendSendBody {
  return call.body as ResendSendBody;
}

/** Subjects of every captured single send, in order. */
export function subjects(calls: CapturedEmail[]): string[] {
  return calls.filter((c) => c.path === "/emails").map((c) => asSend(c).subject);
}

/** Captured single sends addressed to `recipient` (case-insensitive). */
export function sendsTo(calls: CapturedEmail[], recipient: string): ResendSendBody[] {
  const want = recipient.toLowerCase();
  return calls
    .filter((c) => c.path === "/emails")
    .map(asSend)
    .filter((b) => (b.to ?? []).some((addr) => addr.toLowerCase() === want));
}

/**
 * Run `fn` with `api.resend.com` redirected to a local server, handing it the
 * list of captured requests. Always restores the real `fetch` and stops the
 * server, even if `fn` throws.
 */
export async function withFakeResend<T>(fn: (calls: CapturedEmail[]) => Promise<T>): Promise<T> {
  const calls: CapturedEmail[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = await req.json().catch(() => null);
      calls.push({ path: url.pathname, body });
      if (url.pathname === "/emails/batch") {
        const items = Array.isArray(body) ? body : [];
        return new Response(JSON.stringify({ data: items.map(() => ({ id: "batch-ok" })) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: "email-ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === "api.resend.com") {
      const local = new URL(url.pathname + url.search, `http://127.0.0.1:${server.port}`);
      return realFetch(new Request(local, req));
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
    server.stop(true);
  }
}
