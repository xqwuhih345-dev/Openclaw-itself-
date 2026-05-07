/**
 * OpenClaw Mail Agent
 * ────────────────────
 * Send and receive emails using nodemailer.
 * Ollama is used to compose, summarize, and triage email.
 *
 * Capabilities:
 *   - send(to, subject, body)     → send email
 *   - sendTaskReport(task, result) → auto-compose task completion report
 *   - sendDailySummary()           → daily digest email
 *   - composeWithAI(instruction)   → let Ollama write the email
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const nodemailer = require('nodemailer');
const logger     = require('../logger');
const store      = require('../memory/store');
const ltm        = require('../memory/longTerm');
const brain      = require('../brain/ollama');
const prompts    = require('../brain/prompts');

// ── Transporter factory ───────────────────────────────────────────────────────
function getTransporter() {
  const service = process.env.MAIL_SERVICE || 'gmail';

  if (service === 'smtp') {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS,
      },
    });
  }

  return nodemailer.createTransport({
    service,
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
    },
  });
}

// ── Send email ────────────────────────────────────────────────────────────────
async function send(to, subject, body, html = false) {
  if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
    logger.warn('[Mail] Mail credentials not configured — email not sent');
    return { success: false, reason: 'No mail credentials' };
  }

  const transporter = getTransporter();
  const from = process.env.MAIL_FROM || process.env.MAIL_USER;
  const recipients = to || process.env.MAIL_DEFAULT_TO || from;

  try {
    const msg = {
      from,
      to: recipients,
      subject,
      [html ? 'html' : 'text']: body,
    };

    const info = await transporter.sendMail(msg);
    logger.info(`[Mail] Sent to ${recipients}: "${subject}" — ${info.messageId}`);
    await ltm.addEpisode('email_sent', `Email: "${subject}" to ${recipients}`, ['email'], 4);
    return { success: true, messageId: info.messageId };
  } catch (e) {
    logger.error('[Mail] Send error:', e.message);
    return { success: false, error: e.message };
  }
}

// ── Task completion report ────────────────────────────────────────────────────
async function sendTaskReport(task, purpose, result = {}) {
  const to      = process.env.MAIL_REPORT_TO || process.env.MAIL_DEFAULT_TO;
  const subject = `[OpenClaw] ${purpose.toUpperCase()} Complete — ${store.today()}`;
  const body    = [
    `OpenClaw Task Report`,
    `════════════════════`,
    `Date    : ${new Date().toLocaleString()}`,
    `Task    : ${purpose}`,
    `Content : ${task}`,
    `Status  : ${result.success !== false ? '✅ Completed' : '❌ Failed'}`,
    result.error ? `Error   : ${result.error}` : '',
    ``,
    `— OpenClaw Autonomous Agent`,
  ].filter(Boolean).join('\n');

  return send(to, subject, body);
}

// ── Daily summary email ───────────────────────────────────────────────────────
async function sendDailySummary() {
  const mem  = store.load();
  const to   = process.env.MAIL_REPORT_TO || process.env.MAIL_DEFAULT_TO;
  const date = store.today();

  const subject = `[OpenClaw] Daily Summary — ${date}`;

  const lines = [
    `OpenClaw Daily Summary — ${date}`,
    `═══════════════════════════════`,
    ``,
    `Task 1: ${mem.dailyState.task1 || 'Not received'}`,
    `Status: ${mem.dailyState.task1Completed ? '✅ Complete' : '❌ Incomplete'}`,
    ``,
    `Task 2: ${mem.dailyState.task2 || 'Not received'}`,
    `Status: ${mem.dailyState.task2Completed ? '✅ Complete' : '❌ Incomplete'}`,
    ``,
    `Total Tasks Completed Ever: ${mem.meta.totalTasksCompleted}`,
    `Last Heartbeat: ${mem.meta.lastHeartbeat || 'N/A'}`,
    ``,
    `— OpenClaw Autonomous Agent`,
  ];

  return send(to, subject, lines.join('\n'));
}

// ── AI-composed email ─────────────────────────────────────────────────────────
async function composeWithAI(instruction, to = null) {
  const brainOk = await brain.isAvailable();
  if (!brainOk) {
    logger.warn('[Mail] Ollama not available for AI email compose');
    return send(to, instruction, instruction);
  }

  try {
    const raw = await brain.think(prompts.composeEmail(instruction), { temperature: 0.5 });
    const start = raw.indexOf('{');
    const end   = raw.lastIndexOf('}') + 1;
    const composed = JSON.parse(raw.slice(start, end));

    const recipient = to || process.env.MAIL_DEFAULT_TO;
    return send(recipient, composed.subject, composed.body);
  } catch (e) {
    logger.warn('[Mail] AI compose parse error, sending raw:', e.message);
    return send(to || process.env.MAIL_DEFAULT_TO, instruction, instruction);
  }
}

// ── Verify connection ─────────────────────────────────────────────────────────
async function verify() {
  if (!process.env.MAIL_USER || !process.env.MAIL_PASS) return false;
  try {
    const t = getTransporter();
    await t.verify();
    return true;
  } catch {
    return false;
  }
}

module.exports = { send, sendTaskReport, sendDailySummary, composeWithAI, verify };
