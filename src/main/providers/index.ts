// Provider registry + test / login helpers. See ARCHITECTURE.md ("src/main/providers/index.ts").
import type { ProviderConfig, ProviderKind, ProviderTestResult } from '../../shared/types';
import { PROVIDER_META } from '../../shared/types';
import { anthropicApi } from './anthropic-api';
import { claudeCli } from './claude-cli';
import { openTerminal, resolveBinary, shellQuote } from './cli';
import { codexCli } from './codex-cli';
import { errMessage } from './common';
import { geminiApi } from './gemini-api';
import { geminiCli } from './gemini-cli';
import { local, openaiApi, openrouter } from './openai-compat';
import type { Provider } from './provider';

export type { Provider } from './provider';

const PROVIDERS: Record<ProviderKind, Provider> = {
  'claude-subscription': claudeCli,
  'chatgpt-subscription': codexCli,
  'gemini-subscription': geminiCli,
  'anthropic-api': anthropicApi,
  'openai-api': openaiApi,
  'gemini-api': geminiApi,
  openrouter,
  local,
};

export function getProvider(kind: ProviderKind): Provider {
  const p = PROVIDERS[kind];
  if (!p) throw new Error(`unknown provider: ${kind}`);
  return p;
}

/** Send a tiny prompt and time it. Never throws. */
export async function testProvider(kind: ProviderKind, cfg: ProviderConfig, model: string): Promise<ProviderTestResult> {
  const isCli = PROVIDER_META[kind].group === 'subscription';
  const ctrl = new AbortController();
  const timeoutMs = isCli ? 90_000 : 30_000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  let text = '';
  try {
    const it = getProvider(kind).stream(
      {
        system: 'you are a connection test. reply with exactly one word.',
        messages: [{ role: 'user', text: 'reply with the word ok' }],
        model: model || PROVIDER_META[kind].defaultModel,
        signal: ctrl.signal,
      },
      cfg,
    );
    for await (const chunk of it) {
      text += chunk;
      if (text.length > 200) break;
    }
    const latencyMs = Date.now() - started;
    const reply = text.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!reply) return { ok: false, message: 'connected, but the model sent an empty reply', latencyMs };
    const secs = (latencyMs / 1000).toFixed(1);
    const shown = reply.length > 40 ? reply.slice(0, 39) + '…' : reply;
    return { ok: true, message: `works · replied "${shown}" in ${secs}s`, latencyMs };
  } catch (err) {
    if (ctrl.signal.aborted) return { ok: false, message: `no reply after ${timeoutMs / 1000}s` };
    return { ok: false, message: errMessage(err).toLowerCase() };
  } finally {
    clearTimeout(timer);
  }
}

const CLI_BIN: Partial<Record<ProviderKind, { bin: string; args: string[] }>> = {
  'claude-subscription': { bin: 'claude', args: [] }, // first run walks through sign-in (/login)
  'chatgpt-subscription': { bin: 'codex', args: ['login'] },
  'gemini-subscription': { bin: 'gemini', args: [] }, // first run asks how to sign in
};

/**
 * Open an OS terminal running the CLI's login / first-run flow. If the CLI isn't installed,
 * the terminal runs the install command first. API providers open their key page instead.
 */
export async function openLogin(kind: ProviderKind, cfg: ProviderConfig): Promise<void> {
  const meta = PROVIDER_META[kind];
  const cli = CLI_BIN[kind];
  if (!cli) {
    if (meta.docsUrl) {
      const { shell } = await import('electron');
      await shell.openExternal(meta.docsUrl);
    }
    return;
  }
  const bin = await resolveBinary(cli.bin, cfg.cliPath);
  let command: string;
  if (bin) {
    command = [shellQuote(bin), ...cli.args].join(' ');
  } else {
    // not installed: install, then run the login (setupCommand already ends in the login step)
    command = meta.setupCommand ?? `npm i -g ${cli.bin}`;
  }
  await openTerminal(command);
}
