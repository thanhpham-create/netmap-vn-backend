// Admin / operator dashboard endpoints. Role-gated.

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import sql from '../db/index.js';

function requireAdminOrOperator(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.user.type !== 'user') {
    reply.status(403).send({ error: 'User token required' });
    return false;
  }
  if (!['admin', 'operator'].includes(request.user.role)) {
    reply.status(403).send({ error: 'Admin/operator only' });
    return false;
  }
  return true;
}

export const adminRoute: FastifyPluginAsync = async (fastify) => {

  // GET /api/v1/admin/stats — High-level overview
  fastify.get(
    '/api/v1/admin/stats',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      if (!requireAdminOrOperator(request, reply)) return;

      const [
        [totals],
        carrierBreakdown,
        outageStats,
        topProvinces,
      ] = await Promise.all([
        sql`
          SELECT
            (SELECT COUNT(*)::int FROM users)         AS total_users,
            (SELECT COUNT(*)::int FROM devices)        AS total_devices,
            (SELECT COUNT(*)::int FROM devices WHERE last_seen > NOW() - INTERVAL '7 days') AS active_devices_7d,
            (SELECT COUNT(*)::int FROM speed_tests)    AS total_tests,
            (SELECT COUNT(*)::int FROM speed_tests WHERE recorded_at > NOW() - INTERVAL '24 hours') AS tests_24h,
            (SELECT COUNT(*)::int FROM outage_reports WHERE reported_at > NOW() - INTERVAL '24 hours' AND resolved_at IS NULL) AS active_outages_24h,
            (SELECT COUNT(*)::int FROM outage_reports WHERE is_verified AND reported_at > NOW() - INTERVAL '24 hours') AS verified_outages_24h
        `,
        sql`
          SELECT carrier_name, COUNT(*)::int AS test_count,
                 ROUND(AVG(download_mbps)::numeric, 1) AS avg_download,
                 ROUND(AVG(latency_ms)::numeric, 0)    AS avg_latency
          FROM speed_tests
          WHERE recorded_at > NOW() - INTERVAL '7 days'
          GROUP BY carrier_name
          ORDER BY test_count DESC
          LIMIT 10
        `,
        sql`
          SELECT carrier_name, outage_type, COUNT(*)::int AS report_count,
                 COUNT(*) FILTER (WHERE is_verified)::int AS verified
          FROM outage_reports
          WHERE reported_at > NOW() - INTERVAL '24 hours'
            AND resolved_at IS NULL
          GROUP BY carrier_name, outage_type
          ORDER BY report_count DESC
          LIMIT 10
        `,
        sql`
          SELECT province, COUNT(*)::int AS report_count
          FROM outage_reports
          WHERE reported_at > NOW() - INTERVAL '7 days'
            AND province IS NOT NULL
            AND resolved_at IS NULL
          GROUP BY province
          ORDER BY report_count DESC
          LIMIT 10
        `,
      ]);

      return reply.send({
        totals,
        carrierBreakdown,
        outageStats,
        topProblematicProvinces: topProvinces,
        generatedAt: new Date().toISOString(),
      });
    }
  );

  // GET /api/v1/admin/recent-outages — Latest verified outage clusters
  fastify.get<{ Querystring: { limit?: string; verified?: string } }>(
    '/api/v1/admin/recent-outages',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      if (!requireAdminOrOperator(request, reply)) return;

      const limit = Math.min(parseInt(request.query.limit || '20'), 100);
      const verifiedOnly = request.query.verified === 'true';

      const outages = await sql`
        SELECT
          id, carrier_name, outage_type, description,
          latitude, longitude, province, district, ward,
          cluster_size, is_verified, resolved_at, reported_at
        FROM outage_reports
        WHERE
          reported_at > NOW() - INTERVAL '7 days'
          AND resolved_at IS NULL
          ${verifiedOnly ? sql`AND is_verified = TRUE` : sql``}
        ORDER BY reported_at DESC
        LIMIT ${limit}
      `;

      return reply.send({ outages });
    }
  );

  // GET /api/v1/admin/users — List users (admin only, not operator)
  fastify.get<{ Querystring: { limit?: string } }>(
    '/api/v1/admin/users',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      if (request.user.type !== 'user' || request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Admin only' });
      }
      const limit = Math.min(parseInt(request.query.limit || '50'), 200);

      const users = await sql`
        SELECT u.id, u.phone, u.role, u.display_name, u.created_at, u.last_active,
               (SELECT COUNT(*)::int FROM devices WHERE user_id = u.id)         AS device_count,
               (SELECT COUNT(*)::int FROM speed_tests st JOIN devices d ON d.id = st.device_id WHERE d.user_id = u.id) AS test_count
        FROM users u
        ORDER BY u.last_active DESC
        LIMIT ${limit}
      `;

      return reply.send({ users });
    }
  );
};
