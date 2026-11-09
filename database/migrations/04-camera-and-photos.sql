-- Additive migration 04: Camera capture, photo storage, and gallery
-- Preserves all existing tables, rows, and constraints.

-- 1. Photo storage records for each captured image
CREATE TABLE IF NOT EXISTS session_photos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES photobooth_sessions(id),
  sequence        INTEGER NOT NULL CHECK (sequence >= 1),
  status          TEXT NOT NULL DEFAULT 'uploading'
                  CHECK (status IN ('uploading', 'saved', 'failed')),
  filter          TEXT NOT NULL DEFAULT 'original'
                  CHECK (filter IN ('original','bw','vintage','warm','cool','sepia','contrast','glow')),
  storage_path    TEXT,   -- relative: sessions/YYYY/MM/SESSION_UUID/photo-NNN.jpg
  file_size_bytes INTEGER,
  width_px        INTEGER,
  height_px       INTEGER,
  download_token  TEXT UNIQUE,  -- expiring one-time signed token for direct download
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_session_photos_session ON session_photos(session_id);
CREATE INDEX IF NOT EXISTS idx_session_photos_token  ON session_photos(download_token);

-- 2. Photostrip composition record
CREATE TABLE IF NOT EXISTS session_photostrips (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL UNIQUE REFERENCES photobooth_sessions(id),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','composed','failed')),
  background      TEXT NOT NULL DEFAULT 'white'
                  CHECK (background IN ('white','black','pink','yellow','mint','lavender')),
  storage_path    TEXT,
  file_size_bytes INTEGER,
  download_token  TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_session_photostrips_session ON session_photostrips(session_id);

-- 3. Track migration
INSERT INTO operator_schema_migrations(name) VALUES('04-camera-and-photos')
ON CONFLICT(name) DO NOTHING;
