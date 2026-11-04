// The turn orchestrator: push-to-talk → transcript + screenshots → streamed model reply
// → pointing → speech → back to idle. See ARCHITECTURE.md "How a turn works".
// Every turn (voice, overlay type box, chats window) runs through runTurn() and is recorded
// in the active stored chat (chat-store.ts); the chats window gets live ChatEvents.
import { BrowserWindow, ipcMain, nativeImage, screen, type Point } from 'electron';
import { IPC } from '../shared/ipc';
import {
  PROVIDER_KINDS,
  PROVIDER_META,
  type Chat,
  type ChatAttachment,
  type ChatEvent,
  type ChatMessage,
  type ChatRequest,
  type ChatSendRequest,
  type ChatTurn,
  type ImageInput,
  type OverlayPoint,
  type OverlayState,
  type ProviderKind,
  type PttResult,
  type Settings,
} from '../shared/types';
import { getSettings } from './settings-store';
import { captureScreens, cleanupCaptures, screenshotToGlobal, writeTempImage, type CapturedScreen } from './capture';
import * as store from './chat-store';
import { sendToChats } from './chats-window';
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
import { log } from './log';
import { ensureMicrophoneAccess, microphoneStatus, type MicAccess } from './permissions';

/* ───────────────────────── tuning ───────────────────────── */

const MIN_PRESS_MS = 250;
const ERROR_CLEAR_MS = 7000; // long enough to read "what to do" hints
const STATE_THROTTLE_MS = 40;
const POINT_STEP_MS = 2600;
/** on-device: give up when the overlay reports no progress (model download %, loading…) for this long */
const PTT_IDLE_TIMEOUT_LOCAL_MS = 90_000;
const PTT_TIMEOUT_REMOTE_MS = 20_000;
const REMOTE_STT_TIMEOUT_MS = 45_000;
const TYPE_BOX_HIDE_MS = 90; // let the type box disappear before we screenshot
/** a stored chat idle this long is closed: the next voice / type turn starts a new one */
const CHAT_IDLE_MS = 30 * 60 * 1000;
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_TEXT = 200_000; // chars inlined per text file
const ATTACH_MAX_SIDE = 1568;

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
  /** stored chat this turn is recorded in (set once the turn reaches the model) */
  chatId: string | null;
  /** voice turns: OS microphone check, then whether the overlay was told to record */
  mic?: Promise<MicAccess & { started: boolean }>;
}

let current: Turn | null = null;
let turnSeq = 0;
/** the stored chat voice / type turns continue (null = start a new one lazily) */
let activeChatId: string | null = null;
/** when the active chat was made active (opening an old chat shouldn't instantly expire it) */
let activeSince = 0;
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
  return line.length > 220 ? `${line.slice(0, 217)}…` : line;
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
  log('bubble', `error: ${message}`);
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

export interface PromptOptions {
  /** where the user's message came from; 'window' = typed in the chats window, not read aloud */
  source?: ChatTurn['source'];
  /** names of attached images (sent after the screenshots) */
  imageNames?: string[];
}

/** Clickity persona (heyclicky-style) + pointing protocol + this turn's screen list + custom instructions. */
export function buildSystemPrompt(settings: Settings, screens: CapturedScreen[], opts: PromptOptions = {}): string {
  const fromWindow = opts.source === 'window';
  const screenLines = screens.length
    ? screens
        .map((s) => `- screen ${s.index}${s.isCursorScreen ? ' (the mouse cursor is on this one)' : ''}: "${s.image.label}", ${s.image.width}x${s.image.height} pixels`)
        .join('\n')
    : fromWindow
      ? '- (no screenshots this turn; the user did not share their screen, so do not point)'
      : '- (no screenshots this turn; screen capture is unavailable, so do not point)';
  const attachedLines = opts.imageNames?.length
    ? `\n\nATTACHED IMAGES (sent after the screenshots; you cannot point at these)\n${opts.imageNames.map((n) => `- "${n}"`).join('\n')}`
    : '';
  const channel = fromWindow
    ? `

THIS MESSAGE
The user typed this message in Clickity's chat window instead of speaking. Your reply is shown as text there and is not read aloud, so you can be a little longer when it genuinely helps, and short markdown (a list, a code block) is fine when it makes the answer clearer. Attached text files are included inline in the message.`
    : '';

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

  return `You are Clickity, a friendly little AI companion that lives next to the user's mouse cursor on their ${platformName()} computer. The user holds a key, talks to you, and you can see their screen(s) through the screenshots attached to their latest message.

HOW TO REPLY
- Your reply is read aloud by a voice and shown in a small speech bubble, so keep it short: one to three sentences unless the user asks for more detail.
- Sound like a warm, clever friend looking over their shoulder: conversational, plain words, a little playful, never stiff or salesy.
- No markdown, bullet lists, headings, tables, emoji or code fences unless the user explicitly asks for them. Write numbers and symbols the way you'd say them.
- Answer about what's actually on the screen when that's relevant; be specific ("the blue share button in the top right") instead of generic.
- The user's words come from speech-to-text and may contain mistakes; infer what they meant. If the request is truly unclear, ask one short question.
- Earlier turns in the conversation are text only; only the newest message has screenshots, so trust the current screenshots over memory.
${pointing}${channel}

SCREENS THIS TURN
${screenLines}${attachedLines}${custom ? `\n\nADDITIONAL INSTRUCTIONS FROM THE USER\n${custom}` : ''}`;
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
    chatId: null,
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
  log('turn', `${turn.id} failed:`, err instanceof Error && !(err as { quiet?: boolean }).quiet ? err : message);
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

/* ───────────────────────── stored chats ───────────────────────── */

function emitChat(ev: ChatEvent): void {
  sendToChats(IPC.chatsEvent, ev);
}

function activate(id: string | null): void {
  activeChatId = id;
  activeSince = Date.now();
}

/** The chat voice / type turns continue, or null when there is none (or it went idle). */
export function getActiveChatId(): string | null {
  if (!activeChatId) return null;
  const sum = store.getSummary(activeChatId);
  if (!sum || Date.now() - Math.max(sum.updatedAt, activeSince) > CHAT_IDLE_MS) activeChatId = null;
  return activeChatId;
}

/**
 * The chat a new turn goes into. `explicit` (chats window): the requested chat if it exists,
 * else a new one. Otherwise: the active chat, or a new one.
 */
function resolveChat(requested: string | null, explicit: boolean): string {
  if (explicit) {
    if (requested && store.hasChat(requested)) {
      activate(requested);
      return requested;
    }
  } else {
    const id = getActiveChatId();
    if (id) return id;
  }
  const chat = store.createChat();
  activate(chat.id);
  return chat.id;
}

/** Start an empty chat and make it active (chats window "new chat"). */
export function newChat(): Chat {
  const chat = store.createChat();
  activate(chat.id);
  return chat;
}

/** Make a stored chat the active conversation, so the next voice turn continues it. */
export function openChat(id: string): void {
  if (store.hasChat(id)) activate(id);
}

/** Delete a stored chat; stops a reply streaming into it and forgets it if active. */
export function removeChat(id: string): void {
  if (current?.chatId === id) cancelCurrent();
  if (activeChatId === id) activeChatId = null;
  store.deleteChat(id);
}

/** Abort the reply streaming into `chatId` (chats window stop button). */
export function stopChat(chatId: string): void {
  if (current && current.chatId === chatId) cancelCurrent();
}

/** Last `pairs` completed user → assistant exchanges of a chat, as text-only model context. */
function chatContext(chatId: string, pairs: number): ChatMessage[] {
  if (pairs <= 0) return [];
  const chat = store.getChat(chatId);
  if (!chat) return [];
  const out: ChatMessage[][] = [];
  const turns = chat.turns;
  for (let i = 0; i < turns.length - 1; i++) {
    const u = turns[i];
    const a = turns[i + 1];
    if (u.role !== 'user' || a.role !== 'assistant') continue;
    i++;
    if (a.error || !a.text.trim()) continue; // failed / stopped replies aren't context
    const userText = u.text.trim() || (u.attachments?.length ? `(sent ${u.attachments.join(', ')})` : '');
    if (!userText) continue;
    // Remember where we pointed so follow-ups ("and then?") make sense.
    const pointedNote = a.points?.length ? ` (pointed at: ${a.points.join(', ')})` : '';
    out.push([
      { role: 'user', text: userText },
      { role: 'assistant', text: `${a.text}${pointedNote}`.trim() },
    ]);
  }
  return out.slice(-pairs).flat();
}

/* ───────────────────────── the turn ───────────────────────── */

interface TurnInput {
  source: NonNullable<ChatTurn['source']>;
  /** what the user said / typed: stored in the chat and shown in the bubble */
  userText: string;
  /** sent to the model instead of userText (e.g. with text attachments inlined) */
  modelText?: string;
  screens: CapturedScreen[];
  /** extra images sent after the screenshots (chats window attachments) */
  images?: ImageInput[];
  /** attachment names, stored with the user turn */
  attachments?: string[];
  provider?: ProviderKind;
  model?: string;
  /** read the reply aloud (off for chats-window messages) */
  speak: boolean;
  /** fly to POINT targets (needs screenshots) */
  point: boolean;
}

/** Record the user turn, stream the reply (overlay + chats window), store it, then point and speak. */
async function runTurn(turn: Turn, input: TurnInput): Promise<void> {
  const settings = getSettings();
  const signal = turn.controller.signal;
  const kind = input.provider ?? settings.provider;
  const model = input.model || settings.models[kind] || PROVIDER_META[kind].defaultModel;
  const cfg = settings.providers[kind] ?? {};
  const { screens } = input;
  // Overlay updates only while this turn still owns the companion.
  const show = (state: OverlayState): void => {
    if (isTurnCurrent(turn)) sendState(turn.overlay, state);
  };
  const thinking: OverlayState = { phase: 'thinking', transcript: input.userText || input.attachments?.join(', ') };

  const chatId = turn.chatId ?? resolveChat(null, false);
  turn.chatId = chatId;
  const prior = chatContext(chatId, Math.max(0, settings.historyTurns));
  const userTurn = store.appendTurn(chatId, {
    role: 'user',
    text: input.userText,
    source: input.source,
    screenshots: screens.length,
    attachments: input.attachments?.length ? input.attachments : undefined,
    provider: kind,
    model,
  });
  if (userTurn) emitChat({ type: 'user', chatId, turn: userTurn });
  const assistantId = store.newId();
  emitChat({ type: 'start', chatId, turnId: assistantId });

  let buffer = '';
  let recorded = false;
  /** Store the assistant turn once (done, error or stopped) and tell the chats window. */
  const record = (text: string, points: ParsedPoint[], error?: string): void => {
    if (recorded) return;
    recorded = true;
    const stored = store.appendTurn(chatId, {
      id: assistantId,
      role: 'assistant',
      text,
      points: points.length ? points.map((p) => p.label) : undefined,
      provider: kind,
      model,
      error,
    });
    if (error || !stored) emitChat({ type: 'error', chatId, turnId: assistantId, error: error ?? 'chat was deleted' });
    else emitChat({ type: 'done', chatId, turn: stored });
  };

  try {
    show(thinking);
    const userMsg: ChatMessage = {
      role: 'user',
      text: input.modelText ?? input.userText,
      images: [...screens.map((s) => s.image), ...(input.images ?? [])],
    };
    const req: ChatRequest = {
      system: buildSystemPrompt(settings, screens, { source: input.source, imageNames: input.images?.map((i) => i.label) }),
      messages: [...prior, userMsg],
      model,
      signal,
    };

    // Stream, pushing throttled visible-text updates to the overlay and the chats window.
    let lastSent = '';
    let lastSentAt = 0;
    const pushVisible = (force: boolean): void => {
      const visible = stripForDisplay(buffer);
      if (visible === lastSent) return;
      const now = Date.now();
      if (!force && now - lastSentAt < STATE_THROTTLE_MS) return;
      lastSent = visible;
      lastSentAt = now;
      show(visible ? { phase: 'speaking', reply: visible } : thinking);
      emitChat({ type: 'delta', chatId, turnId: assistantId, text: visible });
    };

    const t0 = Date.now();
    let firstAt = 0;
    log('turn', `${turn.id} ${input.source} → ${kind} / ${model}: ${screens.length} screenshot(s), ${prior.length} context message(s), ${userMsg.text.length} chars`);
    if (!signal.aborted) {
      for await (const delta of getProvider(kind).stream(req, cfg)) {
        if (signal.aborted) break;
        if (!firstAt) firstAt = Date.now();
        buffer += delta;
        pushVisible(false);
      }
    }
    if (signal.aborted) {
      log('turn', `${turn.id} stopped after ${Date.now() - t0}ms`);
      record(stripPointTags(buffer), [], 'stopped');
      return;
    }
    log('turn', `${turn.id} reply from ${kind} / ${model}: first text ${firstAt ? firstAt - t0 : '-'}ms, total ${Date.now() - t0}ms, ${buffer.length} chars`);
    pushVisible(true);

    const reply = stripPointTags(buffer);
    const points = settings.companion.pointing && input.point ? parsePointTags(buffer) : [];
    if (process.env.CLICKY_DEBUG) console.log(`[clicky] raw reply: ${JSON.stringify(buffer)} points: ${JSON.stringify(points)}`);
    if (!reply && points.length === 0) throw new Error('the model returned an empty reply');
    record(reply, points);
    if (!isTurnCurrent(turn)) return;

    show({ phase: 'speaking', reply });

    // Point and speak concurrently.
    const pointing = points.length ? walkPoints(turn, points, screens) : Promise.resolve();
    const spokeAt = Date.now();
    if (input.speak) await speak(turn, reply, settings);
    else await delay(readingTime(reply), signal);
    await pointing.catch(() => undefined);
    // If speech ended early (muted, no system voices, very short clip), keep the companion
    // on its target long enough to actually see where it is pointing.
    if (points.length && isTurnCurrent(turn)) {
      const left = readingTime(reply) - (Date.now() - spokeAt);
      if (left > 0) await delay(left, turn.controller.signal).catch(() => undefined);
    }
    if (!isTurnCurrent(turn)) return;
    log('turn', `${turn.id} done (${points.length} point(s))`);
    endTurn(turn);
  } catch (err) {
    record(stripPointTags(buffer), [], signal.aborted ? 'stopped' : errorMessage(err));
    throw err;
  }
}

/** How long a bubble should stay up to be read when nothing is spoken. */
function readingTime(text: string): number {
  return Math.min(12_000, Math.max(3000, text.length * 55));
}

/* ───────────────────────── chats window turns ───────────────────────── */

interface PreparedAttachments {
  images: ImageInput[];
  /** text files, already fenced, to append to the model text */
  inlined: string[];
  names: string[];
}

/** A fence longer than any backtick run in the content. */
function fenceFor(content: string): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

async function prepareAttachments(list: ChatAttachment[]): Promise<PreparedAttachments> {
  const out: PreparedAttachments = { images: [], inlined: [], names: [] };
  for (const a of list.slice(0, MAX_ATTACHMENTS)) {
    if (!a || typeof a !== 'object') continue;
    const name = String(a.name || 'file').replace(/[\r\n]+/g, ' ').slice(0, 200);
    const mime = String(a.mime || '').toLowerCase();
    const data = Buffer.from(String(a.base64 || ''), 'base64');
    out.names.push(name);

    if (mime.startsWith('image/')) {
      const img = nativeImage.createFromBuffer(data);
      if (img.isEmpty()) throw new Error(`couldn't read the image ${name}`);
      const size = img.getSize();
      const scale = Math.min(1, ATTACH_MAX_SIDE / Math.max(size.width, size.height));
      const passthrough = scale === 1 && (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/jpg');
      const resized = scale < 1 ? img.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale), quality: 'good' }) : img;
      const asPng = mime === 'image/png' || (!passthrough && mime !== 'image/jpeg' && mime !== 'image/jpg');
      const bytes = passthrough ? data : asPng ? resized.toPNG() : resized.toJPEG(85);
      const { width, height } = resized.getSize();
      const file = await writeTempImage(bytes, asPng ? 'png' : 'jpg');
      out.images.push({ mime: asPng ? 'image/png' : 'image/jpeg', base64: bytes.toString('base64'), path: file, label: name, width, height });
      continue;
    }

    // Anything else is treated as text, unless it is clearly binary.
    if (data.subarray(0, 8192).includes(0)) {
      out.inlined.push(`[attached file "${name}" is binary and was not included]`);
      continue;
    }
    let content = data.toString('utf8');
    if (content.length > MAX_ATTACHMENT_TEXT) content = `${content.slice(0, MAX_ATTACHMENT_TEXT)}\n… (truncated)`;
    const fence = fenceFor(content);
    out.inlined.push(`file: ${name}\n${fence}\n${content.replace(/\n$/, '')}\n${fence}`);
  }
  return out;
}

/**
 * A message typed in the chats window: no push-to-talk, optional screenshots and attachments.
 * Shown on the companion as usual but never spoken; it only points when the screen was shared.
 * Resolves once the turn has started; the reply streams as ChatEvents.
 */
export async function sendFromWindow(req: ChatSendRequest): Promise<{ chatId: string }> {
  if (!req || typeof req !== 'object') throw new Error('bad request');
  const text = String(req.text ?? '').trim();
  const prepared = await prepareAttachments(Array.isArray(req.attachments) ? req.attachments : []);
  if (!text && prepared.names.length === 0) throw new Error('nothing to send');
  let provider: ProviderKind | undefined;
  if (req.provider !== undefined && req.provider !== null) {
    if (!PROVIDER_KINDS.includes(req.provider)) throw new Error(`unknown provider: ${String(req.provider)}`);
    provider = req.provider;
  }
  const model = typeof req.model === 'string' && req.model.trim() ? req.model.trim() : undefined;

  closeTyping();
  const chatId = resolveChat(typeof req.chatId === 'string' ? req.chatId : null, true);
  const cursor = screen.getCursorScreenPoint();
  const turn = beginTurn(overlayForPoint(cursor), 'processing');
  turn.chatId = chatId;

  const modelText = [text, ...prepared.inlined].filter(Boolean).join('\n\n');
  void (async () => {
    sendState(turn.overlay, { phase: 'thinking', transcript: text || prepared.names.join(', ') });
    const screens = req.includeScreen ? await safeCapture(cursor) : [];
    // Even if stopped while capturing, runTurn records the message (and a 'stopped' reply).
    await runTurn(turn, {
      source: 'window',
      userText: text,
      modelText,
      screens,
      images: prepared.images,
      attachments: prepared.names,
      provider,
      model,
      speak: false,
      point: !!req.includeScreen,
    });
  })().catch((err) => failTurn(turn, err));
  return { chatId };
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

const isMac = process.platform === 'darwin';
/** peak below this: the OS fed us zeros (permission not honoured, muted / wrong input) */
const SILENT_PEAK = 0.0005;
/** peak below this: there was sound, but very little */
const QUIET_PEAK = 0.02;

/** An error whose message is meant for the bubble as-is (no stack in the log). */
function userError(message: string): Error {
  const e = new Error(message);
  (e as { quiet?: boolean }).quiet = true;
  return e;
}

export function onTalkDown(): void {
  if (current?.stage === 'recording') return; // already listening (e.g. key repeat)
  closeTyping();
  const cursor = screen.getCursorScreenPoint();
  const turn = beginTurn(overlayForPoint(cursor), 'recording');
  const settings = getSettings();
  const micStatus = microphoneStatus();
  log('voice', `talk down: turn ${turn.id}, overlay ${turn.overlay ? 'ok' : 'missing'}, mic permission ${micStatus}, stt ${settings.speech.stt.provider}${settings.speech.stt.provider === 'on-device' ? ` (${settings.speech.stt.model})` : ''}`);
  sendState(turn.overlay, { phase: 'listening' });

  const startRecording = (): boolean => {
    if (!isTurnCurrent(turn) || turn.stage !== 'recording') return false;
    sendToOverlay(turn.overlay, IPC.overlayPttStart);
    return true;
  };

  if (micStatus === 'granted' || micStatus === 'unknown') {
    // hot path: no await between the key and the mic
    const started = startRecording();
    turn.mic = Promise.resolve({ ok: true, prompted: false, status: micStatus, started });
    return;
  }
  // not determined (first run: show the macOS prompt) or blocked
  turn.mic = ensureMicrophoneAccess().then((access) => {
    if (!access.ok) {
      failTurn(turn, userError(access.message ?? 'microphone blocked'));
      return { ...access, started: false };
    }
    return { ...access, started: startRecording() };
  });
}

export function onTalkUp(): void {
  const turn = current;
  if (!turn || turn.stage !== 'recording') return;
  turn.stage = 'processing';
  const held = Date.now() - turn.startedAt;
  log('voice', `talk up: turn ${turn.id}, held ${held}ms`);
  if (held < MIN_PRESS_MS) {
    // Accidental tap: don't send anything, but say how push-to-talk works.
    sendToOverlay(turn.overlay, IPC.overlayPttCancel);
    log('turn', `${turn.id} failed: tap (${held}ms)`);
    endTurn(turn, null);
    showError(turn.overlay, "didn't catch that — hold the keys while you talk");
    return;
  }
  void processVoiceTurn(turn).catch((err) => failTurn(turn, err));
}

/**
 * Wait for the overlay's PttResult. On-device transcription can include a first-use model
 * download, so the deadline slides forward whenever the overlay reports progress.
 */
function waitForPttResult(turn: Turn, win: BrowserWindow, idleMs: number): Promise<PttResult> {
  const signal = turn.controller.signal;
  return new Promise<PttResult>((resolve, reject) => {
    if (win.isDestroyed()) return reject(new Error('overlay closed'));
    if (signal.aborted) return reject(abortError());
    let timer: NodeJS.Timeout;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        cleanup();
        reject(
          userError(
            getSettings().speech.stt.provider === 'on-device'
              ? 'transcription timed out — the voice model may still be downloading; check your connection and try again'
              : 'timed out waiting for the recording — try again',
          ),
        );
      }, idleMs);
    };
    const progress: ProgressWaiter = { senderId: win.webContents.id, onProgress: arm };
    const cleanup = (): void => {
      waiters.delete(waiter);
      progressWaiters.delete(progress);
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const waiter: Waiter = {
      channel: IPC.pttResult,
      senderId: win.webContents.id,
      resolve: (p) => {
        cleanup();
        resolve(p as PttResult);
      },
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    waiters.add(waiter);
    progressWaiters.add(progress);
    signal.addEventListener('abort', onAbort, { once: true });
    arm();
  });
}

interface ProgressWaiter {
  senderId: number;
  onProgress(): void;
}
const progressWaiters = new Set<ProgressWaiter>();
let lastProgressLogged = '';

function onPttProgress(senderId: number, note: unknown): void {
  const text = String(note ?? '').slice(0, 120);
  // log status changes, and download progress in 25% steps
  const pct = /(\d+)%/.exec(text);
  const key = pct ? text.replace(/\d+%/, `${Math.floor(Number(pct[1]) / 25) * 25}%`) : text;
  if (key !== lastProgressLogged) {
    lastProgressLogged = key;
    log('voice', `overlay status: ${text}`);
  }
  for (const w of progressWaiters) if (w.senderId === senderId) w.onProgress();
}

/** What to say when no words came back. */
function emptyTranscriptMessage(result: PttResult): string {
  const peak = result.peak;
  if (peak !== undefined && peak < SILENT_PEAK) {
    return isMac
      ? 'heard only silence — check your mic input in system settings › sound. if it moves there, toggle clickity off and on in privacy & security › microphone'
      : 'heard only silence — check that the right microphone is selected and not muted';
  }
  if (peak !== undefined && peak < QUIET_PEAK) return "didn't catch that — it was very quiet; speak up or move closer to the mic";
  return "didn't catch that — hold the keys while you talk, then let go";
}

async function processVoiceTurn(turn: Turn): Promise<void> {
  const settings = getSettings();
  const signal = turn.controller.signal;
  const overlay = turn.overlay;
  if (!overlay) throw userError('no overlay on this screen — try restarting clickity');

  const mic = await (turn.mic ?? Promise.resolve({ ok: true, prompted: false, status: 'unknown' as const, started: true }));
  if (!isTurnCurrent(turn)) return;
  if (!mic.ok) throw userError(mic.message ?? 'microphone blocked');
  if (!mic.started) {
    // the macOS prompt was answered while the key was held: nothing was recorded yet
    throw userError('microphone allowed — hold the keys and talk again');
  }

  const stt = settings.speech.stt;
  const timeout = stt.provider === 'on-device' ? PTT_IDLE_TIMEOUT_LOCAL_MS : PTT_TIMEOUT_REMOTE_MS;
  const resultP = waitForPttResult(turn, overlay, timeout);
  sendToOverlay(overlay, IPC.overlayPttStop, { stt });
  sendState(overlay, { phase: 'transcribing' });

  // Screens are captured while the audio is being transcribed.
  const capturesP = safeCapture(screen.getCursorScreenPoint());

  const t0 = Date.now();
  const result = await resultP;
  if (!isTurnCurrent(turn)) return;
  log(
    'voice',
    `ptt result: turn ${turn.id}, ${result.durationMs}ms recorded, peak ${result.peak?.toFixed(4) ?? '?'}` +
      (result.error ? `, error (${result.errorKind ?? '?'}): ${result.error}` : '') +
      (result.text !== undefined ? `, on-device${result.sttDevice ? ` ${result.sttDevice}` : ''} ${result.sttMs ?? Date.now() - t0}ms → ${result.text.length} chars` : '') +
      (result.wav ? `, wav ${result.wav.byteLength} bytes` : ''),
  );
  if (result.error) throw userError(result.error);
  if (result.durationMs < MIN_PRESS_MS) throw userError("didn't catch that — hold the keys while you talk");

  let text = result.text?.trim() ?? '';
  if (!text && result.wav && result.wav.byteLength > 44) {
    const t1 = Date.now();
    const timeoutSignal = AbortSignal.any([signal, AbortSignal.timeout(REMOTE_STT_TIMEOUT_MS)]);
    try {
      text = (await transcribe(Buffer.from(result.wav), settings, timeoutSignal)).trim();
    } catch (err) {
      if (signal.aborted) throw err;
      const reason = timeoutSignal.aborted ? `${stt.provider} took too long` : errorMessage(err);
      throw userError(reason.startsWith('transcription') || reason.includes('transcription') ? reason : `transcription failed: ${reason}`);
    }
    log('voice', `stt ${stt.provider}${stt.model ? ` (${stt.model})` : ''}: ${Date.now() - t1}ms → ${text.length} chars`);
  }
  if (!isTurnCurrent(turn)) return;
  if (!text || isNoise(text)) throw userError(emptyTranscriptMessage(result));

  sendState(overlay, { phase: 'thinking', transcript: text });
  const screens = await capturesP;
  if (!isTurnCurrent(turn)) return;
  await runTurn(turn, { source: 'voice', userText: text, screens, speak: true, point: true });
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
  await runTurn(turn, { source: 'type', userText: text, screens, speak: true, point: true });
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

/** Start over (tray "clear conversation", settings): the next turn opens a new stored chat. */
export function clearHistory(): void {
  activeChatId = null;
}

/** Companion says a short line with the current voice settings (settings → "test voice"). */
export async function testSpeak(): Promise<void> {
  const settings = getSettings();
  const cursor = screen.getCursorScreenPoint();
  const turn = beginTurn(overlayForPoint(cursor), 'processing');
  const label = hotkeyLabel(settings.hotkeys.talk, process.platform);
  const line = `hi! i'm clickity, your companion. hold ${label} and ask me anything.`;
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
  // Pick up where we left off if the last chat is recent; otherwise a new one starts lazily.
  const latest = store.listChats()[0];
  if (latest && Date.now() - latest.updatedAt < CHAT_IDLE_MS) {
    activeChatId = latest.id;
    activeSince = latest.updatedAt;
  }
  ipcMain.on(IPC.pttResult, (e, r: PttResult) => resolveWaiters(IPC.pttResult, e.sender.id, r ?? { durationMs: 0 }));
  ipcMain.on(IPC.pttProgress, (e, note: unknown) => onPttProgress(e.sender.id, note));
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
