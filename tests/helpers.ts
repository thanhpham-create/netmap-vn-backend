// Test helpers — boot a Fastify instance per file, expose `inject` helper
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import sql from '../src/db/index.js';

import { authRoute } from '../src/routes/auth.js';
import { devicesRoute } from '../src/routes/devices.js';
import { speedTestsRoute } from '../src/routes/speed-tests.js';
import { coverageRoute } from '../src/routes/coverage.js';
import { outagesRoute } from '../src/routes/outages.js';
import { leaderboardRoute } from '../src/routes/leaderboard.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(jwt, { secret: process.env.JWT_SECRET || 'test-secret' });
  await app.register(rateLimit, {
    timeWindow: '1 minute',
    max: 1000,  // permissive for tests
    addHeaders: {
      'x-ratelimit-limit':     true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset':     true,
    },
  });

  app.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
      if (request.user.type !== 'user') {
        return reply.status(403).send({ error: 'User token required' });
      }
    } catch { reply.status(401).send({ error: 'Unauthorized' }); }
  });

  app.decorate('authenticateAny', async function (request: FastifyRequest, reply: FastifyReply) {
    try { await request.jwtVerify(); }
    catch { return reply.status(401).send({ error: 'Unauthorized' }); }
    const u = request.user;
    if (u.type === 'device') {
      request.deviceContext = { deviceId: u.deviceId, deviceUid: u.deviceUid };
      return;
    }
    if (u.type === 'user') {
      const [device] = await sql`
        SELECT id, device_uid FROM devices
        WHERE user_id = ${u.userId}
        ORDER BY last_seen DESC LIMIT 1
      `;
      if (!device) return reply.status(400).send({ error: 'User has no registered device' });
      request.deviceContext = { deviceId: device.id, deviceUid: device.deviceUid };
    }
  });

  await app.register(authRoute);
  await app.register(devicesRoute);
  await app.register(speedTestsRoute);
  await app.register(coverageRoute);
  await app.register(outagesRoute);
  await app.register(leaderboardRoute);

  return app;
}

/** Register a device and return its deviceToken for use in subsequent POSTs. */
export async function registerDeviceForTest(
  app: FastifyInstance,
  uid: string,
  carrierName = 'Viettel',
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/devices/register',
    payload: { deviceUid: uid, platform: 'ios', carrierName },
  });
  if (res.statusCode !== 200) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  return res.json().deviceToken;
}

/** Wipe all transactional tables. Keep schema. */
export async function truncateAll() {
  await sql`TRUNCATE outage_reports, signal_samples, speed_tests, devices, users RESTART IDENTITY CASCADE`;
}

/** Close all connections — call in teardown. */
export async function closeAll(app: FastifyInstance) {
  await app.close();
  await sql.end({ timeout: 5 });
}

/** Random VN-bounded coordinate (Da Nang area by default). */
export function vnCoord(jitter = 0.001) {
  return {
    latitude: 16.0544 + (Math.random() - 0.5) * jitter,
    longitude: 108.2022 + (Math.random() - 0.5) * jitter,
  };
}

/** Generate test deviceUid. */
export function uniqueDeviceUid(prefix = 'test') {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}
