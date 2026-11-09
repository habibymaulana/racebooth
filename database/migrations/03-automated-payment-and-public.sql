-- Additive migration 03: Automated Payment Simulator and Public Photobooth
-- Preserves all existing tables, columns, rows, and constraints.

-- 1. Relax role check on app_users to support service identity
ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check;
ALTER TABLE app_users ADD CONSTRAINT app_users_role_check CHECK (role IN ('operator', 'supervisor', 'service'));

-- 2. Insert authorized backend service account if not already present
INSERT INTO app_users (id, full_name, email, role, is_active)
VALUES ('00000000-0000-4000-8000-000000000001', 'Photobooth Backend Service', 'service@photobooth.internal', 'service', TRUE)
ON CONFLICT (id) DO UPDATE SET is_active = TRUE, role = 'service';

-- 3. Allow operator_id on payment_transactions to default to service account
ALTER TABLE payment_transactions ALTER COLUMN operator_id DROP NOT NULL;
ALTER TABLE payment_transactions ALTER COLUMN operator_id SET DEFAULT '00000000-0000-4000-8000-000000000001';

-- 4. Allow operator_id on photobooth_sessions to default to service account
ALTER TABLE photobooth_sessions ALTER COLUMN operator_id DROP NOT NULL;
ALTER TABLE photobooth_sessions ALTER COLUMN operator_id SET DEFAULT '00000000-0000-4000-8000-000000000001';

-- 5. Public checkout sessions tracking
CREATE TABLE IF NOT EXISTS public_checkout_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL UNIQUE REFERENCES payment_transactions(id),
  checkout_key TEXT NOT NULL UNIQUE,
  package_id UUID NOT NULL REFERENCES photo_packages(id),
  package_snapshot JSONB NOT NULL,
  simulation_scenario TEXT NOT NULL DEFAULT 'success' CHECK (simulation_scenario IN ('success', 'failure', 'expired', 'cancelled')),
  simulation_state TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK (simulation_state IN ('awaiting_payment', 'processing', 'completed', 'failed', 'cancelled')),
  client_ip INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_public_checkout_sessions_key ON public_checkout_sessions(checkout_key);
CREATE INDEX IF NOT EXISTS idx_public_checkout_sessions_tx ON public_checkout_sessions(transaction_id);

-- 6. Payment simulation audit events
CREATE TABLE IF NOT EXISTS payment_simulation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES payment_transactions(id),
  event_type TEXT NOT NULL,
  scenario TEXT NOT NULL,
  status TEXT NOT NULL,
  signature_verified BOOLEAN NOT NULL DEFAULT TRUE,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_simulation_events_tx ON payment_simulation_events(transaction_id);

-- 7. Relax check constraints on operator_payment_audit to record automated simulation results
ALTER TABLE operator_payment_audit DROP CONSTRAINT IF EXISTS operator_payment_audit_action_check;
ALTER TABLE operator_payment_audit ADD CONSTRAINT operator_payment_audit_action_check
  CHECK (action IN ('simulation_payment_confirmed', 'simulation_gateway_paid', 'simulation_gateway_failed', 'simulation_gateway_cancelled'));

ALTER TABLE operator_payment_audit DROP CONSTRAINT IF EXISTS operator_payment_audit_new_status_check;
ALTER TABLE operator_payment_audit ADD CONSTRAINT operator_payment_audit_new_status_check
  CHECK (new_status IN ('paid', 'failed', 'cancelled'));

-- Drop unique constraint on transaction_id in operator_payment_audit to allow recording multiple audit attempts (e.g. failure then retry)
ALTER TABLE operator_payment_audit DROP CONSTRAINT IF EXISTS operator_payment_audit_transaction_id_key;
