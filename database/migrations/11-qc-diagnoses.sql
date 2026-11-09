CREATE TABLE IF NOT EXISTS qc_diagnoses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES qc_incidents(id),
  severity TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
  diagnosis TEXT NOT NULL,
  probable_root_cause TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS qc_diagnoses_incident_time_idx ON qc_diagnoses(incident_id, created_at DESC);
INSERT INTO operator_schema_migrations(name) VALUES('11-qc-diagnoses') ON CONFLICT(name) DO NOTHING;
