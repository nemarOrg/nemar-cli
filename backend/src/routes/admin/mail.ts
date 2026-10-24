/**
 * Support-ticket admin routes (epic #1893 phase 3b, ADR 0111). The wire shapes are in
 * shared/contract/mail-admin.ts, which lists the routes and what each refuses.
 *
 * Admin-only through the router's middleware; the owner-only routes check the role here and say
 * so (403). A ticket the caller may not see is a 404 on every route, from the one visibility
 * predicate in services/ticket-assignment.ts. Access reads the role and the ticket's exclusion and
 * nothing else: an admin account held by a person and one held by an agent are treated alike.
 */

import type { Context } from "hono";
import { z } from "zod";
import {
  QUEUE_STRATEGIES,
  SETTABLE_STATUSES,
  TICKET_STATUSES,
} from "../../../../shared/contract/mail-admin";
import {
  MailAdminError,
  addNote,
  assignTicket,
  escalateTicket,
  listTickets,
  replyToTicket,
  requireVisibleTicket,
  setTicketStatus,
  ticketDetail,
} from "../../services/mail-admin";
import { getAvailability, listQueues, putAvailability, putQueue } from "../../services/mail-queues";
import { notifyTicketCreated, notifyTicketEscalated } from "../../services/ticket-notify";
import { reprocessRawKey } from "../../services/tickets";
import type { AdminRouter } from "./shared";

const TEXT_MAX = 20_000;
const id = z.number().int().positive();

const replySchema = z.object({ text: z.string().trim().min(1).max(TEXT_MAX) }).strict();
const noteSchema = replySchema;
const assignSchema = z.object({ user_id: id.nullable() }).strict();
const statusSchema = z.object({ status: z.enum(SETTABLE_STATUSES) }).strict();
const escalateSchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();
const queueSchema = z
  .object({
    restricted: z.boolean().optional(),
    strategy: z.enum(QUEUE_STRATEGIES).optional(),
    assignee_user_id: id.nullable().optional(),
    backup_user_id: id.nullable().optional(),
    rr_members: z.array(id).max(50).optional(),
    escalation_user_id: id.nullable().optional(),
  })
  .strict();
const availabilitySchema = z
  .object({
    away_from: z.string().max(40).nullable().optional(),
    away_until: z.string().max(40).nullable().optional(),
    backup_user_id: id.nullable().optional(),
    note: z.string().max(500).nullable().optional(),
  })
  .strict();
const reprocessSchema = z
  .object({
    raw_key: z.string().regex(/^inbound\/raw\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.eml$/),
  })
  .strict();
const listSchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  queue: z.string().max(64).optional(),
  assignee: z.string().max(20).optional(),
  q: z.string().max(100).optional(),
  cursor: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

function fail(c: Context, error: unknown) {
  if (error instanceof MailAdminError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  console.error(
    "[admin/mail] unexpected failure:",
    error instanceof Error ? error.message : String(error),
  );
  return c.json({ error: "The mail routes failed unexpectedly.", code: "internal" }, 500);
}

async function parseBody<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
  emptyIsObject = false,
): Promise<z.infer<T>> {
  const text = await c.req.text();
  const raw = emptyIsObject && text.trim() === "" ? {} : safeJson(text);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new MailAdminError(
      400,
      "bad_request",
      `Invalid request${first ? `: ${first.path.join(".") || "body"} ${first.message}` : "."}`,
    );
  }
  return parsed.data;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function ticketId(c: Context): number {
  const n = Number(c.req.param("id"));
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new MailAdminError(404, "not_found", "No such ticket.");
  return n;
}

function userIdParam(c: Context): number {
  const n = Number(c.req.param("userId"));
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new MailAdminError(400, "bad_request", "Not a user id.");
  return n;
}

function requireOwner(c: Context): void {
  if (c.get("user").role !== "owner") {
    throw new MailAdminError(403, "forbidden", "Only an owner can do that.");
  }
}

export function registerMailRoutes(admin: AdminRouter): void {
  admin.get("/mail/tickets", async (c) => {
    try {
      const parsed = listSchema.safeParse(c.req.query());
      if (!parsed.success) throw new MailAdminError(400, "bad_request", "Invalid filter.");
      return c.json(await listTickets(c.env.DB, c.get("user"), parsed.data));
    } catch (error) {
      return fail(c, error);
    }
  });

  admin.get("/mail/tickets/:id", async (c) => {
    try {
      const ticket = await requireVisibleTicket(c.env.DB, c.get("user"), ticketId(c));
      return c.json(await ticketDetail(c.env.DB, ticket));
    } catch (error) {
      return fail(c, error);
    }
  });

  admin.post("/mail/tickets/:id/reply", async (c) => {
    try {
      const n = ticketId(c);
      // Validate access before the body, so a hidden ticket is a 404 whatever is sent.
      await requireVisibleTicket(c.env.DB, c.get("user"), n);
      const { text } = await parseBody(c, replySchema);
      const sent = await replyToTicket(c.env, c.get("user"), n, text);
      return c.json({
        message_id: sent.message_id,
        header_message_id: sent.header_message_id,
        status: sent.status,
      });
    } catch (error) {
      return fail(c, error);
    }
  });

  admin.post("/mail/tickets/:id/note", async (c) => {
    try {
      const n = ticketId(c);
      await requireVisibleTicket(c.env.DB, c.get("user"), n);
      const { text } = await parseBody(c, noteSchema);
      const messageId = await addNote(c.env.DB, c.get("user"), n, text);
      return c.json({ message_id: messageId });
    } catch (error) {
      return fail(c, error);
    }
  });

  admin.post("/mail/tickets/:id/assign", async (c) => {
    try {
      const n = ticketId(c);
      await requireVisibleTicket(c.env.DB, c.get("user"), n);
      const { user_id } = await parseBody(c, assignSchema);
      return c.json({ ticket: await assignTicket(c.env.DB, c.get("user"), n, user_id) });
    } catch (error) {
      return fail(c, error);
    }
  });

  admin.post("/mail/tickets/:id/status", async (c) => {
    try {
      const n = ticketId(c);
      await requireVisibleTicket(c.env.DB, c.get("user"), n);
      const { status } = await parseBody(c, statusSchema);
      return c.json({ ticket: await setTicketStatus(c.env.DB, c.get("user"), n, status) });
    } catch (error) {
      return fail(c, error);
    }
  });

  admin.post("/mail/tickets/:id/escalate", async (c) => {
    try {
      const n = ticketId(c);
      await requireVisibleTicket(c.env.DB, c.get("user"), n);
      const body = await parseBody(c, escalateSchema, true);
      const reason = body.reason ? body.reason : null;
      const { ticket, ownerId } = await escalateTicket(c.env.DB, c.get("user"), n, reason);
      // Best effort and it never throws: the escalation stands whether or not the mail goes.
      await notifyTicketEscalated(c.env, c.env.DB, n, ownerId, reason);
      return c.json({ ticket });
    } catch (error) {
      return fail(c, error);
    }
  });

  admin.get("/mail/queues", async (c) => {
    try {
      return c.json({ queues: await listQueues(c.env.DB, c.get("user").role) });
    } catch (error) {
      return fail(c, error);
    }
  });

  admin.put("/mail/queues/:tag", async (c) => {
    try {
      requireOwner(c);
      const req = await parseBody(c, queueSchema);
      return c.json({ queue: await putQueue(c.env.DB, c.req.param("tag") ?? "", req) });
    } catch (error) {
      return fail(c, error);
    }
  });

  admin.get("/mail/availability", async (c) => {
    try {
      return c.json({ availability: await getAvailability(c.env.DB, c.get("user").id) });
    } catch (error) {
      return fail(c, error);
    }
  });

  admin.put("/mail/availability", async (c) => {
    try {
      const req = await parseBody(c, availabilitySchema);
      return c.json({ availability: await putAvailability(c.env.DB, c.get("user").id, req) });
    } catch (error) {
      return fail(c, error);
    }
  });

  admin.get("/mail/availability/:userId", async (c) => {
    try {
      requireOwner(c);
      return c.json({ availability: await getAvailability(c.env.DB, userIdParam(c)) });
    } catch (error) {
      return fail(c, error);
    }
  });

  admin.put("/mail/availability/:userId", async (c) => {
    try {
      requireOwner(c);
      const req = await parseBody(c, availabilitySchema);
      return c.json({ availability: await putAvailability(c.env.DB, userIdParam(c), req) });
    } catch (error) {
      return fail(c, error);
    }
  });

  admin.post("/mail/reprocess", async (c) => {
    try {
      requireOwner(c);
      const { raw_key } = await parseBody(c, reprocessSchema);
      const bucket = c.env.MAIL_INBOUND;
      if (!bucket) {
        throw new MailAdminError(
          503,
          "inbound_not_configured",
          "This Worker has no inbound mail bucket.",
        );
      }
      const result = await reprocessRawKey(c.env.DB, bucket, raw_key);
      if (result.outcome === "missing") {
        throw new MailAdminError(404, "not_found", "That raw message is not in the bucket.");
      }
      if (result.outcome === "created" && !result.spam) {
        await notifyTicketCreated(c.env, c.env.DB, result.ticketId);
      }
      return c.json({
        outcome: result.outcome,
        ticket_id: result.ticketId,
        status: result.status,
      });
    } catch (error) {
      return fail(c, error);
    }
  });
}
