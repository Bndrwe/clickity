// Settings-window IPC for hotkeys: the native keybind recorder, hotkey health and "heard it" pings.
import { ipcMain, systemPreferences, type WebContents } from 'electron';
import { IPC, type HotkeyHeard, type HotkeyStatus } from '../shared/ipc';
import type { KeyName } from '../shared/types';
import { fnStatus, onFnStatus, restartFnWatch } from './fn-key';
import { chordUsesFn, hotkeyBackend, onRawKey, setRecordingSuspended } from './hotkey';
import { KeyRecorder } from './key-recorder';
import { getSettings, onSettingsChanged } from './settings-store';
import { sendToSettings } from './settings-window';

const FN_RETRY_MS = 5000;

let stopCurrent: (() => void) | null = null;
let lastFnRetry = 0;

export function hotkeyStatus(): HotkeyStatus {
  const mac = process.platform === 'darwin';
  let accessibility = true;
  if (mac) {
    try { accessibility = systemPreferences.isTrustedAccessibilityClient(false); } catch { accessibility = false; }
  }
  return {
    platform: process.platform,
    backend: hotkeyBackend() ?? 'none',
    accessibility,
    fn: fnStatus(),
    usesFn: chordUsesFn(getSettings().hotkeys),
  };
}

function startRecording(wc: WebContents): { native: boolean } {
  stopRecording();
  if (hotkeyBackend() !== 'uiohook') return { native: false };
  const rec = new KeyRecorder((e) => {
    if (!wc.isDestroyed()) wc.send(IPC.recordKeys, e);
  });
  setRecordingSuspended(true);
  const off = onRawKey((k, down) => rec.key(k, down));
  const onGone = () => stopRecording();
  wc.once('destroyed', onGone);
  stopCurrent = () => {
    off();
    setRecordingSuspended(false);
    if (!wc.isDestroyed()) wc.removeListener('destroyed', onGone);
  };
  return { native: true };
}

function stopRecording(): void {
  const s = stopCurrent;
  stopCurrent = null;
  s?.();
}

/** Tell the settings window a chord fired ("heard control + fn ✓"). */
export function notifyHotkeyHeard(which: HotkeyHeard['which'], keys: KeyName[]): void {
  sendToSettings(IPC.hotkeyHeard, { which, keys } satisfies HotkeyHeard);
}

export function registerHotkeyIpc(): void {
  ipcMain.handle(IPC.recordKeysStart, (e) => startRecording(e.sender));
  ipcMain.handle(IPC.recordKeysStop, () => stopRecording());
  ipcMain.handle(IPC.hotkeyStatusGet, () => {
    // The user may have just granted input monitoring: retry the fn helper (throttled).
    const st = hotkeyStatus();
    if (st.usesFn && st.backend === 'uiohook' && (st.fn === 'no-permission' || st.fn === 'error') && Date.now() - lastFnRetry > FN_RETRY_MS) {
      lastFnRetry = Date.now();
      restartFnWatch();
    }
    return st;
  });
  onFnStatus(() => sendToSettings(IPC.hotkeyStatusChanged, hotkeyStatus()));
  onSettingsChanged((s, prev) => {
    if (JSON.stringify(s.hotkeys) !== JSON.stringify(prev.hotkeys)) sendToSettings(IPC.hotkeyStatusChanged, hotkeyStatus());
  });
}
