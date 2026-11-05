// IPC channel names and the APIs each preload exposes on `window`.
import type {
  Chat,
  ChatAnswerRequest,
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
  InkCommand,
  OverlayChoice,
  OverlayCue,
  OverlayHighlight,
  HandsFreeState,
  HandsFreeUtterance,
  ChatAttachment,
  ChatTurn,
  ClickyQuizAnswers,
  ClickySuggestion,
  CompanionPhase,
} from './types';
import type { ChatVisual } from './visuals';

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

/** In-app updater state (src/main/updater.ts), broadcast to the settings and chats windows. */
export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'error' | 'up-to-date' | 'unsupported';
  /** running version, e.g. "1.0.41" */
  current: string;
  /** newest release's version (no leading v) */
  latest?: string;
  /** that release's notes (commit subjects), plain lines */
  notes?: string;
  /** 0..1 while downloading */
  progress?: number;
  /** short lowercase reason (error / unsupported) */
  error?: string;
  /** short lowercase hint about what happens next ("finish the install in the window that opened") */
  message?: string;
  /** set for the first launch after an update: the version we came from */
  updatedFrom?: string;
  /** ms epoch of the last finished check */
  checkedAt?: number;
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
  overlayInk: 'overlay:ink', // InkCommand — the cursor's ink trail while talking (every overlay)
  overlayVisuals: 'overlay:visuals', // ChatVisual[] | null — cards / 3D models for the current reply (floating near the bubble)
  overlayChoice: 'overlay:choice', // OverlayChoice | null — a choice question is waiting (pills in the bubble)
  overlayCue: 'overlay:cue', // OverlayCue | null — tiny status pill at the cursor (dictation, hands-free)
  overlayHighlight: 'overlay:highlight', // OverlayHighlight[] | null — soft outlines ([HIGHLIGHT:…]); null = fade out
  overlayHandsFree: 'overlay:hands-free', // HandsFreeState — always-listening mode
  overlayWalkthrough: 'overlay:walkthrough', // boolean — a guided walkthrough is running (bubble click = next)

  /* overlay → main (ipcRenderer.send) */
  pttResult: 'ptt:result', // PttResult
  speechDone: 'overlay:speech-done', // void — finished playing SpeakCommand (or was stopped)
  textSubmit: 'overlay:text-submit', // string
  textCancel: 'overlay:text-cancel', // void
  overlayReady: 'overlay:ready', // void — renderer loaded, send it config
  overlaySetInteractive: 'overlay:set-interactive', // boolean — pointer is over the bubble: accept clicks so it can be dragged
  overlayLog: 'overlay:log', // OverlayLogEntry — diagnostic line for clickity.log
  pttProgress: 'ptt:progress', // string — status while transcribing (e.g. model download %); keeps main's timeout alive
  overlayChoose: 'overlay:choose', // number — the user clicked option N (0-based) of the pending choice
  overlayReply: 'overlay:reply', // void — "reply" / "something else…": open the type box under the bubble
  handsFreeUtterance: 'hands-free:utterance', // HandsFreeUtterance — voice activity ended: transcribe / run it
  handsFreeSpeech: 'hands-free:speech', // void — voice activity started (barge-in: stop speaking)
  walkNext: 'overlay:walk-next', // void — walkthrough: the bubble was clicked (next step)

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
  updateGet: 'update:get', // () => UpdateState
  updateCheck: 'update:check', // () => UpdateState — check github now
  updateInstall: 'update:install', // () => UpdateState — download, install, restart
  updateDismissNote: 'update:dismiss-note', // () => void — hide the "updated to …" note
  memoryList: 'memory:list', // () => string[] — remembered facts, oldest first
  memorySet: 'memory:set', // (facts: string[]) => string[] — replace the list (edit / delete)
  memoryClear: 'memory:clear', // () => void — forget everything
  voicePreview: 'speech:preview', // (provider, voice) => SpeakCommand | null — a short line in that voice (settings plays it)
  routineRun: 'routines:run', // (id) => void — run a routine now

  clickysSuggest: 'clickys:suggest', // (answers: ClickyQuizAnswers) => ClickySuggestion[] — settings › clickys › suggest
  clickysMemory: 'clickys:memory', // (clickyId) => number — how many facts that clicky remembers
  clickysForget: 'clickys:forget', // (clickyId) => void — clear that clicky's memory

  /* notch panel (src/main/notch.ts ↔ src/preload/notch.ts) */
  notchState: 'notch:state', // main → notch: NotchState
  notchReady: 'notch:ready', // notch → main: void — renderer loaded, send state
  notchExpand: 'notch:expand', // notch → main: { expanded, focus } — grow / shrink the window (focus = take keyboard)
  notchSend: 'notch:send', // notch → main (invoke): NotchSendRequest => { chatId, switched? }
  notchAction: 'notch:action', // notch → main: 'new-chat' | 'open-chats' | 'open-settings' | 'stop'
  notchCollapse: 'notch:collapse', // main → notch: void — collapse (clicked outside / esc)

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
  chatsAnswer: 'chats:answer', // (req: ChatAnswerRequest) => { chatId } — answer a choice question (ChatTurn.ask)

  /* main → chats window */
  chatsEvent: 'chats:event', // ChatEvent
  chatsChanged: 'chats:changed', // ChatSummary[] — list changed (new chat, rename, voice turn…)

  /* main → settings window */
  settingsChanged: 'settings:changed', // Settings
  settingsGoto: 'settings:goto', // string — section id to scroll to (model, voice, keys, companion, permissions, about)
  recordKeys: 'hotkey:record-keys', // KeyRecordEvent
  hotkeyHeard: 'hotkey:heard', // HotkeyHeard — a chord fired
  hotkeyStatusChanged: 'hotkey:status-changed', // HotkeyStatus
  memoryChanged: 'memory:changed', // string[]

  /* main → settings + chats windows */
  updateChanged: 'update:changed', // UpdateState
} as const;

/** The updater calls both windows expose. */
export interface UpdateApi {
  getUpdate(): Promise<UpdateState>;
  /** check github now (resolves with the state after the check) */
  checkForUpdate(): Promise<UpdateState>;
  /** download the update, install it and restart */
  installUpdate(): Promise<UpdateState>;
  /** forget the one-time "updated to …" note */
  dismissUpdateNote(): Promise<void>;
  onUpdate(cb: (s: UpdateState) => void): void;
}

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
  /** the talk chord's ink trail: start / end / clear */
  onInk(cb: (cmd: InkCommand) => void): void;
  /** a choice question is waiting (null = answered / dismissed / timed out) */
  /** cards / 3D models the reply carries (null = none; a new turn clears them) */
  onVisuals(cb: (v: ChatVisual[] | null) => void): void;
  onChoice(cb: (c: OverlayChoice | null) => void): void;
  /** the user clicked option `index` (0-based) */
  choose(index: number): void;
  /** "reply" / "something else…": open the type box under the bubble (continues the same chat) */
  openReply(): void;
  onCue(cb: (c: OverlayCue | null) => void): void;
  onHighlight(cb: (h: OverlayHighlight[] | null) => void): void;
  onHandsFree(cb: (s: HandsFreeState) => void): void;
  onWalkthrough(cb: (on: boolean) => void): void;
  /** hands-free: an utterance ended (voice activity detector) */
  handsFreeUtterance(u: HandsFreeUtterance): void;
  /** hands-free: speech started (stop the companion talking) */
  handsFreeSpeech(): void;
  /** walkthrough: the bubble was clicked */
  walkNext(): void;
  sendPttResult(r: PttResult): void;
  speechDone(): void;
  submitText(text: string): void;
  cancelText(): void;
  /** while the pointer is over the bubble, let the overlay take clicks (for dragging) */
  setInteractive(on: boolean): void;
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
export interface SettingsApi extends UpdateApi {
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
  memoryList(): Promise<string[]>;
  memorySet(facts: string[]): Promise<string[]>;
  memoryClear(): Promise<void>;
  onMemoryChanged(cb: (facts: string[]) => void): void;
  /** a short line in this voice (null = nothing to play) */
  voicePreview(provider: string, voice: string): Promise<SpeakCommand | null>;
  runRoutine(id: string): Promise<void>;
  /** settings › clickys: ask the model for up to 3 clickys that fit the quiz answers */
  suggestClickys(answers: ClickyQuizAnswers): Promise<ClickySuggestion[]>;
  /** how many facts a clicky remembers / forget them */
  clickyMemoryCount(clickyId: string): Promise<number>;
  clickyForget(clickyId: string): Promise<void>;
}

/** Exposed as `window.chats` by src/preload/chats.ts */
export interface ChatsApi extends UpdateApi {
  list(): Promise<ChatSummary[]>;
  get(id: string): Promise<Chat | null>;
  create(): Promise<Chat>;
  open(id: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** switched = the text was "switch to <name>": handled locally, nothing was sent (chatId '') */
  send(req: ChatSendRequest): Promise<{ chatId: string; switched?: string }>;
  stop(chatId: string): Promise<void>;
  active(): Promise<string | null>;
  /** agent mode: allow / cancel the actions a reply is waiting on (ChatEvent 'confirm') */
  approve(turnId: string): Promise<void>;
  deny(turnId: string): Promise<void>;
  /** answer an assistant turn's choice question (sent as the next message, like the overlay's pills) */
  answer(req: ChatAnswerRequest): Promise<{ chatId: string }>;
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

/** main → notch panel: everything it draws. */
export interface NotchState {
  clicky: { id: string; name: string; color: string };
  clickys: Array<{ id: string; name: string; color: string }>;
  phase: CompanionPhase;
  /** first line of the reply while speaking / the transcript while thinking */
  line?: string;
  expanded: boolean;
  /** the last few turns of the active chat (expanded view) */
  turns: Array<Pick<ChatTurn, 'id' | 'role' | 'text' | 'error'>>;
  chatId: string | null;
  theme: 'light' | 'dark';
  hotkeyLabel: string;
}

export interface NotchSendRequest {
  text: string;
  attachments?: ChatAttachment[];
  includeScreen: boolean;
}

/** Exposed as `window.notch` by src/preload/notch.ts */
export interface NotchApi {
  onState(cb: (s: NotchState) => void): void;
  onCollapse(cb: () => void): void;
  ready(): void;
  /** grow / shrink the window; focus = it needs the keyboard (typing) */
  setExpanded(expanded: boolean, focus: boolean): void;
  send(req: NotchSendRequest): Promise<{ chatId: string; switched?: string }>;
  action(a: 'new-chat' | 'open-chats' | 'open-settings' | 'stop'): void;
  /** switch the active clicky */
  switchClicky(id: string): Promise<void>;
}

declare global {
  interface Window {
    overlay: OverlayApi;
    clicky: SettingsApi;
    chats: ChatsApi;
    notch: NotchApi;
  }
}
