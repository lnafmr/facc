/**
 * transcript.mjs — lit un transcript JSONL Claude Code et en extrait le dernier
 * message assistant. Le champ `message` des lignes type:"assistant" est déjà au
 * format Anthropic (content[], stop_reason, usage, model, id), donc l'extraction
 * est directe.
 *
 * Sert à enrichir la réponse API avec le `usage` réel (tokens) et le
 * `stop_reason`, que le Stop hook ne fournit pas (il ne donne que le texte via
 * last_assistant_message).
 */

import { readFileSync } from 'node:fs';

/**
 * Retourne le dernier message assistant du transcript, ou null.
 * On prend la dernière ligne type:"assistant" (le tour le plus récent). En MVP
 * sans tools, c'est la réponse cherchée.
 * @param {string} transcriptPath
 * @returns {null | {id?:string, model?:string, content:Array, stop_reason?:string, stop_sequence?:string|null, usage?:object}}
 */
export function lastAssistantMessage(transcriptPath) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'assistant' && obj.message) {
      const m = obj.message;
      return {
        id: m.id,
        model: m.model,
        content: Array.isArray(m.content) ? m.content : [],
        stop_reason: m.stop_reason ?? null,
        stop_sequence: m.stop_sequence ?? null,
        usage: m.usage ?? null,
      };
    }
  }
  return null;
}

/**
 * Variante résiliente : le Stop hook peut arriver avant que la ligne assistant
 * soit flushée sur disque. On retry jusqu'à trouver un message assistant
 * (optionnellement dont le texte correspond à `expectText`).
 * @param {string} transcriptPath
 * @param {object} [o]
 * @param {string} [o.expectText]  texte attendu (du hook) pour valider le bon tour
 * @param {number} [o.retries=10]
 * @param {number} [o.delayMs=150]
 * @returns {Promise<null | object>}
 */
export async function lastAssistantMessageRetry(transcriptPath, o = {}) {
  const { expectText, retries = 10, delayMs = 150 } = o;
  for (let i = 0; i <= retries; i++) {
    const msg = lastAssistantMessage(transcriptPath);
    if (msg) {
      if (!expectText) return msg;
      if (textFromContent(msg.content).trim() === expectText.trim()) return msg;
    }
    if (i < retries) await new Promise((r) => setTimeout(r, delayMs));
  }
  return lastAssistantMessage(transcriptPath); // dernier essai best-effort
}

/**
 * Concatène le texte de tous les blocs type:"text" du content.
 * @param {Array} content
 * @returns {string}
 */
export function textFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
}
