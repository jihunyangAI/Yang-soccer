// Lists the account's audio-capable models (names only).
import { readFileSync } from 'node:fs';
const env = readFileSync(new URL('../../.env.local', import.meta.url), 'utf8');
const key = (env.match(/^\s*(?:OPENAI_API_KEY|open_ai)\s*=\s*["']?([^"'\r\n]+)/m) ?? [])[1] ?? process.env.OPENAI_API_KEY;
const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
const ids = (await r.json()).data.map((m) => m.id).filter((id) => /audio|tts|realtime|voice|speech/i.test(id)).sort();
console.log(ids.join('\n'));
