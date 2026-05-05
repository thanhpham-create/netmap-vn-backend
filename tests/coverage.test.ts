import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, truncateAll, closeAll, uniqueDeviceUid, registerDeviceForTest } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let uid: string;
let deviceToken: string;

before(async () => {
  app = await buildApp();
  await truncateAll();
  uid = uniqueDeviceUid('coverage');
  deviceToken = await registerDeviceForTest(app, uid, 'VNPT');

  // Seed several speed tests around the same location
  for (let i = 0; i < 8; i++) {
    await app.inject({
      method: 'POST', url: '/api/v1/speed-tests',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        carrierName: i % 2 === 0 ? 'Viettel' : 'VNPT',
        networkType: i % 3 === 0 ? '5G' : '4G',
        downloadMbps: 50 + i * 10,
        uploadMbps: 20 + i * 5,
        latencyMs: 15 + i,
        latitude: 16.0544 + i * 0.0001,
        longitude: 108.2022 + i * 0.0001,
        province: 'Da Nang',
        district: 'Hai Chau',
        buildingName: i % 2 === 0 ? 'Vincom Plaza Da Nang' : null,
        signalSample: { rsrpDbm: -80 - i, sinrDb: 10 - i * 0.5 },
      },
    });
  }
});

after(async () => closeAll(app));

describe('Coverage', () => {

  test('GET /coverage — aggregated stats around point', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/coverage?lat=16.0544&lng=108.2022&radius=2000',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.location.latitude, 16.0544);
    assert.ok(Array.isArray(body.coverage));
    assert.ok(body.coverage.length > 0);
    const row = body.coverage[0];
    // Function returns: carrier_name, network_type, sample_count, ...
    // postgres-js toCamel renames them.
    assert.ok('carrierName' in row);
    assert.ok('coverageQuality' in row);
    assert.ok(['excellent','good','fair','poor','very_poor'].includes(row.coverageQuality));
  });

  test('GET /coverage — invalid lat → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/coverage?lat=abc&lng=108' });
    assert.equal(res.statusCode, 400);
  });

  test('GET /coverage/heatmap — bbox returns points', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/coverage/heatmap?minLat=16&maxLat=16.1&minLng=108.1&maxLng=108.3',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.points));
    assert.ok(body.points.length > 0);
  });

  test('GET /coverage/heatmap — invalid bbox → 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/coverage/heatmap?minLat=foo&maxLat=bar&minLng=baz&maxLng=qux',
    });
    assert.equal(res.statusCode, 400);
  });

  test('GET /coverage/buildings — search by name', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/coverage/buildings?name=Vincom',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.buildings.length > 0);
    assert.match(body.buildings[0].buildingName, /Vincom/i);
  });

  test('GET /coverage/buildings — no params → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/coverage/buildings' });
    assert.equal(res.statusCode, 400);
  });

});
