// AI Outage Summary — gọi Anthropic Claude Haiku 4.5 để tạo natural-language
// tổng quan các sự cố mạng đang diễn ra. Cache in-memory 15 phút để giảm cost +
// tránh hit rate limit khi nhiều user vào home page cùng lúc.
//
// Cost: ~$0.0001 per call với Haiku 4.5 (đầu vào ~500 tokens, đầu ra ~200 tokens).
// Với cache 15 phút, max ~96 calls/ngày = $0.01/ngày = $3/năm. Negligible.

import Anthropic from '@anthropic-ai/sdk';

type OutageInput = {
  carrierName: string;
  outageType: string;
  province: string | null;
  reportCount: number;
  firstReported: string;
  isVerified: boolean;
};

type CacheEntry = { value: string; expiresAt: number };
const CACHE_TTL_MS = 15 * 60 * 1000;
let cache: CacheEntry | null = null;

const OUTAGE_TYPE_VN: Record<string, string> = {
  no_signal:    'mất sóng hoàn toàn',
  slow:         'chậm bất thường',
  no_data:      'không có 4G/5G',
  no_call:      'không gọi được',
  no_sms:       'không gửi SMS được',
  intermittent: 'chập chờn',
};

/**
 * Generate AI summary or return null if disabled (no API key) / no outages.
 * Throws on API error so caller can decide whether to fail or degrade gracefully.
 */
export async function generateOutageSummary(outages: OutageInput[]): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (outages.length === 0) return null;

  // Cache hit
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;

  // Build prompt — keep it short to minimize cost
  const lines = outages.slice(0, 30).map((o) => {
    const type = OUTAGE_TYPE_VN[o.outageType] || o.outageType;
    const loc = o.province || 'không rõ tỉnh';
    const verified = o.isVerified ? ' (✓ đã verify)' : '';
    const hoursAgo = Math.round((now - new Date(o.firstReported).getTime()) / 3_600_000);
    return `- ${o.carrierName} ${type} tại ${loc}: ${o.reportCount} báo cáo, bắt đầu ~${hoursAgo}h trước${verified}`;
  }).join('\n');

  const prompt = `Bạn là trợ lý NetMap VN, viết tóm tắt ngắn (3-5 câu) về tình hình sự cố mạng di động Việt Nam trong 6h qua. Viết tự nhiên, dễ hiểu, súc tích, không liệt kê. Nêu nhà mạng nào ảnh hưởng lớn nhất, khu vực địa lý nào tập trung sự cố, và mức độ nghiêm trọng. Không kết luận võ đoán, chỉ tổng hợp data.

Dữ liệu raw:
${lines}

Tóm tắt:`;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
  if (!text) return null;

  cache = { value: text, expiresAt: now + CACHE_TTL_MS };
  return text;
}

/** Reset cache — dùng cho tests hoặc manual refresh. */
export function clearAiSummaryCache() {
  cache = null;
}
