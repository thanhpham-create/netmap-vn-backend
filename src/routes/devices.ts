import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import sql from '../db/index.js';

const RegisterDeviceSchema = z.object({
  deviceUid:   z.string().min(8).max(128),
  platform:    z.enum(['ios', 'android', 'web']),
  osVersion:   z.string().max(50).optional(),
  appVersion:  z.string().max(20).optional(),
  deviceModel: z.string().max(100).optional(),
  carrierName: z.string().max(50).optional(),
});

export const devicesRoute: FastifyPluginAsync = async (fastify) => {

  // POST /api/v1/devices/register — Register or update device, issue device token
  // Optional: send Authorization: Bearer <user_jwt> to link this device to that user.
  fastify.post('/api/v1/devices/register', async (request, reply) => {
    const parsed = RegisterDeviceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const d = parsed.data;

    // Optional user-linking: if a user JWT is provided, attach device to user
    let userId: string | null = null;
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        await request.jwtVerify();
        if (request.user.type === 'user') userId = request.user.userId;
      } catch {
        // Invalid token → ignore, register anonymously
      }
    }

    const [device] = await sql`
      INSERT INTO devices (
        device_uid, user_id, platform, os_version, app_version, device_model, carrier_name
      )
      VALUES (
        ${d.deviceUid}, ${userId}, ${d.platform}, ${d.osVersion ?? null},
        ${d.appVersion ?? null}, ${d.deviceModel ?? null}, ${d.carrierName ?? null}
      )
      ON CONFLICT (device_uid) DO UPDATE SET
        user_id = COALESCE(${userId}, devices.user_id),
        os_version = EXCLUDED.os_version,
        app_version = EXCLUDED.app_version,
        device_model = EXCLUDED.device_model,
        carrier_name = EXCLUDED.carrier_name,
        last_seen = NOW()
      RETURNING id, device_uid, platform, created_at
    `;

    // Issue long-lived device token (90 days) — used for POST /speed-tests, /outages/report
    const deviceToken = fastify.jwt.sign(
      { type: 'device', deviceId: device.id, deviceUid: device.deviceUid },
      { expiresIn: '90d' }
    );

    return reply.status(200).send({ device, deviceToken });
  });

  // GET /api/v1/devices/:uid — Get device info
  fastify.get<{ Params: { uid: string } }>(
    '/api/v1/devices/:uid',
    async (request, reply) => {
      const [device] = await sql`
        SELECT id, device_uid, platform, carrier_name, created_at, last_seen
        FROM devices
        WHERE device_uid = ${request.params.uid}
      `;
      if (!device) return reply.status(404).send({ error: 'Device not found' });
      return reply.send({ device });
    }
  );
};
