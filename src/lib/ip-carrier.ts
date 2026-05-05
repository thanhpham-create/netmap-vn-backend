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

  // Lookup via iptoasn.com (free, no key, no rate limit for reasonable use)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`https://api.iptoasn.com/v1/as/ip/${encodeURIComponent(ip)}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return empty;
    const data: any = await res.json();

    // Some IPs are "Not Found" — handle gracefully
    if (!data.announced || !data.as_number) return empty;

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
  } catch {
    return empty;
  }
}
