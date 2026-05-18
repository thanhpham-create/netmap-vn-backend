// Measurement endpoints for client-side speed test.
// Anonymous (no auth) — actual speed test result is submitted via POST /speed-tests with auth.

import type { FastifyPluginAsync } from 'fastify';
import { randomBytes } from 'crypto';
import { detectCarrier } from '../lib/ip-carrier.js';

const MAX_DOWNLOAD_MB = 50;
const MAX_UPLOAD_MB = 25;

// Pre-generate random buffers for common sizes to avoid CPU thrash on each request.
// 25 MB is the default size for time-bounded client speedtest (chunked stream reads
// until timeout). Always served from pregen, never regen per-request.
const PREGEN: Map<number, Buffer> = new Map();
for (const mb of [1, 5, 10, 25]) {
  PREGEN.set(mb, randomBytes(mb * 1024 * 1024));
}

// Higher rate limit for /measure/* — speedtest legitimately makes many requests
// (5 pings + download + upload per test = ~10 requests). Exempt from global 60/min limit.
const measureRateLimit = {
  rateLimit: { max: 500, timeWindow: '1 minute' },
};

export const measureRoute: FastifyPluginAsync = async (fastify) => {

  // GET /api/v1/measure/ping — for latency measurement (cheap)
  fastify.get('/api/v1/measure/ping', { config: measureRateLimit }, async (_req, reply) => {
    return reply.send({ t: Date.now() });
  });

  // GET /api/v1/measure/whoami — Detect user's IP + carrier from ASN.
  // Privacy: server uses your public IP (already visible to it for any request)
  // to look up which carrier/ISP owns it. Result is cached 24h.
  fastify.get('/api/v1/measure/whoami', async (request, reply) => {
    const ip = request.ip;  // Fastify resolves x-forwarded-for via trustProxy
    const detection = await detectCarrier(ip);
    return reply.send(detection);
  });

  // GET /api/v1/measure/download/:sizeMb — return N MB of random bytes
  fastify.get<{ Params: { sizeMb: string } }>(
    '/api/v1/measure/download/:sizeMb',
    { config: measureRateLimit },
    async (request, reply) => {
      const sizeMb = parseInt(request.params.sizeMb);
      if (isNaN(sizeMb) || sizeMb <= 0 || sizeMb > MAX_DOWNLOAD_MB) {
        return reply.status(400).send({ error: `sizeMb must be 1..${MAX_DOWNLOAD_MB}` });
      }
      const buf = PREGEN.get(sizeMb) || randomBytes(sizeMb * 1024 * 1024);
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Cache-Control', 'no-store');
      return reply.send(buf);
    }
  );

  // Register a Buffer parser for octet-stream so request.body is the raw bytes
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_MB * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  // POST /api/v1/measure/upload — accept blob, return size and elapsed
  fastify.post(
    '/api/v1/measure/upload',
    { bodyLimit: MAX_UPLOAD_MB * 1024 * 1024, config: measureRateLimit },
    async (request, reply) => {
      const start = Date.now();
      const body = request.body as Buffer | undefined;
      const received = body ? body.length : 0;
      // Time spent in framework already includes upload time; report total
      const elapsedMs = Date.now() - start + 1; // +1 to avoid div-by-zero on tiny payloads
      return reply.send({ receivedBytes: received, elapsedMs });
    }
  );
};
