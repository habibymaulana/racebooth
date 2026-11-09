-- Migration 12: ensure the legacy paid-flow simulation marker exists.
-- Additive and idempotent; existing values and transaction rows are preserved.

ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO operator_schema_migrations(name) VALUES('12-simulated-payment-tracking')
ON CONFLICT(name) DO NOTHING;
