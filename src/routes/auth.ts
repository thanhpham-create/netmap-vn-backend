import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import sql from '../db/index.js';
import { smsProvider } from '../lib/sms.js';

// In-memory OTP store (will be Redis in production)
const otpStore = new Map<string, { code: string; expiresAt: number; attempts: number }>();
// Per-phone request throttle: phone -> last request time
const otpRequestThrottle = new Map<string, number>();
const OTP_REQUEST_COOLDOWN_MS = 60_000; // 1 phút giữa các lần yêu cầu
const OTP_MAX_VERIFY_ATTEMPTS = 5;
const IS_PROD = process.env.NODE_ENV === 'production';

const RequestOtpSchema = z.object({
  phone: z.string().regex(/^0\d{9,10}$/, 'Số điện thoại không hợp lệ'),
});

const VerifyOtpSchema = z.object({
  phone: z.string().regex(/^0\d{9,10}$/),
  code:  z.string().length(6),
});

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export const authRoute: FastifyPluginAsync = async (fastify) => {

  // POST /api/v1/auth/otp/request — Request OTP code
  fastify.post('/api/v1/auth/otp/request', async (request, reply) => {
    const parsed = RequestOtpSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { phone } = parsed.data;

    // Per-phone cooldown to prevent SMS bombing
    const lastReq = otpRequestThrottle.get(phone);
    if (lastReq && Date.now() - lastReq < OTP_REQUEST_COOLDOWN_MS) {
      const waitS = Math.ceil((OTP_REQUEST_COOLDOWN_MS - (Date.now() - lastReq)) / 1000);
      return reply.status(429).send({ error: `Vui lòng chờ ${waitS}s trước khi yêu cầu OTP mới` });
    }
    otpRequestThrottle.set(phone, Date.now());

    const code = generateOtp();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
    otpStore.set(phone, { code, expiresAt, attempts: 0 });

    // Send SMS via configured provider. Failures are logged but don't fail the request —
    // user can retry. In dev (console provider), this just prints to stdout.
    const message = `Mã OTP NetMap VN: ${code}. Hết hạn sau 5 phút. Không chia sẻ với ai.`;
    try {
      await smsProvider().send(phone, message);
    } catch (err) {
      request.log.error({ err, phone }, 'SMS send failed');
      // In production, return 503 so client knows to retry
      if (IS_PROD) {
        return reply.status(503).send({ error: 'Không gửi được SMS. Vui lòng thử lại.' });
      }
    }

    const response: { expiresIn: number; devOtp?: string } = { expiresIn: 300 };
    if (!IS_PROD) response.devOtp = code; // Only expose in non-prod
    return reply.send(response);
  });

  // POST /api/v1/auth/otp/verify — Verify OTP and get JWT
  fastify.post('/api/v1/auth/otp/verify', async (request, reply) => {
    const parsed = VerifyOtpSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { phone, code } = parsed.data;

    const stored = otpStore.get(phone);
    if (!stored || stored.expiresAt < Date.now()) {
      return reply.status(401).send({ error: 'Mã OTP đã hết hạn' });
    }
    stored.attempts += 1;
    if (stored.attempts > OTP_MAX_VERIFY_ATTEMPTS) {
      otpStore.delete(phone);
      return reply.status(429).send({ error: 'Quá số lần thử. Vui lòng yêu cầu mã mới.' });
    }
    if (stored.code !== code) {
      return reply.status(401).send({ error: 'Mã OTP không đúng' });
    }

    otpStore.delete(phone);
    otpRequestThrottle.delete(phone);

    // Find or create user — atomic upsert to avoid race on concurrent verifies
    const [user] = await sql`
      INSERT INTO users (phone, role)
      VALUES (${phone}, 'consumer')
      ON CONFLICT (phone) DO UPDATE SET last_active = NOW()
      RETURNING id, role, display_name
    `;

    const token = fastify.jwt.sign(
      { type: 'user', userId: user.id, phone, role: user.role },
      { expiresIn: '30d' }
    );

    return reply.send({
      token,
      user: {
        id: user.id,
        phone,
        role: user.role,
        displayName: user.displayName, // postgres-js toCamel transform
      },
    });
  });

  // GET /api/v1/auth/me — Get current user
  fastify.get(
    '/api/v1/auth/me',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      // authenticate guarantees type==='user', narrow it
      if (request.user.type !== 'user') {
        return reply.status(403).send({ error: 'User token required' });
      }
      const [user] = await sql`
        SELECT id, phone, role, display_name, created_at
        FROM users WHERE id = ${request.user.userId}
      `;
      if (!user) return reply.status(404).send({ error: 'User not found' });
      return reply.send({ user });
    }
  );

  // PATCH /api/v1/auth/me — Update profile (displayName)
  const UpdateMeSchema = z.object({
    displayName: z.string().min(1).max(80).nullable().optional(),
  });
  fastify.patch(
    '/api/v1/auth/me',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      if (request.user.type !== 'user') {
        return reply.status(403).send({ error: 'User token required' });
      }
      const parsed = UpdateMeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const { displayName } = parsed.data;
      const [user] = await sql`
        UPDATE users
        SET display_name = ${displayName ?? null}, last_active = NOW()
        WHERE id = ${request.user.userId}
        RETURNING id, phone, role, display_name, created_at
      `;
      return reply.send({ user });
    }
  );

  // GET /api/v1/auth/me/activity — Recent speed tests + outages by current user
  fastify.get<{ Querystring: { limit?: string } }>(
    '/api/v1/auth/me/activity',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      if (request.user.type !== 'user') {
        return reply.status(403).send({ error: 'User token required' });
      }
      const limit = Math.min(parseInt(request.query.limit || '10'), 50);

      const tests = await sql`
        SELECT st.id, st.carrier_name, st.network_type,
               st.download_mbps, st.upload_mbps, st.latency_ms,
               st.latitude, st.longitude, st.province, st.district,
               st.recorded_at
        FROM speed_tests st
        JOIN devices d ON d.id = st.device_id
        WHERE d.user_id = ${request.user.userId}
        ORDER BY st.recorded_at DESC
        LIMIT ${limit}
      `;

      const outages = await sql`
        SELECT o.id, o.carrier_name, o.outage_type, o.description,
               o.latitude, o.longitude, o.province, o.district,
               o.cluster_size, o.is_verified, o.resolved_at, o.reported_at
        FROM outage_reports o
        JOIN devices d ON d.id = o.device_id
        WHERE d.user_id = ${request.user.userId}
        ORDER BY o.reported_at DESC
        LIMIT ${limit}
      `;

      return reply.send({ tests, outages });
    }
  );
};
