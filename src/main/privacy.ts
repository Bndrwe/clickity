// Privacy controls: the never-capture list, blur before sending and "private for 10 min".
// capture.grabScreens() asks screenVerdict() before any pixels are used; the turn then goes on
// without the screenshot and the bubble says why ("didn't look — 1password is open").
//
// What can be detected (honest, per platform; every probe is time-boxed and optional):
//   macOS   — the focused app (lsappinfo) and every on-screen window's owner app, title and bounds
//             (CGWindowList via osascript; titles need the screen-recording permission clickity
//             already has). Apps that hide themselves from capture (1Password, Keychain prompts with
//             secure input) are blank anyway.
//   windows — the focused process and every visible, non-minimised top-level window (process name,
//             title, bounds) via PowerShell + user32. PowerShell compiles a tiny
//             helper every time, so each check costs ~0.5–1.5 s (run alongside the capture).
//   linux   — X11 with xdotool / wmctrl installed: the focused window class and the window list
//             with geometry (minimised windows skipped via xprop). Wayland and missing tools: the
//             focused app only when xdotool can read it, otherwise nothing — the list can't protect
//             you there, use private mode.
import { execFile } from 'node:child_process';
import { screen } from 'electron';
import { activeAppName } from './live-context';
import { getSettings, updateSettings } from './settings-store';
import { log } from './log';
import { cleanList, matchName, privacyLine, privacyVerdict, type ProbedWindow, type Rect } from './privacy-match';
import type { PrivacyCheck } from '../shared/ipc';

const PROBE_MS = 2500;

/** Thrown by capture.grabScreens when nothing may be captured; carries the bubble line. */
export class PrivacySkip extends Error {
  readonly privacy: string;
  constructor(line: string) {
    super(line);
    this.name = 'PrivacySkip';
    this.privacy = line;
  }
}

export function isPrivacySkip(e: unknown): e is PrivacySkip {
  return !!e && typeof e === 'object' && typeof (e as { privacy?: unknown }).privacy === 'string';
}

function run(cmd: string, args: string[], timeout = PROBE_MS): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out)));
    } catch {
      resolve('');
    }
  });
}

/* ───────── private mode ───────── */

let expiryTimer: NodeJS.Timeout | null = null;

export function privateUntil(now = Date.now()): number {
  const until = getSettings().privacy?.privateUntil ?? 0;
  return until > now ? until : 0;
}

/** Private mode for `minutes` (0 = off). Returns privateUntil. */
export function setPrivateFor(minutes: number): number {
  const m = Math.max(0, Math.min(24 * 60, Math.round(Number(minutes) || 0)));
  const until = m ? Date.now() + m * 60_000 : 0;
  updateSettings({ privacy: { privateUntil: until } });
  log('privacy', until ? `private mode on for ${m} min` : 'private mode off');
  schedulePrivateExpiry();
  return until;
}

export function togglePrivate(minutes = 10): number {
  return setPrivateFor(privateUntil() ? 0 : minutes);
}

/** When private mode runs out, clear it in settings so the tray / notch / companion catch up. */
export function schedulePrivateExpiry(): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  const raw = getSettings().privacy?.privateUntil ?? 0;
  if (!raw) return;
  const left = raw - Date.now();
  if (left <= 0) {
    updateSettings({ privacy: { privateUntil: 0 } });
    return;
  }
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    if ((getSettings().privacy?.privateUntil ?? 0) <= Date.now() + 500) {
      updateSettings({ privacy: { privateUntil: 0 } });
      log('privacy', 'private mode ended');
    } else schedulePrivateExpiry();
  }, Math.min(left + 50, 2 ** 31 - 1));
}

/* ───────── window probes ───────── */

async function linuxWindows(): Promise<ProbedWindow[] | null> {
  const out = await run('wmctrl', ['-lxG']);
  if (!out.trim()) return null;
  const desk = /^(\d+)\s+\*/m.exec(await run('wmctrl', ['-d']))?.[1];
  const wins: ProbedWindow[] = [];
  for (const line of out.split('\n')) {
    // 0x03a00003  0 10   20   800  600  nautilus.Nautilus  host  Title words
    const m = /^(0x[0-9a-f]+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+\S+\s?(.*)$/i.exec(line.trim());
    if (!m) continue;
    if (desk !== undefined && m[2] !== '-1' && m[2] !== desk) continue; // another workspace
    const cls = m[7]!.split('.');
    wins.push({ id: m[1]!, app: `${cls[1] ?? cls[0]} ${cls[0]}`, title: m[8] ?? '', bounds: { x: +m[3]!, y: +m[4]!, width: +m[5]!, height: +m[6]! } });
  }
  return wins;
}

/** linux: is this (matching) window minimised? xprop only for the few that match. */
export async function linuxHidden(id: string): Promise<boolean> {
  return /_NET_WM_STATE_HIDDEN/.test(await run('xprop', ['-id', id, '_NET_WM_STATE'], 800));
}

const WIN_PS = String.raw`
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class CkW{
 public delegate bool P(IntPtr h,IntPtr l);
 [DllImport("user32.dll")]public static extern bool EnumWindows(P p,IntPtr l);
 [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")]public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);
 [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out R r);
 [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]public static extern bool SetProcessDPIAware();
 [DllImport("dwmapi.dll")]public static extern int DwmGetWindowAttribute(IntPtr h,int a,out int v,int s);
 public struct R{public int L,T,Rt,B;}
}
"@
[void][CkW]::SetProcessDPIAware()
$fg=[CkW]::GetForegroundWindow()
$out=New-Object System.Collections.ArrayList
$cb=[CkW+P]{param($h,$l)
 if([CkW]::IsWindowVisible($h) -and -not [CkW]::IsIconic($h)){
  $c=0;[void][CkW]::DwmGetWindowAttribute($h,14,[ref]$c,4)
  if($c -eq 0){
   $n=[CkW]::GetWindowTextLength($h)
   $sb=New-Object System.Text.StringBuilder ($n+1);[void][CkW]::GetWindowText($h,$sb,$sb.Capacity)
   $p=0;[void][CkW]::GetWindowThreadProcessId($h,[ref]$p)
   $r=New-Object CkW+R;[void][CkW]::GetWindowRect($h,[ref]$r)
   $pn=(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
   $f=if($h -eq $fg){'*'}else{'-'}
   [void]$out.Add(($f,$pn,$r.L,$r.T,$r.Rt,$r.B,$sb.ToString()) -join [char]9)
  }
 }
 $true}
[void][CkW]::EnumWindows($cb,[IntPtr]::Zero)
$out -join [char]10
`;

async function windowsWindows(): Promise<{ front: string; windows: ProbedWindow[] } | null> {
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PS], 4000);
  if (!out.trim()) return null;
  let front = '';
  const windows: ProbedWindow[] = [];
  for (const line of out.split(/\r?\n/)) {
    const [f, app, l, t, r, b, ...title] = line.split('\t');
    if (!app) continue;
    if (f === '*') front = app;
    const phys = { x: +l!, y: +t!, width: +r! - +l!, height: +b! - +t! };
    let bounds: Rect | null = null;
    if ([phys.x, phys.y, phys.width, phys.height].every(Number.isFinite) && phys.width > 0 && phys.height > 0) {
      try {
        bounds = screen.screenToDipRect(null, phys); // GetWindowRect is in physical pixels (DPI aware)
      } catch {
        bounds = phys;
      }
    }
    windows.push({ app, title: title.join('\t'), bounds });
  }
  return { front, windows };
}

const MAC_JXA = `ObjC.import('CoreGraphics');
var a = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
JSON.stringify(a.filter(function (w) { return w.kCGWindowLayer === 0; }).map(function (w) {
  var b = w.kCGWindowBounds || {};
  return [w.kCGWindowOwnerName || '', w.kCGWindowName || '', b.X, b.Y, b.Width, b.Height];
}));`;

async function macWindows(): Promise<ProbedWindow[] | null> {
  const out = await run('osascript', ['-l', 'JavaScript', '-e', MAC_JXA]);
  try {
    const rows = JSON.parse(out) as Array<[string, string, number, number, number, number]>;
    return rows.map(([app, title, x, y, w, h]) => ({ app: String(app ?? ''), title: String(title ?? ''), bounds: [x, y, w, h].every((v) => typeof v === 'number') ? { x, y, width: w, height: h } : null }));
  } catch {
    return null;
  }
}

interface Probe {
  front: string;
  /** null = the window list can't be read here */
  windows: ProbedWindow[] | null;
}

/** one probe serves a talk-down grab and its key-up re-grab (powershell is slow to start) */
let probeCache: { at: number; p: Promise<Probe> } | null = null;
const PROBE_CACHE_MS = 1500;

function probe(): Promise<Probe> {
  if (probeCache && Date.now() - probeCache.at < PROBE_CACHE_MS) return probeCache.p;
  const p = probeNow();
  probeCache = { at: Date.now(), p };
  return p;
}

async function probeNow(): Promise<Probe> {
  if (process.platform === 'win32') {
    const w = await windowsWindows();
    if (w) return { front: w.front, windows: w.windows };
    return { front: await activeAppName().catch(() => ''), windows: null };
  }
  const [front, windows] = await Promise.all([
    activeAppName()
      .catch(() => '')
      // linux without an EWMH window manager: the X input focus still names the app
      // (older xdotool has no getwindowclassname: the focused window's title then)
      .then(async (n) => {
        if (n || process.platform !== 'linux') return n;
        return (await run('xdotool', ['getwindowfocus', 'getwindowclassname'], 800)).trim() || (await run('xdotool', ['getwindowfocus', 'getwindowname'], 800)).trim();
      }),
    (process.platform === 'darwin' ? macWindows() : process.platform === 'linux' ? linuxWindows() : Promise.resolve(null)).catch(() => null),
  ]);
  return { front, windows };
}

/** Which windows of the list match (linux: drop the minimised ones, checked only for matches). */
async function visibleMatches(list: string[], p: Probe): Promise<ProbedWindow[]> {
  const wins = p.windows ?? [];
  if (process.platform !== 'linux') return wins;
  const out: ProbedWindow[] = [];
  for (const w of wins) {
    if (!(matchName(list, w.app) ?? matchName(list, w.title))) continue;
    if (w.id && (await linuxHidden(w.id))) continue;
    out.push(w);
  }
  return out;
}

export interface ScreenVerdict {
  /** set: capture nothing; the bubble line */
  all: string | null;
  /** display id → the bubble line for a left-out screen */
  displays: Map<number, string>;
}

/**
 * Before a capture: may clickity look? Private mode → nothing. Otherwise the focused app and
 * (where readable) the window list against the never-capture list. Never throws.
 */
export async function screenVerdict(probed?: Probe): Promise<ScreenVerdict> {
  const until = privateUntil();
  if (until) return { all: privacyLine({ kind: 'private', minutesLeft: (until - Date.now()) / 60_000 }), displays: new Map() };
  const list = cleanList(getSettings().privacy?.neverCapture);
  if (!list.length) return { all: null, displays: new Map() };
  try {
    const p = probed ?? (await probe());
    const displays = screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds }));
    const v = privacyVerdict(list, p.front, await visibleMatches(list, p), displays);
    if (v.all) {
      log('privacy', `not capturing: ${v.all} (focused: ${p.front || '?'})`);
      return { all: privacyLine({ kind: 'app', name: v.all }), displays: new Map() };
    }
    const out = new Map<number, string>();
    for (const [id, name] of v.displays) out.set(id, privacyLine({ kind: 'app', name, partial: true }));
    if (out.size) log('privacy', `leaving out ${out.size} screen(s): ${[...v.displays.values()].join(', ')}`);
    return { all: null, displays: out };
  } catch (err) {
    log('privacy', 'probe failed:', err);
    return { all: null, displays: new Map() };
  }
}

export function blurMode(): 'off' | 'cursor' | 'all' {
  const b = getSettings().privacy?.blur;
  return b === 'cursor' || b === 'all' ? b : 'off';
}

function platformDetail(windows: boolean): string {
  switch (process.platform) {
    case 'darwin':
      return windows ? 'macos: the focused app and every window on screen are checked.' : "macos: only the focused app could be read (the window list didn't answer).";
    case 'win32':
      return windows ? 'windows: the focused app and every visible window are checked.' : "windows: only the focused app could be read (powershell didn't answer).";
    default:
      return windows
        ? 'linux (x11): the focused window and the window list are checked (wmctrl + xdotool).'
        : 'linux: install xdotool and wmctrl (x11) so clickity can see which apps are open. on wayland it can’t tell — use private mode.';
  }
}

/** settings › privacy › check now */
export async function privacyCheck(): Promise<PrivacyCheck> {
  const p = await probe();
  const v = await screenVerdict(p);
  const blocked = v.all ?? (v.displays.size ? [...v.displays.values()][0]! : null);
  return { front: p.front, blocked, windows: p.windows ? p.windows.length : -1, detail: platformDetail(!!p.windows) };
}
