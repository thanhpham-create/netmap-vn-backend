import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, truncateAll, closeAll, uniqueDeviceUid, registerDeviceForTest } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
const deviceTokens: string[] = [];

before(async () => {
  app = await buildApp();
  await truncateAll();
  // Pre-register 10 devices so we can simulate a cluster
  for (let i = 0; i < 10; i++) {
    const uid = uniqueDeviceUid('out');
    const tok = await registerDeviceForTest(app, uid, 'Viettel');
    deviceTokens.push(tok);
  }
});

after(async () => closeAll(app));

describe('Outages', () => {

  const auth = (i: number) => ({ authorization: `Bearer ${deviceTokens[i]}` });

  test('Report — without auth → 401', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/outages/report',
      payload: {
        carrierName: 'Viettel', outageType: 'no_signal',
        latitude: 21.0285, longitude: 105.8542,
      },
    });
    assert.equal(res.statusCode, 401);
  });

  test('Report — happy path, single report not verified', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/outages/report',
      headers: auth(0),
      payload: {
        carrierName: 'Viettel', outageType: 'no_signal',
        latitude: 21.0285, longitude: 105.8542,
        province: 'Ha Noi', district: 'Hoan Kiem', ward: 'Ly Thai To',
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.report.clusterSize, 1);
    assert.equal(body.report.isVerified, false);
  });

  test('Cluster of 5 → auto-verified, AND prior reports backfilled', async () => {
    // Use a fresh location to isolate the cluster
    const baseLat = 10.7769;  // HCMC
    const baseLng = 106.7009;

    const responses = [];
    for (let i = 1; i < 5; i++) {
      const r = await app.inject({
        method: 'POST', url: '/api/v1/outages/report',
        headers: auth(i),
        payload: {
          carrierName: 'MobiFone', outageType: 'no_data',
          latitude: baseLat + i * 0.0001,
          longitude: baseLng + i * 0.0001,
          province: 'HCM', district: 'D1',
        },
      });
      responses.push(r.json());
    }
    // Reports 1..4 should be unverified
    assert.equal(responses[0].report.isVerified, false);
    assert.equal(responses[3].report.clusterSize, 4);

    // 5th report tips it over → should auto-verify
    const fifth = await app.inject({
      method: 'POST', url: '/api/v1/outages/report',
      headers: auth(5),
      payload: {
        carrierName: 'MobiFone', outageType: 'no_data',
        latitude: baseLat, longitude: baseLng,
        province: 'HCM', district: 'D1',
      },
    });
    assert.equal(fifth.statusCode, 201);
    const body = fifth.json();
    assert.equal(body.report.isVerified, true);
    assert.equal(body.report.clusterSize, 5);
    assert.match(body.message, /Đã xác nhận/);

    // Active outages should now find this cluster
    const active = await app.inject({
      method: 'GET',
      url: `/api/v1/outages/active?lat=${baseLat}&lng=${baseLng}&radius=5000&hours=6`,
    });
    assert.equal(active.statusCode, 200);
    const aBody = active.json();
    assert.equal(aBody.hasActiveOutages, true);
    const cluster = aBody.outages.find((o: any) => o.carrierName === 'MobiFone');
    assert.ok(cluster, 'should find MobiFone cluster');
    assert.ok(cluster.reportCount >= 5);
  });

  test('Report — outageType invalid → 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/outages/report',
      headers: auth(0),
      payload: {
        carrierName: 'Viettel', outageType: 'space-aliens',
        latitude: 16, longitude: 108,
      },
    });
    assert.equal(res.statusCode, 400);
  });

  test('GET /outages/active — invalid lat → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/outages/active?lat=foo&lng=bar' });
    assert.equal(res.statusCode, 400);
  });

  test('GET /outages/national — returns summary', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/outages/national' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok('summary' in body);
    assert.ok('generatedAt' in body);
  });

  test('Resolve outage — requires admin/operator role', async () => {
    // First submit a fresh report to get an ID
    const r = await app.inject({
      method: 'POST', url: '/api/v1/outages/report',
      headers: auth(6),
      payload: {
        carrierName: 'Vietnamobile', outageType: 'slow',
        latitude: 12.2388, longitude: 109.1967, // Nha Trang
      },
    });
    const outageId = r.json().report.id;

    // Without auth → 401
    const noAuth = await app.inject({
      method: 'POST', url: `/api/v1/outages/${outageId}/resolve`,
    });
    assert.equal(noAuth.statusCode, 401);

    // With device token → 403 (not a user token)
    const deviceForbidden = await app.inject({
      method: 'POST', url: `/api/v1/outages/${outageId}/resolve`,
      headers: auth(0),
    });
    assert.equal(deviceForbidden.statusCode, 403);

    // With consumer user JWT → 403
    const consumerTok = app.jwt.sign({ type: 'user', userId: '00000000-0000-0000-0000-000000000001', phone: '0900000001', role: 'consumer' });
    const forbidden = await app.inject({
      method: 'POST', url: `/api/v1/outages/${outageId}/resolve`,
      headers: { authorization: `Bearer ${consumerTok}` },
    });
    assert.equal(forbidden.statusCode, 403);

    // With admin user JWT → 200
    const adminTok = app.jwt.sign({ type: 'user', userId: '00000000-0000-0000-0000-000000000099', phone: '0900000099', role: 'admin' });
    const ok = await app.inject({
      method: 'POST', url: `/api/v1/outages/${outageId}/resolve`,
      headers: { authorization: `Bearer ${adminTok}` },
    });
    assert.equal(ok.statusCode, 200);
    assert.ok(ok.json().resolvedCount >= 1);
  });

});
