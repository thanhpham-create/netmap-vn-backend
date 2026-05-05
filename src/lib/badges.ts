// Badge system — dynamic computation from user stats.
// Adding a new badge: append to BADGES array, set criterion. No migration needed.

import sql from '../db/index.js';

export type BadgeId =
  | 'first_test' | 'tester' | 'power_tester' | 'test_master'
  | 'first_report' | 'outage_hunter' | 'sentinel'
  | 'trusted_reporter' | 'watchdog'
  | 'all_carriers' | 'explorer' | 'wanderer'
  | 'speed_demon' | 'pioneer_5g';

export type Badge = {
  id: BadgeId;
  name: string;
  description: string;
  emoji: string;
  category: 'tests' | 'outages' | 'coverage' | 'speed';
  /** Threshold for "earned" status. Compared against `metric`. */
  threshold: number;
  /** Pretty description of the metric for the user UI. */
  metricLabel: string;
};

export const BADGES: Badge[] = [
  // Test count milestones
  { id: 'first_test',  name: 'Lần đầu thử',     description: 'Đo tốc độ đầu tiên',          emoji: '🌱', category: 'tests', threshold: 1,   metricLabel: 'speed test' },
  { id: 'tester',      name: 'Người đo',         description: 'Hoàn thành 10 speed tests',  emoji: '📡', category: 'tests', threshold: 10,  metricLabel: 'speed test' },
  { id: 'power_tester',name: 'Power Tester',    description: 'Hoàn thành 50 speed tests',  emoji: '⚡', category: 'tests', threshold: 50,  metricLabel: 'speed test' },
  { id: 'test_master', name: 'Test Master',     description: 'Hoàn thành 200 speed tests', emoji: '🏆', category: 'tests', threshold: 200, metricLabel: 'speed test' },

  // Outage report milestones
  { id: 'first_report',   name: 'Người báo cáo', description: 'Báo cáo sự cố đầu tiên',       emoji: '🔍', category: 'outages', threshold: 1,  metricLabel: 'báo cáo' },
  { id: 'outage_hunter',  name: 'Outage Hunter', description: 'Báo cáo 10 sự cố',             emoji: '🎯', category: 'outages', threshold: 10, metricLabel: 'báo cáo' },
  { id: 'sentinel',       name: 'Sentinel',      description: 'Báo cáo 50 sự cố',             emoji: '🛡️', category: 'outages', threshold: 50, metricLabel: 'báo cáo' },

  // Verified outages
  { id: 'trusted_reporter', name: 'Trusted Reporter', description: '5 báo cáo được xác minh', emoji: '✅', category: 'outages', threshold: 5,  metricLabel: 'báo cáo verified' },
  { id: 'watchdog',         name: 'Watchdog',         description: '20 báo cáo được xác minh', emoji: '👁️', category: 'outages', threshold: 20, metricLabel: 'báo cáo verified' },

  // Coverage breadth
  { id: 'all_carriers', name: 'All Carriers',  description: 'Đã test cả 4 nhà mạng',  emoji: '🌐', category: 'coverage', threshold: 4,  metricLabel: 'nhà mạng' },
  { id: 'explorer',     name: 'Explorer',      description: 'Test ở 5 tỉnh',          emoji: '🗺️', category: 'coverage', threshold: 5,  metricLabel: 'tỉnh' },
  { id: 'wanderer',     name: 'Wanderer',      description: 'Test ở 10 tỉnh',         emoji: '🧭', category: 'coverage', threshold: 10, metricLabel: 'tỉnh' },

  // Speed achievements
  { id: 'speed_demon',  name: 'Speed Demon',   description: 'Đo được tốc độ ≥ 500 Mbps', emoji: '🔥', category: 'speed', threshold: 500, metricLabel: 'Mbps' },
  { id: 'pioneer_5g',   name: '5G Pioneer',    description: 'Test trên mạng 5G',         emoji: '🚀', category: 'speed', threshold: 1,   metricLabel: 'test 5G' },
];

export type UserBadge = Badge & {
  earned: boolean;
  progress: number;  // current value of metric for this user
  earnedAt?: string; // ISO timestamp khi đạt (nếu earned)
};

/**
 * Compute badges for a user. Single SQL roundtrip:
 * pulls all metrics in 1 CTE-style query, then maps to badge progress.
 */
export async function computeBadges(userId: string): Promise<UserBadge[]> {
  const [stats] = await sql<any[]>`
    WITH user_devices AS (
      SELECT id FROM devices WHERE user_id = ${userId}
    ),
    test_stats AS (
      SELECT
        COUNT(*)::int                                     AS test_count,
        COUNT(DISTINCT carrier_name)::int                 AS unique_carriers,
        COUNT(DISTINCT province) FILTER (WHERE province IS NOT NULL)::int AS unique_provinces,
        COALESCE(MAX(download_mbps), 0)                   AS max_download_mbps,
        BOOL_OR(network_type LIKE '5G%')                  AS has_5g,
        MIN(recorded_at) FILTER (WHERE 1=1)               AS first_test_at,
        MIN(recorded_at) FILTER (WHERE network_type LIKE '5G%') AS first_5g_at
      FROM speed_tests
      WHERE device_id IN (SELECT id FROM user_devices)
    ),
    outage_stats AS (
      SELECT
        COUNT(*)::int                                     AS report_count,
        COUNT(*) FILTER (WHERE is_verified)::int          AS verified_count,
        MIN(reported_at)                                  AS first_report_at
      FROM outage_reports
      WHERE device_id IN (SELECT id FROM user_devices)
    )
    SELECT
      COALESCE(t.test_count, 0)         AS test_count,
      COALESCE(t.unique_carriers, 0)    AS unique_carriers,
      COALESCE(t.unique_provinces, 0)   AS unique_provinces,
      COALESCE(t.max_download_mbps, 0)  AS max_download_mbps,
      COALESCE(t.has_5g, false)         AS has_5g,
      t.first_test_at,
      t.first_5g_at,
      COALESCE(o.report_count, 0)       AS report_count,
      COALESCE(o.verified_count, 0)     AS verified_count,
      o.first_report_at
    FROM test_stats t FULL OUTER JOIN outage_stats o ON true
  `;

  if (!stats) {
    return BADGES.map((b) => ({ ...b, earned: false, progress: 0 }));
  }

  return BADGES.map((b) => {
    let progress = 0;
    let earnedAt: string | undefined;

    switch (b.id) {
      case 'first_test':  case 'tester':  case 'power_tester':  case 'test_master':
        progress = stats.testCount;
        if (progress >= b.threshold && stats.firstTestAt) earnedAt = stats.firstTestAt;
        break;
      case 'first_report':  case 'outage_hunter':  case 'sentinel':
        progress = stats.reportCount;
        if (progress >= b.threshold && stats.firstReportAt) earnedAt = stats.firstReportAt;
        break;
      case 'trusted_reporter':  case 'watchdog':
        progress = stats.verifiedCount;
        break;
      case 'all_carriers':
        progress = stats.uniqueCarriers;
        break;
      case 'explorer':  case 'wanderer':
        progress = stats.uniqueProvinces;
        break;
      case 'speed_demon':
        progress = Math.round(parseFloat(stats.maxDownloadMbps) || 0);
        break;
      case 'pioneer_5g':
        progress = stats.has5G ? 1 : 0;
        if (progress > 0 && stats.first5GAt) earnedAt = stats.first5GAt;
        break;
    }

    return { ...b, progress, earned: progress >= b.threshold, earnedAt };
  });
}
