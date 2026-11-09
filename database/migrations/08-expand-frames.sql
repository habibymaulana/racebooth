-- Migration 08: Expand frame designs to 12 frames
-- Additive only. No DROP/TRUNCATE/DELETE of data.

BEGIN;

-- 1. Extend free_photobooth_sessions frame_design check
ALTER TABLE free_photobooth_sessions
  DROP CONSTRAINT IF EXISTS free_photobooth_sessions_frame_design_check;
ALTER TABLE free_photobooth_sessions
  ADD CONSTRAINT free_photobooth_sessions_frame_design_check
  CHECK (frame_design IN (
    'blueberry','pink-diary','retro-bloom','midnight-film','sunny-picnic','sweet-memories',
    'doodle-booth','retro-checker','denim-memories','polka-party','heart-collage','vintage-film'
  ));

-- 2. Extend session_photostrips background check
ALTER TABLE session_photostrips
  DROP CONSTRAINT IF EXISTS session_photostrips_background_check;
ALTER TABLE session_photostrips
  ADD CONSTRAINT session_photostrips_background_check
  CHECK (background IN (
    'white','black','pink','yellow','mint','lavender',
    'blueberry','pink-diary','retro-bloom','midnight-film','sunny-picnic','sweet-memories',
    'doodle-booth','retro-checker','denim-memories','polka-party','heart-collage','vintage-film'
  ));

-- 3. Track migration
INSERT INTO operator_schema_migrations(name) VALUES('08-expand-frames')
ON CONFLICT(name) DO NOTHING;

COMMIT;
