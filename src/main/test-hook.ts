// End-to-end test hook. Only active when CLICKITY_TEST=1: exposes the push-to-talk handlers and a
// few stores on globalThis so a Playwright _electron run can drive a voice turn (global hotkeys
// can't be pressed reliably under xvfb). Never enabled in normal runs.
import { session } from 'electron';
import { getSettings, updateSettings } from './settings-store';
import { getChat, listChats } from './chat-store';
import { onEscape, onTalkDown, onTalkUp } from './conversation';
import { logPath } from './log';

export function installTestHook(): void {
  if (process.env.CLICKITY_TEST !== '1') return;
  (globalThis as Record<string, unknown>).__clickityTest = {
    onTalkDown,
    onTalkUp,
    onEscape,
    getSettings,
    updateSettings,
    listChats,
    getChat,
    logPath,
    /** simulate the user blocking the microphone at the Chromium level */
    denyMedia(): void {
      session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
      session.defaultSession.setPermissionCheckHandler(() => false);
    },
  };
}
