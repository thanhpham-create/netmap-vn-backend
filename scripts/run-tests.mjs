// Runs each compiled test file as a separate Node process.
// Avoids Node 20.x test runner IPC bug (deserialize error) by not using --test mode.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const TESTS_DIR = 'dist-tests/tests';

let files;
try {
  files = readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.js')).sort();
} catch (err) {
  console.error(`✖ Cannot read ${TESTS_DIR}. Did you run \`tsc -p tsconfig.tests.json\` first?`);
  process.exit(2);
}

if (files.length === 0) {
  console.error(`✖ No *.test.js files in ${TESTS_DIR}`);
  process.exit(2);
}

const results = [];
for (const f of files) {
  const path = join(TESTS_DIR, f);
  console.log(`\n=== ${path} ===`);
  const res = spawnSync('node', [path], { stdio: 'inherit' });
  results.push({ file: f, status: res.status });
}

console.log('\n──────── Summary ────────');
let failed = 0;
for (const r of results) {
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✖'}  ${r.file}${ok ? '' : ` (exit ${r.status})`}`);
}
console.log(`\n${results.length - failed}/${results.length} files passed.`);
process.exit(failed > 0 ? 1 : 0);
