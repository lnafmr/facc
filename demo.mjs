#!/usr/bin/env node
/**
 * POC v2 : pilote Claude Code interactif via node-pty + UI navigateur.
 *
 * Workflow :
 *   1. Pre-trust le dossier dans ~/.claude.json (methode b retenue : plus propre que
 *      detecter le dialog dans le stream).
 *   2. Demarre un serveur HTTP :3060 qui sert une page xterm.js + un endpoint SSE /stream.
 *   3. Spawn `claude` (binaire interactif) dans un PTY 200x50.
 *   4. Diffuse chaque chunk PTY vers (a) stdout, (b) session.log, (c) tous les clients SSE.
 *   5. Optionnel : POST /input pour envoyer une frappe depuis le navigateur.
 *   6. Exit propre quand claude quitte (ou hard timeout / SIGINT).
 *
 * Usage :
 *   node demo.mjs
 *   open http://localhost:3060/
 */

import { spawn as spawnPty } from 'node-pty';
import { createWriteStream, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(__dirname, 'session.log');
const PORT = 3066;
const COLS = 200;
const ROWS = 50;
const REPLAY_BUFFER_MAX = 1024 * 1024; // 1 MB

// ---------- 1. Pre-trust ----------
function ensureTrusted(projectPath) {
  const p = resolve(homedir(), '.claude.json');
  if (!existsSync(p)) {
    console.warn(`[trust] ~/.claude.json absent — claude n'a jamais tourne ? on tente quand meme.`);
    return false;
  }
  const cfg = JSON.parse(readFileSync(p, 'utf8'));
  cfg.projects ??= {};
  const entry = cfg.projects[projectPath] ?? {};
  if (entry.hasTrustDialogAccepted === true) {
    console.log(`[trust] deja accepte pour ${projectPath}`);
    return true;
  }
  cfg.projects[projectPath] = {
    allowedTools: [], mcpContextUris: [], mcpServers: {},
    enabledMcpjsonServers: [], disabledMcpjsonServers: [],
    ...entry,
    hasTrustDialogAccepted: true,
  };
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  console.log(`[trust] force hasTrustDialogAccepted=true pour ${projectPath}`);
  return true;
}
ensureTrusted(__dirname);

// ---------- 2. State ----------
const log = createWriteStream(LOG_PATH, { flags: 'w' });
const startedAt = Date.now();
const replayBuffers = []; // chunks bruts pour replay des nouveaux clients SSE
let replayBytes = 0;
const sseClients = new Set();
let bytesReceived = 0;
let exitCode = null;

function tsHeader(label) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
  return `\n[+${elapsed}s] === ${label} ===\n`;
}

function broadcast(chunk) {
  const b64 = Buffer.from(chunk, 'utf8').toString('base64');
  const frame = `data: ${b64}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch {}
  }
}

function pushReplay(chunk) {
  replayBuffers.push(chunk);
  replayBytes += Buffer.byteLength(chunk, 'utf8');
  while (replayBytes > REPLAY_BUFFER_MAX && replayBuffers.length > 1) {
    replayBytes -= Buffer.byteLength(replayBuffers.shift(), 'utf8');
  }
}

// ---------- 3. HTTP + SSE + xterm.js ----------
const HTML = `<!doctype html>
<html lang="fr"><head>
<meta charset="utf-8">
<title>facc + Claude Code</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
<style>
  body{margin:0;background:#0b0b10;color:#ddd;font-family:system-ui,sans-serif}
  header{padding:8px 14px;background:#15151c;border-bottom:1px solid #2a2a35;display:flex;gap:14px;align-items:center}
  header h1{margin:0;font-size:14px;font-weight:600}
  header .status{font-size:12px;color:#7a7a8c}
  header .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#888;margin-right:6px;vertical-align:middle}
  header .dot.live{background:#3ad17b}
  #term{padding:8px}
  form{padding:8px 14px;background:#15151c;border-top:1px solid #2a2a35;display:flex;gap:8px}
  input{flex:1;background:#0b0b10;color:#ddd;border:1px solid #2a2a35;padding:6px 10px;border-radius:4px;font-family:monospace}
  button{background:#3a3a48;color:#eee;border:0;padding:6px 14px;border-radius:4px;cursor:pointer}
  button:hover{background:#4a4a58}
</style></head><body>
<header>
  <h1>facc + Claude Code</h1>
  <span class="status"><span class="dot" id="dot"></span><span id="state">connexion…</span></span>
  <span class="status" id="bytes">0 bytes</span>
</header>
<div id="term"></div>
<form id="f"><input id="in" placeholder="tapez du texte puis Entree (envoye au PTY) — Ctrl+L = clear" autocomplete="off"><button>Send</button></form>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js"></script>
<script>
  const term = new Terminal({ cols: ${COLS}, rows: ${ROWS}, theme: { background: '#0b0b10' }, convertEol: false, scrollback: 5000 });
  term.open(document.getElementById('term'));
  let bytes = 0;
  const dot = document.getElementById('dot'), state = document.getElementById('state'), bel = document.getElementById('bytes');
  const es = new EventSource('/stream');
  es.onopen = () => { dot.classList.add('live'); state.textContent = 'live'; };
  es.onerror = () => { dot.classList.remove('live'); state.textContent = 'reconnecting…'; };
  es.onmessage = (e) => {
    if (!e.data) return;
    const raw = atob(e.data);
    term.write(raw);
    bytes += raw.length;
    bel.textContent = bytes + ' bytes';
  };
  document.getElementById('f').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const inp = document.getElementById('in');
    const v = inp.value;
    if (!v) return;
    await fetch('/input', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ data: v + '\\r' }) });
    inp.value = '';
  });
</script></body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  if (url.pathname === '/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(':ok\n\n');
    // Replay du buffer pour ce nouveau client
    for (const chunk of replayBuffers) {
      res.write(`data: ${Buffer.from(chunk, 'utf8').toString('base64')}\n\n`);
    }
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (url.pathname === '/input' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        const { data } = JSON.parse(body || '{}');
        if (typeof data === 'string' && exitCode === null) pty.write(data);
        res.writeHead(204).end();
      } catch (err) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('bad json');
      }
    });
    return;
  }
  res.writeHead(404).end('not found');
});

server.listen(PORT, () => {
  const msg = tsHeader(`HTTP server up on :${PORT}  →  http://localhost:${PORT}/`);
  process.stdout.write(msg);
  log.write(msg);
});

// ---------- 4. PTY ----------
const isWin = process.platform === 'win32';
const ptyFile = isWin ? 'cmd.exe' : 'claude';
const ptyArgs = isWin ? ['/c', 'claude'] : [];
const pty = spawnPty(ptyFile, ptyArgs, {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: __dirname,
  env: process.env,
});

const startMsg = tsHeader(`PTY spawn claude (cols=${COLS} rows=${ROWS} cwd=${__dirname})`);
process.stdout.write(startMsg);
log.write(startMsg);

pty.onData((data) => {
  bytesReceived += data.length;
  process.stdout.write(data);
  log.write(data);
  pushReplay(data);
  broadcast(data);
});

pty.onExit(({ exitCode: code, signal }) => {
  exitCode = code;
  const msg = tsHeader(`claude exited (code=${code}, signal=${signal ?? '-'}, bytes=${bytesReceived})`);
  process.stdout.write(msg);
  log.write(msg);
  broadcast(msg);
  log.end();
  // Laisse le serveur HTTP tourner 3s pour que les clients voient le message d'exit
  setTimeout(() => { server.close(); process.exit(0); }, 3000);
});

// ---------- 5. SIGINT propre ----------
process.on('SIGINT', () => {
  const msg = tsHeader('SIGINT recu — kill PTY + close HTTP');
  process.stdout.write(msg);
  log.write(msg);
  broadcast(msg);
  try { pty.kill('SIGTERM'); } catch {}
  setTimeout(() => { server.close(); process.exit(0); }, 1500);
});
