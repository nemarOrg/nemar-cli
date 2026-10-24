/**
 * The announcement outbox consumer (epic #1893 phase 2, ADR 0110). Real D1 for the audit row;
 * the send_email binding is the recorder from helpers/cloudflare-email.ts and the batch is a
 * plain object with ack/retry recorders (helpers/queue-binding.ts): both external boundaries.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { dispatchQueueBatch } from "../src/index";
import { type OutboxEnv, handleOutboxBatch } from "../src/services/email-outbox";
import type { Bindings } from "../src/types/bindings";
import { type BindingMessage, bindingError, recordingBinding } from "./helpers/cloudflare-email";
import { freshDb, realD1 } from "./helpers/d1";
import { recordingBatch } from "./helpers/queue-binding";

function seedBroadcast(db: Database, queued: number): number {
  db.prepare(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('broadcastadmin', 'broadcastadmin@nemar.test', 'x', 'approved', 'admin', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO broadcast_emails
       (sent_by, recipient_group, subject, body_markdown, recipient_count, status, queued_count)
     VALUES (1, 'admins', 'Maintenance window', 'Hello **all**', ?, 'queued', ?)`,
  ).run(queued, queued);
  return 1;
}

const row = (db: Database) =>
  db
    .query<
      {
        status: string;
        delivered_count: number;
        failure_count: number;
        unknown_count: number;
        failed_recipients: string;
      },
      []
    >(
      "SELECT status, delivered_count, failure_count, unknown_count, failed_recipients FROM broadcast_emails",
    )
    .get();

function setup(failure?: (m: BindingMessage) => unknown, extra: Partial<OutboxEnv> = {}) {
  const db = freshDb();
  const { binding, sent } = recordingBinding(failure);
  const env: OutboxEnv = {
    DB: realD1(db),
    ENVIRONMENT: "development",
    DEV_EMAIL_ALLOWLIST: "@nemar.test",
    EMAIL_PROVIDER: "cloudflare",
    EMAIL: binding,
    FROM_EMAIL: "NEMAR Staging <noreply@staging.nemar.test>",
    ...extra,
  };
  return { db, env, sent };
}

const msg = (to: string, broadcast_id = 1) => ({ kind: "broadcast", broadcast_id, to });
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const e = console.error;
  const w = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.error = e;
    console.warn = w;
  }
};

describe("handleOutboxBatch", () => {
  test("sends the rendered announcement, counts it and reaches done", async () => {
    const { db, env, sent } = setup();
    seedBroadcast(db, 2);
    const { batch, recorded } = recordingBatch([msg("a@nemar.test"), msg("b@nemar.test")]);
    await handleOutboxBatch(batch.messages as never, env);

    expect(sent.map((m) => m.to)).toEqual(["a@nemar.test", "b@nemar.test"]);
    expect(sent[0].subject).toBe("[DEV] Maintenance window");
    expect(sent[0].html).toContain("<strong>all</strong>");
    expect(sent[0].html).toContain("DEV BACKEND - NOT PRODUCTION");
    expect(recorded.every((r) => r.acked && r.retried === null)).toBe(true);
    expect(row(db)).toMatchObject({ status: "done", delivered_count: 2 });
  });

  test("status stays queued until every outcome is in", async () => {
    const { db, env } = setup();
    seedBroadcast(db, 3);
    const { batch } = recordingBatch([msg("a@nemar.test")]);
    await handleOutboxBatch(batch.messages as never, env);
    expect(row(db)).toMatchObject({ status: "queued", delivered_count: 1 });
  });

  test("a fenced recipient is a failure, never sent, and its address is stored redacted", async () => {
    const { db, env, sent } = setup();
    seedBroadcast(db, 1);
    const { batch, recorded } = recordingBatch([msg("outsider@example.org")]);
    await quiet(() => handleOutboxBatch(batch.messages as never, env));

    expect(sent).toEqual([]);
    expect(recorded[0]).toMatchObject({ acked: true, retried: null });
    const r = row(db);
    expect(r).toMatchObject({ status: "done", failure_count: 1 });
    expect(JSON.parse(r?.failed_recipients ?? "[]")).toEqual(["o***@example.org"]);
    expect(r?.failed_recipients).not.toContain("outsider");
  });

  test("a definite refusal is a failure and acked without retry", async () => {
    const { db, env } = setup(() => bindingError("E_RECIPIENT_SUPPRESSED", "suppressed"));
    seedBroadcast(db, 1);
    const { batch, recorded } = recordingBatch([msg("a@nemar.test")]);
    await quiet(() => handleOutboxBatch(batch.messages as never, env));
    expect(recorded[0]).toMatchObject({ acked: true, retried: null });
    expect(row(db)).toMatchObject({ status: "done", failure_count: 1, delivered_count: 0 });
    expect(JSON.parse(row(db)?.failed_recipients ?? "[]")).toEqual(["a***@nemar.test"]);
  });

  test.each(["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED"])(
    "%s retries in 300 seconds and changes no counter",
    async (code) => {
      const { db, env } = setup(() => bindingError(code, "slow down"));
      seedBroadcast(db, 1);
      const { batch, recorded } = recordingBatch([msg("a@nemar.test")]);
      await quiet(() => handleOutboxBatch(batch.messages as never, env));
      expect(recorded[0]).toMatchObject({ acked: false, retried: { delaySeconds: 300 } });
      expect(row(db)).toMatchObject({
        status: "queued",
        delivered_count: 0,
        failure_count: 0,
        unknown_count: 0,
      });
    },
  );

  test("an internal error is unknown, acked and never retried", async () => {
    const { db, env } = setup(() => bindingError("E_INTERNAL_SERVER_ERROR", "boom"));
    seedBroadcast(db, 1);
    const { batch, recorded } = recordingBatch([msg("a@nemar.test")]);
    await quiet(() => handleOutboxBatch(batch.messages as never, env));
    expect(recorded[0]).toMatchObject({ acked: true, retried: null });
    expect(row(db)).toMatchObject({ status: "done", unknown_count: 1, failure_count: 0 });
  });

  test("a timeout is unknown, acked and never retried", async () => {
    const { db, env } = setup();
    // A binding that never answers: the broadcast timeout bounds it.
    env.EMAIL = { send: () => new Promise(() => {}) };
    seedBroadcast(db, 1);
    const { batch, recorded } = recordingBatch([msg("a@nemar.test")]);
    const realSetTimeout = globalThis.setTimeout;
    // Shorten only the 10 second bound so the test does not wait for it.
    globalThis.setTimeout = ((fn: () => void, ms?: number) =>
      realSetTimeout(fn, ms === 10_000 ? 20 : ms)) as typeof setTimeout;
    try {
      await quiet(() => handleOutboxBatch(batch.messages as never, env));
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(recorded[0]).toMatchObject({ acked: true, retried: null });
    expect(row(db)).toMatchObject({ status: "done", unknown_count: 1 });
  });

  test("an unusable provider setting is a certain failure", async () => {
    const { db, env } = setup(undefined, { EMAIL_PROVIDER: "cloudfare" });
    seedBroadcast(db, 1);
    const { batch, recorded } = recordingBatch([msg("a@nemar.test")]);
    await quiet(() => handleOutboxBatch(batch.messages as never, env));
    expect(recorded[0]).toMatchObject({ acked: true, retried: null });
    expect(row(db)).toMatchObject({ failure_count: 1 });
  });

  test("a mixed batch lands every outcome and the row is done", async () => {
    const { db, env } = setup((m) =>
      m.to === "bad@nemar.test"
        ? bindingError("E_RECIPIENT_NOT_ALLOWED")
        : m.to === "odd@nemar.test"
          ? bindingError(undefined, "mystery")
          : undefined,
    );
    seedBroadcast(db, 3);
    const { batch } = recordingBatch([
      msg("ok@nemar.test"),
      msg("bad@nemar.test"),
      msg("odd@nemar.test"),
    ]);
    await quiet(() => handleOutboxBatch(batch.messages as never, env));
    expect(row(db)).toMatchObject({
      status: "done",
      delivered_count: 1,
      failure_count: 1,
      unknown_count: 1,
    });
  });

  test("a message whose row is missing is acked without sending", async () => {
    const { env, sent } = setup();
    const { batch, recorded } = recordingBatch([msg("a@nemar.test", 99)]);
    await quiet(() => handleOutboxBatch(batch.messages as never, env));
    expect(sent).toEqual([]);
    expect(recorded[0]).toMatchObject({ acked: true, retried: null });
  });
});

describe("dispatchQueueBatch", () => {
  test("routes broadcast messages to the outbox and acks anything else", async () => {
    const { db, env, sent } = setup();
    seedBroadcast(db, 1);
    const { batch, recorded } = recordingBatch([
      msg("a@nemar.test"),
      { type: "something.else" },
      "not an object",
    ]);
    await quiet(() => dispatchQueueBatch(batch, env as unknown as Bindings));
    expect(sent.length).toBe(1);
    expect(recorded.map((r) => [r.acked, r.retried])).toEqual([
      [true, null],
      [true, null],
      [true, null],
    ]);
    expect(row(db)?.status).toBe("done");
  });
});
