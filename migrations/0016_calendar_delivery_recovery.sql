-- Keep remote write destinations even when the provider's response is lost.
CREATE TABLE booking_calendar_targets (
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  uncertain INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (booking_id, connection_id)
);

-- Separate completed confirmation delivery from a temporary dispatch lease.
-- Preserve confirmation_queued_at, including the historical 0009 backfill.
ALTER TABLE bookings ADD COLUMN confirmation_claimed_at INTEGER;

CREATE TABLE booking_confirmation_recipients (
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  audience TEXT NOT NULL CHECK (audience IN ('guest', 'host')),
  queued_at INTEGER NOT NULL,
  PRIMARY KEY (booking_id, audience)
);
