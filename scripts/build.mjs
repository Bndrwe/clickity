// Bundles main, preload and renderer code with esbuild, then copies static renderer files.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };

await Promise.all([
  build({ ...common, platform: 'node', format: 'cjs', entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js', external: ['electron', 'uiohook-napi'] }),
  build({ ...common, platform: 'node', format: 'cjs', entryPoints: { overlay: 'src/preload/overlay.ts', settings: 'src/preload/settings.ts' }, outdir: 'dist/preload', external: ['electron'] }),
  build({ ...common, platform: 'browser', format: 'iife', entryPoints: { 'overlay/overlay': 'src/renderer/overlay/overlay.ts', 'settings/settings': 'src/renderer/settings/settings.ts' }, outdir: 'dist/renderer' }),
]);

// copy static html/css from renderer folders
for (const dir of ['overlay', 'settings']) {
  const src = join('src/renderer', dir);
  const out = join('dist/renderer', dir);
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(src)) if (/\.(html|css|svg|png)$/.test(f)) cpSync(join(src, f), join(out, f));
}
mkdirSync('dist/assets', { recursive: true });
cpSync('assets', 'dist/assets', { recursive: true });
if (watch) console.log('watch mode not implemented; re-run build');
