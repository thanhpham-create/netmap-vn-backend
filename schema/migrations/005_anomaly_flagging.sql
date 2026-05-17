-- Migration 005: Anomaly detection columns for speed_tests + outage_reports.
-- - is_flagged: server-side detected as suspicious (fake/spam/impossible)
-- - flag_reasons: array of textual codes (e.g. ['speed_too_high', 'duplicate_burst'])
-- Public queries (heatmap, leaderboard, compare) filter out is_flagged=true.

ALTER TABLE speed_tests
  ADD COLUMN IF NOT EXISTS is_flagged   BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS flag_reasons TEXT[]      NOT NULL DEFAULT '{}';

ALTER TABLE outage_reports
  ADD COLUMN IF NOT EXISTS is_flagged   BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS flag_reasons TEXT[]      NOT NULL DEFAULT '{}';

-- Partial index: only index unflagged rows because public queries always filter to those.
-- Speeds up the WHERE NOT is_flagged path without bloating the index.
CREATE INDEX IF NOT EXISTS idx_speed_tests_unflagged
  ON speed_tests(recorded_at DESC)
  WHERE NOT is_flagged;

CREATE INDEX IF NOT EXISTS idx_outage_reports_unflagged
  ON outage_reports(reported_at DESC)
  WHERE NOT is_flagged;
