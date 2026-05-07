/**
 * OpenClaw Terminal Browser Agent
 * ─────────────────────────────────
 * Shell-based web agent for mobile environments (Termux / iSH).
 * Uses curl + Node.js https — no Puppeteer, no Chromium required.
 *
 * Detects automatically:
 *   - Termux  (Android) → TERMUX_VERSION env var set
 *   - iSH     (iOS)     → /proc/ish exists or ISH_VERSION set
 *   - Forced  (any)     → FORCE_TERMINAL_BROWSER=true in .env
 *
 * Same API surface as browser.js:
 *   navigate(url)           → HTTP GET, return status + title
 *   scrape(url, selector)   → fetch HTML, strip tags, return text
 *   screenshot(url)         → not supported → returns notice
 *   search(query)           → DuckDuckGo Lite HTML parse
 *   checkTrends()           → fetch + AI-summarize trending data
 *   smartTask(goal)         → AI-planned curl-based steps
 *   close()                 → no-op (no process to kill)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const https    = require('https');
const http     = require('http');
const { execSync, exec } = require('child_process');
const logger   = require('../logger');
const ltm      = require('../memory/longTerm');
const brain    = require('../brain/ollama');
const fs       = require('fs-extra');
const path     = require('path');
const url      = require('url');

const RESULTS_DIR = path.join(__dirname, '..', 'logs', 'terminal-browser');

// ── Platform detection ────────────────────────────────────────────────────────
function detectMobilePlatform() {
  if (process.env.FORCE_TERMINAL_BROWSER === 'true') return 'forced';
  if (process.env.TERMUX_VERSION || process.env.PREFIX?.includes('com.termux')) return 'termux';
  if (process.env.ISH_VERSION) return 'ish';
  try {
    if (fs.existsSync('/proc/ish')) return 'ish';
  } catch {}
  return null;
}

function isMobile() {
  return detectMobilePlatform() !== null;
}

// ── HTTP fetch (pure Node.js — no curl needed) ────────────────────────────────
function fetchUrl(rawUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new url.URL(rawUrl);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      method:   'GET',
      timeout:  opts.timeout || 20000,
      headers:  {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
        'Accept':     'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    };

    const req = lib.request(options, (res) => {
      // Follow redirects (max 5)
      const redirectCount = opts._redirects || 0;
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectCount < 5) {
        const newUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
        return fetchUrl(newUrl, { ...opts, _redirects: redirectCount + 1 }).then(resolve).catch(reject);
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 500000) res.destroy(); });
      res.on('end',  () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });

    req.setTimeout(opts.timeout || 20000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    req.end();
  });
}

// ── Strip HTML tags → plain text ──────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Extract <title> ───────────────────────────────────────────────────────────
function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim() : '';
}

// ── navigate ──────────────────────────────────────────────────────────────────
async function navigate(targetUrl) {
  logger.info(`[TermBrowser] navigate → ${targetUrl}`);
  try {
    const { status, body } = await fetchUrl(targetUrl);
    const title = extractTitle(body);
    return { success: true, url: targetUrl, status, title };
  } catch (e) {
    logger.error('[TermBrowser] navigate error:', e.message);
    return { success: false, url: targetUrl, error: e.message };
  }
}

// ── scrape ────────────────────────────────────────────────────────────────────
async function scrape(targetUrl, selector = null) {
  logger.info(`[TermBrowser] scrape → ${targetUrl}`);
  try {
    const { body } = await fetchUrl(targetUrl);
    let content = stripHtml(body).substring(0, 6000);

    // Rough selector support: find text near a heading keyword
    if (selector && typeof selector === 'string' && !selector.startsWith('.') && !selector.startsWith('#')) {
      const idx = content.toLowerCase().indexOf(selector.toLowerCase());
      if (idx >= 0) content = content.substring(idx, idx + 2000);
    }

    await ltm.addEpisode('terminal_scrape', `Scraped: ${targetUrl} — ${content.substring(0, 80)}`, ['terminal', 'scrape'], 4);
    return { success: true, url: targetUrl, content };
  } catch (e) {
    logger.error('[TermBrowser] scrape error:', e.message);
    return { success: false, error: e.message };
  }
}

// ── screenshot (not available in terminal) ────────────────────────────────────
async function screenshot(targetUrl) {
  logger.warn('[TermBrowser] screenshot not available in terminal mode');
  return { success: false, reason: 'Screenshots require desktop mode', url: targetUrl };
}

// ── search (DuckDuckGo Lite — no JS required) ─────────────────────────────────
async function search(query, limit = 5) {
  logger.info(`[TermBrowser] search → "${query}"`);
  try {
    const encoded = encodeURIComponent(query);
    const { body } = await fetchUrl(`https://html.duckduckgo.com/html/?q=${encoded}`);

    // Parse result snippets from DDG HTML
    const results = [];
    const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    const titleRe   = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

    const titles   = [];
    const snippets = [];
    let m;

    while ((m = titleRe.exec(body)) !== null)   titles.push({ url: m[1], title: stripHtml(m[2]) });
    while ((m = snippetRe.exec(body)) !== null) snippets.push(stripHtml(m[1]));

    for (let i = 0; i < Math.min(titles.length, limit); i++) {
      results.push({
        title:   titles[i]?.title   || '',
        url:     titles[i]?.url     || '',
        snippet: snippets[i]        || '',
      });
    }

    // If DDG parse yields nothing, fallback to raw text chunks
    if (!results.length) {
      const text = stripHtml(body);
      results.push({ title: `Search: ${query}`, url: '', snippet: text.substring(0, 500) });
    }

    await ltm.addEpisode('terminal_search', `Search: "${query}" — ${results.length} results`, ['terminal', 'search'], 4);
    return { success: true, query, results };
  } catch (e) {
    logger.error('[TermBrowser] search error:', e.message);
    return { success: false, error: e.message, results: [] };
  }
}

// ── checkTrends ───────────────────────────────────────────────────────────────
async function checkTrends() {
  logger.info('[TermBrowser] Checking trends via terminal');

  // Try Google Trends RSS (no JS needed)
  const sources = [
    { url: 'https://trends.google.com/trends/trendingsearches/daily/rss?geo=US', name: 'Google Trends RSS' },
    { url: 'https://html.duckduckgo.com/html/?q=trending+youtube+topics+today', name: 'DDG search' },
  ];

  let rawContent = '';

  for (const src of sources) {
    try {
      const { body } = await fetchUrl(src.url);
      rawContent = stripHtml(body).substring(0, 3000);
      if (rawContent.length > 100) {
        logger.info(`[TermBrowser] Trends fetched from ${src.name}`);
        break;
      }
    } catch { /* try next */ }
  }

  if (!rawContent) return { success: false, error: 'Could not fetch trends' };

  const brainOk = await brain.isAvailable();
  if (brainOk) {
    const summary = await brain.think(
      `Summarize the top 5 trending YouTube/web topics from this content:\n${rawContent}\nReturn a concise bullet list.`,
      { temperature: 0.3 }
    );
    return { success: true, summary, raw: rawContent.substring(0, 500) };
  }

  return { success: true, summary: rawContent.substring(0, 800) };
}

// ── smartTask (AI-planned terminal steps) ─────────────────────────────────────
async function smartTask(goal) {
  logger.info(`[TermBrowser] Smart task: "${goal}"`);

  const brainOk = await brain.isAvailable();
  if (!brainOk) {
    logger.warn('[TermBrowser] Ollama not available — falling back to search');
    return search(goal);
  }

  const planRaw = await brain.think(
    `You are a terminal web agent running on mobile (Termux/iSH).
You can ONLY use: search, scrape, navigate (no screenshots, no JavaScript).
Plan steps to achieve this goal: "${goal}"
Return JSON: {"steps": [{"action": "search|scrape|navigate", "target": "url or query"}]}`,
    { temperature: 0.3 }
  );

  let steps = [];
  try {
    const start = planRaw.indexOf('{');
    const end   = planRaw.lastIndexOf('}') + 1;
    steps = JSON.parse(planRaw.slice(start, end)).steps || [];
  } catch {
    steps = [{ action: 'search', target: goal }];
  }

  const outputs = [];
  for (const step of steps.slice(0, 5)) {
    logger.info(`[TermBrowser] Step: ${step.action} → ${step.target}`);
    let result;
    if (step.action === 'search')   result = await search(step.target);
    if (step.action === 'scrape')   result = await scrape(step.target);
    if (step.action === 'navigate') result = await navigate(step.target);
    if (result) outputs.push(result);
  }

  await ltm.addEpisode('terminal_smart_task', `Smart task: "${goal}" — ${steps.length} steps`, ['terminal', 'smart'], 6);
  return { success: true, goal, steps: steps.length, outputs };
}

// ── Run a shell command (Termux/iSH) ──────────────────────────────────────────
function runShell(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: opts.timeout || 15000, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        logger.warn(`[TermBrowser] shell error: ${err.message}`);
        resolve({ success: false, error: err.message, stdout, stderr });
      } else {
        resolve({ success: true, stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
  });
}

// ── Install a Termux package ───────────────────────────────────────────────────
async function termuxInstall(pkg) {
  if (detectMobilePlatform() !== 'termux') {
    return { success: false, reason: 'Not running in Termux' };
  }
  logger.info(`[TermBrowser] Installing Termux package: ${pkg}`);
  return runShell(`pkg install -y ${pkg}`, { timeout: 60000 });
}

// ── Platform info ─────────────────────────────────────────────────────────────
function getPlatformInfo() {
  const platform = detectMobilePlatform();
  return {
    isMobile:    platform !== null,
    platform:    platform || 'desktop',
    engine:      platform ? 'terminal (curl/http)' : 'puppeteer',
    hasBrowser:  false,
    hasShell:    true,
    capabilities: platform
      ? ['navigate', 'scrape', 'search', 'checkTrends', 'smartTask', 'runShell']
      : ['navigate', 'scrape', 'search', 'checkTrends', 'smartTask', 'screenshot'],
  };
}

// ── close (no-op) ─────────────────────────────────────────────────────────────
async function close() {
  // Nothing to close in terminal mode
}

module.exports = {
  navigate, scrape, screenshot, search, checkTrends, smartTask,
  runShell, termuxInstall, getPlatformInfo, close,
  isMobile, detectMobilePlatform,
};
