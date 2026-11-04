// Diagnostic log: timestamped lines appended to <logs>/clickity.log (rotated at ~1 MB to
// clickity.old.log). Every voice-turn stage is logged here so "it doesn't work" reports can be
// diagnosed: settings › about › "open logs".
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const MAX_BYTES = 1024 * 1024;

let file: string | null = null;
let size = 0;

function logFile(): string | null {
  if (file) return file;
  try {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'clickity.log');
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
  } catch {
    file = null;
  }
  return file;
}

/** Absolute path of the log file (it may not exist yet). */
export function logPath(): string {
  return logFile() ?? path.join(app.getPath('userData'), 'clickity.log');
}

function fmt(v: unknown): string {
  if (v instanceof Error) return v.stack ? v.stack.split('\n').slice(0, 4).join(' | ') : `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Append one line: `2026-11-04T08:21:00.123Z [scope] message …` */
export function log(scope: string, ...parts: unknown[]): void {
  const line = `${new Date().toISOString()} [${scope}] ${parts.map(fmt).join(' ')}\n`;
  if (!app.isPackaged || process.env.CLICKITY_TEST) process.stdout.write(line);
  const f = logFile();
  if (!f) return;
  try {
    if (size + line.length > MAX_BYTES) {
      try {
        fs.renameSync(f, path.join(path.dirname(f), 'clickity.old.log'));
      } catch {
        /* first rotation / race */
      }
      size = 0;
    }
    fs.appendFileSync(f, line);
    size += Buffer.byteLength(line);
  } catch {
    /* never let logging break the app */
  }
}

/** Start-of-session header with the environment that matters for support. */
export function logStartup(extra: Record<string, unknown> = {}): void {
  log(
    'app',
    `start v${app.getVersion()} ${process.platform}/${process.arch} electron ${process.versions.electron}`,
    `packaged=${app.isPackaged}`,
    extra,
  );
}
