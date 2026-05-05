// Push subscription endpoints — user-only (need verified phone to subscribe).

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import sql from '../db/index.js';

const SubscribeSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().max(200),
    auth:   z.string().max(50),
  }),
  // Optional location to filter alerts
  latitude:  z.number().min(8).max(24).optional(),
  longitude: z.number().min(102).max(110).optional(),
  radiusM:   z.number().int().min(500).max(100000).default(10000),
  carriers:  z.array(z.string().max(50)).max(10).optional(),
});

export const pushRoute: FastifyPluginAsync = async (fastify) => {

  // GET /api/v1/push/vapid-public-key
  fastify.get('/api/v1/push/vapid-public-key', async (_request, reply) => {
    const key = process.env.VAPID_PUBLIC_KEY;
    if (!key) return reply.status(503).send({ error: 'Push notifications not configured' });
    return reply.send({ publicKey: key });
  });

  // POST /api/v1/push/subscribe — store or update subscription for user
  fastify.post(
    '/api/v1/push/subscribe',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      if (request.user.type !== 'user') {
        return reply.status(403).send({ error: 'User token required' });
      }
      const parsed = SubscribeSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const d = parsed.data;

      const [sub] = await sql`
        INSERT INTO push_subscriptions (
          user_id, endpoint, p256dh, auth_secret,
          latitude, longitude, radius_m, carriers
        ) VALUES (
          ${request.user.userId},
          ${d.endpoint},
          ${d.keys.p256dh},
          ${d.keys.auth},
          ${d.latitude ?? null},
          ${d.longitude ?? null},
          ${d.radiusM},
          ${d.carriers ?? null}
        )
        ON CONFLICT (endpoint) DO UPDATE SET
          user_id     = EXCLUDED.user_id,
          p256dh      = EXCLUDED.p256dh,
          auth_secret = EXCLUDED.auth_secret,
          latitude    = EXCLUDED.latitude,
          longitude   = EXCLUDED.longitude,
          radius_m    = EXCLUDED.radius_m,
          carriers    = EXCLUDED.carriers,
          failure_count = 0,
          last_used   = NOW()
        RETURNING id
      `;

      return reply.send({ subscriptionId: sub.id });
    }
  );

  // DELETE /api/v1/push/subscribe — remove by endpoint
  fastify.delete(
    '/api/v1/push/subscribe',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      if (request.user.type !== 'user') {
        return reply.status(403).send({ error: 'User token required' });
      }
      const body = request.body as { endpoint?: string } | undefined;
      const endpoint = body?.endpoint;
      if (!endpoint) return reply.status(400).send({ error: 'endpoint required' });

      const result = await sql`
        DELETE FROM push_subscriptions
        WHERE endpoint = ${endpoint} AND user_id = ${request.user.userId}
        RETURNING id
      `;
      return reply.send({ deleted: result.length });
    }
  );

  // GET /api/v1/push/me — list current user's subscriptions
  fastify.get(
    '/api/v1/push/me',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      if (request.user.type !== 'user') {
        return reply.status(403).send({ error: 'User token required' });
      }
      const subs = await sql`
        SELECT id, endpoint, latitude, longitude, radius_m, carriers, created_at, last_used
        FROM push_subscriptions
        WHERE user_id = ${request.user.userId}
        ORDER BY last_used DESC
      `;
      return reply.send({ subscriptions: subs });
    }
  );
};
