// Enum / platform checks for loaded or patched settings. Pure (type imports only) so it can be
// unit tested with `node --experimental-strip-types --test`; settings-store.ts calls it.
import type { Settings } from '../shared/types';

const THEMES = ['system', 'light', 'dark'];
const MODES = ['hold', 'toggle'];
const STT = ['on-device', 'openai', 'groq', 'gemini', 'local'];
const TTS = ['system', 'openai', 'elevenlabs', 'off'];
const ACTIONS = ['off', 'ask', 'auto'];

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
  if (!ACTIONS.includes(s.companion.actions)) s.companion.actions = d.companion.actions;
  s.companion.maxSteps = finite(s.companion.maxSteps) ? Math.min(20, Math.max(1, Math.round(s.companion.maxSteps))) : d.companion.maxSteps;
  // 'Fn' only exists on mac (fn-key helper). A settings.json synced / copied from a mac would
  // leave Windows / Linux with a chord that can never fire: fall back to the platform default.
  if (platform !== 'darwin') {
    if (s.hotkeys.talk.includes('Fn')) s.hotkeys.talk = [...d.hotkeys.talk];
    if (s.hotkeys.type.includes('Fn')) s.hotkeys.type = [...d.hotkeys.type];
  }
  return s;
}
