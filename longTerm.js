/**
 * OpenClaw Long-Term Memory
 * ──────────────────────────
 * Stores rich episodic memory, insights, and learned patterns.
 * Supports semantic search via dot-product similarity on Ollama embeddings.
 * Falls back to keyword search if embeddings unavailable.
 */

const fs     = require('fs-extra');
const path   = require('path');
const logger = require('../logger');

const LTM_FILE = path.join(__dirname, 'longterm_memory.json');

const DEFAULT_LTM = {
  version: 1,
  episodes: [],        // {id, date, type, content, tags, embedding, importance}
  insights: [],        // {date, insight, source, applied}
  learnedPatterns: [], // {pattern, frequency, lastSeen, successRate}
  agentConfig: {       // self-tuned config values
    preferredTaskTime: '09:00',
    avgTaskDurationMinutes: 10,
    successRate: 1.0,
    totalReflections: 0,
  },
};

// ── Load / Save ────────────────────────────────────────────────────────────
function load() {
  try {
    if (fs.existsSync(LTM_FILE)) return fs.readJsonSync(LTM_FILE);
  } catch (e) {
    logger.error('[LTM] Failed to load:', e.message);
  }
  return structuredClone(DEFAULT_LTM);
}

function save(ltm) {
  try {
    fs.ensureDirSync(path.dirname(LTM_FILE));
    fs.writeJsonSync(LTM_FILE, ltm, { spaces: 2 });
  } catch (e) {
    logger.error('[LTM] Failed to save:', e.message);
  }
}

// ── Add episode ────────────────────────────────────────────────────────────
async function addEpisode(type, content, tags = [], importance = 5) {
  const ltm = load();

  let embedding = [];
  try {
    const brain = require('../brain/ollama');
    embedding = await brain.embed(`${type}: ${content}`);
  } catch { /* embeddings optional */ }

  const episode = {
    id:         `ep_${Date.now()}`,
    date:       new Date().toISOString(),
    type,       // 'task_completed' | 'error' | 'insight' | 'browser' | 'email' | 'chat'
    content,
    tags,
    embedding,
    importance, // 1-10
  };

  ltm.episodes.unshift(episode);
  // Keep last 500 episodes
  if (ltm.episodes.length > 500) ltm.episodes = ltm.episodes.slice(0, 500);

  save(ltm);
  logger.info(`[LTM] Episode saved: [${type}] ${content.substring(0, 80)}`);
  return episode;
}

// ── Add insight ────────────────────────────────────────────────────────────
function addInsight(insight, source = 'reflection') {
  const ltm = load();
  ltm.insights.unshift({ date: new Date().toISOString(), insight, source, applied: false });
  if (ltm.insights.length > 100) ltm.insights = ltm.insights.slice(0, 100);
  save(ltm);
  logger.info(`[LTM] Insight saved: ${insight.substring(0, 80)}`);
}

// ── Update learned pattern ─────────────────────────────────────────────────
function recordPattern(pattern, success = true) {
  const ltm = load();
  const existing = ltm.learnedPatterns.find(p => p.pattern === pattern);

  if (existing) {
    existing.frequency++;
    existing.lastSeen = new Date().toISOString();
    existing.successRate = ((existing.successRate * (existing.frequency - 1)) + (success ? 1 : 0)) / existing.frequency;
  } else {
    ltm.learnedPatterns.push({
      pattern,
      frequency: 1,
      lastSeen: new Date().toISOString(),
      successRate: success ? 1.0 : 0.0,
    });
  }

  save(ltm);
}

// ── Semantic search ────────────────────────────────────────────────────────
async function search(query, limit = 5) {
  const ltm = load();

  let queryEmbedding = [];
  try {
    const brain = require('../brain/ollama');
    queryEmbedding = await brain.embed(query);
  } catch { /* fall back to keyword */ }

  if (queryEmbedding.length > 0) {
    // Dot-product similarity
    const scored = ltm.episodes
      .filter(e => e.embedding && e.embedding.length > 0)
      .map(e => ({
        ...e,
        score: dotProduct(queryEmbedding, e.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (scored.length > 0) return scored;
  }

  // Fallback: keyword match
  const q = query.toLowerCase();
  return ltm.episodes
    .filter(e => e.content.toLowerCase().includes(q) || e.tags.some(t => t.toLowerCase().includes(q)))
    .slice(0, limit);
}

// ── Get context summary for prompt injection ───────────────────────────────
async function getContextSummary(task, maxChars = 800) {
  const relevant = await search(task, 5);
  if (!relevant.length) return '';

  const lines = relevant.map(e =>
    `[${e.date.split('T')[0]}] (${e.type}) ${e.content.substring(0, 150)}`
  );

  const summary = lines.join('\n');
  return summary.length > maxChars ? summary.substring(0, maxChars) + '…' : summary;
}

// ── Update agent config from self-improvement ─────────────────────────────
function updateAgentConfig(changes = {}) {
  const ltm = load();
  ltm.agentConfig = { ...ltm.agentConfig, ...changes, totalReflections: (ltm.agentConfig.totalReflections || 0) + 1 };
  save(ltm);
  logger.info('[LTM] Agent config updated:', JSON.stringify(changes));
}

// ── Stats ─────────────────────────────────────────────────────────────────
function getStats() {
  const ltm = load();
  return {
    totalEpisodes:  ltm.episodes.length,
    totalInsights:  ltm.insights.length,
    totalPatterns:  ltm.learnedPatterns.length,
    totalReflections: ltm.agentConfig.totalReflections,
    successRate:    ltm.agentConfig.successRate,
    recentInsights: ltm.insights.slice(0, 3).map(i => i.insight),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────
function dotProduct(a, b) {
  if (a.length !== b.length) return 0;
  return a.reduce((sum, val, i) => sum + val * b[i], 0);
}

module.exports = {
  load, save, addEpisode, addInsight, recordPattern,
  search, getContextSummary, updateAgentConfig, getStats,
  LTM_FILE,
};
