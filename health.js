/**
 * OpenClaw Health Reporter
 * Prints a quick human-readable health summary.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const store  = require('../memory/store');
const { runWatchdog } = require('./watchdog');

(async () => {
  const mem    = store.load();
  const today  = store.today();
  store.ensureTodayState(mem);

  console.log('\n═══════════════════════════════════════');
  console.log('       OpenClaw Health Report');
  console.log('═══════════════════════════════════════');
  console.log(`Date            : ${today}`);
  console.log(`Last Heartbeat  : ${mem.meta.lastHeartbeat || 'never'}`);
  console.log(`Total Completed : ${mem.meta.totalTasksCompleted}`);
  console.log('');
  console.log('── Today ───────────────────────────────');
  console.log(`Task 1 received : ${mem.dailyState.task1 ? '✅' : '❌'} ${mem.dailyState.task1 || ''}`);
  console.log(`Task 1 done     : ${mem.dailyState.task1Completed ? '✅' : '⏳'}`);
  console.log(`Task 2 received : ${mem.dailyState.task2 ? '✅' : '❌'} ${mem.dailyState.task2 || ''}`);
  console.log(`Task 2 done     : ${mem.dailyState.task2Completed ? '✅' : '⏳'}`);
  console.log(`Last call       : ${mem.dailyState.lastCallAttempt || 'not yet'}`);
  console.log('');

  const { ok, issues, warnings } = await runWatchdog(true);
  console.log('── System ──────────────────────────────');
  console.log(`Status          : ${ok ? '✅ Healthy' : '❌ Issues found'}`);
  if (issues.length)   issues.forEach(i   => console.log(`  ✗ ${i}`));
  if (warnings.length) warnings.forEach(w => console.log(`  ⚠ ${w}`));
  if (!issues.length && !warnings.length) console.log('  All checks pass.');
  console.log('═══════════════════════════════════════\n');
})();
