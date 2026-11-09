-- Migration 06: Quality Control and Incident Tracking for racebooth.
BEGIN;

CREATE TABLE IF NOT EXISTS qc_incidents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category        TEXT NOT NULL CHECK (category IN ('api', 'storage', 'email', 'quota', 'workflow', 'system')),
  severity        TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  recommendation  TEXT,
  entity_id       TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_qc_incidents_status ON qc_incidents(status, detected_at DESC);

CREATE TABLE IF NOT EXISTS qc_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  executed_by     TEXT NOT NULL DEFAULT 'operator',
  checks_run      INTEGER NOT NULL DEFAULT 0,
  incidents_found INTEGER NOT NULL DEFAULT 0,
  hermes_status   TEXT NOT NULL DEFAULT 'not_configured',
  summary         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO operator_schema_migrations(name) VALUES('06-qc-monitoring')
ON CONFLICT(name) DO NOTHING;

COMMIT;
