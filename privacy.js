/**
 * OpenClaw Security & Privacy Module
 * ─────────────────────────────────────
 * Protects sensitive data and enforces access controls.
 *
 * Features:
 *   - AES-256-GCM encryption for sensitive memory fields
 *   - .env file integrity check (detects accidental exposure)
 *   - Access token for the chat/API interface
 *   - Sanitize logs (mask phone numbers, tokens, passwords)
 *   - Audit log of all sensitive actions
 *   - Rate limiting for API/webhook endpoints
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const crypto = require('crypto');
const fs     = require('fs-extra');
const path   = require('path');
const logger = require('../logger');

const AUDIT_FILE   = path.join(__dirname, '..', 'logs', 'audit.log');
const KEY_FILE     = path.join(__dirname, '..', 'security', '.keystore');
const ALGORITHM    = 'aes-256-gcm';

// ── Key management ─────────────────────────────────────────────────────────────
function getEncryptionKey() {
  // Use env secret if provided
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey) {
    return crypto.createHash('sha256').update(envKey).digest();
  }

  // Auto-generate and persist a machine key
  if (fs.existsSync(KEY_FILE)) {
    try {
      const stored = fs.readFileSync(KEY_FILE, 'utf8').trim();
      return Buffer.from(stored, 'hex');
    } catch { /* regenerate */ }
  }

  const key = crypto.randomBytes(32);
  try {
    fs.ensureDirSync(path.dirname(KEY_FILE));
    fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
    logger.info('[Security] Encryption key generated and stored');
  } catch (e) {
    logger.warn('[Security] Could not persist key:', e.message);
  }
  return key;
}

// ── Encrypt / Decrypt ──────────────────────────────────────────────────────────
function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  try {
    const key = getEncryptionKey();
    const iv  = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  } catch (e) {
    logger.error('[Security] Encrypt error:', e.message);
    return plaintext;
  }
}

function decrypt(ciphertext) {
  if (!ciphertext || !String(ciphertext).startsWith('enc:')) return ciphertext;
  try {
    const key  = getEncryptionKey();
    const parts = String(ciphertext).split(':');
    const iv  = Buffer.from(parts[1], 'hex');
    const tag = Buffer.from(parts[2], 'hex');
    const enc = Buffer.from(parts[3], 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc) + decipher.final('utf8');
  } catch (e) {
    logger.error('[Security] Decrypt error:', e.message);
    return ciphertext;
  }
}

// ── Access token ───────────────────────────────────────────────────────────────
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function validateToken(provided) {
  const expected = process.env.CHAT_ACCESS_TOKEN;
  if (!expected) return true; // no token set = open (dev mode)
  if (!provided)  return false;
  // Constant-time comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(String(provided).padEnd(64, '0').substring(0, 64)),
      Buffer.from(String(expected).padEnd(64, '0').substring(0, 64))
    );
  } catch { return false; }
}

// ── Log sanitizer ──────────────────────────────────────────────────────────────
const SENSITIVE_PATTERNS = [
  { pattern: /\+?[0-9]{10,15}/g,          replace: (m) => m.substring(0, 4) + '****' + m.slice(-2) },
  { pattern: /AC[a-f0-9]{32}/gi,           replace: 'TWILIO_SID_****' },
  { pattern: /auth_token=[^\s&]+/gi,       replace: 'auth_token=****' },
  { pattern: /password=[^\s&]+/gi,         replace: 'password=****' },
  { pattern: /token=[A-Za-z0-9]{20,}/g,   replace: 'token=****' },
  { pattern: /Bearer\s+[A-Za-z0-9._-]+/g, replace: 'Bearer ****' },
];

function sanitize(text) {
  let s = String(text);
  for (const { pattern, replace } of SENSITIVE_PATTERNS) {
    s = s.replace(pattern, typeof replace === 'function' ? replace : replace);
  }
  return s;
}

// ── Audit log ──────────────────────────────────────────────────────────────────
async function audit(action, details = {}) {
  const entry = {
    ts:     new Date().toISOString(),
    action,
    details: sanitize(JSON.stringify(details)),
  };
  try {
    fs.ensureDirSync(path.dirname(AUDIT_FILE));
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
  } catch { /* best effort */ }
}

// ── .env integrity check ───────────────────────────────────────────────────────
function checkEnvSecurity() {
  const issues = [];
  const envPath = path.join(__dirname, '..', '.env');

  if (!fs.existsSync(envPath)) {
    issues.push('.env file missing');
    return issues;
  }

  // Check file permissions (Unix/Mac only — Windows uses ACLs)
  if (process.platform !== 'win32') {
    try {
      const stat = fs.statSync(envPath);
      const mode = (stat.mode & 0o777).toString(8);
      if (!['600', '400'].includes(mode)) {
        issues.push(`.env permissions are ${mode} — should be 600. Run: chmod 600 .env`);
      }
    } catch { /* skip */ }
  }

  // Check for placeholder values
  const content = fs.readFileSync(envPath, 'utf8');
  if (content.includes('your_twilio_account_sid')) issues.push('Twilio SID is still placeholder');
  if (content.includes('your_twilio_auth_token'))  issues.push('Twilio token is still placeholder');

  return issues;
}

// ── Rate limiter (in-memory) ───────────────────────────────────────────────────
const _rateCounts = new Map();

function rateLimit(key, maxPerMinute = 60) {
  const now    = Date.now();
  const window = 60 * 1000;
  const entry  = _rateCounts.get(key) || { count: 0, resetAt: now + window };

  if (now > entry.resetAt) {
    entry.count   = 0;
    entry.resetAt = now + window;
  }

  entry.count++;
  _rateCounts.set(key, entry);

  if (entry.count > maxPerMinute) {
    logger.warn(`[Security] Rate limit hit for: ${key} (${entry.count}/${maxPerMinute})`);
    return false;
  }
  return true;
}

// ── Secure memory wrapper ──────────────────────────────────────────────────────
function secureFields(obj, fieldsToEncrypt = []) {
  const secured = { ...obj };
  for (const field of fieldsToEncrypt) {
    if (secured[field]) secured[field] = encrypt(secured[field]);
  }
  return secured;
}

function revealFields(obj, fieldsToDecrypt = []) {
  const revealed = { ...obj };
  for (const field of fieldsToDecrypt) {
    if (revealed[field]) revealed[field] = decrypt(revealed[field]);
  }
  return revealed;
}

// ── Startup security report ────────────────────────────────────────────────────
function runSecurityCheck() {
  const envIssues = checkEnvSecurity();
  if (envIssues.length) {
    envIssues.forEach(i => logger.warn(`[Security] ⚠️  ${i}`));
  } else {
    logger.info('[Security] ✅ Security check passed');
  }
  return { ok: envIssues.length === 0, issues: envIssues };
}

module.exports = {
  encrypt, decrypt,
  generateToken, validateToken,
  sanitize, audit,
  checkEnvSecurity, runSecurityCheck,
  rateLimit,
  secureFields, revealFields,
};
