-- NetMap VN — DESTRUCTIVE reset script
-- Drops all NetMap tables + functions + the _migrations tracking table.
-- ⚠️  Only run via `yarn db:reset` (which refuses NODE_ENV=production unless --force).

DROP TABLE IF EXISTS outage_reports CASCADE;
DROP TABLE IF EXISTS signal_samples CASCADE;
DROP TABLE IF EXISTS speed_tests CASCADE;
DROP TABLE IF EXISTS devices CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS _migrations CASCADE;
DROP FUNCTION IF EXISTS coverage_grid CASCADE;
DROP FUNCTION IF EXISTS active_outages CASCADE;
