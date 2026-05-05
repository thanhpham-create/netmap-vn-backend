// NetMap VN — DESTRUCTIVE database reset
// Drops all tables (including _migrations). Use only in dev/test.
// Refuses NODE_ENV=production unless --force flag.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import sql from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESET_FILE = resolve(__dirname, '../../schema/reset.sql');

async function reset() {
  const NODE_ENV = process.env.NODE_ENV || 'development';
  const force = process.argv.includes('--force');

  if (NODE_ENV === 'production' && !force) {
    console.error('⛔ Refusing to reset in NODE_ENV=production without --force flag.');
    console.error('   This will DROP ALL TABLES and DELETE ALL DATA.');
    console.error('   If you really want to do this, run with: --force');
    process.exit(1);
  }

  if (NODE_ENV === 'production' && force) {
    console.warn('⚠️  Production reset with --force. Sleeping 5s. Ctrl+C to abort.');
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.log(`🗑  Resetting NetMap DB (NODE_ENV=${NODE_ENV})...`);
  const content = readFileSync(RESET_FILE, 'utf-8');

  try {
    await sql.unsafe(content);
    console.log('✓ All tables/functions dropped. Run `yarn db:migrate` to recreate schema.');
  } catch (err) {
    console.error('✖ Reset failed:', err);
    process.exit(1);
  }

  process.exit(0);
}

reset();
