#!/usr/bin/env node
/**
 * generate-key.mjs — génère une clé API pour protéger /v1/messages.
 *
 * À lancer après le clone :  npm run gen-key
 * - crée .env à partir de .env.example s'il n'existe pas
 * - génère une clé aléatoire (32 octets, hex) et l'écrit dans API_KEY=
 * - ne réécrase pas une clé existante (utiliser --force pour régénérer)
 *
 * Le serveur (server.mjs) lit API_KEY : si défini, chaque requête doit fournir
 * le header `x-api-key` correspondant.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const force = process.argv.includes('--force');
const ENV = resolve(process.cwd(), '.env');
const EXAMPLE = resolve(process.cwd(), '.env.example');

// 1. S'assurer que .env existe (copie du template, sinon fichier vide).
if (!existsSync(ENV)) {
  if (existsSync(EXAMPLE)) {
    copyFileSync(EXAMPLE, ENV);
    console.log('[gen-key] .env créé depuis .env.example');
  } else {
    writeFileSync(ENV, '');
    console.log('[gen-key] .env créé (vide)');
  }
}

let content = readFileSync(ENV, 'utf8');

// 2. Détecter une clé déjà définie (non vide, hors placeholder).
const m = content.match(/^\s*API_KEY=(.*)$/m);
const existing = m && m[1].trim() && m[1].trim() !== 'change-me' ? m[1].trim() : null;
if (existing && !force) {
  console.log('[gen-key] Une API_KEY est déjà définie dans .env.');
  console.log('[gen-key] Utiliser `npm run gen-key -- --force` pour en régénérer une.');
  process.exit(0);
}

// 3. Générer et écrire la clé (remplace la ligne API_KEY, commentée ou non).
const key = randomBytes(32).toString('hex');
if (/^#?\s*API_KEY=.*$/m.test(content)) {
  content = content.replace(/^#?\s*API_KEY=.*$/m, `API_KEY=${key}`);
} else {
  content += (content.endsWith('\n') || content === '' ? '' : '\n') + `API_KEY=${key}\n`;
}
writeFileSync(ENV, content);

console.log('[gen-key] API_KEY générée et écrite dans .env :\n');
console.log('  ' + key + '\n');
console.log('[gen-key] Les clients doivent désormais envoyer ce header :');
console.log('  x-api-key: ' + key);
console.log('\n[gen-key] Relance le serveur pour activer la protection : npm start');
