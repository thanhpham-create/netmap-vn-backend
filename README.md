# NetMap VN — Backend

5G Coverage Map & Outage Detection for Vietnam.

## Tech Stack
- Node.js 20+ + TypeScript
- Fastify (HTTP framework)
- PostgreSQL (database)
- JWT auth + Zod validation

## API Endpoints

### Auth
- `POST /api/v1/auth/otp/request` — Request OTP
- `POST /api/v1/auth/otp/verify` — Verify OTP, get JWT
- `GET /api/v1/auth/me` — Current user (auth required)
- `PATCH /api/v1/auth/me` — Update displayName (user JWT)
- `GET /api/v1/auth/me/activity?limit=20` — Recent speed tests + outages (user JWT)

### Devices
- `POST /api/v1/devices/register` — Register device, returns `{ device, deviceToken }`. Optional: send `Authorization: Bearer <user_jwt>` to link device to a user.
- `GET /api/v1/devices/:uid` — Get device info

### Speed Tests
- `POST /api/v1/speed-tests` — Submit speed test (auth required: device or user JWT). `deviceId` taken from token, NOT from body.
- `GET /api/v1/speed-tests/recent?lat=&lng=&radius=&carrier=` — Recent tests

### Coverage
- `GET /api/v1/coverage?lat=&lng=&radius=&carrier=&network=&days=` — Aggregated coverage
- `GET /api/v1/coverage/heatmap?minLat=&maxLat=&minLng=&maxLng=` — Heatmap data
- `GET /api/v1/coverage/buildings?name=` — Building-level coverage

### Outages
- `POST /api/v1/outages/report` — Report outage (auth required: device or user JWT)
- `GET /api/v1/outages/active?lat=&lng=&radius=&hours=` — Active outages near location
- `GET /api/v1/outages/national` — Nationwide outage status
- `POST /api/v1/outages/:id/resolve` — Mark cluster resolved (operator/admin user JWT only)

### Leaderboard
- `GET /api/v1/leaderboard/speed-tests?period=week|month|all&limit=10` — Top speed test contributors
- `GET /api/v1/leaderboard/outages?period=…` — Top outage reporters
- `GET /api/v1/leaderboard/contributors?period=…` — Combined score (1pt/test, 3pt/outage, +2pt/verified)
- `GET /api/v1/leaderboard/me?period=…` — Current user's rank (user JWT required)

Privacy: only users who have verified their phone (via OTP) appear. Anonymous devices are excluded.

### Measurement (for client-side speed test)
- `GET /api/v1/measure/ping` — Latency probe
- `GET /api/v1/measure/download/:sizeMb` — Returns N MB random bytes (max 50)
- `POST /api/v1/measure/upload` — Accepts blob (max 25 MB), returns received size + elapsed

### Admin (operator/admin only, user JWT required)
- `GET /api/v1/admin/stats` — Overview: totals, carrier breakdown, outage stats, top problematic provinces
- `GET /api/v1/admin/recent-outages?limit=30&verified=true` — Active outage clusters
- `GET /api/v1/admin/users?limit=50` — User list (admin only, not operator)

### Carriers (public)
- `GET /api/v1/carriers/compare?province=&days=30&network=` — Compare carriers: avg/median speeds, latency, 5G %, outage count, reliability score
- `GET /api/v1/carriers/provinces` — List provinces with data (cho dropdown)

### Push notifications (user JWT for subscribe/unsubscribe)
- `GET /api/v1/push/vapid-public-key` — Public VAPID key (cho client subscribe)
- `POST /api/v1/push/subscribe` — Lưu subscription (endpoint + keys + optional location filter)
- `DELETE /api/v1/push/subscribe` — Xoá theo endpoint
- `GET /api/v1/push/me` — List subscriptions của user

Trigger tự động: khi outage cluster verified (≥5 reports), `broadcastOutageAlert()` gửi push tới subscribers trong bbox + cùng carrier filter.

### Badges (gamification)
- `GET /api/v1/badges` — All badge definitions (public)
- `GET /api/v1/badges/me` — Earned + progress của current user
- `GET /api/v1/badges/:userId` — Public profile (chỉ trả earned)

14 badges chia theo category: tests (4), outages (5), coverage (3), speed (2). Tính dynamic từ stats — không cần migration để thêm/sửa badge.

### Open Data API (public, rate-limited)
- `GET /api/v1/data` — Index + rate limit policy
- `GET /api/v1/data/speed-tests?from=&to=&province=&carrier=&network=&format=json|csv&limit=1000&offset=0`
- `GET /api/v1/data/outages?from=&to=&province=&carrier=&verifiedOnly=&format=&limit=&offset=`
- `GET /api/v1/data/carriers-stats?days=30&format=json|csv` — daily aggregates per carrier

License: CC-BY-4.0. Max 5000 rows/request. PII không expose (no phone, no device IDs, no user IDs).

**Rate limits** (per-user khi authenticated):
| Tier | Limit |
|---|---|
| Anonymous (per IP) | 60 req/min |
| Device token | 200 req/min |
| User (consumer) | 300 req/min |
| User (admin/operator) | 1000 req/min |

Response trả `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After` headers.

Ví dụ:
```bash
# Speed tests last week, Đà Nẵng, CSV
curl "https://api.netmap.vn/api/v1/data/speed-tests?province=Đà%20Nẵng&from=2026-04-22&format=csv" \
  -o speed-tests-danang.csv

# Daily carrier stats 30 days, JSON
curl "https://api.netmap.vn/api/v1/data/carriers-stats?days=30"
```

## Auth Model

Two token types, both signed with `JWT_SECRET`:

- **User JWT** — issued via `POST /auth/otp/verify`. Payload `{ type: 'user', userId, phone, role }`. 30-day TTL. Used for `/me`, `/outages/:id/resolve`.
- **Device JWT** — issued via `POST /devices/register`. Payload `{ type: 'device', deviceId, deviceUid }`. 90-day TTL. Used for POST mutations (`/speed-tests`, `/outages/report`).

`/speed-tests` and `/outages/report` accept either. With a user JWT, the most recently active device of that user is used.

## Setup

```bash
# Install deps
yarn install

# Set DATABASE_URL
export DATABASE_URL="postgresql://user:pass@host:port/db"

# First-time setup (dev): drops tables + applies all migrations
yarn db:setup

# (Optional) Seed demo data: ~10 users, ~30 devices, ~1000 tests, ~50 outages
yarn db:seed

# Production / subsequent deploys: ONLY apply pending migrations (safe, idempotent)
yarn db:migrate

# Dev mode
yarn dev

# Production build
yarn build && yarn start
```

## Migrations

Schema is managed via versioned SQL files in `schema/migrations/`. Tracked by `_migrations` table.

- `yarn db:migrate` — apply pending migrations. **Production-safe**, idempotent.
- `yarn db:reset` — DROP all tables. Refuses `NODE_ENV=production` unless `--force`.
- `yarn db:setup` — reset + migrate (clean dev start).

Add new migration: drop a file `schema/migrations/00X_descriptive_name.sql` (numbered, alphabetical order matters). Use `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` to keep it idempotent. Each file runs in a transaction.

## Environment Variables

- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — JWT signing secret (change in production!)
- `PORT` — HTTP port (default 8080)
- `LOG_LEVEL` — Logging verbosity (default 'info')
# netmap-vn-backend
