// Shared contract between main, preload and renderer code.
// Every module in this app depends on these shapes. Change them only deliberately.

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
    defaultModel: 'gpt-5',
    setupCommand: 'npm i -g @openai/codex && codex login',
    docsUrl: 'https://github.com/openai/codex',
  },
  'gemini-subscription': {
    kind: 'gemini-subscription',
    label: 'gemini',
    group: 'subscription',
    description: 'uses your google account / ai pro plan through gemini cli',
    fields: ['cliPath'],
    defaultModel: 'gemini-2.5-flash',
    setupCommand: 'npm i -g @google/gemini-cli && gemini',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  'anthropic-api': {
    kind: 'anthropic-api',
    label: 'anthropic api',
    group: 'api',
    description: 'claude models with an anthropic api key',
    fields: ['apiKey'],
    defaultModel: 'claude-sonnet-4-5',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  'openai-api': {
    kind: 'openai-api',
    label: 'openai api',
    group: 'api',
    description: 'gpt models with an openai api key',
    fields: ['apiKey'],
    defaultModel: 'gpt-4.1',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  'gemini-api': {
    kind: 'gemini-api',
    label: 'gemini api',
    group: 'api',
    description: 'gemini models with a google ai studio key',
    fields: ['apiKey'],
    defaultModel: 'gemini-2.5-flash',
    docsUrl: 'https://aistudio.google.com/apikey',
  },
  openrouter: {
    kind: 'openrouter',
    label: 'openrouter',
    group: 'api',
    description: 'hundreds of models behind one key',
    fields: ['apiKey'],
    defaultModel: 'anthropic/claude-sonnet-4.5',
    docsUrl: 'https://openrouter.ai/keys',
  },
  local: {
    kind: 'local',
    label: 'local',
    group: 'local',
    description: 'ollama, lm studio or any openai-compatible server',
    fields: ['baseUrl', 'apiKey'],
    defaultModel: 'qwen2.5vl:7b',
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
    /** on-device: Xenova/whisper-base.en etc; openai: gpt-4o-mini-transcribe; groq: whisper-large-v3-turbo */
    model: string;
    apiKey?: string; // optional override (else reuse matching provider key)
    baseUrl?: string; // for 'local'
    language?: string; // ISO code or '' for auto
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
 * Canonical key names. Modifiers are side-agnostic: 'Control' | 'Alt' | 'Shift' | 'Meta'.
 * Every other key uses the DOM KeyboardEvent.code value: 'Space', 'KeyA', 'Digit1', 'F5',
 * 'Backquote', 'Escape', 'Enter', 'Tab', 'ArrowUp', … The settings UI records keys with
 * KeyboardEvent.code; the hotkey module maps uiohook keycodes to the same names.
 */
export type KeyName = string;

export interface HotkeySettings {
  /** push-to-talk chord. default: Control + Alt (ctrl+option on mac) */
  talk: KeyName[];
  /** 'hold' = talk while held, release to send. 'toggle' = press once to start, again to send */
  mode: 'hold' | 'toggle';
  /** open a small text box next to the companion instead of speaking. default: Control + Alt + Space */
  type: KeyName[];
}

/* ───────────────────────── settings ───────────────────────── */

export type Theme = 'system' | 'light' | 'dark';

export interface CompanionSettings {
  /** follow the mouse. if false the companion parks in the bottom-right corner */
  followCursor: boolean;
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
  hotkeys: { talk: ['Control', 'Alt'], mode: 'hold', type: ['Control', 'Alt', 'Space'] },
  companion: { followCursor: true, offsetX: 18, offsetY: 20, scale: 1, color: '', showBubble: true, pointing: true },
  theme: 'system',
  customInstructions: '',
  historyTurns: 6,
  launchAtLogin: false,
  onboarded: false,
};

/** Recursive partial used for settings patches. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends any[] ? T[K] : DeepPartial<T[K]>) : T[K] };

/* ───────────────────────── permissions ───────────────────────── */

export type PermissionKind = 'microphone' | 'screen' | 'accessibility';
export type PermissionState = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';
export type PermissionsStatus = Record<PermissionKind, PermissionState>;

/* ───────────────────────── overlay ───────────────────────── */

export type CompanionPhase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error';

export interface OverlayState {
  phase: CompanionPhase;
  /** the user's transcribed words (shown briefly while thinking) */
  transcript?: string;
  /** visible reply text so far (POINT tags already stripped) */
  reply?: string;
  error?: string;
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
}

export interface PttResult {
  /** 16 kHz mono 16-bit PCM WAV, when the renderer did not transcribe itself */
  wav?: ArrayBuffer;
  /** transcript when transcribed on-device */
  text?: string;
  error?: string;
  /** recording length; very short presses (< 250ms) are treated as accidental */
  durationMs: number;
}

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
}
