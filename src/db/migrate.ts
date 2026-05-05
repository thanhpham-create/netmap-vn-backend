// NetMap VN — Database migration runner
// Apply each .sql file in schema/migrations/ exactly once, recording in _migrations table.
// Safe for production: idempotent, transactional per file.

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import sql from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../schema/migrations');

async function ensureMigrationsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum   TEXT
    )
  `;
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const rows = await sql<{ filename: string }[]>`SELECT filename FROM _migrations`;
  return new Set(rows.map((r) => r.filename));
}

function listMigrationFiles(): string[] {
  let files: string[];
  try {
    files = readdirSync(MIGRATIONS_DIR);
  } catch (err) {
    console.error(`✖ Cannot read migrations directory: ${MIGRATIONS_DIR}`);
    throw err;
  }
  return files.filter((f) => f.endsWith('.sql')).sort();
}

async function applyMigration(filename: string) {
  const fullPath = join(MIGRATIONS_DIR, filename);
  const content = readFileSync(fullPath, 'utf-8');

  console.log(`→ Applying ${filename}...`);
  await sql.begin(async (tx) => {
    await tx.unsafe(content);
    await tx`INSERT INTO _migrations (filename) VALUES (${filename})`;
  });
  console.log(`  ✓ ${filename}`);
}

async function migrate() {
  console.log(`📦 NetMap VN — DB migrations (${MIGRATIONS_DIR})`);
  await ensureMigrationsTable();

  const applied = await getAppliedMigrations();
  const all = listMigrationFiles();
  const pending = all.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log(`✓ No pending migrations (${applied.size} already applied).`);
    return;
  }

  console.log(`Found ${pending.length} pending migration(s):`);
  pending.forEach((f) => console.log(`  • ${f}`));
  console.log('');

  for (const filename of pending) {
    try {
      await applyMigration(filename);
    } catch (err) {
      console.error(`✖ Failed on ${filename}:`, err);
      process.exit(1);
    }
  }

  console.log(`\n✅ Applied ${pending.length} migration(s).`);
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('✖ Migration runner crashed:', err);
    process.exit(1);
  });
