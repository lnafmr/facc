/**
 * anthropic.mjs — parsing requête / formatage réponse au format API Anthropic
 * Messages (POST /v1/messages), et aplatissement de l'historique en une seule
 * invite injectable dans la session Claude interactive.
 */

import { randomUUID } from 'node:crypto';

/** Normalise un `content` Anthropic (string | bloc[] ) en texte simple. */
export function normalizeContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && b.type === 'text') return b.text || '';
        return ''; // image / tool_use / tool_result ignorés en MVP
      })
      .join('');
  }
  return '';
}

/** Normalise `system` (string | bloc[]). */
export function normalizeSystem(system) {
  return normalizeContent(system).trim();
}

/**
 * Aplatit system + messages en une seule invite texte.
 * - 1 seul message user : invite directe (éventuellement préfixée du system).
 * - multi-tours : transcript "User:/Assistant:" précédé des instructions système.
 */
export function flattenPrompt({ system, messages }) {
  const sys = normalizeSystem(system);
  const norm = (messages || []).map((m) => ({
    role: m.role,
    text: normalizeContent(m.content).trim(),
  }));

  if (norm.length <= 1) {
    const userText = norm[0]?.text ?? '';
    return sys ? `${sys}\n\n${userText}` : userText;
  }

  const lines = [];
  if (sys) lines.push(`[Instructions système]\n${sys}\n`);
  lines.push('[Conversation]');
  for (const m of norm) {
    const label = m.role === 'assistant' ? 'Assistant' : 'User';
    lines.push(`${label}: ${m.text}`);
  }
  lines.push('\n[Réponds en tant qu\'Assistant au dernier message User.]');
  return lines.join('\n');
}

/**
 * Construit la réponse au format Anthropic Messages (non-streaming).
 * @param {object} args
 * @param {string} args.text        texte de la réponse (du hook)
 * @param {string} args.model       modèle demandé (echo)
 * @param {object|null} [args.transcriptMsg]  message extrait du transcript (usage, stop_reason, id…)
 */
export function buildMessageResponse({ text, model, transcriptMsg }) {
  const tm = transcriptMsg || {};
  const content = text
    ? [{ type: 'text', text }]
    : (Array.isArray(tm.content) && tm.content.length ? tm.content : [{ type: 'text', text: '' }]);

  const usage = tm.usage
    ? { input_tokens: tm.usage.input_tokens ?? 0, output_tokens: tm.usage.output_tokens ?? 0 }
    : { input_tokens: 0, output_tokens: 0 };

  return {
    id: tm.id || `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model: model || tm.model || 'claude',
    content,
    stop_reason: tm.stop_reason || 'end_turn',
    stop_sequence: tm.stop_sequence ?? null,
    usage,
  };
}

/** Erreur au format Anthropic. */
export function errorResponse(type, message) {
  return { type: 'error', error: { type, message } };
}
