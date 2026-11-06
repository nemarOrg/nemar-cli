/**
 * The conformance rig, started for real (epic #2014 phase #2020): `scripts/oidc-conformance/rig.ts` as
 * a child process on a loopback port, with a self-signed certificate it makes itself, and the pre-flight
 * script (`smoke.ts`) walked against it. Nothing here replaces NEMAR logic: the rig serves the real
 * Worker over a real SQLite database.
 *
 * Held:
 *  - the sign-in page signs in the rig's own account only: any other address is refused before the
 *    statement that clears sign-in codes can run, and the rig's account signs in through the real routes;
 *  - the pre-flight signs in at a client of its own, which is none of the three the plans use, and it
 *    completes sign-in, consent, code, token and identity token;
 *  - the clients register no more scopes than the suite's tests need (`orcid` is refused as
 *    `invalid_scope`, answered by redirect, before any sign-in is asked for).
 *
 * CI TIER: integration (spawns two child processes; needs `openssl`).
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { RIG_ACCOUNT_EMAIL, callbackAddress } from "../scripts/oidc-conformance/plan-config";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
let outDir: string;
let rigLog: string;
let rig: ReturnType<typeof spawn>;
let origin: string;
let port: number;

const insecure = { tls: { rejectUnauthorized: false } } as const;

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const p = probe.port as number;
  await probe.stop(true);
  return p;
}

const readJson = (name: string) => JSON.parse(readFileSync(join(outDir, name), "utf8"));

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "nemar-rig-test-"));
  rigLog = join(outDir, "rig.log");
  port = await freePort();
  origin = `https://localhost:${port}`;
  rig = spawn({
    cmd: ["bun", "run", join(ROOT, "scripts", "oidc-conformance", "rig.ts")],
    cwd: ROOT,
    env: {
      ...process.env,
      RIG_OUT_DIR: outDir,
      RIG_HOST: "localhost",
      RIG_PORT: String(port),
    } as Record<string, string>,
    stdout: Bun.file(rigLog),
    stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${origin}/.well-known/openid-configuration`, insecure);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(200);
  }
  throw new Error("the rig did not start");
});

afterAll(() => {
  rig?.kill();
  rmSync(outDir, { recursive: true, force: true });
});

const form = (fields: Record<string, string>) => ({
  method: "POST",
  redirect: "manual" as const,
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
  ...insecure,
});

describe("the sign-in page", () => {
  test("refuses any address but the rig's own account", async () => {
    const res = await fetch(
      `${origin}/login`,
      form({ email: "someone@example.org", next: "/oauth/authorize" }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("signs the rig's own account in through the real routes, with the real session cookie", async () => {
    const res = await fetch(
      `${origin}/login`,
      form({ email: RIG_ACCOUNT_EMAIL, next: "/oauth/authorize" }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/oauth/authorize");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-"))).toBe(true);
  });
});

describe("the clients", () => {
  test("the pre-flight has a client of its own, apart from the three the plans use", () => {
    const plan = readJson("basic-plan.json");
    const smoke = readJson("smoke-client.json");
    const planIds = [
      plan.client.client_id,
      plan.client2.client_id,
      plan.client_secret_post.client_id,
    ];
    expect(new Set(planIds).size).toBe(3);
    expect(planIds).not.toContain(smoke.client_id);
  });

  test("the pre-flight walks sign-in, consent, code and token", async () => {
    const run = spawn({
      cmd: ["bun", "run", join(ROOT, "scripts", "oidc-conformance", "smoke.ts")],
      cwd: ROOT,
      env: {
        ...process.env,
        RIG_OUT_DIR: outDir,
        RIG_HOST: "localhost",
        RIG_PORT: String(port),
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(run.stdout).text();
    expect(await run.exited).toBe(0);
    expect(out).toContain("[smoke] ok");
    // Its secret is never printed.
    expect(out).not.toContain(readJson("smoke-client.json").client_secret);
  });

  test("register openid, profile, email and offline_access and no more", async () => {
    const smoke = readJson("smoke-client.json");
    const request = (scope: string) =>
      new URLSearchParams({
        response_type: "code",
        client_id: smoke.client_id,
        redirect_uri: callbackAddress("https://localhost.emobix.co.uk:8443", "nemar"),
        scope,
        state: "s",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
      });
    // Scopes the clients were not registered for are refused by redirect, before any sign-in is asked
    // for: the narrowing is the registration's, not the page's.
    for (const scope of [
      "openid orcid",
      "openid nemar.account",
      "openid compute.read",
      "openid compute.submit",
    ]) {
      const res = await fetch(`${origin}/oauth/authorize?${request(scope)}`, {
        redirect: "manual",
        ...insecure,
      });
      expect({ scope, status: res.status }).toEqual({ scope, status: 302 });
      expect({
        scope,
        error: new URL(res.headers.get("location") as string).searchParams.get("error"),
      }).toEqual({ scope, error: "invalid_scope" });
    }
    // And the ones that are registered are not refused.
    for (const scope of ["openid profile email", "openid offline_access"]) {
      const ok = await fetch(`${origin}/oauth/authorize?${request(scope)}`, {
        redirect: "manual",
        ...insecure,
      });
      expect(new URL(ok.headers.get("location") as string, origin).pathname).toBe("/login");
    }
  });

  test("the pre-flight reads its own client's file and never the plan's", () => {
    const text = readFileSync(join(ROOT, "scripts", "oidc-conformance", "smoke.ts"), "utf8");
    expect(text).toContain("smoke-client.json");
    expect(text).not.toContain("basic-plan.json");
  });
});

describe("the authorization responses", () => {
  const lines = () =>
    readFileSync(rigLog, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("[rig] authz "));

  test("a request with no PKCE challenge gets exactly invalid_request, with state and iss and no description", async () => {
    const smoke = readJson("smoke-client.json");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: smoke.client_id,
      redirect_uri: callbackAddress("https://localhost.emobix.co.uk:8443", "nemar"),
      scope: "openid",
      state: "pkce-state",
    });
    const before = lines().length;
    const res = await fetch(`${origin}/oauth/authorize?${query}`, {
      redirect: "manual",
      ...insecure,
    });
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location") as string);
    expect(`${back.origin}${back.pathname}`).toBe(
      callbackAddress("https://localhost.emobix.co.uk:8443", "nemar"),
    );
    expect([...back.searchParams.keys()].sort()).toEqual(["error", "iss", "state"]);
    expect(back.searchParams.get("error")).toBe("invalid_request");
    expect(back.searchParams.get("state")).toBe("pkce-state");
    expect(back.searchParams.get("iss")).toBe(origin);
    expect(back.searchParams.has("error_description")).toBe(false);
    // The rig logged it as the PKCE case: the error code, and that no challenge came with the request.
    await Bun.sleep(200);
    expect(lines().slice(before)).toEqual([
      "[rig] authz kind=redirect error=invalid_request pkce=no",
    ]);
  });

  test("a refusal that is not about PKCE is logged with the challenge it carried", async () => {
    const smoke = readJson("smoke-client.json");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: smoke.client_id,
      redirect_uri: callbackAddress("https://localhost.emobix.co.uk:8443", "nemar"),
      scope: "openid orcid",
      state: "s",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
    const before = lines().length;
    await fetch(`${origin}/oauth/authorize?${query}`, { redirect: "manual", ...insecure });
    await Bun.sleep(200);
    expect(lines().slice(before)).toEqual([
      "[rig] authz kind=redirect error=invalid_scope pkce=yes",
    ]);
  });

  test("the log holds no value: no state, challenge, client id or address", async () => {
    const text = readFileSync(rigLog, "utf8");
    for (const value of [
      "pkce-state",
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw",
      readJson("smoke-client.json").client_id,
    ]) {
      expect(text).not.toContain(value);
    }
  });
});
