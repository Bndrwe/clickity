// Proactive tips (opt-in, settings › companion › tips). Every ~45–90 s while the user is active,
// and never while clickity is busy, in a call or watching video, it takes a cheap look: the
// focused app + window title (live-context.ts), and only when that looks worth it (a new window,
// an error-sounding title, going back and forth between two windows) one call to the cheapest
// model (clickys.cheapestModel), optionally with a small screenshot. When the model has a
// genuinely useful tip, a tiny dot appears on the companion — nothing is spoken. The tip key
// (grabbed only while the dot shows) or a click on the dot opens it in a small bubble with
// "not now" / "stop tips". Throttling lives in src/shared/tips.ts (TipsPolicy, unit tested).
import { desktopCapturer, ipcMain, powerMonitor, screen } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC } from '../shared/ipc';
import { PROVIDER_META, type ImageInput, type OverlayTip, type Settings } from '../shared/types';
import { TipsPolicy, parseTipReply, privacyBlocksScreens, isPrivateApp, type TipContext } from '../shared/tips';
import { getSettings, onSettingsChanged, updateSettings } from './settings-store';
import { broadcastToOverlays, getOverlays, overlayForPoint, sendToOverlay } from './overlay';
import { activeAppName, activeWindowTitle } from './live-context';
import { cheapestModel } from './clickys';
import { getProvider } from './providers/index';
import { chordToAccelerator, grabKeys, hotkeyLabel, releaseKeys } from './hotkey';
import { log } from './log';

const TICK_MS = 5_000;
const FOCUS_MS = 10_000;
const MODEL_TIMEOUT_MS = 45_000;

let busy: () => boolean = () => false;
let policy = new TipsPolicy(Date.now());
let timer: NodeJS.Timeout | null = null;
let looking = false;
let lastFocusAt = 0;
let lastNo = '';
let pending: { id: string; text: string; at: number; app: string; open: boolean } | null = null;
let seq = 0;
/** decisions, newest last (settings › companion › tips status line + tests) */
const decisions: Array<{ at: number; what: string }> = [];

function decide(what: string): void {
  decisions.push({ at: Date.now(), what });
  while (decisions.length > 60) decisions.shift();
  log('tips', what);
}

function keyLabel(s: Settings): string {
  return chordToAccelerator(s.tips.key) ? hotkeyLabel(s.tips.key, process.platform) : '';
}

/* ───────── the dot / bubble ───────── */

function push(): void {
  const s = getSettings();
  const t: OverlayTip | null = pending ? { id: pending.id, open: pending.open, text: pending.open ? pending.text : undefined, keyLabel: keyLabel(s) } : null;
  broadcastToOverlays(IPC.overlayTip, t);
}

function grab(): void {
  const s = getSettings();
  releaseKeys('tip');
  if (!pending) return;
  const keys: Record<string, () => void> = {};
  const accel = chordToAccelerator(s.tips.key);
  if (accel && !pending.open) keys[accel] = () => openTip('key');
  if (pending.open) keys.Escape = () => closeTip('esc');
  if (Object.keys(keys).length) grabKeys('tip', keys);
}

function offerTip(text: string, app: string): void {
  pending = { id: `tip-${++seq}`, text, at: Date.now(), app, open: false };
  decide(`offered a tip (${app || 'unknown app'}): dot shown`);
  push();
  grab();
}

export function openTip(how: 'key' | 'click' | 'test'): boolean {
  if (!pending || pending.open) return false;
  pending.open = true;
  decide(`tip opened (${how})`);
  // show it on the display the cursor is on
  const win = overlayForPoint(screen.getCursorScreenPoint());
  for (const w of getOverlays()) sendToOverlay(w, IPC.overlayTip, w === win ? { id: pending.id, open: true, text: pending.text, keyLabel: keyLabel(getSettings()) } : null);
  grab();
  return true;
}

export function closeTip(why: string): void {
  if (!pending) return;
  decide(`tip closed (${why})`);
  pending = null;
  releaseKeys('tip');
  push();
}

function onAction(a: unknown): void {
  if (a === 'not-now') {
    policy.snooze(Date.now());
    closeTip('not now: quiet for 30 minutes');
  } else if (a === 'stop') {
    closeTip('stop tips');
    updateSettings({ tips: { enabled: false } });
  } else closeTip('closed');
}

/* ───────── the look ───────── */

async function smallScreenshot(): Promise<ImageInput | null> {
  try {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const ratio = display.bounds.height / display.bounds.width;
    const width = 768;
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height: Math.round(width * ratio) } });
    const src = sources.find((x) => String(x.display_id) === String(display.id)) ?? sources[0];
    if (!src || src.thumbnail.isEmpty()) return null;
    const jpg = src.thumbnail.toJPEG(60);
    const file = path.join(os.tmpdir(), `clickity-tip-${process.pid}-${Date.now()}.jpg`);
    await fs.writeFile(file, jpg);
    const size = src.thumbnail.getSize();
    return { mime: 'image/jpeg', base64: jpg.toString('base64'), path: file, label: 'screen (small)', width: size.width, height: size.height };
  } catch (err) {
    log('tips', 'screenshot failed:', err);
    return null;
  }
}

function tipPrompt(c: TipContext, signals: string[], withScreen: boolean): string {
  return `You are Clickity, a quiet AI companion on the user's computer. Every minute or so you glance at what they're doing and, very rarely, offer ONE short tip — only when it would genuinely save them time or trouble right now. Most glances should produce no tip.

What you can see:
- focused app: ${c.app || 'unknown'}
- window title: ${c.title || 'unknown'}
- noticed: ${signals.join(', ') || 'nothing special'}${withScreen ? '\n- a small screenshot of their screen is attached' : ''}

Good tips: an error dialog or failed build is on screen and you know the likely fix; they keep switching back and forth between the same two windows and a split view / shortcut would help; a much faster keyboard shortcut for what they're clearly doing. Bad tips: generic advice, "take a break", anything about what you can't actually see, anything private or judgemental.

Reply with ONLY JSON, no prose: {"tip": "one or two short lowercase sentences, plain words"} or {"tip": null}.`;
}

async function askModel(c: TipContext, signals: string[], s: Settings): Promise<string | null> {
  const privacy = (s as unknown as { privacy?: unknown }).privacy;
  const wantScreen = s.tips.screenshot && !privacyBlocksScreens(privacy) && !isPrivateApp(c.app, privacy);
  const image = wantScreen ? await smallScreenshot() : null;
  const { kind, model } = await cheapestModel();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), MODEL_TIMEOUT_MS);
  const t0 = Date.now();
  let out = '';
  try {
    for await (const d of getProvider(kind).stream(
      {
        system: 'You decide whether a short, genuinely useful tip is worth showing. You reply with JSON only.',
        messages: [{ role: 'user', text: tipPrompt(c, signals, !!image), images: image ? [image] : undefined }],
        model,
        signal: ctrl.signal,
        effort: 'low',
      },
      s.providers[kind] ?? {},
    )) {
      out += d;
      if (out.length > 4000) break;
    }
  } finally {
    clearTimeout(t);
    if (image) void fs.rm(image.path, { force: true }).catch(() => undefined);
  }
  const tip = parseTipReply(out);
  decide(`asked ${PROVIDER_META[kind].label} · ${model}${image ? ' (with a small screenshot)' : ''} in ${Date.now() - t0}ms: ${tip ? 'has a tip' : 'no tip'}`);
  return tip;
}

/** Test seam: the model answer comes from here when set (CLICKITY_TEST only). */
let fakeModel: ((c: TipContext) => string | null) | null = null;
/** Test seam: the focused app / title. */
let fakeContext: TipContext | null = null;

async function readContext(): Promise<TipContext> {
  if (fakeContext) return { ...fakeContext };
  const [app, title] = await Promise.all([activeAppName().catch(() => ''), activeWindowTitle().catch(() => '')]);
  return { app, title };
}

async function look(now: number, s: Settings): Promise<void> {
  const c = await readContext();
  const privacy = (s as unknown as { privacy?: unknown }).privacy;
  const a = policy.assess(c, now, privacy);
  if (!a.ask) return decide(`looked (${c.app || 'unknown app'}): skip, ${a.reason}`);
  decide(`looked (${c.app || 'unknown app'}): ${a.signals.join(' + ')} → asking the cheapest model`);
  let tip: string | null = null;
  try {
    tip = fakeModel ? fakeModel(c) : await askModel(c, a.signals, s);
  } catch (err) {
    decide(`model failed: ${(err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 120)}`);
    return;
  }
  // things may have changed while the model thought
  if (!getSettings().tips.enabled || busy()) return decide('dropped the answer: tips off or clickity busy');
  const o = policy.offer(tip, c, Date.now());
  if (!o.offer) return decide(`no tip shown: ${o.reason}`);
  offerTip(tip!, c.app);
}

async function tick(): Promise<void> {
  const s = getSettings();
  if (!s.tips?.enabled || looking) return;
  const now = Date.now();
  if (pending && !pending.open && now - pending.at > policy.opts.pendingMs) closeTip('expired');
  if (pending?.open && now - pending.at > policy.opts.pendingMs + 60_000) closeTip('expired');
  let idleSec = 0;
  try {
    if (!fakeContext) idleSec = powerMonitor.getSystemIdleTime();
  } catch {
    /* unsupported: count as active */
  }
  // where the user is, every ~10 s (cheap): feeds the "back and forth" signal
  if (now - lastFocusAt > FOCUS_MS && idleSec < 30 && !busy()) {
    lastFocusAt = now;
    void readContext().then((c) => policy.noteFocus(c, Date.now())).catch(() => undefined);
  }
  const d = policy.shouldLook(now, { idleSec, busy: busy(), pending: !!pending });
  if (!d.look) {
    // log each reason once, not every few seconds
    if (d.reason !== 'not-yet' && d.reason !== lastNo) decide(`not looking: ${d.reason}`);
    if (d.reason !== 'not-yet') lastNo = d.reason;
    return;
  }
  lastNo = '';
  looking = true;
  try {
    await look(now, s);
  } catch (err) {
    log('tips', 'look failed:', err);
  } finally {
    looking = false;
  }
}

function applyPolicy(s: Settings): void {
  policy.opts.perHour = s.tips.perHour;
}

export function tipsStatusLine(): string {
  const s = getSettings();
  if (!s.tips?.enabled) return 'tips are off';
  const n = policy.offeredLastHour(Date.now());
  const last = [...decisions].reverse().find((x) => !x.what.startsWith('not looking'));
  const ago = last ? Math.max(1, Math.round((Date.now() - last.at) / 60_000)) : 0;
  return `${n} tip${n === 1 ? '' : 's'} in the last hour${last ? ` · last look ${ago} min ago` : ' · first look in about a minute'}`;
}

export function initTips(opts: { busy(): boolean }): void {
  busy = opts.busy;
  applyPolicy(getSettings());
  ipcMain.on(IPC.tipOpen, (_e, id: unknown) => {
    if (pending && id === pending.id) openTip('click');
  });
  ipcMain.on(IPC.tipAction, (_e, a: unknown) => onAction(a));
  ipcMain.handle(IPC.tipsStatusGet, () => tipsStatusLine());
  ipcMain.on(IPC.overlayReady, () => setTimeout(push, 80));
  onSettingsChanged((s, prev) => {
    applyPolicy(s);
    if (s.tips.enabled !== prev.tips?.enabled) {
      log('tips', s.tips.enabled ? `on (max ${s.tips.perHour}/hour${s.tips.screenshot ? ', small screenshots' : ', app + title only'})` : 'off');
      if (!s.tips.enabled) closeTip('tips turned off');
      else policy = new TipsPolicy(Date.now(), { perHour: s.tips.perHour });
    }
    if (pending && (s.tips.key.join('+') !== prev.tips?.key.join('+'))) {
      grab();
      push();
    }
  });
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
}

export function stopTips(): void {
  if (timer) clearInterval(timer);
  timer = null;
  releaseKeys('tip');
}

/** CLICKITY_TEST=1 (test-hook.ts): drive the loop without waiting a minute. */
export function testTips(): Record<string, unknown> {
  return {
    setFake(ctx: TipContext | null, answer: string | null | undefined): void {
      fakeContext = ctx;
      fakeModel = answer === undefined ? null : () => answer;
    },
    /** look right now (skips the interval, keeps every other rule) */
    async lookNow(): Promise<string> {
      policy.lookSoon(Date.now());
      lastNo = '';
      await tick();
      return decisions.at(-1)?.what ?? '';
    },
    open: () => openTip('test'),
    action: (a: string) => onAction(a),
    pending: () => (pending ? { ...pending } : null),
    decisions: () => decisions.map((d) => d.what),
    status: tipsStatusLine,
  };
}
