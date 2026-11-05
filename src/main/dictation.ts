// Dictation into any app, and screen-aware drafting.
//
//  dictate: hold the dictation chord, speak, release → the configured speech-to-text → the
//           dictionary (replacements, dash style) → typed / pasted into the focused app.
//           No screenshot, no model call; only a tiny cue at the cursor.
//  draft:   the same chord + alt / option (or "write / reply / draft …" with the talk chord):
//           screenshot + spoken instruction → the model writes the text → preview in the
//           bubble (enter types it, esc cancels; agent mode 'auto' types it straight away
//           unless it looks like a secret) → typed into the focused field.
import { BrowserWindow, ipcMain, screen } from 'electron';
import { IPC } from '../shared/ipc';
import { PROVIDER_META, type ChatRequest, type OverlayCue, type OverlayState, type PttResult, type Settings } from '../shared/types';
import { getSettings, updateSettings } from './settings-store';
import { overlayForPoint, sendToOverlay } from './overlay';
import { transcribe } from './speech/stt';
import { ensureMicrophoneAccess, microphoneStatus } from './permissions';
import { applyReplacements, detectCorrection, dictionaryPrompt, fixDashes, looksLikeCommandRisk, looksSecret } from './dictionary';
import { copyText, insertText } from './text-insert';
import { captureScreens, deleteCaptureFiles, type CapturedScreen } from './capture';
import { getProvider } from './providers/index';
import { memoryPrompt } from './memory';
import { activeAppName, isTerminalApp } from './live-context';
import { holdHandsFree } from './hands-free';
import { grabKeys, releaseKeys } from './hotkey';
import { log } from './log';

const MIN_PRESS_MS = 300;
const RESULT_TIMEOUT_MS = 90_000;
const LEARN_WINDOW_MS = 20_000;
const CONFIRM_TIMEOUT_MS = 60_000;

/* ───────── state ───────── */

interface Session {
  id: number;
  win: BrowserWindow;
  startedAt: number;
  draft: boolean;
  abort: AbortController;
  release: () => void;
  /** the focused app when the chord went down (typing is skipped if focus moved meanwhile) */
  app: Promise<string>;
}

let session: Session | null = null;
let seq = 0;
let last: { text: string; at: number } | null = null;
let busyCheck: () => boolean = () => false;
let stopTurn: () => void = () => undefined;
/** a draft / paste waiting for enter or esc */
let pending: { settle(ok: boolean): void } | null = null;
let draftAbort: AbortController | null = null;

const resultWaiters = new Map<number, (r: PttResult) => void>();

function cue(win: BrowserWindow | null | undefined, c: OverlayCue | null): void {
  sendToOverlay(win, IPC.overlayCue, c);
}

function state(win: BrowserWindow | null | undefined, s: OverlayState): void {
  sendToOverlay(win, IPC.overlayState, s);
}

/** conversation.ts tells us whether a voice turn is recording, and how to stop a turn for a draft. */
export function initDictation(opts: { isRecording(): boolean; stopTurn(): void }): void {
  busyCheck = opts.isRecording;
  stopTurn = opts.stopTurn;
  ipcMain.on(IPC.pttResult, (e, r: PttResult) => {
    const w = resultWaiters.get(e.sender.id);
    if (w) {
      resultWaiters.delete(e.sender.id);
      w(r ?? { durationMs: 0 });
    }
  });
}

export function isDictating(): boolean {
  return !!session;
}

/* ───────── chord handlers ───────── */

export function onDictateDown(draft: boolean): void {
  if (session || busyCheck()) return;
  const cursor = screen.getCursorScreenPoint();
  const win = overlayForPoint(cursor);
  if (!win) return;
  const release = holdHandsFree('dictation');
  const s: Session = { id: ++seq, win, startedAt: Date.now(), draft, abort: new AbortController(), release, app: activeAppName().catch(() => '') };
  session = s;
  log('dictation', `${draft ? 'draft' : 'dictate'} down (session ${s.id})`);
  const start = (): void => {
    if (session !== s) return;
    sendToOverlay(win, IPC.overlayPttStart);
    cue(win, { text: s.draft ? 'listening · draft' : 'listening', kind: 'listening', ttl: 0 });
  };
  const mic = microphoneStatus();
  if (mic === 'granted' || mic === 'unknown') start();
  else
    void ensureMicrophoneAccess().then((a) => {
      if (!a.ok) {
        end(s);
        cue(win, { text: a.message ?? 'microphone blocked', kind: 'error', ttl: 5000 });
      } else start();
    });
}

export function onDictateDraft(): void {
  if (!session || session.draft) return;
  session.draft = true;
  cue(session.win, { text: 'listening · draft', kind: 'listening', ttl: 0 });
}

export function onDictateCancel(): void {
  const s = session;
  if (!s) return;
  log('dictation', `cancelled (session ${s.id})`);
  sendToOverlay(s.win, IPC.overlayPttCancel);
  cue(s.win, null);
  end(s);
}

export function onDictateUp(draft: boolean): void {
  const s = session;
  if (!s) return;
  s.draft ||= draft;
  const held = Date.now() - s.startedAt;
  if (held < MIN_PRESS_MS) {
    sendToOverlay(s.win, IPC.overlayPttCancel);
    cue(s.win, { text: 'hold the keys while you speak', kind: 'info', ttl: 2200 });
    end(s);
    return;
  }
  void finish(s).catch((err) => {
    const msg = err instanceof Error ? err.message.split('\n')[0].toLowerCase() : String(err);
    if (!s.abort.signal.aborted) {
      log('dictation', `failed: ${msg}`);
      cue(s.win, { text: msg.slice(0, 90), kind: 'error', ttl: 5000 });
    }
    end(s);
  });
}

function end(s: Session): void {
  if (session === s) session = null;
  resultWaiters.delete(s.win.webContents.id);
  s.release();
}

function waitResult(s: Session): Promise<PttResult> {
  return new Promise((resolve, reject) => {
    const id = s.win.webContents.id;
    const timer = setTimeout(() => {
      resultWaiters.delete(id);
      reject(new Error('timed out waiting for the recording'));
    }, RESULT_TIMEOUT_MS);
    resultWaiters.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
  });
}

/** Transcribe a recording (on-device text, or a wav for the remote engines) with the dictionary prompt. */
async function toText(r: PttResult, settings: Settings, prompt: string, signal: AbortSignal): Promise<string> {
  if (r.error) throw new Error(r.error);
  let text = r.text?.trim() ?? '';
  if (!text && r.wav && r.wav.byteLength > 44) {
    text = (await transcribe(Buffer.from(r.wav), settings, AbortSignal.any([signal, AbortSignal.timeout(45_000)]), { prompt })).trim();
  }
  return text;
}

/** Dictionary replacements + dash style; also strips whisper's "[BLANK_AUDIO]"-style noise. */
export function postProcess(text: string, settings: Settings): string {
  const t = text.replace(/^\s*[[(][^\])]*[\])]\s*$/, '').trim();
  return fixDashes(applyReplacements(t, settings.dictation.replacements), settings.dictation.dashes).trim();
}

async function finish(s: Session): Promise<void> {
  const settings = getSettings();
  const prompt = dictionaryPrompt(settings.dictation.words);
  const resultP = waitResult(s);
  sendToOverlay(s.win, IPC.overlayPttStop, { stt: settings.speech.stt, prompt });
  cue(s.win, { text: 'transcribing…', kind: 'working', ttl: 0 });
  // drafting looks at the screen: grab it while the words are transcribed
  const screensP = s.draft ? captureScreens(screen.getCursorScreenPoint()).catch(() => [] as CapturedScreen[]) : null;
  const r = await resultP;
  const raw = await toText(r, settings, prompt, s.abort.signal);
  const text = postProcess(raw, settings);
  log('dictation', `session ${s.id}: ${r.durationMs}ms → ${text.length} chars${s.draft ? ' (draft instruction)' : ''}`);
  if (!text) {
    end(s);
    cue(s.win, { text: "didn't catch that", kind: 'info', ttl: 2200 });
    if (screensP) void screensP.then((sc) => deleteCaptureFiles(sc.map((x) => x.image.path)));
    return;
  }
  end(s);
  if (s.draft && screensP) {
    cue(s.win, null);
    await runDraft({ instruction: text, screens: await screensP, win: s.win });
    return;
  }
  learn(text, settings);
  // focus moved to another app while talking: don't type into the wrong place, keep it on the clipboard
  const [before, after] = await Promise.all([s.app, activeAppName().catch(() => '')]);
  if (before && after && before !== after) {
    log('dictation', `focus moved (${before} → ${after}): copied instead of typing`);
    copyText(text);
    cue(s.win, { text: 'focus moved — copied instead', kind: 'info', ttl: 2600 });
    return;
  }
  await insertWithGuards(text, s.win);
}

/** Type / paste; asks first when text with a line break is about to land in a terminal. */
async function insertWithGuards(text: string, win: BrowserWindow): Promise<void> {
  if (looksLikeCommandRisk(text)) {
    const app = await activeAppName().catch(() => '');
    if (isTerminalApp(app)) {
      const ok = await confirm(win, text, `paste into ${app.toLowerCase() || 'the terminal'}? it has a line break, which could run a command`);
      if (!ok) {
        cue(win, { text: 'not pasted', kind: 'info', ttl: 1800 });
        return;
      }
    }
  }
  const how = await insertText(text);
  cue(win, { text: how === 'pasted' ? 'pasted' : 'typed', kind: 'done', ttl: 1400 });
}

/** Light auto-learn: "clicky tea" right after "… clicky tea …" means a correction → offer it in settings. */
function learn(text: string, settings: Settings): void {
  const now = Date.now();
  const prev = last;
  last = { text, at: now };
  if (!settings.dictation.autoLearn || !prev || now - prev.at > LEARN_WINDOW_MS) return;
  const fix = detectCorrection(prev.text, text);
  if (!fix) return;
  const d = settings.dictation;
  const known = (r: { from: string }) => r.from.toLowerCase() === fix.from.toLowerCase();
  if (d.replacements.some(known) || d.suggestions.some(known)) return;
  log('dictation', `suggesting "${fix.from}" → "${fix.to}"`);
  updateSettings({ dictation: { suggestions: [...d.suggestions, fix].slice(-20) } });
}

/* ───────── enter / esc while a draft or paste waits ───────── */

function confirm(win: BrowserWindow, preview: string, question: string): Promise<boolean> {
  pending?.settle(false);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const settle = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (pending === p) pending = null;
      releaseKeys('draft');
      state(win, { phase: 'idle' });
      resolve(ok);
    };
    const p = { settle };
    pending = p;
    const timer = setTimeout(() => settle(false), CONFIRM_TIMEOUT_MS);
    grabKeys('draft', { Return: () => settle(true), Escape: () => settle(false) });
    state(win, { phase: 'speaking', reply: preview, confirm: question });
  });
}

/** Enter (chord engine backup): approve a waiting draft. Returns whether it was ours. */
export function draftEnter(): boolean {
  if (!pending) return false;
  pending.settle(true);
  return true;
}

/** Esc: cancel a waiting / streaming draft or a recording dictation. Returns whether it was ours. */
export function draftEscape(): boolean {
  if (pending) {
    pending.settle(false);
    return true;
  }
  if (draftAbort) {
    draftAbort.abort();
    return true;
  }
  if (session) {
    onDictateCancel();
    return true;
  }
  return false;
}

export function draftPending(): boolean {
  return !!pending || !!draftAbort;
}

/* ───────── drafting ───────── */

const DRAFT_RE = /^\s*(?:(?:hey |ok |okay )?clickity[,.]?\s+)?(?:please\s+)?(write|reply|respond|draft|compose|answer)\b/i;

/** "write a reply saying i'm in", "draft an email to sam…" (talk chord) → a draft instead of a chat answer. */
export function isDraftRequest(text: string): boolean {
  return DRAFT_RE.test(text) && !/\?\s*$/.test(text.trim()) && !/\b(how|what|where|why)\b.*\b(do|does|should|can)\b/i.test(text.slice(0, 40));
}

function draftSystem(settings: Settings, screens: CapturedScreen[]): string {
  const lines = screens.map((s) => `- screen ${s.index}${s.isCursorScreen ? ' (the cursor and the text field are on this one)' : ''}: ${s.image.width}x${s.image.height} pixels`);
  const custom = settings.customInstructions.trim();
  return `You are Clickity's writing helper. The user is about to type into a text field on their screen (an email, a chat, a form, a document) and told you what to write. Your entire reply is typed into that field exactly as you write it.

RULES
- Output ONLY the text to insert. No preamble ("here's a draft"), no quotes around it, no explanations, no markdown, no tags.
- Use the screenshot for context: who they're replying to, what was said, the language and tone of the thread, names, dates.
- Write in the user's voice, in the language of the conversation on screen unless they ask for another one. Keep it as short as the situation calls for.
- Never invent facts (numbers, dates, promises) that the user didn't give and the screen doesn't show; leave a short [placeholder] instead.
- Never write passwords, card numbers or other secrets.
${memoryPrompt(settings.memory.enabled).replace(/\n\nMEMORY[\s\S]*?(?=Things you know|$)/, '\n\n')}
SCREENS
${lines.join('\n') || '- (no screenshot: write from the instruction alone)'}${custom ? `\n\nADDITIONAL INSTRUCTIONS FROM THE USER\n${custom}` : ''}`;
}

/** Strip what models add despite the rules: code fences, wrapping quotes, "Here's a draft:". */
export function cleanDraft(text: string): string {
  let t = text.trim();
  t = t.replace(/^```[a-z]*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  t = t.replace(/^(?:sure[,!.]?\s*)?here(?:'s| is) (?:a |the |your )?(?:draft|reply|message|response|text)[^:\n]*:\s*/i, '');
  if (/^["“].*["”]$/s.test(t)) t = t.slice(1, -1).trim();
  return t.replace(/\[(?:POINT|CLICK|TYPE|KEY|DONE|REMEMBER|ASK)[^\]]*\]/gi, '').trim();
}

/** Write text from an instruction + screenshots, preview it, then type it where the cursor is. */
export async function runDraft(opts: { instruction: string; screens: CapturedScreen[]; win?: BrowserWindow | null }): Promise<void> {
  stopTurn();
  draftAbort?.abort();
  const abort = new AbortController();
  draftAbort = abort;
  const win = opts.win ?? overlayForPoint(screen.getCursorScreenPoint());
  const settings = getSettings();
  const kind = settings.provider;
  const model = settings.models[kind] || PROVIDER_META[kind].defaultModel;
  const release = holdHandsFree('draft');
  try {
    state(win, { phase: 'thinking', transcript: opts.instruction, note: 'drafting…' });
    const req: ChatRequest = {
      system: draftSystem(settings, opts.screens),
      messages: [{ role: 'user', text: `Write this for me: ${opts.instruction}`, images: opts.screens.map((s) => s.image) }],
      model,
      signal: abort.signal,
    };
    let buf = '';
    let lastSent = 0;
    const t0 = Date.now();
    for await (const delta of getProvider(kind).stream(req, settings.providers[kind] ?? {})) {
      if (abort.signal.aborted) break;
      buf += delta;
      if (Date.now() - lastSent > 60) {
        lastSent = Date.now();
        state(win, { phase: 'speaking', reply: cleanDraft(buf), note: 'drafting…' });
      }
    }
    deleteCaptureFiles(opts.screens.map((s) => s.image.path));
    if (abort.signal.aborted) {
      state(win, { phase: 'idle' });
      return;
    }
    const text = cleanDraft(buf);
    log('dictation', `draft from ${kind} / ${model}: ${text.length} chars in ${Date.now() - t0}ms`);
    if (!text) throw new Error('the model returned an empty draft');
    if (draftAbort === abort) draftAbort = null;
    const secret = looksSecret(text);
    const auto = settings.companion.actions === 'auto' && !secret;
    if (!auto) {
      const ok = await confirm(win!, text, secret ? 'this looks like a secret — type it anyway?' : 'type this where your cursor is?');
      if (!ok) {
        cue(win, { text: 'draft discarded', kind: 'info', ttl: 1800 });
        return;
      }
    } else state(win, { phase: 'idle' });
    await insertWithGuards(text, win!);
  } catch (err) {
    deleteCaptureFiles(opts.screens.map((s) => s.image.path));
    if (abort.signal.aborted) return;
    const msg = err instanceof Error ? err.message.split('\n')[0].toLowerCase() : String(err);
    log('dictation', `draft failed: ${msg}`);
    state(win, { phase: 'error', error: `couldn't draft that: ${msg}` });
    setTimeout(() => state(win, { phase: 'idle' }), 6000);
  } finally {
    if (draftAbort === abort) draftAbort = null;
    release();
  }
}
