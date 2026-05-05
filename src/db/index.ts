import postgres from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Auto-load .env file if present in cwd (no dotenv dep needed).
// Existing env vars take precedence (so explicit `export FOO=bar` wins over .env).
try {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^['"](.*)['"]$/, '$1');
      }
    }
  }
} catch { /* ignore */ }

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required (set in shell or .env file)');
}

const sql = postgres(connectionString, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  ssl: connectionString.includes('localhost') ? false : 'require',
  transform: {
    column: {
      from: postgres.toCamel,
      to: postgres.fromCamel,
    },
  },
});

export default sql;
