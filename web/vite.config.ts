import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single-file build: the whole game ships as one index.html,
// so it can be hosted anywhere (static host, artifact, itch.io).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
// Shown in the game so testers can say which build they played.
// The date in Korea, wherever the build runs (the hosting service builds in UTC).
const build = `v${pkg.version} · ${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date())}`;

export default defineConfig({
  plugins: [viteSingleFile()],
  define: { __BUILD__: JSON.stringify(build) },
  build: { target: 'es2020' },
});
