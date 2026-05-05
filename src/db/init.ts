// DEPRECATED — use src/db/migrate.ts (safe) or src/db/reset.ts (destructive) instead.
// This file is kept only to avoid breaking old `tsx src/db/init.ts` calls.
// You can delete it once your scripts are migrated.

console.error('⛔ src/db/init.ts is deprecated.');
console.error('   Use one of:');
console.error('     yarn db:migrate    # apply pending migrations (production-safe)');
console.error('     yarn db:reset      # drop all tables (dev-only)');
console.error('     yarn db:setup      # reset + migrate (dev fresh start)');
process.exit(1);
