// End-to-end test hook. Only active when CLICKITY_TEST=1: exposes the push-to-talk handlers and a
// few stores on globalThis so a Playwright _electron run can drive a voice turn (global hotkeys
// can't be pressed reliably under xvfb). Never enabled in normal runs.
import { session } from 'electron';
import { getSettings, updateSettings } from './settings-store';
import { getChat, listChats } from './chat-store';
import { answerConfirm, answerFromWindow, busyNow, cancelTalk, choicePending, confirmPending, isListening, onEnter, onEscape, onStopKey, onTalkDown, onTalkUp, pauseChat, resumeChat, sendFromWindow, stopChat, stopEverything, stopKeyState, submitTypedText } from './conversation';
import { grabOwner, hotkeyBackend, isGrabbed } from './hotkey';
import { fakeInputLog } from './agent-input';
import { logPath } from './log';
import { trayMenu } from './tray';
import { testFeatures } from './features';

export function installTestHook(): void {
  if (process.env.CLICKITY_TEST !== '1') return;
  (globalThis as Record<string, unknown>).__clickityTest = {
    onTalkDown,
    onTalkUp,
    onEscape,
    cancelTalk,
    /** stop / pause: the key, the chats window / notch / tray buttons, what's grabbed */
    onStopKey,
    stopChat,
    pauseChat,
    resumeChat,
    stopEverything,
    busyNow,
    stopKeyState,
    isGrabbed,
    grabOwner,
    hotkeyBackend,
    /** agent mode: the enter key / chats window allow-deny, the pending state, faked actions */
    onEnter,
    answerConfirm,
    confirmPending,
    fakeInputLog,
    submitTypedText,
    /** choices ([ASK:…]): what's pending, the chats window's option buttons */
    choicePending,
    answerFromWindow,
    sendFromWindow,
    isListening,
    getSettings,
    updateSettings,
    listChats,
    getChat,
    logPath,
    /** the tray menu (named companions: click "clicky: <name> ▸" items) */
    trayMenu,
    /** dictation, hands-free, memory, routines, walkthrough (features.ts) */
    features: testFeatures(),
    /** simulate the user blocking the microphone at the Chromium level */
    denyMedia(): void {
      session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
      session.defaultSession.setPermissionCheckHandler(() => false);
    },
  };
}
