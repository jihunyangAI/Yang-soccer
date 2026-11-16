// Turns dist/index.html into a body-only page for claude.ai Artifact publishing
// (the artifact host supplies its own <html>/<head>/<body> skeleton).
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? '';
const body = html.match(/<body>([\s\S]*?)<\/body>/i)?.[1] ?? '';
const keep = head
  .replace(/<meta charset[^>]*>/i, '')
  .replace(/<meta name="viewport"[^>]*>/i, '');
writeFileSync(new URL('../dist/artifact.html', import.meta.url), `${keep}\n${body}\n`);
console.log('wrote dist/artifact.html');
