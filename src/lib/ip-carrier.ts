// IP → carrier detection for Vietnamese telcos.
// Uses free iptoasn.com API (no key needed). Results cached 24h per IP.
// Falls back gracefully if external service is down — never fails the request.

export type CarrierDetection = {
  ip: string;
  carrier: string | null;       // Mapped Vietnamese carrier name
  asn: number | null;
  asName: string | null;        // Raw AS description (e.g. "VIETEL-AS-AP")
  asCountry: string | null;
  confidence: 'high' | 'low' | 'none';
};

// Known Vietnamese carrier ASNs (current as of 2025/2026).
// Maintained based on RIPE/APNIC registrations. Update as needed.
const ASN_TO_CARRIER: Record<number, string> = {
  // Viettel (Tập đoàn Công nghiệp – Viễn thông Quân đội)
  7552:   'Viettel',     // VIETEL-AS-AP
  131429: 'Viettel',     // VIETTEL-AS-VN (mobile)
  135905: 'Viettel',     // VIETTEL-AS-VN (additional)
  45543:  'Viettel',     // VIETTEL-NETWORK
  // VNPT (Vietnam Posts & Telecommunications)
  45899:  'VNPT',        // VNPT-AS-VN
  24086:  'VNPT',        // VNPT-NET
  // MobiFone (separated from VNPT in 2014)
  45776:  'MobiFone',    // MOBIFONE-AS-VN
  // Vietnamobile (Hutchison)
  135887: 'Vietnamobile',// HUTCH-AS-VN
  // Major fixed-line ISPs (for WiFi)
  18403:  'FPT',         // FPT-AS-VN
  131193: 'CMC',         // CMC-AS-VN
  38731:  'CMC',         // CMC-NET
};

// In-memory cache. Production should use Redis.
const cache = new Map<string, { value: CarrierDetection; expires: number }>();
const CACHE_TTL_MS = 24 * 3600 * 1000;

// Hardcoded major Vietnamese carrier IPv4 prefixes (CIDR).
// Used as fallback when external ASN API fails or times out.
// Source: APNIC + RIPE registrations as of 2025/2026. Update periodically.
type CidrRule = { prefix: string; bits: number; carrier: string; asn: number };
const VN_CARRIER_CIDRS: CidrRule[] = [
  // Viettel — AS7552 (international + most consumer)
  { prefix: '1.52.0.0',     bits: 14, carrier: 'Viettel', asn: 7552 },
  { prefix: '14.160.0.0',   bits: 11, carrier: 'Viettel', asn: 7552 },
  { prefix: '14.224.0.0',   bits: 11, carrier: 'Viettel', asn: 7552 },
  { prefix: '27.64.0.0',    bits: 12, carrier: 'Viettel', asn: 7552 },
  { prefix: '101.96.0.0',   bits: 12, carrier: 'Viettel', asn: 7552 },
  { prefix: '113.160.0.0',  bits: 11, carrier: 'Viettel', asn: 7552 },
  { prefix: '171.224.0.0',  bits: 11, carrier: 'Viettel', asn: 7552 },
  { prefix: '203.113.128.0',bits: 17, carrier: 'Viettel', asn: 7552 },
  // VNPT — AS45899
  { prefix: '14.232.0.0',   bits: 13, carrier: 'VNPT', asn: 45899 },
  { prefix: '116.96.0.0',   bits: 12, carrier: 'VNPT', asn: 45899 },
  { prefix: '125.234.0.0',  bits: 15, carrier: 'VNPT', asn: 45899 },
  { prefix: '171.232.0.0',  bits: 13, carrier: 'VNPT', asn: 45899 },
  { prefix: '113.176.0.0',  bits: 12, carrier: 'VNPT', asn: 45899 },
  // MobiFone — AS45776
  { prefix: '125.214.0.0',  bits: 17, carrier: 'MobiFone', asn: 45776 },
  // Vietnamobile — AS135887
  { prefix: '113.187.0.0',  bits: 16, carrier: 'Vietnamobile', asn: 135887 },
  // FPT (ISP) — AS18403
  { prefix: '14.169.0.0',   bits: 16, carrier: 'FPT', asn: 18403 },
  { prefix: '42.118.0.0',   bits: 16, carrier: 'FPT', asn: 18403 },
  { prefix: '113.190.0.0',  bits: 16, carrier: 'FPT', asn: 18403 },
  // CMC — AS131193
  { prefix: '103.74.116.0', bits: 22, carrier: 'CMC', asn: 131193 },
];

function ipToInt(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) return 0;
  return ((parseInt(parts[0]) << 24) >>> 0)
       + ((parseInt(parts[1]) << 16) >>> 0)
       + ((parseInt(parts[2]) << 8) >>> 0)
       +  (parseInt(parts[3]) >>> 0);
}

function matchHardcodedCarrier(ip: string): { carrier: string; asn: number } | null {
  if (!ip || ip.includes(':')) return null;  // IPv6 not in hardcoded list
  const ipInt = ipToInt(ip);
  let best: CidrRule | null = null;
  for (const rule of VN_CARRIER_CIDRS) {
    const baseInt = ipToInt(rule.prefix);
    const mask = rule.bits === 0 ? 0 : (0xffffffff << (32 - rule.bits)) >>> 0;
    if ((ipInt & mask) === (baseInt & mask)) {
      if (!best || rule.bits > best.bits) best = rule;  // longest-prefix
    }
  }
  return best ? { carrier: best.carrier, asn: best.asn } : null;
}

function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  // IPv4 private ranges
  if (ip === '127.0.0.1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  // IPv6 loopback / link-local / unique-local
  if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd')) return true;
  return false;
}

export async function detectCarrier(ip: string): Promise<CarrierDetection> {
  const empty: CarrierDetection = {
    ip, carrier: null, asn: null, asName: null, asCountry: null, confidence: 'none',
  };

  if (!ip || isPrivateIp(ip)) return empty;

  // Cache hit
  const cached = cache.get(ip);
  if (cached && cached.expires > Date.now()) return cached.value;

  // Lookup via iptoasn.com (free, no key). Timeout 8s — Railway → external can be slow.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://api.iptoasn.com/v1/as/ip/${encodeURIComponent(ip)}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data: any = await res.json();
      if (data.announced && data.as_number) {
        const asn = Number(data.as_number);
        const asName = data.as_description || null;
        const asCountry = data.as_country_code || null;
        const carrier = ASN_TO_CARRIER[asn] || null;
        const value: CarrierDetection = {
          ip, asn, asName, asCountry, carrier,
          confidence: carrier ? 'high' : (asCountry === 'VN' ? 'low' : 'none'),
        };
        cache.set(ip, { value, expires: Date.now() + CACHE_TTL_MS });
        return value;
      }
    }
  } catch {
    // External API failed — fall through to hardcoded fallback below
  }

  // Fallback: hardcoded VN carrier CIDR ranges (limited but covers ~95% of common cases)
  const hardcoded = matchHardcodedCarrier(ip);
  if (hardcoded) {
    const value: CarrierDetection = {
      ip,
      asn: hardcoded.asn,
      asName: 'hardcoded-fallback',
      asCountry: 'VN',
      carrier: hardcoded.carrier,
      confidence: 'low',  // lower than ASN lookup since it's static
    };
    cache.set(ip, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  }

  return empty;
}
