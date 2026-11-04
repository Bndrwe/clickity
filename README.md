# clickity

a small companion that lives next to your cursor.

it is a little ink-black triangle that follows the mouse. hold a key, ask it something out loud, and it looks at your screens, answers in a short bubble, and speaks back. when the answer is about something on screen, it flies over and points at it.

clickity is an open-source clone of heyclicky.com. the difference is that you bring your own brain: a Claude, ChatGPT or Google AI subscription, an API key, or a local model.

![the companion pointing at a button, with its reply bubble](docs/screenshots/pointing.png)

## how it works

1. you hold the talk key (ctrl + option on mac, ctrl + alt on windows).
2. the companion listens while you hold it. your voice is turned into text on your machine by default.
3. when you let go, it takes a screenshot of each display and sends your words and the screenshots to the model you picked.
4. the reply streams into a bubble, and the companion reads it out loud.
5. if the model points at something, the companion flies there and lands next to it.

## download

grab the installer for your computer from the [releases page](https://github.com/bndrwe/clickyclone/releases):

| computer | file |
|---|---|
| mac with apple silicon (m1–m4) | `Clickity-…-mac-arm64.dmg` |
| mac with intel | `Clickity-…-mac-x64.dmg` |
| windows 10 / 11 | `Clickity-…-win-x64.exe` |
| linux | `Clickity-…-linux-x86_64.AppImage` or `.deb` |

on mac, open the dmg and drag clickity into applications. clickity isn't notarized by apple yet, so macos blocks the first launch ("apple could not verify…"). click **done**, then either:

- open **system settings › privacy & security**, scroll down, click **open anyway** next to clickity, and confirm; or
- run this once in terminal: `xattr -dr com.apple.quarantine /Applications/Clickity.app`

on windows, smartscreen may warn: more info › run anyway.

clickity then behaves like any app: it has a dock / taskbar / start-menu icon, clicking the icon opens its settings, the companion keeps running while the window is closed, and you quit it with cmd + q, the dock menu, or quit in the menu-bar / tray icon. turn on "launch at login" in settings to have it start quietly when you log in.

installers are built by github actions (`.github/workflows/release.yml`) whenever a `v*` tag is pushed, or on demand from the actions tab.

## install and run from source

you need node.js and npm.

```sh
npm install
npm run dev
```

`npm run dev` builds the app and starts it in electron. the companion appears near the cursor, and the menu bar (mac) or tray (windows, linux) icon opens settings.

to package an installer:

```sh
npm run dist
```

the builds land in `release/`: a dmg and zip on mac, an nsis installer on windows, and an AppImage on linux.

the icons are generated, not hand-drawn. to regenerate them after changing the shape, run `node scripts/make-icons.mjs`.

## choosing a brain

pick one in settings. the setup column is the command or step you need before clickity can use it.

| provider | what you need | setup |
|---|---|---|
| claude | a claude pro or max plan | `npm i -g @anthropic-ai/claude-code && claude` |
| chatgpt | a chatgpt plus or pro plan | `npm i -g @openai/codex && codex login` |
| gemini (subscription) | a google account with an ai pro plan | `npm i -g @google/gemini-cli && gemini` |
| anthropic api | an anthropic api key | paste the key in settings (console.anthropic.com) |
| openai api | an openai api key | paste the key in settings (platform.openai.com) |
| gemini api | a google ai studio key | paste the key in settings (aistudio.google.com) |
| openrouter | an openrouter key | paste the key in settings (openrouter.ai) |
| local | ollama, lm studio, or any openai-compatible server | start the server; the default base url is `http://localhost:11434/v1` |

the three subscription options run the vendor's own cli on your machine, in headless mode. that means each request counts against your plan's usage, and it is subject to each vendor's terms. clickity does not get a separate allowance or bypass any limit.

see [docs/PROVIDERS.md](docs/PROVIDERS.md) for sign-in steps, model ids and cost notes.

## models

each provider has a default model, so you can start without choosing one. the model picker in settings lists what the provider offers. for local models, use a vision model if you want the companion to see your screen. see the notes in `docs/PROVIDERS.md`.

## voice

speech to text (stt) options:

- **on-device** (default): whisper running in the app, through transformers.js. free, private, no key, works with any brain. the default model is `Xenova/whisper-base.en`.
- **openai**, **groq**: whisper over https. uses the openai key you already set, or a key you enter here.
- **gemini**: gemini audio understanding, using the gemini api key.
- **local**: any openai-compatible `/audio/transcriptions` server, such as whisper.cpp or speaches.

text to speech (tts) options:

- **system** (default): the operating system voice. no key needed.
- **openai**, **elevenlabs**: higher quality voices over https. elevenlabs needs its own key.
- **off**: the companion only shows the reply in the bubble.

the speaking rate is adjustable in settings.

## keys

- **talk key**: default ctrl + option on mac, ctrl + alt on windows. change it in settings by recording a new chord.
- **hold or toggle**: in *hold* mode, the companion listens while you hold the chord and sends when you let go. in *toggle* mode, press once to start and again to send.
- **type instead**: ctrl + alt + space opens a small text box next to the companion, for when you would rather type.
- **escape** cancels the current turn.

## permissions

**macos** asks for three things, all in system settings → privacy & security:

- **microphone**: asked the first time you hold the talk key. the app declares why it needs it.
- **screen recording**: needed to capture your displays when you press the talk key. without it, the companion can still talk, but it cannot see the screen.
- **accessibility**: needed for real hold-to-talk, because the app has to see when you let go of the chord. without it, the chord falls back to a toggle, so you press once to start and once to send.

**windows** needs microphone access, which you can allow under settings → privacy & security → microphone. nothing else needs a separate prompt.

## privacy

- screenshots are only taken when you press the talk or type chord. nothing is captured in the background.
- screenshots and your words go only to the provider you chose. with on-device speech to text, your voice never leaves your machine.
- the screenshots are saved as temporary files for the turn. they are deleted after about two minutes.
- api keys are encrypted with the operating system's keychain, through electron's safeStorage. if safeStorage is not available on your system, the app stores keys unencrypted and logs a warning.

## pointing

the model can end a reply with pointing tags, such as `[POINT:x,y:label:screen1]`. the coordinates are pixels in the screenshot it was sent for, and the screen number matches the order the screenshots were sent in. the app converts those pixels to a position on your display, flies the companion there, and shows the label beside it. the tags are removed before the reply is shown or spoken, so you never see them. if the model has nothing to point at, it writes `[POINT:none]`. pointing can be turned off in settings.

## troubleshooting

- **"cli not found" for a subscription provider**: the app cannot find `claude`, `codex` or `gemini` on its path. open settings, find the provider, and set the cli path to the full path of the binary (run `which claude` in a terminal to get it).
- **the cli works in a terminal but not when the app is opened from finder or the dock**: on mac, apps started from finder do not inherit the path from your shell profile. a cli installed through nvm or a global npm prefix is often missing from that path. set the cli path, as above.
- **the talk key does nothing on linux**: global key handling works best on x11. on wayland, the compositor may block global shortcuts entirely, or only deliver key presses and not releases. in that case the chord acts as a toggle, or it may not trigger at all. linux support is best-effort and targets x11.
- **the companion can talk but cannot see the screen**: check screen recording permission on mac. on other systems, check that your model is a vision model.

## credits

inspired by [heyclicky.com](https://heyclicky.com). clickity is not affiliated with it.

## license

MIT. see [LICENSE](LICENSE).
