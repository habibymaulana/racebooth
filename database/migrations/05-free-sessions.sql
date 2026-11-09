-- Migration 05: Free photobooth sessions for racebooth.
-- Additive only. No DROP/TRUNCATE/DELETE.

BEGIN;

-- 1. Add 'free' to payment_method enum
ALTER TABLE payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_payment_method_check;
ALTER TABLE payment_transactions
  ADD CONSTRAINT payment_transactions_payment_method_check
  CHECK (payment_method IN ('cash', 'transfer', 'qris', 'card', 'free'));

-- 2. Free sessions table (independent, rate-limited creation)
CREATE TABLE IF NOT EXISTS free_photobooth_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key     TEXT NOT NULL UNIQUE CHECK (LENGTH(session_key) = 64),
  photo_limit     INTEGER NOT NULL DEFAULT 4 CHECK (photo_limit BETWEEN 1 AND 10),
  session_id      UUID UNIQUE REFERENCES photobooth_sessions(id),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'active', 'completed', 'expired')),
  frame_design    TEXT NOT NULL DEFAULT 'blueberry'
                  CHECK (frame_design IN ('blueberry','pink-diary','retro-bloom','midnight-film','sunny-picnic','sweet-memories')),
  client_ip       INET,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '2 hours'
);
CREATE INDEX IF NOT EXISTS idx_free_sessions_key ON free_photobooth_sessions(session_key);
CREATE INDEX IF NOT EXISTS idx_free_sessions_expires ON free_photobooth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_free_sessions_ip_created ON free_photobooth_sessions(client_ip, created_at DESC);

-- 3. Email delivery tracking for free sessions
CREATE TABLE IF NOT EXISTS free_session_email_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  free_session_id UUID NOT NULL REFERENCES free_photobooth_sessions(id),
  recipient_email TEXT NOT NULL CHECK (LENGTH(recipient_email) BETWEEN 5 AND 254),
  gallery_url     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'failed')),
  n8n_response    JSONB,
  sent_at         TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  failure_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_session ON free_session_email_deliveries(free_session_id);
CREATE INDEX IF NOT EXISTS idx_email_deliveries_status ON free_session_email_deliveries(status, created_at DESC);

-- 4. Extend session_photostrips background to support frame designs
ALTER TABLE session_photostrips
  DROP CONSTRAINT IF EXISTS session_photostrips_background_check;
ALTER TABLE session_photostrips
  ADD CONSTRAINT session_photostrips_background_check
  CHECK (background IN ('white','black','pink','yellow','mint','lavender',
    'blueberry','pink-diary','retro-bloom','midnight-film','sunny-picnic','sweet-memories'));

-- 5. Track migration
INSERT INTO operator_schema_migrations(name) VALUES('05-free-sessions')
ON CONFLICT(name) DO NOTHING;

COMMIT;
