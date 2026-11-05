// Enum / platform checks for loaded or patched settings. Pure (type imports only) so it can be
// unit tested with `node --experimental-strip-types --test`; settings-store.ts calls it.
import type { Settings } from '../shared/types';

const THEMES = ['system', 'light', 'dark'];
const MODES = ['hold', 'toggle'];
const STT = ['on-device', 'openai', 'groq', 'gemini', 'local'];
const TTS = ['system', 'openai', 'elevenlabs', 'off'];
const ACTIONS = ['off', 'ask', 'auto'];
const SHOW = ['always', 'active', 'never'];

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
  fixFeatures(s, d);
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
