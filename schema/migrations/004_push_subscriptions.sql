-- NetMap VN — Migration 004: Web Push subscriptions
-- Lưu push subscriptions cho user verified phone, optional location để filter theo khu vực.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   UUID REFERENCES devices(id) ON DELETE SET NULL,

  -- Web Push fields (RFC 8030)
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,            -- base64 public key
  auth_secret TEXT NOT NULL,            -- base64 auth secret

  -- Optional: filter alerts to user's typical area
  -- (set when user opts in from a specific page; client may update over time)
  latitude    DOUBLE PRECISION,
  longitude   DOUBLE PRECISION,
  radius_m    INTEGER NOT NULL DEFAULT 10000,

  carriers    TEXT[],                   -- empty/null = all carriers; e.g. ['Viettel','VNPT'] for filtering

  failure_count INTEGER NOT NULL DEFAULT 0,
  last_failure  TIMESTAMPTZ,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_push_geo ON push_subscriptions(latitude, longitude);
