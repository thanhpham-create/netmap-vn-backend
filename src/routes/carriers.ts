// Carrier comparison endpoints — so sánh nhà mạng theo tỉnh hoặc toàn quốc.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import sql from '../db/index.js';

const CompareQuerySchema = z.object({
  province: z.string().max(100).optional(),
  days:     z.coerce.number().int().min(1).max(365).default(30),
  network:  z.string().max(20).optional(),
});

export const carriersRoute: FastifyPluginAsync = async (fastify) => {

  // GET /api/v1/carriers/compare — Compare carriers (optional: filter by province/network)
  fastify.get<{ Querystring: { province?: string; days?: string; network?: string } }>(
    '/api/v1/carriers/compare',
    async (request, reply) => {
      const parsed = CompareQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { province, days, network } = parsed.data;

      // Stats per carrier: speeds, latency, 5G %, sample count
      const carriers = await sql`
        SELECT
          carrier_name,
          COUNT(*)::int                                    AS test_count,
          ROUND(AVG(download_mbps)::numeric, 1)            AS avg_download_mbps,
          ROUND(AVG(upload_mbps)::numeric, 1)              AS avg_upload_mbps,
          ROUND(AVG(latency_ms)::numeric, 0)               AS avg_latency_ms,
          ROUND(
            (COUNT(*) FILTER (WHERE network_type LIKE '5G%')::numeric / COUNT(*) * 100),
            1
          )                                                AS pct_5g,
          ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY download_mbps)::numeric, 1) AS median_download_mbps,
          COUNT(DISTINCT device_id)::int                   AS device_count
        FROM speed_tests
        WHERE
          recorded_at > NOW() - make_interval(days => ${days}::int)
          ${province ? sql`AND province = ${province}` : sql``}
          ${network ? sql`AND network_type = ${network}` : sql``}
        GROUP BY carrier_name
        HAVING COUNT(*) >= 3
        ORDER BY avg_download_mbps DESC NULLS LAST
      `;

      // Outage counts per carrier in same window
      const outages = await sql`
        SELECT
          carrier_name,
          COUNT(*)::int                                AS outage_count,
          COUNT(*) FILTER (WHERE is_verified)::int     AS verified_outages
        FROM outage_reports
        WHERE
          reported_at > NOW() - make_interval(days => ${days}::int)
          ${province ? sql`AND province = ${province}` : sql``}
        GROUP BY carrier_name
      `;

      // Combine and compute reliability score: 1 - (outage_count / test_count), clamped
      const outageMap = new Map<string, { outageCount: number; verifiedOutages: number }>();
      for (const o of outages as any[]) {
        outageMap.set(o.carrierName, { outageCount: o.outageCount, verifiedOutages: o.verifiedOutages });
      }

      const result = (carriers as any[]).map((c) => {
        const o = outageMap.get(c.carrierName) || { outageCount: 0, verifiedOutages: 0 };
        const reliability = c.testCount > 0
          ? Math.max(0, Math.min(1, 1 - (o.outageCount / c.testCount)))
          : null;
        return {
          ...c,
          outageCount:     o.outageCount,
          verifiedOutages: o.verifiedOutages,
          reliabilityScore: reliability !== null ? Math.round(reliability * 1000) / 1000 : null,
        };
      });

      return reply.send({
        province: province || 'Toàn quốc',
        days,
        network: network || 'Tất cả',
        carriers: result,
      });
    }
  );

  // GET /api/v1/carriers/provinces — List provinces có data (cho dropdown)
  fastify.get('/api/v1/carriers/provinces', async (_request, reply) => {
    const rows = await sql`
      SELECT province, COUNT(*)::int AS test_count
      FROM speed_tests
      WHERE province IS NOT NULL
        AND recorded_at > NOW() - INTERVAL '90 days'
      GROUP BY province
      ORDER BY test_count DESC
    `;
    return reply.send({ provinces: rows });
  });
};
