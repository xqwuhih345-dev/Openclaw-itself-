/**
 * OpenClaw Watchdog v2
 * ─────────────────────
 * Monitors:
 *   1. Required .env keys
 *   2. npm dependencies (core + v2 additions)
 *   3. Memory files (short-term + long-term)
 *   4. Webhook server health
 *   5. Chat server health
 *   6. Ollama brain connectivity
 *   7. Logs directory writable
 *   8. Security key file
 *
 * Auto-repair: re-runs npm install if modules are missing.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs     = require('fs-extra');
const path   = require('path');
const { execSync } = require('child_process');
const http   = require('http');
const https  = require('https');

const ROOT   = path.join(__dirname, '..');
const logger = require('../logger');

const REQUIRED_ENV = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'TASK_PHONE_NUMBER',
  'WEBHOOK_BASE_URL',
];

const OPTIONAL_ENV = [
  'OLLAMA_URL',
  'OLLAMA_MODEL',
  'WHATSAPP_TO',
  'WHATSAPP_FROM',
  'MAIL_USER',
  'CHAT_PORT',
  'ENCRYPTION_KEY',
];

const REQUIRED_DEPS = [
  // Core
  'axios', 'dotenv', 'node-cron', 'twilio', 'winston', 'fs-extra',
  // v2
  'express', 'ws', 'nodemailer', 'chalk', 'inquirer',
];

const OPTIONAL_DEPS = [
  'puppeteer', // browser agent (large — optional)
  'open',
];

let issues   = [];
let warnings = [];

// ── 1. Check .env keys ────────────────────────────────────────────────────────
function checkEnv() {
  for (const key of REQUIRED_ENV) {
    const val = process.env[key];
    if (!val || val.includes('your_') || val.includes('XXXXXXXXXX')) {
      issues.push(`Missing or placeholder .env key: ${key}`);
    }
  }
  for (const key of OPTIONAL_ENV) {
    if (!process.env[key]) {
      warnings.push(`Optional .env key not set: ${key} (some features disabled)`);
    }
  }
}

// ── 2. Check npm deps ─────────────────────────────────────────────────────────
function checkDeps() {
  const nmDir = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(nmDir)) {
    issues.push('node_modules not found — run: npm install inside openclaw/');
    return;
  }
  for (const dep of REQUIRED_DEPS) {
    if (!fs.existsSync(path.join(nmDir, dep))) {
      issues.push(`Missing required dependency: ${dep} — run: npm install`);
    }
  }
  for (const dep of OPTIONAL_DEPS) {
    if (!fs.existsSync(path.join(nmDir, dep))) {
      warnings.push(`Optional dependency not installed: ${dep} (run npm install to enable)`);
    }
  }
}

// ── 3. Check memory files ─────────────────────────────────────────────────────
function checkMemory() {
  const memFile = path.join(ROOT, 'memory', 'openclaw_memory.json');
  const ltmFile = path.join(ROOT, 'memory', 'longterm_memory.json');

  if (fs.existsSync(memFile)) {
    try {
      const m = fs.readJsonSync(memFile);
      if (!m.version || !m.dailyState) warnings.push('Short-term memory schema unexpected');
    } catch (e) {
      issues.push(`Short-term memory corrupted: ${e.message}`);
    }
  } else {
    warnings.push('Short-term memory not created yet (normal on first run)');
  }

  if (!fs.existsSync(ltmFile)) {
    warnings.push('Long-term memory not created yet (normal on first run)');
  }
}

// ── 4. Check logs dir writable ────────────────────────────────────────────────
function checkLogs() {
  const logsDir = path.join(ROOT, 'logs');
  try {
    fs.ensureDirSync(logsDir);
    const testFile = path.join(logsDir, '.write-test');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
  } catch (e) {
    issues.push(`Logs directory not writable: ${e.message}`);
  }
}

// ── 5. Ping webhook server ────────────────────────────────────────────────────
function pingWebhook() {
  return pingPort(process.env.WEBHOOK_PORT || 3741, '/health', 'Webhook');
}

// ── 6. Ping chat server ────────────────────────────────────────────────────────
function pingChat() {
  return pingPort(process.env.CHAT_PORT || 3742, '/chat/status', 'Chat');
}

// ── 7. Ping Ollama brain ──────────────────────────────────────────────────────
function pingOllama() {
  return new Promise((resolve) => {
    const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    const isHttps   = ollamaUrl.startsWith('https');
    const lib       = isHttps ? https : http;
    const reqUrl    = `${ollamaUrl}/api/tags`;

    const req = lib.get(reqUrl, (res) => {
      if (res.statusCode === 200) {
        logger.info('[Watchdog] 🧠 Ollama is online');
      } else {
        warnings.push(`Ollama returned status ${res.statusCode}`);
      }
      resolve();
    });
    req.on('error', () => {
      warnings.push('Ollama not running — start with: ollama serve (optional but recommended)');
      resolve();
    });
    req.setTimeout(4000, () => { req.destroy(); resolve(); });
  });
}

// ── 8. Check security ─────────────────────────────────────────────────────────
function checkSecurity() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const stat = fs.statSync(envPath);
      const mode = (stat.mode & 0o777).toString(8);
      if (!['600', '400', '644'].includes(mode)) {
        const fix = process.platform === 'win32' ? 'icacls .env /inheritance:r /grant:r %USERNAME%:R' : 'chmod 600 .env';
        warnings.push(`.env permissions are ${mode} — consider: ${fix}`);
      }
    } catch { /* Windows stat may not expose Unix mode bits */ }
  }

  // Check .gitignore protects .env
  const gitignorePath = path.join(ROOT, '..', '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gi = fs.readFileSync(gitignorePath, 'utf8');
    if (!gi.includes('.env')) {
      warnings.push('.gitignore does not include .env — add it to prevent credential leaks!');
    }
  }
}

// ── Generic port ping ─────────────────────────────────────────────────────────
function pingPort(port, endpoint, name) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}${endpoint}`, (res) => {
      if (res.statusCode !== 200) warnings.push(`${name} server /health returned ${res.statusCode}`);
      resolve();
    });
    req.on('error', () => {
      warnings.push(`${name} server not responding on :${port} — may not be started yet`);
      resolve();
    });
    req.setTimeout(3000, () => { req.destroy(); resolve(); });
  });
}

// ── Run all checks ─────────────────────────────────────────────────────────────
async function runWatchdog(silent = false) {
  issues.length   = 0;
  warnings.length = 0;

  checkEnv();
  checkDeps();
  checkMemory();
  checkLogs();
  checkSecurity();
  await Promise.all([pingWebhook(), pingChat(), pingOllama()]);

  const ok = issues.length === 0;

  if (!silent) {
    if (ok) {
      logger.info('[Watchdog] ✅ All critical checks passed.');
    } else {
      logger.error(`[Watchdog] ❌ ${issues.length} critical issue(s):`);
      issues.forEach(i => logger.error(`  ✗ ${i}`));
    }
    if (warnings.length) {
      logger.warn(`[Watchdog] ⚠️  ${warnings.length} warning(s):`);
      warnings.forEach(w => logger.warn(`  ⚠ ${w}`));
    }
  }

  return { ok, issues: [...issues], warnings: [...warnings] };
}

// ── Auto-repair ────────────────────────────────────────────────────────────────
async function autoRepair() {
  const { issues: found } = await runWatchdog(true);
  const depIssues = found.filter(i => i.includes('node_modules') || i.includes('Missing required dependency'));

  if (depIssues.length) {
    logger.warn('[Watchdog] Auto-repair: running npm install…');
    try {
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      execSync(`${npmCmd} install`, { cwd: ROOT, stdio: 'inherit' });
      logger.info('[Watchdog] Auto-repair: npm install complete.');
    } catch (e) {
      logger.error('[Watchdog] Auto-repair failed:', e.message);
    }
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    await autoRepair();
    const result = await runWatchdog();
    process.exit(result.ok ? 0 : 1);
  })();
}

module.exports = { runWatchdog, autoRepair };
