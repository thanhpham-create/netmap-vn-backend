// Anomaly detection cho speed test + outage report.
// Trả về array các flag codes; empty array = clean.
//
// Hai loại flag:
// 1. HARD = giá trị bất khả thi → reject với 422
// 2. SOFT = suspicious nhưng có thể là edge case → accept với is_flagged=true,
//    loại khỏi public query (heatmap, leaderboard) để khỏi méo data, nhưng vẫn
//    audit được bởi admin.

import sql from '../db/index.js';

export type FlagReason =
  | 'speed_too_high_for_network'   // SOFT
  | 'latency_zero'                  // SOFT
  | 'upload_exceeds_download_2x'    // SOFT
  | 'test_duration_too_short'       // SOFT
  | 'burst_from_same_device'        // SOFT — 10+ submissions in 5min
  | 'impossible_speed'              // HARD — >10 Gbps download
  | 'impossible_latency'            // HARD — < -1ms or > 60s
  | 'coords_out_of_vietnam';        // HARD — should be caught by Zod, but double-check

export type SpeedTestInput = {
  carrierName: string;
  networkType: string;
  downloadMbps: number;
  uploadMbps: number;
  latencyMs: number;
  latitude: number;
  longitude: number;
  testDurationMs?: number;
  deviceId: string;
};

/** Theoretical max download per network type — Mbps. */
const MAX_DOWNLOAD_BY_NETWORK: Record<string, number> = {
  '5G-SA':  3500,   // Sub-6 5G SA peak ~3 Gbps
  '5G-NSA': 2500,
  '5G':     2500,
  '4G+':    1000,
  '4G':     400,
  '3G':     50,
  '2G':     1,
  'WIFI':   10000,  // WiFi 6E can hit ~9.6 Gbps in theory
};

/** Vietnam bbox roughly: 8°-24°N, 102°-110°E. */
function inVietnam(lat: number, lng: number): boolean {
  return lat >= 8 && lat <= 24 && lng >= 102 && lng <= 110;
}

/**
 * Run detection. Async because some rules query DB (burst detection).
 * Returns { hard, soft, reasons } — hard = should reject, soft = should flag.
 */
export async function detectSpeedTestAnomaly(
  input: SpeedTestInput,
): Promise<{ hard: FlagReason[]; soft: FlagReason[] }> {
  const hard: FlagReason[] = [];
  const soft: FlagReason[] = [];

  // ── HARD rules ──────────────────────────────────────────────────
  if (input.downloadMbps > 10000 || input.downloadMbps < 0) {
    hard.push('impossible_speed');
  }
  if (input.latencyMs < 0 || input.latencyMs > 60000) {
    hard.push('impossible_latency');
  }
  if (!inVietnam(input.latitude, input.longitude)) {
    hard.push('coords_out_of_vietnam');
  }

  // ── SOFT rules ──────────────────────────────────────────────────
  // 1. Speed too high cho network type
  const maxAllowed = MAX_DOWNLOAD_BY_NETWORK[input.networkType] ?? 2000;
  if (input.downloadMbps > maxAllowed * 1.2) {
    soft.push('speed_too_high_for_network');
  }

  // 2. Latency = 0 (impossible trên cellular, có thể là localhost test)
  if (input.latencyMs === 0) {
    soft.push('latency_zero');
  }

  // 3. Upload > download 2x (rare; usually down > up trên consumer connection)
  if (input.uploadMbps > input.downloadMbps * 2 && input.downloadMbps > 10) {
    soft.push('upload_exceeds_download_2x');
  }

  // 4. Test quá ngắn (real test mất ít nhất 5s; <2s là fake)
  if (input.testDurationMs !== undefined && input.testDurationMs < 2000) {
    soft.push('test_duration_too_short');
  }

  // 5. Burst: same device submit 10+ trong 5 phút → spam
  const [{ count }] = await sql<[{ count: number }]>`
    SELECT COUNT(*)::int AS count
    FROM speed_tests
    WHERE device_id = ${input.deviceId}
      AND recorded_at > NOW() - INTERVAL '5 minutes'
  `;
  if (count >= 10) {
    soft.push('burst_from_same_device');
  }

  return { hard, soft };
}

/**
 * Outage report anomaly detection — chỉ có soft rules vì content user-generated
 * khó verify automatically. Burst detection là chính.
 */
export async function detectOutageAnomaly(input: {
  deviceId: string;
  description?: string;
}): Promise<{ hard: FlagReason[]; soft: FlagReason[] }> {
  const hard: FlagReason[] = [];
  const soft: FlagReason[] = [];

  // Burst: same device submit 5+ outage trong 10 phút → spam
  const [{ count }] = await sql<[{ count: number }]>`
    SELECT COUNT(*)::int AS count
    FROM outage_reports
    WHERE device_id = ${input.deviceId}
      AND reported_at > NOW() - INTERVAL '10 minutes'
  `;
  if (count >= 5) {
    soft.push('burst_from_same_device');
  }

  return { hard, soft };
}
