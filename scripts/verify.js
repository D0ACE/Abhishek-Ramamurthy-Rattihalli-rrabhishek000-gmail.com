// Canonical Verification Suite for RemoteOps
// Runs all suites in sequence and prints a comprehensive scorecard.
// Run: npm run verify

import { execSync } from 'node:child_process';

const steps = [
  { name: 'Production Build', cmd: 'npm run build', label: 'Vite & React SPA Build' },
  { name: 'JWT Cryptography & Parser', cmd: 'node scripts/check-jwt.js', label: '43 checks' },
  { name: 'Permission Engine & Scopes', cmd: 'node scripts/check-permissions.js', label: '35 checks' },
  { name: 'API Scoping & Invariants', cmd: 'node scripts/check-api.js', label: '66 checks' },
  { name: 'Dynamic Personalisation', cmd: 'node scripts/check-personalisation.js', label: '18 checks' },
  { name: 'Security Hardening & Concurrency', cmd: 'node scripts/check-hardening.js', label: '37 checks' },
  { name: 'Playwright E2E Browser Suite', cmd: 'npx playwright test', label: '25 tests' },
];

console.log('======================================================================');
console.log('REMOTEOPS CANONICAL VERIFICATION');
console.log('======================================================================\n');

let allOk = true;

for (const step of steps) {
  process.stdout.write(`Running ${step.name.padEnd(35)} ... `);
  try {
    execSync(step.cmd, { stdio: 'pipe', env: process.env });
    console.log(`✓ PASS (${step.label})`);
  } catch (err) {
    console.log(`✖ FAIL`);
    if (err.stdout) console.log(err.stdout.toString());
    if (err.stderr) console.error(err.stderr.toString());
    allOk = false;
    break;
  }
}

console.log('\n----------------------------------------------------------------------');
if (allOk) {
  console.log('STATUS: ALL 224 AUTOMATED CHECKS PASSED (0 FAILURES)');
} else {
  console.log('STATUS: VERIFICATION FAILURES DETECTED');
}
console.log('======================================================================');

process.exit(allOk ? 0 : 1);
