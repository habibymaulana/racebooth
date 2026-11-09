-- Additive QC evidence storage. Existing incidents/runs remain untouched.
ALTER TABLE qc_runs ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::jsonb;
