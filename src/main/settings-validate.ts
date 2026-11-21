// Enum / platform checks for loaded or patched settings. Pure (type imports only) so it can be
// unit tested with `node --experimental-strip-types --test`; settings-store.ts calls it.
import type { Settings } from '../shared/types';
import { DEFAULT_STOP, stopKeyProblem } from './stop-logic.ts';
import { DEFAULT_NEVER_CAPTURE } from '../shared/types.ts';
import { cleanList } from './privacy-match.ts';

const THEMES = ['system', 'light', 'dark'];
const MODES = ['hold', 'toggle'];
const STT = ['on-device', 'openai', 'deepgram', 'groq', 'gemini', 'local'];
const TTS = ['kokoro', 'system', 'openai', 'elevenlabs', 'off'];
const ACTIONS = ['off', 'ask', 'auto'];
const SHOW = ['always', 'active', 'never'];
const HIDE_REPLIES = ['auto', 'keep', '10s', '30s', '1m'];

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Replaces values outside their union with the default (mutates s). Without this a hand-edited
 * or older settings.json could e.g. set hotkeys.mode "Hold" (the chord engine then never ends a
 * talk) or theme "auto" (nativeTheme.themeSource throws during startup).
 */
export function fixEnums(s: Settings, d: Settings, platform: string): Settings {
  if (!THEMES.includes(s.theme)) s.theme = d.theme;
  if (!MODES.includes(s.hotkeys.mode)) s.hotkeys.mode = d.hotkeys.mode;
  if (!STT.includes(s.speech.stt.provider)) s.speech.stt.provider = d.speech.stt.provider;
  if (!TTS.includes(s.speech.tts.provider)) s.speech.tts.provider = d.speech.tts.provider;
  if (!finite(s.companion.offsetX)) s.companion.offsetX = d.companion.offsetX;
  if (!finite(s.companion.offsetY)) s.companion.offsetY = d.companion.offsetY;
  // agent mode: anything unknown falls back to the default ('ask first'), never to 'auto'
  // older settings.json files have no `show`: the defaults merge fills it; anything else → 'always'
  if (!SHOW.includes(s.companion.show)) s.companion.show = d.companion.show;
  if (!ACTIONS.includes(s.companion.actions)) s.companion.actions = d.companion.actions;
  if (!HIDE_REPLIES.includes(s.companion.hideReplies ?? 'auto')) s.companion.hideReplies = 'auto';
  s.companion.maxSteps = finite(s.companion.maxSteps) ? Math.min(20, Math.max(1, Math.round(s.companion.maxSteps))) : d.companion.maxSteps;
  // 'Fn' only exists on mac (fn-key helper). A settings.json synced / copied from a mac would
  // leave Windows / Linux with a chord that can never fire: fall back to the platform default.
  if (platform !== 'darwin') {
    if (s.hotkeys.talk.includes('Fn')) s.hotkeys.talk = [...d.hotkeys.talk];
    if (s.hotkeys.type.includes('Fn')) s.hotkeys.type = [...d.hotkeys.type];
    for (const k of ['dictate', 'typeTap', 'alwaysOn'] as const) {
      if (s.hotkeys[k]?.includes('Fn')) s.hotkeys[k] = [...d.hotkeys[k]];
    }
  }
  // stop / pause key: older settings have none (the defaults merge adds esc); anything that can't
  // be grabbed as a shortcut (fn, taps, plain letters…) falls back to esc
  if (stopKeyProblem(s.hotkeys.stop, platform)) s.hotkeys.stop = [...(d.hotkeys.stop ?? DEFAULT_STOP)];
  fixFeatures(s, d);
  fixWakeAndTips(s, d, platform);
  fixSafety(s, d);
  upgradeSpeech(s, d);
  return s;
}

const SENSITIVITY = ['low', 'medium', 'high'];

/** settings › voice › wake word and settings › companion › tips: both opt-in, off unless set to true. */
export function fixWakeAndTips(s: Settings, d: Settings, platform: string): Settings {
  const dw = d.wakeWord ?? { enabled: false, sensitivity: 'medium' };
  const w = s.wakeWord && typeof s.wakeWord === 'object' ? s.wakeWord : (s.wakeWord = { ...dw });
  w.enabled = w.enabled === true;
  if (!SENSITIVITY.includes(w.sensitivity)) w.sensitivity = dw.sensitivity;
  const dt = d.tips ?? { enabled: false, key: ['Control', 'Alt', 'KeyH'], perHour: 3, screenshot: false };
  const t = s.tips && typeof s.tips === 'object' ? s.tips : (s.tips = structuredClone(dt));
  t.enabled = t.enabled === true;
  t.screenshot = t.screenshot === true;
  t.perHour = finite(t.perHour) ? Math.min(6, Math.max(1, Math.round(t.perHour))) : dt.perHour;
  // same rules as the stop key: one non-modifier, f-keys alone, otherwise a ctrl / alt / cmd chord
  if (!Array.isArray(t.key) || !t.key.every((k) => typeof k === 'string') || stopKeyProblem(t.key, platform)) t.key = [...dt.key];
  return s;
}

/** on-device whisper defaults of older versions (users who never picked a model); base.en is
 * still the default: measured in the worker it's as quick as tiny.en and mishears far less */
const OLD_LOCAL_DEFAULTS: string[] = [];

/**
 * One-time speech upgrade (speech.upgraded === 0, set by settings-store for older files): users still on the untouched defaults get the
 * natural on-device voice instead of the robotic system default, and the faster on-device
 * whisper. Anything they picked themselves (a named system voice, a cloud voice, another model)
 * is kept. Fast replies default on.
 */
export function upgradeSpeech(s: Settings, d: Settings): Settings {
  const sp = s.speech;
  if ((sp.upgraded ?? 1) >= 1) return s; // settings-store marks pre-upgrade files with 0
  if (sp.tts.provider === 'system' && !sp.tts.voice) {
    sp.tts.provider = 'kokoro';
    sp.tts.voice = d.speech.tts.voice;
  }
  if (sp.stt.provider === 'on-device' && OLD_LOCAL_DEFAULTS.includes(sp.stt.model)) sp.stt.model = d.speech.stt.model;
  if (typeof sp.fastReplies !== 'boolean') sp.fastReplies = true;
  if (typeof sp.stt.streaming !== 'boolean') sp.stt.streaming = true;
  sp.upgraded = 1;
  return s;
}

const DASHES = ['keep', 'comma', 'hyphen'];
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Dictation dictionary, routines and the other feature settings: shapes a hand-edited file can break. */
export function fixFeatures(s: Settings, d: Settings): Settings {
  const dd = d.dictation ?? { words: [], replacements: [], suggestions: [], autoLearn: true, dashes: 'keep' };
  if (!s.dictation || typeof s.dictation !== 'object') s.dictation = structuredClone(dd);
  const dict = s.dictation;
  dict.words = (Array.isArray(dict.words) ? dict.words : []).map((w) => str(w, 80).trim()).filter(Boolean).slice(0, 300);
  const pairs = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .filter((r): r is { from: string; to: string } => !!r && typeof r === 'object')
      .map((r) => ({ from: str(r.from, 120).trim(), to: str(r.to, 200) }))
      .filter((r) => r.from)
      .slice(0, 300);
  dict.replacements = pairs(dict.replacements);
  dict.suggestions = pairs(dict.suggestions).slice(-20);
  if (typeof dict.autoLearn !== 'boolean') dict.autoLearn = dd.autoLearn;
  if (!DASHES.includes(dict.dashes)) dict.dashes = dd.dashes;
  s.userName = str(s.userName, 40).replace(/[\r\n\t]+/g, ' ').trim();
  s.routines = (Array.isArray(s.routines) ? s.routines : [])
    .filter((r) => !!r && typeof r === 'object' && typeof r.id === 'string' && r.id)
    .map((r) => ({
      ...r,
      days: (Array.isArray(r.days) ? r.days : []).filter((x) => Number.isInteger(x) && x >= 0 && x < 7),
      time: /^\d{2}:\d{2}$/.test(String(r.time)) ? r.time : '09:00',
      prompt: str(r.prompt, 1000),
      screen: !!r.screen,
      speak: !!r.speak,
      enabled: !!r.enabled,
    }))
    .slice(0, 50);
  return s;
}

const BLUR = ['off', 'cursor', 'all'];
const MAX_PRIVATE_MS = 24 * 60 * 60_000;
const MODS = ['Control', 'Alt', 'Shift', 'Meta'];

/**
 * Privacy, usage meter and undo key (older files have none: defaults; a hand-edited file can't
 * turn private mode on for a year or give the undo key a tap / fn binding).
 */
export function fixSafety(s: Settings, d: Settings, now = Date.now()): Settings {
  const dp = d.privacy ?? { neverCapture: [...DEFAULT_NEVER_CAPTURE], blur: 'off', privateUntil: 0 };
  if (!s.privacy || typeof s.privacy !== 'object') s.privacy = structuredClone(dp);
  const p = s.privacy;
  p.neverCapture = Array.isArray(p.neverCapture) ? cleanList(p.neverCapture) : [...dp.neverCapture];
  if (!BLUR.includes(p.blur)) p.blur = 'off';
  p.privateUntil = finite(p.privateUntil) && p.privateUntil > now ? Math.min(p.privateUntil, now + MAX_PRIVATE_MS) : 0;
  if (!s.usage || typeof s.usage !== 'object') s.usage = { monthlyLimit: 0 };
  const lim = Number(s.usage.monthlyLimit);
  s.usage.monthlyLimit = Number.isFinite(lim) && lim > 0 ? Math.min(100_000, Math.round(lim * 10_000) / 10_000) : 0;
  const u = s.hotkeys.undo;
  const ok =
    Array.isArray(u) &&
    u.length <= 4 &&
    u.every((k) => typeof k === 'string' && !!k && k !== 'Fn' && !/Tap$/.test(k)) &&
    (u.length === 0 || u.some((k) => !MODS.includes(k)));
  if (!ok) s.hotkeys.undo = [...(d.hotkeys.undo ?? ['KeyU'])];
  return s;
}
