/**
 * OpenClaw Brain — Ollama Interface
 * ───────────────────────────────────
 * Connects to a local Ollama instance and provides:
 *   - think(prompt)          → single completion
 *   - plan(task)             → structured task plan
 *   - reflect(history)       → self-reflection / improvement suggestions
 *   - embed(text)            → text embedding for memory search
 *   - chat(messages)         → multi-turn conversation
 *   - isAvailable()          → health check
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios  = require('axios');
const logger = require('../logger');

const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const TIMEOUT = parseInt(process.env.OLLAMA_TIMEOUT || '120000'); // 2 min

// ── Core completion ───────────────────────────────────────────────────────────
async function think(prompt, opts = {}) {
  const model = opts.model || OLLAMA_MODEL;
  logger.info(`[Brain] Thinking with ${model} (${prompt.length} chars)`);

  try {
    const res = await axios.post(`${OLLAMA_URL}/api/generate`, {
      model,
      prompt,
      stream: false,
      options: {
        temperature:  opts.temperature  ?? 0.7,
        num_predict:  opts.max_tokens   ?? 1024,
        top_p:        opts.top_p        ?? 0.9,
      },
    }, { timeout: TIMEOUT });

    const text = res.data.response || '';
    logger.info(`[Brain] Response: ${text.substring(0, 100)}…`);
    return text.trim();
  } catch (err) {
    logger.error(`[Brain] think() error: ${err.message}`);
    throw err;
  }
}

// ── Multi-turn chat ───────────────────────────────────────────────────────────
async function chat(messages, opts = {}) {
  const model = opts.model || OLLAMA_MODEL;
  logger.info(`[Brain] Chat with ${model} (${messages.length} messages)`);

  try {
    const res = await axios.post(`${OLLAMA_URL}/api/chat`, {
      model,
      messages,
      stream: false,
      options: { temperature: opts.temperature ?? 0.7 },
    }, { timeout: TIMEOUT });

    return res.data.message?.content?.trim() || '';
  } catch (err) {
    logger.error(`[Brain] chat() error: ${err.message}`);
    throw err;
  }
}

// ── Task planner ──────────────────────────────────────────────────────────────
async function plan(task, context = '') {
  const prompt = `You are OpenClaw, an autonomous YouTube automation agent.

Your job is to break down the following task into a clear, numbered action plan.
Each step must be concrete and executable.

${context ? `Context from memory:\n${context}\n` : ''}
Task: ${task}

Return a JSON object like:
{
  "summary": "one-line summary",
  "steps": ["step 1", "step 2", ...],
  "priority": "high|medium|low",
  "estimatedMinutes": 5
}

Only return the JSON, nothing else.`;

  const raw = await think(prompt, { temperature: 0.3 });

  try {
    const start = raw.indexOf('{');
    const end   = raw.lastIndexOf('}') + 1;
    return JSON.parse(raw.slice(start, end));
  } catch {
    logger.warn('[Brain] plan() — JSON parse failed, returning raw');
    return { summary: task, steps: [task], priority: 'medium', estimatedMinutes: 5 };
  }
}

// ── Self-reflection ───────────────────────────────────────────────────────────
async function reflect(history = [], errors = []) {
  if (!history.length && !errors.length) return null;

  const historyStr = history.slice(-10).map(h =>
    `- ${h.date}: Task1="${h.task1||'—'}" (${h.task1Completed?'✅':'❌'}) Task2="${h.task2||'—'}" (${h.task2Completed?'✅':'❌'})`
  ).join('\n');

  const errStr = errors.slice(0, 5).map(e => `- ${e.ts}: ${e.error}`).join('\n');

  const prompt = `You are OpenClaw's self-improvement system.

Analyze the recent task history and errors below.
Identify patterns, failures, and suggest concrete improvements.

History (last 10 days):
${historyStr || 'No history yet.'}

Recent errors:
${errStr || 'No errors.'}

Return JSON:
{
  "insights": ["insight 1", "insight 2"],
  "improvements": ["improvement 1", "improvement 2"],
  "healthScore": 0-100,
  "recommendation": "one-line next action"
}

Only return JSON.`;

  const raw = await think(prompt, { temperature: 0.4 });

  try {
    const start = raw.indexOf('{');
    const end   = raw.lastIndexOf('}') + 1;
    return JSON.parse(raw.slice(start, end));
  } catch {
    return { insights: [], improvements: [], healthScore: 50, recommendation: raw.substring(0, 200) };
  }
}

// ── Embedding (for semantic memory) ──────────────────────────────────────────
async function embed(text) {
  try {
    const res = await axios.post(`${OLLAMA_URL}/api/embeddings`, {
      model: OLLAMA_EMBED_MODEL,
      prompt: text,
    }, { timeout: 30000 });
    return res.data.embedding || [];
  } catch (err) {
    logger.warn(`[Brain] embed() not available: ${err.message}`);
    return [];
  }
}

// ── Health check ──────────────────────────────────────────────────────────────
async function isAvailable() {
  try {
    await axios.get(`${OLLAMA_URL}/api/tags`, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ── List available models ─────────────────────────────────────────────────────
async function listModels() {
  try {
    const res = await axios.get(`${OLLAMA_URL}/api/tags`, { timeout: 5000 });
    return (res.data.models || []).map(m => m.name);
  } catch {
    return [];
  }
}

module.exports = { think, chat, plan, reflect, embed, isAvailable, listModels };
