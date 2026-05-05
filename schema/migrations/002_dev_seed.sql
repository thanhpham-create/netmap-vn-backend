-- NetMap VN — Migration 002: Dev seed data
-- Idempotent: ON CONFLICT DO NOTHING. Safe to run on prod (won't create duplicates).
-- Only inserts admin/operator users for testing — no production secrets.

INSERT INTO users (phone, display_name, role) VALUES
  ('0941000075', 'Test Admin',          'admin'),
  ('0961234567', 'Test Operator (VNPT)', 'operator')
ON CONFLICT (phone) DO NOTHING;
