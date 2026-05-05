import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, truncateAll, closeAll, uniqueDeviceUid, vnCoord } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let userToken = '';
let deviceToken = '';

before(async () => {
  app = await buildApp();
  await truncateAll();

  // Create a user
  const phone = '0911223344';
  await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone } });
  const otpRes = await app.inject({
    method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone },
  });
  // ^ first request created OTP; second hits cooldown but that's fine since we already have OTP
  // Actually we don't have access to OTP after first call in this test setup since cooldown returns 429.
  // Just call once and read code from earlier response
  const phoneNew = '0911223345';
  const r1 = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone: phoneNew } });
  const code = r1.json().devOtp;
  const r2 = await app.inject({
    method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone: phoneNew, code },
  });
  userToken = r2.json().token;

  // Register a device linked to user
  const dRes = await app.inject({
    method: 'POST',
    url: '/api/v1/devices/register',
    headers: { authorization: `Bearer ${userToken}` },
    payload: { deviceUid: uniqueDeviceUid('badge'), platform: 'ios', carrierName: 'Viettel' },
  });
  deviceToken = dRes.json().deviceToken;

  // Submit 1 speed test (5G with high speed) to earn first_test + pioneer_5g + speed_demon
  await app.inject({
    method: 'POST',
    url: '/api/v1/speed-tests',
    headers: { authorization: `Bearer ${deviceToken}` },
    payload: {
      carrierName: 'Viettel',
      networkType: '5G',
      downloadMbps: 600,
      uploadMbps: 80,
      latencyMs: 15,
      ...vnCoord(),
      province: 'Đà Nẵng',
    },
  });
});

after(async () => closeAll(app));

describe('Badges', () => {

  test('GET /badges returns full list (public)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/badges' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.badges));
    assert.ok(body.badges.length >= 14);
    const ids = body.badges.map((b: any) => b.id);
    assert.ok(ids.includes('first_test'));
    assert.ok(ids.includes('pioneer_5g'));
  });

  test('GET /badges/me — earns first_test + pioneer_5g + speed_demon after 600 Mbps 5G test', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/badges/me',
      headers: { authorization: `Bearer ${userToken}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    const earned = body.badges.filter((b: any) => b.earned).map((b: any) => b.id);
    assert.ok(earned.includes('first_test'));
    assert.ok(earned.includes('pioneer_5g'));
    assert.ok(earned.includes('speed_demon'));
    assert.equal(body.totalCount, 14);
    assert.ok(body.earnedCount >= 3);
  });

  test('GET /badges/me without auth → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/badges/me' });
    assert.equal(res.statusCode, 401);
  });

  test('Progress increments toward unearned badges', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/badges/me',
      headers: { authorization: `Bearer ${userToken}` },
    });
    const tester = res.json().badges.find((b: any) => b.id === 'tester');
    assert.equal(tester.progress, 1);  // 1 test done, threshold 10
    assert.equal(tester.earned, false);
  });
});
