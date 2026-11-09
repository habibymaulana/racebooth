-- Photobooth Management System — schema for WF-01 Token Management
-- Database: photobooth_db (PostgreSQL 16+)
-- Safe for the initially empty project database. No DROP/TRUNCATE/DELETE statements.
-- This schema matches the two PostgreSQL queries in the imported WF-01 workflow.

BEGIN;

CREATE TABLE IF NOT EXISTS app_users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name      TEXT NOT NULL,
    email          TEXT UNIQUE,
    password_hash  TEXT,
    role           TEXT NOT NULL CHECK (role IN ('operator', 'supervisor')),
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS photo_packages (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                     TEXT NOT NULL,
    price_idr                BIGINT NOT NULL CHECK (price_idr >= 0),
    photo_limit              INTEGER NOT NULL CHECK (photo_limit > 0),
    session_duration_minutes INTEGER NOT NULL CHECK (session_duration_minutes > 0),
    is_active                BOOLEAN NOT NULL DEFAULT TRUE,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    package_id      UUID NOT NULL REFERENCES photo_packages(id),
    operator_id     UUID NOT NULL REFERENCES app_users(id),
    amount_idr      BIGINT NOT NULL CHECK (amount_idr >= 0),
    payment_method  TEXT NOT NULL CHECK (payment_method IN ('cash', 'transfer', 'qris', 'card')),
    payment_status  TEXT NOT NULL DEFAULT 'pending'
                    CHECK (payment_status IN ('pending', 'paid', 'failed', 'cancelled', 'refunded')),
    paid_at         TIMESTAMPTZ,
    cancelled_at    TIMESTAMPTZ,
    refunded_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS photobooth_sessions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id     UUID NOT NULL UNIQUE REFERENCES payment_transactions(id),
    operator_id        UUID NOT NULL REFERENCES app_users(id),
    package_id         UUID NOT NULL REFERENCES photo_packages(id),
    idempotency_key    TEXT NOT NULL UNIQUE CHECK (LENGTH(idempotency_key) BETWEEN 16 AND 128),
    access_token_hash  TEXT NOT NULL UNIQUE CHECK (LENGTH(access_token_hash) = 64),
    photo_limit        INTEGER NOT NULL CHECK (photo_limit > 0),
    photos_taken       INTEGER NOT NULL DEFAULT 0 CHECK (photos_taken >= 0 AND photos_taken <= photo_limit),
    status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'active', 'completed', 'expired', 'cancelled')),
    token_expires_at   TIMESTAMPTZ NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_created_at
    ON payment_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_photobooth_sessions_expires_at
    ON photobooth_sessions(token_expires_at);

COMMIT;
