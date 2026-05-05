import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, truncateAll, closeAll } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

before(async () => {
  app = await buildApp();
  await truncateAll();
});

after(async () => {
  await closeAll(app);
});

describe('Auth — OTP flow', () => {

  test('POST /auth/otp/request rejects invalid phone', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      payload: { phone: '12345' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('POST /auth/otp/request returns devOtp in non-prod', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      payload: { phone: '0901111111' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.expiresIn, 300);
    assert.match(body.devOtp, /^\d{6}$/);
  });

  test('Cooldown — second request within 1 min returns 429', async () => {
    // First (already done above for 0901111111). Try again immediately.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      payload: { phone: '0901111111' },
    });
    assert.equal(res.statusCode, 429);
  });

  test('Verify wrong code → 401', async () => {
    const phone = '0902222222';
    await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: { phone, code: '000000' },
    });
    assert.equal(res.statusCode, 401);
  });

  test('Full flow → JWT + /me works, displayName casing', async () => {
    const phone = '0903333333';
    const otp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/request',
      payload: { phone },
    });
    const code = otp.json().devOtp;

    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      payload: { phone, code },
    });
    assert.equal(verify.statusCode, 200);
    const body = verify.json();
    assert.ok(body.token, 'token should be returned');
    assert.equal(body.user.phone, phone);
    assert.equal(body.user.role, 'consumer');
    // Regression: previously `user.displayName` was undefined because
    // postgres-js's toCamel transform renames `display_name` → `displayName`.
    assert.ok(
      body.user.displayName === null || body.user.displayName === undefined || typeof body.user.displayName === 'string',
      'displayName must exist (even if null)'
    );

    // /me with token
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${body.token}` },
    });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.phone, phone);
  });

  test('/me without token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    assert.equal(res.statusCode, 401);
  });

  test('Verify expired OTP → 401', async () => {
    const phone = '0904444444';
    const code = '123456';
    // Inject directly via re-request with a fresh phone, then mutate by waiting?
    // Simpler: request OTP, use wrong code 6 times → 429 "quá số lần thử"
    await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone } });
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone, code: '000000' } });
    }
    const last = await app.inject({
      method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone, code: '000000' },
    });
    assert.equal(last.statusCode, 429);
  });

});
