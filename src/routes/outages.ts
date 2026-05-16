import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import sql from '../db/index.js';
import { broadcastOutageAlert } from '../lib/push.js';

const ReportOutageSchema = z.object({
  // deviceUid removed — taken from auth token
  carrierName:  z.string().max(50),
  outageType:   z.enum(['no_signal', 'slow', 'no_data', 'no_call', 'no_sms', 'intermittent']),
  description:  z.string().max(500).optional(),
  latitude:     z.number().min(8).max(24),
  longitude:    z.number().min(102).max(110),
  province:     z.string().max(100).optional(),
  district:     z.string().max(100).optional(),
  ward:         z.string().max(100).optional(),
});

export const outagesRoute: FastifyPluginAsync = async (fastify) => {

  // POST /api/v1/outages/report — Report an outage (auth required)
  fastify.post(
    '/api/v1/outages/report',
    { onRequest: [fastify.authenticateAny] },
    async (request, reply) => {
    const parsed = ReportOutageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const d = parsed.data;
    const ctx = request.deviceContext;
    if (!ctx) return reply.status(401).send({ error: 'No device context' });

    // Check for similar reports nearby in last hour (cluster detection)
    // Bbox prefilter uses idx_outage_geo before exact Haversine.
    const [cluster] = await sql`
      WITH bbox AS (
        SELECT * FROM nearby_bbox(${d.latitude}, ${d.longitude}, 2000)
      )
      SELECT COUNT(*)::int AS count
      FROM outage_reports, bbox
      WHERE
        carrier_name = ${d.carrierName}
        AND outage_type = ${d.outageType}
        AND reported_at > NOW() - INTERVAL '1 hour'
        AND latitude  BETWEEN bbox.min_lat AND bbox.max_lat
        AND longitude BETWEEN bbox.min_lng AND bbox.max_lng
        AND 6371000 * 2 * ASIN(SQRT(
          POWER(SIN((RADIANS(latitude) - RADIANS(${d.latitude})) / 2), 2) +
          COS(RADIANS(${d.latitude})) * COS(RADIANS(latitude)) *
          POWER(SIN((RADIANS(longitude) - RADIANS(${d.longitude})) / 2), 2)
        )) <= 2000
    `;

    const clusterSize = cluster.count + 1;
    const isVerified = clusterSize >= 5;  // Auto-verify if 5+ reports in 2km/1hr

    const [report] = await sql`
      INSERT INTO outage_reports (
        device_id, carrier_name, outage_type, description,
        latitude, longitude, province, district, ward,
        cluster_size, is_verified
      ) VALUES (
        ${ctx.deviceId}, ${d.carrierName}, ${d.outageType}, ${d.description ?? null},
        ${d.latitude}, ${d.longitude},
        ${d.province ?? null}, ${d.district ?? null}, ${d.ward ?? null},
        ${clusterSize}, ${isVerified}
      )
      RETURNING id, reported_at, cluster_size, is_verified
    `;

    // When threshold crossed, broadcast push to nearby subscribers (fire-and-forget)
    if (isVerified) {
      broadcastOutageAlert({
        carrier:     d.carrierName,
        outageType:  d.outageType,
        latitude:    d.latitude,
        longitude:   d.longitude,
        province:    d.province,
        district:    d.district,
        clusterSize,
      }).then((res) => {
        request.log.info({ res, carrier: d.carrierName }, 'Push broadcast complete');
      }).catch((err) => {
        request.log.error({ err }, 'Push broadcast failed (non-fatal)');
      });
    }

    // When threshold crossed, backfill verification on all prior reports in cluster
    if (isVerified) {
      const bbox = await sql<Array<{minLat:number; maxLat:number; minLng:number; maxLng:number}>>`
        SELECT * FROM nearby_bbox(${d.latitude}, ${d.longitude}, 2000)
      `;
      const b = bbox[0];
      await sql`
        UPDATE outage_reports
        SET is_verified = TRUE, cluster_size = ${clusterSize}
        WHERE
          carrier_name = ${d.carrierName}
          AND outage_type = ${d.outageType}
          AND reported_at > NOW() - INTERVAL '1 hour'
          AND is_verified = FALSE
          AND latitude  BETWEEN ${b.minLat} AND ${b.maxLat}
          AND longitude BETWEEN ${b.minLng} AND ${b.maxLng}
          AND 6371000 * 2 * ASIN(SQRT(
            POWER(SIN((RADIANS(latitude) - RADIANS(${d.latitude})) / 2), 2) +
            COS(RADIANS(${d.latitude})) * COS(RADIANS(latitude)) *
            POWER(SIN((RADIANS(longitude) - RADIANS(${d.longitude})) / 2), 2)
          )) <= 2000
      `;
    }

    return reply.status(201).send({
      report,
      message: isVerified
        ? `🚨 Đã xác nhận sự cố! ${clusterSize} người báo cáo cùng khu vực.`
        : `Đã ghi nhận báo cáo. ${clusterSize} người báo gần đây.`,
    });
  }
  );

  // GET /api/v1/outages/active — Get active outages near location
  fastify.get<{
    Querystring: { lat: string; lng: string; radius?: string; hours?: string }
  }>('/api/v1/outages/active', async (request, reply) => {
    const lat = parseFloat(request.query.lat);
    const lng = parseFloat(request.query.lng);
    const radius = parseInt(request.query.radius || '5000');
    const hours = parseInt(request.query.hours || '6');

    if (isNaN(lat) || isNaN(lng)) {
      return reply.status(400).send({ error: 'Invalid lat/lng' });
    }

    const outages = await sql`
      SELECT * FROM active_outages(${lat}, ${lng}, ${radius}, ${hours})
    `;

    return reply.send({
      location: { latitude: lat, longitude: lng },
      radiusM: radius,
      hoursBack: hours,
      outages,
      hasActiveOutages: outages.length > 0,
    });
  });

  // POST /api/v1/outages/:id/resolve — Mark outage cluster as resolved (operator/admin)
  fastify.post<{ Params: { id: string } }>(
    '/api/v1/outages/:id/resolve',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      if (request.user.type !== 'user' || !['operator', 'admin'].includes(request.user.role)) {
        return reply.status(403).send({ error: 'Forbidden — operator/admin only' });
      }
      const id = parseInt(request.params.id);
      if (isNaN(id)) return reply.status(400).send({ error: 'Invalid id' });

      const [seed] = await sql`
        SELECT carrier_name, outage_type, latitude, longitude
        FROM outage_reports WHERE id = ${id}
      `;
      if (!seed) return reply.status(404).send({ error: 'Outage not found' });

      const bbox = await sql<Array<{minLat:number; maxLat:number; minLng:number; maxLng:number}>>`
        SELECT * FROM nearby_bbox(${seed.latitude}, ${seed.longitude}, 2000)
      `;
      const b = bbox[0];
      const result = await sql`
        UPDATE outage_reports
        SET resolved_at = NOW()
        WHERE
          carrier_name = ${seed.carrierName}
          AND outage_type = ${seed.outageType}
          AND resolved_at IS NULL
          AND latitude  BETWEEN ${b.minLat} AND ${b.maxLat}
          AND longitude BETWEEN ${b.minLng} AND ${b.maxLng}
          AND 6371000 * 2 * ASIN(SQRT(
            POWER(SIN((RADIANS(latitude) - RADIANS(${seed.latitude})) / 2), 2) +
            COS(RADIANS(${seed.latitude})) * COS(RADIANS(latitude)) *
            POWER(SIN((RADIANS(longitude) - RADIANS(${seed.longitude})) / 2), 2)
          )) <= 2000
        RETURNING id
      `;

      return reply.send({ resolvedCount: result.length, message: `Đã đánh dấu ${result.length} báo cáo là đã giải quyết.` });
    }
  );

  // GET /api/v1/outages/national — Country-wide outage status (for homepage)
  fastify.get('/api/v1/outages/national', async (_request, reply) => {
    const summary = await sql`
      SELECT
        carrier_name,
        outage_type,
        COUNT(*)::int AS report_count,
        COUNT(DISTINCT province)::int AS provinces_affected,
        ARRAY_AGG(DISTINCT province ORDER BY province) FILTER (WHERE province IS NOT NULL) AS provinces
      FROM outage_reports
      WHERE
        reported_at > NOW() - INTERVAL '6 hours'
        AND resolved_at IS NULL
      GROUP BY carrier_name, outage_type
      HAVING COUNT(*) >= 5
      ORDER BY report_count DESC
    `;

    return reply.send({
      summary,
      generatedAt: new Date().toISOString(),
    });
  });

  // GET /api/v1/outages/ai-summary — natural language summary of recent outages
  // Returns { summary: null } gracefully when ANTHROPIC_API_KEY is not configured
  // so the frontend can hide the section without errors.
  fastify.get('/api/v1/outages/ai-summary', async (_request, reply) => {
    try {
      const rows = await sql<Array<{
        carrierName: string;
        outageType: string;
        province: string | null;
        reportCount: number;
        firstReported: string;
        isVerified: boolean;
      }>>`
        SELECT
          carrier_name        AS "carrierName",
          outage_type         AS "outageType",
          province,
          COUNT(*)::int       AS "reportCount",
          MIN(reported_at)    AS "firstReported",
          BOOL_OR(is_verified) AS "isVerified"
        FROM outage_reports
        WHERE
          reported_at > NOW() - INTERVAL '6 hours'
          AND resolved_at IS NULL
        GROUP BY carrier_name, outage_type, province
        HAVING COUNT(*) >= 3
        ORDER BY COUNT(*) DESC
        LIMIT 30
      `;

      const { generateOutageSummary } = await import('../lib/ai-summary.js');
      const summary = await generateOutageSummary(rows);

      return reply.send({
        summary,
        outageCount: rows.length,
        generatedAt: new Date().toISOString(),
        enabled: !!process.env.ANTHROPIC_API_KEY,
      });
    } catch (err) {
      // AI failure must NOT break the page — log and return null
      fastify.log.error({ err }, 'AI summary generation failed');
      return reply.send({
        summary: null,
        outageCount: 0,
        generatedAt: new Date().toISOString(),
        enabled: !!process.env.ANTHROPIC_API_KEY,
        error: 'AI summary unavailable',
      });
    }
  });
};
