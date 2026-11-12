-- Migration 14: protected package management and auditable visitor payment simulation.
-- Additive business-data changes only. Existing package and payment rows are retained.

ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check;
ALTER TABLE app_users ADD CONSTRAINT app_users_role_check
  CHECK (role IN ('operator', 'supervisor', 'admin', 'service'));

ALTER TABLE photo_packages
  ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS benefits JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE photo_packages DROP CONSTRAINT IF EXISTS photo_packages_benefits_array_check;
ALTER TABLE photo_packages ADD CONSTRAINT photo_packages_benefits_array_check
  CHECK (jsonb_typeof(benefits) = 'array');
ALTER TABLE photo_packages DROP CONSTRAINT IF EXISTS photo_packages_display_order_check;
ALTER TABLE photo_packages ADD CONSTRAINT photo_packages_display_order_check
  CHECK (display_order BETWEEN 0 AND 10000);

ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS currency_id CHAR(3) NOT NULL DEFAULT 'IDR',
  ADD COLUMN IF NOT EXISTS payment_reference TEXT,
  ADD COLUMN IF NOT EXISTS package_snapshot JSONB;

-- Freeze the package terms visible at the point this migration runs. Later admin edits
-- change only the current package row, never these transaction snapshots or amounts.
UPDATE payment_transactions t
SET package_snapshot = jsonb_build_object(
  'id', p.id,
  'name', p.name,
  'price_idr', t.amount_idr,
  'description', p.description,
  'benefits', p.benefits,
  'photo_limit', p.photo_limit,
  'session_duration_minutes', p.session_duration_minutes
)
FROM photo_packages p
WHERE p.id = t.package_id AND t.package_snapshot IS NULL;

ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_currency_id_check;
ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_currency_id_check CHECK (currency_id = 'IDR');
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_transactions_reference
  ON payment_transactions(payment_reference) WHERE payment_reference IS NOT NULL;

ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_payment_method_check;
ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_payment_method_check
  CHECK (payment_method IN ('cash', 'transfer', 'qris', 'card', 'free', 'simulation'));

ALTER TABLE public_checkout_sessions
  ADD COLUMN IF NOT EXISTS flow_type TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS frame_design TEXT NOT NULL DEFAULT 'blueberry';
ALTER TABLE public_checkout_sessions DROP CONSTRAINT IF EXISTS public_checkout_sessions_flow_type_check;
ALTER TABLE public_checkout_sessions ADD CONSTRAINT public_checkout_sessions_flow_type_check
  CHECK (flow_type IN ('legacy', 'visitor'));
ALTER TABLE public_checkout_sessions DROP CONSTRAINT IF EXISTS public_checkout_sessions_frame_design_check;
ALTER TABLE public_checkout_sessions ADD CONSTRAINT public_checkout_sessions_frame_design_check
  CHECK (frame_design IN ('blueberry','pink-diary','retro-bloom','midnight-film','sunny-picnic','sweet-memories',
    'doodle-booth','retro-checker','denim-memories','polka-party','heart-collage','vintage-film'));

ALTER TABLE operator_payment_audit DROP CONSTRAINT IF EXISTS operator_payment_audit_action_check;
ALTER TABLE operator_payment_audit ADD CONSTRAINT operator_payment_audit_action_check
  CHECK (action IN ('simulation_payment_confirmed', 'simulation_gateway_paid', 'simulation_gateway_failed',
    'simulation_gateway_cancelled', 'automatic_simulated_payment'));

INSERT INTO operator_schema_migrations(name) VALUES('14-admin-packages-auto-simulation')
ON CONFLICT(name) DO NOTHING;
