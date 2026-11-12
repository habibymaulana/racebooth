-- Shared rate-limit counters for serverless instances. IP-based keys are
-- HMACed by the application; raw client identifiers are never stored here.
CREATE TABLE IF NOT EXISTS api_rate_limit_counters (
  namespace TEXT NOT NULL CHECK (namespace ~ '^[A-Za-z0-9_-]{1,40}$'),
  key_hash TEXT NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  hits INTEGER NOT NULL CHECK (hits >= 0),
  reset_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (namespace,key_hash)
);
CREATE INDEX IF NOT EXISTS idx_api_rate_limit_counters_reset_at
  ON api_rate_limit_counters(reset_at);
