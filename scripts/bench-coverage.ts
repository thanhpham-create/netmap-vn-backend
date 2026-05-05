// NetMap VN — Coverage query benchmark
// Inserts N synthetic speed tests, then compares EXPLAIN ANALYZE timings:
//   1. Pure Haversine (no bbox prefilter)  — what the OLD code did
//   2. Bbox + Haversine                    — what the NEW code does
//
// Usage:
//   DATABASE_URL=postgresql://localhost:5432/netmap_bench yarn tsx scripts/bench-coverage.ts
//
// ⚠️  Inserts ~N rows into your DB. Use a separate bench database.

import sql from '../src/db/index.js';

const N = parseInt(process.env.BENCH_ROWS || '100000');
const VN_LAT_MIN = 8.5, VN_LAT_MAX = 23.5;
const VN_LNG_MIN = 102.5, VN_LNG_MAX = 109.5;

// Center the test query near Da Nang
const Q_LAT = 16.0544;
const Q_LNG = 108.2022;
const Q_RADIUS_M = 1000;

async function ensureDevice(): Promise<string> {
  const [d] = await sql`
    INSERT INTO devices (device_uid, platform)
    VALUES ('bench-device', 'ios')
    ON CONFLICT (device_uid) DO UPDATE SET last_seen = NOW()
    RETURNING id
  `;
  return d.id;
}

async function seed(deviceId: string, n: number) {
  console.log(`Seeding ${n} synthetic speed_tests across all of VN…`);
  // Insert in batches of 5k rows for speed
  const BATCH = 5000;
  for (let i = 0; i < n; i += BATCH) {
    const rows: any[] = [];
    const k = Math.min(BATCH, n - i);
    for (let j = 0; j < k; j++) {
      const lat = VN_LAT_MIN + Math.random() * (VN_LAT_MAX - VN_LAT_MIN);
      const lng = VN_LNG_MIN + Math.random() * (VN_LNG_MAX - VN_LNG_MIN);
      rows.push({
        deviceId,
        carrierName: ['Viettel', 'VNPT', 'MobiFone', 'Vietnamobile'][Math.floor(Math.random() * 4)],
        networkType: ['5G', '4G', '4G+', '3G'][Math.floor(Math.random() * 4)],
        downloadMbps: Math.round(Math.random() * 500 * 100) / 100,
        uploadMbps: Math.round(Math.random() * 100 * 100) / 100,
        latencyMs: Math.floor(Math.random() * 80),
        latitude: lat,
        longitude: lng,
        testType: 'manual',
      });
    }
    await sql`
      INSERT INTO speed_tests ${sql(rows, 'deviceId', 'carrierName', 'networkType', 'downloadMbps', 'uploadMbps', 'latencyMs', 'latitude', 'longitude', 'testType')}
    `;
    process.stdout.write(`  inserted ${i + k}/${n}\r`);
  }
  console.log('');
}

async function explain(label: string, query: any) {
  console.log(`\n──── ${label} ────`);
  const result = await sql`EXPLAIN (ANALYZE, BUFFERS) ${query}`;
  for (const row of result) {
    console.log(`  ${(row as any)['QUERY PLAN']}`);
  }
}

async function bench() {
  console.log(`📊 Bench: ${N} rows, query near (${Q_LAT}, ${Q_LNG}) radius ${Q_RADIUS_M}m\n`);

  const [{ count: existing }] = await sql<{ count: number }[]>`SELECT COUNT(*)::int FROM speed_tests`;
  console.log(`Existing rows in speed_tests: ${existing}`);
  if (existing < N) {
    const deviceId = await ensureDevice();
    await seed(deviceId, N - existing);
  } else {
    console.log('Already enough rows — skipping seed.');
  }

  // Make sure ANALYZE has stats
  await sql`ANALYZE speed_tests`;

  // 1. Pure Haversine (no bbox)
  await explain(
    'OLD: Pure Haversine (no bbox)',
    sql`
      SELECT carrier_name, network_type, COUNT(*)
      FROM speed_tests
      WHERE 6371000 * 2 * ASIN(SQRT(
        POWER(SIN((RADIANS(latitude) - RADIANS(${Q_LAT})) / 2), 2) +
        COS(RADIANS(${Q_LAT})) * COS(RADIANS(latitude)) *
        POWER(SIN((RADIANS(longitude) - RADIANS(${Q_LNG})) / 2), 2)
      )) <= ${Q_RADIUS_M}
      GROUP BY carrier_name, network_type
    `
  );

  // 2. Bbox + Haversine
  await explain(
    'NEW: Bbox prefilter + Haversine',
    sql`
      WITH bbox AS (SELECT * FROM nearby_bbox(${Q_LAT}, ${Q_LNG}, ${Q_RADIUS_M}))
      SELECT carrier_name, network_type, COUNT(*)
      FROM speed_tests, bbox
      WHERE
        latitude  BETWEEN bbox.min_lat AND bbox.max_lat
        AND longitude BETWEEN bbox.min_lng AND bbox.max_lng
        AND 6371000 * 2 * ASIN(SQRT(
          POWER(SIN((RADIANS(latitude) - RADIANS(${Q_LAT})) / 2), 2) +
          COS(RADIANS(${Q_LAT})) * COS(RADIANS(latitude)) *
          POWER(SIN((RADIANS(longitude) - RADIANS(${Q_LNG})) / 2), 2)
        )) <= ${Q_RADIUS_M}
      GROUP BY carrier_name, network_type
    `
  );

  console.log('\n✓ Done. Look for "Execution Time" lines above.');
  process.exit(0);
}

bench().catch((err) => { console.error(err); process.exit(1); });
