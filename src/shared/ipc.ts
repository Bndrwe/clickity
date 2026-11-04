// IPC channel names and the APIs each preload exposes on `window`.
import type {
  Chat,
  ChatEvent,
  ChatSendRequest,
  ChatSummary,
  DeepPartial,
  ModelInfo,
  OverlayConfig,
  OverlayPoint,
  OverlayState,
  PermissionKind,
  PermissionsStatus,
  ProviderKind,
  ProviderStatus,
  ProviderTestResult,
  PttResult,
  PttStopRequest,
  Settings,
  SpeakCommand,
  KeyName,
  InputStatus,
} from './types';

/** Streamed to the settings window while main records a keybind (IPC.recordKeys). */
export interface KeyRecordEvent {
  /** keys down right now, ordered (modifiers first) */
  held: KeyName[];
  /** the biggest chord seen so far in this attempt */
  chord: KeyName[];
  /** all keys released: chord is the recorded result (['Escape'] alone = cancel) */
  done: boolean;
}

/** Whether global keys are being heard (settings › keys › status). */
export interface HotkeyStatus {
  platform: NodeJS.Platform;
  /** 'uiohook' = real key up/down; 'globalShortcut' = fallback (no modifier-only chords, no fn) */
  backend: 'uiohook' | 'globalShortcut' | 'none';
  /** macOS accessibility trust (always true elsewhere) */
  accessibility: boolean;
  /** mac fn helper: 'running' | 'missing' | 'no-permission' | 'starting' | 'error' | 'off' */
  fn: 'off' | 'starting' | 'running' | 'missing' | 'no-permission' | 'error';
  /** the talk or type chord includes Fn */
  usesFn: boolean;
}

/** Sent when a chord fires (IPC.hotkeyHeard), so settings can show "heard control + fn". */
export interface HotkeyHeard {
  which: 'talk' | 'type';
  keys: KeyName[];
}

export const IPC = {
  /* main → overlay (webContents.send) */
  overlayConfig: 'overlay:config', // OverlayConfig
  overlayCursor: 'overlay:cursor', // { x, y } global DIP, ~60 Hz
  overlayState: 'overlay:state', // OverlayState
  overlayPoint: 'overlay:point', // OverlayPoint | null  (local DIP; null = return to cursor)
  overlayPttStart: 'overlay:ptt-start', // void — start recording mic
  overlayPttStop: 'overlay:ptt-stop', // PttStopRequest — stop and reply with IPC.pttResult
  overlayPttCancel: 'overlay:ptt-cancel', // void — stop and discard
  overlaySpeak: 'overlay:speak', // SpeakCommand
  overlayStopSpeaking: 'overlay:stop-speaking', // void
  overlayTextInput: 'overlay:text-input', // boolean — show/hide the type box (window is made focusable by main)
  overlayClick: 'overlay:click', // OverlayPoint — agent mode: a click happens here now (ripple)

  /* overlay → main (ipcRenderer.send) */
  pttResult: 'ptt:result', // PttResult
  speechDone: 'overlay:speech-done', // void — finished playing SpeakCommand (or was stopped)
  textSubmit: 'overlay:text-submit', // string
  textCancel: 'overlay:text-cancel', // void
  overlayReady: 'overlay:ready', // void — renderer loaded, send it config
  overlayLog: 'overlay:log', // OverlayLogEntry — diagnostic line for clickity.log
  pttProgress: 'ptt:progress', // string — status while transcribing (e.g. model download %); keeps main's timeout alive

  /* settings window → main (ipcRenderer.invoke) */
  settingsGet: 'settings:get', // () => Settings
  settingsSet: 'settings:set', // (patch: DeepPartial<Settings>) => Settings
  settingsReset: 'settings:reset', // () => Settings
  providersStatus: 'providers:status', // (kind) => ProviderStatus
  providersModels: 'providers:models', // (kind) => ModelInfo[]
  providersTest: 'providers:test', // (kind) => ProviderTestResult
  providersLogin: 'providers:login', // (kind) => void — opens a terminal running the CLI login
  hotkeySuspend: 'hotkey:suspend', // (suspended: boolean) => void — while recording a new keybind
  recordKeysStart: 'hotkey:record-start', // () => { native: boolean } — main streams IPC.recordKeys; native=false → use the DOM recorder
  recordKeysStop: 'hotkey:record-stop', // () => void
  hotkeyStatusGet: 'hotkey:status', // () => HotkeyStatus
  permissionsGet: 'permissions:get', // () => PermissionsStatus
  permissionsRequest: 'permissions:request', // (kind) => PermissionsStatus
  permissionsReset: 'permissions:reset', // () => void — macOS: clear clickity's privacy entries (tccutil) and relaunch
  historyClear: 'history:clear', // () => void
  openExternal: 'app:open-external', // (url) => void
  appInfo: 'app:info', // () => { version, platform }
  testSpeak: 'speech:test', // () => void — companion says a short line using current tts settings
  appQuit: 'app:quit', // () => void
  openLogs: 'app:open-logs', // () => void — open clickity.log (settings › about)
  appRelaunch: 'app:relaunch', // () => void — restart (macOS applies some permissions only after a relaunch)
  inputStatus: 'input:status', // () => InputStatus — agent mode: can clickity click / type here?

  openChats: 'app:open-chats', // () => void — from settings (and tray / app menu in main)
  openSettings: 'app:open-settings', // () => void — from the chats window

  /* chats window → main (invoke) */
  chatsList: 'chats:list', // () => ChatSummary[] (newest first)
  chatsGet: 'chats:get', // (id) => Chat | null
  chatsNew: 'chats:new', // () => Chat — empty chat, becomes the active conversation
  chatsOpen: 'chats:open', // (id) => void — make it the active conversation (voice turns continue it)
  chatsRename: 'chats:rename', // (id, title) => void
  chatsDelete: 'chats:delete', // (id) => void
  chatsSend: 'chats:send', // (req: ChatSendRequest) => { chatId } — reply streams via chatsEvent
  chatsStop: 'chats:stop', // (chatId) => void — abort a reply in progress
  chatsActive: 'chats:active', // () => string | null — id of the active conversation
  chatsApprove: 'chats:approve', // (turnId) => void — agent mode: allow the pending actions
  chatsDeny: 'chats:deny', // (turnId) => void — agent mode: cancel the pending actions

  /* main → chats window */
  chatsEvent: 'chats:event', // ChatEvent
  chatsChanged: 'chats:changed', // ChatSummary[] — list changed (new chat, rename, voice turn…)

  /* main → settings window */
  settingsChanged: 'settings:changed', // Settings
  settingsGoto: 'settings:goto', // string — section id to scroll to (model, voice, keys, companion, permissions, about)
  recordKeys: 'hotkey:record-keys', // KeyRecordEvent
  hotkeyHeard: 'hotkey:heard', // HotkeyHeard — a chord fired
  hotkeyStatusChanged: 'hotkey:status-changed', // HotkeyStatus
} as const;

/** Exposed as `window.overlay` by src/preload/overlay.ts */
export interface OverlayApi {
  onConfig(cb: (c: OverlayConfig) => void): void;
  onCursor(cb: (p: { x: number; y: number }) => void): void;
  onState(cb: (s: OverlayState) => void): void;
  onPoint(cb: (p: OverlayPoint | null) => void): void;
  onPttStart(cb: () => void): void;
  onPttStop(cb: (req: PttStopRequest) => void): void;
  onPttCancel(cb: () => void): void;
  onSpeak(cb: (cmd: SpeakCommand) => void): void;
  onStopSpeaking(cb: () => void): void;
  onTextInput(cb: (open: boolean) => void): void;
  /** agent mode: a click lands here now (draw a ripple) */
  onClick(cb: (p: OverlayPoint) => void): void;
  sendPttResult(r: PttResult): void;
  speechDone(): void;
  submitText(text: string): void;
  cancelText(): void;
  ready(): void;
  /** diagnostic line for clickity.log */
  log(entry: OverlayLogEntry): void;
  /** status while a ptt result is pending (model download %, loading…) */
  pttProgress(note: string): void;
}

export interface OverlayLogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
}

/** Exposed as `window.clicky` by src/preload/settings.ts */
export interface SettingsApi {
  getSettings(): Promise<Settings>;
  setSettings(patch: DeepPartial<Settings>): Promise<Settings>;
  resetSettings(): Promise<Settings>;
  onSettingsChanged(cb: (s: Settings) => void): void;
  /** main asks the settings window to show a section */
  onGoto(cb: (section: string) => void): void;
  providerStatus(kind: ProviderKind): Promise<ProviderStatus>;
  providerModels(kind: ProviderKind): Promise<ModelInfo[]>;
  providerTest(kind: ProviderKind): Promise<ProviderTestResult>;
  providerLogin(kind: ProviderKind): Promise<void>;
  suspendHotkeys(suspended: boolean): Promise<void>;
  /** start the main-process key recorder; native=false when global keys can't be heard (use DOM events) */
  recordKeysStart(): Promise<{ native: boolean }>;
  recordKeysStop(): Promise<void>;
  onRecordKeys(cb: (e: KeyRecordEvent) => void): void;
  hotkeyStatus(): Promise<HotkeyStatus>;
  onHotkeyStatus(cb: (s: HotkeyStatus) => void): void;
  onHotkeyHeard(cb: (e: HotkeyHeard) => void): void;
  getPermissions(): Promise<PermissionsStatus>;
  requestPermission(kind: PermissionKind): Promise<PermissionsStatus>;
  /** macOS: forget stale privacy grants from older builds, then restart so macOS asks again */
  resetPermissions(): Promise<void>;
  clearHistory(): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** packaged = running as the installed app (false under `npm run dev`) */
  appInfo(): Promise<{ version: string; platform: NodeJS.Platform; packaged: boolean }>;
  relaunch(): Promise<void>;
  testSpeak(): Promise<void>;
  quit(): Promise<void>;
  openChats(): Promise<void>;
  /** open clickity.log in the default viewer */
  openLogs(): Promise<void>;
  /** agent mode: whether clickity can click / type on this machine */
  inputStatus(): Promise<InputStatus>;
}

/** Exposed as `window.chats` by src/preload/chats.ts */
export interface ChatsApi {
  list(): Promise<ChatSummary[]>;
  get(id: string): Promise<Chat | null>;
  create(): Promise<Chat>;
  open(id: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
  send(req: ChatSendRequest): Promise<{ chatId: string }>;
  stop(chatId: string): Promise<void>;
  active(): Promise<string | null>;
  /** agent mode: allow / cancel the actions a reply is waiting on (ChatEvent 'confirm') */
  approve(turnId: string): Promise<void>;
  deny(turnId: string): Promise<void>;
  onEvent(cb: (e: ChatEvent) => void): void;
  onChanged(cb: (list: ChatSummary[]) => void): void;
  // shared with the settings window
  getSettings(): Promise<Settings>;
  setSettings(patch: DeepPartial<Settings>): Promise<Settings>;
  onSettingsChanged(cb: (s: Settings) => void): void;
  providerModels(kind: ProviderKind): Promise<ModelInfo[]>;
  /** open the settings window, optionally at a section (model, voice, keys, companion, permissions, about) */
  openSettings(section?: string): Promise<void>;
}

declare global {
  interface Window {
    overlay: OverlayApi;
    clicky: SettingsApi;
    chats: ChatsApi;
  }
}
