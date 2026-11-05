// Bundles main, preload and renderer code with esbuild, then copies static renderer files.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };

// The chats renderer is optional while it's being written: only bundle it when present.
const rendererEntries = { 'overlay/overlay': 'src/renderer/overlay/overlay.ts', 'settings/settings': 'src/renderer/settings/settings.ts' };
if (existsSync('src/renderer/chats/chats.ts')) rendererEntries['chats/chats'] = 'src/renderer/chats/chats.ts';
if (existsSync('src/renderer/notch/notch.ts')) rendererEntries['notch/notch'] = 'src/renderer/notch/notch.ts';

await Promise.all([
  build({ ...common, platform: 'node', format: 'cjs', entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js', external: ['electron', 'uiohook-napi'] }),
  build({ ...common, platform: 'node', format: 'cjs', entryPoints: { overlay: 'src/preload/overlay.ts', settings: 'src/preload/settings.ts', chats: 'src/preload/chats.ts', notch: 'src/preload/notch.ts' }, outdir: 'dist/preload', external: ['electron'] }),
  build({ ...common, platform: 'browser', format: 'iife', entryPoints: rendererEntries, outdir: 'dist/renderer' }),
]);

// copy static html/css from renderer folders
for (const dir of ['overlay', 'settings', 'chats', 'notch']) {
  const src = join('src/renderer', dir);
  if (!existsSync(src)) continue;
  const out = join('dist/renderer', dir);
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(src)) if (/\.(html|css|svg|png)$/.test(f)) cpSync(join(src, f), join(out, f));
  // css shared by several windows (cards / 3D models)
  if (existsSync('src/renderer/shared')) for (const f of readdirSync('src/renderer/shared')) if (f.endsWith('.css')) cpSync(join('src/renderer/shared', f), join(out, f));
}
mkdirSync('dist/assets', { recursive: true });
cpSync('assets', 'dist/assets', { recursive: true });
if (watch) console.log('watch mode not implemented; re-run build');
