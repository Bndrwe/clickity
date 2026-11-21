// Cost & usage meter: every model reply (api providers report tokens in their streams) and every
// cloud speech call is added to userData/usage.json, aggregated per local day and model. Costs are
// ESTIMATES from the price table in src/shared/usage-math.ts. A soft monthly limit
// (settings.usage.monthlyLimit) only warns — once a month, quietly at the cursor — never blocks.
import { app, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { ProviderKind, TokenUsage, TurnUsage } from '../shared/types';
import type { UsageSummary } from '../shared/ipc';
import { IPC } from '../shared/ipc';
import { dayKey, emptyStore, fixStore, formatCost, recordInto, shouldWarn, speechCost, summarize, turnUsage, type UsageStore } from '../shared/usage-math';
import { getSettings } from './settings-store';
import { overlayForPoint, sendToOverlay } from './overlay';
import { log } from './log';

const file = (): string => path.join(app.getPath('userData'), 'usage.json');
let store: UsageStore | null = null;
let saveTimer: NodeJS.Timeout | null = null;

function load(): UsageStore {
  if (store) return store;
  try {
    store = fixStore(JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch {
    store = emptyStore();
  }
  return store;
}

function writeNow(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!store) return;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    const tmp = `${file()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    fs.renameSync(tmp, file());
  } catch (err) {
    log('usage', 'could not save usage.json:', err);
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(writeNow, 1500);
}

/** Flush pending writes (quit). */
export function flushUsage(): void {
  if (saveTimer) writeNow();
}

/** Past the soft monthly limit for the first time this month: say so once, quietly, at the cursor. */
function checkLimit(day: string): void {
  const s = load();
  const limit = getSettings().usage?.monthlyLimit ?? 0;
  if (!shouldWarn(s, day, limit)) return;
  s.warned = day.slice(0, 7);
  const text = `this month's estimated cost passed ${formatCost(limit)} — settings › usage`;
  log('usage', text);
  try {
    sendToOverlay(overlayForPoint(screen.getCursorScreenPoint()), IPC.overlayCue, { text, kind: 'info', ttl: 6000 });
  } catch {
    /* no overlay yet */
  }
}

/**
 * A model reply finished (or was stopped): record what it used. `u` null = the provider reported
 * nothing (subscription CLIs, most local servers): counted as a call. Returns what the chat stores.
 */
export function recordReply(provider: ProviderKind, model: string, u: TokenUsage | null): TurnUsage {
  const tu = turnUsage(provider, model, u);
  const day = dayKey();
  recordInto(load(), day, { provider, model, billing: tu.billing, input: tu.input, output: tu.output, cached: tu.cached, cost: tu.billing === 'api' ? tu.cost : 0 });
  scheduleSave();
  if (tu.billing === 'api') checkLimit(day);
  return tu;
}

/** Cloud speech: TTS by characters spoken, STT by seconds of audio. On-device / system voices are free and not recorded. */
export function recordSpeech(kind: 'tts' | 'stt', provider: string, model: string, amount: number): void {
  if (!(amount > 0) || ['on-device', 'kokoro', 'system', 'off', 'local'].includes(provider)) return;
  const cost = speechCost(kind, provider, amount);
  const day = dayKey();
  recordInto(load(), day, {
    provider: 'speech',
    model: `${provider} ${kind === 'tts' ? 'voice' : 'transcription'}${model ? ` · ${model}` : ''}`,
    billing: 'api',
    cost,
    ...(kind === 'tts' ? { chars: amount } : { seconds: amount }),
  });
  scheduleSave();
  checkLimit(day);
}

export function usageSummary(): UsageSummary {
  return summarize(load(), dayKey(), getSettings().usage?.monthlyLimit ?? 0);
}

export function resetUsage(): UsageSummary {
  store = emptyStore();
  writeNow();
  return usageSummary();
}
