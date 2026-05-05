// Badge endpoints — list all badges + per-user earned status.

import type { FastifyPluginAsync } from 'fastify';
import { BADGES, computeBadges } from '../lib/badges.js';

export const badgesRoute: FastifyPluginAsync = async (fastify) => {

  // GET /api/v1/badges — All badges (public, for marketing/info page)
  fastify.get('/api/v1/badges', async (_request, reply) => {
    return reply.send({ badges: BADGES });
  });

  // GET /api/v1/badges/me — Current user's earned + progress
  fastify.get(
    '/api/v1/badges/me',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      if (request.user.type !== 'user') {
        return reply.status(403).send({ error: 'User token required' });
      }
      const badges = await computeBadges(request.user.userId);
      const earnedCount = badges.filter((b) => b.earned).length;
      return reply.send({ badges, earnedCount, totalCount: badges.length });
    }
  );

  // GET /api/v1/badges/:userId — Public profile badges (someone else's)
  fastify.get<{ Params: { userId: string } }>(
    '/api/v1/badges/:userId',
    async (request, reply) => {
      const { userId } = request.params;
      // Only return earned badges (privacy: don't expose progress to others)
      const all = await computeBadges(userId);
      const earned = all.filter((b) => b.earned).map((b) => ({
        id: b.id, name: b.name, emoji: b.emoji, description: b.description,
        category: b.category, earnedAt: b.earnedAt,
      }));
      return reply.send({ badges: earned, earnedCount: earned.length });
    }
  );
};
