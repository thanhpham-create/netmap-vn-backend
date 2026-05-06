// NetMap VN — Demo data seeder
// Tạo dữ liệu giả thực tế để demo: ~10 users, ~30 devices, ~1000 speed tests, ~50 outages.
//
// ⚠️  REFUSES NODE_ENV=production.
// Idempotent-ish: skip toàn bộ nếu phát hiện đã có user demo (phone bắt đầu '0999').
//
// Run: yarn db:seed

import sql from '../src/db/index.js';

const force = process.argv.includes('--force');
if (process.env.NODE_ENV === 'production' && !force) {
  console.error('⛔ Refusing to seed demo data in NODE_ENV=production.');
  console.error('   To force-seed (vd lần đầu deploy Railway), thêm --force:');
  console.error('   yarn db:seed --force');
  process.exit(1);
}
if (force) {
  console.warn('⚠️  --force enabled. Sẽ insert demo data vào NODE_ENV=production. 5s để Ctrl+C nếu nhầm...');
  // 5 second pause to allow abort
}

// ============= REFERENCE DATA =============

// 30 thành phố/tỉnh lớn VN với tọa độ trung tâm.
// Spread rộng để map nhìn ở zoom toàn quốc có chấm khắp.
const CITIES = [
  // Miền Bắc
  { name: 'Hà Nội',     province: 'Hà Nội',          district: 'Hoàn Kiếm', lat: 21.0285, lng: 105.8542, weight: 22 },
  { name: 'Hải Phòng',  province: 'Hải Phòng',       district: 'Hồng Bàng', lat: 20.8525, lng: 106.6837, weight: 7 },
  { name: 'Hạ Long',    province: 'Quảng Ninh',      district: 'Hạ Long',   lat: 20.9711, lng: 107.0466, weight: 4 },
  { name: 'Bắc Ninh',   province: 'Bắc Ninh',        district: 'Bắc Ninh',  lat: 21.1861, lng: 106.0763, weight: 3 },
  { name: 'Thái Nguyên',province: 'Thái Nguyên',     district: 'Thái Nguyên',lat: 21.5944, lng: 105.8480, weight: 2 },
  { name: 'Nam Định',   province: 'Nam Định',        district: 'Nam Định',  lat: 20.4385, lng: 106.1621, weight: 2 },
  { name: 'Việt Trì',   province: 'Phú Thọ',         district: 'Việt Trì',  lat: 21.3227, lng: 105.4024, weight: 2 },
  { name: 'Sơn La',     province: 'Sơn La',          district: 'Sơn La',    lat: 21.3256, lng: 103.9188, weight: 1 },
  { name: 'Lào Cai',    province: 'Lào Cai',         district: 'Lào Cai',   lat: 22.4856, lng: 103.9707, weight: 1 },
  // Miền Trung
  { name: 'Thanh Hóa',  province: 'Thanh Hóa',       district: 'Thanh Hóa', lat: 19.8067, lng: 105.7765, weight: 4 },
  { name: 'Vinh',       province: 'Nghệ An',         district: 'Vinh',      lat: 18.6790, lng: 105.6813, weight: 4 },
  { name: 'Huế',        province: 'Thừa Thiên Huế',  district: 'Huế',       lat: 16.4637, lng: 107.5909, weight: 4 },
  { name: 'Đà Nẵng',    province: 'Đà Nẵng',         district: 'Hải Châu',  lat: 16.0544, lng: 108.2022, weight: 10 },
  { name: 'Hội An',     province: 'Quảng Nam',       district: 'Hội An',    lat: 15.8801, lng: 108.3380, weight: 2 },
  { name: 'Quy Nhơn',   province: 'Bình Định',       district: 'Quy Nhơn',  lat: 13.7820, lng: 109.2200, weight: 3 },
  { name: 'Nha Trang',  province: 'Khánh Hòa',       district: 'Nha Trang', lat: 12.2388, lng: 109.1967, weight: 5 },
  { name: 'Phan Thiết', province: 'Bình Thuận',      district: 'Phan Thiết',lat: 10.9333, lng: 108.1000, weight: 3 },
  { name: 'Buôn Ma Thuột', province: 'Đắk Lắk',      district: 'Buôn Ma Thuột', lat: 12.6667, lng: 108.0500, weight: 2 },
  { name: 'Pleiku',     province: 'Gia Lai',         district: 'Pleiku',    lat: 13.9833, lng: 108.0000, weight: 2 },
  { name: 'Đà Lạt',     province: 'Lâm Đồng',        district: 'Đà Lạt',    lat: 11.9404, lng: 108.4583, weight: 3 },
  // Miền Nam
  { name: 'TP.HCM',     province: 'TP. Hồ Chí Minh', district: 'Quận 1',    lat: 10.7769, lng: 106.7009, weight: 25 },
  { name: 'Biên Hòa',   province: 'Đồng Nai',        district: 'Biên Hòa',  lat: 10.9472, lng: 106.8430, weight: 4 },
  { name: 'Thủ Dầu Một',province: 'Bình Dương',      district: 'Thủ Dầu Một', lat: 10.9803, lng: 106.6519, weight: 4 },
  { name: 'Vũng Tàu',   province: 'Bà Rịa - Vũng Tàu', district: 'Vũng Tàu',lat: 10.4113, lng: 107.1365, weight: 5 },
  { name: 'Mỹ Tho',     province: 'Tiền Giang',      district: 'Mỹ Tho',    lat: 10.3600, lng: 106.3600, weight: 2 },
  { name: 'Cần Thơ',    province: 'Cần Thơ',         district: 'Ninh Kiều', lat: 10.0341, lng: 105.7882, weight: 5 },
  { name: 'Long Xuyên', province: 'An Giang',        district: 'Long Xuyên',lat: 10.3863, lng: 105.4359, weight: 2 },
  { name: 'Rạch Giá',   province: 'Kiên Giang',      district: 'Rạch Giá',  lat: 10.0167, lng: 105.0833, weight: 2 },
  { name: 'Cà Mau',     province: 'Cà Mau',          district: 'Cà Mau',    lat: 9.1769, lng: 105.1500, weight: 2 },
  { name: 'Phú Quốc',   province: 'Kiên Giang',      district: 'Phú Quốc',  lat: 10.2270, lng: 103.9590, weight: 2 },
];

// Carriers theo market share (Viettel dominant)
const CARRIERS = [
  { name: 'Viettel',      weight: 50 },
  { name: 'VNPT',         weight: 25 },
  { name: 'MobiFone',     weight: 15 },
  { name: 'Vietnamobile', weight: 10 },
];

// Network types — 5G phổ biến nhất ở Hà Nội/HCM/Đà Nẵng
const NETWORKS = [
  { type: '5G',   weight: 25, downMin: 200, downMax: 600, upMin: 50, upMax: 100, latMin: 8,  latMax: 25, band: 'n78' },
  { type: '5G-NSA', weight: 5, downMin: 150, downMax: 400, upMin: 40, upMax: 80,  latMin: 10, latMax: 30, band: 'n78' },
  { type: '4G+',  weight: 25, downMin: 50,  downMax: 150, upMin: 20, upMax: 50,  latMin: 15, latMax: 40, band: 'B7' },
  { type: '4G',   weight: 35, downMin: 20,  downMax: 80,  upMin: 10, upMax: 30,  latMin: 20, latMax: 60, band: 'B3' },
  { type: '3G',   weight: 10, downMin: 1,   downMax: 10,  upMin: 0.5, upMax: 5,  latMin: 50, latMax: 200, band: null },
];

const OUTAGE_TYPES = ['no_signal', 'slow', 'no_data', 'no_call', 'no_sms', 'intermittent'];

const FAKE_USERS = [
  { phone: '0999000001', name: 'Nguyễn Văn An',     role: 'consumer' },
  { phone: '0999000002', name: 'Trần Thị Bình',     role: 'consumer' },
  { phone: '0999000003', name: 'Lê Hoàng Cường',    role: 'consumer' },
  { phone: '0999000004', name: 'Phạm Mai Dung',     role: 'consumer' },
  { phone: '0999000005', name: 'Hoàng Đức',          role: 'consumer' },
  { phone: '0999000006', name: 'Vũ Thị Huyền',     role: 'consumer' },
  { phone: '0999000007', name: 'Đỗ Quang Khánh',   role: 'consumer' },
  { phone: '0999000008', name: 'Bùi Linh',          role: 'consumer' },
  { phone: '0999000009', name: 'Demo Operator',    role: 'operator' },
  { phone: '0999000010', name: 'Demo Admin',        role: 'admin' },
];

// ============= HELPERS =============

function pickWeighted<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const x of items) { r -= x.weight; if (r <= 0) return x; }
  return items[items.length - 1];
}

function jitter(value: number, range: number): number {
  return value + (Math.random() - 0.5) * range;
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number, dec = 2): number {
  return Math.round((min + Math.random() * (max - min)) * Math.pow(10, dec)) / Math.pow(10, dec);
}

// ============= MAIN =============

async function seed() {
  console.log('🌱 Seeding demo data...');

  // Idempotency check
  const existing = await sql`SELECT COUNT(*)::int AS count FROM users WHERE phone LIKE '0999%'`;
  if (existing[0].count > 0) {
    console.log(`⚠️  Đã có ${existing[0].count} demo users (phone bắt đầu 0999). Bỏ qua seed.`);
    console.log('   Để re-seed: yarn db:reset && yarn db:migrate && yarn db:seed');
    process.exit(0);
  }

  // 1. Users
  console.log(`\n→ Inserting ${FAKE_USERS.length} users...`);
  const users = await sql`
    INSERT INTO users ${sql(FAKE_USERS.map((u) => ({
      phone: u.phone, displayName: u.name, role: u.role,
    })))}
    RETURNING id, phone, role
  `;

  // 2. Devices — mỗi user 1-3 devices, một số anonymous
  const devices: Array<{ id: string; userId: string | null }> = [];
  console.log(`→ Inserting devices...`);
  for (const u of users) {
    const numDevices = randInt(1, 3);
    for (let i = 0; i < numDevices; i++) {
      const platform = (['ios', 'android', 'web'] as const)[randInt(0, 2)];
      const carrierName = pickWeighted(CARRIERS).name;
      const [d] = await sql`
        INSERT INTO devices (device_uid, user_id, platform, carrier_name, device_model)
        VALUES (
          ${`demo-${u.phone}-${i}`},
          ${u.id},
          ${platform},
          ${carrierName},
          ${platform === 'ios' ? 'iPhone 15 Pro' : platform === 'android' ? 'Galaxy S24' : 'Web'}
        )
        RETURNING id
      `;
      devices.push({ id: d.id, userId: u.id });
    }
  }
  // Anonymous devices
  for (let i = 0; i < 5; i++) {
    const [d] = await sql`
      INSERT INTO devices (device_uid, platform, carrier_name)
      VALUES (${`demo-anon-${i}`}, 'web', ${pickWeighted(CARRIERS).name})
      RETURNING id
    `;
    devices.push({ id: d.id, userId: null });
  }
  console.log(`  ✓ ${devices.length} devices`);

  // 3. Speed tests
  const N_TESTS = parseInt(process.env.SEED_TESTS || '3000');
  console.log(`→ Inserting ${N_TESTS} speed tests...`);

  const BATCH = 100;
  for (let off = 0; off < N_TESTS; off += BATCH) {
    const batch: any[] = [];
    const k = Math.min(BATCH, N_TESTS - off);
    for (let i = 0; i < k; i++) {
      const city = pickWeighted(CITIES);
      const carrier = pickWeighted(CARRIERS);
      const network = pickWeighted(NETWORKS);
      // Spread tests trong bán kính ~15km quanh trung tâm city (jitter 0.25° ≈ 25km diameter).
      // Đủ rộng để map zoom-out toàn quốc nhìn thấy cluster, mà vẫn local đủ.
      const lat = jitter(city.lat, 0.25);
      const lng = jitter(city.lng, 0.25);
      const device = devices[randInt(0, devices.length - 1)];
      // Recorded within last 30 days (skewed toward recent)
      const daysAgo = Math.pow(Math.random(), 2) * 30;
      const recordedAt = new Date(Date.now() - daysAgo * 86400000);

      batch.push({
        deviceId:     device.id,
        carrierName:  carrier.name,
        networkType:  network.type,
        downloadMbps: randFloat(network.downMin, network.downMax),
        uploadMbps:   randFloat(network.upMin, network.upMax),
        latencyMs:    randInt(network.latMin, network.latMax),
        latitude:     lat,
        longitude:    lng,
        province:     city.province,
        district:     city.district,
        recordedAt,
        testType:     'manual',
      });
    }
    await sql`
      INSERT INTO speed_tests ${sql(batch,
        'deviceId', 'carrierName', 'networkType', 'downloadMbps', 'uploadMbps', 'latencyMs',
        'latitude', 'longitude', 'province', 'district', 'recordedAt', 'testType',
      )}
    `;
    process.stdout.write(`  ${off + k}/${N_TESTS}\r`);
  }
  console.log('');

  // 4. Outage clusters — 5 clusters, mỗi cluster 5-15 reports gần nhau
  const N_CLUSTERS = parseInt(process.env.SEED_OUTAGE_CLUSTERS || '5');
  console.log(`→ Inserting ${N_CLUSTERS} outage clusters...`);

  let outageCount = 0;
  for (let c = 0; c < N_CLUSTERS; c++) {
    const city = pickWeighted(CITIES);
    const clusterCarrier = pickWeighted(CARRIERS).name;
    const clusterType = OUTAGE_TYPES[randInt(0, OUTAGE_TYPES.length - 1)];
    const clusterSize = randInt(5, 15);
    const isVerified = clusterSize >= 5;
    // Cluster within 1km of city center
    const baseLat = jitter(city.lat, 0.02);
    const baseLng = jitter(city.lng, 0.02);
    // Cluster time: random within last 24 hours
    const hoursAgo = Math.random() * 24;

    const reports: any[] = [];
    for (let i = 0; i < clusterSize; i++) {
      const device = devices[randInt(0, devices.length - 1)];
      reports.push({
        deviceId:    device.id,
        carrierName: clusterCarrier,
        outageType:  clusterType,
        latitude:    baseLat + (Math.random() - 0.5) * 0.01,  // ~500m spread
        longitude:   baseLng + (Math.random() - 0.5) * 0.01,
        province:    city.province,
        district:    city.district,
        clusterSize: clusterSize,
        isVerified:  isVerified,
        reportedAt:  new Date(Date.now() - hoursAgo * 3600000 - i * 60000),
      });
    }
    await sql`
      INSERT INTO outage_reports ${sql(reports,
        'deviceId', 'carrierName', 'outageType', 'latitude', 'longitude',
        'province', 'district', 'clusterSize', 'isVerified', 'reportedAt',
      )}
    `;
    outageCount += clusterSize;
  }
  console.log(`  ✓ ${outageCount} outage reports across ${N_CLUSTERS} clusters`);

  // Summary
  console.log('\n✅ Seed complete:');
  const stats = await sql<any[]>`
    SELECT
      (SELECT COUNT(*)::int FROM users WHERE phone LIKE '0999%')                        AS demo_users,
      (SELECT COUNT(*)::int FROM devices WHERE device_uid LIKE 'demo-%')                AS demo_devices,
      (SELECT COUNT(*)::int FROM speed_tests st JOIN devices d ON d.id = st.device_id WHERE d.device_uid LIKE 'demo-%') AS demo_tests,
      (SELECT COUNT(*)::int FROM outage_reports o JOIN devices d ON d.id = o.device_id WHERE d.device_uid LIKE 'demo-%') AS demo_outages
  `;
  console.log(`   ${stats[0].demoUsers} users, ${stats[0].demoDevices} devices`);
  console.log(`   ${stats[0].demoTests} speed tests, ${stats[0].demoOutages} outage reports`);
  console.log('\n💡 Tip: login với SĐT 0999000010 (admin role) để test admin dashboard.');

  process.exit(0);
}

seed().catch((err) => {
  console.error('✖ Seed failed:', err);
  process.exit(1);
});
