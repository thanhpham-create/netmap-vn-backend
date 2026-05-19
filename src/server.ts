// Sentry must be imported BEFORE other instrumented modules (http, postgres, etc.)
import { Sentry } from './lib/sentry.js';

import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import sql from './db/index.js';

import { authRoute } from './routes/auth.js';
import { devicesRoute } from './routes/devices.js';
import { speedTestsRoute } from './routes/speed-tests.js';
import { coverageRoute } from './routes/coverage.js';
import { outagesRoute } from './routes/outages.js';
import { leaderboardRoute } from './routes/leaderboard.js';
import { measureRoute } from './routes/measure.js';
import { adminRoute } from './routes/admin.js';
import { carriersRoute } from './routes/carriers.js';
import { pushRoute } from './routes/push.js';
import { badgesRoute } from './routes/badges.js';
import { dataRoute } from './routes/data.js';

const PORT = parseInt(process.env.PORT || '8080');
const HOST = '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const JWT_SECRET = process.env.JWT_SECRET
  || (NODE_ENV === 'production'
        ? (() => { throw new Error('JWT_SECRET is required in production'); })()
        : 'netmap-vn-dev-secret-change-in-production');

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
  },
  trustProxy: true,
});

async function bootstrap() {
  // Response compression — gzip/brotli on JSON payloads. Heatmap responses can
  // be 50-200KB → compressed thường 10-30KB (~5x reduction).
  // Threshold 1KB tránh overhead với small responses.
  await fastify.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ['br', 'gzip'],   // brotli ưu tiên, fallback gzip
    // Skip /measure/download responses: random bytes không compress được nhưng
    // CPU vẫn tốn cho thử → chậm response on speedtest endpoint.
    customTypes: /^(?!application\/octet-stream).*/,
  });

  // Security headers — HSTS, X-Content-Type-Options, X-Frame-Options, etc.
  // Disabling CSP because this is a JSON API; CSP enforcement is responsibility of the SPA.
  await fastify.register(helmet, {
    contentSecurityPolicy: false,
    // 1 year HSTS, include subdomains, preload-ready
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    // Disable noSniff override — handled per-route if needed
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow embedding API from frontend
  });

  // CORS — let @fastify/cors handle it. Manual `*` + credentials breaks browsers.
  // For prod, set CORS_ORIGINS="https://netmap.vn,https://app.netmap.vn"
  // Also auto-accept *.vercel.app (preview + prod) để khỏi phải update env mỗi deploy.
  const allowedList = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const corsOrigin: any = allowedList
    ? (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
        // Non-browser requests (curl, server-to-server) have no Origin header — allow.
        if (!origin) return cb(null, true);
        if (allowedList.includes(origin)) return cb(null, true);
        // Auto-allow Vercel deployments (prod + previews share the same backend safely).
        if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return cb(null, true);
        // Auto-allow penwin.vn subdomains (netmap.penwin.vn + tương lai).
        if (/^https:\/\/([a-z0-9-]+\.)?penwin\.vn$/i.test(origin)) return cb(null, true);
        return cb(new Error('Not allowed by CORS'), false);
      }
    : true; // dev: allow all
  await fastify.register(cors, {
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // JWT
  await fastify.register(jwt, { secret: JWT_SECRET });

  // Strict: requires a USER token (not device).
  fastify.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
      if (request.user.type !== 'user') {
        return reply.status(403).send({ error: 'User token required (got device token)' });
      }
    } catch (err) {
      reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  // Accepts user OR device token. Populates request.deviceContext for either case.
  // For user token: looks up the user's most recently active device.
  fastify.decorate('authenticateAny', async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
    } catch (err) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const u = request.user;
    if (u.type === 'device') {
      request.deviceContext = { deviceId: u.deviceId, deviceUid: u.deviceUid };
      return;
    }
    if (u.type === 'user') {
      const [device] = await sql`
        SELECT id, device_uid FROM devices
        WHERE user_id = ${u.userId}
        ORDER BY last_seen DESC
        LIMIT 1
      `;
      if (!device) {
        return reply.status(400).send({ error: 'User has no registered device. Register a device first.' });
      }
      request.deviceContext = { deviceId: device.id, deviceUid: device.deviceUid };
      return;
    }
    return reply.status(401).send({ error: 'Unknown token type' });
  });

  // Rate limiting — per-user when authenticated, per-IP otherwise.
  // Authenticated users get higher limits.
  await fastify.register(rateLimit, {
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      // Try to extract userId from already-verified JWT (set by hooks on protected routes).
      // For unauth requests, fall back to IP.
      const u = (req as any).user;
      if (u?.userId) return `user:${u.userId}`;
      if (u?.deviceId) return `device:${u.deviceId}`;
      return `ip:${req.ip}`;
    },
    // Per-request max based on auth state
    max: (req: any) => {
      const u = req.user;
      if (u?.type === 'user' && (u.role === 'admin' || u.role === 'operator')) return 1000;
      if (u?.type === 'user') return 300;
      if (u?.type === 'device') return 200;
      return 60;
    },
    addHeaders: {
      'x-ratelimit-limit':     true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset':     true,
      'retry-after':           true,
    },
  });

  // Cache-Control headers cho responses cacheable.
  // CDN/edge cache (s-maxage) hơi dài hơn browser cache (max-age) để giảm load DB.
  // private/no-store cho data nhạy cảm (auth, me, admin) để CDN không cache nhầm.
  const CACHE_PUBLIC_60S      = 'public, max-age=30, s-maxage=60, stale-while-revalidate=120';
  const CACHE_PUBLIC_5MIN     = 'public, max-age=120, s-maxage=300, stale-while-revalidate=600';
  const CACHE_PRIVATE_NOSTORE = 'private, no-store, no-cache, must-revalidate';

  fastify.addHook('onSend', async (request, reply, payload) => {
    if (request.method !== 'GET') return payload;
    const url = request.url.split('?')[0];

    // No-cache cho dữ liệu user-specific & admin
    if (
      url.startsWith('/api/v1/auth/me') ||
      url.startsWith('/api/v1/admin') ||
      url.startsWith('/api/v1/badges/me') ||
      url.startsWith('/api/v1/push/me') ||
      url.startsWith('/api/v1/leaderboard/me')
    ) {
      reply.header('cache-control', CACHE_PRIVATE_NOSTORE);
      return payload;
    }

    // Static-ish data — cache lâu hơn (badge definitions, sitemap)
    if (url === '/api/v1/badges' || url.startsWith('/api/v1/carriers')) {
      reply.header('cache-control', CACHE_PUBLIC_5MIN);
      return payload;
    }

    // Heatmap, outages, leaderboard — cache ngắn vì data refresh thường xuyên
    if (
      url.startsWith('/api/v1/coverage') ||
      url.startsWith('/api/v1/outages') ||
      url.startsWith('/api/v1/leaderboard')
    ) {
      reply.header('cache-control', CACHE_PUBLIC_60S);
    }

    return payload;
  });

  // Health check
  fastify.get('/health', async () => ({
    status: 'ok',
    service: 'netmap-vn',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));

  // API root
  fastify.get('/', async () => ({
    name: 'NetMap VN API',
    version: '1.0.0',
    docs: 'https://github.com/netmap-vn',
  }));

  // Sentry error handler — capture 5xx, ignore 4xx
  fastify.setErrorHandler((error, request, reply) => {
    // Fastify v5 types error as unknown; we know it's an Error-like with optional statusCode
    const e = error as Error & { statusCode?: number };
    const statusCode = e.statusCode ?? 500;
    if (statusCode >= 500) {
      Sentry.withScope((scope) => {
        scope.setTag('route', request.routeOptions?.url || request.url);
        scope.setExtra('method', request.method);
        scope.setExtra('userId', (request as any).user?.userId || null);
        Sentry.captureException(e);
      });
    }
    request.log.error({ err: e }, 'Request failed');
    reply.status(statusCode).send({
      error: statusCode >= 500 ? 'Internal Server Error' : (e.message || 'Bad Request'),
    });
  });

  // Register routes
  await fastify.register(authRoute);
  await fastify.register(devicesRoute);
  await fastify.register(speedTestsRoute);
  await fastify.register(coverageRoute);
  await fastify.register(outagesRoute);
  await fastify.register(leaderboardRoute);
  await fastify.register(measureRoute);
  await fastify.register(adminRoute);
  await fastify.register(carriersRoute);
  await fastify.register(pushRoute);
  await fastify.register(badgesRoute);
  await fastify.register(dataRoute);

  // Start
  try {
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`🚀 NetMap VN API running at http://${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

bootstrap();
