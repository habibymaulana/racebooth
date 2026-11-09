-- Stage 4.2: derived photostrip editing state. Additive only.
ALTER TABLE session_photostrips
  ADD COLUMN IF NOT EXISTS selected_filter TEXT NOT NULL DEFAULT 'original',
  ADD COLUMN IF NOT EXISTS is_finalized BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS edit_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE session_photostrips
  DROP CONSTRAINT IF EXISTS session_photostrips_selected_filter_check;
ALTER TABLE session_photostrips
  ADD CONSTRAINT session_photostrips_selected_filter_check CHECK (selected_filter IN (
    'original','bw','vintage','warm','cool','sepia','contrast','glow',
    'pencil-sketch','comic-pop','doodle-art','retro-print','dreamy-illustration','magazine-cutout'
  ));

-- Existing composed strips are already the historical export and remain shareable.
UPDATE session_photostrips SET is_finalized=TRUE WHERE status='composed' AND is_finalized=FALSE;

INSERT INTO operator_schema_migrations(name) VALUES('10-photostrip-editing')
ON CONFLICT(name) DO NOTHING;
