import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import sql from '../db/index.js';

const SubmitSpeedTestSchema = z.object({
  // deviceUid removed — taken from auth token, not body
  carrierName:      z.string().max(50),
  networkType:      z.string().max(20),
  isRoaming:        z.boolean().default(false),

  downloadMbps:     z.number().min(0).max(10000),
  uploadMbps:       z.number().min(0).max(10000),
  latencyMs:        z.number().int().min(0).max(60000),
  jitterMs:         z.number().int().min(0).max(60000).optional(),
  packetLossPct:    z.number().min(0).max(100).optional(),

  latitude:         z.number().min(8).max(24),
  longitude:        z.number().min(102).max(110),
  altitudeM:        z.number().int().optional(),
  locationAccuracyM: z.number().int().optional(),
  province:         z.string().max(100).optional(),
  district:         z.string().max(100).optional(),
  ward:             z.string().max(100).optional(),
  buildingName:     z.string().max(200).optional(),

  testDurationMs:   z.number().int().optional(),
  testServer:       z.string().max(200).optional(),
  testType:         z.enum(['manual', 'passive', 'scheduled']).default('manual'),

  // Optional signal data (sent together with speed test)
  signalSample:     z.object({
    band:           z.string().max(20).optional(),
    rsrpDbm:        z.number().int().min(-140).max(-40).optional(),
    rsrqDb:         z.number().min(-30).max(0).optional(),
    sinrDb:         z.number().min(-30).max(50).optional(),
    rssiDbm:        z.number().int().min(-140).max(-30).optional(),
    cqi:            z.number().int().min(0).max(15).optional(),
    cellId:         z.number().int().optional(),
    pci:            z.number().int().optional(),
    tac:            z.number().int().optional(),
    mcc:            z.number().int().optional(),
    mnc:            z.number().int().optional(),
  }).optional(),
});

export const speedTestsRoute: FastifyPluginAsync = async (fastify) => {

  // POST /api/v1/speed-tests — Submit a speed test (auth required)
  fastify.post(
    '/api/v1/speed-tests',
    { onRequest: [fastify.authenticateAny] },
    async (request, reply) => {
      const parsed = SubmitSpeedTestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const d = parsed.data;
      const ctx = request.deviceContext;
      if (!ctx) {
        return reply.status(401).send({ error: 'No device context' });
      }

      // Insert speed test
      const [test] = await sql`
        INSERT INTO speed_tests (
          device_id, carrier_name, network_type, is_roaming,
          download_mbps, upload_mbps, latency_ms, jitter_ms, packet_loss_pct,
          latitude, longitude, altitude_m, location_accuracy_m,
          province, district, ward, building_name,
          test_duration_ms, test_server, test_type
        ) VALUES (
          ${ctx.deviceId}, ${d.carrierName}, ${d.networkType}, ${d.isRoaming},
          ${d.downloadMbps}, ${d.uploadMbps}, ${d.latencyMs},
          ${d.jitterMs ?? null}, ${d.packetLossPct ?? null},
          ${d.latitude}, ${d.longitude},
          ${d.altitudeM ?? null}, ${d.locationAccuracyM ?? null},
          ${d.province ?? null}, ${d.district ?? null}, ${d.ward ?? null}, ${d.buildingName ?? null},
          ${d.testDurationMs ?? null}, ${d.testServer ?? null}, ${d.testType}
        )
        RETURNING id, recorded_at
      `;

      // Insert signal sample if provided
      if (d.signalSample) {
        const s = d.signalSample;
        await sql`
          INSERT INTO signal_samples (
            device_id, speed_test_id, carrier_name, network_type, band,
            rsrp_dbm, rsrq_db, sinr_db, rssi_dbm, cqi,
            cell_id, pci, tac, mcc, mnc,
            latitude, longitude, altitude_m
          ) VALUES (
            ${ctx.deviceId}, ${test.id}, ${d.carrierName}, ${d.networkType}, ${s.band ?? null},
            ${s.rsrpDbm ?? null}, ${s.rsrqDb ?? null}, ${s.sinrDb ?? null},
            ${s.rssiDbm ?? null}, ${s.cqi ?? null},
            ${s.cellId ?? null}, ${s.pci ?? null}, ${s.tac ?? null},
            ${s.mcc ?? null}, ${s.mnc ?? null},
            ${d.latitude}, ${d.longitude}, ${d.altitudeM ?? null}
          )
        `;
      }

      // Touch device.last_seen
      await sql`UPDATE devices SET last_seen = NOW() WHERE id = ${ctx.deviceId}`;

      return reply.status(201).send({
        speedTest: test,
        message: 'Đã ghi nhận kết quả đo tốc độ',
      });
    }
  );

  // GET /api/v1/speed-tests/recent — Recent tests in area
  fastify.get<{
    Querystring: { lat: string; lng: string; radius?: string; carrier?: string; limit?: string }
  }>('/api/v1/speed-tests/recent', async (request, reply) => {
    const lat = parseFloat(request.query.lat);
    const lng = parseFloat(request.query.lng);
    const radius = parseInt(request.query.radius || '5000');
    const carrier = request.query.carrier;
    const limit = Math.min(parseInt(request.query.limit || '50'), 200);

    if (isNaN(lat) || isNaN(lng)) {
      return reply.status(400).send({ error: 'Invalid lat/lng' });
    }

    // Bbox prefilter (uses idx_speed_tests_geo) → exact Haversine on subset
    const tests = await sql`
      WITH bbox AS (
        SELECT * FROM nearby_bbox(${lat}, ${lng}, ${radius})
      )
      SELECT
        id, carrier_name, network_type, download_mbps, upload_mbps, latency_ms,
        latitude, longitude, province, district, ward, building_name,
        recorded_at,
        ROUND((6371000 * 2 * ASIN(SQRT(
          POWER(SIN((RADIANS(latitude) - RADIANS(${lat})) / 2), 2) +
          COS(RADIANS(${lat})) * COS(RADIANS(latitude)) *
          POWER(SIN((RADIANS(longitude) - RADIANS(${lng})) / 2), 2)
        )))::numeric, 0) AS distance_m
      FROM speed_tests, bbox
      WHERE
        recorded_at > NOW() - INTERVAL '7 days'
        AND latitude  BETWEEN bbox.min_lat AND bbox.max_lat
        AND longitude BETWEEN bbox.min_lng AND bbox.max_lng
        ${carrier ? sql`AND carrier_name = ${carrier}` : sql``}
        AND 6371000 * 2 * ASIN(SQRT(
          POWER(SIN((RADIANS(latitude) - RADIANS(${lat})) / 2), 2) +
          COS(RADIANS(${lat})) * COS(RADIANS(latitude)) *
          POWER(SIN((RADIANS(longitude) - RADIANS(${lng})) / 2), 2)
        )) <= ${radius}
      ORDER BY recorded_at DESC
      LIMIT ${limit}
    `;

    return reply.send({ tests, count: tests.length });
  });
};
