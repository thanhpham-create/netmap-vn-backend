// Minimal CSV serializer (RFC 4180 compliant for our use case).

function escapeCell(v: any): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : (v instanceof Date ? v.toISOString() : String(v));
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Convert array of records to CSV string.
 * Header columns auto-detected from first row's keys, or pass `columns`.
 */
export function rowsToCsv<T extends Record<string, any>>(
  rows: T[],
  columns?: (keyof T & string)[],
): string {
  if (rows.length === 0) return columns ? columns.join(',') + '\n' : '';
  const cols = columns || (Object.keys(rows[0]) as (keyof T & string)[]);
  const lines = [cols.join(',')];
  for (const row of rows) {
    lines.push(cols.map((c) => escapeCell(row[c])).join(','));
  }
  return lines.join('\n') + '\n';
}
