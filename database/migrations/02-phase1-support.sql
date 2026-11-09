-- Additive Phase 1 support only. Existing business tables and WF-01 stay intact.
-- Run through backend/scripts/migrate.js; it checks prerequisites and records this migration.
CREATE TABLE IF NOT EXISTS operator_http_sessions (
  sid VARCHAR NOT NULL PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operator_http_sessions_expire ON operator_http_sessions(expire);

CREATE TABLE IF NOT EXISTS operator_transaction_requests (
  transaction_id UUID PRIMARY KEY REFERENCES payment_transactions(id),
  operator_id UUID NOT NULL REFERENCES app_users(id),
  request_key UUID NOT NULL,
  package_id UUID NOT NULL REFERENCES photo_packages(id),
  package_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(operator_id, request_key)
);

CREATE TABLE IF NOT EXISTS operator_payment_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL UNIQUE REFERENCES payment_transactions(id),
  actor_id UUID NOT NULL REFERENCES app_users(id),
  action TEXT NOT NULL CHECK (action = 'simulation_payment_confirmed'),
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL CHECK (new_status = 'paid'),
  is_simulated BOOLEAN NOT NULL CHECK (is_simulated = TRUE),
  request_id UUID NOT NULL,
  actor_ip INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS operator_token_issuance (
  transaction_id UUID PRIMARY KEY REFERENCES payment_transactions(id),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (LENGTH(idempotency_key) = 64),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'issuing', 'issued', 'uncertain', 'failed')),
  session_id UUID UNIQUE REFERENCES photobooth_sessions(id),
  encrypted_token TEXT,
  last_error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (state <> 'issued' OR (session_id IS NOT NULL AND encrypted_token IS NOT NULL))
);

-- Persists account+IP login throttling across application restarts/replicas.
CREATE TABLE IF NOT EXISTS operator_login_limits (
  key_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  blocked_until TIMESTAMPTZ
);
