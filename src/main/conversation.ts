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
  type InputAction,
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
import { hotkeyLabel, setAgentKeysSuspended, setConfirmKeys } from './hotkey';
import { describeAction, parseActionTags, stripActionTags, summarizeActions, type ParsedAction } from './action-tags';
import { agentInputStatus, performActions } from './agent-input';
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
  /** what started it: the global escape key leaves chats-window turns alone (they have a stop button) */
  kind: 'voice' | 'type' | 'window' | 'test';
  /** overlays we sent a point to, so we can recall the companion */
  pointed: Set<BrowserWindow>;
  /** stored chat this turn is recorded in (set once the turn reaches the model) */
  chatId: string | null;
  /** voice turns: OS microphone check, then whether the overlay was told to record */
  mic?: Promise<MicAccess & { started: boolean }>;
  /** set once the turn runs agent-mode actions (esc then stops it even from the chats window) */
  agent?: AgentState;
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
      win.removeListener('closed', onClosed);
    };
    // display unplugged / overlays rebuilt mid-turn: fail now instead of at the timeout
    const onClosed = (): void => {
      cleanup();
      reject(new Error('overlay closed'));
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
    win.once('closed', onClosed);
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

// Tag parsing is pure and lives in point-tags.ts (unit tested).
import { parsePointTags, pickPointScreen, stripForDisplay, stripPointTags, type ParsedPoint } from './point-tags';
export { parsePointTags, stripForDisplay, stripPointTags, type ParsedPoint };

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

/** The agent-mode section of the system prompt ('' when actions are off). */
function agentPrompt(settings: Settings, screens: CapturedScreen[]): string {
  const mode = settings.companion.actions;
  if (mode === 'off') return '';
  if (!screens.length) {
    return `

DOING THINGS ON SCREEN
You can sometimes click and type for the user, but not this turn: you can't see their screen. If they ask you to do something on screen, say you need to see it (they can share the screen) and output no action tags.`;
  }
  const mod = process.platform === 'darwin' ? 'cmd' : 'ctrl';
  const approval =
    mode === 'ask'
      ? 'Before anything happens the user sees a short summary of your actions and approves it with enter (esc cancels).'
      : 'Your actions run right away, without asking the user first, so be careful.';
  return `

DOING THINGS ON SCREEN (agent mode)
When the user asks you to DO something on their computer ("click next", "type my address in there", "clickity, do…", "save this", "scroll down", "agent: …"), you can operate the mouse and keyboard for them. Only act when they asked for something to be done; for questions, explanations or "where is…", just answer (and point) without action tags.
To act, write ONE short sentence saying what you're about to do ("i'll click save for you."), then end the reply with action tags, in order:
[CLICK:x,y:label:screenN] - left click. x,y are pixel coordinates in that screen's screenshot, exactly like POINT. Aim at the center of the element. label is 1-4 words naming it.
[DOUBLECLICK:x,y:label:screenN] - double click.
[RIGHTCLICK:x,y:label:screenN] - right click.
[TYPE:text] - type text into whatever has keyboard focus (click the field first if it isn't focused). Write a literal ] as \\] and a backslash as \\\\. For a new line or to submit, use [KEY:enter].
[KEY:${mod}+s] / [KEY:enter] / [KEY:tab] / [KEY:esc] / [KEY:${mod}+shift+t] - press one key or shortcut. Use plain key names joined with +: ${process.platform === 'darwin' ? 'cmd, ctrl, option, shift' : 'ctrl, alt, shift, win'}, letters, digits, enter, tab, esc, space, backspace, delete, up, down, left, right, home, end, pageup, pagedown, f1-f12.
[SCROLL:x,y:down 5:screenN] - scroll with the mouse over x,y (up / down / left / right, then how many lines).
[WAIT:500] - wait that many milliseconds (e.g. for a menu or page to open).
[DONE] - the whole task is finished. Put it at the end of your final reply (that reply may still contain last actions).
:screenN is optional and defaults to the screen with the cursor, like POINT.
How it works: after your actions run, you automatically get a fresh screenshot ("done. here is the screen now…"). Look at it, check that the last step worked, then continue with the next few actions, or reply [DONE] with one short sentence about what you did. You get at most ${settings.companion.maxSteps} rounds of actions per request.
Rules:
- Prefer few, precise steps. Usually do one to three actions per round, and stop to look whenever the screen will change (a click that opens a menu, dialog or page). Never guess at things you can't see yet.
- Only click things you can actually see in the current screenshot.
- Never do anything destructive or irreversible (deleting, sending messages or email, posting, publishing, purchasing, paying, submitting forms, closing unsaved work, changing account or security settings) unless the user explicitly asked for exactly that in this conversation. If a step would do that and they didn't ask, stop and ask instead.
- Never type passwords, card numbers or other secrets unless the user dictated them in this conversation.
- If something unexpected happens (an error, a login wall, a captcha, the wrong window), stop and tell the user in one sentence, with [DONE].
- ${approval}
- Never mention the tags or coordinates in your words; the tags are never shown or spoken.`;
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
  const agent = agentPrompt(settings, screens);

  return `You are Clickity, a friendly little AI companion that lives next to the user's mouse cursor on their ${platformName()} computer. The user holds a key, talks to you, and you can see their screen(s) through the screenshots attached to their latest message.

HOW TO REPLY
- Your reply is read aloud by a voice and shown in a small speech bubble, so keep it short: one to three sentences unless the user asks for more detail.
- Sound like a warm, clever friend looking over their shoulder: conversational, plain words, a little playful, never stiff or salesy.
- No markdown, bullet lists, headings, tables, emoji or code fences unless the user explicitly asks for them. Write numbers and symbols the way you'd say them.
- Answer about what's actually on the screen when that's relevant; be specific ("the blue share button in the top right") instead of generic.
- The user's words come from speech-to-text and may contain mistakes; infer what they meant. If the request is truly unclear, ask one short question.
- Earlier turns in the conversation are text only; only the newest message has screenshots, so trust the current screenshots over memory.
${pointing}${agent}${channel}

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

function beginTurn(overlay: BrowserWindow | null, stage: Turn['stage'], kind: Turn['kind']): Turn {
  cancelCurrent();
  clearErrorTimer();
  const turn: Turn = {
    id: ++turnSeq,
    controller: new AbortController(),
    overlay,
    startedAt: Date.now(),
    stage,
    kind,
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
    if (u.role !== 'user' || turns[i + 1].role !== 'assistant') continue;
    // an agent run stores one assistant turn per step: read them as one reply
    const replies: ChatTurn[] = [];
    while (i + 1 < turns.length && turns[i + 1].role === 'assistant') replies.push(turns[++i]);
    const parts: string[] = [];
    for (const a of replies) {
      if (!a.text.trim() && !a.actions?.length) continue;
      if (a.error && !a.actions?.length) {
        if (a.error.startsWith('not done')) parts.push(`${a.text.trim()} (${a.error})`.trim());
        continue; // failed / stopped replies aren't context
      }
      // Remember where we pointed / what we did so follow-ups ("and then?") make sense.
      const pointedNote = a.points?.length ? ` (pointed at: ${a.points.join(', ')})` : '';
      const didNote = a.actions?.length ? ` (did: ${a.actions.join(', ')})` : '';
      parts.push(`${a.text}${pointedNote}${didNote}`.trim());
    }
    if (!parts.length) continue;
    const userText = u.text.trim() || (u.attachments?.length ? `(sent ${u.attachments.join(', ')})` : '');
    if (!userText) continue;
    out.push([
      { role: 'user', text: userText },
      { role: 'assistant', text: parts.join('\n') },
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

/** Record the user turn, stream the reply (overlay + chats window), store it, then point and speak.
 * In agent mode a reply with action tags runs the act → look → continue loop (runAgent). */
async function runTurn(turn: Turn, input: TurnInput): Promise<void> {
  const settings = getSettings();
  const kind = input.provider ?? settings.provider;
  const model = input.model || settings.models[kind] || PROVIDER_META[kind].defaultModel;
  const cfg = settings.providers[kind] ?? {};
  const { screens } = input;

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

  const ctx: ModelCtx = { settings, kind, model, cfg, chatId, input };
  const userMsg: ChatMessage = {
    role: 'user',
    text: input.modelText ?? input.userText,
    images: [...screens.map((s) => s.image), ...(input.images ?? [])],
  };
  const res = await askModel(turn, ctx, [...prior, userMsg], screens, {
    thinking: { phase: 'thinking', transcript: input.userText || input.attachments?.join(', ') },
    imageNames: input.images?.map((i) => i.label),
  });
  if (!res || !isTurnCurrent(turn)) return;

  if (agentEnabled(settings, input, screens) && res.actions.length) {
    await runAgent(turn, ctx, { history: prior, userMsg, screens, first: res });
    return;
  }
  await finishReply(turn, input, settings, res.reply, res.points, screens);
}

/* ───────────────────────── one model call ───────────────────────── */

interface ModelCtx {
  settings: Settings;
  kind: ProviderKind;
  model: string;
  cfg: Settings['providers'][ProviderKind];
  chatId: string;
  input: TurnInput;
}

interface ModelReply {
  assistantId: string;
  /** the raw reply, tags included (agent-mode context for the next round) */
  raw: string;
  /** visible / spoken text */
  reply: string;
  points: ParsedPoint[];
  actions: ParsedAction[];
  done: boolean;
}

/** Visible text: POINT and action tags removed (a trailing partial tag hidden while streaming). */
function visibleText(buffer: string, streaming: boolean): string {
  const noActions = stripActionTags(buffer, streaming);
  return streaming ? stripForDisplay(noActions) : stripPointTags(noActions);
}

/**
 * Stream one assistant reply into a new stored assistant turn (overlay + chats window updates).
 * Returns null when the turn was stopped (a 'stopped' turn is recorded); throws on errors
 * (an error turn is recorded).
 */
async function askModel(
  turn: Turn,
  ctx: ModelCtx,
  messages: ChatMessage[],
  screens: CapturedScreen[],
  opts: { thinking: OverlayState; step?: string; imageNames?: string[] },
): Promise<ModelReply | null> {
  const { settings, kind, model, cfg, chatId, input } = ctx;
  const signal = turn.controller.signal;
  const show = (state: OverlayState): void => {
    if (isTurnCurrent(turn)) sendState(turn.overlay, state);
  };
  const assistantId = store.newId();
  emitChat({ type: 'start', chatId, turnId: assistantId });

  let buffer = '';
  let recorded = false;
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
    show(opts.thinking);
    const req: ChatRequest = {
      system: buildSystemPrompt(settings, screens, { source: input.source, imageNames: opts.imageNames }),
      messages,
      model,
      signal,
    };

    // Stream, pushing throttled visible-text updates to the overlay and the chats window.
    let lastSent = '';
    let lastSentAt = 0;
    const pushVisible = (force: boolean): void => {
      const visible = visibleText(buffer, true);
      if (visible === lastSent) return;
      const now = Date.now();
      if (!force && now - lastSentAt < STATE_THROTTLE_MS) return;
      lastSent = visible;
      lastSentAt = now;
      show(visible ? { phase: 'speaking', reply: visible, step: opts.step } : opts.thinking);
      emitChat({ type: 'delta', chatId, turnId: assistantId, text: visible });
    };

    const t0 = Date.now();
    let firstAt = 0;
    const last = messages[messages.length - 1];
    log('turn', `${turn.id} ${input.source}${opts.step ? ` (agent, after ${opts.step})` : ''} → ${kind} / ${model}: ${screens.length} screenshot(s), ${messages.length - 1} context message(s), ${last?.text.length ?? 0} chars`);
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
      record(visibleText(buffer, false), [], 'stopped');
      return null;
    }
    log('turn', `${turn.id} reply from ${kind} / ${model}: first text ${firstAt ? firstAt - t0 : '-'}ms, total ${Date.now() - t0}ms, ${buffer.length} chars`);
    pushVisible(true);

    const reply = visibleText(buffer, false);
    const points = settings.companion.pointing && input.point ? parsePointTags(buffer) : [];
    const agentOn = agentEnabled(settings, input, screens);
    const parsed = agentOn ? parseActionTags(buffer) : { actions: [], done: false };
    if (process.env.CLICKY_DEBUG) console.log(`[clicky] raw reply: ${JSON.stringify(buffer)} points: ${JSON.stringify(points)} actions: ${JSON.stringify(parsed)}`);
    if (agentOn && (parsed.actions.length || parsed.done)) log('agent', `${turn.id} reply: ${parsed.actions.length} action(s)${parsed.done ? ' + done' : ''}: ${JSON.stringify(parsed.actions).slice(0, 600)}`);
    if (!reply && points.length === 0 && parsed.actions.length === 0 && !parsed.done) throw new Error('the model returned an empty reply');
    record(reply, points);
    return { assistantId, raw: buffer, reply, points, actions: parsed.actions, done: parsed.done };
  } catch (err) {
    record(visibleText(buffer, false), [], signal.aborted ? 'stopped' : errorMessage(err));
    throw err;
  }
}

/** Point and speak a final reply (or let it be read), then return to idle. */
async function finishReply(turn: Turn, input: TurnInput, settings: Settings, reply: string, points: ParsedPoint[], screens: CapturedScreen[], step?: string): Promise<void> {
  if (!isTurnCurrent(turn)) return;
  const signal = turn.controller.signal;
  sendState(turn.overlay, { phase: 'speaking', reply, step });

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
    if (left > 0) await delay(left, signal).catch(() => undefined);
  }
  if (!isTurnCurrent(turn)) return;
  log('turn', `${turn.id} done (${points.length} point(s))`);
  endTurn(turn);
}

/* ───────────────────────── agent mode ───────────────────────── */

/** fly to a click target, then click (the overlay's acting flight is ~300ms) */
const ACT_FLY_MS = 380;
/** let the UI react before taking the next screenshot */
const ACT_SETTLE_MS = 700;
const CONFIRM_TIMEOUT_MS = 60_000;
const AGENT_FOLLOW_UP = 'done. here is the screen now. continue, or reply [DONE].';

type ConfirmOutcome = 'allowed' | 'cancelled' | 'timeout';

interface PendingConfirm {
  /** assistant turn whose actions wait for approval */
  turnId: string;
  settle(outcome: ConfirmOutcome): void;
}

interface AgentState {
  confirm: PendingConfirm | null;
}

/** Agent mode applies to this turn: actions on, the turn may point (voice / type / shared screen), and we can see. */
function agentEnabled(settings: Settings, input: TurnInput, screens: CapturedScreen[]): boolean {
  return settings.companion.actions !== 'off' && input.point && screens.length > 0;
}

function agentMaxSteps(settings: Settings): number {
  const n = Math.round(Number(settings.companion.maxSteps));
  return Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : 8;
}

/** Where a click / scroll lands: global DIP for input.ts, plus the overlay + local point for the flight. */
interface ResolvedTarget {
  global: Point;
  win: BrowserWindow | null;
  local: OverlayPoint | null;
}

function resolveTarget(a: { x: number; y: number; screen?: number; label: string }, screens: CapturedScreen[]): ResolvedTarget | null {
  const target = pickPointScreen({ x: a.x, y: a.y, label: a.label, screen: a.screen }, screens);
  if (!target) return null;
  const x = Math.min(Math.max(a.x, 0), target.image.width - 1);
  const y = Math.min(Math.max(a.y, 0), target.image.height - 1);
  const g = screenshotToGlobal(target, x, y);
  const global = { x: Math.round(g.x), y: Math.round(g.y) };
  const win = overlayForDisplay(target.displayId) ?? overlayForPoint(global);
  if (!win) return { global, win: null, local: null };
  const origin = overlayDisplay(win)?.bounds ?? win.getBounds();
  return { global, win, local: { x: global.x - origin.x, y: global.y - origin.y, label: a.label } };
}

interface PlannedAction {
  parsed: ParsedAction;
  input: InputAction;
  target: ResolvedTarget | null;
}

/** Screenshot pixels → global coordinates. Throws a bubble-ready error for a screen we didn't send. */
export function planActions(actions: ParsedAction[], screens: CapturedScreen[]): PlannedAction[] {
  return actions.map((a): PlannedAction => {
    switch (a.type) {
      case 'click':
      case 'scroll': {
        const t = resolveTarget(a, screens);
        if (!t) throw userError(`couldn't find screen ${a.screen ?? '?'} to ${a.type} on — stopped`);
        const input: InputAction =
          a.type === 'click'
            ? { type: 'click', x: t.global.x, y: t.global.y, button: a.button, count: a.count, label: a.label }
            : { type: 'scroll', x: t.global.x, y: t.global.y, dy: a.dy, dx: a.dx };
        return { parsed: a, input, target: t };
      }
      case 'type':
        return { parsed: a, input: { type: 'type', text: a.text }, target: null };
      case 'key':
        return { parsed: a, input: { type: 'key', keys: a.keys }, target: null };
      case 'wait':
        return { parsed: a, input: { type: 'wait', ms: a.ms }, target: null };
    }
  });
}

/** "agent mode needs accessibility — settings › permissions" */
function inputProblem(detail: string): string {
  const d = (detail.trim().toLowerCase() || 'is unavailable here').replace(/^agent mode\s+/, '');
  const where = /accessib|permission/.test(d) ? ' — settings › permissions' : '';
  return `agent mode ${/^(needs|is|can|requires|has|isn't)\b/.test(d) ? d : `can't act: ${d}`}${where}`;
}

/** Keys while an agent run owns the companion: enter approves (only while asking), esc stops. */
function grabAgentKeys(turn: Turn, confirming: boolean): void {
  if (!isTurnCurrent(turn)) return setConfirmKeys(null);
  setConfirmKeys(confirming ? { onEnter, onEscape } : { onEscape });
}

/** Show what's about to happen and wait for enter / the chats window's allow (esc / deny / 60s = no). */
function confirmActions(turn: Turn, ctx: ModelCtx, res: ModelReply, summary: string, step: string | undefined): Promise<ConfirmOutcome> {
  const signal = turn.controller.signal;
  const agent = (turn.agent ??= { confirm: null });
  return new Promise<ConfirmOutcome>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    let settled = false;
    const finish = (outcome: ConfirmOutcome | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (agent.confirm === pending) agent.confirm = null;
      grabAgentKeys(turn, false);
      emitChat({ type: 'confirm', chatId: ctx.chatId, turnId: res.assistantId, summary, pending: false, outcome: outcome ?? 'cancelled' });
      log('agent', `${turn.id} confirmation: ${outcome ?? 'aborted'}`);
      if (outcome) resolve(outcome);
      else reject(abortError());
    };
    const pending: PendingConfirm = { turnId: res.assistantId, settle: (o) => finish(o) };
    const onAbort = (): void => finish(null);
    const timer = setTimeout(() => finish('timeout'), CONFIRM_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    agent.confirm = pending;
    grabAgentKeys(turn, true);
    sendState(turn.overlay, { phase: 'speaking', reply: res.reply, confirm: summary, step });
    emitChat({ type: 'confirm', chatId: ctx.chatId, turnId: res.assistantId, summary, pending: true });
    log('agent', `${turn.id} asking: ${summary}`);
  });
}

/** Fly to each target, click / type / press, one action at a time. */
async function performPlanned(turn: Turn, planned: PlannedAction[], step: string, reply: string): Promise<void> {
  const signal = turn.controller.signal;
  closeTyping(); // the type box is the only part of an overlay that takes clicks
  let prev: BrowserWindow | null = null;
  for (const p of planned) {
    if (!isTurnCurrent(turn)) throw abortError();
    const t = p.target;
    if (t?.win && t.local) {
      if (prev && prev !== t.win) {
        sendToOverlay(prev, IPC.overlayPoint, null);
        turn.pointed.delete(prev);
      }
      sendState(t.win, { phase: 'acting', reply: t.win === turn.overlay ? reply : undefined, step });
      sendToOverlay(t.win, IPC.overlayPoint, t.local);
      turn.pointed.add(t.win);
      prev = t.win;
      await delay(ACT_FLY_MS, signal);
      if (p.input.type === 'click') sendToOverlay(t.win, IPC.overlayClick, t.local);
    }
    const keyboard = p.input.type === 'type' || p.input.type === 'key';
    // our own synthetic keys must not reach the chord engine / the esc grab (an [KEY:esc] would stop us)
    if (keyboard) {
      setConfirmKeys(null);
      setAgentKeysSuspended(true);
    }
    try {
      await performActions([p.input], signal);
    } finally {
      if (keyboard) {
        setAgentKeysSuspended(false);
        grabAgentKeys(turn, false);
      }
    }
  }
}

/**
 * The act → look → continue loop. `first` is the reply that asked for actions; each round asks
 * (in 'ask' mode), acts, waits for the UI, takes fresh screenshots and lets the model continue,
 * until [DONE], a reply without actions, esc / stop, an error, or max steps.
 */
async function runAgent(
  turn: Turn,
  ctx: ModelCtx,
  start: { history: ChatMessage[]; userMsg: ChatMessage; screens: CapturedScreen[]; first: ModelReply },
): Promise<void> {
  const { settings, input, chatId } = ctx;
  const signal = turn.controller.signal;
  const maxSteps = agentMaxSteps(settings);
  let history = start.history;
  let userMsg = start.userMsg;
  let screens = start.screens;
  let res = start.first;
  let steps = 0;
  let speech: Promise<void> = Promise.resolve();
  let lastTurnId = res.assistantId;
  turn.agent ??= { confirm: null };
  log('agent', `${turn.id} agent run (${settings.companion.actions}, max ${maxSteps} steps)`);

  const status = await agentInputStatus();
  if (!status.ok) {
    store.updateTurn(chatId, res.assistantId, { error: 'not done: agent mode is unavailable' });
    throw userError(inputProblem(status.detail));
  }
  if (!isTurnCurrent(turn)) return;

  /** Final words. `spoken`: the text was already said as the step's plan, so just let it be read. */
  const end = async (text: string, step?: string, spoken = false): Promise<void> => {
    await speech;
    emitChat({ type: 'acting', chatId, turnId: lastTurnId, step: null });
    setConfirmKeys(null);
    if (!spoken || !input.speak) return finishReply(turn, input, settings, text, [], screens, step);
    if (!isTurnCurrent(turn)) return;
    sendState(turn.overlay, { phase: 'speaking', reply: text, step });
    await delay(1500, signal);
    if (!isTurnCurrent(turn)) return;
    log('turn', `${turn.id} done (agent, ${steps} step(s))`);
    endTurn(turn);
  };

  try {
    grabAgentKeys(turn, false);
    for (;;) {
      if (!isTurnCurrent(turn)) return;
      lastTurnId = res.assistantId;
      if (!res.actions.length) {
        // finished: "[DONE] saved it" or just an answer
        await end(res.reply || 'done.', steps ? `${steps} step${steps === 1 ? '' : 's'}` : undefined);
        return;
      }
      const planned = planActions(res.actions, screens);
      const summary = summarizeActions(res.actions);
      const nextStep = `step ${steps + 1} of ${maxSteps}`;

      // say the one-line plan while waiting for approval / acting
      await speech;
      speech = input.speak && res.reply ? speak(turn, res.reply, settings).catch(() => undefined) : Promise.resolve();

      if (settings.companion.actions === 'ask') {
        const outcome = await confirmActions(turn, ctx, res, summary, steps ? `step ${steps} of ${maxSteps}` : undefined);
        if (outcome !== 'allowed') {
          sendToOverlay(turn.overlay, IPC.overlayStopSpeaking);
          const updated = store.updateTurn(chatId, res.assistantId, { error: outcome === 'timeout' ? 'not done: no answer' : 'not done: cancelled' });
          if (updated) emitChat({ type: 'done', chatId, turn: updated });
          await end(outcome === 'timeout' ? "no answer, so i didn't do it." : "okay, i won't do that.");
          return;
        }
      }

      steps++;
      emitChat({ type: 'acting', chatId, turnId: res.assistantId, step: nextStep });
      sendState(turn.overlay, { phase: 'acting', reply: res.reply, step: nextStep });
      log('agent', `${turn.id} ${nextStep}: ${JSON.stringify(planned.map((p) => p.input))}`);
      try {
        await performPlanned(turn, planned, nextStep, res.reply);
      } catch (err) {
        if (signal.aborted) throw err;
        store.updateTurn(chatId, res.assistantId, { error: `couldn't act: ${errorMessage(err)}` });
        throw userError(`couldn't do that: ${errorMessage(err)}`);
      }
      const past = res.actions.filter((a) => a.type !== 'wait').map((a) => describeAction(a, 'past'));
      const updated = store.updateTurn(chatId, res.assistantId, { actions: past.length ? past : res.actions.map((a) => describeAction(a, 'past')) });
      if (updated) emitChat({ type: 'done', chatId, turn: updated });

      if (res.done) {
        await end(res.reply || 'done.', nextStep, !!res.reply);
        return;
      }
      if (steps >= maxSteps) {
        log('agent', `${turn.id} stopped at max steps (${maxSteps})`);
        await end(`i stopped after ${maxSteps} step${maxSteps === 1 ? '' : 's'} — ask me to keep going if there's more to do.`, nextStep);
        return;
      }

      // look again: let the UI settle, then fresh screenshots (companion back home, bubble small)
      recallPoints(turn);
      sendState(turn.overlay, { phase: 'thinking', step: nextStep });
      await delay(ACT_SETTLE_MS, signal);
      const fresh = await safeCapture(screen.getCursorScreenPoint());
      if (!isTurnCurrent(turn)) return;
      if (!fresh.length) throw userError("couldn't see the screen after acting — stopped");
      screens = fresh;
      // only the newest message carries screenshots
      history = [...history, { role: 'user', text: userMsg.text }, { role: 'assistant', text: res.raw.trim() || '(acted)' }];
      userMsg = { role: 'user', text: AGENT_FOLLOW_UP, images: screens.map((s) => s.image) };
      const next = await askModel(turn, ctx, [...history, userMsg], screens, { thinking: { phase: 'thinking', step: nextStep }, step: nextStep });
      if (!next || !isTurnCurrent(turn)) return;
      res = next;
    }
  } finally {
    if (turn.agent) turn.agent.confirm = null;
    setConfirmKeys(null);
    setAgentKeysSuspended(false);
    emitChat({ type: 'acting', chatId, turnId: lastTurnId, step: null });
  }
}

/** Enter: approve the pending agent-mode actions (no-op unless a confirmation is waiting). */
export function onEnter(): void {
  const c = current?.agent?.confirm;
  if (!c || !current || current.controller.signal.aborted) return;
  log('agent', `${current.id} allowed (enter)`);
  c.settle('allowed');
}

/** chats window "allow" / "cancel" for the actions of assistant turn `turnId`. */
export function answerConfirm(turnId: string, allow: boolean): void {
  const c = current?.agent?.confirm;
  if (!c || c.turnId !== turnId) return;
  c.settle(allow ? 'allowed' : 'cancelled');
}

/** Whether an agent confirmation is waiting (tests, hotkeys). */
export function confirmPending(): boolean {
  return !!current?.agent?.confirm;
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
  const turn = beginTurn(overlayForPoint(cursor), 'processing', 'window');
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
  const target = pickPointScreen(p, screens);
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
  const turn = beginTurn(overlayForPoint(cursor), 'recording', 'voice');
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
      win.removeListener('closed', onClosed);
    };
    // the overlay (and its recording) is gone, e.g. its display was unplugged
    const onClosed = (): void => {
      cleanup();
      reject(userError('the screen changed while listening — try again'));
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
    win.once('closed', onClosed);
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
      (result.sttMs !== undefined ? `, on-device${result.sttDevice ? ` ${result.sttDevice}` : ''} stt ${result.sttMs}ms → ${result.text?.length ?? 0} chars` : '') +
      `, waited ${Date.now() - t0}ms` +
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
  const turn = beginTurn(win, 'processing', 'type');
  void processTypedTurn(turn, trimmed).catch((err) => failTurn(turn, err));
}

/** A typed turn on the overlay under the cursor, as if sent from the type box (test hook). */
export function submitTypedText(text: string): void {
  const win = overlayForPoint(screen.getCursorScreenPoint());
  if (win) onTextSubmit(win.webContents.id, text);
}

/* ───────────────────────── escape / misc ───────────────────────── */

let confirmEscAt = 0;

export function onEscape(): void {
  closeTyping();
  // agent mode waiting for approval: esc = "no" (said and recorded, unlike a plain stop)
  const pending = current?.agent?.confirm;
  if (pending) {
    log('agent', `${current!.id} cancelled (escape)`);
    confirmEscAt = Date.now();
    pending.settle('cancelled');
    clearErrorTimer();
    return;
  }
  // the same esc press can arrive twice (global-shortcut grab + uiohook): don't let the echo
  // also stop the "okay, i won't do that" that the first one started
  if (Date.now() - confirmEscAt < 400) return;
  // Escape is global (uiohook hears it in every app): pressing it in an editor must not kill a
  // reply streaming into the chats window, which has its own stop button. An agent run acting on
  // the screen is the exception: esc always stops it.
  if (current && (current.kind !== 'window' || current.agent)) {
    log('turn', `${current.id} cancelled (escape)`);
    cancelCurrent();
  }
  clearErrorTimer();
}

/** True while a voice turn is recording (the hotkey engine's toggle mode resyncs on this). */
export function isListening(): boolean {
  return current?.stage === 'recording' && !current.controller.signal.aborted;
}

/**
 * The talk chord turned out to be part of another shortcut (AltGr / ctrl+alt+key): drop the
 * recording without an error bubble. Only touches a turn that is still recording.
 */
export function cancelTalk(): void {
  if (!current || current.stage !== 'recording') return;
  log('voice', `talk cancelled: turn ${current.id} (chord was part of another shortcut)`);
  cancelCurrent();
}

/** Everything, including a chats-window reply (app quit / pause). */
function cancelAll(): void {
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
  const turn = beginTurn(overlayForPoint(cursor), 'processing', 'test');
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
  cancelAll();
  broadcastToOverlays(IPC.overlayPoint, null);
  try {
    cleanupCaptures();
  } catch {
    /* ignore */
  }
}
