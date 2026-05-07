/**
 * OpenClaw Automation Workflow Engine
 * ─────────────────────────────────────
 * Define and run multi-step automation workflows.
 * Each workflow is a JSON-defined chain of steps with conditions.
 *
 * Built-in actions:
 *   brain.think    → Ask Ollama
 *   browser.search → Web search
 *   browser.scrape → Scrape URL
 *   mail.send      → Send email
 *   memory.save    → Save to LTM
 *   log            → Log message
 *   wait           → Delay
 *   condition      → Branch on result
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs     = require('fs-extra');
const path   = require('path');
const logger = require('../logger');
const ltm    = require('../memory/longTerm');
const brain  = require('../brain/ollama');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'tasks', 'workflows');

// ── Built-in action registry ──────────────────────────────────────────────────
const ACTIONS = {

  'brain.think': async (params, ctx) => {
    const prompt = interpolate(params.prompt, ctx);
    const result = await brain.think(prompt, { temperature: params.temperature || 0.7 });
    return { output: result };
  },

  'brain.plan': async (params, ctx) => {
    const task = interpolate(params.task, ctx);
    const plan = await require('../brain/ollama').plan(task);
    return { plan };
  },

  'browser.search': async (params, ctx) => {
    const query = interpolate(params.query, ctx);
    const browser = require('./browser');
    return browser.search(query, params.limit || 5);
  },

  'browser.scrape': async (params, ctx) => {
    const url = interpolate(params.url, ctx);
    const browser = require('./browser');
    return browser.scrape(url, params.selector);
  },

  'browser.trends': async () => {
    const browser = require('./browser');
    return browser.checkTrends();
  },

  'mail.send': async (params, ctx) => {
    const mail = require('./mail');
    return mail.send(
      interpolate(params.to, ctx),
      interpolate(params.subject, ctx),
      interpolate(params.body, ctx)
    );
  },

  'mail.report': async (params, ctx) => {
    const mail = require('./mail');
    return mail.sendDailySummary();
  },

  'memory.save': async (params, ctx) => {
    const content = interpolate(params.content, ctx);
    await ltm.addEpisode(params.type || 'workflow', content, params.tags || ['workflow'], params.importance || 5);
    return { saved: true };
  },

  'log': async (params, ctx) => {
    const msg = interpolate(params.message, ctx);
    logger.info(`[Workflow] ${msg}`);
    return { logged: true };
  },

  'wait': async (params) => {
    const ms = (params.seconds || 1) * 1000;
    await new Promise(r => setTimeout(r, ms));
    return { waited: params.seconds };
  },

  'condition': async (params, ctx) => {
    const value = resolveRef(params.value, ctx);
    const passes = evaluateCondition(value, params.operator || 'truthy', params.compare);
    return { passes, branch: passes ? 'true' : 'false' };
  },
};

// ── Run a workflow definition ─────────────────────────────────────────────────
async function runWorkflow(workflowOrPath, inputData = {}) {
  let workflow;

  if (typeof workflowOrPath === 'string') {
    const filepath = path.extname(workflowOrPath) ? workflowOrPath : path.join(WORKFLOWS_DIR, `${workflowOrPath}.json`);
    workflow = await fs.readJson(filepath);
  } else {
    workflow = workflowOrPath;
  }

  logger.info(`[Workflow] Starting: "${workflow.name}"`);

  const ctx = {
    input: inputData,
    steps: {},
    vars:  workflow.vars || {},
    startedAt: new Date().toISOString(),
  };

  const steps  = workflow.steps || [];
  let   cursor = 0;

  while (cursor < steps.length) {
    const step = steps[cursor];

    if (!step || !step.action) { cursor++; continue; }

    logger.info(`[Workflow] Step [${step.id || cursor}]: ${step.action}`);

    try {
      const action = ACTIONS[step.action];
      if (!action) {
        logger.warn(`[Workflow] Unknown action: ${step.action}`);
        cursor++;
        continue;
      }

      const result = await action(step.params || {}, ctx);
      ctx.steps[step.id || `step${cursor}`] = result;

      // Handle condition branching
      if (step.action === 'condition' && step.branches) {
        const branch = result.passes ? (step.branches.true || 'next') : (step.branches.false || 'next');
        if (branch === 'end') break;
        if (branch !== 'next') {
          const nextIdx = steps.findIndex(s => s.id === branch);
          if (nextIdx >= 0) { cursor = nextIdx; continue; }
        }
      }

      // On-success jump
      if (result && result.success === false && step.onFail) {
        if (step.onFail === 'end') break;
        const failIdx = steps.findIndex(s => s.id === step.onFail);
        if (failIdx >= 0) { cursor = failIdx; continue; }
      }

    } catch (err) {
      logger.error(`[Workflow] Step ${step.id || cursor} error: ${err.message}`);
      ctx.steps[step.id || `step${cursor}`] = { error: err.message };
      if (step.onFail === 'end') break;
    }

    cursor++;
  }

  ctx.completedAt = new Date().toISOString();
  logger.info(`[Workflow] "${workflow.name}" complete`);

  await ltm.addEpisode('workflow_run', `Workflow "${workflow.name}" completed`, ['workflow'], 5);

  // Optionally persist result
  if (workflow.saveResult) {
    await fs.ensureDir(WORKFLOWS_DIR);
    await fs.writeJson(path.join(WORKFLOWS_DIR, `result-${workflow.name}-${Date.now()}.json`), ctx, { spaces: 2 });
  }

  return ctx;
}

// ── Built-in workflows ────────────────────────────────────────────────────────
const BUILT_IN = {

  daily_trends: {
    name: 'daily_trends',
    description: 'Fetch YouTube trends, summarize with AI, save to memory',
    steps: [
      { id: 'fetch',    action: 'browser.trends', params: {} },
      { id: 'summarize', action: 'brain.think', params: {
        prompt: 'Summarize these YouTube trends in 3 bullet points: {{steps.fetch.summary}}',
        temperature: 0.4,
      }},
      { id: 'save', action: 'memory.save', params: {
        type: 'trends', content: '{{steps.summarize.output}}', tags: ['trends', 'youtube'], importance: 6,
      }},
      { id: 'log', action: 'log', params: { message: 'Trends workflow complete: {{steps.summarize.output}}' }},
    ],
  },

  task_report: {
    name: 'task_report',
    description: 'Send daily task report via email',
    steps: [
      { id: 'report', action: 'mail.report', params: {} },
      { id: 'log',    action: 'log', params: { message: 'Daily report sent' }},
    ],
  },
};

async function runBuiltIn(name, input = {}) {
  if (!BUILT_IN[name]) throw new Error(`No built-in workflow: ${name}`);
  return runWorkflow(BUILT_IN[name], input);
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function interpolate(template, ctx) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{([^}]+)\}\}/g, (_, ref) => {
    const val = resolveRef(ref.trim(), ctx);
    return val !== undefined ? String(val) : `{{${ref}}}`;
  });
}

function resolveRef(ref, ctx) {
  const parts = ref.split('.');
  let obj = ctx;
  for (const p of parts) {
    if (obj == null) return undefined;
    obj = obj[p];
  }
  return obj;
}

function evaluateCondition(value, operator, compare) {
  switch (operator) {
    case 'truthy':   return !!value;
    case 'falsy':    return !value;
    case 'eq':       return String(value) === String(compare);
    case 'neq':      return String(value) !== String(compare);
    case 'includes': return String(value).includes(compare);
    case 'gt':       return Number(value) > Number(compare);
    case 'lt':       return Number(value) < Number(compare);
    default:         return !!value;
  }
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────
if (require.main === module) {
  const name = process.argv[2] || 'daily_trends';
  runBuiltIn(name)
    .then(ctx => { console.log('\n✅ Workflow result:\n', JSON.stringify(ctx.steps, null, 2)); process.exit(0); })
    .catch(e  => { console.error('Error:', e.message); process.exit(1); });
}

module.exports = { runWorkflow, runBuiltIn, BUILT_IN, ACTIONS };
