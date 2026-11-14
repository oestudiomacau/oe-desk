CREATE TABLE chat_connector (
  id INTEGER PRIMARY KEY,
  instance_id TEXT NOT NULL,
  last_seen INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE chat_jobs (
  id TEXT PRIMARY KEY,
  receipt_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  payload TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  instance_id TEXT,
  lease_token TEXT,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX chat_jobs_pending ON chat_jobs(state, created_at);
--> statement-breakpoint
CREATE TABLE chat_rate (
  id TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
