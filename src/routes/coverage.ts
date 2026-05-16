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
  // Returns aggregated points within a bounding box.
  //
  // Optional `endDate` (ISO yyyy-mm-dd) cho phép xem snapshot lịch sử —
  // query window = [endDate - days, endDate]. Default = now → window = last N days.
  fastify.get<{
    Querystring: {
      minLat: string; maxLat: string; minLng: string; maxLng: string;
      carrier?: string; network?: string; days?: string; endDate?: string;
    }
  }>('/api/v1/coverage/heatmap', async (request, reply) => {
    const minLat = parseFloat(request.query.minLat);
    const maxLat = parseFloat(request.query.maxLat);
    const minLng = parseFloat(request.query.minLng);
    const maxLng = parseFloat(request.query.maxLng);
    const carrier = request.query.carrier || null;
    const network = request.query.network || null;
    const days = parseInt(request.query.days || '30');

    // Parse endDate cẩn thận — chỉ accept ISO date hoặc datetime hợp lệ
    let endDate: Date | null = null;
    if (request.query.endDate) {
      const parsed = new Date(request.query.endDate);
      if (isNaN(parsed.getTime())) {
        return reply.status(400).send({ error: 'Invalid endDate (expected ISO date)' });
      }
      endDate = parsed;
    }

    if ([minLat, maxLat, minLng, maxLng].some(isNaN)) {
      return reply.status(400).send({ error: 'Invalid bounding box' });
    }

    // Build time window. endDate null → use NOW(). Else use endDate as upper bound.
    const points = endDate
      ? await sql`
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
            recorded_at <= ${endDate}
            AND recorded_at >  ${endDate}::timestamptz - (${days} || ' days')::interval
            AND latitude BETWEEN ${minLat} AND ${maxLat}
            AND longitude BETWEEN ${minLng} AND ${maxLng}
            ${carrier ? sql`AND carrier_name = ${carrier}` : sql``}
            ${network ? sql`AND network_type = ${network}` : sql``}
          GROUP BY lat_grid, lng_grid, carrier_name, network_type
          HAVING COUNT(*) >= 1
          ORDER BY sample_count DESC
          LIMIT 5000
        `
      : await sql`
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

    return reply.send({ points, count: points.length, endDate, days });
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

  // GET /api/v1/coverage/history — Time-series tại 1 điểm
  // Trả về list { month, carrier, sampleCount, avgDownloadMbps, ... }
  // Dùng bbox prefilter (~500m bằng độ lat/lng) thay vì PostGIS ST_DWithin để giữ
  // light-weight, không cần extension.
  fastify.get<{
    Querystring: { lat: string; lng: string; radius?: string; months?: string };
  }>('/api/v1/coverage/history', async (request, reply) => {
    const lat = parseFloat(request.query.lat);
    const lng = parseFloat(request.query.lng);
    const radius = parseInt(request.query.radius || '500');   // metres
    const months = Math.min(parseInt(request.query.months || '6'), 24);

    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return reply.status(400).send({ error: 'Invalid lat/lng' });
    }

    // ~111km per degree latitude; longitude scales with cos(lat).
    const degLat = radius / 111_000;
    const degLng = radius / (111_000 * Math.cos((lat * Math.PI) / 180));
    const minLat = lat - degLat, maxLat = lat + degLat;
    const minLng = lng - degLng, maxLng = lng + degLng;

    const history = await sql`
      SELECT
        TO_CHAR(DATE_TRUNC('month', recorded_at), 'YYYY-MM')        AS month,
        carrier_name,
        network_type,
        COUNT(*)::int                                                AS sample_count,
        ROUND(AVG(download_mbps)::numeric, 1)::float                 AS avg_download_mbps,
        ROUND(AVG(upload_mbps)::numeric, 1)::float                   AS avg_upload_mbps,
        ROUND(AVG(latency_ms)::numeric, 0)::int                      AS avg_latency_ms
      FROM speed_tests
      WHERE
        latitude  BETWEEN ${minLat} AND ${maxLat}
        AND longitude BETWEEN ${minLng} AND ${maxLng}
        AND recorded_at > NOW() - (${months} || ' months')::interval
      GROUP BY month, carrier_name, network_type
      HAVING COUNT(*) >= 1
      ORDER BY month DESC, sample_count DESC
    `;

    return reply.send({
      location: { latitude: lat, longitude: lng, radiusM: radius },
      monthsBack: months,
      history,
      totalSamples: history.reduce((s: number, r: any) => s + r.sample_count, 0),
    });
  });
};
