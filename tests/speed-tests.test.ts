import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, truncateAll, closeAll, uniqueDeviceUid, vnCoord, registerDeviceForTest } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let testDeviceUid: string;
let deviceToken: string;
const authHeader = () => ({ authorization: `Bearer ${deviceToken}` });

before(async () => {
  app = await buildApp();
  await truncateAll();
  testDeviceUid = uniqueDeviceUid('speed');
  deviceToken = await registerDeviceForTest(app, testDeviceUid);
});

after(async () => closeAll(app));

describe('Speed tests', () => {

  test('Submit without auth → 401', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/speed-tests',
      payload: {
        carrierName: 'Viettel', networkType: '5G',
        downloadMbps: 100, uploadMbps: 50, latencyMs: 20,
        ...vnCoord(),
      },
    });
    assert.equal(res.statusCode, 401);
  });

  test('Submit — happy path with signal sample', async () => {
    const coord = vnCoord();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/speed-tests',
      headers: authHeader(),
      payload: {
        carrierName: 'Viettel',
        networkType: '5G',
        downloadMbps: 350.5,
        uploadMbps: 80.2,
        latencyMs: 18,
        ...coord,
        province: 'Da Nang',
        district: 'Hai Chau',
        signalSample: { rsrpDbm: -85, sinrDb: 12.5, band: 'n78', cellId: 12345 },
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.ok(body.speedTest.id);
    assert.ok(body.speedTest.recordedAt, 'recordedAt should be camelCased');
  });

  test('Submit with garbage token → 401', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/speed-tests',
      headers: { authorization: 'Bearer not-a-real-jwt' },
      payload: {
        carrierName: 'Viettel', networkType: '5G',
        downloadMbps: 100, uploadMbps: 50, latencyMs: 20,
        ...vnCoord(),
      },
    });
    assert.equal(res.statusCode, 401);
  });

  test('Submit — out-of-VN coordinate rejected by Zod', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/speed-tests',
      headers: authHeader(),
      payload: {
        carrierName: 'Viettel', networkType: '5G',
        downloadMbps: 100, uploadMbps: 50, latencyMs: 20,
        latitude: 35.6, longitude: 139.7, // Tokyo
      },
    });
    assert.equal(res.statusCode, 400);
  });

  test('Submit — RSRP outside valid range rejected', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/speed-tests',
      headers: authHeader(),
      payload: {
        carrierName: 'Viettel', networkType: '5G',
        downloadMbps: 100, uploadMbps: 50, latencyMs: 20,
        ...vnCoord(),
        signalSample: { rsrpDbm: -200 }, // out of range
      },
    });
    assert.equal(res.statusCode, 400);
  });

  test('GET /speed-tests/recent — returns nearby with distance_m', async () => {
    const coord = vnCoord(0.0001);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/speed-tests/recent?lat=${coord.latitude}&lng=${coord.longitude}&radius=10000`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.tests));
    assert.ok(body.tests.length > 0, 'should find earlier inserted test');
    const t = body.tests[0];
    assert.ok('distanceM' in t, 'distanceM should be camelCased on response');
    assert.ok(typeof t.downloadMbps === 'string' || typeof t.downloadMbps === 'number');
  });

  test('GET /speed-tests/recent — invalid lat/lng → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/speed-tests/recent?lat=foo&lng=bar' });
    assert.equal(res.statusCode, 400);
  });

  test('GET /speed-tests/recent — filter by carrier', async () => {
    const coord = vnCoord(0.0001);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/speed-tests/recent?lat=${coord.latitude}&lng=${coord.longitude}&carrier=Viettel&radius=10000`,
    });
    assert.equal(res.statusCode, 200);
    for (const t of res.json().tests) {
      assert.equal(t.carrierName, 'Viettel');
    }
  });

});
