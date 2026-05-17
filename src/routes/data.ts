// Open Data API — public read-only endpoints.
// JSON or CSV. Strict pagination (max 5000 rows). PII not exposed (no phone, no device IDs).

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import sql from '../db/index.js';
import { rowsToCsv } from '../lib/csv.js';

const FormatSchema = z.enum(['json', 'csv']).default('json');
const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 1000;

const SpeedTestsQuerySchema = z.object({
  from:       z.string().optional(),  // ISO date
  to:         z.string().optional(),
  province:   z.string().max(100).optional(),
  carrier:    z.string().max(50).optional(),
  network:    z.string().max(20).optional(),
  format:     FormatSchema,
  limit:      z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset:     z.coerce.number().int().min(0).default(0),
});

const OutagesQuerySchema = z.object({
  from:       z.string().optional(),
  to:         z.string().optional(),
  province:   z.string().max(100).optional(),
  carrier:    z.string().max(50).optional(),
  verifiedOnly: z.coerce.boolean().default(false),
  format:     FormatSchema,
  limit:      z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset:     z.coerce.number().int().min(0).default(0),
});

const CarriersStatsQuerySchema = z.object({
  days:    z.coerce.number().int().min(1).max(365).default(30),
  format:  FormatSchema,
});

function sendCsvOrJson(reply: FastifyReply, rows: any[], format: 'json' | 'csv', filename: string) {
  if (format === 'csv') {
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return reply.send(rowsToCsv(rows));
  }
  return reply.send({ rows, count: rows.length });
}

export const dataRoute: FastifyPluginAsync = async (fastify) => {

  // GET /api/v1/data/speed-tests
  fastify.get<{ Querystring: any }>('/api/v1/data/speed-tests', async (request, reply) => {
    const parsed = SpeedTestsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const q = parsed.data;

    const fromDate = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);
    const toDate   = q.to   ? new Date(q.to)   : new Date();

    const rows = await sql`
      SELECT
        id, carrier_name, network_type, is_roaming,
        download_mbps, upload_mbps, latency_ms, jitter_ms, packet_loss_pct,
        latitude, longitude, altitude_m,
        province, district, ward, building_name,
        recorded_at
      FROM speed_tests
      WHERE
        NOT is_flagged
        AND recorded_at BETWEEN ${fromDate} AND ${toDate}
        ${q.province ? sql`AND province = ${q.province}` : sql``}
        ${q.carrier  ? sql`AND carrier_name = ${q.carrier}` : sql``}
        ${q.network  ? sql`AND network_type = ${q.network}` : sql``}
      ORDER BY recorded_at DESC
      LIMIT ${q.limit} OFFSET ${q.offset}
    `;

    return sendCsvOrJson(reply, rows as any[], q.format, 'speed-tests');
  });

  // GET /api/v1/data/outages
  fastify.get<{ Querystring: any }>('/api/v1/data/outages', async (request, reply) => {
    const parsed = OutagesQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const q = parsed.data;

    const fromDate = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);
    const toDate   = q.to   ? new Date(q.to)   : new Date();

    const rows = await sql`
      SELECT
        id, carrier_name, outage_type, description,
        latitude, longitude, province, district, ward,
        cluster_size, is_verified, resolved_at, reported_at
      FROM outage_reports
      WHERE
        NOT is_flagged
        AND reported_at BETWEEN ${fromDate} AND ${toDate}
        ${q.province ? sql`AND province = ${q.province}` : sql``}
        ${q.carrier  ? sql`AND carrier_name = ${q.carrier}` : sql``}
        ${q.verifiedOnly ? sql`AND is_verified = TRUE` : sql``}
      ORDER BY reported_at DESC
      LIMIT ${q.limit} OFFSET ${q.offset}
    `;

    return sendCsvOrJson(reply, rows as any[], q.format, 'outages');
  });

  // GET /api/v1/data/carriers-stats — Daily aggregates per carrier
  fastify.get<{ Querystring: any }>('/api/v1/data/carriers-stats', async (request, reply) => {
    const parsed = CarriersStatsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const q = parsed.data;

    const rows = await sql`
      SELECT
        DATE_TRUNC('day', recorded_at)::date            AS date,
        carrier_name,
        COUNT(*)::int                                    AS test_count,
        ROUND(AVG(download_mbps)::numeric, 1)            AS avg_download_mbps,
        ROUND(AVG(upload_mbps)::numeric, 1)              AS avg_upload_mbps,
        ROUND(AVG(latency_ms)::numeric, 0)               AS avg_latency_ms,
        ROUND(
          (COUNT(*) FILTER (WHERE network_type LIKE '5G%')::numeric / NULLIF(COUNT(*), 0) * 100),
          1
        )                                                AS pct_5g
      FROM speed_tests
      WHERE NOT is_flagged
        AND recorded_at > NOW() - make_interval(days => ${q.days}::int)
      GROUP BY 1, carrier_name
      ORDER BY date DESC, carrier_name
    `;

    return sendCsvOrJson(reply, rows as any[], q.format, 'carriers-stats');
  });

  // GET /api/v1/data — Index của các endpoints + rate limit info
  fastify.get('/api/v1/data', async (_request, reply) => {
    return reply.send({
      version: '1',
      description: 'NetMap VN Open Data API. Read-only public access to crowdsourced telecom data.',
      endpoints: {
        speedTests:    '/api/v1/data/speed-tests?from=&to=&province=&carrier=&network=&format=json|csv&limit=&offset=',
        outages:       '/api/v1/data/outages?from=&to=&province=&carrier=&verifiedOnly=&format=&limit=&offset=',
        carriersStats: '/api/v1/data/carriers-stats?days=30&format=json|csv',
      },
      rateLimit: {
        anonymous:        '60 requests / minute / IP',
        authenticatedUser:'300 requests / minute / user',
        device:           '200 requests / minute / device',
      },
      maxRowsPerRequest: MAX_LIMIT,
      defaultRows:       DEFAULT_LIMIT,
      license: 'CC-BY-4.0 (attribution: NetMap VN cộng đồng)',
    });
  });
};
