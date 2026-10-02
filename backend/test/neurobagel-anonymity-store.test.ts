/**
 * ADR 0067's amendment (epic #1586, phase 6): the anonymity sweep also verifies that no
 * anonymous deposit is present in the Neurobagel artifact store.
 *
 * Driven through `runAnonymitySweep`, the real service, against the real R2 simulator and a
 * D1 carrying every migration. The test PLANTS bytes in the bucket (it stands in for a writer
 * that broke its own rule, which is the case the invariant is for) and the sweep must find
 * them by listing the real bucket. The other boundaries (GitHub's repository API, EZID, the
 * Zarr index, the raw file host) are the sweep's own DI seams, as in `anonymity-sweep.test.ts`;
 * mail goes through the real mail code to a real local server (`withFakeResend`).
 *
 * What must hold:
 *   - a deposit with any object in the store, or its id anywhere in the index, is a finding of
 *     severity `invariant` that goes to the audit log and to the `dataset_anonymity` mail
 *     category, and the sweep files nothing on GitHub;
 *   - a store that holds only other datasets, no store at all, and a clean store are none;
 *   - a store that could not be listed is `unchecked`, so the verdict is `unverifiable`, never
 *     `verified`;
 *   - the weekly report may COUNT these findings and never names the deposit.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ANONYMOUS_AUTHORS_LABEL } from "../src/services/anonymity";
import {
  type AnonymitySweepSeams,
  NEUROBAGEL_STORE_CHECK,
  runAnonymitySweep,
} from "../src/services/anonymity-sweep";
import {
  ARTIFACT_KINDS,
  META,
  NEUROBAGEL_INDEX_KEY,
  artifactName,
} from "../src/services/neurobagel-store";
import type { Bindings } from "../src/types/bindings";
import { realD1 } from "./helpers/d1";
import { type Harness, startHarness } from "./helpers/neurobagel-harness";
import { type CapturedEmail, sendsTo, withFakeResend } from "./helpers/resend";

let h: Harness;
let fileServer: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  h = await startHarness();
  // The deposit's own files, served by a real local server so the file half of the sweep runs.
  fileServer = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname.split("/").filter(Boolean).slice(3).join("/");
      if (path === "dataset_description.json") {
        return new Response(
          JSON.stringify({ Name: "A title", BIDSVersion: "1.9.0", Authors: ["n/a"] }),
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(async () => {
  fileServer.stop(true);
  await h.dispose();
});
beforeEach(async () => {
  await h.reset();
});

const DEPOSIT = "nm000910";
const OTHER = "nm000911";

function seedOwner(): void {
  h.db.run(
    `INSERT INTO users (id, username, email, password_hash, status, role, email_verified,
                        github_username, given_name, family_name, orcid)
     VALUES (31, 'aklovelace', 'ada@example.org', 'x', 'approved', 'member', 1,
             'ada-gh', 'Ada', 'Lovelace', '0000-0002-1825-0097')
     ON CONFLICT(id) DO NOTHING`,
  );
  h.db.run(
    `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
     VALUES (32, 'anadmin', 'admin@example.org', 'x', 'approved', 'admin', 1)
     ON CONFLICT(id) DO NOTHING`,
  );
}

function seedDeposit(id = DEPOSIT): void {
  seedOwner();
  h.db
    .query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox,
                             github_repo, anonymous, authors, first_published_at)
       VALUES (?, 'A sufficiently descriptive dataset title', 31, 'active', 'public', 0, ?, 1, ?, NULL)`,
    )
    .run(id, `nemarDatasets/${id}`, ANONYMOUS_AUTHORS_LABEL);
}

const sha = (c: string) => c.repeat(64);

/** A writer-shaped artifact, so the real listing recognises it. */
async function plantArtifact(id: string, kind: (typeof ARTIFACT_KINDS)[number]): Promise<void> {
  await h.bucket.put(artifactName(id, kind), `{"id":"${id}"}`, {
    customMetadata: {
      [META.sha256]: sha("a"),
      [META.kind]: kind,
      ...(kind === "jsonld" ? { [META.fingerprint]: "sha256:x" } : {}),
    },
  });
}

const github: { method: string; url: string }[] = [];
function seams(over: Partial<AnonymitySweepSeams> = {}): AnonymitySweepSeams {
  github.length = 0;
  return {
    fetchGithubImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      github.push({ method: init?.method ?? "GET", url: String(input) });
      return new Response(JSON.stringify({ private: true }), { status: 200 });
    }) as unknown as typeof fetch,
    getIdentifierImpl: async () => ({ status: "reserved", dataciteXml: "<resource/>" }),
    fetchZarrIndexImpl: async () => null,
    listGitFilesImpl: async () => [
      { path: "dataset_description.json", sha: "a".repeat(40), size: 60, mode: "100644" },
    ],
    rawBase: `http://127.0.0.1:${fileServer.port}`,
    ...over,
  };
}

function env(over: Partial<Bindings> = {}): Bindings {
  return h.env({
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "test-pat",
    ...over,
    DB: realD1(h.db),
  });
}

const auditFindings = () =>
  h.db
    .query("SELECT resource_id, details FROM audit_log WHERE action = 'anonymity_findings'")
    .all() as { resource_id: string; details: string }[];

describe("the Neurobagel store invariant", () => {
  test("a deposit with no object in the store, beside another dataset that has them, verifies", async () => {
    seedDeposit();
    for (const kind of ARTIFACT_KINDS) await plantArtifact(OTHER, kind);
    await h.bucket.put(NEUROBAGEL_INDEX_KEY, JSON.stringify({ datasets: [{ id: OTHER }] }));
    const res = await runAnonymitySweep(env(), { seams: seams() });
    expect(res.results[0]?.findings).toEqual([]);
    expect(res.verified).toBe(1);
    expect(res.results[0]?.unchecked).not.toContain("neurobagel_store");
  });

  test("a planted artifact is a finding: severity invariant, to the audit log and to the dataset_anonymity category", async () => {
    seedDeposit();
    seedOwner();
    await plantArtifact(DEPOSIT, "jsonld");

    const mail: CapturedEmail[] = await withFakeResend(async (calls) => {
      const res = await runAnonymitySweep(env({ RESEND_API_KEY: "re_test" }), { seams: seams() });
      expect(res.with_findings).toBe(1);
      const finding = res.results[0]?.findings.find((f) => f.check === NEUROBAGEL_STORE_CHECK);
      expect(finding?.severity).toBe("invariant");
      expect(res.results[0]?.status).toBe("findings");
      return calls;
    });

    // The durable record.
    const rows = auditFindings();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe(DEPOSIT);
    expect(
      JSON.parse(rows[0]?.details ?? "{}").findings.map((f: { check: string }) => f.check),
    ).toContain(NEUROBAGEL_STORE_CHECK);
    // And the verdict is read back from the same place as every other finding.
    const stamp = h.db
      .query<{ s: string }, [string]>(
        "SELECT json_extract(sweep_stamps, '$.anonymity_status') AS s FROM datasets WHERE dataset_id = ?",
      )
      .get(DEPOSIT);
    expect(stamp?.s).toBe("findings");

    // The mail category: the depositor, and the administrator who receives dataset_anonymity.
    expect(sendsTo(mail, "ada@example.org")).toHaveLength(1);
    const admin = sendsTo(mail, "admin@example.org");
    expect(admin).toHaveLength(1);
    expect(admin[0]?.html).toContain("The Neurobagel artifact store holds");

    // NEVER on GitHub: every request the sweep made was the one read of repository visibility.
    expect(github.length).toBeGreaterThan(0);
    expect(github.every((g) => g.method === "GET")).toBe(true);
    expect(github.some((g) => /issues|dispatches|pulls/.test(g.url))).toBe(false);
  });

  test("any one of the three artifacts, an unrecognised object, or the id anywhere in the index is enough", async () => {
    for (const [label, plant] of [
      ["only the description", () => plantArtifact(DEPOSIT, "description")],
      ["an object with no writer metadata", () => h.bucket.put(`${DEPOSIT}.jsonld`, "{}")],
      [
        "an index that names it and nothing else",
        () => h.bucket.put(NEUROBAGEL_INDEX_KEY, JSON.stringify({ note: `see ${DEPOSIT}` })),
      ],
      [
        "an index that is not JSON at all",
        () => h.bucket.put(NEUROBAGEL_INDEX_KEY, `broken ${DEPOSIT} {`),
      ],
    ] as const) {
      await h.reset();
      seedDeposit();
      await plant();
      const res = await runAnonymitySweep(env(), { seams: seams() });
      expect(
        res.results[0]?.findings.map((f) => f.check),
        label,
      ).toContain(NEUROBAGEL_STORE_CHECK);
    }
  });

  test("an id that merely begins with the deposit's does not count: the whole id is matched", async () => {
    seedDeposit("nm000910");
    for (const kind of ARTIFACT_KINDS) await plantArtifact("nm000911", kind);
    await h.bucket.put(NEUROBAGEL_INDEX_KEY, JSON.stringify({ datasets: [{ id: "nm0009100" }] }));
    const res = await runAnonymitySweep(env(), { seams: seams() });
    expect(res.results[0]?.findings).toEqual([]);
  });

  test("no store bound in this environment is nothing to find: the verdict is unchanged", async () => {
    seedDeposit();
    const res = await runAnonymitySweep(env({ NEUROBAGEL: undefined }), { seams: seams() });
    expect(res.verified).toBe(1);
    expect(res.results[0]?.unchecked).not.toContain("neurobagel_store");
  });

  test("a store that cannot be listed is unchecked, so the verdict is unverifiable, never verified", async () => {
    seedDeposit();
    const failing = new Proxy(h.bucket, {
      get(target, prop, receiver) {
        if (prop === "list") return async () => Promise.reject(new Error("R2 unavailable"));
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const res = await runAnonymitySweep(env({ NEUROBAGEL: failing as R2Bucket }), {
      seams: seams(),
    });
    expect(res.results[0]?.status).toBe("unverifiable");
    expect(res.results[0]?.unchecked).toContain("neurobagel_store");
    expect(res.results[0]?.findings).toEqual([]);
  });

  test("the store is listed once for the whole pass, however many deposits there are", async () => {
    seedDeposit("nm000910");
    seedDeposit("nm000912");
    seedDeposit("nm000913");
    let lists = 0;
    const counting = new Proxy(h.bucket, {
      get(target, prop, receiver) {
        if (prop === "list") {
          return async (...a: unknown[]) => {
            lists++;
            return (target.list as (...x: unknown[]) => unknown)(...a);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const res = await runAnonymitySweep(env({ NEUROBAGEL: counting as R2Bucket }), {
      seams: seams(),
    });
    expect(res.processed).toBe(3);
    expect(lists).toBe(1);
  });

  test("a deposit that is not anonymous is never a candidate, so a published dataset's artifacts are not a finding", async () => {
    seedOwner();
    h.db
      .query(
        `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox, github_repo, anonymous, first_published_at)
         VALUES (?, 'A published dataset title here', 31, 'active', 'public', 0, ?, 0, '2026-01-01 00:00:00')`,
      )
      .run(OTHER, `nemarDatasets/${OTHER}`);
    for (const kind of ARTIFACT_KINDS) await plantArtifact(OTHER, kind);
    const res = await runAnonymitySweep(env(), { seams: seams() });
    expect(res.processed).toBe(0);
    expect(auditFindings()).toEqual([]);
  });
});
