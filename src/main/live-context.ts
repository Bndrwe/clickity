// Live context for the system prompt: local date / time, the focused app and (best effort) the
// titles of open windows. Every probe is optional, time-boxed and silent when unavailable:
//   linux   — xdotool (active window) + wmctrl -l (window list) when installed
//   windows — PowerShell Get-Process MainWindowTitle
//   macOS   — lsappinfo (front app; window titles would need another permission, so skipped)
import { execFile } from 'node:child_process';

const PROBE_TIMEOUT_MS = 1500;
const CACHE_MS = 4000;
const MAX_TITLES = 25;

function run(cmd: string, args: string[], timeout = PROBE_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 256 * 1024 }, (err, out) => resolve(err ? '' : String(out)));
    } catch {
      resolve('');
    }
  });
}

const TERMINALS = /terminal|iterm|konsole|xterm|alacritty|kitty|wezterm|powershell|pwsh|cmd\.exe|command prompt|warp|hyper|tilix|terminator|ghostty|tabby|windowsterminal|urxvt|st-256color|foot/i;

export function isTerminalApp(name: string): boolean {
  return !!name && TERMINALS.test(name);
}

/** The focused app / window name ('' when unknown). */
export async function activeAppName(): Promise<string> {
  if (process.platform === 'linux') {
    const cls = (await run('xdotool', ['getactivewindow', 'getwindowclassname'])).trim();
    if (cls) return cls;
    return (await run('xdotool', ['getactivewindow', 'getwindowname'])).trim();
  }
  if (process.platform === 'darwin') {
    const asn = (await run('lsappinfo', ['front'])).trim();
    if (!asn) return '';
    const info = await run('lsappinfo', ['info', '-only', 'name', asn]);
    return /"[^"]*name"\s*=\s*"([^"]+)"/i.exec(info)?.[1] ?? '';
  }
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Add-Type @"\nusing System;using System.Runtime.InteropServices;public class FG{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);}\n"@;$p=0;[void][FG]::GetWindowThreadProcessId([FG]::GetForegroundWindow(),[ref]$p);(Get-Process -Id $p).ProcessName',
    ], 3000);
    return out.trim();
  }
  return '';
}

/** Titles of open, titled windows (deduped, capped). */
export async function windowTitles(): Promise<string[]> {
  let lines: string[] = [];
  if (process.platform === 'linux') {
    const out = await run('wmctrl', ['-l']);
    // "0x03a00003  0 host Title words"
    lines = out.split('\n').map((l) => l.replace(/^\S+\s+-?\d+\s+\S+\s?/, '').trim());
  } else if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.ProcessName + " — " + $_.MainWindowTitle }'], 3000);
    lines = out.split(/\r?\n/);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const t = l.trim().slice(0, 120);
    if (!t || seen.has(t) || /^clickity/i.test(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TITLES) break;
  }
  return out;
}

let cache: { at: number; value: Promise<string> } | null = null;

/** The LIVE CONTEXT section of the system prompt (date / time always; apps when they can be read). */
export function liveContextPrompt(now = new Date()): Promise<string> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value.then((apps) => format(now, apps));
  const value = Promise.all([activeAppName().catch(() => ''), windowTitles().catch(() => [] as string[])]).then(([front, titles]) => {
    const parts: string[] = [];
    if (front) parts.push(`- focused app: ${front}`);
    if (titles.length) parts.push(`- open windows: ${titles.join(' | ')}`);
    return parts.join('\n');
  });
  cache = { at: Date.now(), value };
  return value.then((apps) => format(now, apps));
}

function format(now: Date, apps: string): string {
  const date = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const time = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  let tz = '';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* ignore */
  }
  return `\n\nLIVE CONTEXT\n- it is ${date}, ${time}${tz ? ` (${tz})` : ''} on the user's computer\n${apps}`.trimEnd();
}

/** How to change clickity itself, so "how do i change my hotkey?" gets a real answer. */
export function selfHelpPrompt(labels: { talk: string; type: string; dictate: string; typeTap: string; alwaysOn: string }): string {
  return `

ABOUT CLICKITY ITSELF (answer questions about your own settings from this; settings open from the menu bar / tray icon)
- talk: hold ${labels.talk}. type a question: ${labels.type} or ${labels.typeTap}. dictate into any app: hold ${labels.dictate} (add option / alt to draft a reply). hands-free on/off: ${labels.alwaysOn}. all keys: settings › keys (record).
- voice in / out, language, microphone and captions: settings › voice. dictionary and corrections: settings › dictation.
- the model / provider: settings › model. agent mode (clicking for the user): settings › companion. memory: settings › memory. scheduled routines: settings › routines.`;
}
