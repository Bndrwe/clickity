// Cost & usage meter: the price table, cost math, labels and the per-day store's aggregation.
// Pure (type imports only), shared by main (src/main/usage.ts) and the settings / chats windows.
// Unit tested: test/usage-math.test.ts.
//
// PRICES ARE ESTIMATES. They are list prices per 1M tokens in USD as best known when the table was
// written (PRICES_AS_OF); providers change them, add discounts (batch, regional) and bill things
// this table doesn't know about. Update PRICE_TABLE / SPEECH_PRICES when a provider changes its
// prices — the first matching row wins, so put specific ids above family fallbacks.
import type { Billing, ProviderKind, TokenUsage, TurnUsage } from './types';
import type { UsageModelRow, UsageSummary, UsageTotals } from './ipc';

export const PRICES_AS_OF = '2026-11';

/** USD per 1M tokens. cacheRead / cacheWrite default to the vendor's usual multiple of `input`. */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

type Vendor = 'anthropic' | 'openai' | 'google' | 'other';

/** cache-read / cache-write multiples of the input price, per vendor */
const CACHE: Record<Vendor, { read: number; write: number }> = {
  anthropic: { read: 0.1, write: 1.25 },
  openai: { read: 0.1, write: 1 },
  google: { read: 0.25, write: 1 },
  other: { read: 0.5, write: 1 },
};

/** matched against normalizeModel(id): lowercase, vendor prefix dropped, dots → dashes */
export const PRICE_TABLE: Array<{ match: RegExp; vendor: Vendor; price: Price }> = [
  // anthropic (claude-<family>-<major>-<minor>)
  { match: /^claude-opus/, vendor: 'anthropic', price: { input: 5, output: 25 } },
  { match: /^claude-sonnet/, vendor: 'anthropic', price: { input: 3, output: 15 } },
  { match: /^claude-haiku/, vendor: 'anthropic', price: { input: 1, output: 5 } },
  { match: /^claude-fable/, vendor: 'anthropic', price: { input: 3, output: 15 } },
  { match: /^claude-/, vendor: 'anthropic', price: { input: 3, output: 15 } },
  // openai
  { match: /^gpt-6(-\d+)?-sol/, vendor: 'openai', price: { input: 1.25, output: 10 } },
  { match: /^gpt-6(-\d+)?-astra/, vendor: 'openai', price: { input: 2.5, output: 15 } },
  { match: /^gpt-6(-\d+)?-terra/, vendor: 'openai', price: { input: 0.75, output: 4.5 } },
  { match: /^gpt-6(-\d+)?-luna/, vendor: 'openai', price: { input: 0.25, output: 2 } },
  { match: /^gpt-[4-9][\w-]*-(mini)/, vendor: 'openai', price: { input: 0.25, output: 2 } },
  { match: /^gpt-[4-9][\w-]*-(nano)/, vendor: 'openai', price: { input: 0.05, output: 0.4 } },
  { match: /^gpt-/, vendor: 'openai', price: { input: 1.25, output: 10 } },
  { match: /^o\d/, vendor: 'openai', price: { input: 2, output: 8 } },
  // google
  { match: /^gemini-[\d-]*flash-lite/, vendor: 'google', price: { input: 0.1, output: 0.4 } },
  { match: /^gemini-[\d-]*flash/, vendor: 'google', price: { input: 0.3, output: 2.5 } },
  { match: /^gemini-[\d-]*argon/, vendor: 'google', price: { input: 2, output: 12 } },
  { match: /^gemini-[\d-]*pro/, vendor: 'google', price: { input: 1.25, output: 10 } },
  { match: /^gemini-/, vendor: 'google', price: { input: 0.3, output: 2.5 } },
  { match: /^gemma/, vendor: 'google', price: { input: 0.1, output: 0.2 } },
  // a few openrouter regulars
  { match: /^grok-/, vendor: 'other', price: { input: 3, output: 15 } },
  { match: /^qwen[\w-]*flash/, vendor: 'other', price: { input: 0.05, output: 0.4 } },
];

/** Speech, also estimates: TTS per 1k characters, STT per minute of audio (USD). */
export const SPEECH_PRICES: { tts: Record<string, number>; stt: Record<string, number> } = {
  tts: { openai: 0.015, elevenlabs: 0.1 },
  stt: { openai: 0.006, deepgram: 0.0077, groq: 0.0007, gemini: 0.002 },
};

/** "anthropic/claude-sonnet-5.5" → "claude-sonnet-5-5"; "models/gemini-3.8-flash" → "gemini-3-8-flash" */
export function normalizeModel(id: string): string {
  let m = String(id ?? '').trim().toLowerCase();
  m = m.replace(/^models\//, '');
  m = m.replace(/^[a-z0-9_-]+\//, ''); // openrouter vendor prefix
  m = m.replace(/:.*$/, ''); // ":free", ":beta"
  return m.replace(/[._]/g, '-');
}

export function billingFor(provider: ProviderKind | string): Billing {
  if (provider === 'local') return 'local';
  if (/-subscription$/.test(provider)) return 'subscription';
  return 'api';
}

/** The table row for a model (null = unknown: tokens are counted, the cost isn't guessed). */
export function priceFor(provider: ProviderKind | string, model: string): (Price & { cacheRead: number; cacheWrite: number }) | null {
  if (billingFor(provider) !== 'api') return null;
  const id = normalizeModel(model);
  if (!id) return null;
  if (/:free$/i.test(String(model).trim())) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const row = PRICE_TABLE.find((r) => r.match.test(id));
  if (!row) return null;
  const c = CACHE[row.vendor];
  return {
    input: row.price.input,
    output: row.price.output,
    cacheRead: row.price.cacheRead ?? row.price.input * c.read,
    cacheWrite: row.price.cacheWrite ?? row.price.input * c.write,
  };
}

const n0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** USD for one call; the provider's own figure wins. undefined = unknown price. */
export function costOf(u: TokenUsage, price: (Price & { cacheRead?: number; cacheWrite?: number }) | null): number | undefined {
  if (typeof u.costUsd === 'number' && Number.isFinite(u.costUsd) && u.costUsd >= 0) return u.costUsd;
  if (!price) return undefined;
  const cr = price.cacheRead ?? price.input;
  const cw = price.cacheWrite ?? price.input;
  return (n0(u.input) * price.input + n0(u.output) * price.output + n0(u.cacheRead) * cr + n0(u.cacheWrite) * cw) / 1_000_000;
}

/** What gets stored with the assistant turn. */
export function turnUsage(provider: ProviderKind | string, model: string, u: TokenUsage | null | undefined): TurnUsage {
  const billing = billingFor(provider);
  if (!u) return { billing };
  const out: TurnUsage = { billing, input: n0(u.input) + n0(u.cacheRead) + n0(u.cacheWrite), output: n0(u.output) };
  if (n0(u.cacheRead)) out.cached = n0(u.cacheRead);
  if (billing === 'api') {
    const cost = costOf(u, priceFor(provider, model));
    if (cost !== undefined) out.cost = cost;
    if (typeof u.costUsd === 'number') out.exact = true;
  }
  return out;
}

/** USD for speech: TTS by characters, STT by seconds. 0 for on-device / system / local. */
export function speechCost(kind: 'tts' | 'stt', provider: string, amount: number): number {
  const rate = SPEECH_PRICES[kind][provider];
  if (!rate || !(amount > 0)) return 0;
  return kind === 'tts' ? (amount / 1000) * rate : (amount / 60) * rate;
}

/** "$0.0031", "$0.42", "$12.30", "$1,204" */
export function formatCost(usd: number): string {
  if (!(usd > 0)) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01) return `$${usd.toPrecision(2).replace(/0+$/, '')}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

/** 980 → "980", 1234 → "1.2k", 1_250_000 → "1.25m" */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n || 0));
  if (v < 1000) return String(v);
  if (v < 100_000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (v < 1_000_000) return `${Math.round(v / 1000)}k`;
  return `${(v / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}m`;
}

/** The chats window's quiet meta bit: "~$0.0031 · 1.2k in · 84 out" / "included in your subscription" / "free (local)". */
export function usageLabel(u: TurnUsage | undefined): string {
  if (!u) return '';
  const tokens = u.input || u.output ? `${formatTokens(u.input ?? 0)} in · ${formatTokens(u.output ?? 0)} out` : '';
  if (u.billing === 'subscription') return 'included in your subscription';
  if (u.billing === 'local') return tokens ? `free (local) · ${tokens}` : 'free (local)';
  if (u.cost === undefined) return tokens ? `${tokens} · price unknown` : '';
  return [`${u.exact ? '' : '~'}${formatCost(u.cost)}`, tokens].filter(Boolean).join(' · ');
}

/* ───────── the per-day store (userData/usage.json) ───────── */

export interface UsageRow {
  provider: string;
  model: string;
  billing: Billing;
  calls: number;
  input: number;
  output: number;
  cached: number;
  cost: number;
  unpriced: number;
  chars?: number;
  seconds?: number;
}

export interface UsageStore {
  version: 1;
  /** "YYYY-MM-DD" (local) → "provider|model" → row */
  days: Record<string, Record<string, UsageRow>>;
  /** the month ("YYYY-MM") the soft limit warning was last shown */
  warned?: string;
}

export const KEEP_DAYS = 400;

export function emptyStore(): UsageStore {
  return { version: 1, days: {} };
}

/** Local calendar day. */
export function dayKey(d: Date | number = new Date()): string {
  const x = typeof d === 'number' ? new Date(d) : d;
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

export interface UsageEvent {
  provider: string;
  model: string;
  billing: Billing;
  input?: number;
  output?: number;
  cached?: number;
  /** undefined = unknown price (api) / nothing to pay */
  cost?: number;
  chars?: number;
  seconds?: number;
}

/** Add one call to the store (mutates; drops days older than KEEP_DAYS). */
export function recordInto(store: UsageStore, day: string, ev: UsageEvent): UsageStore {
  const bucket = (store.days[day] ??= {});
  const key = `${ev.provider}|${ev.model}`;
  const row = (bucket[key] ??= { provider: ev.provider, model: ev.model, billing: ev.billing, calls: 0, input: 0, output: 0, cached: 0, cost: 0, unpriced: 0 });
  row.calls++;
  row.input += n0(ev.input);
  row.output += n0(ev.output);
  row.cached += n0(ev.cached);
  if (typeof ev.cost === 'number' && Number.isFinite(ev.cost)) row.cost += Math.max(0, ev.cost);
  else if (ev.billing === 'api') row.unpriced++;
  if (ev.chars) row.chars = (row.chars ?? 0) + n0(ev.chars);
  if (ev.seconds) row.seconds = (row.seconds ?? 0) + n0(ev.seconds);
  const days = Object.keys(store.days).sort();
  while (days.length > KEEP_DAYS) delete store.days[days.shift()!];
  return store;
}

function zero(): UsageTotals {
  return { calls: 0, input: 0, output: 0, cached: 0, cost: 0, unpriced: 0 };
}

function addTo(t: UsageTotals, r: UsageRow): void {
  t.calls += r.calls;
  t.input += r.input;
  t.output += r.output;
  t.cached += r.cached;
  t.cost += r.cost;
  t.unpriced += r.unpriced;
}

/** Month total (estimated USD) for `day`'s month. */
export function monthCost(store: UsageStore, day: string): number {
  const month = day.slice(0, 7);
  let c = 0;
  for (const [d, rows] of Object.entries(store.days)) if (d.startsWith(month)) for (const r of Object.values(rows)) c += r.cost;
  return c;
}

/** Should this call show the soft-limit warning? (once per month, when the month crosses it) */
export function shouldWarn(store: UsageStore, day: string, limit: number): boolean {
  if (!(limit > 0)) return false;
  const month = day.slice(0, 7);
  return store.warned !== month && monthCost(store, day) >= limit;
}

/** settings › usage: today, this month, by model, the last 30 days. */
export function summarize(store: UsageStore, today: string, limit: number, now = new Date()): UsageSummary {
  const month = today.slice(0, 7);
  const t = zero();
  const m = zero();
  const models = new Map<string, UsageModelRow>();
  for (const [d, rows] of Object.entries(store.days)) {
    for (const [key, r] of Object.entries(rows)) {
      if (d === today) addTo(t, r);
      if (!d.startsWith(month)) continue;
      addTo(m, r);
      const row = models.get(key) ?? { provider: r.provider, model: r.model, billing: r.billing, ...zero() };
      addTo(row, r);
      if (r.chars) row.chars = (row.chars ?? 0) + r.chars;
      if (r.seconds) row.seconds = (row.seconds ?? 0) + r.seconds;
      models.set(key, row);
    }
  }
  const byModel = [...models.values()].sort((a, b) => b.cost - a.cost || b.calls - a.calls);
  const days: Array<{ day: string; cost: number }> = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = dayKey(d);
    let cost = 0;
    for (const r of Object.values(store.days[key] ?? {})) cost += r.cost;
    days.push({ day: key, cost });
  }
  const lim = limit > 0 ? limit : 0;
  return {
    today: t,
    month: m,
    byModel,
    days,
    monthlyLimit: lim,
    overLimit: lim > 0 && m.cost >= lim,
    priceNote: `costs are estimates from a price table (${PRICES_AS_OF}) — your provider's bill is the real number`,
  };
}

/** Anything a hand-edited / old usage.json could break: back to a valid store. */
export function fixStore(raw: unknown): UsageStore {
  const s = emptyStore();
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as { days?: unknown; warned?: unknown };
  if (typeof r.warned === 'string') s.warned = r.warned.slice(0, 7);
  if (!r.days || typeof r.days !== 'object') return s;
  for (const [d, rows] of Object.entries(r.days as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !rows || typeof rows !== 'object') continue;
    for (const [k, row] of Object.entries(rows as Record<string, any>)) {
      if (!row || typeof row !== 'object') continue;
      const billing: Billing = row.billing === 'subscription' || row.billing === 'local' ? row.billing : 'api';
      (s.days[d] ??= {})[k] = {
        provider: String(row.provider ?? k.split('|')[0] ?? ''),
        model: String(row.model ?? k.split('|')[1] ?? ''),
        billing,
        calls: n0(row.calls),
        input: n0(row.input),
        output: n0(row.output),
        cached: n0(row.cached),
        cost: n0(row.cost),
        unpriced: n0(row.unpriced),
        ...(row.chars ? { chars: n0(row.chars) } : {}),
        ...(row.seconds ? { seconds: n0(row.seconds) } : {}),
      };
    }
  }
  return s;
}
