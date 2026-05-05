import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, truncateAll, closeAll, uniqueDeviceUid } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

before(async () => {
  app = await buildApp();
  await truncateAll();
});

after(async () => closeAll(app));

describe('Devices', () => {

  test('Register device — happy path returns device + deviceToken', async () => {
    const uid = uniqueDeviceUid();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/register',
      payload: {
        deviceUid: uid,
        platform: 'ios',
        osVersion: '18.0',
        appVersion: '1.0.0',
        deviceModel: 'iPhone 15 Pro',
        carrierName: 'Viettel',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.device.deviceUid, uid);
    assert.equal(body.device.platform, 'ios');
    assert.ok(body.deviceToken, 'deviceToken should be issued');
    // Token is JWT — decode header, expect 3 base64 segments
    assert.equal(body.deviceToken.split('.').length, 3);
  });

  test('Register with valid user JWT links device to user', async () => {
    // Full OTP flow to get a real user
    const phone = '0905555555';
    const otp = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone } });
    const userToken = (await app.inject({
      method: 'POST', url: '/api/v1/auth/otp/verify',
      payload: { phone, code: otp.json().devOtp },
    })).json().token;

    const uid = uniqueDeviceUid();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/register',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { deviceUid: uid, platform: 'web' },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().deviceToken);
  });

  test('Register — invalid platform rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/register',
      payload: { deviceUid: uniqueDeviceUid(), platform: 'symbian' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('Register twice — upsert (no duplicate)', async () => {
    const uid = uniqueDeviceUid();
    await app.inject({
      method: 'POST', url: '/api/v1/devices/register',
      payload: { deviceUid: uid, platform: 'android' },
    });
    const res2 = await app.inject({
      method: 'POST', url: '/api/v1/devices/register',
      payload: { deviceUid: uid, platform: 'android', appVersion: '2.0.0' },
    });
    assert.equal(res2.statusCode, 200);
  });

  test('GET /devices/:uid — found', async () => {
    const uid = uniqueDeviceUid();
    await app.inject({
      method: 'POST', url: '/api/v1/devices/register',
      payload: { deviceUid: uid, platform: 'web' },
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/devices/${uid}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().device.deviceUid, uid);
  });

  test('GET /devices/:uid — 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/devices/nonexistent-uid-xyz' });
    assert.equal(res.statusCode, 404);
  });

});
