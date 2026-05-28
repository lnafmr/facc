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
