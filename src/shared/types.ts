// Shared contract between main, preload and renderer code.
// Every module in this app depends on these shapes. Change them only deliberately.
import type { ChatVisual } from './visuals';

/* ───────────────────────── providers ───────────────────────── */

/**
 * Where the "brain" comes from.
 *  - *-subscription: drives the user's locally installed, officially signed-in CLI
 *    (Claude Code `claude`, OpenAI `codex`, Google `gemini`) in headless mode, so the
 *    request is billed to the user's existing Claude Pro/Max, ChatGPT Plus/Pro or
 *    Google AI plan. No API key required.
 *  - *-api / openrouter: direct HTTPS calls with the user's API key.
 *  - local: any OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM…).
 */
export type ProviderKind =
  | 'claude-subscription'
  | 'chatgpt-subscription'
  | 'gemini-subscription'
  | 'anthropic-api'
  | 'openai-api'
  | 'gemini-api'
  | 'openrouter'
  | 'local';

export const PROVIDER_KINDS: ProviderKind[] = [
  'claude-subscription',
  'chatgpt-subscription',
  'gemini-subscription',
  'anthropic-api',
  'openai-api',
  'gemini-api',
  'openrouter',
  'local',
];

export type ProviderGroup = 'subscription' | 'api' | 'local';

/** Static metadata the settings UI uses to render a provider row. */
export interface ProviderMeta {
  kind: ProviderKind;
  label: string; // lowercase UI label, e.g. "claude (subscription)"
  group: ProviderGroup;
  description: string; // one short muted line
  /** which config fields the UI should show for this provider */
  fields: Array<'apiKey' | 'baseUrl' | 'cliPath'>;
  /** default model id if the user hasn't picked one */
  defaultModel: string;
  /** login/setup help: shell command shown to the user (subscription CLIs) */
  setupCommand?: string;
  docsUrl?: string;
}

export const PROVIDER_META: Record<ProviderKind, ProviderMeta> = {
  'claude-subscription': {
    kind: 'claude-subscription',
    label: 'claude',
    group: 'subscription',
    description: 'uses your claude pro / max plan through claude code',
    fields: ['cliPath'],
    defaultModel: 'sonnet',
    setupCommand: 'npm i -g @anthropic-ai/claude-code && claude',
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
  },
  'chatgpt-subscription': {
    kind: 'chatgpt-subscription',
    label: 'chatgpt',
    group: 'subscription',
    description: 'uses your chatgpt plus / pro plan through codex cli',
    fields: ['cliPath'],
    defaultModel: 'gpt-6.1-sol',
    setupCommand: 'npm i -g @openai/codex && codex login',
    docsUrl: 'https://github.com/openai/codex',
  },
  'gemini-subscription': {
    kind: 'gemini-subscription',
    label: 'gemini',
    group: 'subscription',
    description: 'uses your google account / ai pro plan through gemini cli',
    fields: ['cliPath'],
    defaultModel: 'gemini-3.8-flash',
    setupCommand: 'npm i -g @google/gemini-cli && gemini',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  'anthropic-api': {
    kind: 'anthropic-api',
    label: 'anthropic api',
    group: 'api',
    description: 'claude models with an anthropic api key',
    fields: ['apiKey'],
    defaultModel: 'claude-sonnet-5-5',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  'openai-api': {
    kind: 'openai-api',
    label: 'openai api',
    group: 'api',
    description: 'gpt models with an openai api key',
    fields: ['apiKey'],
    defaultModel: 'gpt-6.1-sol',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  'gemini-api': {
    kind: 'gemini-api',
    label: 'gemini api',
    group: 'api',
    description: 'gemini models with a google ai studio key',
    fields: ['apiKey'],
    defaultModel: 'gemini-3.8-flash',
    docsUrl: 'https://aistudio.google.com/apikey',
  },
  openrouter: {
    kind: 'openrouter',
    label: 'openrouter',
    group: 'api',
    description: 'hundreds of models behind one key',
    fields: ['apiKey'],
    defaultModel: 'anthropic/claude-sonnet-5.5',
    docsUrl: 'https://openrouter.ai/keys',
  },
  local: {
    kind: 'local',
    label: 'local',
    group: 'local',
    description: 'ollama, lm studio or any openai-compatible server',
    fields: ['baseUrl', 'apiKey'],
    defaultModel: 'gemma4:12b',
  },
};

export interface ProviderConfig {
  apiKey?: string; // stored encrypted at rest by settings-store
  baseUrl?: string; // local: e.g. http://localhost:11434/v1
  cliPath?: string; // override path to claude / codex / gemini binary
}

export interface ModelInfo {
  id: string;
  label?: string;
  /** false if the model is known not to accept images */
  vision?: boolean;
}

export interface ProviderStatus {
  ok: boolean;
  /** short lowercase line for the UI, e.g. "signed in · claude code 2.1.0" or "claude not found on PATH" */
  detail: string;
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

/* ───────────────────────── conversation ───────────────────────── */

export interface ImageInput {
  mime: 'image/png' | 'image/jpeg';
  base64: string;
  /** absolute path of the same image written to a temp file (CLI providers need a path) */
  path: string;
  /** human label the model sees, e.g. "screen 1 (cursor is here)" */
  label: string;
  width: number; // pixel size of the encoded image
  height: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  /** only the newest user turn carries screenshots */
  images?: ImageInput[];
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  model: string;
  signal: AbortSignal;
}

/* ───────────────────────── speech ───────────────────────── */

/**
 * on-device: whisper running in the overlay renderer via transformers.js (no key, works with subscriptions)
 * openai / groq: whisper over HTTPS (key reused from openai-api or set here)
 * gemini: gemini api audio understanding (key reused from gemini-api)
 * local: any OpenAI-compatible /audio/transcriptions server (whisper.cpp, speaches…)
 */
export type SttProvider = 'on-device' | 'openai' | 'groq' | 'gemini' | 'local';
export type TtsProvider = 'system' | 'openai' | 'elevenlabs' | 'off';

export interface SpeechSettings {
  stt: {
    provider: SttProvider;
    /** on-device: Xenova/whisper-base.en etc; openai: gpt-transcribe; groq: whisper-large-v3-turbo */
    model: string;
    apiKey?: string; // optional override (else reuse matching provider key)
    baseUrl?: string; // for 'local'
    language?: string; // ISO code or '' for auto
    /** microphone deviceId ('' / undefined = system default); falls back to the default when missing */
    micId?: string;
  };
  tts: {
    provider: TtsProvider;
    voice: string; // system: voice name ('' = default); openai: 'alloy'…; elevenlabs: voice id
    model?: string; // openai: gpt-4o-mini-tts; elevenlabs: eleven_flash_v2_5
    apiKey?: string; // elevenlabs key, or override for openai
    rate: number; // 0.5 – 2
  };
}

/* ───────────────────────── hotkeys ───────────────────────── */

/**
 * Canonical key names. Modifiers are side-agnostic: 'Control' | 'Alt' | 'Shift' | 'Meta', plus
 * 'Fn' — the mac fn / globe key, heard through a small helper (src/main/fn-key.ts); it counts as a
 * modifier. Windows / Linux never see fn (keyboard firmware handles it).
 * Every other key uses the DOM KeyboardEvent.code value: 'Space', 'KeyA', 'Digit1', 'F5',
 * 'Backquote', 'Escape', 'Enter', 'Tab', 'ArrowUp', … The settings UI records keys with
 * KeyboardEvent.code; the hotkey module maps uiohook keycodes to the same names.
 */
export type KeyName = string;

export interface HotkeySettings {
  /** push-to-talk chord. default: Control + Fn on mac (see settings-store platformDefaults), Control + Alt elsewhere */
  talk: KeyName[];
  /** 'hold' = talk while held, release to send. 'toggle' = press once to start, again to send */
  mode: 'hold' | 'toggle';
  /** open a small text box next to the companion instead of speaking. default: Control + Alt + Space (control + option + space on mac) */
  type: KeyName[];
  /**
   * dictation: hold, speak, release → the words are typed into the focused app (no model call).
   * Hold alt / option with it to draft a reply instead. default: Fn + Shift on mac,
   * Control + Shift + Space elsewhere. [] = off.
   */
  dictate: KeyName[];
  /**
   * a second way to open the type box. A chord, or a tap binding: ['DoubleTap', key] /
   * ['TripleTap', key] (press and release that key alone, 2 / 3 times within 300ms).
   * default: double-tap control. [] = off.
   */
  typeTap: KeyName[];
  /** toggle hands-free (always listening) mode. default: triple-tap control. [] = off. */
  alwaysOn: KeyName[];
}

/* ───────────────────────── settings ───────────────────────── */

export type Theme = 'system' | 'light' | 'dark';

export interface CompanionSettings {
  /** follow the mouse. if false the companion parks in the bottom-right corner */
  followCursor: boolean;
  /**
   * when the companion (the arrow) is drawn. 'always' = always; 'active' = only while it
   * listens / thinks / speaks / acts / points, hidden while idle; 'never' = no arrow at all,
   * but it still tracks the cursor invisibly so the reply bubble opens there.
   */
  show: 'always' | 'active' | 'never';
  /** px offset from the cursor tip */
  offsetX: number;
  offsetY: number;
  /** 0.5 – 2.5 */
  scale: number;
  /** companion color as #rrggbb; '' = follow the theme (ink) */
  color: string;
  /** show streamed reply text in a bubble next to the companion */
  showBubble: boolean;
  /** let the companion fly to and point at things on screen */
  pointing: boolean;
  /**
   * agent mode: let clickity act on the screen (click, type, keys, scroll).
   * 'ask' = show what it wants to do and wait for enter (esc cancels); 'auto' = just do it;
   * 'off' = never act, only point.
   */
  actions: 'off' | 'ask' | 'auto';
  /** max act → look → act steps in one agent run */
  maxSteps: number;
  /** show the sentence being spoken near the cursor, even when the reply bubble is off */
  captions?: boolean;
  /** when the voice is off, put each spoken-style answer on the clipboard ("copied") */
  autoCopy?: boolean;
  /**
   * the notch panel: a small black pill pinned top-centre of the cursor's display (under the
   * menu bar / notch). 'off' (default) · 'hover' = appears when the cursor touches the top
   * centre · 'always' = always visible.
   */
  notch?: 'off' | 'hover' | 'always';
}

/** Dictation: custom words (fed to whisper as a prompt), replacements, learned corrections. */
export interface DictationSettings {
  /** names / jargon whisper should expect ("Clickity, Bndrwe") */
  words: string[];
  /** applied after transcription, case-insensitive whole words: "clicky tea" → "clickity" */
  replacements: Array<{ from: string; to: string }>;
  /** corrections noticed while dictating, waiting for the user to accept in settings */
  suggestions: Array<{ from: string; to: string }>;
  /** notice "you re-dictated one word" corrections and offer them in settings */
  autoLearn: boolean;
  /** em / en dashes in dictated text */
  dashes: 'keep' | 'comma' | 'hyphen';
}

/** "every [days] at [time]: [prompt]" — runs as a normal turn into a new chat. */
export interface Routine {
  id: string;
  /** 0 = sunday … 6 = saturday */
  days: number[];
  /** "HH:MM", local 24h */
  time: string;
  prompt: string;
  /** take screenshots like a voice turn */
  screen: boolean;
  /** read the result aloud */
  speak: boolean;
  enabled: boolean;
  createdAt?: number;
  /** epoch ms of the last run (successful or not) */
  lastRun?: number;
  /** consecutive failures; 3 pauses the routine (enabled = false, paused = true) */
  failures?: number;
  paused?: boolean;
  lastError?: string;
}

export interface Settings {
  version: 1;
  provider: ProviderKind;
  /** selected model per provider */
  models: Record<ProviderKind, string>;
  providers: Record<ProviderKind, ProviderConfig>;
  speech: SpeechSettings;
  hotkeys: HotkeySettings;
  companion: CompanionSettings;
  theme: Theme;
  /** extra instructions appended to the system prompt */
  customInstructions: string;
  /** how many previous turns to keep as context (text only) */
  historyTurns: number;
  launchAtLogin: boolean;
  /** first-run onboarding finished */
  onboarded: boolean;
  dictation: DictationSettings;
  /** facts the companion remembers across chats ([REMEMBER:…]; stored in userData/memory.json) */
  memory: { enabled: boolean };
  /** hands-free: the mic is always on; speech (voice activity) starts a turn */
  handsFree: { enabled: boolean };
  routines: Routine[];
  /** mac: show the dock icon (the menu bar icon is always there) */
  showInDock: boolean;
  /** what to call the user in greetings (optional, at most 40 characters) */
  userName: string;
  /** named companions ("clickys"); always at least one (migrated users get "clickity") */
  clickys: Clicky[];
  /** id of the clicky voice / type / chats turns talk to */
  activeClicky: string;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  provider: 'claude-subscription',
  models: Object.fromEntries(
    Object.values(PROVIDER_META).map((m) => [m.kind, m.defaultModel]),
  ) as Record<ProviderKind, string>,
  providers: {
    'claude-subscription': {},
    'chatgpt-subscription': {},
    'gemini-subscription': {},
    'anthropic-api': {},
    'openai-api': {},
    'gemini-api': {},
    openrouter: {},
    local: { baseUrl: 'http://localhost:11434/v1' },
  },
  speech: {
    stt: { provider: 'on-device', model: 'Xenova/whisper-base.en', language: '' },
    tts: { provider: 'system', voice: '', rate: 1.05 },
  },
  hotkeys: {
    talk: ['Control', 'Alt'],
    mode: 'hold',
    type: ['Control', 'Alt', 'Space'],
    dictate: ['Control', 'Shift', 'Space'],
    typeTap: ['DoubleTap', 'Control'],
    alwaysOn: ['TripleTap', 'Control'],
  },
  companion: { followCursor: true, show: 'always', offsetX: 18, offsetY: 20, scale: 1, color: '', showBubble: true, pointing: true, actions: 'ask', maxSteps: 8, captions: false, autoCopy: true, notch: 'off' },
  theme: 'system',
  customInstructions: '',
  historyTurns: 6,
  launchAtLogin: false,
  onboarded: false,
  dictation: { words: [], replacements: [], suggestions: [], autoLearn: true, dashes: 'keep' },
  memory: { enabled: true },
  handsFree: { enabled: false },
  routines: [],
  showInDock: true,
  userName: '',
  clickys: [],
  activeClicky: 'clickity',
};

/* ───────────────────────── clickys (named companions) ───────────────────────── */

/**
 * A named companion. Each has its own name, persona, optional brain / voice override, memory
 * (userData/memory.json for the default one, memory-<id>.json otherwise) and chats (Chat.clickyId).
 */
export interface Clicky {
  /** stable id ([a-z0-9-], ≤ 32); the default / migrated one is 'clickity' */
  id: string;
  /** shown lowercase in the ui; the model is told "You are <name>" */
  name: string;
  /** mark + companion color #rrggbb ('' = ink); the active clicky's color is companion.color */
  color: string;
  /** personality / instructions, added to the system prompt */
  persona: string;
  /** brain override (unset = the global provider / model) */
  provider?: ProviderKind;
  model?: string;
  /** voice override (unset = settings.speech.tts) */
  voice?: { provider: TtsProvider; voice: string };
  createdAt?: number;
}

/** "suggest clickys for me": the three quick multiple-choice answers sent to the model. */
export interface ClickyQuizAnswers {
  use: string;
  stuck: string;
  tone: string;
}

/** One proposed clicky (settings › clickys › suggest). */
export interface ClickySuggestion {
  name: string;
  persona: string;
  color: string;
  /** one short line: why this one fits the answers */
  why: string;
}

/** Recursive partial used for settings patches. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends any[] ? T[K] : DeepPartial<T[K]>) : T[K] };

/* ───────────────────────── permissions ───────────────────────── */

export type PermissionKind = 'microphone' | 'screen' | 'accessibility';
export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';
export type PermissionsStatus = Record<PermissionKind, PermissionState>;

/* ───────────────────────── overlay ───────────────────────── */

export type CompanionPhase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'acting' | 'error';

export interface OverlayState {
  phase: CompanionPhase;
  /** the user's transcribed words (shown briefly while thinking) */
  transcript?: string;
  /** visible reply text so far (POINT tags already stripped) */
  reply?: string;
  error?: string;
  /** short status line in the bubble while listening / transcribing, e.g. "downloading the voice model… 42%" */
  note?: string;
  /** agent mode: actions waiting for approval ("click save · type hello") — bubble shows "enter to allow · esc to cancel" */
  confirm?: string;
  /** agent mode: "step 2 of 8" while acting */
  step?: string;
  /** agent mode confirm: also offer "a = always allow" */
  confirmAlways?: boolean;
}

/**
 * A choice question waiting for the user (main → overlay, IPC.overlayChoice; null = none).
 * The bubble shows the reply with numbered option pills and "something else…".
 */
export interface OverlayChoice {
  /** the reply text (it ends with the question) */
  reply: string;
  question: string;
  options: string[];
  /** digit keys are grabbed (press 1–N) */
  keys: boolean;
}

/** A point in overlay-window-local DIP coordinates. */
export interface OverlayPoint {
  x: number;
  y: number;
  label: string;
}

/** What the overlay should do on ptt stop. */
export interface PttStopRequest {
  /** if 'on-device', the renderer transcribes locally and returns text; otherwise it returns wav */
  stt: SpeechSettings['stt'];
  /** dictionary words as a whisper prompt (on-device: best effort) */
  prompt?: string;
}

/** A tiny status pill at the cursor (dictation "listening" / "typed", hands-free…). null = hide. */
export interface OverlayCue {
  text: string;
  kind: 'listening' | 'working' | 'done' | 'error' | 'info';
  /** ms before it fades on its own (0 = stays until replaced) */
  ttl: number;
}

/** A soft rounded outline drawn around something on screen ([HIGHLIGHT:…]); overlay-local DIP. */
export interface OverlayHighlight {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

/** main → overlay: hands-free (always listening) state. */
export interface HandsFreeState {
  /** hands-free is on (every overlay shows the cue) */
  on: boolean;
  /** this overlay owns the always-on mic */
  mic: boolean;
  /** listening right now (false while the companion speaks / thinks, plus a short tail) */
  listening: boolean;
  /** the companion is replying: with headphones the renderer keeps listening so speech interrupts it */
  bargeIn?: boolean;
}

/** overlay → main: one utterance heard in hands-free mode (text = on-device, else wav). */
export interface HandsFreeUtterance {
  text?: string;
  wav?: ArrayBuffer;
  durationMs: number;
  peak?: number;
  error?: string;
}

export interface PttResult {
  /** 16 kHz mono 16-bit PCM WAV, when the renderer did not transcribe itself */
  wav?: ArrayBuffer;
  /** transcript when transcribed on-device */
  text?: string;
  error?: string;
  /** recording length; very short presses (< 250ms) are treated as accidental */
  durationMs: number;
  /** loudest sample of the recording, 0..1 (diagnostics + "only silence" detection) */
  peak?: number;
  /** on-device transcription time */
  sttMs?: number;
  /** on-device backend that transcribed it */
  sttDevice?: string;
  /** what went wrong, when `error` is set: mic = recording, model = voice model load, stt = transcription */
  errorKind?: 'mic' | 'model' | 'stt';
}

/**
 * The ink trail drawn on every overlay while the talk chord is held (main → overlay).
 * 'start' = begin a new trail at the cursor; 'end' = stop extending it (keep it visible);
 * 'clear' = the screenshots are taken: fade it out.
 */
export type InkCommand = 'start' | 'end' | 'clear';

export type SpeakCommand =
  | { mode: 'system'; text: string; voice: string; rate: number }
  | { mode: 'audio'; mime: string; data: ArrayBuffer };

/** Settings slice the overlay needs to render. */
export interface OverlayConfig {
  companion: CompanionSettings;
  theme: Theme;
  /** the overlay's display bounds in global DIP, so it can tell whether the cursor is on it */
  displayBounds: { x: number; y: number; width: number; height: number };
  hotkeyLabel: string; // e.g. "ctrl + option"
  /** speech-to-text settings, so the overlay can warm up the on-device model */
  stt?: SpeechSettings['stt'];
  /** this overlay should preload the on-device model in the background (one overlay does) */
  preloadStt?: boolean;
}

/* ───────────────────────── chat history ───────────────────────── */

/** One message in a stored chat. Screenshots are never stored, only a count. */
export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: number; // epoch ms
  /** how the user turn arrived: held the talk key, the overlay type box, or the chats window */
  source?: 'voice' | 'type' | 'window';
  /** number of screenshots sent with this user turn */
  screenshots?: number;
  /** names of attachments sent from the chats window */
  attachments?: string[];
  /** labels the companion pointed at (assistant turns) */
  points?: string[];
  /** agent mode: what this step did on screen, past tense ("clicked save", "typed hello") */
  actions?: string[];
  /** user turns: what they did with the cursor while talking ("circled an area on screen 1") */
  gesture?: string;
  provider?: ProviderKind;
  model?: string;
  /** assistant turn failed; text holds whatever streamed before the error */
  error?: string;
  /**
   * assistant turns: the reply ended with a choice question ([ASK:question|option|…]). The
   * options show as buttons; `answered` is what the user picked or said next.
   */
  ask?: ChatAsk;
  /** assistant turns: a 2D card / 3D models the reply carried ([CARD:…] / [MODEL3D:…]) */
  visuals?: ChatVisual[];
}

/** A choice question an assistant turn asked (2–5 short options). */
export interface ChatAsk {
  question: string;
  options: string[];
  /** the user's answer (an option, or whatever they typed / said instead) */
  answered?: string;
  /** not answered: dismissed with esc, timed out, or the user moved on to something else */
  dismissed?: boolean;
}

export interface ChatSummary {
  id: string;
  title: string; // first user message, trimmed (or a user rename)
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  preview: string; // last assistant reply, trimmed to ~120 chars
  /** the clicky this chat belongs to (older chats: none = the default clicky) */
  clickyId?: string;
}

export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: ChatTurn[];
  /** the clicky this chat belongs to (older chats: none = the default clicky) */
  clickyId?: string;
}

/** An image or text file attached in the chats window composer. */
export interface ChatAttachment {
  name: string;
  mime: string; // image/png, image/jpeg, image/webp, text/plain…
  base64: string;
}

export interface ChatSendRequest {
  chatId: string | null; // null → start a new chat
  text: string;
  /** also capture the screens, like a voice turn */
  includeScreen: boolean;
  attachments?: ChatAttachment[];
  /** override the provider/model for this message (defaults to settings) */
  provider?: ProviderKind;
  model?: string;
  /** no reply bubble at the cursor (the notch panel shows the reply itself) */
  noBubble?: boolean;
}

/** Chats window: answer an assistant turn's choice question (ChatTurn.ask) with an option or free text. */
export interface ChatAnswerRequest {
  chatId: string;
  /** the assistant turn that asked */
  turnId: string;
  text: string;
  /** used when the question is no longer pending (falls back to a normal message): share the screen */
  includeScreen?: boolean;
}

/** Streamed back to the chats window while a reply is generated. */
export type ChatEvent =
  | { type: 'user'; chatId: string; turn: ChatTurn } // user turn stored (voice or window)
  | { type: 'start'; chatId: string; turnId: string } // assistant turn begins
  | { type: 'delta'; chatId: string; turnId: string; text: string } // full visible text so far
  | { type: 'done'; chatId: string; turn: ChatTurn }
  | { type: 'error'; chatId: string; turnId: string; error: string }
  /**
   * agent mode: the assistant turn `turnId` wants to act. pending=true → show "allow / cancel"
   * (chats.approve / chats.deny); pending=false → settled (outcome says how).
   */
  | { type: 'confirm'; chatId: string; turnId: string; summary: string; pending: boolean; outcome?: 'allowed' | 'cancelled' | 'timeout'; always?: boolean }
  /** agent mode: acting on screen ("step 2 of 8"); step null = the agent run is over */
  | { type: 'acting'; chatId: string; turnId: string; step: string | null }
  /** a stored turn changed after the fact (e.g. its choice question was answered: turn.ask.answered) */
  | { type: 'turn'; chatId: string; turn: ChatTurn };

/* ───────────────────────── agent mode (input control) ───────────────────────── */

/**
 * One thing clickity does with the user's mouse/keyboard. Coordinates are GLOBAL DIP
 * (Electron screen coordinates), already mapped from screenshot pixels by conversation.ts.
 */
export type InputAction =
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right'; count?: 1 | 2; label?: string }
  | { type: 'move'; x: number; y: number }
  | { type: 'scroll'; x: number; y: number; dy: number; dx?: number } // dy in lines, + = down
  | { type: 'type'; text: string }
  | { type: 'key'; keys: KeyName[] } // canonical KeyName chord, e.g. ['Meta','KeyS'] or ['Enter']
  | { type: 'wait'; ms: number };

export interface InputStatus {
  ok: boolean;
  /** 'native' (mac swift helper / windows SendInput / linux xdotool) */
  backend: string;
  /** short lowercase reason when !ok, e.g. "needs accessibility", "install xdotool" */
  detail: string;
}

/** settings › clickys › "make a clicky": what the model wrote and which (cheapest) model wrote it */
export interface ClickyCreateResult {
  suggestions: ClickySuggestion[];
  /** e.g. "local · qwen3-vl:8b" or "gemini · gemini-3.5-flash-lite" */
  via: string;
}
