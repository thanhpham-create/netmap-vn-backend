// Sentry initialization for the Fastify backend.
// Must be imported BEFORE other modules so instrumentation hooks attach early.

import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;
const environment = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development';

if (dsn) {
  Sentry.init({
    dsn,
    environment,
    // Lower sample rate in prod to control quota
    tracesSampleRate: environment === 'production' ? 0.1 : 1.0,
    integrations: [
      Sentry.httpIntegration(),
      Sentry.postgresIntegration(),
    ],
    // Scrub sensitive data
    beforeSend(event, hint) {
      // Drop Authorization header from request data
      if (event.request?.headers) {
        const h = event.request.headers as Record<string, any>;
        if (h.authorization) h.authorization = '[Filtered]';
        if (h.Authorization) h.Authorization = '[Filtered]';
        if (h.cookie) h.cookie = '[Filtered]';
      }
      // Don't ship OTP codes if any sneak in
      if (event.extra) {
        for (const k of Object.keys(event.extra)) {
          if (/otp|code|token|secret|password/i.test(k)) {
            event.extra[k] = '[Filtered]';
          }
        }
      }
      return event;
    },
  });
  console.log(`📡 Sentry initialised (env=${environment})`);
} else if (environment === 'production') {
  console.warn('⚠️  SENTRY_DSN not set in production — errors will not be tracked.');
}

export { Sentry };
