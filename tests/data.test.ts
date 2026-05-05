import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, truncateAll, closeAll, uniqueDeviceUid, vnCoord, registerDeviceForTest } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

before(async () => {
  app = await buildApp();
  await truncateAll();

  // Seed a few speed tests + an outage so the data endpoints have something to return
  const tok = await registerDeviceForTest(app, uniqueDeviceUid('data'), 'Viettel');
  for (let i = 0; i < 5; i++) {
    await app.inject({
      method: 'POST',
      url: '/api/v1/speed-tests',
      headers: { authorization: `Bearer ${tok}` },
      payload: {
        carrierName: 'Viettel',
        networkType: i % 2 ? '5G' : '4G',
        downloadMbps: 100 + i * 10,
        uploadMbps: 30,
        latencyMs: 20,
        ...vnCoord(),
        province: 'Đà Nẵng',
      },
    });
  }
});

after(async () => closeAll(app));

describe('Open Data API', () => {

  test('GET /data — index returns metadata', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/data' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.endpoints.speedTests);
    assert.ok(body.endpoints.outages);
    assert.ok(body.rateLimit);
    assert.equal(body.maxRowsPerRequest, 5000);
  });

  test('GET /data/speed-tests — JSON format default', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/data/speed-tests?limit=3',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.rows));
    assert.ok(body.rows.length <= 3);
    // Verify PII NOT exposed
    for (const r of body.rows) {
      assert.equal(r.deviceId, undefined);
      assert.equal(r.userId, undefined);
      assert.equal(r.phone, undefined);
    }
  });

  test('GET /data/speed-tests?format=csv → text/csv with attachment header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/data/speed-tests?format=csv&limit=2',
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type']?.toString() || '', /text\/csv/);
    assert.match(res.headers['content-disposition']?.toString() || '', /attachment/);
    const text = res.payload;
    // First line is header row
    const firstLine = text.split('\n')[0];
    assert.match(firstLine, /carrier_name/);
    assert.match(firstLine, /download_mbps/);
  });

  test('GET /data/speed-tests with invalid limit > 5000 → 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/data/speed-tests?limit=10000',
    });
    assert.equal(res.statusCode, 400);
  });

  test('GET /data/carriers-stats — daily aggregates', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/data/carriers-stats?days=7',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.rows));
    if (body.rows.length > 0) {
      const r = body.rows[0];
      assert.ok('carrierName' in r);
      assert.ok('avgDownloadMbps' in r);
      assert.ok('pct5g' in r);
    }
  });

  test('Rate limit headers exposed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/data',
    });
    assert.equal(res.statusCode, 200);
    // Headers may be lowercase
    const limit = res.headers['x-ratelimit-limit'];
    const remaining = res.headers['x-ratelimit-remaining'];
    assert.ok(limit, 'x-ratelimit-limit header should be present');
    assert.ok(remaining, 'x-ratelimit-remaining header should be present');
  });
});
