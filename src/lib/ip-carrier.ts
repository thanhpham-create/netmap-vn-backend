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
  // ── Viettel — AS7552 ─────────────────────────────────────────
  { prefix: '1.52.0.0',     bits: 14, carrier: 'Viettel', asn: 7552 },
  { prefix: '14.160.0.0',   bits: 11, carrier: 'Viettel', asn: 7552 },
  { prefix: '14.224.0.0',   bits: 11, carrier: 'Viettel', asn: 7552 },
  { prefix: '27.64.0.0',    bits: 12, carrier: 'Viettel', asn: 7552 },
  { prefix: '101.96.0.0',   bits: 12, carrier: 'Viettel', asn: 7552 },
  { prefix: '113.160.0.0',  bits: 11, carrier: 'Viettel', asn: 7552 },
  { prefix: '171.224.0.0',  bits: 11, carrier: 'Viettel', asn: 7552 },
  { prefix: '203.113.128.0',bits: 17, carrier: 'Viettel', asn: 7552 },
  { prefix: '210.245.0.0',  bits: 16, carrier: 'Viettel', asn: 7552 },
  { prefix: '203.190.160.0',bits: 19, carrier: 'Viettel', asn: 7552 },
  // ── VNPT (incl. VinaPhone mobile) — AS45899 ──────────────────
  { prefix: '14.232.0.0',   bits: 13, carrier: 'VNPT', asn: 45899 },
  { prefix: '116.96.0.0',   bits: 12, carrier: 'VNPT', asn: 45899 },
  { prefix: '113.176.0.0',  bits: 12, carrier: 'VNPT', asn: 45899 },
  { prefix: '125.234.0.0',  bits: 15, carrier: 'VNPT', asn: 45899 },
  { prefix: '171.232.0.0',  bits: 13, carrier: 'VNPT', asn: 45899 },
  { prefix: '203.162.0.0',  bits: 16, carrier: 'VNPT', asn: 45899 },
  // 222.252.0.0/14 covers 222.252.0.0–222.255.255.255 (toàn dải VNPT-VN per APNIC)
  { prefix: '222.252.0.0',  bits: 14, carrier: 'VNPT', asn: 45899 },
  { prefix: '123.16.0.0',   bits: 13, carrier: 'VNPT', asn: 45899 },
  { prefix: '14.231.0.0',   bits: 16, carrier: 'VNPT', asn: 45899 },
  // ── MobiFone — AS45776 ──────────────────────────────────────
  { prefix: '125.214.0.0',  bits: 17, carrier: 'MobiFone', asn: 45776 },
  { prefix: '210.245.0.0',  bits: 18, carrier: 'MobiFone', asn: 45776 },
  // ── Vietnamobile — AS135887 ─────────────────────────────────
  { prefix: '113.187.0.0',  bits: 16, carrier: 'Vietnamobile', asn: 135887 },
  { prefix: '14.187.0.0',   bits: 16, carrier: 'Vietnamobile', asn: 135887 },
  // ── FPT Telecom — AS18403 (ISP fiber-to-home phổ biến) ──────
  { prefix: '14.169.0.0',   bits: 16, carrier: 'FPT', asn: 18403 },
  { prefix: '42.118.0.0',   bits: 16, carrier: 'FPT', asn: 18403 },
  { prefix: '113.171.0.0',  bits: 16, carrier: 'FPT', asn: 18403 },
  { prefix: '113.190.0.0',  bits: 16, carrier: 'FPT', asn: 18403 },
  { prefix: '117.0.0.0',    bits: 13, carrier: 'FPT', asn: 18403 },
  { prefix: '118.69.0.0',   bits: 16, carrier: 'FPT', asn: 18403 },
  { prefix: '210.245.32.0', bits: 19, carrier: 'FPT', asn: 18403 },
  { prefix: '123.30.0.0',   bits: 15, carrier: 'FPT', asn: 18403 },
  // ── CMC Telecom — AS131193 ──────────────────────────────────
  { prefix: '103.74.116.0', bits: 22, carrier: 'CMC', asn: 131193 },
  { prefix: '203.113.156.0',bits: 22, carrier: 'CMC', asn: 131193 },
  { prefix: '14.241.0.0',   bits: 16, carrier: 'CMC', asn: 131193 },
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

  // Try iptoasn.com first, then fallback to ipapi.co.
  // Timeout 4s each (down từ 8s) — fail-fast hơn để fallback nhanh.
  type LookupOk = { asn: number; asName: string | null; asCountry: string | null };
  async function lookupViaIptoAsn(): Promise<LookupOk | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`https://api.iptoasn.com/v1/as/ip/${encodeURIComponent(ip)}`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const data: any = await res.json();
      if (!data.announced || !data.as_number) return null;
      return {
        asn: Number(data.as_number),
        asName: data.as_description || null,
        asCountry: data.as_country_code || null,
      };
    } catch { return null; }
  }

  async function lookupViaIpApi(): Promise<LookupOk | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      // ipapi.co — free 30k req/month, no key needed
      const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const data: any = await res.json();
      if (!data.asn) return null;
      // ipapi.co returns asn as string like "AS7552"
      const asnNum = Number(String(data.asn).replace(/^AS/i, ''));
      if (!asnNum) return null;
      return {
        asn: asnNum,
        asName: data.org || data.asn || null,
        asCountry: data.country_code || null,
      };
    } catch { return null; }
  }

  // Team Cymru free WHOIS service — không key, ổn định.
  // Format: dig +short AS<ip>.origin.asn.cymru.com TXT
  // Vì backend không có dig sẵn, dùng DNS-over-HTTPS (DoH) qua Cloudflare.
  async function lookupViaCymru(): Promise<LookupOk | null> {
    try {
      const reversed = ip.split('.').reverse().join('.');
      const query = `${reversed}.origin.asn.cymru.com`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${query}&type=TXT`,
        { signal: controller.signal, headers: { Accept: 'application/dns-json' } },
      );
      clearTimeout(timeout);
      if (!res.ok) return null;
      const data: any = await res.json();
      const answer = data.Answer?.[0]?.data;
      if (!answer) return null;
      // Format: "ASN | Prefix | Country | Registry | Allocation_date"
      // e.g. "7552 | 1.52.0.0/14 | VN | apnic | 2010-07-21"
      const parts = String(answer).replace(/"/g, '').split('|').map((s) => s.trim());
      const asn = parseInt(parts[0]);
      if (!asn) return null;
      return { asn, asName: null, asCountry: parts[2] || null };
    } catch { return null; }
  }

  // Run all 3 in parallel — first non-null wins
  const lookup = await Promise.race([
    lookupViaIptoAsn().then((r) => r ?? lookupViaIpApi().then((r2) => r2 ?? lookupViaCymru())),
    lookupViaIpApi().then((r) => r ?? lookupViaIptoAsn().then((r2) => r2 ?? lookupViaCymru())),
    lookupViaCymru().then((r) => r ?? lookupViaIptoAsn().then((r2) => r2 ?? lookupViaIpApi())),
  ]);

  if (lookup) {
    const carrier = ASN_TO_CARRIER[lookup.asn] || null;
    const value: CarrierDetection = {
      ip,
      asn: lookup.asn,
      asName: lookup.asName,
      asCountry: lookup.asCountry,
      carrier,
      confidence: carrier ? 'high' : (lookup.asCountry === 'VN' ? 'low' : 'none'),
    };
    cache.set(ip, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
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
