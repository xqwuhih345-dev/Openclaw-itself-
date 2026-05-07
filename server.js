/**
 * OpenClaw Chat Server
 * ─────────────────────
 * Web-based and WebSocket chat interface to talk to OpenClaw.
 * Uses Ollama as the conversational brain.
 *
 * Endpoints:
 *   GET  /chat              → web UI (HTML)
 *   WS   /chat/ws           → WebSocket real-time chat
 *   POST /chat/message      → REST API chat
 *   GET  /chat/status       → agent status JSON
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const http     = require('http');
const url      = require('url');
const logger   = require('../logger');
const brain    = require('../brain/ollama');
const prompts  = require('../brain/prompts');
const store    = require('../memory/store');
const ltm      = require('../memory/longTerm');
const security = require('../security/privacy');

const CHAT_PORT = parseInt(process.env.CHAT_PORT || '3742');

// ── In-memory conversation history ────────────────────────────────────────────
const conversations = new Map(); // sessionId → [{role, content}]

function getHistory(sessionId) {
  if (!conversations.has(sessionId)) conversations.set(sessionId, []);
  return conversations.get(sessionId);
}

// ── Handle chat message ────────────────────────────────────────────────────────
async function handleMessage(sessionId, userMessage) {
  security.audit('chat_message', { sessionId, length: userMessage.length });

  const history = getHistory(sessionId);
  history.push({ role: 'user', content: userMessage });

  // Build context from memory
  const mem         = store.load();
  const ltmContext  = await ltm.getContextSummary(userMessage, 400);
  const agentStatus = JSON.stringify({
    today:          mem.dailyState,
    totalCompleted: mem.meta.totalTasksCompleted,
    lastHeartbeat:  mem.meta.lastHeartbeat,
  }, null, 2);

  const context = `Agent status:\n${agentStatus}\n\nRelevant memory:\n${ltmContext || 'none'}`;

  let reply = 'Sorry, I could not process that.';

  try {
    const brainOk = await brain.isAvailable();
    if (brainOk) {
      const messages = [
        { role: 'system', content: prompts.chat(userMessage, context, history.slice(-6)) },
        ...history.slice(-6).map(h => ({ role: h.role, content: h.content })),
      ];
      reply = await brain.chat(messages);
    } else {
      // Fallback: keyword responses when Ollama is offline
      const lower = userMessage.toLowerCase();
      if (lower.includes('status'))       reply = `Today: T1=${mem.dailyState.task1Completed} T2=${mem.dailyState.task2Completed}. Total: ${mem.meta.totalTasksCompleted}`;
      else if (lower.includes('task'))    reply = `Task 1: ${mem.dailyState.task1 || 'none'} | Task 2: ${mem.dailyState.task2 || 'none'}`;
      else if (lower.includes('history')) reply = `${mem.history.length} days in history.`;
      else reply = 'Ollama brain is offline. I can answer basic status questions.';
    }
  } catch (e) {
    logger.error('[Chat] brain error:', e.message);
    reply = `Brain error: ${e.message}`;
  }

  history.push({ role: 'assistant', content: reply });
  // Keep last 20 turns
  if (history.length > 20) conversations.set(sessionId, history.slice(-20));

  await ltm.addEpisode('chat', `User: ${userMessage.substring(0,80)} → Bot: ${reply.substring(0,80)}`, ['chat'], 3);

  return reply;
}

// ── Web UI HTML ────────────────────────────────────────────────────────────────
function getChatHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenClaw Chat</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Courier New', monospace; background: #0a0a0a; color: #00ff88; height: 100vh; display: flex; flex-direction: column; }
    header { padding: 16px 20px; border-bottom: 1px solid #1a3a1a; background: #050f05; }
    header h1 { font-size: 1.2em; letter-spacing: 2px; }
    header span { font-size: 0.7em; color: #558855; margin-left: 10px; }
    #messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
    .msg { max-width: 80%; padding: 10px 14px; border-radius: 6px; line-height: 1.5; font-size: 0.9em; }
    .msg.user { background: #0d2d0d; border: 1px solid #1a5a1a; align-self: flex-end; color: #88ff88; }
    .msg.bot  { background: #050f05; border: 1px solid #0a2a0a; align-self: flex-start; color: #00cc66; }
    .msg .label { font-size: 0.7em; opacity: 0.6; margin-bottom: 4px; }
    #input-area { display: flex; padding: 16px; border-top: 1px solid #1a3a1a; gap: 8px; background: #050f05; }
    #msg-input { flex: 1; background: #0d2d0d; border: 1px solid #1a5a1a; color: #00ff88; padding: 10px 14px; border-radius: 4px; font-family: inherit; font-size: 0.9em; outline: none; }
    #msg-input::placeholder { color: #336633; }
    #send-btn { background: #00aa44; color: #000; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-family: inherit; font-weight: bold; letter-spacing: 1px; }
    #send-btn:hover { background: #00cc55; }
    #status-bar { padding: 6px 20px; font-size: 0.7em; color: #336633; border-top: 1px solid #0a2a0a; }
    .typing { opacity: 0.6; font-style: italic; }
  </style>
</head>
<body>
  <header>
    <h1>⚡ OPENCLAW</h1><span>AUTONOMOUS AGENT CHAT</span>
  </header>
  <div id="messages">
    <div class="msg bot"><div class="label">OPENCLAW</div>Online. How can I help? Ask about tasks, status, memory, or give me a command.</div>
  </div>
  <div id="input-area">
    <input id="msg-input" type="text" placeholder="Type a message..." autocomplete="off" />
    <button id="send-btn">SEND</button>
  </div>
  <div id="status-bar" id="status">Connecting...</div>

  <script>
    const msgs    = document.getElementById('messages');
    const input   = document.getElementById('msg-input');
    const statusB = document.getElementById('status-bar');
    const token   = localStorage.getItem('openclaw_token') || '';
    const session = 'sess_' + Math.random().toString(36).slice(2);

    let ws;
    function connect() {
      ws = new WebSocket('ws://' + location.host + '/chat/ws?session=' + session + '&token=' + token);
      ws.onopen    = () => { statusB.textContent = '● Connected'; };
      ws.onclose   = () => { statusB.textContent = '○ Disconnected — retrying…'; setTimeout(connect, 3000); };
      ws.onerror   = () => { statusB.textContent = '✗ Connection error'; };
      ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.type === 'reply') appendMsg('bot', data.text);
        if (data.type === 'typing') appendMsg('bot', '…', true);
      };
    }
    connect();

    function appendMsg(role, text, typing = false) {
      const el = document.createElement('div');
      el.className = 'msg ' + role + (typing ? ' typing' : '');
      el.innerHTML = '<div class="label">' + (role === 'user' ? 'YOU' : 'OPENCLAW') + '</div>' + escHtml(text);
      msgs.appendChild(el);
      msgs.scrollTop = msgs.scrollHeight;
      return el;
    }

    function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\n/g,'<br>'); }

    function sendMsg() {
      const text = input.value.trim();
      if (!text) return;
      appendMsg('user', text);
      input.value = '';
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'message', text, session }));
      }
    }

    document.getElementById('send-btn').onclick = sendMsg;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') sendMsg(); });

    // Load status
    fetch('/chat/status').then(r=>r.json()).then(s => {
      statusB.textContent = '● Connected | Today: T1=' + (s.task1Completed?'✅':'❌') + ' T2=' + (s.task2Completed?'✅':'❌');
    }).catch(()=>{});
  </script>
</body>
</html>`;
}

// ── HTTP + WebSocket server ────────────────────────────────────────────────────
let wsServer = null;

function startChatServer() {
  const server = http.createServer(async (req, res) => {
    const parsed   = url.parse(req.url, true);
    const pathname = parsed.pathname;

    // ── Web UI ────────────────────────────────────────────────────────────────
    if (pathname === '/chat' || pathname === '/chat/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getChatHTML());
      return;
    }

    // ── Status ────────────────────────────────────────────────────────────────
    if (pathname === '/chat/status') {
      const mem = store.load();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        agent: 'openclaw',
        ts: new Date().toISOString(),
        ...mem.dailyState,
        totalCompleted: mem.meta.totalTasksCompleted,
      }));
      return;
    }

    // ── REST chat ─────────────────────────────────────────────────────────────
    if (pathname === '/chat/message' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { message, session: sess, token: tok } = JSON.parse(body);
          if (!security.validateToken(tok)) {
            res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
          }
          if (!security.rateLimit(`chat:${sess}`, 30)) {
            res.writeHead(429); res.end(JSON.stringify({ error: 'Rate limit' })); return;
          }
          const reply = await handleMessage(sess || 'rest', message);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ reply }));
        } catch (e) {
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  // ── WebSocket upgrade ─────────────────────────────────────────────────────
  server.on('upgrade', async (req, socket, head) => {
    const parsed  = url.parse(req.url, true);
    if (parsed.pathname !== '/chat/ws') { socket.destroy(); return; }

    const tok     = parsed.query.token;
    const sess    = parsed.query.session || 'ws_anon';

    if (!security.validateToken(tok)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Lazy-load ws module
    const { WebSocketServer } = require('ws');
    if (!wsServer) wsServer = new WebSocketServer({ noServer: true });

    wsServer.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', async (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data.type === 'message') {
            if (!security.rateLimit(`ws:${sess}`, 20)) {
              ws.send(JSON.stringify({ type: 'error', text: 'Rate limit exceeded' }));
              return;
            }
            ws.send(JSON.stringify({ type: 'typing', text: '…' }));
            const reply = await handleMessage(sess, data.text);
            ws.send(JSON.stringify({ type: 'reply', text: reply }));
          }
        } catch (e) {
          logger.error('[Chat/WS] Error:', e.message);
          ws.send(JSON.stringify({ type: 'error', text: e.message }));
        }
      });
      ws.on('error', e => logger.error('[Chat/WS]', e.message));
    });
  });

  server.listen(CHAT_PORT, () => {
    logger.info(`[Chat] Server running on port ${CHAT_PORT}`);
    logger.info(`[Chat] Web UI: http://localhost:${CHAT_PORT}/chat`);
  });

  return server;
}

module.exports = { startChatServer, handleMessage };
