# Clickity architecture

Electron app (TypeScript, bundled by esbuild via `scripts/build.mjs`). Target: macOS 14+, Windows 10+, Linux (X11) best-effort.

Shared contract: `src/shared/types.ts` (data shapes, defaults, provider metadata) and `src/shared/ipc.ts` (channel names, preload APIs). **Do not change these without coordinating** — every module depends on them. Import them with relative paths (e.g. `../shared/types`).

## How a turn works

1. User holds the talk chord (default `Control + Fn` on mac — fn is the globe key — and `Control + Alt` elsewhere; any chord can be recorded in settings › keys). `hotkey.ts` → `conversation.onTalkDown()`.
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

## Cursor gestures ("circle while you talk")

`conversation.onTalkDown` starts recording the cursor path (`overlay.onCursorMove`, global DIP, timestamped; `gesture.ts` drops < 2px moves, caps at 600 points by thinning) and broadcasts `IPC.overlayInk 'start'`: every overlay draws the path as a tapered ink stroke on a canvas outside the stage (only after ≥ 6px of movement), so it shows on each display the path crosses. Talk up → `'end'`; the screenshots are taken with a `CaptureAnnotator` that draws the same stroke into each screenshot's bitmap before JPEG encoding (`gesture.drawStroke`, pure — on X11 the transparent overlay is not in `desktopCapturer` images, elsewhere it may be; drawing it ourselves is the reliable path), then `'clear'` fades the trail (instant with reduced motion). `gesture.summarizeGesture` classifies the path per screen (circle / line / point (dwell) / area / still) and describes it in screenshot pixels plus the final cursor position; that sentence goes into the system prompt (`THE USER'S CURSOR … This turn: …`) for the turn's own screenshots only. Typed turns get the cursor position. The user turn stores only a short `gesture` note ("circled an area on screen 1").

`companion.show` ('always' | 'active' | 'never'): the overlay sets `data-show` and toggles `.buddy-on` (non-idle phase or pointing) to hide the arrow; 'never' skips the flight (ripple + label pill at the target) and ignores `followCursor` so the bubble opens at the cursor.

## Agent mode (action tags)

When `settings.companion.actions !== 'off'` and the turn has screenshots, the system prompt also offers action tags (screenshot pixels, like POINT): `[CLICK|DOUBLECLICK|RIGHTCLICK:x,y:label:screenN]`, `[TYPE:text]` (`\]` / `\\` escapes), `[KEY:cmd+s]`, `[SCROLL:x,y:down 5:screenN]`, `[WAIT:500]`, `[DONE]`. `action-tags.ts` parses / strips them (pure, unit tested; human key names → canonical `KeyName`).

`conversation.runAgent()` loop: map coords with `screenshotToGlobal` → (`'ask'`) `OverlayState.confirm` + ChatEvent `confirm`, wait for Enter (`hotkey.setConfirmKeys` grabs plain Enter/Esc as global shortcuts while pending; ChordEngine `onEnter` is a backup), Esc, chats `approve`/`deny`, or 60 s → phase `'acting'` with `step`: fly the companion to each target (`overlayPoint`, fast flight), `IPC.overlayClick` ripple, `agent-input.performActions()` (→ `input.perform`; `CLICKITY_FAKE_INPUT=1` only logs) → settle 700 ms → fresh screenshots → automatic follow-up model turn, until `[DONE]`, a reply without actions, Esc/stop, an error or `maxSteps`. Each step is its own stored assistant turn with `actions` ("clicked save"); `chatContext` merges consecutive assistant turns.

## Choices (ask tags)

A reply may end with one choice question: `[ASK:question|option|option…]` (2–5 options, 1–6 words each; `\|`, `\]`, `\\` escapes). `ask-tags.ts` parses / strips it (pure, unit tested): the last usable tag wins, empty / duplicate options are dropped, extras beyond 5 cut. `composeAskReply` appends the question to the visible text unless the prose already contains it or ends with a question of its own; `spokenAsk` adds the options to the spoken text only when there are ≤ 3 short ones ("budget, report, or notes?") — the bubble always shows them as pills. A reply with an ASK never acts (its action tags are ignored), so an ASK inside an agent run ends the loop. The assistant `ChatTurn.ask = { question, options, answered?, dismissed? }` is stored; `chatContext` adds "(offered choices: 1. …)".

`conversation.finishReply(…, offer)` makes it the pending choice (one at a time): `IPC.overlayChoice` (`OverlayChoice`, null clears) → numbered pills + "something else…" in the bubble; `hotkey.setChoiceKeys` grabs plain digits 1..N + Esc as global shortcuts — only while no one is typing (released while the overlay type box is open / an overlay or the chats window has focus, re-grabbed after). `OverlayChoice.keys` false (nothing grabbed, e.g. Wayland) → pills without numbers. Answers: digit → `pickChoice`; pill click → `IPC.overlayChoose`; "something else…" / bubble "reply" → `IPC.overlayReply` opens the type box under the bubble (its text answers the choice); chats window button → `chats.answer` (`ChatAnswerRequest`; when no longer pending it falls back to a normal message). `answerPending` sends the answer as the next user turn of the same chat, run like the question's turn (same source, voice, pointing, fresh screenshots; window turns stay window turns; agent mode may act). Any other new turn in that chat is the answer too (`markAskAnswered`); a turn elsewhere, Esc or the 2-minute timeout mark it `dismissed` (ChatEvent `turn` updates the chats window) and release the keys.

Plain-key grabs (`hotkey.grabKeys(owner, keys)` / `releaseKeys(owner)`) share one registry: each accelerator is registered once, a press goes to the newest owner, and releasing hands it back to the one below (agent `confirm` and `choice` both hold Esc). Owners `busy` and `bubble` always sit at the bottom of a key's stack (`LOW_OWNERS`), whatever order they grabbed in.

## Stop / pause key

`settings.hotkeys.stop` (default `['Escape']`; `stop-logic.stopKeyProblem` validates: one non-modifier key, esc / f-keys alone, otherwise a ctrl / alt / cmd chord, no fn / taps; `settings-validate.fixEnums` falls back to esc, which also migrates older settings). Pure logic in `src/main/stop-logic.ts` (unit tested, `test/stop.test.ts`): `busyState(snapshot)` → `{ mode: 'stop' | 'pause' | 'paused', global }` (chats-window replies are busy but not `global`; agent runs always are), `stopStep(snapshot, 'key' | 'stop')`, `stopHint`, `PauseControl`, `PressDedupe`.

- **Grab.** `conversation.applyBusy()` (coalesced via `syncBusy()`, poked from `beginTurn` / `endTurn` / `cancelCurrent`, agent state changes, every `overlayState` tap and `busy.pokeBusy()` from dictation / drafts) grabs the stop key with owner `busy` (`hotkey.setBusyStopKey`) only while `global` busy, and releases it the moment clickity is idle. While a finished reply still shows (overlay → `IPC.overlayBubble`), owner `bubble` holds it instead, so esc dismisses the bubble (`IPC.overlayDismiss`); gone → released. A keyboard action that would press the stop key itself releases the grab first (`AgentState.typingStopKey`). The native hook stays a backup: the chord engine fires `onStop` for the stop chord (`onEscape` for plain esc when the stop key is custom: prompts only). `acceptPress` drops the hook's echo of a press a grab already handled (`hotkey.grabFiredRecently`) and `PressDedupe` the reverse. `CLICKITY_NO_UIOHOOK=1` forces the globalShortcut backend (tests).
- **`onStopKey(source)`** answers a waiting prompt first (`escapePrompts`: type box, choice, agent confirm, routine offer), then `stopOrPause('key')`: speaking → `stopTurnByUser` (`ChatTurn.stopped`, bubble keeps the text with `OverlayState.stopped`), streaming → abort (`error: 'stopped'`, partial text kept), listening → cancel, dictation / draft → `draftEscape()` (dictation aborts its session: nothing typed), walkthrough → the turn's abort ends it, nothing running → dismiss lingering bubbles. Chats window / notch / tray stop use `'stop'` (agent runs stop, never just pause).
- **Agent pause.** `AgentState.pause` (`PauseControl`): the first press aborts only the in-flight model call (`askModel(..., { call })`, recorded `error: 'paused'`) or lets the current input action finish (`performPlanned` skips the rest), then `waitPaused` shows `OverlayBusy.mode 'paused'` ("paused · enter to continue · esc to stop", continue / stop buttons), grabs Enter (owner `pause`) and emits `ChatEvent busy { mode: 'paused', turnId }`. Continue (enter, `IPC.overlayContinue`, `chats.resume`, notch) → fresh screenshot + `AGENT_RESUME` follow-up. A second press, stop, or 2 minutes → `stopAgentRun` (`error: 'stopped by you'`).
- **UI.** `IPC.overlayBusy` (`OverlayBusy`, to the turn's overlay) → "esc to stop" / "esc to pause" line + stop button (`IPC.overlayStop`; the bubble's × sends `hard` = always stop, then hides the bubble and its cards; settings › companion › `hideReplies` sets the linger). `busy.ts` publishes `BusyInfo` to the tray ("stop" item) and the notch (`NotchState.busy`, stop / pause / continue). `ChatEvent { type: 'busy' }` keeps the chats window's stop button up for any turn in that chat (`chats.stop / pause / resume`), re-sent when the window loads.

## Cards and 3D models (visual tags)

A reply may carry `[CARD:title|line|…]` (≤ 6 short lines) and `[MODEL3D:kind|label]` (kind ∈ `MODEL3D_KINDS` in `src/shared/visuals.ts`, with a few aliases; same `\|` `\]` `\\` escapes as ASK). `visual-tags.ts` parses / strips them (pure, unit tested; at most 3 visuals, duplicates dropped, unclosed tags and streaming partial heads hidden) and exports `visualPromptSection()`, which `buildSystemPrompt` appends. `conversation.askModel` strips the tags from the visible / spoken text, stores `ChatTurn.visuals` and sends `IPC.overlayVisuals` (`ChatVisual[]`, null clears; sent null at the start of every model call). The overlay (`overlay/visuals.ts`) floats them under / above / beside the bubble, draggable by the frame, with the bubble's hover mechanism (`setInteractive`); they are dropped when the bubble goes unless the user rotated / zoomed / dragged them. The chats window renders `turn.visuals` under the message (`chats/visuals.ts`, WebGL canvases only while on screen). `renderer/shared/visuals.ts` builds the card, `renderer/shared/models3d.ts` the procedural three.js models; `renderer/shared/visuals.css` is copied into each window by `scripts/build.mjs`.

## Greetings

`src/shared/greetings.ts` holds the 500+ lines per context (morning / afternoon / evening / lateNight / weekend / monday / friday / any, `{name}` slot) and `pickGreeting`: ~30% any-time, otherwise the day pool (40%) or the time-of-day pool; a persisted shuffled queue per pool and window (localStorage, in-memory fallback) guarantees no repeat until the pool is used up; `{name}` lines are only eligible when `settings.userName` is set. `renderer/shared/greeting.ts` wraps it for the chats empty state, the settings hero title and the welcome step.

## Clickys (named companions)

`Settings.clickys: Clicky[]` + `Settings.activeClicky` (`src/shared/types.ts`). A `Clicky` is `{ id, name, color, persona, provider?, model?, voice?: { provider, voice } }`. Pure helpers live in `src/shared/clickys.ts` (unit tested, `test/clickys.test.ts`): `fixClickys` (called from `settings-store.validate`: drops broken / duplicate entries, and gives older settings one default `{ id: 'clickity', name: 'clickity', color: companion.color, persona: '' }`), `settingsForClicky(s, id)` (a never-persisted copy with that clicky's provider / model / tts overrides and `activeClicky = id`), `parseSwitchCommand`, `parseSuggestions`, `clickyIdFor`, `chatClickyId`.

- **Turns.** `conversation.runTurn` resolves the chat first, then `settingsForClicky(getSettings(), chatClickyId(chat))`, so a turn always speaks as the clicky its chat belongs to; `buildSystemPrompt` reads `clickyById(settings, settings.activeClicky)`: "You are ‹name›…" plus a `WHO YOU ARE` persona block. Voice / type turns that are `switch to ‹name›` (2+ clickys) are handled in `runSwitchCommand` without a model call; `sendFromWindow` returns `{ chatId: '', switched }` for them.
- **Chats.** `Chat.clickyId` / `ChatSummary.clickyId` (missing = `'clickity'`); `chat-store.createChat(clickyId)`. `getActiveChatId()` drops an active chat that belongs to another clicky and continues that clicky's newest recent chat (or a new one). The chats renderer filters with `clicky-switch.ts` (dropdown in the sidebar header: switch, "show all clickys' chats", manage).
- **Main module** `src/main/clickys.ts`: `switchClicky`, `trySwitchCommand`, `suggestClickys(answers)` (one non-streamed model call with the global brain, JSON array → `parseSuggestions`), IPC `clickysSuggest` / `clickysMemory` / `clickysForget`, and a settings listener that keeps `companion.color` and the active clicky's `color` in sync (applied on the next tick so every listener sees changes in order).
- **Memory.** `memory.ts` keeps one store per clicky (`memory.json` for `'clickity'`, `memory-<id>.json` otherwise); every function takes an optional `clickyId` (default: the active clicky). `turn-extras` passes `settings.activeClicky`, i.e. the turn's clicky. `onFactsChanged` (settings › memory) follows the active clicky.
- **Tray**: `clicky: ‹name› ▸` radio submenu + "manage clickys…". **Settings**: `src/renderer/settings/clickys.ts` (rows reuse the provider-row pattern; every edit replaces the whole `clickys` array, queued so edits never race).

## Notch panel

`src/main/notch.ts` + `src/preload/notch.ts` (`window.notch`, `NotchApi`) + `src/renderer/notch/`. `settings.companion.notch`: `'off'` (no window) · `'hover'` · `'always'`. One frameless, transparent, always-on-top (`'screen-saver'`), visible-on-all-workspaces window (`type: 'panel'` on mac, like the overlays), 420×56 collapsed / 420×360 expanded, centred at the top of the cursor display's work area (`notchBounds`: under the menu bar; on a mac full-screen space 32px down for the camera notch). Collapsed it is `focusable: false` and shown with `showInactive`; the renderer asks for `notchExpand { expanded, focus }` on hover (no focus) or click / typing (focus → `setFocusable(true)` + `focus()`), and folds back on esc, mouse-leave (unfocused) or window blur (`notchCollapse`). `'always'` follows the cursor to other displays (checked every 250ms of cursor movement while collapsed); `'hover'` shows when the cursor is within 6px of the top edge near the centre and hides 700ms after it leaves.

State: `overlay.onOverlayState` taps every `IPC.overlayState` (phase, reply, transcript, confirm) and `chat-store.onChatsChanged` → `NotchState` (active clicky + list, phase, first line, last 6 turns of `getActiveChatId()`), coalesced to ~40ms. Sending: `notchSend` → `sendFromWindow({ chatId: active, noBubble: true, … })` (`ChatSendRequest.noBubble`: no reply bubble at the cursor; the panel shows it). Dropped files become `ChatAttachment`s on the next message.

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
Canonical key `'Fn'` (mac only) counts as a modifier; `orderKeys`/`hotkeyLabel` put it after cmd (`"control + fn"`). Also exported: `onRawKey(cb)` (every native key, even while suspended), `setRecordingSuspended(b)`, `hotkeyBackend()`.

Primary backend `uiohook-napi` (real key down/up, modifier-only chords). In `toggle` mode, a press of the chord fires `onTalkDown`, the next press fires `onTalkUp`. Fallback to Electron `globalShortcut` (no key-up → behaves as toggle) when uiohook fails (e.g. macOS accessibility not granted) or the chord is not expressible.

### `src/main/fn-key.ts` (macOS fn key)
uiohook never reports fn on mac (libuiohook maps `kVK_Function` to `VC_UNDEFINED`). `native/macos/fnwatch.swift` is a tiny listen-only `CGEventTap` CLI that prints `{"ready":true}`, then `{"fn":true}` / `{"fn":false}` per change (flagsChanged on keycode 63 / 179 only), or `{"error":"no-permission"}` + exit 2 when the tap is refused (Input Monitoring / Accessibility). It exits when stdin closes.
```ts
export function startFnWatch(opts?: { prompt?: boolean }): void; // spawned by startHotkeys on darwin
export function restartFnWatch(opts?: { prompt?: boolean }): void;
export function stopFnWatch(): void;
export function onFn(cb: (down: boolean) => void): () => void;  // hotkey.ts feeds this into the ChordEngine as 'Fn'
export function fnStatus(): 'off' | 'starting' | 'running' | 'missing' | 'no-permission' | 'error';
```
Binary: `npm run build:fnwatch` (universal, ad-hoc signed) → `resources/mac/fnwatch` (dev path, gitignored); CI builds it in `release.yml`, and `electron-builder.yml` `mac.extraResources` ships it as `process.resourcesPath/fnwatch`. Missing helper = no fn, never a crash.

### `src/main/hotkey-ipc.ts`, `key-recorder.ts`
Settings › keys: `recordKeysStart()` → main suspends chord actions and streams `IPC.recordKeys` `{ held, chord, done }` from the native hook (sees fn); `{ native: false }` → the renderer records DOM key events instead (and it also falls back if the native hook stays silent). `hotkeyStatus()` / `IPC.hotkeyStatusChanged` report backend, accessibility and the fn helper; `IPC.hotkeyHeard` fires when a chord triggers ("heard control + fn ✓").

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

### `src/main/updater.ts`, `update-core.ts` (in-app updates)
```ts
export function initUpdater(): void;                 // first check ~10s after start, then every 4 h (packaged builds only)
export function checkForUpdate(manual?: boolean): Promise<UpdateState>;
export function installUpdate(): Promise<UpdateState>; // download → install → restart
export function getUpdateState(): UpdateState;
export function onUpdateState(cb: (s: UpdateState) => void): () => void; // index.ts → IPC.updateChanged to settings + chats, tray refresh
```
Reads `api.github.com/repos/Bndrwe/clickity/releases/latest` (`tag_name` minus the `v` is the version; `build.json` adds notes), numeric compare with `app.getVersion()`. CI (`release.yml`) versions every main build `1.0.<run number>` (`-c.extraMetadata.version`) and publishes it as release `v1.0.N`, marked latest; asset names carry no version. Assets: mac → `-mac-<arch>.zip`, unzipped with `ditto`, a detached shell script replaces the bundle after we exit (`xattr -dr com.apple.quarantine`, `open`), falling back to revealing the new app when the bundle isn't writable / translocated; windows → NSIS `.exe /S --force-run`; linux → AppImage swapped in place next to `$APPIMAGE` and relaunched after we exit, else the `.deb` opened with the system installer. Not electron-updater: Squirrel.Mac needs a Developer ID signature. A one-time "updated to vX" note (`UpdateState.updatedFrom`) reminds mac users to reset permissions (TCC grants follow the signature, which changes every build). `update-core.ts` is pure node and unit tested (`test/updater.test.ts`, incl. a local-server download + AppImage swap); `CLICKITY_UPDATE_API` overrides the api base for tests.

## Renderer

- `src/renderer/overlay/` — `overlay.html`, `overlay.css`, `overlay.ts` (+ helper modules). Full-screen transparent click-through window per display. Draws the companion, reply bubble, waveform, pointing flight; records mic; plays `SpeakCommand`s.
- `src/renderer/overlay/stt-local.ts` — `export async function transcribeLocal(pcm16k: Float32Array, model: string, language?: string): Promise<string>` and `export function preloadLocalModel(model: string): void`. transformers.js Whisper.
- `src/renderer/settings/` — `settings.html`, `settings.css`, `settings.ts`. The settings / onboarding window, in the "Opal" design language (see `DESIGN.md`).
- `src/renderer/notch/` — `notch.html`, `notch.css`, `notch.ts`. The notch panel: a pure black pill (same palette as the chats window) with the active clicky, its state and an ask box; expands into recent messages + quick actions.

Renderers are bundled as IIFE for the browser; they talk to main **only** through `window.overlay` / `window.clicky` / `window.chats` / `window.notch` (contextIsolation on, nodeIntegration off).

## Build

`npm run build` → `dist/`. `npm run typecheck` must pass. `npm run dev` builds and launches Electron.

## Diagnostics

`src/main/log.ts` appends timestamped lines to `app.getPath('logs')/clickity.log` (rotated at ~1 MB to `clickity.old.log`; settings › about › "open logs"). Every voice-turn stage is logged (talk down/up, mic permission, mic device / duration / peak level, stt engine + ms, provider/model + ms, errors shown in the bubble); overlay console warnings/errors and `OverlayApi.log()` lines are forwarded to it. Voice-path failures always end in a short lowercase bubble message saying what to do; while on-device whisper downloads/loads, the overlay shows `OverlayState`-independent progress ("downloading the voice model… 42%") and reports it to main via `IPC.pttProgress`, which keeps main's result timeout alive.

`CLICKITY_TEST=1` installs `src/main/test-hook.ts` (`globalThis.__clickityTest`: onTalkDown/onTalkUp, settings, chats, log path, denyMedia) so Playwright can drive a voice turn under xvfb with Chromium's fake audio capture.

## Dictation, drafting, hands-free, memory, routines (feature modules)

These live beside the core turn and hook into it at a few points (`turn-extras.ts`, `features.ts`).

- **Chord engine** (`chord-engine.ts`): besides talk / type it handles `hotkeys.dictate` (hold; alt / option held with it, or added while held = draft; any other key cancels; dictation is checked before talk / type so the chords can overlap) and tap bindings stored as `['DoubleTap', key]` / `['TripleTap', key]` in `hotkeys.typeTap` / `hotkeys.alwaysOn` (a tap = that key pressed and released alone within 250 ms; taps ≤ 300 ms apart; when a triple tap is also bound the double tap waits out the gap). `tapOf()` / `hotkeyLabel()` understand both forms. The settings recorder records a tap binding when the same key is tapped 2–3 times.
- **Dictation** (`dictation.ts`): `onDictateDown/Up` record through the cursor overlay's normal `overlayPttStart/Stop` (its own `IPC.pttResult` waiter), transcribe with the configured STT (`transcribe(…, { prompt })` passes the dictionary words as whisper's `prompt` for openai / groq / local, as a hint for gemini; transformers.js has no `prompt_ids` in generate, so on-device ignores it), then `dictionary.ts` (replacements, dash style) and `text-insert.ts` (waits for every key to be up, suspends the chord engine, types with `input.ts`, or on mac pastes long / non-ascii text with the clipboard saved and restored via Electron's async `clipboard.read()/write()`). A newline headed for a terminal (`live-context.activeAppName()`) asks first. Auto-learn (`detectCorrection`) stores offers in `settings.dictation.suggestions` for settings to accept. Cue pill: `IPC.overlayCue`.
- **Drafting** (`runDraft`): screenshots + instruction → provider stream with a "text only" system prompt → bubble preview (`OverlayState.confirm`) → enter (key-grab owner `draft`) → `insertText`. `actions === 'auto'` skips the preview unless `looksSecret()`. Talk-chord turns starting with write / reply / draft are routed here from `processVoiceTurn`.
- **Hands-free** (`hands-free.ts` + `renderer/overlay/extras.ts` + `shared/vad.ts`): the primary display's overlay runs a second `MicRecorder` continuously, feeds 20 ms RMS frames into `EnergyVad` (start after 120 ms above threshold, end after 900 ms of silence, < 400 ms discarded, cut at 30 s), and sends the utterance (on-device text or wav) as `IPC.handsFreeUtterance` → `conversation.runUtterance` → `processVoiceTurn(turn, preset)`. Main is the mic arbiter: `HandsFreeState.listening` is false while a turn records / works, while dictation or a draft holds it (`holdHandsFree`), and for 800 ms after a reply; with headphones (output label) the renderer keeps listening during a reply (`bargeIn`) and `IPC.handsFreeSpeech` stops it.
- **Tags** (`extra-tags.ts`, pure): `[REMEMBER:fact]` → `memory.ts` (userData `memory.json`, deduped, secrets dropped, 200 max, per clicky), `[HIGHLIGHT:x1,y1,x2,y2:label:screenN]` → `IPC.overlayHighlight` (local DIP rects, fade 2.6 s after the turn), `[STEP:n:x,y:label:instruction:screenN]` (≤ 15) → `turn-extras.runWalkthrough` from `finishReply` (enter / bubble click `IPC.walkNext` = next, esc = end; key-grab owner `walkthrough`), `[ROUTINE:days|HH:MM|prompt]` → confirm in the bubble → `settings.routines`. `extrasPrompt()` adds memory, these protocols, live context (`live-context.ts`: date / time, focused app, window titles) and a self-help section to every system prompt.
- **Links / PDFs**: `runTurn` reads http(s) links in the user's text with `web-fetch.ts` (DNS-checked against private ranges on every redirect hop, 10 s, 2 MB, readability-lite `web-text.ts`) and appends them wrapped as untrusted page text. `prepareAttachments` extracts PDF text with `pdf-text.ts` (pdfjs-dist legacy build, worker module loaded in-process, 200 pages / 60k chars).
- **Agent safety**: automatic mode counts down 3 s before the first action; `destructiveReason()` (send / delete / pay / post…) forces a confirm even in automatic mode; the confirm offers **a = always allow** (`alwaysAllow()` → `companion.actions = 'auto'`, `OverlayState.confirmAlways`, `ChatEvent.confirm.always`).
- **Routines** (`routines.ts` + pure `schedule.ts`): a 30 s tick runs due routines (`isDue`: a slot passed since `lastRun` / `createdAt`, at most 6 h late) via `conversation.runRoutineTurn` into a new chat, never while `companionBusy()` or offline; 3 failures pause one. `IPC.routineRun` = run now.
- **Screenshots** are deleted when their turn ends (`capture.capturedSince(turn.startedAt)` in `endTurn` / `cancelCurrent`), after any agent loop or nudge; the 2-minute sweep stays as a backstop.
