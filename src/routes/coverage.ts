import type { FastifyPluginAsync } from 'fastify';
import sql from '../db/index.js';

export const coverageRoute: FastifyPluginAsync = async (fastify) => {

  // GET /api/v1/coverage — Aggregated coverage data for a location
  fastify.get<{
    Querystring: { lat: string; lng: string; radius?: string; carrier?: string; network?: string; days?: string }
  }>('/api/v1/coverage', async (request, reply) => {
    const lat = parseFloat(request.query.lat);
    const lng = parseFloat(request.query.lng);
    const radius = parseInt(request.query.radius || '1000');
    const carrier = request.query.carrier || null;
    const network = request.query.network || null;
    const days = parseInt(request.query.days || '30');

    if (isNaN(lat) || isNaN(lng)) {
      return reply.status(400).send({ error: 'Invalid lat/lng' });
    }

    const coverage = await sql`
      SELECT * FROM coverage_grid(${lat}, ${lng}, ${radius}, ${carrier}, ${network}, ${days})
    `;

    return reply.send({
      location: { latitude: lat, longitude: lng },
      radiusM: radius,
      coverage,
    });
  });

  // GET /api/v1/coverage/heatmap — Heatmap data for visualization
  // Returns aggregated points within a bounding box
  fastify.get<{
    Querystring: {
      minLat: string; maxLat: string; minLng: string; maxLng: string;
      carrier?: string; network?: string; days?: string;
    }
  }>('/api/v1/coverage/heatmap', async (request, reply) => {
    const minLat = parseFloat(request.query.minLat);
    const maxLat = parseFloat(request.query.maxLat);
    const minLng = parseFloat(request.query.minLng);
    const maxLng = parseFloat(request.query.maxLng);
    const carrier = request.query.carrier || null;
    const network = request.query.network || null;
    const days = parseInt(request.query.days || '30');

    if ([minLat, maxLat, minLng, maxLng].some(isNaN)) {
      return reply.status(400).send({ error: 'Invalid bounding box' });
    }

    // Group by ~100m grid cells (rough lat/lng quantization)
    const points = await sql`
      SELECT
        ROUND(latitude::numeric, 3) AS lat_grid,
        ROUND(longitude::numeric, 3) AS lng_grid,
        carrier_name,
        network_type,
        COUNT(*)::int AS sample_count,
        ROUND(AVG(download_mbps)::numeric, 1) AS avg_download_mbps,
        ROUND(AVG(latency_ms)::numeric, 0) AS avg_latency_ms
      FROM speed_tests
      WHERE
        recorded_at > NOW() - (${days} || ' days')::interval
        AND latitude BETWEEN ${minLat} AND ${maxLat}
        AND longitude BETWEEN ${minLng} AND ${maxLng}
        ${carrier ? sql`AND carrier_name = ${carrier}` : sql``}
        ${network ? sql`AND network_type = ${network}` : sql``}
      GROUP BY lat_grid, lng_grid, carrier_name, network_type
      HAVING COUNT(*) >= 1
      ORDER BY sample_count DESC
      LIMIT 5000
    `;

    return reply.send({ points, count: points.length });
  });

  // GET /api/v1/coverage/buildings — Building-level coverage (hyper-local feature)
  fastify.get<{ Querystring: { name?: string; province?: string } }>(
    '/api/v1/coverage/buildings',
    async (request, reply) => {
      const name = request.query.name;
      const province = request.query.province;

      if (!name && !province) {
        return reply.status(400).send({ error: 'Provide name or province' });
      }

      const buildings = await sql`
        SELECT
          building_name,
          province,
          district,
          ward,
          carrier_name,
          network_type,
          COUNT(*)::int AS sample_count,
          ROUND(AVG(download_mbps)::numeric, 1) AS avg_download_mbps,
          ROUND(AVG(upload_mbps)::numeric, 1) AS avg_upload_mbps,
          ROUND(AVG(latency_ms)::numeric, 0) AS avg_latency_ms,
          MAX(recorded_at) AS last_test
        FROM speed_tests
        WHERE
          building_name IS NOT NULL
          AND recorded_at > NOW() - INTERVAL '90 days'
          ${name ? sql`AND building_name ILIKE ${'%' + name + '%'}` : sql``}
          ${province ? sql`AND province = ${province}` : sql``}
        GROUP BY building_name, province, district, ward, carrier_name, network_type
        ORDER BY building_name, carrier_name, network_type
        LIMIT 500
      `;

      return reply.send({ buildings, count: buildings.length });
    }
  );
};
