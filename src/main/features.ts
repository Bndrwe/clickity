// Wiring for dictation / drafting, hands-free, routines, memory, voice previews and the dock:
// IPC handlers, the extra chord-engine handlers, and startup. index.ts calls these three.
import { app, ipcMain } from 'electron';
import { IPC, type LatencyInfo } from '../shared/ipc';
import type { Settings, TtsProvider } from '../shared/types';
import { getSettings, onSettingsChanged } from './settings-store';
import type { HotkeyHandlers } from './chord-engine';
import { notifyHotkeyHeard } from './hotkey-ipc';
import { draftEnter, draftEscape, initDictation, onDictateCancel, onDictateDown, onDictateDraft, onDictateUp } from './dictation';
import { initHandsFree, stopHandsFree, toggleHandsFree } from './hands-free';
import { checkRoutinesNow, initRoutines, runRoutineNow, stopRoutines } from './routines';
import { clearFacts, listFacts, onFactsChanged, setFacts } from './memory';
import { routineEnter, routineEscape, walkthroughEnter } from './turn-extras';
import { synthesize } from './speech/tts';
import { companionBusy, lessonEnter, isListening, latencySnapshot, onType, runRoutineTurn, runUtterance, stopCurrentTurn, testSpeak, turnActivity } from './conversation';
import { describeSpeed } from '../shared/speed';
import { sendToSettings } from './settings-window';
import { log } from './log';

/**
 * The extra chord-engine handlers (dictation, the type tap, the hands-free toggle) plus Enter /
 * Esc wrappers: a waiting draft / walkthrough / routine offer gets the key first, then the base.
 */
export function featureHotkeyHandlers(base: { onEnter(): void; onEscape(): void; onStop?(): void }): Partial<HotkeyHandlers> & { onEnter(): void; onEscape(): void } {
  return {
    onDictateDown,
    onDictateDraft,
    onDictateUp,
    onDictateCancel,
    onTypeTap: () => {
      notifyHotkeyHeard('type', getSettings().hotkeys.typeTap);
      onType();
    },
    onAlwaysOn: () => toggleHandsFree(),
    onEnter: () => {
      if (draftEnter() || walkthroughEnter() || routineEnter() || lessonEnter()) return;
      base.onEnter();
    },
    onEscape: () => {
      if (draftEscape() || routineEscape()) return;
      base.onEscape();
    },
    // the stop / pause key (default esc): a draft / dictation / routine offer first, then the turn
    onStop: () => {
      if (draftEscape() || routineEscape()) return;
      (base.onStop ?? base.onEscape)();
    },
  };
}

export function registerFeatureIpc(): void {
  ipcMain.handle(IPC.memoryList, () => listFacts());
  ipcMain.handle(IPC.memorySet, (_e, facts: unknown) => setFacts(facts));
  ipcMain.handle(IPC.memoryClear, () => clearFacts());
  ipcMain.handle(IPC.routineRun, (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('missing routine id');
    return runRoutineNow(id);
  });
  ipcMain.handle(IPC.voicePreview, async (_e, provider: unknown, voice: unknown) => {
    const p = String(provider) as TtsProvider;
    if (!['kokoro', 'system', 'openai', 'elevenlabs'].includes(p)) return null;
    const s = getSettings();
    const preview: Settings = { ...s, speech: { ...s.speech, tts: { ...s.speech.tts, provider: p, voice: String(voice ?? '') } } };
    const name = String(voice || 'the default voice').toLowerCase().replace(/^[ab][fm]_/, '');
    const line = `hi, i'm clickity. this is ${name}.`;
    // the natural voice runs in the overlay: say it next to the cursor
    if (p === 'kokoro') {
      void testSpeak(preview, line);
      return null;
    }
    return synthesize(line, preview);
  });
  ipcMain.handle(IPC.latencyGet, (): LatencyInfo => {
    const s = getSettings();
    const { last, kokoro } = latencySnapshot();
    return { ...describeSpeed(s), last, kokoro: s.speech.tts.provider === 'kokoro' ? kokoro || 'loading' : undefined };
  });
  onFactsChanged((facts) => sendToSettings(IPC.memoryChanged, facts));
}

function applyDock(s: Settings): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  try {
    if (s.showInDock === false) app.dock.hide();
    else void app.dock.show();
  } catch (err) {
    log('app', 'dock toggle failed:', err);
  }
}

export function initFeatures(): void {
  initDictation({ isRecording: isListening, stopTurn: stopCurrentTurn });
  initHandsFree({ activity: turnActivity, onUtterance: runUtterance, onBargeIn: stopCurrentTurn });
  initRoutines({ busy: companionBusy, run: runRoutineTurn });
  applyDock(getSettings());
  onSettingsChanged((s, prev) => {
    if (s.showInDock !== prev.showInDock) applyDock(s);
  });
}

export function stopFeatures(): void {
  stopHandsFree();
  stopRoutines();
}

/** CLICKITY_TEST=1 only (test-hook.ts): drive the features without real global keys. */
export function testFeatures(): Record<string, unknown> {
  return {
    onDictateDown,
    onDictateDraft,
    onDictateUp,
    draftEnter,
    draftEscape,
    walkthroughEnter,
    toggleHandsFree,
    listFacts,
    runRoutineNow,
    checkRoutinesNow,
    hotkeyHandlers: () => featureHotkeyHandlers({ onEnter: () => undefined, onEscape: () => undefined }),
  };
}
