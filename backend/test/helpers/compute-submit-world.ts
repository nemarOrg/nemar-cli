/**
 * The world the person's job-submission suites run in (epic #2021 phase D3, #2024): the lifecycle
 * fixture (real migrated SQLite, Miniflare's R2 through the Worker's own bindings, the real local S3
 * interface, the Tapis stand-in), the REAL compute router with its real authentication, real API keys
 * and a real session, and the calls a command-line interface makes: a JSON request, a PUT of the
 * archive to the address the Worker issued, and a finalize.
 *
 * Nothing stands in for a NEMAR decision. The Tapis stand-in and the S3 stand-in answer from published
 * specifications; no response of either was recorded from a real service.
 */

import { createHash } from "node:crypto";
import { JobSpecSchema } from "../../../shared/contract/compute";
import { hashApiKey } from "../../src/services/token";
import { issueSession } from "../../src/services/web-session";
import type { Bindings } from "../../src/types/bindings";
import { type LifecycleFixture, startLifecycleFixture } from "./compute-lifecycle-fixture";
import { seedEegDataset } from "./compute-pipeline-fixture";
import { type RoutesHandle, makeRoutesApp } from "./compute-routes-app";
import { fundAccount, seedUser, setPolicy } from "./compute-seed";

export interface World {
  fx: LifecycleFixture;
  handle: RoutesHandle;
  env(over?: Partial<Bindings>): Bindings;
}

export async function startWorld(): Promise<World> {
  const fx = await startLifecycleFixture();
  const handle = makeRoutesApp();
  return { fx, handle, env: (over) => fx.env(over) };
}

/** Reset the world and seed the public EEG dataset every submission names. */
export async function resetWorld(w: World): Promise<void> {
  await w.fx.reset();
  await seedEegDataset(w.env(), "nm000104");
}

export interface Person {
  id: number;
  key: string;
}

let keys = 0;

/** A funded person with compute access (by default `active`) and a real API key. */
export async function newPerson(
  w: World,
  over: { access?: string; grant?: number } = {},
): Promise<Person> {
  const env = w.env();
  const id = await seedUser(env.DB, {});
  await env.DB.prepare("UPDATE users SET compute_access = ?1 WHERE id = ?2")
    .bind(over.access ?? "active", id)
    .run();
  await fundAccount(env.DB, id, over.grant ?? 100_000);
  const key = `cmp-submit-key-${++keys}-0123456789abcdef0123456789abcdef`;
  w.fx.harness.db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(id, await hashApiKey(key), key.slice(0, 8));
  return { id, key };
}

export async function cookieFor(w: World, person: Person): Promise<string> {
  const { cookieIdRaw } = await issueSession(w.env(), person.id, false, null, null, "orcid");
  return `nemar_session=${cookieIdRaw}`;
}

export interface Reply {
  status: number;
  text: string;
  body: Record<string, any>;
  headers: Headers;
  bytes: Uint8Array;
}

export async function call(
  w: World,
  method: "GET" | "POST",
  path: string,
  opts: {
    key?: string | null;
    cookie?: string;
    origin?: string;
    headers?: Record<string, string>;
    json?: unknown;
    raw?: string;
    env?: Bindings;
  } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.origin) headers.Origin = opts.origin;
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.raw !== undefined) {
    headers["content-type"] = "application/json";
    body = opts.raw;
  }
  const res = await w.handle(
    new Request(`http://api.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    }),
    opts.env ?? w.env(),
  );
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let parsed: Record<string, any> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, body: parsed, headers: res.headers, bytes };
}

// --- A bundle, as the packer would make it ---------------------------------------------------------

export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

export interface Bundle {
  archive: Uint8Array;
  size: number;
  sha256: string;
  manifest: { files: Array<{ path: string; size: number; sha256: string }> };
}

/**
 * An archive of arbitrary bytes (the Worker never opens it) and the manifest of the files it claims to
 * hold. The digest is the archive's own; the manifest's are the packer's claims.
 */
export function makeBundle(
  files: Array<{ path: string; content: string }> = [{ path: "run.py", content: "print(1)\n" }],
): Bundle {
  const archive = new TextEncoder().encode(`archive:${files.map((f) => f.path).join(",")}:${keys}`);
  return {
    archive,
    size: archive.length,
    sha256: sha256(archive),
    manifest: {
      files: files.map((f) => ({
        path: f.path,
        size: f.content.length,
        sha256: sha256(f.content),
      })),
    },
  };
}

/** A script job's request: the specification (with `over` applied) and the manifest. */
export function bundleRequest(bundle: Bundle, over: Record<string, unknown> = {}) {
  return {
    spec: {
      name: "a script job",
      runtime: "python",
      entry: "run.py",
      bundle: { size: bundle.size, sha256: bundle.sha256 },
      datasets: [{ id: "nm000104", version: "1.0.0" }],
      partition: "shared",
      cores: 2,
      minutes: 30,
      ...over,
    },
    manifest: bundle.manifest,
  };
}

export const IMAGE_REF = `ghcr.io/example/tool@sha256:${"c".repeat(64)}`;

/** An image job's request: no bundle, a digest-pinned image and a command. */
export function imageRequest(over: Record<string, unknown> = {}) {
  return {
    spec: {
      name: "an image job",
      runtime: "image",
      image: IMAGE_REF,
      command: ["run-it"],
      partition: "shared",
      cores: 2,
      minutes: 30,
      ...over,
    },
  };
}

/** The Worker's policy with the registry list set so that `IMAGE_REF` is allowed. */
export async function allowRegistry(w: World, over: Record<string, unknown> = {}): Promise<void> {
  await setPolicy(w.env().DB, w.fx.ownerId, { registries: ["ghcr.io/example"], ...over });
}

/** PUT the archive to the address the Worker issued, exactly as a command-line interface does. */
export async function putArchive(
  upload: { url: string; headers: Record<string, string>; size: number },
  bytes: Uint8Array,
): Promise<Response> {
  return fetch(upload.url, { method: "PUT", headers: upload.headers, body: bytes });
}

export function parsedSpec(request: { spec: Record<string, unknown> }) {
  return JobSpecSchema.parse(request.spec);
}

/** The row of a job. */
export function jobRow(w: World, id: string): Record<string, any> {
  return w.fx.harness.db.query("SELECT * FROM compute_jobs WHERE id = ?").get(id) as Record<
    string,
    any
  >;
}
