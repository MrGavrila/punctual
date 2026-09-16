-- One nullable key per booking is enough to arbitrate concurrent creates for
-- an event type/email pair. Past rows keep their history in `bookings`; the
-- key is cleared lazily when that guest books again.
ALTER TABLE bookings ADD COLUMN active_email_key TEXT;

CREATE UNIQUE INDEX bookings_active_email_key_idx
  ON bookings (active_email_key);
