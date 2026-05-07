/**
 * OpenClaw Memory Store
 * ─────────────────────
 * Persistent JSON-backed memory so OpenClaw never forgets tasks,
 * completed work, or state across restarts.
 */

const fs   = require('fs-extra');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, 'openclaw_memory.json');

const DEFAULT = {
  version: 1,
  agent: 'openclaw',
  dailyState: {
    date: null,          // YYYY-MM-DD
    tasksReceivedToday: 0,
    task1: null,
    task2: null,
    task1Completed: false,
    task2Completed: false,
    lastCallAttempt: null,
  },
  history: [],           // array of {date, task, completedAt, notes}
  errors: [],            // recent errors for diagnosis
  meta: {
    startedAt: null,
    lastHeartbeat: null,
    totalTasksCompleted: 0,
  },
};

function load() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const raw = fs.readJsonSync(MEMORY_FILE);
      // Deep-merge with DEFAULT to handle schema additions
      return deepMerge(DEFAULT, raw);
    }
  } catch (e) {
    console.error('[Memory] Failed to load memory file, starting fresh:', e.message);
  }
  return structuredClone(DEFAULT);
}

function save(mem) {
  try {
    fs.ensureDirSync(path.dirname(MEMORY_FILE));
    fs.writeJsonSync(MEMORY_FILE, mem, { spaces: 2 });
  } catch (e) {
    console.error('[Memory] Failed to save memory:', e.message);
  }
}

function today() {
  return new Date().toISOString().split('T')[0];
}

/** Returns a fresh daily state block if the stored date doesn't match today */
function ensureTodayState(mem) {
  const t = today();
  if (mem.dailyState.date !== t) {
    // Archive yesterday's state to history if it had tasks
    if (mem.dailyState.date && mem.dailyState.task1) {
      mem.history.push({
        date: mem.dailyState.date,
        task1: mem.dailyState.task1,
        task2: mem.dailyState.task2,
        task1Completed: mem.dailyState.task1Completed,
        task2Completed: mem.dailyState.task2Completed,
      });
      // Keep last 90 days
      if (mem.history.length > 90) mem.history = mem.history.slice(-90);
    }
    mem.dailyState = {
      ...DEFAULT.dailyState,
      date: t,
    };
    save(mem);
  }
  return mem;
}

function recordError(mem, error) {
  mem.errors.unshift({ ts: new Date().toISOString(), error: String(error) });
  if (mem.errors.length > 50) mem.errors = mem.errors.slice(0, 50);
  save(mem);
}

function heartbeat(mem) {
  mem.meta.lastHeartbeat = new Date().toISOString();
  if (!mem.meta.startedAt) mem.meta.startedAt = mem.meta.lastHeartbeat;
  save(mem);
}

function deepMerge(defaults, overrides) {
  const result = structuredClone(defaults);
  for (const key of Object.keys(overrides)) {
    if (
      overrides[key] !== null &&
      typeof overrides[key] === 'object' &&
      !Array.isArray(overrides[key]) &&
      key in result &&
      typeof result[key] === 'object'
    ) {
      result[key] = deepMerge(result[key], overrides[key]);
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}

module.exports = { load, save, ensureTodayState, recordError, heartbeat, today, MEMORY_FILE };
