-- Durable, bounded recovery for cancellation email and calendar deletion.
CREATE TABLE booking_delivery_tasks (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  action_version TEXT NOT NULL,
  audience TEXT CHECK (audience IS NULL OR audience IN ('guest', 'host')),
  kind TEXT NOT NULL CHECK (kind IN ('email', 'calendar_delete')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'done', 'skipped', 'needs_attention')),
  round INTEGER NOT NULL DEFAULT 0 CHECK (round >= 0 AND round <= 4),
  next_attempt_at INTEGER NOT NULL,
  deadline_at INTEGER,
  dispatch_after INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at INTEGER,
  first_attempt_at INTEGER,
  completed_at INTEGER,
  error_category TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX booking_delivery_tasks_due_idx
  ON booking_delivery_tasks (status, next_attempt_at, dispatch_after, created_at);
