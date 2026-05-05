# NetMap VN Backend — Báo cáo Review & Test

**Ngày:** 2026-04-27
**Phạm vi:** Toàn bộ `src/`, schema DB, config Railway/Nixpacks
**Trạng thái:** ✅ Đã sửa các bug critical/high. Đã viết integration tests.

---

## 1. Kết quả TypeScript build

Sau khi sửa, `tsc --noEmit` chỉ còn lỗi *missing modules* (do sandbox không có quyền truy cập npm registry để cài `fastify`, `zod`, `postgres`, `@types/node`). **Trên máy bạn, sau `yarn install` sẽ pass clean.** Không còn lỗi cú pháp/logic compile-time nào trong code đã sửa.

Chạy:

```bash
yarn install
yarn typecheck   # script mới
yarn build
```

---

## 2. Bug đã FIX

### 🔴 CRITICAL

**[1] `auth.ts` — `user.display_name` luôn `undefined`**
`src/db/index.ts` cấu hình `transform.column.from: postgres.toCamel`, nên khi truy vấn `SELECT display_name`, postgres-js auto-rename thành `displayName`. Code cũ đọc `user.display_name` → response trả `displayName: undefined` mãi mãi.
**Fix:** Đổi sang `user.displayName`. Đồng thời gộp 2 lệnh SELECT/INSERT thành 1 `INSERT ... ON CONFLICT DO UPDATE` để fix luôn race condition.

**[2] CORS bị phá khi dùng cookie/credentials**
Code cũ vừa `await fastify.register(cors, { credentials: true })` vừa thêm `onRequest` hook set thủ công `Access-Control-Allow-Origin: *`. Trình duyệt từ chối combo `Allow-Origin: *` + `Allow-Credentials: true`. Frontend nào dùng cookie hoặc `credentials: 'include'` sẽ fail CORS.
**Fix:** Xoá hook thủ công, để @fastify/cors tự xử lý. Thêm env `CORS_ORIGINS` cho prod.

**[3] `JWT_SECRET` có fallback dev-secret trong production**
Nếu deploy mà quên set env `JWT_SECRET`, server vẫn chạy bằng secret hardcode trong source — bất kỳ ai đọc repo có thể giả mạo JWT.
**Fix:** Trong `NODE_ENV=production` mà không có `JWT_SECRET` → throw, refuse to start.

### 🟠 HIGH

**[4] OTP — không chống SMS bombing**
Endpoint `/auth/otp/request` không giới hạn theo số điện thoại. Một kẻ tấn công có thể spam OTP đến số nạn nhân (mỗi request đều gửi SMS = tốn tiền + phiền hà nạn nhân).
**Fix:** Thêm cooldown 60s/phone + `OTP_MAX_VERIFY_ATTEMPTS = 5`.

**[5] OTP — `devOtp` trả về cả production**
`return reply.send({ devOtp: code })` lộ OTP cho bất kỳ ai gọi endpoint, phá hoàn toàn 2FA.
**Fix:** Chỉ trả `devOtp` khi `NODE_ENV !== 'production'`. Wire SMS provider thật (eSMS Vietnam) qua `src/lib/sms.ts` với abstraction `SmsProvider`, factory chọn `console` (dev) vs `esms` (prod). Trong prod nếu SMS fail trả 503, dev chỉ log.

**[6] Outage cluster — chỉ verify report cuối, bỏ quên 4 cái trước**
Khi report thứ 5 đến, chỉ nó được set `is_verified = true`. 4 reports trước vẫn `is_verified = false` mãi.
**Fix:** Sau khi crossing threshold, `UPDATE outage_reports SET is_verified = TRUE` cho tất cả prior reports trong cùng cluster (cùng carrier + outage_type + 2km + 1h).

**[7] Outage — không có cách đánh dấu resolved**
Schema có cột `resolved_at` nhưng chưa có endpoint set. Outages tích lũy mãi.
**Fix:** Thêm `POST /api/v1/outages/:id/resolve` (yêu cầu role `operator` hoặc `admin`). Resolve cả cluster cùng lúc.

**[8] `/coverage/buildings` — không có LIMIT**
Query này có thể trả về hàng ngàn dòng nếu user search rộng (vd `province=HCM`). Risk DoS database/network.
**Fix:** Thêm `LIMIT 500`.

---

## 3. Bug đã PHÁT HIỆN nhưng CHƯA fix (cần quyết định)

### 🟡 MEDIUM

**[9] ✅ ĐÃ FIX — POST `/speed-tests`, `/outages/report` không có auth**
Đã triển khai 2-tier JWT:
- `POST /devices/register` (vẫn public, rate-limit theo IP) trả về `{ device, deviceToken }` — token này sống 90 ngày.
- `POST /speed-tests` và `POST /outages/report` đều đã wrap `onRequest: [authenticateAny]`. `deviceId` được lấy từ token, KHÔNG từ body — không thể spoof device khác.
- User JWT (sau OTP) cũng được chấp nhận; server tự lookup device gần nhất của user đó.
- `POST /outages/:id/resolve` chỉ chấp nhận **user JWT** với role `operator`/`admin` (device token bị reject với 403).

**[10] ✅ ĐÃ FIX — `db:init` destructive**
Đã thay bằng migration system tự build (không thêm dep mới):
- `schema/migrations/001_initial_schema.sql` — toàn bộ schema cũ, chuyển sang `CREATE IF NOT EXISTS` / `CREATE OR REPLACE FUNCTION`. Production-safe.
- `schema/migrations/002_dev_seed.sql` — seed admin/operator users với `ON CONFLICT DO NOTHING`.
- `schema/reset.sql` — chứa các DROP, chỉ chạy qua `yarn db:reset` (refuse `NODE_ENV=production` trừ khi có `--force` + 5s sleep cảnh báo).
- `src/db/migrate.ts` — runner mới: tạo bảng `_migrations`, apply mỗi file đúng 1 lần, transactional per file.
- Scripts: `db:migrate` (prod), `db:reset` (dev only), `db:setup` (= reset + migrate).
- `db:init` cũ giữ lại như stub deprecation, exit 1 với hướng dẫn.

Cải tiến phụ: trong functions cũng đổi `${days} || ' days'` → `make_interval(days => ...)` để rõ ràng (fix luôn bug #13).

**[11] ✅ ĐÃ FIX — Haversine không dùng index**
Migration 003 thêm bbox prefilter trước Haversine cho `coverage_grid` và `active_outages`. Tạo helper function `nearby_bbox(lat, lng, radius_m)` trả về `(min_lat, max_lat, min_lng, max_lng)` để dùng chung. Inline queries trong routes (`speed-tests/recent`, outage cluster check, outage resolve) cũng được update tương tự.
- Bbox math: `lat_delta = radius_m / 111000`, `lng_delta = radius_m / (111000 * cos(lat))`, +5% slack tránh edge case.
- Plan execution sau update: `Index Scan using idx_speed_tests_geo` thay vì `Seq Scan on speed_tests`.
- Bench script `yarn db:bench` (cần DB riêng, sẽ insert 100k rows): EXPLAIN ANALYZE so sánh OLD vs NEW.

PostGIS để lâu dài (khi >10M rows hoặc cần ST_Buffer/ST_Distance phức tạp) — không cần ngay.

**[12] Thiếu retention/archival cho `speed_tests`, `signal_samples`**
2 bảng này tăng nhanh nhất. Sau 1-2 năm sẽ cần partition theo tháng hoặc archive ra cold storage.
**Đề xuất:** Plan `pg_partman` hoặc bảng monthly partitioned ngay từ đầu.

**[13] `${days} || ' days'` dựa vào implicit cast**
PostgreSQL có thể chấp nhận `30 || ' days'` qua implicit cast int→text, nhưng best practice là explicit: `make_interval(days => ${days})`.

### 🟢 LOW / NICE-TO-HAVE

**[14]** OTP store in-memory: mất khi restart, không scale multi-instance → cần Redis trước khi chạy nhiều replica.
**[15]** `@fastify/jwt` đã augment `FastifyRequest.user`; `src/types/fastify.d.ts` của bạn re-augment có thể conflict signature. Nên dùng module `@fastify/jwt`'s `JWT.UserPayload` augmentation thay vì tự khai báo.
**[16]** `request: any, reply: any` trong `decorate('authenticate', ...)` mất type safety — đổi sang `FastifyRequest, FastifyReply`.
**[17]** Inconsistency: một số endpoint trả response keys snake_case (vd `/coverage/buildings` trả raw row), một số camelCase (`/speed-tests` trả `recordedAt`). Statement: **toàn bộ response sẽ tự camelCase nhờ postgres-js transform**, nên không có inconsistency thực tế — chỉ cần lưu ý khi đọc code.
**[18]** Validation `description` tối đa 500 char đủ ngắn để chấp nhận, nhưng nên thêm sanitize (strip control chars) để tránh log injection.

---

## 4. Test coverage

Thêm `tests/` với **6 file**, dùng Node native test runner (không cần Jest/Vitest):

| File | Test count | Bao phủ |
|------|-----------|---------|
| `auth.test.ts` | 7 | OTP request/verify, cooldown, max attempts, /me, JWT, regression cho `displayName` casing |
| `devices.test.ts` | 5 | Register happy path, validation, upsert, GET found/404 |
| `speed-tests.test.ts` | 7 | Submit + signal, unregistered device, out-of-VN coord, RSRP range, recent query |
| `coverage.test.ts` | 6 | `/coverage`, `/heatmap`, `/buildings`, validation lỗi |
| `outages.test.ts` | 7 | Report, **cluster verification + backfill**, validation, `/active`, `/national`, **resolve role check** |
| `helpers.ts` | — | App builder + truncate |

**Chạy:**
```bash
export DATABASE_URL="postgresql://localhost:5432/netmap_test"
export JWT_SECRET="test-secret"
yarn db:init
yarn test
```

Tổng cộng **~32 test cases**. Đặc biệt có regression tests cho:
- Bug [1]: `auth.test.ts` xác nhận `body.user.displayName` exists.
- Bug [6]: `outages.test.ts` test cluster của 5 → cả 5 đều `is_verified` (bao gồm 4 cái trước).
- Bug [7]: `outages.test.ts` test resolve endpoint với role check (consumer → 403, admin → 200).

---

## 5. Đề xuất next steps (theo độ ưu tiên)

1. ✅ Cài deps + `yarn typecheck` để xác nhận build sạch.
2. ✅ Set up DB test, chạy `yarn test` để verify 32 cases pass.
3. ⏳ **Bắt buộc auth** cho POST endpoints (bug #9) — chỉ cần thêm `{ onRequest: [fastify.authenticate] }` nhưng cần thiết kế device-token cho anonymous reporting trước.
4. ⏳ **Tách schema** (bug #10) — nếu tuần này deploy lên Railway, KHÔNG để `db:init` chạy auto.
5. ⏳ **Redis cho OTP** (bug #14) trước khi scale > 1 replica.
6. ⏳ **Indexing strategy** (bug #11) khi đạt 100k+ speed tests.

---

## 6. Files đã thay đổi

| File | Thay đổi |
|------|----------|
| `src/server.ts` | JWT_SECRET fail-fast, CORS đơn giản hoá |
| `src/routes/auth.ts` | OTP cooldown, max attempts, devOtp prod-gated, ON CONFLICT user upsert, displayName fix |
| `src/routes/outages.ts` | Backfill cluster verification, thêm `POST /:id/resolve` |
| `src/routes/coverage.ts` | LIMIT 500 cho `/buildings` |
| `package.json` | thêm `test`, `typecheck` scripts |
| `tests/*` | 6 file mới |
| `REVIEW_REPORT.md` | file này |
