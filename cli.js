/**
 * OpenClaw Memory CLI
 * Usage:
 *   node memory/cli.js view       — pretty-print full memory
 *   node memory/cli.js clear      — reset daily state only
 *   node memory/cli.js history    — list task history
 */

const { load, save, DEFAULT, today } = require('./store');

const cmd = process.argv[2] || 'view';
const mem = load();

if (cmd === 'view') {
  console.log(JSON.stringify(mem, null, 2));

} else if (cmd === 'clear') {
  mem.dailyState = { ...require('./store').load().dailyState, date: today() };
  save(mem);
  console.log('[Memory] Daily state cleared for', today());

} else if (cmd === 'history') {
  if (!mem.history.length) return console.log('No history yet.');
  mem.history.forEach(h => {
    console.log(`\n📅 ${h.date}`);
    console.log(`  Task 1: ${h.task1 || '—'} [${h.task1Completed ? '✅' : '❌'}]`);
    console.log(`  Task 2: ${h.task2 || '—'} [${h.task2Completed ? '✅' : '❌'}]`);
  });

} else {
  console.log('Unknown command. Use: view | clear | history');
}
