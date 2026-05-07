/**
 * OpenClaw Self-Improvement Agent
 * ─────────────────────────────────
 * Runs periodic self-analysis using Ollama to:
 *   - Review task performance and completion rates
 *   - Identify failure patterns
 *   - Tune agent config (timing, retries, prompts)
 *   - Update long-term memory with insights
 *   - Generate improvement reports
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const cron    = require('node-cron');
const logger  = require('../logger');
const store   = require('../memory/store');
const ltm     = require('../memory/longTerm');
const brain   = require('../brain/ollama');
const prompts = require('../brain/prompts');
const fs      = require('fs-extra');
const path    = require('path');

const REPORTS_DIR = path.join(__dirname, '..', 'logs', 'improvement-reports');

// ── Start self-improvement loop ───────────────────────────────────────────────
function start() {
  logger.info('[SelfImprove] Agent started');

  // Weekly deep reflection — every Sunday at 11 PM
  cron.schedule('0 23 * * 0', () => runReflection('weekly').catch(e =>
    logger.error('[SelfImprove] weekly reflection error:', e.message)
  ), { timezone: 'America/Jamaica' });

  // Daily micro-reflection at midnight
  cron.schedule('0 0 * * *', () => runReflection('daily').catch(e =>
    logger.error('[SelfImprove] daily reflection error:', e.message)
  ), { timezone: 'America/Jamaica' });
}

// ── Main reflection engine ────────────────────────────────────────────────────
async function runReflection(mode = 'daily') {
  logger.info(`[SelfImprove] Running ${mode} reflection…`);

  const brainOk = await brain.isAvailable();
  if (!brainOk) {
    logger.warn('[SelfImprove] Ollama not available — skipping reflection');
    return null;
  }

  const mem      = store.load();
  const ltmStats = ltm.getStats();

  // Compute metrics
  const history   = mem.history.slice(mode === 'weekly' ? -7 : -1);
  const completed = history.filter(h => h.task1Completed && h.task2Completed).length;
  const partial   = history.filter(h => h.task1Completed !== h.task2Completed).length;
  const failed    = history.filter(h => !h.task1Completed && !h.task2Completed).length;

  const metrics = {
    period: mode,
    daysAnalyzed: history.length,
    fullyCompleted: completed,
    partiallyCompleted: partial,
    fullyFailed: failed,
    successRate: history.length ? (completed / history.length) : 1,
    totalTasksEver: mem.meta.totalTasksCompleted,
    longTermStats: ltmStats,
  };

  const historyStr = history.map(h =>
    `${h.date}: T1="${(h.task1||'—').substring(0,50)}" (${h.task1Completed?'✅':'❌'})  T2="${(h.task2||'—').substring(0,50)}" (${h.task2Completed?'✅':'❌'})`
  ).join('\n');

  try {
    const raw = await brain.think(
      prompts.selfImprove(metrics, mem.errors.slice(0, 10), historyStr),
      { temperature: 0.4, max_tokens: 1024 }
    );

    const start = raw.indexOf('{');
    const end   = raw.lastIndexOf('}') + 1;

    if (start < 0) throw new Error('No JSON in response');

    const result = JSON.parse(raw.slice(start, end));

    // Save insights to long-term memory
    if (result.insights) {
      for (const insight of result.insights) {
        ltm.addInsight(insight, `${mode}_reflection`);
      }
    }

    // Apply suggested config changes
    if (result.configChanges && Object.keys(result.configChanges).length > 0) {
      ltm.updateAgentConfig(result.configChanges);
      logger.info('[SelfImprove] Config updated:', JSON.stringify(result.configChanges));
    }

    // Save improvement report
    const report = {
      date:     new Date().toISOString(),
      mode,
      metrics,
      analysis: result,
    };

    await saveReport(report);
    await ltm.addEpisode('reflection', JSON.stringify(result).substring(0, 300), ['reflection', mode], 8);

    logger.info(`[SelfImprove] ${mode} reflection complete. Health score: ${result.healthScore || 'N/A'}`);
    return result;

  } catch (e) {
    logger.error('[SelfImprove] Reflection error:', e.message);
    store.recordError(mem, `reflection_${mode}: ${e.message}`);
    return null;
  }
}

// ── Self-heal: auto-fix common issues ─────────────────────────────────────────
async function selfHeal(issue) {
  logger.info(`[SelfImprove] Self-healing: ${issue}`);

  const brainOk = await brain.isAvailable();
  if (!brainOk) return null;

  const prompt = `You are OpenClaw's self-healing system.

Issue detected: ${issue}

What is the best automated fix for this issue?
Return JSON:
{
  "canAutoFix": true|false,
  "fix": "description of fix",
  "action": "restart|retry|skip|alert",
  "params": {}
}`;

  try {
    const raw   = await brain.think(prompt, { temperature: 0.2 });
    const start = raw.indexOf('{');
    const end   = raw.lastIndexOf('}') + 1;
    const fix   = JSON.parse(raw.slice(start, end));

    await ltm.addEpisode('self_heal', `Issue: ${issue} → Fix: ${fix.fix}`, ['heal'], 7);
    logger.info(`[SelfImprove] Self-heal plan: ${JSON.stringify(fix)}`);
    return fix;
  } catch (e) {
    logger.warn('[SelfImprove] Self-heal parse error:', e.message);
    return null;
  }
}

// ── Performance score ─────────────────────────────────────────────────────────
function getPerformanceScore() {
  const mem     = store.load();
  const history = mem.history.slice(-30);
  if (!history.length) return { score: 100, label: 'No data yet' };

  const successCount = history.filter(h => h.task1Completed && h.task2Completed).length;
  const score = Math.round((successCount / history.length) * 100);

  let label = 'Excellent';
  if (score < 50) label = 'Needs attention';
  else if (score < 75) label = 'Fair';
  else if (score < 90) label = 'Good';

  return { score, label, history: history.length, successCount };
}

// ── Save report to disk ────────────────────────────────────────────────────────
async function saveReport(report) {
  try {
    await fs.ensureDir(REPORTS_DIR);
    const filename = `${report.mode}-${report.date.split('T')[0]}.json`;
    await fs.writeJson(path.join(REPORTS_DIR, filename), report, { spaces: 2 });
    logger.info(`[SelfImprove] Report saved: ${filename}`);
  } catch (e) {
    logger.warn('[SelfImprove] Could not save report:', e.message);
  }
}

module.exports = { start, runReflection, selfHeal, getPerformanceScore };
