/**
 * OpenClaw Browser Agent — Platform Router
 * ──────────────────────────────────────────
 * Automatically selects the right engine based on the platform:
 *
 *   🖥  Desktop (Windows / Linux / macOS)
 *       → Puppeteer (full headless Chromium)
 *
 *   📱 Mobile (Termux on Android / iSH on iOS)
 *       → Terminal Browser (curl/https, no Chromium needed)
 *
 *   🔧 Force terminal mode on any platform:
 *       Set FORCE_TERMINAL_BROWSER=true in .env
 *
 * Same API on all platforms:
 *   navigate(url)      scrape(url)     search(query)
 *   screenshot(url)    checkTrends()   smartTask(goal)
 *   close()            getPlatformInfo()
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const terminal = require('./terminalBrowser');

// ── Route to terminal browser if on mobile or forced ─────────────────────────
if (terminal.isMobile()) {
  const _info = terminal.getPlatformInfo();
  // logger not yet available here — use console so it shows on boot
  console.info(`[Browser] Platform: ${_info.platform} — using Terminal Browser (no Puppeteer)`);
  module.exports = terminal;
  return; // skip Puppeteer entirely
}

const logger = require('../logger');
const ltm    = require('../memory/longTerm');
const brain  = require('../brain/ollama');
const path   = require('path');
const fs     = require('fs-extra');

const SCREENSHOTS_DIR = path.join(__dirname, '..', 'logs', 'screenshots');

let browser = null;

// ── Lazy browser init ─────────────────────────────────────────────────────────
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  try {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
      ],
    });
    logger.info('[Browser] Puppeteer launched');
    return browser;
  } catch (e) {
    logger.error('[Browser] Failed to launch Puppeteer:', e.message);
    throw new Error(`Browser not available: ${e.message}`);
  }
}

async function newPage() {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 800 });
  return page;
}

// ── Navigate ──────────────────────────────────────────────────────────────────
async function navigate(url) {
  const page = await newPage();
  try {
    logger.info(`[Browser] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const title = await page.title();
    await page.close();
    return { success: true, title, url };
  } catch (e) {
    await page.close();
    logger.error('[Browser] navigate error:', e.message);
    return { success: false, error: e.message, url };
  }
}

// ── Scrape ────────────────────────────────────────────────────────────────────
async function scrape(url, selector = 'body') {
  const page = await newPage();
  try {
    logger.info(`[Browser] Scraping ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const content = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.innerText.substring(0, 5000) : document.body.innerText.substring(0, 5000);
    }, selector);

    await page.close();
    await ltm.addEpisode('browser_scrape', `Scraped: ${url} — ${content.substring(0, 100)}`, ['browser', 'scrape'], 4);
    return { success: true, url, content };
  } catch (e) {
    await page.close();
    logger.error('[Browser] scrape error:', e.message);
    return { success: false, error: e.message };
  }
}

// ── Screenshot ────────────────────────────────────────────────────────────────
async function screenshot(url) {
  const page = await newPage();
  try {
    await fs.ensureDir(SCREENSHOTS_DIR);
    const filename = `screenshot-${Date.now()}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);

    logger.info(`[Browser] Screenshot of ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.screenshot({ path: filepath, fullPage: false });
    await page.close();

    return { success: true, filepath, filename };
  } catch (e) {
    await page.close();
    logger.error('[Browser] screenshot error:', e.message);
    return { success: false, error: e.message };
  }
}

// ── Google search ─────────────────────────────────────────────────────────────
async function search(query, limit = 5) {
  const page = await newPage();
  try {
    logger.info(`[Browser] Searching: "${query}"`);
    const encoded = encodeURIComponent(query);
    await page.goto(`https://www.google.com/search?q=${encoded}`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const results = await page.evaluate((lim) => {
      const items = [];
      const divs  = document.querySelectorAll('div.g');
      for (let i = 0; i < Math.min(divs.length, lim); i++) {
        const titleEl   = divs[i].querySelector('h3');
        const snippetEl = divs[i].querySelector('.VwiC3b, .yXK7lf, span');
        const linkEl    = divs[i].querySelector('a');
        if (titleEl) {
          items.push({
            title:   titleEl.innerText,
            snippet: snippetEl?.innerText || '',
            url:     linkEl?.href || '',
          });
        }
      }
      return items;
    }, limit);

    await page.close();
    await ltm.addEpisode('browser_search', `Searched: "${query}" — ${results.length} results`, ['browser', 'search'], 4);
    return { success: true, query, results };
  } catch (e) {
    await page.close();
    logger.error('[Browser] search error:', e.message);
    return { success: false, error: e.message, results: [] };
  }
}

// ── Check YouTube trends ──────────────────────────────────────────────────────
async function checkTrends() {
  logger.info('[Browser] Checking YouTube/Google trends');

  const results = await search('trending YouTube topics today', 8);
  if (!results.success) return results;

  // Use Ollama to summarize if available
  const brainOk = await brain.isAvailable();
  if (brainOk && results.results.length) {
    const raw = results.results.map(r => `${r.title}: ${r.snippet}`).join('\n');
    const summary = await brain.think(
      `Summarize the top 5 trending YouTube topics from this search data:\n${raw}\n\nReturn a concise bullet list.`,
      { temperature: 0.3 }
    );
    return { ...results, summary };
  }

  return results;
}

// ── AI-guided smart task ──────────────────────────────────────────────────────
async function smartTask(goal) {
  logger.info(`[Browser] Smart task: "${goal}"`);

  const brainOk = await brain.isAvailable();
  if (!brainOk) {
    logger.warn('[Browser] Ollama not available for smart task');
    // Fall back to a basic search
    return search(goal);
  }

  // Ask brain for a plan
  const planRaw = await brain.think(
    `You are a browser agent. Plan the steps to achieve this goal using only: navigate, scrape, search, screenshot.
Goal: ${goal}
Return JSON: {"steps": [{"action": "search|navigate|scrape|screenshot", "target": "url or query"}]}`,
    { temperature: 0.3 }
  );

  let steps = [];
  try {
    const start = planRaw.indexOf('{');
    const end   = planRaw.lastIndexOf('}') + 1;
    const plan  = JSON.parse(planRaw.slice(start, end));
    steps = plan.steps || [];
  } catch {
    steps = [{ action: 'search', target: goal }];
  }

  const outputs = [];
  for (const step of steps.slice(0, 5)) { // max 5 steps
    logger.info(`[Browser] Smart step: ${step.action} → ${step.target}`);
    let result;
    if (step.action === 'search')     result = await search(step.target);
    else if (step.action === 'scrape') result = await scrape(step.target);
    else if (step.action === 'navigate') result = await navigate(step.target);
    else if (step.action === 'screenshot') result = await screenshot(step.target);
    if (result) outputs.push(result);
  }

  await ltm.addEpisode('browser_smart_task', `Smart task: "${goal}" — ${steps.length} steps`, ['browser', 'smart'], 6);

  return { success: true, goal, steps: steps.length, outputs };
}

// ── Close browser ─────────────────────────────────────────────────────────────
async function close() {
  if (browser) {
    await browser.close();
    browser = null;
    logger.info('[Browser] Browser closed');
  }
}

function getPlatformInfo() {
  return {
    isMobile:     false,
    platform:     process.platform,
    engine:       'puppeteer',
    hasBrowser:   true,
    hasShell:     false,
    capabilities: ['navigate', 'scrape', 'search', 'checkTrends', 'smartTask', 'screenshot'],
  };
}

module.exports = { navigate, scrape, screenshot, search, checkTrends, smartTask, close, getPlatformInfo };
