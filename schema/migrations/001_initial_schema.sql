-- NetMap VN — Migration 001: Initial schema
-- Idempotent: safe to re-run. Uses CREATE IF NOT EXISTS / CREATE OR REPLACE.
-- DOES NOT drop existing data.

-- ============================================================
-- USERS — Anonymous device-based, optional phone verification
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         TEXT UNIQUE,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'consumer' CHECK (role IN ('consumer','operator','admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- DEVICES — Each install gets device_id, no PII required
-- ============================================================
CREATE TABLE IF NOT EXISTS devices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  device_uid      TEXT UNIQUE NOT NULL,
  platform        TEXT NOT NULL CHECK (platform IN ('ios','android','web')),
  os_version      TEXT,
  app_version     TEXT,
  device_model    TEXT,
  carrier_name    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_carrier ON devices(carrier_name);

-- ============================================================
-- SPEED_TESTS — Manual + passive speed measurements
-- ============================================================
CREATE TABLE IF NOT EXISTS speed_tests (
  id              BIGSERIAL PRIMARY KEY,
  device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  carrier_name    TEXT NOT NULL,
  network_type    TEXT NOT NULL,
  is_roaming      BOOLEAN DEFAULT FALSE,
  download_mbps   NUMERIC(8,2) NOT NULL,
  upload_mbps     NUMERIC(8,2) NOT NULL,
  latency_ms      INTEGER NOT NULL,
  jitter_ms       INTEGER,
  packet_loss_pct NUMERIC(5,2),
  latitude        DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN 8 AND 24),
  longitude       DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN 102 AND 110),
  altitude_m      INTEGER,
  location_accuracy_m INTEGER,
  province        TEXT,
  district        TEXT,
  ward            TEXT,
  building_name   TEXT,
  test_duration_ms INTEGER,
  test_server      TEXT,
  test_type        TEXT NOT NULL DEFAULT 'manual' CHECK (test_type IN ('manual','passive','scheduled')),
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  client_time     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_speed_tests_carrier ON speed_tests(carrier_name);
CREATE INDEX IF NOT EXISTS idx_speed_tests_recorded ON speed_tests(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_speed_tests_geo ON speed_tests(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_speed_tests_device ON speed_tests(device_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_speed_tests_province ON speed_tests(province);

-- ============================================================
-- SIGNAL_SAMPLES — Native sensor data (RSRP, RSRQ, SINR, Cell ID)
-- ============================================================
CREATE TABLE IF NOT EXISTS signal_samples (
  id              BIGSERIAL PRIMARY KEY,
  device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  speed_test_id   BIGINT REFERENCES speed_tests(id) ON DELETE SET NULL,
  carrier_name    TEXT NOT NULL,
  network_type    TEXT NOT NULL,
  band            TEXT,
  rsrp_dbm        INTEGER,
  rsrq_db         NUMERIC(5,2),
  sinr_db         NUMERIC(5,2),
  rssi_dbm        INTEGER,
  cqi             INTEGER,
  cell_id         BIGINT,
  pci             INTEGER,
  tac             INTEGER,
  mcc             INTEGER,
  mnc             INTEGER,
  latitude        DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN 8 AND 24),
  longitude       DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN 102 AND 110),
  altitude_m      INTEGER,
  location_accuracy_m INTEGER,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signal_carrier ON signal_samples(carrier_name);
CREATE INDEX IF NOT EXISTS idx_signal_recorded ON signal_samples(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_geo ON signal_samples(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_signal_cell ON signal_samples(cell_id);

-- ============================================================
-- OUTAGE_REPORTS — Crowdsourced outage detection
-- ============================================================
CREATE TABLE IF NOT EXISTS outage_reports (
  id              BIGSERIAL PRIMARY KEY,
  device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  carrier_name    TEXT NOT NULL,
  outage_type     TEXT NOT NULL CHECK (outage_type IN ('no_signal','slow','no_data','no_call','no_sms','intermittent')),
  description     TEXT,
  latitude        DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN 8 AND 24),
  longitude       DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN 102 AND 110),
  province        TEXT,
  district        TEXT,
  ward            TEXT,
  is_verified     BOOLEAN DEFAULT FALSE,
  cluster_size    INTEGER DEFAULT 1,
  resolved_at     TIMESTAMPTZ,
  reported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outage_carrier ON outage_reports(carrier_name);
CREATE INDEX IF NOT EXISTS idx_outage_reported ON outage_reports(reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_outage_geo ON outage_reports(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_outage_province ON outage_reports(province);

-- ============================================================
-- FUNCTIONS — Coverage grid aggregation (Haversine-based hex bins)
-- These use CREATE OR REPLACE so they update cleanly on re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION coverage_grid(
  p_lat        DOUBLE PRECISION,
  p_lng        DOUBLE PRECISION,
  p_radius_m   INTEGER DEFAULT 1000,
  p_carrier    TEXT DEFAULT NULL,
  p_network    TEXT DEFAULT NULL,
  p_days       INTEGER DEFAULT 30
)
RETURNS TABLE (
  carrier_name      TEXT,
  network_type      TEXT,
  sample_count      INTEGER,
  avg_download_mbps NUMERIC,
  avg_upload_mbps   NUMERIC,
  avg_latency_ms    NUMERIC,
  avg_rsrp_dbm      NUMERIC,
  avg_sinr_db       NUMERIC,
  coverage_quality  TEXT
)
LANGUAGE sql STABLE AS $$
  WITH nearby AS (
    SELECT
      st.carrier_name,
      st.network_type,
      st.download_mbps,
      st.upload_mbps,
      st.latency_ms,
      ss.rsrp_dbm,
      ss.sinr_db
    FROM speed_tests st
    LEFT JOIN signal_samples ss ON ss.speed_test_id = st.id
    WHERE
      st.recorded_at > NOW() - make_interval(days => p_days)
      AND (p_carrier IS NULL OR st.carrier_name = p_carrier)
      AND (p_network IS NULL OR st.network_type = p_network)
      AND 6371000 * 2 * ASIN(SQRT(
        POWER(SIN((RADIANS(st.latitude) - RADIANS(p_lat)) / 2), 2) +
        COS(RADIANS(p_lat)) * COS(RADIANS(st.latitude)) *
        POWER(SIN((RADIANS(st.longitude) - RADIANS(p_lng)) / 2), 2)
      )) <= p_radius_m
  )
  SELECT
    n.carrier_name,
    n.network_type,
    COUNT(*)::int AS sample_count,
    ROUND(AVG(n.download_mbps)::numeric, 2) AS avg_download_mbps,
    ROUND(AVG(n.upload_mbps)::numeric, 2) AS avg_upload_mbps,
    ROUND(AVG(n.latency_ms)::numeric, 0) AS avg_latency_ms,
    ROUND(AVG(n.rsrp_dbm)::numeric, 0) AS avg_rsrp_dbm,
    ROUND(AVG(n.sinr_db)::numeric, 1) AS avg_sinr_db,
    CASE
      WHEN AVG(n.download_mbps) >= 100 THEN 'excellent'
      WHEN AVG(n.download_mbps) >= 50  THEN 'good'
      WHEN AVG(n.download_mbps) >= 20  THEN 'fair'
      WHEN AVG(n.download_mbps) >= 5   THEN 'poor'
      ELSE 'very_poor'
    END AS coverage_quality
  FROM nearby n
  GROUP BY n.carrier_name, n.network_type
  ORDER BY avg_download_mbps DESC NULLS LAST;
$$;

CREATE OR REPLACE FUNCTION active_outages(
  p_lat        DOUBLE PRECISION,
  p_lng        DOUBLE PRECISION,
  p_radius_m   INTEGER DEFAULT 5000,
  p_hours      INTEGER DEFAULT 6
)
RETURNS TABLE (
  carrier_name    TEXT,
  outage_type     TEXT,
  report_count    INTEGER,
  first_reported  TIMESTAMPTZ,
  last_reported   TIMESTAMPTZ,
  affected_areas  TEXT[]
)
LANGUAGE sql STABLE AS $$
  SELECT
    o.carrier_name,
    o.outage_type,
    COUNT(*)::int AS report_count,
    MIN(o.reported_at) AS first_reported,
    MAX(o.reported_at) AS last_reported,
    ARRAY_AGG(DISTINCT o.ward ORDER BY o.ward) FILTER (WHERE o.ward IS NOT NULL) AS affected_areas
  FROM outage_reports o
  WHERE
    o.reported_at > NOW() - make_interval(hours => p_hours)
    AND o.resolved_at IS NULL
    AND 6371000 * 2 * ASIN(SQRT(
      POWER(SIN((RADIANS(o.latitude) - RADIANS(p_lat)) / 2), 2) +
      COS(RADIANS(p_lat)) * COS(RADIANS(o.latitude)) *
      POWER(SIN((RADIANS(o.longitude) - RADIANS(p_lng)) / 2), 2)
    )) <= p_radius_m
  GROUP BY o.carrier_name, o.outage_type
  HAVING COUNT(*) >= 3
  ORDER BY report_count DESC;
$$;
