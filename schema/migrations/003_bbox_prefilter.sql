-- NetMap VN — Migration 003: Add bbox prefilter to geo functions
-- Performance: Haversine alone scans every row. Adding a coarse bbox first lets
-- PostgreSQL use idx_speed_tests_geo / idx_outage_geo to narrow down candidates
-- before computing Haversine on the small subset. Big win on large tables.
--
-- Bbox math:
--   1° latitude  ≈ 111 km          → lat_delta_deg = radius_m / 111000
--   1° longitude ≈ 111 km × cos(lat) → lng_delta_deg = radius_m / (111000 × cos(lat))
-- We add 5% slack to avoid false negatives from floating-point + earth ellipsoid imprecision.

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
  WITH bbox AS (
    SELECT
      (p_radius_m::float / 111000.0) * 1.05 AS lat_delta,
      (p_radius_m::float / (111000.0 * GREATEST(COS(RADIANS(p_lat)), 0.01))) * 1.05 AS lng_delta
  ),
  nearby AS (
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
    CROSS JOIN bbox
    WHERE
      st.recorded_at > NOW() - make_interval(days => p_days)
      AND (p_carrier IS NULL OR st.carrier_name = p_carrier)
      AND (p_network IS NULL OR st.network_type = p_network)
      -- Bbox prefilter (uses idx_speed_tests_geo)
      AND st.latitude  BETWEEN p_lat - bbox.lat_delta AND p_lat + bbox.lat_delta
      AND st.longitude BETWEEN p_lng - bbox.lng_delta AND p_lng + bbox.lng_delta
      -- Exact Haversine
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
  WITH bbox AS (
    SELECT
      (p_radius_m::float / 111000.0) * 1.05 AS lat_delta,
      (p_radius_m::float / (111000.0 * GREATEST(COS(RADIANS(p_lat)), 0.01))) * 1.05 AS lng_delta
  )
  SELECT
    o.carrier_name,
    o.outage_type,
    COUNT(*)::int AS report_count,
    MIN(o.reported_at) AS first_reported,
    MAX(o.reported_at) AS last_reported,
    ARRAY_AGG(DISTINCT o.ward ORDER BY o.ward) FILTER (WHERE o.ward IS NOT NULL) AS affected_areas
  FROM outage_reports o
  CROSS JOIN bbox
  WHERE
    o.reported_at > NOW() - make_interval(hours => p_hours)
    AND o.resolved_at IS NULL
    AND o.latitude  BETWEEN p_lat - bbox.lat_delta AND p_lat + bbox.lat_delta
    AND o.longitude BETWEEN p_lng - bbox.lng_delta AND p_lng + bbox.lng_delta
    AND 6371000 * 2 * ASIN(SQRT(
      POWER(SIN((RADIANS(o.latitude) - RADIANS(p_lat)) / 2), 2) +
      COS(RADIANS(p_lat)) * COS(RADIANS(o.latitude)) *
      POWER(SIN((RADIANS(o.longitude) - RADIANS(p_lng)) / 2), 2)
    )) <= p_radius_m
  GROUP BY o.carrier_name, o.outage_type
  HAVING COUNT(*) >= 3
  ORDER BY report_count DESC;
$$;

-- Helper function used by inline route queries (avoid duplicating bbox math).
CREATE OR REPLACE FUNCTION nearby_bbox(
  p_lat       DOUBLE PRECISION,
  p_lng       DOUBLE PRECISION,
  p_radius_m  INTEGER
)
RETURNS TABLE (
  min_lat DOUBLE PRECISION,
  max_lat DOUBLE PRECISION,
  min_lng DOUBLE PRECISION,
  max_lng DOUBLE PRECISION
)
LANGUAGE sql IMMUTABLE AS $$
  WITH d AS (
    SELECT
      (p_radius_m::float / 111000.0) * 1.05 AS lat_delta,
      (p_radius_m::float / (111000.0 * GREATEST(COS(RADIANS(p_lat)), 0.01))) * 1.05 AS lng_delta
  )
  SELECT
    p_lat - d.lat_delta, p_lat + d.lat_delta,
    p_lng - d.lng_delta, p_lng + d.lng_delta
  FROM d;
$$;
