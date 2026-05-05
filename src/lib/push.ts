// Web Push wrapper. Sends notifications to subscribers based on geo + carrier filter.
//
// VAPID keys (one-time): npx web-push generate-vapid-keys
// Required env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:...)

import webpush from 'web-push';
import sql from '../db/index.js';

let _initialized = false;

function init() {
  if (_initialized) return;
  const publicKey  = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject    = process.env.VAPID_SUBJECT || 'mailto:netmap@example.com';

  if (!publicKey || !privateKey) {
    throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set to use push');
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  _initialized = true;
}

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
};

/**
 * Find subscribers who match the given location + carrier, send push to each.
 * Returns count of attempted sends + failures.
 */
export async function broadcastOutageAlert(opts: {
  carrier: string;
  outageType: string;
  latitude: number;
  longitude: number;
  province?: string;
  district?: string;
  clusterSize: number;
}) {
  init();

  // Find subscribers within their configured radius from the outage point.
  // Use bbox prefilter for index, then exact Haversine.
  const subs = await sql`
    WITH bbox AS (
      SELECT * FROM nearby_bbox(${opts.latitude}, ${opts.longitude}, 50000)  -- 50km outer bound
    )
    SELECT id, endpoint, p256dh, auth_secret, radius_m, carriers
    FROM push_subscriptions, bbox
    WHERE
      latitude IS NOT NULL AND longitude IS NOT NULL
      AND latitude  BETWEEN bbox.min_lat AND bbox.max_lat
      AND longitude BETWEEN bbox.min_lng AND bbox.max_lng
      AND failure_count < 5
      AND 6371000 * 2 * ASIN(SQRT(
        POWER(SIN((RADIANS(latitude) - RADIANS(${opts.latitude})) / 2), 2) +
        COS(RADIANS(${opts.latitude})) * COS(RADIANS(latitude)) *
        POWER(SIN((RADIANS(longitude) - RADIANS(${opts.longitude})) / 2), 2)
      )) <= radius_m
      AND (carriers IS NULL OR cardinality(carriers) = 0 OR ${opts.carrier} = ANY(carriers))
  `;

  if (subs.length === 0) return { sent: 0, failed: 0 };

  const location = [opts.district, opts.province].filter(Boolean).join(', ') || 'gần bạn';
  const payload: PushPayload = {
    title: `🚨 ${opts.carrier} mất sóng tại ${location}`,
    body:  `${opts.clusterSize} người báo "${opts.outageType}" trong giờ qua. Bấm để xem.`,
    url:   '/outages',
    tag:   `outage-${opts.carrier}-${Math.round(opts.latitude * 100)}-${Math.round(opts.longitude * 100)}`,
  };

  let sent = 0;
  let failed = 0;
  await Promise.all(
    (subs as any[]).map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.authSecret } },
          JSON.stringify(payload),
          { TTL: 3600 },  // 1 hour relevance
        );
        sent++;
        await sql`UPDATE push_subscriptions SET last_used = NOW(), failure_count = 0 WHERE id = ${s.id}`;
      } catch (err: any) {
        failed++;
        // 410 Gone or 404 Not Found → subscription expired, delete
        if (err.statusCode === 410 || err.statusCode === 404) {
          await sql`DELETE FROM push_subscriptions WHERE id = ${s.id}`;
        } else {
          await sql`
            UPDATE push_subscriptions
            SET failure_count = failure_count + 1, last_failure = NOW()
            WHERE id = ${s.id}
          `;
        }
      }
    }),
  );

  return { sent, failed };
}
