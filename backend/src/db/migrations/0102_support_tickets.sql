-- Epic #1893 phase 3 (#1896): inbound mail becomes support tickets.
-- Raw messages stay in R2 (the record); these tables are the working copy that is built from
-- them and can be rebuilt from them (services/tickets.ts, reprocessRawKey).
-- User ids are plain INTEGERs with no foreign key, as in 0098: a user row is tombstoned and
-- never deleted, and the cascades in routes/admin/users.ts and db/user-tombstone.ts clear
-- every reference to a removed person explicitly.
--
-- mail_queues: one row per recipient local part that has its own routing ('support',
--   'security', ...), plus '*', the fallback for any other tag. restricted=1 queues are visible
--   to owners only. strategy: fixed (assignee_user_id), round_robin (rr_members, a JSON array of
--   user ids, advanced through rr_cursor) or pool (left unassigned for anyone eligible to take).
-- mail_tickets: ref is the short random token of the plus address support+t<ref>@; a reply to
--   it threads here. restricted is copied from the queue at creation. excluded_user_id names an
--   account that must never see or hold the ticket, even if it is an owner.
-- mail_ticket_tags: descriptive labels from the recipient address. A tag is chosen by whoever
--   writes the address, so it must NEVER be used for an access decision; restricted and
--   excluded_user_id on the ticket are the only inputs to access.
-- mail_messages: raw_key is UNIQUE so processing one stored message twice stores it once.
-- mail_availability: away window with a backup person; away_until NULL is open-ended.
CREATE TABLE IF NOT EXISTS mail_queues (
  tag TEXT PRIMARY KEY,
  restricted INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0, 1)),
  strategy TEXT NOT NULL DEFAULT 'pool'
    CHECK (strategy IN ('fixed', 'round_robin', 'pool')),
  assignee_user_id INTEGER,
  backup_user_id INTEGER,
  rr_members TEXT NOT NULL DEFAULT '[]',
  rr_cursor INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mail_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL CHECK (length(ref) = 10 AND ref NOT GLOB '*[^a-z2-7]*'),
  queue_tag TEXT NOT NULL CHECK (length(queue_tag) > 0),
  restricted INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0, 1)),
  excluded_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'pending', 'escalated', 'closed', 'spam')),
  assignee_user_id INTEGER,
  requester_email TEXT NOT NULL,
  requester_user_id INTEGER,
  subject TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_tickets_ref ON mail_tickets (ref);
CREATE INDEX IF NOT EXISTS idx_mail_tickets_status ON mail_tickets (status, last_message_at);
CREATE INDEX IF NOT EXISTS idx_mail_tickets_queue ON mail_tickets (queue_tag, last_message_at);
CREATE INDEX IF NOT EXISTS idx_mail_tickets_assignee
  ON mail_tickets (assignee_user_id, last_message_at);
-- The release statements and the tombstone privacy clear look tickets up by these two.
CREATE INDEX IF NOT EXISTS idx_mail_tickets_requester_user ON mail_tickets (requester_user_id);
CREATE INDEX IF NOT EXISTS idx_mail_tickets_excluded_user ON mail_tickets (excluded_user_id);

CREATE TABLE IF NOT EXISTS mail_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES mail_tickets (id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out', 'note')),
  message_id TEXT,
  in_reply_to TEXT,
  references_ids TEXT,
  from_addr TEXT NOT NULL DEFAULT '',
  to_addr TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  raw_key TEXT,
  spf TEXT NOT NULL DEFAULT 'none',
  dkim TEXT NOT NULL DEFAULT 'none',
  dmarc TEXT NOT NULL DEFAULT 'none',
  author_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_messages_raw_key ON mail_messages (raw_key);
CREATE INDEX IF NOT EXISTS idx_mail_messages_message_id ON mail_messages (message_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_ticket ON mail_messages (ticket_id, id);

CREATE TABLE IF NOT EXISTS mail_ticket_tags (
  ticket_id INTEGER NOT NULL REFERENCES mail_tickets (id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (ticket_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_mail_ticket_tags_tag ON mail_ticket_tags (tag);

CREATE TABLE IF NOT EXISTS mail_ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES mail_tickets (id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN ('created', 'assigned', 'unassigned', 'escalated', 'status', 'reopened',
                    'restricted', 'excluded', 'reply', 'reply_failed', 'note')),
  actor_user_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mail_ticket_events_ticket ON mail_ticket_events (ticket_id, id);

CREATE TABLE IF NOT EXISTS mail_availability (
  user_id INTEGER PRIMARY KEY,
  away_from TEXT,
  away_until TEXT,
  backup_user_id INTEGER,
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mail_queues_assignee ON mail_queues (assignee_user_id);
CREATE INDEX IF NOT EXISTS idx_mail_queues_backup ON mail_queues (backup_user_id);
CREATE INDEX IF NOT EXISTS idx_mail_availability_backup ON mail_availability (backup_user_id);

-- security and conduct are restricted and start unassigned, so owners see them until an owner
-- sets themself. '*' is the fallback queue: fixed to the default admin when that account
-- exists, else (no such user, NULL assignee) it behaves as a pool.
INSERT OR IGNORE INTO mail_queues (tag, restricted, strategy) VALUES ('security', 1, 'pool');
INSERT OR IGNORE INTO mail_queues (tag, restricted, strategy) VALUES ('conduct', 1, 'pool');
INSERT OR IGNORE INTO mail_queues (tag, restricted, strategy, assignee_user_id)
  VALUES ('*', 0, 'fixed', (SELECT id FROM users WHERE username = 'nemarAdmin' COLLATE NOCASE));
