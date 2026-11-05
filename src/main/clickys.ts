// Named companions ("clickys"): switching, the active clicky's color, the local
// "switch to <name>" command and "suggest clickys for me". Pure helpers: ../shared/clickys.ts.
import { ipcMain } from 'electron';
import { IPC } from '../shared/ipc';
import { PROVIDER_META, type Clicky, type ClickyQuizAnswers, type ClickySuggestion, type DeepPartial, type Settings } from '../shared/types';
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

/* ───────────────────────── init ───────────────────────── */

export function initClickys(): void {
  if (initialized) return;
  initialized = true;
  onSettingsChanged(syncColor);
  ipcMain.handle(IPC.clickysSuggest, (_e, answers: ClickyQuizAnswers) => suggestClickys(answers));
  // each clicky has its own memory (memory.ts: memory.json for the default one, memory-<id>.json)
  ipcMain.handle(IPC.clickysMemory, (_e, id: unknown) => (typeof id === 'string' && getSettings().clickys.some((c) => c.id === id) ? listFacts(id).length : 0));
  ipcMain.handle(IPC.clickysForget, (_e, id: unknown) => {
    if (typeof id === 'string' && getSettings().clickys.some((c) => c.id === id)) clearFacts(id);
  });
  const s = getSettings();
  log('clickys', `${s.clickys.length} clicky(s), active ${s.activeClicky}`);
}
