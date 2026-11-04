# providers

this page goes deeper than the table in the readme. for each brain: how to install and sign in, how clickyclone calls it, example model ids, what it needs to see the screen, and what it costs.

the readme table is the short version. the defaults and setup commands here match the app's provider list.

## how the subscription CLIs are called

the three subscription providers (`claude-subscription`, `chatgpt-subscription`, `gemini-subscription`) do not use an API key. clickyclone starts the vendor's CLI on your machine in headless mode, sends it the system prompt, recent turns, and the current turn with its screenshots, and reads the streamed text back. the CLI uses the sign-in you already made, so the request counts against your plan.

if clickyclone cannot find the binary, set the CLI path under the provider in settings. use the full path, for example `/opt/homebrew/bin/claude`.

because the CLI is a separate program, its own terms apply. clickyclone runs it as you would from a terminal, under your own sign-in.

## claude (subscription)

**what you need:** a claude pro or max plan.

**install and sign in:**

```sh
npm i -g @anthropic-ai/claude-code
claude
```

the first run walks you through signing in with your claude account. after that, clickyclone can use the `claude` binary.

**model ids:** the default is `sonnet`. the claude cli also accepts the aliases `opus` and `haiku`, and full model names.

**vision:** claude models see the screenshots directly, so no extra setup is needed.

**cost:** counted against your claude plan's usage limits. each turn sends one or more screenshots, which use more of that allowance than text alone.

## chatgpt (subscription)

**what you need:** a chatgpt plus or pro plan.

**install and sign in:**

```sh
npm i -g @openai/codex
codex login
```

choose the sign-in with your chatgpt account when prompted.

**model ids:** the default is `gpt-5`. use the model names the codex cli lists for your plan.

**vision:** the gpt models see screenshots. no extra setup.

**cost:** counted against your chatgpt plan's usage.

## gemini (subscription)

**what you need:** a google account with a google ai pro plan, or a free google account for the free tier limits.

**install and sign in:**

```sh
npm i -g @google/gemini-cli
gemini
```

the first run asks you to sign in with google.

**model ids:** the default is `gemini-2.5-flash`. other gemini model ids that the cli accepts also work.

**vision:** gemini models see screenshots. no extra setup.

**cost:** counted against your google ai plan's usage. free-tier limits are lower and can be hit quickly when you talk often.

## anthropic api

**what you need:** an api key from [console.anthropic.com](https://console.anthropic.com/settings/keys).

**setup:** paste the key in settings under the anthropic api provider. the key is encrypted at rest with the os keychain.

**model ids:** the default is `claude-sonnet-4-5`. the model picker lists the other ids your key can use.

**vision:** claude models accept images. each screenshot is sent as an image block.

**cost:** billed per token by anthropic. screenshots are the largest input in each turn. clickyclone scales each screenshot so its longest side is at most 1568 px, which keeps the image token count predictable. with several displays, each screen adds an image.

## openai api

**what you need:** an api key from [platform.openai.com](https://platform.openai.com/api-keys).

**setup:** paste the key in settings under the openai api provider.

**model ids:** the default is `gpt-4.1`. other chat models that accept images work too.

**vision:** use a model that accepts image input. the default does.

**cost:** billed per token by openai. the same screenshot cost note as above applies.

## gemini api

**what you need:** a google ai studio key from [aistudio.google.com](https://aistudio.google.com/apikey).

**setup:** paste the key in settings under the gemini api provider. this key is also the default for gemini speech to text.

**model ids:** the default is `gemini-2.5-flash`.

**vision:** gemini models accept images.

**cost:** google ai studio has a free tier with lower limits. past that, it is billed per token.

## openrouter

**what you need:** an api key from [openrouter.ai](https://openrouter.ai/keys).

**setup:** paste the key in settings under openrouter.

**model ids:** use the openrouter slug, such as `anthropic/claude-sonnet-4.5`. the default is that model.

**vision:** only models on openrouter that accept image input will see the screenshots. check the model page on openrouter before you pick one. a text-only model will not see your screen.

**cost:** billed per token by openrouter, at that model's rate. openrouter shows the price on each model page.

## local (ollama, lm studio, or any openai-compatible server)

**what you need:** a running local server. the app talks to any server that speaks the openai chat completions API.

**ollama:**

```sh
ollama pull qwen2.5vl:7b
ollama serve
```

the default base url is `http://localhost:11434/v1`, which is where ollama listens. the default model is `qwen2.5vl:7b`.

**lm studio:** load a model, then start the local server from the developer tab. its default base url is `http://localhost:1234/v1`. set that in the local provider's base url field, and enter the model id as lm studio shows it.

**other servers** (llama.cpp, vllm, and so on): set the base url to the server's `/v1` endpoint. an api key is optional, and only needed if the server asks for one.

**vision:** this is the caveat that matters most. the companion sends screenshots with each turn, so you need a vision-capable model to get answers about your screen. good choices:

- `qwen2.5vl` (the default)
- `llama3.2-vision`
- `gemma3` (the 4b size and up accept images)

a text-only model cannot read the screenshots. depending on the server, it either ignores the images and answers from your words alone, or the request fails with an error that mentions images. if you see an error like that, switch to a vision model.

smaller vision models answer more slowly and may describe the screen less accurately, so pointing is less reliable with them.

**cost:** free to run apart from electricity and the hardware. a larger model needs more memory and a fast gpu to respond in a few seconds.

## speech to text and text to speech

speech settings are separate from the brain, so you can mix them. the on-device whisper model is free, private and needs no key, so it is a good default with any provider above. the openai, groq and gemini speech options use the key you already set for that provider, or a key you enter in the speech section. these add per-minute charges on the provider's side. see the readme's voice section for the full list.
