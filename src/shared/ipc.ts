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
  PttStartRequest,
  SpeechTiming,
  TurnTiming,
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
  ClickyCreateResult,
  CompanionPhase,
  OverlayBusy,
  QuizReviewItem,
  WakeState,
  WakeHeard,
  WakeStatus,
  OverlayTip,
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
  overlayPttStart: 'overlay:ptt-start', // PttStartRequest | undefined — start recording mic
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
  overlayBusy: 'overlay:busy', // OverlayBusy | null — busy: "esc to stop" line + stop button (paused: continue / stop)
  overlayDismiss: 'overlay:dismiss', // void — hide the bubble now (the stop key over a lingering reply)
  overlayWake: 'overlay:wake', // WakeState — the "hey clickity" listener (wake-word.ts)
  overlayTip: 'overlay:tip', // OverlayTip | null — a proactive tip: dot on the companion / open in the tip bubble (tips.ts)

  /* overlay → main (ipcRenderer.send) */
  pttResult: 'ptt:result', // PttResult
  speechDone: 'overlay:speech-done', // string | undefined (utt) — finished playing an utterance (or was stopped)
  pttAudio: 'ptt:audio', // ArrayBuffer — 16 kHz mono int16 PCM, streamed while recording (PttStartRequest.stream)
  speechTiming: 'overlay:speech-timing', // SpeechTiming — first audio of an utterance, kokoro status
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
  overlayStop: 'overlay:stop', // void — the bubble's stop button (same as the stop key: pauses an agent run)
  overlayContinue: 'overlay:continue', // void — paused agent run: "continue"
  overlayBubble: 'overlay:bubble', // boolean — the reply bubble is showing / gone (idle: the stop key dismisses it)
  wakeHeard: 'wake:heard', // WakeHeard — the wake listener heard its name (or the follow-up question)
  wakeStatus: 'wake:status', // WakeStatus — the wake listener's state (mic blocked, model loading, checks)
  tipOpen: 'tip:open', // string (tip id) — the tip dot was clicked
  tipAction: 'tip:action', // 'close' | 'not-now' | 'stop' — the tip bubble's buttons
  overlayUndo: 'overlay:undo', // void — the bubble's "undo" (agent mode just acted)

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
  quizReviewList: 'quiz:review-list', // () => QuizReviewItem[] — what the user missed in quizzes (active clicky)
  quizReviewRemove: 'quiz:review-remove', // (text) => QuizReviewItem[] — drop one item
  quizReviewClear: 'quiz:review-clear', // () => void — clear the review list
  voicePreview: 'speech:preview', // (provider, voice) => SpeakCommand | null — a short line in that voice (settings plays it)
  latencyGet: 'speech:latency', // () => LatencyInfo — the last voice turn's timing + the current pipeline summary
  routineRun: 'routines:run', // (id) => void — run a routine now
  wakeStatusGet: 'wake:status-get', // () => WakeStatus — settings › voice › wake word
  tipsStatusGet: 'tips:status-get', // () => string — settings › companion › tips: a quiet line ("1 tip in the last hour")

  /* privacy, usage, undo (src/main/safety.ts) */
  usageGet: 'usage:get', // () => UsageSummary — settings › usage
  usageReset: 'usage:reset', // () => UsageSummary — forget the recorded usage
  privacyCheck: 'privacy:check', // () => PrivacyCheck — what clickity can see right now (settings › privacy)
  privacyPrivate: 'privacy:private', // (minutes: number) => number — private mode for n minutes (0 = off) → privateUntil
  chatsUndo: 'chats:undo', // (chatId) => UndoResult — the chats window's "undo" under an agent run

  clickysCreate: 'clickys:create', // (description: string) => ClickyCreateResult — settings › clickys › "make a clicky"
  clickysSuggest: 'clickys:suggest', // (answers: ClickyQuizAnswers) => ClickySuggestion[] — settings › clickys › suggest
  clickysMemory: 'clickys:memory', // (clickyId) => number — how many facts that clicky remembers
  clickysForget: 'clickys:forget', // (clickyId) => void — clear that clicky's memory

  /* notch panel (src/main/notch.ts ↔ src/preload/notch.ts) */
  notchState: 'notch:state', // main → notch: NotchState
  notchReady: 'notch:ready', // notch → main: void — renderer loaded, send state
  notchExpand: 'notch:expand', // notch → main: { expanded, focus } — grow / shrink the window (focus = take keyboard)
  notchSend: 'notch:send', // notch → main (invoke): NotchSendRequest => { chatId, switched? }
  notchAction: 'notch:action', // notch → main: 'new-chat' | 'open-chats' | 'open-settings' | 'stop' | 'pause' | 'continue'
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
  chatsStop: 'chats:stop', // (chatId) => void — stop whatever runs in that chat (reply, speech, voice turn, agent run)
  chatsPause: 'chats:pause', // (chatId) => void — agent run: pause after the current action
  chatsResume: 'chats:resume', // (chatId) => void — paused agent run: continue (fresh screenshot)
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
  quizReviewChanged: 'quiz:review-changed', // QuizReviewItem[]
  wakeStatusChanged: 'wake:status-changed', // WakeStatus

  /* main → settings + chats windows */
  updateChanged: 'update:changed', // UpdateState
} as const;

/** settings › usage: what the meter recorded (src/main/usage.ts). Costs are estimates in USD. */
export interface UsageTotals {
  calls: number;
  input: number;
  output: number;
  cached: number;
  /** estimated USD for api calls with a known price */
  cost: number;
  /** api calls whose model has no known price (tokens counted, cost unknown) */
  unpriced: number;
}

export interface UsageModelRow extends UsageTotals {
  /** provider kind, or 'speech' */
  provider: string;
  model: string;
  billing: 'api' | 'subscription' | 'local';
  /** speech: characters spoken / seconds transcribed */
  chars?: number;
  seconds?: number;
}

export interface UsageSummary {
  today: UsageTotals;
  month: UsageTotals;
  /** this month, biggest cost first */
  byModel: UsageModelRow[];
  /** the last 30 days' estimated cost, oldest first ("YYYY-MM-DD") */
  days: Array<{ day: string; cost: number }>;
  monthlyLimit: number;
  overLimit: boolean;
  /** "prices are estimates (table from 2026-11) — check your provider's bill" */
  priceNote: string;
}

/** settings › privacy › "check now": what the never-capture list sees this moment. */
export interface PrivacyCheck {
  /** focused app as detected ('' = can't tell) */
  front: string;
  /** a never-capture entry matched: why clickity wouldn't look now */
  blocked: string | null;
  /** how many other windows could be read (-1 = window list unavailable on this system) */
  windows: number;
  /** honest per-platform line: what can and can't be detected here */
  detail: string;
}

/** The result of an undo request (chats window / bubble). */
export interface UndoResult {
  ok: boolean;
  /** short lowercase line: what it did / why it couldn't */
  message: string;
}

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
  onPttStart(cb: (req?: PttStartRequest) => void): void;
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
  /** busy: show the stop hint + button (null = idle) */
  onBusy(cb: (b: OverlayBusy | null) => void): void;
  /**
   * the bubble's stop button (pauses an agent run, like the stop key); hard = the × close button:
   * always stops (speech, stream, walkthrough, agent run) and dismisses a waiting choice
   */
  stop(hard?: boolean): void;
  /** the bubble is showing / gone (main grabs the stop key while a finished reply lingers) */
  bubbleVisible(on: boolean): void;
  /** main: hide the bubble now (the stop key over a lingering reply) */
  onDismiss(cb: () => void): void;
  /** paused agent run: continue */
  resume(): void;
  /** agent mode just acted: undo it (the bubble's "undo") */
  undo(): void;
  /** hands-free: an utterance ended (voice activity detector) */
  handsFreeUtterance(u: HandsFreeUtterance): void;
  /** hands-free: speech started (stop the companion talking) */
  handsFreeSpeech(): void;
  /** walkthrough: the bubble was clicked */
  walkNext(): void;
  sendPttResult(r: PttResult): void;
  /** streamed recording: 16 kHz mono int16 PCM */
  pttAudio(pcm: ArrayBuffer): void;
  speechDone(utt?: string): void;
  speechTiming(t: SpeechTiming): void;
  submitText(text: string): void;
  cancelText(): void;
  /** while the pointer is over the bubble, let the overlay take clicks (for dragging) */
  setInteractive(on: boolean): void;
  ready(): void;
  /** diagnostic line for clickity.log */
  log(entry: OverlayLogEntry): void;
  /** status while a ptt result is pending (model download %, loading…) */
  pttProgress(note: string): void;
  /** wake word: listen / pause / follow-up (wake-word.ts) */
  onWake(cb: (s: WakeState) => void): void;
  /** wake word: heard the name (or the question after it) */
  wakeHeard(h: WakeHeard): void;
  wakeStatus(st: WakeStatus): void;
  /** proactive tip waiting / open (null = none) */
  onTip(cb: (t: OverlayTip | null) => void): void;
  /** the tip dot was clicked */
  tipOpen(id: string): void;
  tipAction(action: 'close' | 'not-now' | 'stop'): void;
}

/** settings › voice "speed" summary + about › diagnostics. */
export interface LatencyInfo {
  /** e.g. "streaming transcription · claude haiku · natural voice" */
  pipeline: string;
  /** rough expected key-up → first words, ms */
  estimateMs: number;
  /** the fastest settings available with the keys already saved (null = already fastest) */
  fastest: DeepPartial<Settings> | null;
  /** what "make it fast" would change, in words */
  fastestNote: string;
  /** keys that would make it faster ("a deepgram or groq key: transcripts in ~0.3 s") */
  hints: string[];
  last: TurnTiming | null;
  /** on-device natural voice status ("ready", "downloading 42%") */
  kokoro?: string;
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
  /** quiz mode: things missed in quizzes, asked first next time (settings › memory › to review) */
  quizReviewList(): Promise<QuizReviewItem[]>;
  quizReviewRemove(text: string): Promise<QuizReviewItem[]>;
  quizReviewClear(): Promise<void>;
  onQuizReviewChanged(cb: (items: QuizReviewItem[]) => void): void;
  /** a short line in this voice (null = nothing to play) */
  voicePreview(provider: string, voice: string): Promise<SpeakCommand | null>;
  /** settings › voice speed summary and about › diagnostics latency line */
  latency(): Promise<LatencyInfo>;
  runRoutine(id: string): Promise<void>;
  /** settings › usage */
  usage(): Promise<UsageSummary>;
  usageReset(): Promise<UsageSummary>;
  /** settings › privacy: what the never-capture list sees right now */
  privacyCheck(): Promise<PrivacyCheck>;
  /** private mode for `minutes` (0 = off); resolves with privateUntil */
  setPrivate(minutes: number): Promise<number>;
  /** settings › clickys: ask the model for up to 3 clickys that fit the quiz answers */
  suggestClickys(answers: ClickyQuizAnswers): Promise<ClickySuggestion[]>;
  /** describe a clicky in your own words; it's written by the cheapest model you have set up */
  createClickys(description: string): Promise<ClickyCreateResult>;
  /** how many facts a clicky remembers / forget them */
  clickyMemoryCount(clickyId: string): Promise<number>;
  clickyForget(clickyId: string): Promise<void>;
  /** settings › voice › wake word: what the listener is doing */
  wakeStatus(): Promise<WakeStatus>;
  onWakeStatus(cb: (s: WakeStatus) => void): void;
  /** settings › companion › tips: a quiet status line */
  tipsStatus(): Promise<string>;
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
  /** agent run: pause after the current action / continue a paused run */
  pause(chatId: string): Promise<void>;
  resume(chatId: string): Promise<void>;
  active(): Promise<string | null>;
  /** agent mode: allow / cancel the actions a reply is waiting on (ChatEvent 'confirm') */
  approve(turnId: string): Promise<void>;
  deny(turnId: string): Promise<void>;
  /** answer an assistant turn's choice question (sent as the next message, like the overlay's pills) */
  answer(req: ChatAnswerRequest): Promise<{ chatId: string }>;
  /** undo the last agent-mode actions in this chat (local where it can, else the model reverses them) */
  undo(chatId: string): Promise<UndoResult>;
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
  /** clickity is busy (stop button); 'pause' = an agent run (pause button), 'paused' = continue / stop */
  busy?: 'stop' | 'pause' | 'paused' | null;
  /** the stop key's label ("esc") */
  stopLabel?: string;
  /** "private for 10 min": screen capture off until this epoch ms (0 / missing = off) */
  privateUntil?: number;
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
  action(a: 'new-chat' | 'open-chats' | 'open-settings' | 'stop' | 'pause' | 'continue' | 'private'): void;
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
