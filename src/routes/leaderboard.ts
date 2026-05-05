// Leaderboard — top contributors of speed tests + outage reports.
// Privacy: only users who have verified their phone (have user_id) appear.
// Anonymous devices are excluded.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import sql from '../db/index.js';
import { computeBadges } from '../lib/badges.js';

/** Attach top 3 earned badge emojis + count to each leaderboard row. */
async function attachBadges<T extends { userId: string }>(rows: T[]): Promise<(T & { topBadges: string[]; badgeCount: number })[]> {
  return Promise.all(
    rows.map(async (row) => {
      const all = await computeBadges(row.userId);
      const earned = all.filter((b) => b.earned);
      return {
        ...row,
        topBadges: earned.slice(0, 3).map((b) => b.emoji),
        badgeCount: earned.length,
      };
    }),
  );
}

const PeriodSchema = z.enum(['week', 'month', 'all']).default('month');

function periodInterval(period: 'week' | 'month' | 'all'): string {
  switch (period) {
    case 'week':  return '7 days';
    case 'month': return '30 days';
    case 'all':   return '100 years';
  }
}

const QuerySchema = z.object({
  period: PeriodSchema,
  limit:  z.coerce.number().int().min(1).max(100).default(10),
});

export const leaderboardRoute: FastifyPluginAsync = async (fastify) => {

  // GET /api/v1/leaderboard/speed-tests
  fastify.get<{ Querystring: { period?: string; limit?: string } }>(
    '/api/v1/leaderboard/speed-tests',
    async (request, reply) => {
      const parsed = QuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { period, limit } = parsed.data;
      const interval = periodInterval(period);

      const rows = await sql`
        SELECT
          u.id AS user_id,
          COALESCE(u.display_name, 'Người dùng #' || SUBSTRING(u.id::text FROM 1 FOR 8)) AS display_name,
          COUNT(*)::int AS test_count,
          MAX(st.recorded_at) AS last_at,
          ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, MAX(st.recorded_at) DESC)::int AS rank
        FROM speed_tests st
        JOIN devices d ON d.id = st.device_id
        JOIN users   u ON u.id = d.user_id
        WHERE st.recorded_at > NOW() - INTERVAL '${sql.unsafe(interval)}'
        GROUP BY u.id, u.display_name
        ORDER BY test_count DESC, last_at DESC
        LIMIT ${limit}
      `;

      const enriched = await attachBadges(rows as any);
      return reply.send({ period, leaderboard: enriched });
    }
  );

  // GET /api/v1/leaderboard/outages
  fastify.get<{ Querystring: { period?: string; limit?: string } }>(
    '/api/v1/leaderboard/outages',
    async (request, reply) => {
      const parsed = QuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { period, limit } = parsed.data;
      const interval = periodInterval(period);

      const rows = await sql`
        SELECT
          u.id AS user_id,
          COALESCE(u.display_name, 'Người dùng #' || SUBSTRING(u.id::text FROM 1 FOR 8)) AS display_name,
          COUNT(*)::int AS report_count,
          COUNT(*) FILTER (WHERE o.is_verified)::int AS verified_count,
          MAX(o.reported_at) AS last_at,
          ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, MAX(o.reported_at) DESC)::int AS rank
        FROM outage_reports o
        JOIN devices d ON d.id = o.device_id
        JOIN users   u ON u.id = d.user_id
        WHERE o.reported_at > NOW() - INTERVAL '${sql.unsafe(interval)}'
        GROUP BY u.id, u.display_name
        ORDER BY report_count DESC, last_at DESC
        LIMIT ${limit}
      `;

      const enriched = await attachBadges(rows as any);
      return reply.send({ period, leaderboard: enriched });
    }
  );

  // GET /api/v1/leaderboard/contributors — combined score
  // score = test_count + 3*outage_count + 2*verified_outage_bonus
  fastify.get<{ Querystring: { period?: string; limit?: string } }>(
    '/api/v1/leaderboard/contributors',
    async (request, reply) => {
      const parsed = QuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
      const { period, limit } = parsed.data;
      const interval = periodInterval(period);

      const rows = await sql`
        WITH tests AS (
          SELECT d.user_id, COUNT(*)::int AS test_count, MAX(st.recorded_at) AS last_at
          FROM speed_tests st
          JOIN devices d ON d.id = st.device_id
          WHERE d.user_id IS NOT NULL
            AND st.recorded_at > NOW() - INTERVAL '${sql.unsafe(interval)}'
          GROUP BY d.user_id
        ),
        outages AS (
          SELECT d.user_id,
                 COUNT(*)::int AS report_count,
                 COUNT(*) FILTER (WHERE o.is_verified)::int AS verified_count,
                 MAX(o.reported_at) AS last_at
          FROM outage_reports o
          JOIN devices d ON d.id = o.device_id
          WHERE d.user_id IS NOT NULL
            AND o.reported_at > NOW() - INTERVAL '${sql.unsafe(interval)}'
          GROUP BY d.user_id
        ),
        merged AS (
          SELECT
            COALESCE(t.user_id, o.user_id) AS user_id,
            COALESCE(t.test_count, 0) AS test_count,
            COALESCE(o.report_count, 0) AS report_count,
            COALESCE(o.verified_count, 0) AS verified_count,
            GREATEST(COALESCE(t.last_at, o.last_at), COALESCE(o.last_at, t.last_at)) AS last_at
          FROM tests t
          FULL OUTER JOIN outages o ON t.user_id = o.user_id
        )
        SELECT
          m.user_id,
          COALESCE(u.display_name, 'Người dùng #' || SUBSTRING(u.id::text FROM 1 FOR 8)) AS display_name,
          m.test_count,
          m.report_count,
          m.verified_count,
          (m.test_count + 3 * m.report_count + 2 * m.verified_count)::int AS score,
          m.last_at,
          ROW_NUMBER() OVER (
            ORDER BY (m.test_count + 3 * m.report_count + 2 * m.verified_count) DESC,
                     m.last_at DESC
          )::int AS rank
        FROM merged m
        JOIN users u ON u.id = m.user_id
        ORDER BY score DESC, last_at DESC
        LIMIT ${limit}
      `;

      const enriched = await attachBadges(rows as any);
      return reply.send({ period, leaderboard: enriched });
    }
  );

  // GET /api/v1/leaderboard/me — current user's rank in each board
  fastify.get<{ Querystring: { period?: string } }>(
    '/api/v1/leaderboard/me',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      if (request.user.type !== 'user') {
        return reply.status(403).send({ error: 'User token required' });
      }
      const userId = request.user.userId;
      const periodParsed = PeriodSchema.safeParse(request.query.period);
      const period = periodParsed.success ? periodParsed.data : 'month';
      const interval = periodInterval(period);

      const [me] = await sql`
        WITH tests AS (
          SELECT d.user_id, COUNT(*)::int AS test_count
          FROM speed_tests st
          JOIN devices d ON d.id = st.device_id
          WHERE d.user_id IS NOT NULL
            AND st.recorded_at > NOW() - INTERVAL '${sql.unsafe(interval)}'
          GROUP BY d.user_id
        ),
        outages AS (
          SELECT d.user_id,
                 COUNT(*)::int AS report_count,
                 COUNT(*) FILTER (WHERE o.is_verified)::int AS verified_count
          FROM outage_reports o
          JOIN devices d ON d.id = o.device_id
          WHERE d.user_id IS NOT NULL
            AND o.reported_at > NOW() - INTERVAL '${sql.unsafe(interval)}'
          GROUP BY d.user_id
        ),
        merged AS (
          SELECT
            COALESCE(t.user_id, o.user_id) AS user_id,
            COALESCE(t.test_count, 0) AS test_count,
            COALESCE(o.report_count, 0) AS report_count,
            COALESCE(o.verified_count, 0) AS verified_count,
            (COALESCE(t.test_count, 0) + 3 * COALESCE(o.report_count, 0) + 2 * COALESCE(o.verified_count, 0)) AS score
          FROM tests t
          FULL OUTER JOIN outages o ON t.user_id = o.user_id
        ),
        ranked AS (
          SELECT *,
            RANK() OVER (ORDER BY score DESC) AS rank,
            COUNT(*) OVER () AS total_participants
          FROM merged
        )
        SELECT
          user_id, test_count, report_count, verified_count, score,
          rank::int AS rank, total_participants::int AS total_participants
        FROM ranked
        WHERE user_id = ${userId}
      `;

      if (!me) {
        return reply.send({
          period,
          rank: null,
          totalParticipants: 0,
          stats: { testCount: 0, reportCount: 0, verifiedCount: 0, score: 0 },
        });
      }

      return reply.send({
        period,
        rank: me.rank,
        totalParticipants: me.totalParticipants,
        stats: {
          testCount: me.testCount,
          reportCount: me.reportCount,
          verifiedCount: me.verifiedCount,
          score: me.score,
        },
      });
    }
  );
};
