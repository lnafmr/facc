/**
 * M3 — valide la compat avec le vrai SDK Anthropic pointé sur notre façade.
 *   node test-sdk.mjs
 */
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.API_KEY || 'dummy-key',
  baseURL: process.env.BASE_URL || 'http://localhost:3066',
});

console.log('[sdk] baseURL =', client.baseURL);

console.log('\n--- Test 1 : message simple ---');
const m1 = await client.messages.create({
  model: 'claude-opus-4-7',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'Reponds uniquement: ANANAS' }],
});
console.log('id:', m1.id, '| role:', m1.role, '| stop_reason:', m1.stop_reason);
console.log('content:', JSON.stringify(m1.content));
console.log('usage:', JSON.stringify(m1.usage));

console.log('\n--- Test 2 : system + multi-tours ---');
const m2 = await client.messages.create({
  model: 'claude-opus-4-7',
  max_tokens: 200,
  system: 'Tu reponds en un seul mot.',
  messages: [
    { role: 'user', content: 'Retiens le code secret: ZEBRE.' },
    { role: 'assistant', content: 'Compris.' },
    { role: 'user', content: 'Quel est le code secret ?' },
  ],
});
console.log('content:', JSON.stringify(m2.content));

console.log('\n--- Test 3 : content en blocs (array) ---');
const m3 = await client.messages.create({
  model: 'claude-opus-4-7',
  max_tokens: 100,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reponds uniquement: TOUCAN' }] }],
});
console.log('content:', JSON.stringify(m3.content));

console.log('\n[sdk] OK — le SDK Anthropic parle à notre façade.');
