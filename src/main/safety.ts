// Wires privacy controls, the usage meter and undo into the app: IPC for settings / chats /
// overlay, the speech meter, private mode's expiry. index.ts calls initSafety() once.
import { app, ipcMain } from 'electron';
import { IPC } from '../shared/ipc';
import { privacyCheck, schedulePrivateExpiry, setPrivateFor } from './privacy';
import { flushUsage, recordSpeech, resetUsage, usageSummary } from './usage';
import { requestUndo } from './undo';
import { setTtsMeter } from './speech/tts';
import { onSettingsChanged } from './settings-store';

let initialized = false;

export function initSafety(): void {
  if (initialized) return;
  initialized = true;
  ipcMain.handle(IPC.usageGet, () => usageSummary());
  ipcMain.handle(IPC.usageReset, () => resetUsage());
  ipcMain.handle(IPC.privacyCheck, () => privacyCheck());
  ipcMain.handle(IPC.privacyPrivate, (_e, minutes: unknown) => setPrivateFor(Number(minutes) || 0));
  ipcMain.handle(IPC.chatsUndo, (_e, chatId: unknown) => requestUndo('chats', typeof chatId === 'string' && chatId ? chatId : undefined));
  ipcMain.on(IPC.overlayUndo, () => void requestUndo('bubble'));
  setTtsMeter((provider, model, chars) => recordSpeech('tts', provider, model, chars));
  schedulePrivateExpiry();
  onSettingsChanged((s, prev) => {
    if ((s.privacy?.privateUntil ?? 0) !== (prev.privacy?.privateUntil ?? 0)) schedulePrivateExpiry();
  });
  app.on('before-quit', () => flushUsage());
}
