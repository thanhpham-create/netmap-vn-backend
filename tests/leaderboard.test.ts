import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, truncateAll, closeAll, uniqueDeviceUid, vnCoord } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

// 3 users: alice (10 tests), bob (5 tests + 4 outages), charlie (1 test). Plus 1 anonymous device (should NOT appear).
const users = [
  { phone: '0911111101', name: 'Alice', tests: 10, outages: 0 },
  { phone: '0911111102', name: 'Bob',   tests: 5,  outages: 4 },  // Bob does outages too
  { phone: '0911111103', name: 'Charlie', tests: 1, outages: 0 },
];
const userTokens: Record<string, string> = {};
const deviceTokens: Record<string, string> = {};
let anonDeviceToken = '';

async function loginUser(app: FastifyInstance, phone: string): Promise<string> {
  const otpRes = await app.inject({
    method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone },
  });
  const code = otpRes.json().devOtp;
  const verifyRes = await app.inject({
    method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone, code },
  });
  return verifyRes.json().token;
}

async function registerLinkedDevice(
  app: FastifyInstance, userToken: string, uid: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/devices/register',
    headers: { authorization: `Bearer ${userToken}` },
    payload: { deviceUid: uid, platform: 'ios', carrierName: 'Viettel' },
  });
  return res.json().deviceToken;
}

async function submitTest(app: FastifyInstance, deviceToken: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/speed-tests',
    headers: { authorization: `Bearer ${deviceToken}` },
    payload: {
      carrierName: 'Viettel',
      networkType: '5G',
      downloadMbps: 100,
      uploadMbps: 50,
      latencyMs: 20,
      ...vnCoord(),
    },
  });
}

async function reportOutage(app: FastifyInstance, deviceToken: string, lat: number, lng: number) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/outages/report',
    headers: { authorization: `Bearer ${deviceToken}` },
    payload: {
      carrierName: 'Viettel',
      outageType: 'no_signal',
      latitude: lat,
      longitude: lng,
    },
  });
}

before(async () => {
  app = await buildApp();
  await truncateAll();

  // Set up linked users + their devices
  for (const u of users) {
    const userToken = await loginUser(app, u.phone);
    userTokens[u.name] = userToken;
    const uid = uniqueDeviceUid(u.name);
    deviceTokens[u.name] = await registerLinkedDevice(app, userToken, uid);
  }

  // Set up an anonymous device — its tests should NOT appear in leaderboard
  const anonRegister = await app.inject({
    method: 'POST',
    url: '/api/v1/devices/register',
    payload: { deviceUid: uniqueDeviceUid('anon'), platform: 'web' },
  });
  anonDeviceToken = anonRegister.json().deviceToken;

  // Submit data
  for (const u of users) {
    for (let i = 0; i < u.tests; i++) {
      await submitTest(app, deviceTokens[u.name]);
    }
    for (let i = 0; i < u.outages; i++) {
      // Spread across different locations to avoid cluster auto-verify side effects
      await reportOutage(app, deviceTokens[u.name], 16 + i * 0.5, 108 + i * 0.5);
    }
  }
  // Anonymous device submits 100 tests — should not show on leaderboard
  for (let i = 0; i < 100; i++) {
    await submitTest(app, anonDeviceToken);
  }
});

after(async () => closeAll(app));

describe('Leaderboard', () => {

  test('GET /leaderboard/speed-tests — Alice 1st (10 tests), then Bob (5), Charlie (1). Anonymous excluded.', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leaderboard/speed-tests?period=month&limit=10',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.period, 'month');
    assert.ok(Array.isArray(body.leaderboard));
    assert.equal(body.leaderboard.length, 3, 'should have 3 users (anonymous device excluded)');

    const ranks = body.leaderboard;
    assert.equal(ranks[0].rank, 1);
    assert.equal(ranks[0].displayName, 'Alice');
    assert.equal(ranks[0].testCount, 10);
    assert.equal(ranks[1].displayName, 'Bob');
    assert.equal(ranks[1].testCount, 5);
    assert.equal(ranks[2].displayName, 'Charlie');
    assert.equal(ranks[2].testCount, 1);
  });

  test('GET /leaderboard/outages — only Bob should appear', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leaderboard/outages?period=month',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.leaderboard.length, 1);
    assert.equal(body.leaderboard[0].displayName, 'Bob');
    assert.equal(body.leaderboard[0].reportCount, 4);
  });

  test('GET /leaderboard/contributors — combined score: Bob = 5 + 3*4 = 17, Alice = 10, Charlie = 1', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leaderboard/contributors?period=month',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.leaderboard.length, 3);
    assert.equal(body.leaderboard[0].displayName, 'Bob');
    assert.ok(body.leaderboard[0].score >= 17, `Bob score should be at least 17, got ${body.leaderboard[0].score}`);
    assert.equal(body.leaderboard[1].displayName, 'Alice');
    assert.equal(body.leaderboard[1].score, 10);
    assert.equal(body.leaderboard[2].displayName, 'Charlie');
    assert.equal(body.leaderboard[2].score, 1);
  });

  test('GET /leaderboard/me — returns rank for authenticated user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leaderboard/me?period=month',
      headers: { authorization: `Bearer ${userTokens['Bob']}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.rank, 1, 'Bob should be rank 1 in combined leaderboard');
    assert.equal(body.totalParticipants, 3);
    assert.equal(body.stats.testCount, 5);
    assert.equal(body.stats.reportCount, 4);
  });

  test('GET /leaderboard/me — without auth → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/leaderboard/me' });
    assert.equal(res.statusCode, 401);
  });

  test('GET /leaderboard/me — device token rejected (user only)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leaderboard/me',
      headers: { authorization: `Bearer ${deviceTokens['Alice']}` },
    });
    assert.equal(res.statusCode, 403);
  });

  test('limit parameter respected', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leaderboard/speed-tests?period=month&limit=2',
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().leaderboard.length, 2);
  });

  test('invalid period rejected', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leaderboard/speed-tests?period=decade',
    });
    assert.equal(res.statusCode, 400);
  });

  test('GET /leaderboard/contributors?period=week — same data within 7d window', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/leaderboard/contributors?period=week',
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().leaderboard.length >= 1);
  });

});
