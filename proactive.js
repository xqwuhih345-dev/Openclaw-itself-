/**
 * OpenClaw Proactive Agent
 * ─────────────────────────
 * Monitors the environment and takes initiative without being asked.
 * Runs on a schedule and:
 *   - Checks for pending/stuck tasks and reschedules them
 *   - Monitors for missed call windows and retries
 *   - Scans for optimization opportunities using Ollama
 *   - Alerts via WhatsApp/log when something needs attention
 *   - Pre-fetches context before scheduled call windows
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const cron    = require('node-cron');
const logger  = require('../logger');
const store   = require('../memory/store');
const ltm     = require('../memory/longTerm');
const brain   = require('../brain/ollama');
const prompts = require('../brain/prompts');

let _onAlert    = null; // callback(msg) for notifications
let _onAction   = null; // callback(action) for executing suggested actions
let _running    = false;

// ── Public API ────────────────────────────────────────────────────────────────
function onAlert(fn)  { _onAlert  = fn; }
function onAction(fn) { _onAction = fn; }

function start() {
  if (_running) return;
  _running = true;

  logger.info('[Proactive] Agent started');

  // Every 15 minutes — light health check
  cron.schedule('*/15 * * * *', () => lightCheck().catch(e => logger.error('[Proactive] lightCheck error:', e.message)));

  // Every hour — deep analysis with Ollama
  cron.schedule('0 * * * *', () => deepAnalysis().catch(e => logger.error('[Proactive] deepAnalysis error:', e.message)));

  // 8:45 AM — pre-warm before 9 AM call
  cron.schedule('45 8 * * *', () => preWarm('task1').catch(e => logger.error('[Proactive] preWarm error:', e.message)), { timezone: 'America/Jamaica' });

  // 10:30 PM — daily summary
  cron.schedule('30 22 * * *', () => dailySummary().catch(e => logger.error('[Proactive] dailySummary error:', e.message)), { timezone: 'America/Jamaica' });
}

// ── Light check (every 15 min) ────────────────────────────────────────────────
async function lightCheck() {
  const mem = store.load();
  store.ensureTodayState(mem);

  const now     = new Date();
  const hour    = now.getHours();
  const lastHB  = mem.meta.lastHeartbeat ? new Date(mem.meta.lastHeartbeat) : null;
  const stale   = lastHB ? (now - lastHB) > 10 * 60 * 1000 : false; // >10 min

  if (stale) {
    alert('⚠️ OpenClaw heartbeat is stale — agent may be stuck');
  }

  // Check if task1 should have been called by now
  if (hour >= 10 && !mem.dailyState.task1) {
    alert('⚠️ Task 1 not received by 10 AM — missed call window, will retry');
    if (_onAction) _onAction({ type: 'retry_call', purpose: 'task1' });
  }

  // Check for stuck task (received but not completed for >2h)
  const task1Age = mem.dailyState.task1 && !mem.dailyState.task1Completed;
  if (task1Age && hour >= 11) {
    alert('⚠️ Task 1 was received but not completed — may be stuck');
  }

  logger.info('[Proactive] Light check complete');
}

// ── Deep analysis with Ollama (hourly) ───────────────────────────────────────
async function deepAnalysis() {
  const brainOk = await brain.isAvailable();
  if (!brainOk) {
    logger.warn('[Proactive] Ollama not available — skipping deep analysis');
    return;
  }

  const mem     = store.load();
  const history = mem.history.slice(-7).map(h =>
    `${h.date}: T1=${h.task1Completed?'✅':'❌'} T2=${h.task2Completed?'✅':'❌'}`
  ).join('\n');

  const status = {
    today: mem.dailyState,
    totalCompleted: mem.meta.totalTasksCompleted,
    recentErrors: mem.errors.slice(0, 3),
  };

  try {
    const raw = await brain.think(prompts.proactiveSuggest(status, history), { temperature: 0.4 });
    const start = raw.indexOf('{');
    const end   = raw.lastIndexOf('}') + 1;

    if (start >= 0) {
      const result = JSON.parse(raw.slice(start, end));

      // Store insights
      if (result.actions?.length) {
        for (const a of result.actions.filter(x => x.priority === 'high')) {
          await ltm.addEpisode('proactive_suggestion', `${a.action}: ${a.reason}`, ['proactive'], 7);
          if (_onAction) _onAction({ type: 'suggestion', ...a });
        }
      }

      if (result.warnings?.length) {
        for (const w of result.warnings) alert(`🤖 Proactive: ${w}`);
      }

      logger.info(`[Proactive] Deep analysis done — ${result.actions?.length || 0} actions suggested`);
    }
  } catch (e) {
    logger.warn('[Proactive] Deep analysis parse error:', e.message);
  }
}

// ── Pre-warm before scheduled call ────────────────────────────────────────────
async function preWarm(purpose) {
  logger.info(`[Proactive] Pre-warming for ${purpose} call in 15 minutes`);
  await ltm.addEpisode('pre_warm', `Pre-warming context for ${purpose}`, ['system']);

  // Prime the brain with recent context
  const brainOk = await brain.isAvailable();
  if (brainOk) {
    const mem = store.load();
    const history = mem.history.slice(-3).map(h => `${h.date}: ${h.task1||'—'}`).join(', ');
    await brain.think(`OpenClaw pre-warm: recent tasks were [${history}]. Get ready for today's task.`, { temperature: 0.1 });
    logger.info('[Proactive] Brain pre-warmed');
  }
}

// ── Daily summary ──────────────────────────────────────────────────────────────
async function dailySummary() {
  const mem = store.load();
  const t1  = mem.dailyState.task1Completed;
  const t2  = mem.dailyState.task2Completed;

  const msg = [
    `📊 Daily Summary — ${store.today()}`,
    `Task 1: ${t1 ? '✅ Complete' : '❌ Incomplete'} — ${mem.dailyState.task1 || 'not received'}`,
    `Task 2: ${t2 ? '✅ Complete' : '❌ Incomplete'} — ${mem.dailyState.task2 || 'not received'}`,
    `Total tasks ever: ${mem.meta.totalTasksCompleted}`,
  ].join('\n');

  alert(msg);
  await ltm.addEpisode('daily_summary', msg, ['summary'], 6);
  logger.info('[Proactive] Daily summary sent');
}

// ── Alert helper ──────────────────────────────────────────────────────────────
function alert(msg) {
  logger.warn(`[Proactive] ALERT: ${msg}`);
  if (_onAlert) _onAlert(msg);
}

// ── Run a one-off analysis ────────────────────────────────────────────────────
async function runNow() {
  await lightCheck();
  await deepAnalysis();
}

module.exports = { start, onAlert, onAction, runNow, deepAnalysis, dailySummary };
