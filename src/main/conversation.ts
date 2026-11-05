// The turn orchestrator: push-to-talk → transcript + screenshots → streamed model reply
// → pointing → speech → back to idle. See ARCHITECTURE.md "How a turn works".
// Every turn (voice, overlay type box, chats window) runs through runTurn() and is recorded
// in the active stored chat (chat-store.ts); the chats window gets live ChatEvents.
import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, screen, type Point } from 'electron';
import { IPC } from '../shared/ipc';
import {
  PROVIDER_KINDS,
  PROVIDER_META,
  type Chat,
  type ChatAnswerRequest,
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
import { activeClicky, chatClickyId, clickyById, clickyIdentity, settingsForClicky } from '../shared/clickys';
import { trySwitchCommand } from './clickys';
import { captureScreens, cleanupCaptures, screenshotToGlobal, writeTempImage, type CaptureAnnotator, type CapturedScreen } from './capture';
import { MEANINGFUL_PX, addPoint, drawStroke, extentOf, finishPath, globalToScreenshot, hexToRgb, newPath, summarizeGesture, type GesturePath } from './gesture';
import * as store from './chat-store';
import { getChatsWindow, sendToChats } from './chats-window';
import { transcribe } from './speech/stt';
import { synthesize } from './speech/tts';
import { getProvider } from './providers/index';
import { hotkeyLabel, setAgentKeysSuspended, setChoiceKeys, setConfirmKeys } from './hotkey';
import { hasVisualTag, parseVisualTags, stripVisualTags, visualContextNote, visualPromptSection } from './visual-tags';
import type { ChatVisual } from '../shared/visuals';
import { askContextNote, composeAskReply, parseAskTag, spokenAsk, stripAskTags, type ParsedAsk } from './ask-tags';
import { describeAction, parseActionTags, stripActionTags, summarizeActions, wantsAction, type ParsedAction } from './action-tags';
import { agentInputStatus, performActions } from './agent-input';
import {
  broadcastToOverlays,
  onCursorMove,
  overlayDisplay,
  overlayForDisplay,
  overlayForPoint,
  overlayForWebContentsId,
  isOverlay as isOverlayWindow,
  sendToOverlay,
  setOverlayTyping,
} from './overlay';
import { log } from './log';
// features beside the core turn (memory, highlights, walkthroughs, routines, web pages, pdfs, drafts…)
import { capturedSince, deleteCaptureFiles } from './capture';
import { alwaysAllow, clearHighlights, completionCue, countdown, destructiveReason, extrasPrompt, handleReplyExtras, offerRoutines, runWalkthrough, stripExtras, type ReplyExtras } from './turn-extras';
import { pagesForMessage } from './web-fetch';
import { extractPdfText } from './pdf-text';
import { isDictating, isDraftRequest, runDraft } from './dictation';
import { copyText } from './text-insert';
import { grabKeys, releaseKeys } from './hotkey';
import type { HandsFreeUtterance, Routine } from '../shared/types';
import type { RoutineResult } from './routines';
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
  /** voice turns: the cursor's path while the talk chord is held (global DIP) */
  gesture?: { path: GesturePath; stop: (() => void) | null; cleared?: boolean };
  /** the latest reply's walkthrough steps / routine offers ([STEP] / [ROUTINE], turn-extras.ts) */
  extras?: ReplyExtras;
}

/** The turn is over: drop its screenshot temp files now (the 2-minute sweep is only a backstop) and fade highlights. */
function releaseTurnResources(turn: Turn): void {
  deleteCaptureFiles(capturedSince(turn.startedAt));
  clearHighlights();
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

/* ───────────────────────── cursor gesture (ink trail) ───────────────────────── */

/** Start recording the cursor path for a voice turn and start the ink trail on every overlay. */
function startGesture(turn: Turn, cursor: Point): void {
  const path = newPath(cursor, Date.now());
  const stop = onCursorMove((p, t) => addPoint(path, p.x, p.y, t));
  turn.gesture = { path, stop };
  broadcastToOverlays(IPC.overlayInk, 'start');
}

/** Stop recording (talk up): the trail stays on screen until the screenshots are taken. */
function stopGesture(turn: Turn): GesturePath | null {
  const g = turn.gesture;
  if (!g) return null;
  if (g.stop) {
    g.stop();
    g.stop = null;
    const p = screen.getCursorScreenPoint();
    finishPath(g.path, p.x, p.y, Date.now());
    broadcastToOverlays(IPC.overlayInk, 'end');
  }
  return g.path;
}

/** Fade the trail out (screenshots taken, turn cancelled or over). Idempotent. */
function clearInk(turn: Turn): void {
  if (!turn.gesture) return;
  stopGesture(turn);
  if (turn.gesture.cleared) return;
  turn.gesture.cleared = true;
  broadcastToOverlays(IPC.overlayInk, 'clear');
}

/** Draws the talk gesture into the screenshots (whether or not the OS captured the on-screen trail). */
function gestureAnnotator(path: GesturePath | null, settings: Settings): CaptureAnnotator | undefined {
  if (!path || extentOf(path.points) < MEANINGFUL_PX) return undefined;
  const dark = nativeTheme.shouldUseDarkColors;
  const ink: [number, number, number] = dark ? [242, 242, 240] : [17, 17, 17];
  const color = hexToRgb(settings.companion.color || '', ink);
  const halo: [number, number, number] = dark ? [20, 20, 20] : [255, 255, 255];
  return (s, bitmap) => {
    const k = s.image.width / s.bounds.width;
    const pts = path.points.map((p) => globalToScreenshot(s, p.x, p.y));
    return drawStroke(bitmap, s.image.width, s.image.height, pts, { width: Math.max(3, 3.5 * k), color, halo, alpha: 0.9 });
  };
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
  /** where the user's cursor is / what they circled with it this turn (gesture.ts summary) */
  cursorNote?: string;
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
- Never do anything destructive or irreversible (deleting, sending messages or email, posting, publishing, purchasing, paying, submitting forms, closing unsaved work, changing account or security settings) unless the user explicitly asked for exactly that in this conversation. If a step would do that and they didn't ask, stop and ask instead (an [ASK:…] with the choices, e.g. [ASK:send it now?|send|don't send]).
- Never type passwords, card numbers or other secrets unless the user dictated them in this conversation.
- If something unexpected happens (an error, a login wall, a captcha, the wrong window), stop and tell the user in one sentence, with [DONE].
- ${approval}
- Never mention the tags or coordinates in your words; the tags are never shown or spoken.
- If the user asked you to DO something, never answer with instructions for them ("click the icon in your dock…"). Do it yourself with the tags. Describing what to click without the tags does nothing.

Examples (screenshot coordinates are made up):
user: open apple music
you: opening music from your dock. [CLICK:612,1046:music icon:screen1]
user: search for cats
you: i'll type it into the search box. [CLICK:540,88:search box] [TYPE:cats] [KEY:enter]
user: save this
you: saving. [KEY:${mod}+s]
user: where is the save button?
you: it's in the top right. [POINT:1180,64:save button]`;
}

/** The choice-question section of the system prompt ([ASK:…], see ask-tags.ts). */
const ASK_PROMPT = `

ASKING THE USER TO CHOOSE
When the request is ambiguous (several things match, e.g. a few files, windows or buttons it could mean), or before an action that needs the user's decision (which of several matches, confirming a risky step, picking a format or an option), don't guess: ask one short question and offer the likely answers as choices. End the reply with one tag:
[ASK:question|option|option|option]
- The question first, then 2 to 5 options, separated by |. Keep each option short (1-6 words), most likely first. Never more than 5 options.
- The user picks one by clicking it, pressing its number or just saying something else; their answer comes back as their next message, and then you carry on (and act, if they asked you to do something).
- Write a literal | as \\| and ] as \\].
- A reply with an ASK must not also act: no action tags in the same reply. You may still point.
- The question is shown and read with the options, so before the tag write at most one short lead-in sentence that is not a question (or nothing). Don't repeat the question or list the options in your words.
- Only ask when there is a real choice to make; if the answer is obvious, just answer or do it.
Example:
user: open one of my files
you: there are a few on your desktop. [ASK:which file should i open?|budget.xlsx|report.docx|notes.txt]`;

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
  const cursor = screens.length && !fromWindow
    ? `

THE USER'S CURSOR
While they talk, the user may circle, underline or point at things with their mouse cursor to show you what they mean. Their stroke is drawn as a thin ink line in the screenshot (it is their gesture, not part of the app on screen). When they say "this", "that", "here" or "it" without naming anything, they mean what they circled or pointed at, or what is under their cursor. Explain or point at that.${opts.cursorNote ? `\nThis turn: ${opts.cursorNote}` : ''}`
    : '';

  // named companions: settingsForClicky() sets activeClicky to the clicky this turn talks to
  const who = clickyIdentity(clickyById(settings, settings.activeClicky));
  const persona = who.persona ? `\n\nWHO YOU ARE\nYour name is ${who.name}. Stay in this role (it shapes your focus and tone; the reply rules below still apply):\n${who.persona}` : '';
  return `You are ${who.name}, a friendly little AI companion that lives next to the user's mouse cursor on their ${platformName()} computer. The user holds a key, talks to you, and you can see their screen(s) through the screenshots attached to their latest message.${persona}

HOW TO REPLY
- Your reply is read aloud by a voice and shown in a small speech bubble, so keep it short: one to three sentences unless the user asks for more detail.
- Sound like a warm, clever friend looking over their shoulder: conversational, plain words, a little playful, never stiff or salesy.
- No markdown, bullet lists, headings, tables, emoji or code fences unless the user explicitly asks for them. Write numbers and symbols the way you'd say them.
- Answer about what's actually on the screen when that's relevant; be specific ("the blue share button in the top right") instead of generic.
- The user's words come from speech-to-text and may contain mistakes; infer what they meant. If the request is truly unclear, ask one short question (with choices, see below, when there are a few likely answers).
- Earlier turns in the conversation are text only; only the newest message has screenshots, so trust the current screenshots over memory.
${pointing}${ASK_PROMPT}${visualPromptSection()}${agent}${cursor}${channel}

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
  clearInk(turn);
  if (turn.stage === 'recording') sendToOverlay(turn.overlay, IPC.overlayPttCancel);
  sendToOverlay(turn.overlay, IPC.overlayStopSpeaking);
  for (const win of turn.pointed) sendToOverlay(win, IPC.overlayStopSpeaking);
  recallPoints(turn);
  sendState(turn.overlay, { phase: 'idle' });
  releaseTurnResources(turn);
}

function beginTurn(overlay: BrowserWindow | null, stage: Turn['stage'], kind: Turn['kind']): Turn {
  cancelCurrent();
  clearErrorTimer();
  // a new turn while a choice is pending is the answer (runTurn marks it): stop offering it
  clearChoice('new turn');
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
  clearInk(turn);
  recallPoints(turn);
  if (finalState) sendState(turn.overlay, finalState);
  releaseTurnResources(turn);
}

function failTurn(turn: Turn, err: unknown): void {
  if (turn.controller.signal.aborted || current !== turn) return; // cancelled: stay quiet
  const message = errorMessage(err);
  console.warn(`[conversation] turn ${turn.id} failed:`, err);
  log('turn', `${turn.id} failed:`, err instanceof Error && !(err as { quiet?: boolean }).quiet ? err : message);
  endTurn(turn, null);
  showError(turn.overlay, message);
}

async function safeCapture(cursor: Point, annotate?: CaptureAnnotator): Promise<CapturedScreen[]> {
  try {
    cleanupCaptures();
    return await captureScreens(cursor, annotate);
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
  else {
    // named companions: after a switch, continue the new clicky's own recent chat (or start one)
    const clicky = getSettings().activeClicky;
    if (chatClickyId(sum) !== clicky) {
      const recent = store.listChats().find((c) => chatClickyId(c) === clicky && Date.now() - c.updatedAt < CHAT_IDLE_MS);
      activeChatId = recent?.id ?? null;
      if (recent) activeSince = recent.updatedAt;
    }
  }
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
  const chat = store.createChat(getSettings().activeClicky);
  activate(chat.id);
  return chat.id;
}

/** Start an empty chat and make it active (chats window "new chat"). */
export function newChat(): Chat {
  const chat = store.createChat(getSettings().activeClicky);
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
      const askNote = a.ask ? askContextNote(a.ask) : '';
      const shownNote = a.visuals?.length ? visualContextNote(a.visuals) : '';
      parts.push(`${a.text}${pointedNote}${didNote}${askNote}${shownNote}`.trim());
    }
    if (!parts.length) continue;
    const userText = (u.text.trim() || (u.attachments?.length ? `(sent ${u.attachments.join(', ')})` : '')) + (u.text.trim() && u.gesture ? ` (${u.gesture})` : '');
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
  /** where the cursor is / what the user circled, for the system prompt of this turn's screenshots */
  cursorNote?: string;
  /** tiny note stored with the user turn ("circled an area on screen 1") */
  gestureNote?: string;
}

/** Voice / type "switch to <name>": switch the active clicky and let the new one say hi. */
async function runSwitchCommand(turn: Turn, input: TurnInput): Promise<boolean> {
  const target = trySwitchCommand(input.userText);
  if (!target) return false;
  const settings = settingsForClicky(getSettings(), target.id);
  const line = `hi, it's ${clickyIdentity(target).name}.`;
  sendState(turn.overlay, { phase: 'speaking', reply: line });
  if (input.speak) await speak(turn, line, settings);
  else await delay(1600, turn.controller.signal);
  if (isTurnCurrent(turn)) endTurn(turn);
  return true;
}

/** Record the user turn, stream the reply (overlay + chats window), store it, then point and speak.
 * In agent mode a reply with action tags runs the act → look → continue loop (runAgent). */
async function runTurn(turn: Turn, input: TurnInput): Promise<void> {
  // "switch to <name>" (named companions): handled here, no model call
  if (input.source !== 'window' && !input.attachments?.length && (await runSwitchCommand(turn, input))) return;
  const chatId = turn.chatId ?? resolveChat(null, false);
  turn.chatId = chatId;
  // the chat's clicky: its name / persona in the prompt, its brain and voice overrides
  const settings = settingsForClicky(getSettings(), chatClickyId(store.getSummary(chatId) ?? {}));
  const kind = input.provider ?? settings.provider;
  const model = input.model || settings.models[kind] || PROVIDER_META[kind].defaultModel;
  const cfg = settings.providers[kind] ?? {};
  const { screens } = input;
  const prior = chatContext(chatId, Math.max(0, settings.historyTurns));
  markAskAnswered(chatId, input.userText || input.attachments?.join(', ') || '');
  const userTurn = store.appendTurn(chatId, {
    role: 'user',
    text: input.userText,
    source: input.source,
    screenshots: screens.length,
    attachments: input.attachments?.length ? input.attachments : undefined,
    gesture: input.gestureNote || undefined,
    provider: kind,
    model,
  });
  if (userTurn) emitChat({ type: 'user', chatId, turn: userTurn });

  const ctx: ModelCtx = { settings, kind, model, cfg, chatId, input };
  // links in the message: read the pages (public http(s) only) and pass them along as untrusted context
  let pages: string[] = [];
  if (/https?:\/\//i.test(input.userText)) {
    sendState(turn.overlay, { phase: 'thinking', transcript: input.userText, note: 'reading the page…' });
    pages = await pagesForMessage(input.userText, turn.controller.signal);
    if (!isTurnCurrent(turn)) return;
  }
  const userMsg: ChatMessage = {
    role: 'user',
    text: [input.modelText ?? input.userText, ...pages].join('\n\n'),
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
  // Smaller / local models often answer a request to DO something with instructions
  // ("click the music icon in your dock") instead of action tags, so nothing happens.
  if (agentEnabled(settings, input, screens) && !res.done && !res.ask && wantsAction(input.userText)) {
    log('agent', `${turn.id} asked to act but the reply had no actions — nudging once`);
    const nudge: ChatMessage = { role: 'user', text: AGENT_NUDGE, images: screens.map((s) => s.image) };
    const retry = await askModel(turn, ctx, [...prior, userMsg, { role: 'assistant', text: res.raw }, nudge], screens, {
      thinking: { phase: 'thinking', transcript: input.userText },
    });
    if (!retry || !isTurnCurrent(turn)) return;
    if (retry.actions.length) {
      await runAgent(turn, ctx, { history: prior, userMsg, screens, first: retry });
      return;
    }
    // Still nothing, but it pointed at the thing: offer to click that spot. Always ask first,
    // even in automatic mode, since the model never actually decided to act.
    const target = retry.points[0] ?? res.points[0];
    if (target) {
      log('agent', `${turn.id} no actions after nudge — offering to click the pointed spot "${target.label}"`);
      const click: ParsedAction = { type: 'click', x: target.x, y: target.y, label: target.label || 'that', screen: target.screen, button: 'left', count: 1 };
      const askCtx: ModelCtx = { ...ctx, settings: { ...settings, companion: { ...settings.companion, actions: 'ask' } } };
      await runAgent(turn, askCtx, { history: prior, userMsg, screens, first: { ...retry, actions: [click] } });
      return;
    }
    await finishReply(turn, input, settings, retry.reply, retry.points, screens, undefined, askOffer(ctx, retry));
    return;
  }
  await finishReply(turn, input, settings, res.reply, res.points, screens, undefined, askOffer(ctx, res));
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
  /** the reply ends with a choice question ([ASK:…]); then `actions` is empty */
  ask: ParsedAsk | null;
}

/** Visible text: POINT, ASK and action tags removed (a trailing partial tag hidden while streaming). */
function visibleText(buffer: string, streaming: boolean): string {
  const noActions = stripActionTags(stripVisualTags(stripAskTags(stripExtras(buffer, streaming), streaming), streaming), streaming);
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
  const record = (text: string, points: ParsedPoint[], error?: string, ask?: ParsedAsk | null, visuals?: ChatVisual[]): void => {
    if (recorded) return;
    recorded = true;
    const stored = store.appendTurn(chatId, {
      id: assistantId,
      role: 'assistant',
      text,
      points: points.length ? points.map((p) => p.label) : undefined,
      ask: ask ? { question: ask.question, options: ask.options } : undefined,
      visuals: visuals?.length ? visuals : undefined,
      provider: kind,
      model,
      error,
    });
    if (error || !stored) emitChat({ type: 'error', chatId, turnId: assistantId, error: error ?? 'chat was deleted' });
    else emitChat({ type: 'done', chatId, turn: stored });
  };

  try {
    sendToOverlay(turn.overlay, IPC.overlayVisuals, null);
    show(opts.thinking);
    const req: ChatRequest = {
      // the cursor note describes this turn's own screenshots, not an agent step's fresh ones
      system:
        buildSystemPrompt(settings, screens, { source: input.source, imageNames: opts.imageNames, cursorNote: screens === input.screens ? input.cursorNote : undefined }) +
        (await extrasPrompt(settings, screens)),
      messages,
      model,
      signal,
    };

    if (process.env.CLICKY_DEBUG) console.log(`[clicky] system prompt: ${req.system}`);

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

    const ask = parseAskTag(buffer);
    const reply = ask ? composeAskReply(visibleText(buffer, false), ask) : visibleText(buffer, false);
    const points = settings.companion.pointing && input.point ? parsePointTags(buffer) : [];
    const agentOn = agentEnabled(settings, input, screens);
    // a reply that asks the user to choose never acts in the same breath
    const parsed = agentOn && !ask ? parseActionTags(buffer) : { actions: [], done: false };
    if (ask) log('choice', `${turn.id} asks: ${ask.question} [${ask.options.join(' | ')}]${agentOn && parseActionTags(buffer).actions.length ? ' (its action tags were ignored)' : ''}`);
    if (process.env.CLICKY_DEBUG) console.log(`[clicky] raw reply: ${JSON.stringify(buffer)} points: ${JSON.stringify(points)} actions: ${JSON.stringify(parsed)}`);
    if (agentOn && (parsed.actions.length || parsed.done)) log('agent', `${turn.id} reply: ${parsed.actions.length} action(s)${parsed.done ? ' + done' : ''}: ${JSON.stringify(parsed.actions).slice(0, 600)}`);
    if (!reply && points.length === 0 && parsed.actions.length === 0 && !parsed.done && !hasVisualTag(buffer)) throw new Error('the model returned an empty reply');
    const visuals = parseVisualTags(buffer);
    if (visuals.length) log('visuals', `${turn.id} shows ${visuals.map((v) => (v.type === 'card' ? `card "${v.title}"` : v.kind)).join(', ')}`);
    record(reply, points, undefined, ask, visuals);
    // [REMEMBER] facts are stored, [HIGHLIGHT]s drawn; walkthrough steps / routine offers wait for finishReply
    turn.extras = handleReplyExtras(buffer, screens, settings);
    if (isTurnCurrent(turn)) sendToOverlay(turn.overlay, IPC.overlayVisuals, visuals.length ? visuals : null);
    return { assistantId, raw: buffer, reply, points, actions: parsed.actions, done: parsed.done, ask };
  } catch (err) {
    record(visibleText(buffer, false), [], signal.aborted ? 'stopped' : errorMessage(err));
    throw err;
  }
}

/** Point and speak a final reply (or let it be read), then return to idle. A reply that asks
 * (`offer`) leaves its choice pending: pills in the bubble, digit keys grabbed, 2 minutes. */
async function finishReply(turn: Turn, input: TurnInput, settings: Settings, reply: string, points: ParsedPoint[], screens: CapturedScreen[], step?: string, offer?: AskOffer | null): Promise<void> {
  if (!isTurnCurrent(turn)) return;
  const signal = turn.controller.signal;
  const extras = turn.extras;
  turn.extras = undefined;
  // voice off: the answer also goes on the clipboard ("copied")
  if (input.speak && reply && settings.speech.tts.provider === 'off' && settings.companion.autoCopy !== false) {
    copyText(reply);
    sendToOverlay(turn.overlay, IPC.overlayCue, { text: 'copied', kind: 'done', ttl: 1600 });
  }
  if (extras?.steps.length && !offer) {
    // guided walkthrough: the intro, then step by step (enter / bubble click = next, esc = end)
    sendState(turn.overlay, { phase: 'speaking', reply, step });
    if (input.speak && reply) await speak(turn, reply, settings).catch(() => undefined);
    else await delay(1200, signal).catch(() => undefined);
    if (!isTurnCurrent(turn)) return;
    const say = input.speak ? (text: string) => void speak(turn, text, settings).catch(() => undefined) : undefined;
    const how = await runWalkthrough({ steps: extras.steps, screens, signal, overlay: turn.overlay, pointed: turn.pointed, say });
    if (!isTurnCurrent(turn)) return;
    sendToOverlay(turn.overlay, IPC.overlayStopSpeaking);
    log('turn', `${turn.id} done (walkthrough ${how})`);
    if (how === 'done') sendState(turn.overlay, { phase: 'speaking', reply: "that's it!" });
    await delay(how === 'done' ? 1400 : 0, signal).catch(() => undefined);
    endTurn(turn);
    return;
  }
  sendState(turn.overlay, { phase: 'speaking', reply, step });
  if (offer) offerChoice(turn, input, offer, reply, screens);

  // Point and speak concurrently.
  const pointing = points.length ? walkPoints(turn, points, screens) : Promise.resolve();
  const spokeAt = Date.now();
  if (input.speak) await speak(turn, offer ? spokenAsk(reply, offer.ask) : reply, settings);
  else await delay(readingTime(reply), signal);
  await pointing.catch(() => undefined);
  // If speech ended early (muted, no system voices, very short clip), keep the companion
  // on its target long enough to actually see where it is pointing.
  if (points.length && isTurnCurrent(turn)) {
    const left = readingTime(reply) - (Date.now() - spokeAt);
    if (left > 0) await delay(left, signal).catch(() => undefined);
  }
  if (!isTurnCurrent(turn)) return;
  // [ROUTINE:…] in the reply: ask before saving it
  if (extras?.routines.length) await offerRoutines(extras.routines, turn.overlay, signal).catch(() => 0);
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
const AGENT_NUDGE =
  "don't tell me what to click — do it yourself. reply with one short sentence and the action tags " +
  '(e.g. [CLICK:x,y:label:screenN], [TYPE:text], [KEY:enter]) using coordinates from this screenshot.';


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
function confirmActions(turn: Turn, ctx: ModelCtx, res: ModelReply, summary: string, step: string | undefined, offerAlways = true): Promise<ConfirmOutcome> {
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
      releaseKeys('always-allow');
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
    // "a" = always allow: agent mode becomes automatic (destructive steps still ask)
    if (offerAlways)
      grabKeys('always-allow', {
        A: () => {
          if (settled) return;
          alwaysAllow();
          finish('allowed');
        },
      });
    sendState(turn.overlay, { phase: 'speaking', reply: res.reply, confirm: summary, step, confirmAlways: offerAlways });
    emitChat({ type: 'confirm', chatId: ctx.chatId, turnId: res.assistantId, summary, pending: true, always: offerAlways });
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
  const end = async (text: string, step?: string, spoken = false, offer?: AskOffer | null): Promise<void> => {
    await speech;
    emitChat({ type: 'acting', chatId, turnId: lastTurnId, step: null });
    setConfirmKeys(null);
    if (steps) completionCue(turn.overlay, settings);
    if (!spoken || !input.speak || offer) return finishReply(turn, input, settings, text, [], screens, step, offer);
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
        await end(res.reply || 'done.', steps ? `${steps} step${steps === 1 ? '' : 's'}` : undefined, false, askOffer(ctx, res));
        return;
      }
      const planned = planActions(res.actions, screens);
      const summary = summarizeActions(res.actions);
      const nextStep = `step ${steps + 1} of ${maxSteps}`;

      // say the one-line plan while waiting for approval / acting
      await speech;
      speech = input.speak && res.reply ? speak(turn, res.reply, settings).catch(() => undefined) : Promise.resolve();

      // send / delete / pay / post… always asks, even in automatic ("always allow") mode
      const destructive = destructiveReason(res.actions);
      if (destructive && settings.companion.actions !== 'ask') log('agent', `${turn.id} destructive step (${destructive}): asking even in automatic mode`);
      if (settings.companion.actions !== 'ask' && !destructive && steps === 0) {
        // automatic mode: a moment to say no before the first action
        await countdown(signal, (n) => sendState(turn.overlay, { phase: 'acting', reply: res.reply, step: `starting in ${n}… esc to cancel` }));
        if (!isTurnCurrent(turn)) return;
      }
      if (settings.companion.actions === 'ask' || destructive) {
        const outcome = await confirmActions(turn, ctx, res, summary, steps ? `step ${steps} of ${maxSteps}` : undefined, !destructive);
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

    if (mime === 'application/pdf' || /\.pdf$/i.test(name)) {
      try {
        const pdf = await extractPdfText(data);
        const note = pdf.truncated ? `\n… (truncated: the pdf has more text than fits; ${pdf.pages} pages)` : '';
        const fence = fenceFor(pdf.text);
        out.inlined.push(`file: ${name} (pdf, ${pdf.pages} page${pdf.pages === 1 ? '' : 's'})\n${fence}\n${pdf.text || '(no text layer: this pdf is probably scanned images)'}${note}\n${fence}`);
        log('turn', `pdf ${name}: ${pdf.pages} page(s), ${pdf.text.length} chars${pdf.truncated ? ' (truncated)' : ''}`);
      } catch (err) {
        log('turn', `pdf ${name} unreadable:`, err);
        out.inlined.push(`[attached pdf "${name}" could not be read: ${errorMessage(err)}]`);
      }
      continue;
    }
    // .docx (and other office files) aren't read yet
    if (/officedocument|msword/.test(mime) || /\.(docx?|pptx?|xlsx?)$/i.test(name)) {
      out.inlined.push(`[attached file "${name}" is an office document, which clickity can't read yet — ask the user to paste the text or export a pdf]`);
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
export async function sendFromWindow(req: ChatSendRequest): Promise<{ chatId: string; switched?: string }> {
  if (!req || typeof req !== 'object') throw new Error('bad request');
  const text = String(req.text ?? '').trim();
  // "switch to <name>" (named companions): switch locally, send nothing
  if (!req.attachments?.length) {
    const target = trySwitchCommand(text);
    if (target) return { chatId: '', switched: target.name };
  }
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
  const turn = beginTurn(req.noBubble ? null : overlayForPoint(cursor), 'processing', 'window');
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
  startGesture(turn, cursor);

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
  stopGesture(turn);
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

/** `preset`: hands-free mode already recorded (and maybe transcribed) the utterance. */
async function processVoiceTurn(turn: Turn, preset?: PttResult): Promise<void> {
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
  const resultP = preset ? Promise.resolve(preset) : waitForPttResult(turn, overlay, timeout);
  if (!preset) sendToOverlay(overlay, IPC.overlayPttStop, { stt });
  sendState(overlay, { phase: 'transcribing' });

  // Screens are captured while the audio is being transcribed. The cursor's ink trail is still
  // on screen and is also drawn into the screenshots; it fades once they're taken.
  const path = stopGesture(turn);
  const cursor = screen.getCursorScreenPoint();
  const capturesP = safeCapture(cursor, gestureAnnotator(path, settings)).finally(() => clearInk(turn));

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
  // "write / reply / draft …": the model writes text for the focused field instead of answering
  if (isDraftRequest(text)) {
    log('voice', `turn ${turn.id} is a draft request`);
    turn.startedAt = Date.now(); // its screenshots go to the draft (which deletes them itself)
    endTurn(turn, null);
    void runDraft({ instruction: text, screens, win: overlay });
    return;
  }
  const gesture = summarizeGesture(path, cursor, screens);
  if (gesture.parts.length) log('voice', `gesture: ${gesture.parts.map((p) => `${p.kind} on screen ${p.screen} (${p.box.minX},${p.box.minY})–(${p.box.maxX},${p.box.maxY})`).join(', ')}`);
  await runTurn(turn, { source: 'voice', userText: text, screens, speak: true, point: true, cursorNote: gesture.text, gestureNote: gesture.note });
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
  syncChoiceKeys(); // digits must reach the type box
}

function closeTyping(): void {
  const win = typingOverlay;
  if (!win) return;
  typingOverlay = null;
  typingClosedAt = Date.now();
  sendToOverlay(win, IPC.overlayTextInput, false);
  setOverlayTyping(win, false);
  syncChoiceKeys();
}

async function processTypedTurn(turn: Turn, text: string): Promise<void> {
  await delay(TYPE_BOX_HIDE_MS, turn.controller.signal);
  sendState(turn.overlay, { phase: 'thinking', transcript: text });
  const cursor = screen.getCursorScreenPoint();
  const screens = await safeCapture(cursor);
  if (!isTurnCurrent(turn)) return;
  const cursorNote = summarizeGesture(null, cursor, screens).text;
  await runTurn(turn, { source: 'type', userText: text, screens, speak: true, point: true, cursorNote });
}

function onTextSubmit(senderId: number, text: string): void {
  const win = overlayForWebContentsId(senderId);
  if (!win) return;
  if (typingOverlay === win) closeTyping();
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return;
  // "something else…" (or any typed reply) while a choice waits: that's the answer, sent like the question's turn
  const p = pendingChoice;
  if (p) {
    log('choice', 'answered by typing');
    answerPending(p, trimmed);
    return;
  }
  const turn = beginTurn(win, 'processing', 'type');
  void processTypedTurn(turn, trimmed).catch((err) => failTurn(turn, err));
}

/** A typed turn on the overlay under the cursor, as if sent from the type box (test hook). */
export function submitTypedText(text: string): void {
  const win = overlayForPoint(screen.getCursorScreenPoint());
  if (win) onTextSubmit(win.webContents.id, text);
}

/* ───────────────────────── choices ([ASK:…]) ───────────────────────── */

/** a choice question stays answerable this long, then it becomes a normal reply */
const CHOICE_TIMEOUT_MS = 120_000;

/** What a reply that asks needs to be answered later. */
interface AskOffer {
  ask: ParsedAsk;
  chatId: string;
  /** the assistant turn that asked */
  turnId: string;
  provider: ProviderKind;
  model: string;
}

function askOffer(ctx: ModelCtx, res: ModelReply): AskOffer | null {
  return res.ask ? { ask: res.ask, chatId: ctx.chatId, turnId: res.assistantId, provider: ctx.kind, model: ctx.model } : null;
}

interface PendingChoice extends AskOffer {
  reply: string;
  overlay: BrowserWindow | null;
  /** the answer runs like the question's turn: same source, voice, pointing, screenshots */
  source: NonNullable<ChatTurn['source']>;
  speak: boolean;
  point: boolean;
  capture: boolean;
  timer: NodeJS.Timeout;
  /** digit keys currently grabbed (undefined = not synced yet) */
  keys?: boolean;
}

let pendingChoice: PendingChoice | null = null;
/** when the overlay type box last closed (its esc must not also dismiss the choice) */
let typingClosedAt = 0;
let choiceEscAt = 0;

function offerChoice(turn: Turn, input: TurnInput, offer: AskOffer, reply: string, screens: CapturedScreen[]): void {
  clearChoice(null);
  pendingChoice = {
    ...offer,
    reply,
    overlay: turn.overlay,
    source: input.source,
    speak: input.speak,
    point: input.point,
    capture: input.source !== 'window' || screens.length > 0,
    timer: setTimeout(() => clearChoice('timeout'), CHOICE_TIMEOUT_MS),
  };
  log('choice', `${turn.id} pending: ${offer.ask.options.length} option(s), ${input.source}`);
  syncChoiceKeys();
}

/**
 * Grab digits 1..N (+ esc) only while a choice is pending and nobody is typing: not while the
 * overlay type box is open, nor while the chats window has focus (its composer needs digits).
 * Tells the overlay (pills + whether "press 1–N" works).
 */
function syncChoiceKeys(): void {
  const p = pendingChoice;
  if (!p) {
    setChoiceKeys(null);
    return;
  }
  const chats = getChatsWindow();
  // an overlay taking focus means the type box is up (its digits are text, not choices)
  const focused = BrowserWindow.getFocusedWindow();
  const overlayFocused = !!focused && isOverlayWindow(focused);
  const want = !typingOverlay && !overlayFocused && !(chats && chats.isFocused());
  const keys = want ? setChoiceKeys({ count: p.ask.options.length, onDigit: (n) => pickChoice(n - 1, `key ${n}`), onEscape }) : setChoiceKeys(null);
  if (keys === p.keys) return;
  p.keys = keys;
  sendToOverlay(p.overlay, IPC.overlayChoice, { reply: p.reply, question: p.ask.question, options: p.ask.options, keys });
}

/** The choice a new turn cleared: if that turn goes into another chat, the question was dropped. */
let supersededChoice: { chatId: string; turnId: string } | null = null;

/**
 * Stop offering the pending choice. 'timeout' / 'escape' mark the stored question dismissed (not
 * answered); 'new turn' waits to see where the turn goes (runTurn: same chat = the answer).
 */
function clearChoice(reason: 'answered' | 'timeout' | 'escape' | 'new turn' | null): void {
  const p = pendingChoice;
  if (!p) return;
  pendingChoice = null;
  clearTimeout(p.timer);
  setChoiceKeys(null);
  sendToOverlay(p.overlay, IPC.overlayChoice, null);
  if (reason === 'timeout' || reason === 'escape') dismissAsk(p.chatId, p.turnId);
  if (reason === 'new turn') supersededChoice = { chatId: p.chatId, turnId: p.turnId };
  if (reason) log('choice', `cleared (${reason})`);
}

/** Mark a stored question dismissed (its buttons stop answering it). */
function dismissAsk(chatId: string, turnId: string): void {
  const t = store.getChat(chatId)?.turns.find((x) => x.id === turnId);
  if (!t?.ask || t.ask.answered !== undefined || t.ask.dismissed) return;
  const updated = store.updateTurn(chatId, turnId, { ask: { ...t.ask, dismissed: true } });
  if (updated) emitChat({ type: 'turn', chatId, turn: updated });
}

/** Option `index` of the pending choice (digit key, overlay pill). */
function pickChoice(index: number, how: string): void {
  const p = pendingChoice;
  if (!p) return;
  const text = p.ask.options[index];
  if (text === undefined) return;
  log('choice', `picked ${index + 1} (${how})`);
  answerPending(p, text);
}

/** Send `text` as the next message of the chat that asked, the way the question's turn ran. */
function answerPending(p: PendingChoice, text: string): void {
  clearChoice('answered');
  closeTyping();
  const cursor = screen.getCursorScreenPoint();
  const win = p.overlay && !p.overlay.isDestroyed() ? p.overlay : overlayForPoint(cursor);
  const turn = beginTurn(win, 'processing', p.source === 'window' ? 'window' : 'type');
  if (store.hasChat(p.chatId)) {
    turn.chatId = p.chatId;
    activate(p.chatId);
  }
  void (async () => {
    sendState(turn.overlay, { phase: 'thinking', transcript: text });
    await delay(TYPE_BOX_HIDE_MS, turn.controller.signal);
    const shot = screen.getCursorScreenPoint();
    const screens = p.capture ? await safeCapture(shot) : [];
    if (!isTurnCurrent(turn)) return;
    const cursorNote = p.source !== 'window' && screens.length ? summarizeGesture(null, shot, screens).text : undefined;
    await runTurn(turn, { source: p.source, userText: text, screens, speak: p.speak, point: p.point, provider: p.provider, model: p.model, cursorNote });
  })().catch((err) => failTurn(turn, err));
}

/** The newest turn of the chat asked and nobody answered yet: whatever comes next is the answer. */
function markAskAnswered(chatId: string, answer: string): void {
  // a turn in another chat while a question was pending: that question was dropped
  const prev = supersededChoice;
  supersededChoice = null;
  if (prev && prev.chatId !== chatId) dismissAsk(prev.chatId, prev.turnId);
  const last = store.getChat(chatId)?.turns.at(-1);
  if (!last || last.role !== 'assistant' || !last.ask || last.ask.answered !== undefined || last.ask.dismissed) return;
  const updated = store.updateTurn(chatId, last.id, { ask: { ...last.ask, answered: answer.trim() || '…' } });
  if (updated) emitChat({ type: 'turn', chatId, turn: updated });
}

/** Chats window: an option button (or a typed answer) for assistant turn `turnId`. */
export async function answerFromWindow(req: ChatAnswerRequest): Promise<{ chatId: string }> {
  if (!req || typeof req !== 'object') throw new Error('bad request');
  const text = String(req.text ?? '').trim().slice(0, 2000);
  if (!text) throw new Error('nothing to send');
  const p = pendingChoice;
  if (p && p.turnId === req.turnId && p.chatId === req.chatId) {
    log('choice', `answered from the chats window`);
    answerPending(p, text);
    return { chatId: p.chatId };
  }
  // no longer pending (timed out, dismissed, app restarted): a normal message in that chat
  return sendFromWindow({ chatId: req.chatId, text, includeScreen: !!req.includeScreen });
}

/** "reply" / "something else…" in the bubble: the type box opens under it (same chat). */
function openReplyBox(senderId: number): void {
  const win = overlayForWebContentsId(senderId);
  if (!win) return;
  // stop a reply that is still being read out; a pending choice stays answerable
  if (current) cancelCurrent();
  clearErrorTimer();
  if (typingOverlay && typingOverlay !== win) closeTyping();
  typingOverlay = win;
  setOverlayTyping(win, true);
  sendToOverlay(win, IPC.overlayTextInput, true);
  syncChoiceKeys();
}

/** Whether a choice question is waiting (tests). */
export function choicePending(): { chatId: string; turnId: string; question: string; options: string[]; keys: boolean } | null {
  const p = pendingChoice;
  return p ? { chatId: p.chatId, turnId: p.turnId, question: p.ask.question, options: [...p.ask.options], keys: !!p.keys } : null;
}

/* ───────────────────────── escape / misc ───────────────────────── */

let confirmEscAt = 0;

export function onEscape(): void {
  // the type box open over a pending choice: esc closes just the box
  const wasTyping = !!typingOverlay;
  closeTyping();
  if (pendingChoice && (wasTyping || Date.now() - typingClosedAt < 400)) return;
  // a choice waiting: esc dismisses it (and stops the question being read out)
  if (pendingChoice) {
    log('choice', 'dismissed (escape)');
    choiceEscAt = Date.now();
    const askedBy = current;
    clearChoice('escape');
    if (askedBy && askedBy.kind !== 'window') cancelCurrent();
    clearErrorTimer();
    return;
  }
  if (Date.now() - choiceEscAt < 400) return; // the same press echoed by the other key backend
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
  clearChoice(null);
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
  const settings = settingsForClicky(getSettings());
  const cursor = screen.getCursorScreenPoint();
  const turn = beginTurn(overlayForPoint(cursor), 'processing', 'test');
  const label = hotkeyLabel(settings.hotkeys.talk, process.platform);
  const line = `hi! i'm ${clickyIdentity(activeClicky(settings)).name.toLowerCase()}, your companion. hold ${label} and ask me anything.`;
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

/* ───────────────────────── hands-free, routines, drafts (feature hooks) ───────────────────────── */

/** For the hands-free mic arbiter and routines: is a turn recording / working right now? */
export function turnActivity(): 'idle' | 'recording' | 'working' {
  if (!current || current.controller.signal.aborted) return 'idle';
  return current.stage === 'recording' ? 'recording' : 'working';
}

/** Anything a routine must not interrupt: a turn, a pending choice, a dictation / draft. */
export function companionBusy(): boolean {
  return turnActivity() !== 'idle' || !!choicePending() || isDictating();
}

/** Hands-free barge-in / a draft taking over: stop the current voice / typed turn (not chats-window replies). */
export function stopCurrentTurn(): void {
  if (current && (current.kind !== 'window' || current.agent)) cancelCurrent();
}

/** Hands-free: one utterance became a voice turn (on the overlay that heard it). */
export function runUtterance(u: HandsFreeUtterance, win: BrowserWindow): void {
  if (current?.stage === 'recording') return;
  const cursor = screen.getCursorScreenPoint();
  const turn = beginTurn(overlayForPoint(cursor) ?? win, 'processing', 'voice');
  log('voice', `hands-free turn ${turn.id}: ${Math.round(u.durationMs)}ms${u.text !== undefined ? `, on-device → ${u.text.length} chars` : ''}`);
  sendState(turn.overlay, { phase: 'transcribing' });
  const preset: PttResult = { text: u.text, wav: u.wav, durationMs: Math.max(u.durationMs, MIN_PRESS_MS), peak: u.peak, error: u.error };
  void processVoiceTurn(turn, preset).catch((err) => failTurn(turn, err));
}

/** Routines: run `r.prompt` as a normal turn in a new chat titled after it. */
export async function runRoutineTurn(r: Routine): Promise<RoutineResult> {
  if (current) return { ok: false, error: 'busy' };
  const chat = store.createChat();
  store.renameChat(chat.id, `routine · ${r.prompt.replace(/\s+/g, ' ').trim().slice(0, 60)}`);
  const cursor = screen.getCursorScreenPoint();
  const turn = beginTurn(overlayForPoint(cursor), 'processing', 'window');
  turn.chatId = chat.id;
  try {
    sendState(turn.overlay, { phase: 'thinking', transcript: r.prompt, note: 'routine' });
    const screens = r.screen ? await safeCapture(cursor) : [];
    await runTurn(turn, { source: 'type', userText: r.prompt, screens, speak: r.speak, point: r.screen });
  } catch (err) {
    failTurn(turn, err);
  }
  const last = store.getChat(chat.id)?.turns.filter((t) => t.role === 'assistant').pop();
  if (!last) return { ok: false, error: 'no reply', chatId: chat.id };
  completionCue(turn.overlay, getSettings(), 'routine done');
  return last.error ? { ok: false, error: last.error, chatId: chat.id } : { ok: true, reply: last.text, chatId: chat.id };
}

/** Register the overlay → main IPC listeners. Call once after app ready. */
export function initConversation(): void {
  if (initialized) return;
  initialized = true;
  // Pick up where we left off if the last chat is recent; otherwise a new one starts lazily.
  const clicky = getSettings().activeClicky;
  const latest = store.listChats().find((c) => chatClickyId(c) === clicky);
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
  ipcMain.on(IPC.overlayChoose, (_e, index: unknown) => {
    if (typeof index === 'number' && Number.isInteger(index)) pickChoice(index, 'click');
  });
  ipcMain.on(IPC.overlayReply, (e) => openReplyBox(e.sender.id));
  // the chats window taking / losing focus decides whether digits are grabbed
  app.on('browser-window-focus', () => syncChoiceKeys());
  app.on('browser-window-blur', () => syncChoiceKeys());
  app.on('will-quit', () => clearChoice(null));
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
