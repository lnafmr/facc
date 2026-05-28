/**
 * pty-session.mjs — pilote une session Claude Code interactive via PTY.
 *
 * Stratégie : on lance `claude` interactif (facturation abonnement) dans un PTY
 * uniquement pour INJECTER des prompts. La capture de la réponse ne se fait PAS
 * en scrapant l'écran, mais via un Stop hook http : Claude finit son tour →
 * envoie {session_id, last_assistant_message, transcript_path} au bridge, qui
 * appelle onStopHook() pour résoudre la requête en attente.
 *
 * - session_id connu à l'avance (--session-id) → corrélation directe.
 * - Stop hook injecté via --settings (pas de pollution des settings projet).
 * - File d'attente : une requête à la fois par session.
 */

import { spawn as spawnPty } from 'node-pty';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Consigne ajoutée au system prompt : on sert une API de chat, donc jamais
// d'interaction bloquante (menus, questions à choix). Écrite dans un fichier
// pour éviter les problèmes de quoting CLI (espaces/apostrophes via cmd.exe).
const APPEND_SYSTEM_PROMPT = [
  "You are a helpful, neutral, general-purpose assistant serving a chat API.",
  "You are NOT tied to any project, codebase or repository: never mention a",
  "\"project\" and do not assume the user wants coding help unless they ask.",
  "Answer general questions directly, in the user's language.",
  "Always reply with a complete final text message in a single turn.",
  "Never use interactive tools that wait for user input (choice menus, plan",
  "mode). If you want to offer choices, write them as plain text (1., 2., 3.).",
].join(' ');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Pré-trust du dossier (évite le dialog interactif "Quick safety check").
function ensureTrusted(projectPath) {
  const p = resolve(homedir(), '.claude.json');
  if (!existsSync(p)) return false;
  const cfg = JSON.parse(readFileSync(p, 'utf8'));
  cfg.projects ??= {};
  const entry = cfg.projects[projectPath] ?? {};
  if (entry.hasTrustDialogAccepted === true) return true;
  cfg.projects[projectPath] = {
    allowedTools: [], mcpContextUris: [], mcpServers: {},
    enabledMcpjsonServers: [], disabledMcpjsonServers: [],
    ...entry, hasTrustDialogAccepted: true,
  };
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  return true;
}

/**
 * Crée et démarre une session PTY Claude pilotable par hook.
 * @param {object} opts
 * @param {number} opts.bridgePort       port du bridge (pour l'URL du Stop hook)
 * @param {string} [opts.cwd]            répertoire de travail de claude
 * @param {string} [opts.sessionId]      uuid (généré sinon)
 * @param {string} [opts.model]          alias modèle (ex: 'opus', 'sonnet')
 * @param {number} [opts.cols=200]
 * @param {number} [opts.rows=50]
 * @param {number} [opts.enterDelayMs=300]  délai texte→Entrée (règle TUI)
 * @param {number} [opts.responseTimeoutMs=180000]
 * @param {(chunk:string)=>void} [opts.onData]  hook flux brut (viewer/debug)
 */
export function createSession(opts = {}) {
  const {
    bridgePort,
    cwd = process.cwd(),
    sessionId = randomUUID(),
    model,
    cols = 200,
    rows = 50,
    enterDelayMs = 300,
    responseTimeoutMs = 180_000,
    onData,
    onExit,
  } = opts;

  if (!bridgePort) throw new Error('createSession: bridgePort requis');

  ensureTrusted(cwd);

  // Settings injectant le Stop hook http vers le bridge (+ skip du dialog
  // "dangerous mode" au cas où bypassPermissions le déclencherait).
  const settings = JSON.stringify({
    skipDangerousModePermissionPrompt: true,
    hooks: {
      Stop: [{ hooks: [{ type: 'http', url: `http://localhost:${bridgePort}/_hook/stop` }] }],
    },
  });

  // Fichiers temporaires PROPRES À CETTE SESSION (nom unique via sessionId).
  // Important : on passe --settings comme CHEMIN, pas comme chaîne JSON. Avec une
  // chaîne, claude matérialise /tmp/claude-settings-<hash>.json (nom dérivé du
  // contenu) → collision de propriété entre utilisateurs (ex: fichier laissé par
  // root → EACCES pour un autre user). Un chemin qu'on possède évite ça.
  const settingsFile = resolve(tmpdir(), `facc-${sessionId}-settings.json`);
  const promptFile = resolve(tmpdir(), `facc-${sessionId}-sysprompt.txt`);
  try { writeFileSync(settingsFile, settings, 'utf8'); } catch {}
  try { writeFileSync(promptFile, APPEND_SYSTEM_PROMPT, 'utf8'); } catch {}
  const cleanupTempFiles = () => {
    for (const f of [settingsFile, promptFile]) { try { unlinkSync(f); } catch {} }
  };

  // bypassPermissions : pas de prompt de permission interactif.
  // disallowedTools AskUserQuestion : empêche le blocage sur un menu interactif
  //   (sans Stop hook) → Claude écrit les choix en texte à la place.
  const claudeArgs = [
    '--session-id', sessionId,
    '--permission-mode', 'bypassPermissions',
    '--disallowedTools', 'AskUserQuestion',
    '--append-system-prompt-file', promptFile,
    '--settings', settingsFile,
  ];
  if (model) claudeArgs.push('--model', model);

  const isWin = process.platform === 'win32';
  const file = isWin ? 'cmd.exe' : 'claude';
  const args = isWin ? ['/c', 'claude', ...claudeArgs] : claudeArgs;

  const pty = spawnPty(file, args, {
    name: 'xterm-256color', cols, rows, cwd, env: process.env,
  });

  let exitCode = null;
  let rawTail = ''; // fin du flux brut, pour détecter la box de prompt ❯
  pty.onData((chunk) => {
    if (onData) { try { onData(chunk); } catch {} }
    rawTail = (rawTail + chunk).slice(-4000);
  });
  pty.onExit(({ exitCode: code }) => {
    exitCode = code;
    cleanupTempFiles();
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error(`claude exited (code=${code})`)); pending = null; }
    // rawTail = dernière sortie du PTY → permet de diagnostiquer pourquoi claude meurt.
    if (onExit) { try { onExit(code, rawTail); } catch {} }
  });

  // Prêt : la box de prompt ❯ apparaît dans le flux brut (sinon timeout de boot).
  const ready = new Promise((res) => {
    const deadline = Date.now() + 30_000;
    const tick = () => {
      if (rawTail.includes('❯') || Date.now() > deadline || exitCode !== null) return res();
      setTimeout(tick, 150);
    };
    tick();
  });

  // ---------- Une requête à la fois ----------
  let pending = null; // { resolve, reject, timer }
  let chain = Promise.resolve();
  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  }

  /**
   * Envoie une invite (déjà aplatie) et attend la réponse via le Stop hook.
   * @param {string} prompt
   * @returns {Promise<{text:string, sessionId:string, transcriptPath:string, raw:object}>}
   */
  function ask(prompt) {
    return enqueue(async () => {
      if (exitCode !== null) throw new Error(`claude session exited (code=${exitCode})`);
      await ready;

      const result = new Promise((resolveAsk, rejectAsk) => {
        const timer = setTimeout(() => {
          if (pending) {
            pending = null;
            // Annule le tour bloqué (Esc) pour rendre la session réutilisable.
            try { pty.write('\x1b'); } catch {}
            rejectAsk(new Error('response timeout (hook non reçu)'));
          }
        }, responseTimeoutMs);
        pending = { resolve: resolveAsk, reject: rejectAsk, timer };
      });

      // Saisie : pas de newline brut (soumettrait en cours de frappe).
      const oneLine = String(prompt).replace(/\r?\n/g, ' ');
      pty.write(oneLine);
      await delay(enterDelayMs);
      pty.write('\r');

      return result;
    });
  }

  // Appelé par le serveur quand le Stop hook arrive pour cette session.
  function onStopHook(payload) {
    if (!pending) return false; // pas de requête en attente (ex: stop au boot)
    clearTimeout(pending.timer);
    const p = pending;
    pending = null;
    p.resolve({
      text: payload.last_assistant_message ?? '',
      sessionId: payload.session_id,
      transcriptPath: payload.transcript_path,
      raw: payload,
    });
    return true;
  }

  function kill() {
    try { pty.write('/exit'); } catch {}
    setTimeout(() => { try { pty.kill(); } catch {} }, 500);
  }

  return {
    sessionId,
    cwd,
    ask,
    onStopHook,
    ready,
    kill,
    get exitCode() { return exitCode; },
    _pty: pty,
  };
}
