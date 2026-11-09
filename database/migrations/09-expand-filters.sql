-- Migration 09: Expand session_photos filter check for art filters
-- Additive only. No DROP/TRUNCATE/DELETE of data.

BEGIN;

ALTER TABLE session_photos
  DROP CONSTRAINT IF EXISTS session_photos_filter_check;
ALTER TABLE session_photos
  ADD CONSTRAINT session_photos_filter_check
  CHECK (filter IN (
    'original', 'bw', 'vintage', 'warm', 'cool', 'sepia', 'contrast', 'glow',
    'pencil-sketch', 'comic-pop', 'doodle-art', 'retro-print', 'dreamy-illustration', 'magazine-cutout'
  ));

INSERT INTO operator_schema_migrations(name) VALUES('09-expand-filters')
ON CONFLICT(name) DO NOTHING;

COMMIT;
