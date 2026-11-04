# Clickity architecture

Electron app (TypeScript, bundled by esbuild via `scripts/build.mjs`). Target: macOS 14+, Windows 10+, Linux (X11) best-effort.

Shared contract: `src/shared/types.ts` (data shapes, defaults, provider metadata) and `src/shared/ipc.ts` (channel names, preload APIs). **Do not change these without coordinating** — every module depends on them. Import them with relative paths (e.g. `../shared/types`).

## How a turn works

1. User holds the talk chord (default `Meta + Alt` on mac, `Control + Alt` elsewhere). `hotkey.ts` → `conversation.onTalkDown()`.
2. Conversation sends `IPC.overlayPttStart` to the overlay on the cursor's display; overlay records the mic and shows the *listening* state.
3. Chord released → `conversation.onTalkUp()` → `IPC.overlayPttStop` with `{ stt }`. In parallel, `capture.captureScreens()` grabs every display.
4. Overlay replies `IPC.pttResult`: either `text` (on-device whisper, `renderer/overlay/stt-local.ts`) or a 16 kHz mono `wav` that main transcribes with `speech/stt.ts`.
5. Conversation builds a `ChatRequest` (system prompt + last N text turns + this turn with screenshots) and streams it from `providers/index.ts → getProvider(kind).stream(req, cfg)`.
6. While streaming it strips `[POINT:…]` tags and pushes `IPC.overlayState { phase: 'thinking'|'speaking', reply }` to the overlay.
7. When done: parse POINT tags → map screenshot pixels to global DIP → overlay-local DIP → `IPC.overlayPoint`. Speak the reply with `speech/tts.ts` (`SpeakCommand` → overlay plays it). Overlay sends `IPC.speechDone`; companion returns to the cursor.

## Pointing protocol (system prompt asks the model for this)

The model may end its reply with zero or more tags:

```
[POINT:x,y:label:screenN]
```

`x,y` are pixel coordinates **in the screenshot image** for screen `N` (1-based, in the order sent; `:screenN` optional → defaults to the cursor's screen). `label` is 1–4 words. `[POINT:none]` means nothing to point at. Tags are never spoken or shown.

Mapping: `globalX = bounds.x + x * bounds.width / imageWidth` (same for y), then `localX = globalX - overlayDisplay.bounds.x`.

## Module APIs (main process)

### `src/main/settings-store.ts`
```ts
export function loadSettings(): Settings;                    // call once after app ready; merges defaults
export function getSettings(): Settings;                     // in-memory, decrypted
export function updateSettings(patch: DeepPartial<Settings>): Settings; // deep merge (arrays replace), persist, notify
export function resetSettings(): Settings;
export function onSettingsChanged(cb: (s: Settings, prev: Settings) => void): () => void;
```
Persists to `app.getPath('userData')/settings.json`. All `apiKey` fields (providers.*.apiKey, speech.stt.apiKey, speech.tts.apiKey) are encrypted with `safeStorage` when available (stored as `enc:<base64>`), plaintext fallback with a warning.

### `src/main/capture.ts`
```ts
export interface CapturedScreen {
  index: number;                 // 1-based, order sent to the model
  displayId: number;
  isCursorScreen: boolean;
  bounds: Electron.Rectangle;    // global DIP
  scaleFactor: number;
  image: ImageInput;             // jpeg, longest side ≤ 1568px, written to a temp file too
}
export async function captureScreens(cursor: Electron.Point): Promise<CapturedScreen[]>; // cursor screen first
export function screenshotToGlobal(s: CapturedScreen, x: number, y: number): Electron.Point;
export function cleanupCaptures(): void;   // delete temp files from previous turn
```
Uses `desktopCapturer.getSources({ types: ['screen'], thumbnailSize })`, matching sources to displays by `display_id`.

### `src/main/hotkey.ts`
```ts
export interface HotkeyHandlers { onTalkDown(): void; onTalkUp(): void; onType(): void; onEscape(): void; }
export function startHotkeys(h: HotkeySettings, handlers: HotkeyHandlers): { backend: 'uiohook' | 'globalShortcut' };
export function updateHotkeys(h: HotkeySettings): void;
export function suspendHotkeys(suspended: boolean): void;
export function stopHotkeys(): void;
export function hotkeyLabel(keys: KeyName[], platform?: NodeJS.Platform): string; // "ctrl + option", "⌃ ⌥" style lowercase words
```
Primary backend `uiohook-napi` (real key down/up, modifier-only chords). In `toggle` mode, a press of the chord fires `onTalkDown`, the next press fires `onTalkUp`. Fallback to Electron `globalShortcut` (no key-up → behaves as toggle) when uiohook fails (e.g. macOS accessibility not granted) or the chord is not expressible.

### `src/main/speech/stt.ts`
```ts
export async function transcribe(wav: Buffer, settings: Settings, signal?: AbortSignal): Promise<string>;
```
### `src/main/speech/tts.ts`
```ts
export async function synthesize(text: string, settings: Settings, signal?: AbortSignal): Promise<SpeakCommand | null>; // null when tts is 'off'
```
`system` → `{ mode: 'system', … }` (overlay uses `speechSynthesis`). openai/elevenlabs → `{ mode: 'audio', mime, data }`.

### `src/main/providers/index.ts`
```ts
export interface Provider {
  kind: ProviderKind;
  stream(req: ChatRequest, cfg: ProviderConfig): AsyncIterable<string>;  // yields text deltas; throws Error with a short lowercase message
  listModels(cfg: ProviderConfig): Promise<ModelInfo[]>;
  status(cfg: ProviderConfig): Promise<ProviderStatus>;
}
export function getProvider(kind: ProviderKind): Provider;
export async function testProvider(kind: ProviderKind, cfg: ProviderConfig, model: string): Promise<ProviderTestResult>;
export async function openLogin(kind: ProviderKind, cfg: ProviderConfig): Promise<void>; // opens an OS terminal running the CLI login
```

### `src/main/conversation.ts`, `overlay.ts`, `index.ts`, `permissions.ts`, `tray.ts`
Core/integration (app lifecycle, overlay windows per display, cursor polling, settings window, tray menu, IPC handlers, the turn orchestrator, system prompt).

## Renderer

- `src/renderer/overlay/` — `overlay.html`, `overlay.css`, `overlay.ts` (+ helper modules). Full-screen transparent click-through window per display. Draws the companion, reply bubble, waveform, pointing flight; records mic; plays `SpeakCommand`s.
- `src/renderer/overlay/stt-local.ts` — `export async function transcribeLocal(pcm16k: Float32Array, model: string, language?: string): Promise<string>` and `export function preloadLocalModel(model: string): void`. transformers.js Whisper.
- `src/renderer/settings/` — `settings.html`, `settings.css`, `settings.ts`. The settings / onboarding window, in the "Opal" design language (see `DESIGN.md`).

Renderers are bundled as IIFE for the browser; they talk to main **only** through `window.overlay` / `window.clicky` (contextIsolation on, nodeIntegration off).

## Build

`npm run build` → `dist/`. `npm run typecheck` must pass. `npm run dev` builds and launches Electron.
