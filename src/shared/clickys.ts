// Named companions ("clickys"): pure helpers shared by main and the renderers.
// Type-only imports, so `node --experimental-strip-types --test` can load it (test/clickys.test.ts).
import type { Clicky, ClickySuggestion, ProviderKind, Settings, TtsProvider } from './types';

/** the default clicky every install has (migrated users: their current settings) */
export const DEFAULT_CLICKY_ID = 'clickity';
export const MAX_CLICKYS = 12;
export const CLICKY_NAME_MAX = 24;
export const CLICKY_PERSONA_MAX = 1200;

/** mark colors offered for new / suggested clickys (the user's own color is content) */
export const CLICKY_COLORS = ['', '#2f6bff', '#7c4dff', '#ff4f9a', '#ff8a00', '#1fbf5b', '#14b8b0', '#ff3b30', '#ffcc00', '#ffffff'];

const PROVIDERS: ProviderKind[] = ['claude-subscription', 'chatgpt-subscription', 'gemini-subscription', 'anthropic-api', 'openai-api', 'gemini-api', 'openrouter', 'local'];
const TTS: TtsProvider[] = ['system', 'openai', 'elevenlabs', 'off'];

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const isColor = (v: unknown): v is string => typeof v === 'string' && (v === '' || /^#[0-9a-f]{6}$/i.test(v));

/** "Study Buddy!" → "study-buddy" (unique among `taken`) */
export function clickyIdFor(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'clicky';
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** One clicky with every field in shape (null = unusable). */
export function cleanClicky(raw: unknown): Clicky | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Clicky>;
  const id = str(r.id, 32).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
  const name = str(r.name, CLICKY_NAME_MAX).replace(/\s+/g, ' ').trim() || id;
  const out: Clicky = { id, name, color: isColor(r.color) ? r.color.toLowerCase() : '', persona: str(r.persona, CLICKY_PERSONA_MAX) };
  if (r.provider && PROVIDERS.includes(r.provider)) {
    out.provider = r.provider;
    const model = str(r.model, 200).trim();
    if (model) out.model = model;
  }
  if (r.voice && typeof r.voice === 'object' && TTS.includes(r.voice.provider)) out.voice = { provider: r.voice.provider, voice: str(r.voice.voice, 200) };
  if (typeof r.createdAt === 'number' && Number.isFinite(r.createdAt)) out.createdAt = r.createdAt;
  return out;
}

/**
 * Keeps `clickys` / `activeClicky` usable (mutates s): drops broken entries and duplicate ids,
 * and gives an install without any (older settings.json) the default "clickity", carrying the
 * current companion color. Also fixes companion.notch.
 */
export function fixClickys(s: Settings): Settings {
  const seen = new Set<string>();
  const list: Clicky[] = [];
  for (const raw of Array.isArray(s.clickys) ? s.clickys : []) {
    const c = cleanClicky(raw);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    list.push(c);
    if (list.length >= MAX_CLICKYS) break;
  }
  if (!list.length) {
    const color = isColor(s.companion?.color) ? s.companion.color : '';
    list.push({ id: DEFAULT_CLICKY_ID, name: 'clickity', color, persona: '' });
  }
  s.clickys = list;
  if (typeof s.activeClicky !== 'string' || !list.some((c) => c.id === s.activeClicky)) s.activeClicky = list[0].id;
  if (s.companion && !['off', 'hover', 'always'].includes(s.companion.notch as string)) s.companion.notch = 'off';
  return s;
}

/** The clicky with this id, else the active one, else the first. */
export function clickyById(s: Pick<Settings, 'clickys' | 'activeClicky'>, id?: string | null): Clicky {
  const list = s.clickys?.length ? s.clickys : [{ id: DEFAULT_CLICKY_ID, name: 'clickity', color: '', persona: '' }];
  return list.find((c) => c.id === (id || s.activeClicky)) ?? list.find((c) => c.id === s.activeClicky) ?? list[0];
}

export function activeClicky(s: Pick<Settings, 'clickys' | 'activeClicky'>): Clicky {
  return clickyById(s, s.activeClicky);
}

/** The clicky a stored chat belongs to (no clickyId = the default one). */
export function chatClickyId(chat: { clickyId?: string }): string {
  return chat.clickyId || DEFAULT_CLICKY_ID;
}

/**
 * Settings as seen by one clicky's turn: its brain / voice overrides applied, activeClicky set to
 * it (buildSystemPrompt reads the name + persona from there). Never persisted.
 */
export function settingsForClicky(s: Settings, id?: string | null): Settings {
  const c = clickyById(s, id);
  const out: Settings = { ...s, activeClicky: c.id };
  if (c.provider) {
    out.provider = c.provider;
    if (c.model) out.models = { ...s.models, [c.provider]: c.model };
  }
  if (c.voice) out.speech = { ...s.speech, tts: { ...s.speech.tts, provider: c.voice.provider, voice: c.voice.voice } };
  return out;
}

const norm = (t: string): string =>
  t
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * "switch to study buddy", "hey, change to coding sidekick.", "talk to clickity" → that clicky
 * (null when the words aren't a switch command or name nobody). Handled locally, no model call.
 */
export function parseSwitchCommand(text: string, clickys: readonly Clicky[]): Clicky | null {
  const t = norm(text);
  if (!t || t.split(' ').length > 9) return null;
  const m = /^(?:(?:hey|ok|okay|please|so)\s+)*(?:switch|change|swap|go)\s+(?:back\s+|over\s+)?to\s+(.+)$|^(?:let me\s+|i want to\s+)?talk\s+to\s+(.+)$/.exec(t);
  if (!m) return null;
  let target = (m[1] ?? m[2] ?? '').replace(/\s+please$/, '').trim();
  target = target.replace(/^(?:my|the)\s+/, '');
  if (!target) return null;
  const exact = clickys.find((c) => norm(c.name) === target);
  if (exact) return exact;
  // "switch to the study buddy clicky" / "switch to buddy"
  const stripped = target.replace(/\s+(?:clicky|companion|one)$/, '');
  return (
    clickys.find((c) => norm(c.name) === stripped) ??
    clickys.find((c) => norm(c.name).replace(/\s+/g, '') === stripped.replace(/\s+/g, '')) ??
    (stripped.length >= 4 ? clickys.find((c) => norm(c.name).split(' ').includes(stripped)) : undefined) ??
    null
  );
}

/** The identity line + persona for the system prompt. */
export function clickyIdentity(c: Clicky): { name: string; persona: string } {
  const name = c.name.trim() || 'Clickity';
  return { name: name === 'clickity' ? 'Clickity' : name, persona: c.persona.trim() };
}

/**
 * The model's answer to "suggest clickys": a JSON array (possibly inside prose or a code fence)
 * of { name, persona, color?, why? }. Up to 3 usable suggestions; names already taken are skipped.
 */
export function parseSuggestions(raw: string, takenNames: Iterable<string> = []): ClickySuggestion[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const taken = new Set([...takenNames].map(norm));
  const out: ClickySuggestion[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const name = str(r.name, CLICKY_NAME_MAX).replace(/\s+/g, ' ').trim().toLowerCase();
    const persona = str(r.persona, CLICKY_PERSONA_MAX).trim();
    if (!name || !persona || taken.has(norm(name))) continue;
    taken.add(norm(name));
    const color = isColor(r.color) && r.color ? r.color.toLowerCase() : CLICKY_COLORS[1 + (out.length % (CLICKY_COLORS.length - 2))];
    out.push({ name, persona, color, why: str(r.why, 160).trim() });
    if (out.length >= 3) break;
  }
  return out;
}
