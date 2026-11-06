// Named companions ("clickys"): switching, the active clicky's color, the local
// "switch to <name>" command and "suggest clickys for me". Pure helpers: ../shared/clickys.ts.
import { ipcMain } from 'electron';
import { IPC } from '../shared/ipc';
import { PROVIDER_META, type Clicky, type ClickyCreateResult, type ClickyQuizAnswers, type ClickySuggestion, type DeepPartial, type ProviderKind, type Settings } from '../shared/types';
import { activeClicky, clickyById, parseSuggestions, parseSwitchCommand, CLICKY_COLORS } from '../shared/clickys';
import { getSettings, onSettingsChanged, updateSettings } from './settings-store';
import { getProvider } from './providers/index';
import { log } from './log';
import { clearFacts, listFacts, notifyActiveClickyChanged } from './memory';

let initialized = false;

/** Make `id` the active clicky (tray, chats switcher, voice command). Returns it, or null if unknown. */
export function switchClicky(id: string): Clicky | null {
  const s = getSettings();
  const c = s.clickys.find((x) => x.id === id);
  if (!c) return null;
  if (s.activeClicky !== id) updateSettings({ activeClicky: id });
  return c;
}

/** "switch to <name>": switch locally (no model call). Returns the clicky, or null if it isn't one. */
export function trySwitchCommand(text: string): Clicky | null {
  const s = getSettings();
  if (s.clickys.length < 2) return null;
  const target = parseSwitchCommand(text, s.clickys);
  if (!target) return null;
  log('clickys', `switch command → ${target.id}`);
  return switchClicky(target.id);
}

export function currentClicky(): Clicky {
  return activeClicky(getSettings());
}

/**
 * Keep the overlay's companion color and the active clicky's color the same thing:
 * switching shows the new clicky's color; editing either one updates the other.
 * Applied on the next tick, so every settings listener sees this change before the follow-up.
 */
function syncColor(s: Settings, prev: Settings): void {
  const cur = clickyById(s, s.activeClicky);
  let patch: DeepPartial<Settings> | null = null;
  if (s.activeClicky !== prev.activeClicky) {
    log('clickys', `active clicky: ${prev.activeClicky} → ${s.activeClicky}`);
    setImmediate(notifyActiveClickyChanged); // settings › memory follows the active clicky
    if (s.companion.color !== cur.color) patch = { companion: { color: cur.color } };
  } else {
    const before = prev.clickys.find((c) => c.id === cur.id);
    if (before && before.color !== cur.color && s.companion.color !== cur.color) patch = { companion: { color: cur.color } };
    else if (s.companion.color !== prev.companion.color && s.companion.color !== cur.color) {
      patch = { clickys: s.clickys.map((c) => (c.id === cur.id ? { ...c, color: s.companion.color } : c)) };
    }
  }
  if (patch) {
    const p = patch;
    setImmediate(() => updateSettings(p));
  }
}

/* ───────────────────────── suggest clickys ───────────────────────── */

const SUGGEST_TIMEOUT_MS = 90_000;

function suggestPrompt(a: ClickyQuizAnswers, existing: Clicky[]): string {
  return `The user is setting up "clickys": small AI companions that live next to their mouse cursor, see their screen and answer by voice. Each clicky has a short lowercase name and a persona (instructions for how it helps and talks).

Their answers to three quick questions:
- what they mostly use their computer for: ${a.use}
- where they get stuck most: ${a.stuck}
- how they like to be talked to: ${a.tone}

They already have: ${existing.map((c) => c.name).join(', ') || 'none'}.

Propose exactly 3 new clickys that fit them, each focused on a different job (e.g. "spreadsheet helper", "study buddy", "coding sidekick"). Reply with ONLY a JSON array, no prose, no code fence:
[{"name": "1-3 lowercase words", "persona": "2-4 sentences in second person, starting with 'You are' or 'You help', saying what it focuses on and how it talks", "why": "one short lowercase line on why it fits them"}]`;
}

export async function suggestClickys(answers: ClickyQuizAnswers): Promise<ClickySuggestion[]> {
  const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'not sure';
  const a: ClickyQuizAnswers = { use: clean(answers?.use), stuck: clean(answers?.stuck), tone: clean(answers?.tone) };
  const s = getSettings();
  const kind = s.provider;
  const model = s.models[kind] || PROVIDER_META[kind].defaultModel;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SUGGEST_TIMEOUT_MS);
  const t0 = Date.now();
  let text = '';
  try {
    for await (const d of getProvider(kind).stream(
      {
        system: 'You design helpful AI companion personas. You reply with JSON only.',
        messages: [{ role: 'user', text: suggestPrompt(a, s.clickys) }],
        model,
        signal: ctrl.signal,
      },
      s.providers[kind] ?? {},
    )) {
      text += d;
      if (text.length > 20_000) break;
    }
  } catch (err) {
    log('clickys', 'suggest failed:', err);
    throw new Error(ctrl.signal.aborted ? 'the model took too long — try again' : (err instanceof Error ? err.message : String(err)).split('\n')[0].toLowerCase());
  } finally {
    clearTimeout(timer);
  }
  const out = parseSuggestions(text, s.clickys.map((c) => c.name));
  log('clickys', `suggest via ${kind} / ${model}: ${out.length} suggestion(s) in ${Date.now() - t0}ms`);
  if (!out.length) throw new Error("couldn't read the model's suggestions — try again");
  // spread the colors so three new marks don't all look alike
  const used = new Set(s.clickys.map((c) => c.color));
  const free = CLICKY_COLORS.filter((c) => c && !used.has(c));
  return out.map((sug, i) => ({ ...sug, color: used.has(sug.color) && free[i] ? free[i] : sug.color }));
}

/* ───────────────────────── make a clicky from a description ───────────────────────── */

/**
 * Cheapest first: a local model is free; then the lightest model of each subscription the user already
 * pays for; then API keys (pay per request), cheapest models first. Only providers that report ready
 * (CLI signed in, key saved, server reachable) are used. Falls back to the user's own model.
 */
const CHEAP_ORDER: Array<{ kind: ProviderKind; model?: string }> = [
  { kind: 'local' }, // whatever local model they picked
  { kind: 'gemini-subscription', model: 'gemini-3.5-flash-lite' },
  { kind: 'chatgpt-subscription', model: 'gpt-6-luna' },
  { kind: 'claude-subscription', model: 'haiku' },
  { kind: 'openrouter', model: 'google/gemini-3.5-flash-lite' },
  { kind: 'gemini-api', model: 'gemini-3.5-flash-lite' },
  { kind: 'openai-api', model: 'gpt-6-luna' },
  { kind: 'anthropic-api', model: 'claude-haiku-5-5' },
];
let cheapCache: { at: number; pick: { kind: ProviderKind; model: string } } | null = null;

export async function cheapestModel(): Promise<{ kind: ProviderKind; model: string }> {
  if (cheapCache && Date.now() - cheapCache.at < 10 * 60_000) return cheapCache.pick;
  const s = getSettings();
  for (const c of CHEAP_ORDER) {
    try {
      const ready = await Promise.race([
        getProvider(c.kind).status(s.providers[c.kind] ?? {}),
        new Promise<{ ok: false }>((r) => setTimeout(() => r({ ok: false }), 12_000)),
      ]);
      if (!ready.ok) continue;
      const pick = { kind: c.kind, model: c.model ?? (s.models[c.kind] || PROVIDER_META[c.kind].defaultModel) };
      cheapCache = { at: Date.now(), pick };
      return pick;
    } catch {
      /* not set up */
    }
  }
  // nothing answered "ready" in time: still use the lightest model of the provider they already use
  const own = CHEAP_ORDER.find((c) => c.kind === s.provider);
  return { kind: s.provider, model: own?.model ?? (s.models[s.provider] || PROVIDER_META[s.provider].defaultModel) };
}

function createPrompt(description: string, existing: Clicky[]): string {
  return `The user wants a new "clicky": a small AI companion that lives next to their mouse cursor, sees their screen and answers by voice. They described it in their own words:

"${description}"

They already have: ${existing.map((c) => c.name).join(', ') || 'none'}.

Make exactly what they asked for: one clicky, or several only if they clearly asked for more than one (max 3). Keep their wording for the name if they gave one. Reply with ONLY a JSON array, no prose, no code fence:
[{"name": "1-3 lowercase words", "persona": "2-4 sentences in second person, starting with 'You are' or 'You help', saying what it focuses on and how it talks", "why": "one short lowercase line"}]`;
}

export async function createClickys(description: unknown): Promise<ClickyCreateResult> {
  const text = String(description ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!text) throw new Error('describe the clicky you want first');
  const s = getSettings();
  const { kind, model } = await cheapestModel();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SUGGEST_TIMEOUT_MS);
  const t0 = Date.now();
  let out = '';
  try {
    for await (const d of getProvider(kind).stream(
      { system: 'You design helpful AI companion personas. You reply with JSON only.', messages: [{ role: 'user', text: createPrompt(text, s.clickys) }], model, signal: ctrl.signal },
      s.providers[kind] ?? {},
    )) {
      out += d;
      if (out.length > 20_000) break;
    }
  } catch (err) {
    log('clickys', 'create failed:', err);
    throw new Error(ctrl.signal.aborted ? 'the model took too long — try again' : (err instanceof Error ? err.message : String(err)).split('\n')[0].toLowerCase());
  } finally {
    clearTimeout(timer);
  }
  const list = parseSuggestions(out, s.clickys.map((c) => c.name)).slice(0, 3);
  log('clickys', `create via ${kind} / ${model}: ${list.length} clicky(s) in ${Date.now() - t0}ms`);
  if (!list.length) throw new Error("couldn't read the model's answer — try again");
  const used = new Set(s.clickys.map((c) => c.color));
  const free = CLICKY_COLORS.filter((c) => c && !used.has(c));
  return {
    suggestions: list.map((sug, i) => ({ ...sug, color: used.has(sug.color) && free[i] ? free[i] : sug.color })),
    via: `${PROVIDER_META[kind].label} · ${model}`,
  };
}

/* ───────────────────────── init ───────────────────────── */

export function initClickys(): void {
  if (initialized) return;
  initialized = true;
  onSettingsChanged(syncColor);
  ipcMain.handle(IPC.clickysSuggest, (_e, answers: ClickyQuizAnswers) => suggestClickys(answers));
  ipcMain.handle(IPC.clickysCreate, (_e, description: unknown) => createClickys(description));
  // each clicky has its own memory (memory.ts: memory.json for the default one, memory-<id>.json)
  ipcMain.handle(IPC.clickysMemory, (_e, id: unknown) => (typeof id === 'string' && getSettings().clickys.some((c) => c.id === id) ? listFacts(id).length : 0));
  ipcMain.handle(IPC.clickysForget, (_e, id: unknown) => {
    if (typeof id === 'string' && getSettings().clickys.some((c) => c.id === id)) clearFacts(id);
  });
  const s = getSettings();
  log('clickys', `${s.clickys.length} clicky(s), active ${s.activeClicky}`);
}
