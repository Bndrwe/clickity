// The turn orchestrator: push-to-talk → transcript + screenshots → streamed model reply
// → pointing → speech → back to idle. See ARCHITECTURE.md "How a turn works".
import { BrowserWindow, ipcMain, screen, type Point } from 'electron';
import { IPC } from '../shared/ipc';
import {
  PROVIDER_META,
  type ChatMessage,
  type ChatRequest,
  type OverlayPoint,
  type OverlayState,
  type PttResult,
  type Settings,
} from '../shared/types';
import { getSettings } from './settings-store';
import { captureScreens, cleanupCaptures, screenshotToGlobal, type CapturedScreen } from './capture';
import { transcribe } from './speech/stt';
import { synthesize } from './speech/tts';
import { getProvider } from './providers/index';
import { hotkeyLabel } from './hotkey';
import {
  broadcastToOverlays,
  overlayDisplay,
  overlayForDisplay,
  overlayForPoint,
  overlayForWebContentsId,
  sendToOverlay,
  setOverlayTyping,
} from './overlay';

/* ───────────────────────── tuning ───────────────────────── */

const MIN_PRESS_MS = 250;
const ERROR_CLEAR_MS = 4000;
const STATE_THROTTLE_MS = 40;
const POINT_STEP_MS = 2600;
const PTT_TIMEOUT_LOCAL_MS = 120_000; // first on-device run may download the whisper model
const PTT_TIMEOUT_REMOTE_MS = 20_000;
const TYPE_BOX_HIDE_MS = 90; // let the type box disappear before we screenshot

/* ───────────────────────── state ───────────────────────── */

interface Turn {
  id: number;
  controller: AbortController;
  /** overlay on the display that was under the cursor when the turn started */
  overlay: BrowserWindow | null;
  startedAt: number;
  stage: 'recording' | 'processing';
  /** overlays we sent a point to, so we can recall the companion */
  pointed: Set<BrowserWindow>;
}

let current: Turn | null = null;
let turnSeq = 0;
let history: ChatMessage[] = [];
/** overlay currently showing the type box */
let typingOverlay: BrowserWindow | null = null;
let errorTimer: NodeJS.Timeout | null = null;
let initialized = false;

/* ───────────────────────── overlay waiters ───────────────────────── */

interface Waiter {
  channel: string;
  senderId: number;
  resolve(payload: unknown): void;
}
const waiters = new Set<Waiter>();

function resolveWaiters(channel: string, senderId: number, payload: unknown): void {
  for (const w of [...waiters]) {
    if (w.channel === channel && w.senderId === senderId) {
      waiters.delete(w);
      w.resolve(payload);
    }
  }
}

/**
 * Wait for `channel` from a specific overlay. Rejects on abort; resolves `onTimeout`
 * (or rejects if undefined) after `timeoutMs`.
 */
function waitForOverlay<T>(
  win: BrowserWindow,
  channel: string,
  signal: AbortSignal,
  timeoutMs: number,
  onTimeout?: T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (win.isDestroyed()) return reject(new Error('overlay closed'));
    if (signal.aborted) return reject(abortError());
    const cleanup = (): void => {
      waiters.delete(waiter);
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const waiter: Waiter = {
      channel,
      senderId: win.webContents.id,
      resolve: (p) => {
        cleanup();
        resolve(p as T);
      },
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      if (onTimeout !== undefined) resolve(onTimeout);
      else reject(new Error('timed out waiting for the overlay'));
    }, timeoutMs);
    waiters.add(waiter);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/* ───────────────────────── helpers ───────────────────────── */

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function sendState(win: BrowserWindow | null | undefined, state: OverlayState): void {
  sendToOverlay(win, IPC.overlayState, state);
}

/** Short, lowercase, single-line error for the bubble. */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'something went wrong');
  const line = raw.split('\n')[0].trim().toLowerCase() || 'something went wrong';
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}

function isTurnCurrent(turn: Turn): boolean {
  return current === turn && !turn.controller.signal.aborted;
}

function clearErrorTimer(): void {
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = null;
}

/** Show an error on an overlay, then return it to idle unless something newer happened. */
function showError(win: BrowserWindow | null, message: string): void {
  clearErrorTimer();
  const seq = turnSeq;
  sendState(win, { phase: 'error', error: message });
  errorTimer = setTimeout(() => {
    errorTimer = null;
    if (seq === turnSeq && !current) sendState(win, { phase: 'idle' });
  }, ERROR_CLEAR_MS);
}

/* ───────────────────────── POINT tags ───────────────────────── */

const POINT_TAG_RE = /\[POINT:[^\]\n]*\]/gi;
/** A tag that has started streaming but isn't closed yet, at the very end of the buffer. */
const PARTIAL_TAG_RE = /\[(?:P(?:O(?:I(?:N(?:T(?::[^\]\n]*)?)?)?)?)?)?$/i;

export interface ParsedPoint {
  x: number;
  y: number;
  label: string;
  /** 1-based screen index, undefined = cursor screen */
  screen?: number;
}

/** Visible text while streaming: complete tags removed, a trailing partial tag hidden. */
export function stripForDisplay(buffer: string): string {
  return buffer.replace(POINT_TAG_RE, '').replace(PARTIAL_TAG_RE, '').replace(/[ \t]+\n/g, '\n').trimEnd();
}

/** Final text: every tag (and any dangling fragment) removed, whitespace tidied. */
export function stripPointTags(text: string): string {
  return text
    .replace(POINT_TAG_RE, '')
    .replace(PARTIAL_TAG_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Parse `[POINT:x,y:label:screenN]` tags. `[POINT:none]` and malformed tags are skipped. */
export function parsePointTags(text: string): ParsedPoint[] {
  const out: ParsedPoint[] = [];
  for (const m of text.matchAll(POINT_TAG_RE)) {
    const inner = m[0].slice('[POINT:'.length, -1).trim();
    if (!inner || /^none$/i.test(inner)) continue;
    const parts = inner.split(':').map((p) => p.trim());
    const coords = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(parts[0]);
    if (!coords) continue;
    let screenIdx: number | undefined;
    const last = parts[parts.length - 1];
    const screenMatch = parts.length > 1 ? /^screen\s*(\d+)$/i.exec(last) : null;
    if (screenMatch) {
      screenIdx = Number(screenMatch[1]);
      parts.pop();
    }
    const label = parts.slice(1).join(':').trim() || 'here';
    out.push({ x: Number(coords[1]), y: Number(coords[2]), label, screen: screenIdx });
  }
  return out;
}

/* ───────────────────────── system prompt ───────────────────────── */

function platformName(): string {
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'win32') return 'Windows';
  return 'Linux';
}

/** Clicky-style persona + pointing protocol + this turn's screen list + custom instructions. */
export function buildSystemPrompt(settings: Settings, screens: CapturedScreen[]): string {
  const screenLines = screens.length
    ? screens
        .map((s) => `- screen ${s.index}${s.isCursorScreen ? ' (the mouse cursor is on this one)' : ''}: "${s.image.label}", ${s.image.width}x${s.image.height} pixels`)
        .join('\n')
    : '- (no screenshots this turn; screen capture is unavailable, so do not point)';

  const pointing = settings.companion.pointing
    ? `
POINTING
You can fly over and point at things on the user's screen. When it would help the user find something (a button, menu, field, icon, setting, link, part of a window), end your reply with a tag:
[POINT:x,y:label:screenN]
- x,y are pixel coordinates in the screenshot image of that screen (origin top-left, using the image sizes listed below). Aim at the center of the element.
- label is 1-4 words naming the thing, e.g. "save button".
- :screenN is the 1-based screen number from the list below. It is optional and defaults to the screen with the cursor.
- You may add several tags in order if the user has to click through steps; the companion visits them one after another.
- If there is nothing useful to point at, write [POINT:none] or no tag at all.
- Tags go at the very end of the reply. They are never shown or spoken, so the sentence before them must make sense on its own. Never mention coordinates or the tag in your words; just say something like "it's right here" or "click this one".
- Only point at things you can actually see in the screenshot. Don't guess.`
    : `
Pointing is turned off: never output [POINT:...] tags.`;

  const custom = settings.customInstructions.trim();

  return `You are Clicky, a friendly little AI companion that lives next to the user's mouse cursor on their ${platformName()} computer. The user holds a key, talks to you, and you can see their screen(s) through the screenshots attached to their latest message.

HOW TO REPLY
- Your reply is read aloud by a voice and shown in a small speech bubble, so keep it short: one to three sentences unless the user asks for more detail.
- Sound like a warm, clever friend looking over their shoulder: conversational, plain words, a little playful, never stiff or salesy.
- No markdown, bullet lists, headings, tables, emoji or code fences unless the user explicitly asks for them. Write numbers and symbols the way you'd say them.
- Answer about what's actually on the screen when that's relevant; be specific ("the blue share button in the top right") instead of generic.
- The user's words come from speech-to-text and may contain mistakes; infer what they meant. If the request is truly unclear, ask one short question.
- Earlier turns in the conversation are text only; only the newest message has screenshots, so trust the current screenshots over memory.
${pointing}

SCREENS THIS TURN
${screenLines}${custom ? `\n\nADDITIONAL INSTRUCTIONS FROM THE USER\n${custom}` : ''}`;
}

/* ───────────────────────── turn lifecycle ───────────────────────── */

function recallPoints(turn: Turn): void {
  for (const win of turn.pointed) sendToOverlay(win, IPC.overlayPoint, null);
  turn.pointed.clear();
}

/** Abort the in-flight turn (recording, thinking or speaking) and tidy its overlay. */
function cancelCurrent(): void {
  const turn = current;
  if (!turn) return;
  current = null;
  turn.controller.abort();
  if (turn.stage === 'recording') sendToOverlay(turn.overlay, IPC.overlayPttCancel);
  sendToOverlay(turn.overlay, IPC.overlayStopSpeaking);
  for (const win of turn.pointed) sendToOverlay(win, IPC.overlayStopSpeaking);
  recallPoints(turn);
  sendState(turn.overlay, { phase: 'idle' });
}

function beginTurn(overlay: BrowserWindow | null, stage: Turn['stage']): Turn {
  cancelCurrent();
  clearErrorTimer();
  const turn: Turn = {
    id: ++turnSeq,
    controller: new AbortController(),
    overlay,
    startedAt: Date.now(),
    stage,
    pointed: new Set(),
  };
  current = turn;
  return turn;
}

function endTurn(turn: Turn, finalState: OverlayState | null = { phase: 'idle' }): void {
  if (current !== turn) return;
  current = null;
  recallPoints(turn);
  if (finalState) sendState(turn.overlay, finalState);
}

function failTurn(turn: Turn, err: unknown): void {
  if (turn.controller.signal.aborted || current !== turn) return; // cancelled: stay quiet
  const message = errorMessage(err);
  console.warn(`[conversation] turn ${turn.id} failed:`, err);
  endTurn(turn, null);
  showError(turn.overlay, message);
}

async function safeCapture(cursor: Point): Promise<CapturedScreen[]> {
  try {
    cleanupCaptures();
    return await captureScreens(cursor);
  } catch (err) {
    console.warn('[conversation] screen capture failed:', err);
    return [];
  }
}

/** Stream the reply, point, speak, and record history. */
async function runTurn(turn: Turn, userText: string, screens: CapturedScreen[]): Promise<void> {
  const settings = getSettings();
  const signal = turn.controller.signal;
  const kind = settings.provider;
  const model = settings.models[kind] || PROVIDER_META[kind].defaultModel;
  const cfg = settings.providers[kind] ?? {};

  sendState(turn.overlay, { phase: 'thinking', transcript: userText });

  const keep = Math.max(0, settings.historyTurns) * 2;
  const prior = keep > 0 ? history.slice(-keep) : [];
  const userMsg: ChatMessage = { role: 'user', text: userText, images: screens.map((s) => s.image) };
  const req: ChatRequest = {
    system: buildSystemPrompt(settings, screens),
    messages: [...prior, userMsg],
    model,
    signal,
  };

  // Stream, pushing throttled visible-text updates to the overlay.
  let buffer = '';
  let lastSent = '';
  let lastSentAt = 0;
  const pushVisible = (force: boolean): void => {
    const visible = stripForDisplay(buffer);
    if (visible === lastSent) return;
    const now = Date.now();
    if (!force && now - lastSentAt < STATE_THROTTLE_MS) return;
    lastSent = visible;
    lastSentAt = now;
    sendState(turn.overlay, visible ? { phase: 'speaking', reply: visible } : { phase: 'thinking', transcript: userText });
  };

  for await (const delta of getProvider(kind).stream(req, cfg)) {
    if (signal.aborted) return;
    buffer += delta;
    pushVisible(false);
  }
  if (!isTurnCurrent(turn)) return;

  const reply = stripPointTags(buffer);
  const points = settings.companion.pointing ? parsePointTags(buffer) : [];
  if (process.env.CLICKY_DEBUG) console.log(`[clicky] raw reply: ${JSON.stringify(buffer)} points: ${JSON.stringify(points)}`);
  if (!reply && points.length === 0) throw new Error('the model returned an empty reply');

  sendState(turn.overlay, { phase: 'speaking', reply });

  // History is text only; remember where we pointed so follow-ups ("and then?") make sense.
  const pointedNote = points.length ? ` (pointed at: ${points.map((p) => p.label).join(', ')})` : '';
  history.push({ role: 'user', text: userText }, { role: 'assistant', text: `${reply}${pointedNote}`.trim() });
  const maxKept = Math.max(0, settings.historyTurns) * 2;
  if (history.length > maxKept) history = maxKept > 0 ? history.slice(-maxKept) : [];

  // Point and speak concurrently.
  const pointing = points.length ? walkPoints(turn, points, screens) : Promise.resolve();
  const spokeAt = Date.now();
  await speak(turn, reply, settings);
  await pointing.catch(() => undefined);
  // If speech ended early (muted, no system voices, very short clip), keep the companion
  // on its target long enough to actually see where it is pointing.
  if (points.length && isTurnCurrent(turn)) {
    const minLinger = Math.min(12_000, Math.max(3000, reply.length * 55));
    const left = minLinger - (Date.now() - spokeAt);
    if (left > 0) await delay(left, turn.controller.signal).catch(() => undefined);
  }
  if (!isTurnCurrent(turn)) return;
  endTurn(turn);
}

/** Resolve a parsed point to an overlay + overlay-local DIP point. */
function resolvePoint(p: ParsedPoint, screens: CapturedScreen[]): { win: BrowserWindow; point: OverlayPoint } | null {
  const target = (p.screen ? screens.find((s) => s.index === p.screen) : undefined) ?? screens.find((s) => s.isCursorScreen) ?? screens[0];
  if (!target) return null;
  const x = Math.min(Math.max(p.x, 0), target.image.width);
  const y = Math.min(Math.max(p.y, 0), target.image.height);
  const global = screenshotToGlobal(target, x, y);
  const win = overlayForDisplay(target.displayId) ?? overlayForPoint(global);
  if (!win) return null;
  const display = overlayDisplay(win);
  const origin = display?.bounds ?? win.getBounds();
  return { win, point: { x: global.x - origin.x, y: global.y - origin.y, label: p.label } };
}

/** Fly to each point in turn, spaced out while the reply is spoken. */
async function walkPoints(turn: Turn, points: ParsedPoint[], screens: CapturedScreen[]): Promise<void> {
  const signal = turn.controller.signal;
  let prev: BrowserWindow | null = null;
  for (let i = 0; i < points.length; i++) {
    if (!isTurnCurrent(turn)) return;
    const resolved = resolvePoint(points[i], screens);
    if (!resolved) continue;
    // Moving to another display: send the companion home on the previous one.
    if (prev && prev !== resolved.win) {
      sendToOverlay(prev, IPC.overlayPoint, null);
      turn.pointed.delete(prev);
    }
    sendToOverlay(resolved.win, IPC.overlayPoint, resolved.point);
    turn.pointed.add(resolved.win);
    prev = resolved.win;
    if (i < points.length - 1) await delay(POINT_STEP_MS, signal);
  }
}

/** Rough upper bound for how long speaking `text` should take. */
function speechTimeout(text: string, rate: number): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  const seconds = words / (2.6 * Math.max(0.5, rate || 1)) + 8;
  return Math.min(180_000, Math.round(seconds * 1000));
}

/** Synthesize and play the reply on the turn's overlay; without TTS, linger long enough to read. */
async function speak(turn: Turn, text: string, settings: Settings): Promise<void> {
  const signal = turn.controller.signal;
  if (!text || !turn.overlay) return;
  let cmd: Awaited<ReturnType<typeof synthesize>> = null;
  try {
    cmd = await synthesize(text, settings, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    // A broken voice shouldn't lose the answer: keep the bubble up and mention it in the log.
    console.warn('[conversation] tts failed:', err);
  }
  if (!isTurnCurrent(turn)) return;
  if (!cmd) {
    const readMs = Math.min(12_000, Math.max(3000, text.length * 55));
    await delay(readMs, signal);
    return;
  }
  const done = waitForOverlay<void>(turn.overlay, IPC.speechDone, signal, speechTimeout(text, settings.speech.tts.rate));
  sendToOverlay(turn.overlay, IPC.overlaySpeak, cmd);
  await done.catch((err: unknown) => {
    if (signal.aborted) throw err;
    // timed out: stop whatever is still playing and move on
    sendToOverlay(turn.overlay, IPC.overlayStopSpeaking);
  });
}

/* ───────────────────────── voice turn ───────────────────────── */

export function onTalkDown(): void {
  if (current?.stage === 'recording') return; // already listening (e.g. key repeat)
  closeTyping();
  const cursor = screen.getCursorScreenPoint();
  const turn = beginTurn(overlayForPoint(cursor), 'recording');
  sendToOverlay(turn.overlay, IPC.overlayPttStart);
  sendState(turn.overlay, { phase: 'listening' });
}

export function onTalkUp(): void {
  const turn = current;
  if (!turn || turn.stage !== 'recording') return;
  turn.stage = 'processing';
  const held = Date.now() - turn.startedAt;
  if (held < MIN_PRESS_MS) {
    // Accidental tap: discard quietly.
    sendToOverlay(turn.overlay, IPC.overlayPttCancel);
    endTurn(turn);
    return;
  }
  void processVoiceTurn(turn).catch((err) => failTurn(turn, err));
}

async function processVoiceTurn(turn: Turn): Promise<void> {
  const settings = getSettings();
  const signal = turn.controller.signal;
  const overlay = turn.overlay;
  if (!overlay) throw new Error('no overlay on this screen');

  const stt = settings.speech.stt;
  const timeout = stt.provider === 'on-device' ? PTT_TIMEOUT_LOCAL_MS : PTT_TIMEOUT_REMOTE_MS;
  const resultP = waitForOverlay<PttResult>(overlay, IPC.pttResult, signal, timeout);
  sendToOverlay(overlay, IPC.overlayPttStop, { stt });
  sendState(overlay, { phase: 'transcribing' });

  // Screens are captured while the audio is being transcribed.
  const capturesP = safeCapture(screen.getCursorScreenPoint());

  const result = await resultP;
  if (!isTurnCurrent(turn)) return;
  if (result.error) throw new Error(result.error);
  if (result.durationMs < MIN_PRESS_MS) return endTurn(turn);

  let text = result.text?.trim() ?? '';
  if (!text && result.wav && result.wav.byteLength > 44) {
    text = (await transcribe(Buffer.from(result.wav), settings, signal)).trim();
  }
  if (!isTurnCurrent(turn)) return;
  if (!text || isNoise(text)) throw new Error("didn't catch that — try again");

  sendState(overlay, { phase: 'thinking', transcript: text });
  const screens = await capturesP;
  if (!isTurnCurrent(turn)) return;
  await runTurn(turn, text, screens);
}

/** Whisper hallucinations on silence, e.g. "[BLANK_AUDIO]", "(music)", "you". */
function isNoise(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (/^[[(].*[\])]$/.test(t)) return true;
  return /^(you|thank you\.?|thanks for watching!?|\.+)$/.test(t);
}

/* ───────────────────────── typed turn ───────────────────────── */

export function onType(): void {
  cancelCurrent();
  clearErrorTimer();
  const cursor = screen.getCursorScreenPoint();
  const win = overlayForPoint(cursor);
  if (!win) return;
  if (typingOverlay && typingOverlay !== win) closeTyping();
  typingOverlay = win;
  setOverlayTyping(win, true);
  sendToOverlay(win, IPC.overlayTextInput, true);
}

function closeTyping(): void {
  const win = typingOverlay;
  if (!win) return;
  typingOverlay = null;
  sendToOverlay(win, IPC.overlayTextInput, false);
  setOverlayTyping(win, false);
}

async function processTypedTurn(turn: Turn, text: string): Promise<void> {
  await delay(TYPE_BOX_HIDE_MS, turn.controller.signal);
  sendState(turn.overlay, { phase: 'thinking', transcript: text });
  const screens = await safeCapture(screen.getCursorScreenPoint());
  if (!isTurnCurrent(turn)) return;
  await runTurn(turn, text, screens);
}

function onTextSubmit(senderId: number, text: string): void {
  const win = overlayForWebContentsId(senderId);
  if (!win) return;
  if (typingOverlay === win) closeTyping();
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return;
  const turn = beginTurn(win, 'processing');
  void processTypedTurn(turn, trimmed).catch((err) => failTurn(turn, err));
}

/* ───────────────────────── escape / misc ───────────────────────── */

export function onEscape(): void {
  closeTyping();
  cancelCurrent();
  clearErrorTimer();
}

/** Forget the conversation (tray "clear conversation", settings). */
export function clearHistory(): void {
  history = [];
}

/** Companion says a short line with the current voice settings (settings → "test voice"). */
export async function testSpeak(): Promise<void> {
  const settings = getSettings();
  const cursor = screen.getCursorScreenPoint();
  const turn = beginTurn(overlayForPoint(cursor), 'processing');
  const label = hotkeyLabel(settings.hotkeys.talk, process.platform);
  const line = `hi! i'm your clicky companion. hold ${label} and ask me anything.`;
  try {
    if (settings.speech.tts.provider === 'off') {
      sendState(turn.overlay, { phase: 'speaking', reply: 'voice is off — turn it on to hear me.' });
      await delay(3000, turn.controller.signal);
    } else {
      sendState(turn.overlay, { phase: 'speaking', reply: line });
      await speak(turn, line, settings);
    }
    if (isTurnCurrent(turn)) endTurn(turn);
  } catch (err) {
    failTurn(turn, err);
  }
}

/** Register the overlay → main IPC listeners. Call once after app ready. */
export function initConversation(): void {
  if (initialized) return;
  initialized = true;
  ipcMain.on(IPC.pttResult, (e, r: PttResult) => resolveWaiters(IPC.pttResult, e.sender.id, r ?? { durationMs: 0 }));
  ipcMain.on(IPC.speechDone, (e) => resolveWaiters(IPC.speechDone, e.sender.id, undefined));
  ipcMain.on(IPC.textSubmit, (e, text: string) => onTextSubmit(e.sender.id, text));
  ipcMain.on(IPC.textCancel, (e) => {
    if (typingOverlay && typingOverlay.webContents.id === e.sender.id) closeTyping();
  });
}

/** Cancel everything and drop temp files (app quit / pause). */
export function shutdownConversation(): void {
  onEscape();
  broadcastToOverlays(IPC.overlayPoint, null);
  try {
    cleanupCaptures();
  } catch {
    /* ignore */
  }
}
