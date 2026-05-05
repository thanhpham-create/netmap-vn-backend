# NetMap VN — Integration Tests

Test suite dùng **Node native `node:test`** (không cần Jest/Vitest, không thêm dependency).

## Yêu cầu

- Node.js ≥ 20
- PostgreSQL chạy local
- `DATABASE_URL` trỏ tới một DB **test** (sẽ bị `DROP TABLE` trong quá trình init).

## Chạy

```bash
# 1. Set up DB test riêng (tránh chạy trên DB prod!)
export DATABASE_URL="postgresql://localhost:5432/netmap_test"
export JWT_SECRET="test-secret"
export NODE_ENV=test

# 2. Reset + migrate schema
yarn db:setup

# 3. Run tests
yarn test
```

Thêm script vào `package.json`:

```json
"test": "node --import tsx --test tests/**/*.test.ts"
```

## Cấu trúc

- `helpers.ts` — boot test server, cleanup helpers
- `auth.test.ts` — OTP request, verify, /me, rate limit
- `devices.test.ts` — register, get
- `speed-tests.test.ts` — submit + recent
- `coverage.test.ts` — aggregated, heatmap, buildings
- `outages.test.ts` — report, cluster verification, resolve

Mỗi test file tự `truncate` các bảng liên quan trước khi chạy nên có thể chạy song song nếu xài DB riêng. Khi chạy chung 1 DB, dùng `--test-concurrency=1`.
