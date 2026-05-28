/**
 * server.mjs — façade API Anthropic Messages au-dessus d'une session Claude
 * Code interactive (facturée abonnement) pilotée par PTY + Stop hook.
 *
 *   POST /v1/messages   → parse la requête Anthropic, aplatit l'historique,
 *                         injecte dans le PTY, attend le Stop hook, renvoie la
 *                         réponse au format Anthropic.
 *   POST /_hook/stop    → réception du Stop hook (envoyé par claude), corrèle
 *                         par session_id et résout la requête en attente.
 *   GET  /health        → état.
 *
 * MVP : une seule session, champs messages/model/system. Streaming SSE
 * simulé : on attend la réponse finale du hook puis on la rejoue en un flux
 * Anthropic bien formé (keep-alive par pings pendant l'attente).
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createSession } from './pty-session.mjs';
import { lastAssistantMessageRetry } from './transcript.mjs';
import { flattenPrompt, buildMessageResponse, errorResponse } from './anthropic.mjs';

const PORT = Number(process.env.PORT || 3066);
// Par défaut, la session tourne dans un dossier VIDE et neutre (pas le repo) pour
// que Claude reste un assistant généraliste, non ancré sur un projet. Surchargeable
// via CLAUDE_CWD pour un usage "code" sur un vrai dépôt.
const NEUTRAL_WORKDIR = resolve(tmpdir(), 'facc-workdir');
const CWD = process.env.CLAUDE_CWD || NEUTRAL_WORKDIR;
try { mkdirSync(CWD, { recursive: true }); } catch {}
const MODEL = process.env.CLAUDE_MODEL || undefined;
const API_KEY = process.env.API_KEY || null; // si défini, exigé via x-api-key

// Registre des sessions par session_id (corrélation du hook). On garde les
// anciennes le temps qu'un hook tardif arrive ; `currentSession` est l'active.
const sessions = new Map();
let currentSession = null;
let restarting = false;
let consecutiveFailures = 0;
const MAX_FAILURES = 5;
const FAST_EXIT_MS = 15_000; // une session morte avant ça = échec de démarrage

// Retire les codes ANSI pour un log lisible de la sortie de claude.
function stripAnsi(s) {
  return String(s).replace(/[\x1b\x9b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nqry=><]/g, '');
}

// ---------- Log applicatif des requêtes/réponses ----------
const LOG_DIR = resolve(process.cwd(), 'logs');
const LOG_FILE = resolve(LOG_DIR, 'requests.jsonl');
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
function logRequest(entry) {
  try { appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch {}
}

function spawnSession() {
  const spawnedAt = Date.now();
  const s = createSession({
    bridgePort: PORT,
    cwd: CWD,
    model: MODEL,
    onExit: (code, tail) => {
      const lived = Date.now() - spawnedAt;
      console.warn(`[server] session ${s.sessionId} exited (code=${code}, après ${lived}ms)`);
      setTimeout(() => sessions.delete(s.sessionId), 10_000);
      if (restarting || currentSession !== s) return;

      // Sortie rapide = claude n'a pas démarré (flag inconnu, pas de login, etc.).
      if (lived < FAST_EXIT_MS) {
        consecutiveFailures++;
        // Affiche la sortie de claude au 1er échec pour révéler la cause.
        if (consecutiveFailures === 1 && tail && tail.trim()) {
          const out = stripAnsi(tail).trim().split('\n').filter(Boolean).slice(-25).join('\n');
          console.error('[server] --- sortie de claude (pour diagnostic) ---\n' + out + '\n[server] --- fin sortie ---');
        }
        if (consecutiveFailures >= MAX_FAILURES) {
          console.error(`[server] ${MAX_FAILURES} échecs de démarrage consécutifs — auto-restart arrêté.`);
          console.error(`[server] Vérifie que \`claude\` démarre manuellement dans ${CWD} (login, version, flags).`);
          currentSession = null;
          return;
        }
      } else {
        consecutiveFailures = 0; // session saine
      }

      // Backoff exponentiel (1s, 2s, 4s… plafonné à 15s).
      const backoff = Math.min(1000 * 2 ** Math.max(0, consecutiveFailures - 1), 15_000);
      restarting = true;
      setTimeout(() => {
        currentSession = spawnSession();
        restarting = false;
        console.log(`[server] session redémarrée : ${currentSession.sessionId}`);
      }, backoff);
    },
  });
  sessions.set(s.sessionId, s);
  return s;
}

currentSession = spawnSession();
console.log(`[server] session claude créée : ${currentSession.sessionId} (cwd=${CWD})`);

// ---------- Page de chat (consomme /v1/messages) ----------
const CHAT_HTML = `<!doctype html>
<html lang="fr"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude — chat (facc)</title>
<style>
  :root{--bg:#0b0b10;--panel:#15151c;--border:#2a2a35;--user:#2563eb;--asst:#1f2430;--txt:#e6e6ee;--muted:#8a8a9c}
  *{box-sizing:border-box}
  body{margin:0;height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--txt);font-family:system-ui,sans-serif}
  header{padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px}
  header h1{margin:0;font-size:15px;font-weight:600}
  header .meta{font-size:12px;color:var(--muted)}
  header .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#3ad17b;margin-right:5px}
  header button{margin-left:auto;background:#3a3a48;color:#eee;border:0;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:13px}
  header button:hover{background:#4a4a58}
  #chat{flex:1;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:14px}
  .msg{max-width:80%;padding:10px 14px;border-radius:12px;line-height:1.5;white-space:normal;word-wrap:break-word}
  .msg.user{align-self:flex-end;background:var(--user);border-bottom-right-radius:3px}
  .msg.assistant{align-self:flex-start;background:var(--asst);border:1px solid var(--border);border-bottom-left-radius:3px}
  .msg .role{font-size:11px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px}
  .msg.user .role{color:#cfe0ff}
  .msg pre{background:#0b0b10;border:1px solid var(--border);border-radius:6px;padding:10px;overflow-x:auto;margin:6px 0}
  .msg code{font-family:ui-monospace,monospace;font-size:13px}
  .msg :not(pre)>code{background:#0b0b10;padding:1px 5px;border-radius:4px}
  .typing{align-self:flex-start;color:var(--muted);font-style:italic;font-size:14px}
  footer{padding:12px 16px;background:var(--panel);border-top:1px solid var(--border);display:flex;gap:10px}
  textarea{flex:1;resize:none;background:#0b0b10;color:var(--txt);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-family:inherit;font-size:14px;line-height:1.4;max-height:160px}
  footer button{background:var(--user);color:#fff;border:0;padding:0 20px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600}
  footer button:disabled{opacity:.5;cursor:not-allowed}
</style></head><body>
<header>
  <h1>Claude</h1>
  <span class="meta"><span class="dot"></span>facc · /v1/messages</span>
  <button id="reset">Nouvelle conversation</button>
</header>
<div id="chat"></div>
<footer>
  <textarea id="input" rows="1" placeholder="Écris un message… (Entrée pour envoyer, Maj+Entrée = nouvelle ligne)" autofocus></textarea>
  <button id="send">Envoyer</button>
</footer>
<script>
const MODEL = 'claude-opus-4-7';
const API_KEY = '__API_KEY__'; // injecté par le serveur (vide si pas d'auth)
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
let messages = []; // historique Anthropic envoyé à chaque appel
let busy = false;

function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
// Markdown minimal et sûr : on échappe d'abord, puis on applique le formatage.
function renderMarkdown(text){
  let html = escapeHtml(text);
  html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g,(_,c)=>'<pre><code>'+c.replace(/^\\n/,'')+'</code></pre>');
  html = html.replace(/\`([^\`\\n]+)\`/g,'<code>$1</code>');
  html = html.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
  // sauts de ligne hors blocs <pre>
  const parts = html.split(/(<pre>[\\s\\S]*?<\\/pre>)/);
  html = parts.map(p=>p.startsWith('<pre>')?p:p.replace(/\\n/g,'<br>')).join('');
  return html;
}
function addBubble(role, text){
  const div = document.createElement('div');
  div.className = 'msg '+role;
  div.innerHTML = '<div class="role">'+(role==='user'?'Vous':'Claude')+'</div><div class="body">'+renderMarkdown(text)+'</div>';
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}
function setBusy(b){busy=b;sendBtn.disabled=b;input.disabled=b;}

async function send(){
  const text = input.value.trim();
  if(!text || busy) return;
  addBubble('user', text);
  messages.push({role:'user', content:text});
  input.value=''; autosize();
  setBusy(true);
  const typing = document.createElement('div');
  typing.className='typing'; typing.textContent='Claude écrit…';
  chat.appendChild(typing); chat.scrollTop=chat.scrollHeight;
  try{
    const headers = {'content-type':'application/json'};
    if (API_KEY) headers['x-api-key'] = API_KEY;
    const res = await fetch('/v1/messages',{
      method:'POST', headers,
      body: JSON.stringify({model:MODEL, max_tokens:4096, messages})
    });
    const data = await res.json();
    typing.remove();
    if(!res.ok){
      addBubble('assistant','⚠️ Erreur : '+(data?.error?.message||res.status));
    }else{
      const reply = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
      addBubble('assistant', reply||'(réponse vide)');
      messages.push({role:'assistant', content:reply});
    }
  }catch(e){
    typing.remove();
    addBubble('assistant','⚠️ Réseau : '+e.message);
  }finally{
    setBusy(false); input.focus();
  }
}

function autosize(){input.style.height='auto';input.style.height=Math.min(input.scrollHeight,160)+'px';}
input.addEventListener('input', autosize);
input.addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.shiftKey){e.preventDefault(); send();} });
sendBtn.addEventListener('click', send);
document.getElementById('reset').addEventListener('click', ()=>{ messages=[]; chat.innerHTML=''; input.focus(); });
</script></body></html>`;

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

// Écrit un évènement SSE au format Anthropic : `payload.type` = nom de l'évènement.
function sseWrite(res, payload) {
  res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Streaming SSE simulé. La session sous-jacente n'est pas incrémentale (le hook
 * livre la réponse complète d'un coup) : on ouvre donc le flux, on le garde
 * vivant par des pings sans contenu, puis on rejoue le texte final en un seul
 * content_block_delta. Le client (SDK Anthropic) reconstitue le message complet.
 */
async function streamAnthropicResponse({ res, session, prompt, body, lastUser, startedAt }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });

  const msgId = `msg_${randomUUID().replace(/-/g, '')}`;
  const model = body.model || 'claude';

  // Ouverture du flux + keep-alive (aucun contenu n'est émis avant la réponse).
  sseWrite(res, {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  sseWrite(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  sseWrite(res, { type: 'ping' });
  const keepAlive = setInterval(() => { try { sseWrite(res, { type: 'ping' }); } catch {} }, 10_000);

  try {
    const result = await session.ask(prompt);
    clearInterval(keepAlive);

    let transcriptMsg = null;
    if (result.transcriptPath) {
      try {
        transcriptMsg = await lastAssistantMessageRetry(result.transcriptPath, { expectText: result.text });
      } catch {}
    }
    const response = buildMessageResponse({ text: result.text, model: body.model, transcriptMsg });
    const text = (Array.isArray(response.content) ? response.content : [])
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text || '')
      .join('');

    if (text) {
      sseWrite(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    }
    sseWrite(res, { type: 'content_block_stop', index: 0 });
    sseWrite(res, {
      type: 'message_delta',
      delta: { stop_reason: response.stop_reason || 'end_turn', stop_sequence: response.stop_sequence ?? null },
      usage: { output_tokens: response.usage?.output_tokens ?? 0 },
    });
    sseWrite(res, { type: 'message_stop' });
    res.end();

    logRequest({
      ok: true, stream: true, sessionId: session.sessionId,
      durationMs: Date.now() - startedAt, model: response.model, turns: body.messages.length,
      lastUser: typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content),
      responseText: text, usage: response.usage,
    });
  } catch (e) {
    clearInterval(keepAlive);
    try {
      sseWrite(res, { type: 'error', error: { type: 'api_error', message: e.message } });
      res.end();
    } catch {}
    logRequest({
      ok: false, stream: true, sessionId: session.sessionId,
      durationMs: Date.now() - startedAt, error: e.message,
      lastUser: typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content),
    });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // ---------- Page de chat ----------
  if ((url.pathname === '/' || url.pathname === '/index.html') && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(CHAT_HTML.replace('__API_KEY__', API_KEY || ''));
    return;
  }

  // ---------- Réception du Stop hook ----------
  if (url.pathname === '/_hook/stop' && req.method === 'POST') {
    try {
      const payload = JSON.parse((await readBody(req)) || '{}');
      const s = sessions.get(payload.session_id);
      if (s) s.onStopHook(payload);
      else console.warn('[hook] session inconnue:', payload.session_id);
    } catch (e) {
      console.warn('[hook] payload invalide:', e.message);
    }
    return sendJson(res, 200, { ok: true });
  }

  // ---------- Health ----------
  if (url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      sessionId: currentSession?.sessionId ?? null,
      exitCode: currentSession?.exitCode ?? null,
      restarting,
    });
  }

  // ---------- Façade Messages ----------
  if (url.pathname === '/v1/messages' && req.method === 'POST') {
    if (API_KEY) {
      const key = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (key !== API_KEY) {
        return sendJson(res, 401, errorResponse('authentication_error', 'invalid x-api-key'));
      }
    }

    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return sendJson(res, 400, errorResponse('invalid_request_error', 'invalid JSON body'));
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return sendJson(res, 400, errorResponse('invalid_request_error', 'messages[] required'));
    }

    const prompt = flattenPrompt({ system: body.system, messages: body.messages });
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
    const startedAt = Date.now();

    const session = currentSession;
    if (!session || session.exitCode !== null) {
      logRequest({ ok: false, error: 'session not ready', sessionId: session?.sessionId ?? null });
      return sendJson(res, 503, errorResponse('overloaded_error', 'session not ready (restarting)'));
    }

    if (body.stream) {
      return streamAnthropicResponse({ res, session, prompt, body, lastUser, startedAt });
    }

    try {
      const result = await session.ask(prompt);
      // Enrichissement usage/stop_reason depuis le transcript (best-effort).
      let transcriptMsg = null;
      if (result.transcriptPath) {
        try {
          transcriptMsg = await lastAssistantMessageRetry(result.transcriptPath, { expectText: result.text });
        } catch {}
      }
      const response = buildMessageResponse({
        text: result.text,
        model: body.model,
        transcriptMsg,
      });
      logRequest({
        ok: true,
        sessionId: session.sessionId,
        durationMs: Date.now() - startedAt,
        model: response.model,
        turns: body.messages.length,
        lastUser: typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content),
        responseText: result.text,
        usage: response.usage,
      });
      return sendJson(res, 200, response);
    } catch (e) {
      logRequest({
        ok: false,
        sessionId: session.sessionId,
        durationMs: Date.now() - startedAt,
        error: e.message,
        lastUser: typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content),
      });
      return sendJson(res, 500, errorResponse('api_error', e.message));
    }
  }

  return sendJson(res, 404, errorResponse('not_found_error', `no route ${req.method} ${url.pathname}`));
});

server.listen(PORT, () => {
  console.log(`[server] up on http://localhost:${PORT}`);
  console.log(`[server] POST /v1/messages  |  POST /_hook/stop  |  GET /health`);
});

process.on('SIGINT', () => {
  console.log('\n[server] SIGINT — kill session');
  restarting = true; // empêche l'auto-restart pendant l'arrêt
  try { currentSession?.kill(); } catch {}
  setTimeout(() => process.exit(0), 1000);
});
