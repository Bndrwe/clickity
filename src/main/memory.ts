// Facts the companion remembers across chats ([REMEMBER:fact] tags), in userData/memory.json.
// Deduped, secret-looking text dropped, newest 200 kept. Settings › memory shows / edits them.
// Named companions: every clicky has its own store. The default "clickity" keeps memory.json,
// others use memory-<clickyId>.json. Calls without a clickyId mean the active clicky.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { mergeFacts } from './extra-tags';
import { log } from './log';
import { getSettings } from './settings-store';
import { DEFAULT_CLICKY_ID } from '../shared/clickys';

export const MAX_FACTS = 200;

/** clickyId → facts (loaded lazily) */
const stores = new Map<string, string[]>();
const listeners = new Set<(facts: string[]) => void>();

/** the clicky a call is about: the given one, else the active one */
function scopeOf(clickyId?: string): string {
  const id = clickyId || getSettings().activeClicky || DEFAULT_CLICKY_ID;
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(id) ? id : DEFAULT_CLICKY_ID;
}
const fileFor = (id: string): string => path.join(app.getPath('userData'), id === DEFAULT_CLICKY_ID ? 'memory.json' : `memory-${id}.json`);

function load(id: string): string[] {
  const hit = stores.get(id);
  if (hit) return hit;
  const file = () => fileFor(id);
  let facts: string[];
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file(), 'utf8'));
    const list = Array.isArray(raw) ? raw : Array.isArray((raw as { facts?: unknown })?.facts) ? (raw as { facts: unknown[] }).facts : [];
    facts = mergeFacts([], list.filter((f): f is string => typeof f === 'string'), MAX_FACTS);
  } catch {
    facts = [];
  }
  stores.set(id, facts);
  return facts;
}

function save(next: string[], id: string): string[] {
  stores.set(id, next);
  const file = () => fileFor(id);
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    const tmp = `${file()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, facts: next }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file());
  } catch (err) {
    log('memory', `could not save ${path.basename(file())}:`, err);
  }
  // listeners (settings › memory) follow the active clicky
  if (id !== scopeOf()) return [...next];
  for (const cb of [...listeners]) {
    try {
      cb([...next]);
    } catch {
      /* ignore */
    }
  }
  return [...next];
}

export function listFacts(clickyId?: string): string[] {
  return [...load(scopeOf(clickyId))];
}

/** Add facts from a reply (secrets filtered, deduped). Returns how many were new or refreshed. */
export function rememberFacts(added: string[], clickyId?: string): number {
  if (!added.length) return 0;
  const id = scopeOf(clickyId);
  const before = load(id);
  const next = mergeFacts(before, added, MAX_FACTS);
  if (JSON.stringify(next) === JSON.stringify(before)) return 0;
  save(next, id);
  log('memory', `remembered ${added.length} fact(s), ${next.length} total (${id})`);
  return added.length;
}

/** Replace the whole list (settings edit / delete). */
export function setFacts(list: unknown, clickyId?: string): string[] {
  const clean = Array.isArray(list) ? list.filter((f): f is string => typeof f === 'string') : [];
  return save(mergeFacts([], clean, MAX_FACTS), scopeOf(clickyId));
}

export function clearFacts(clickyId?: string): void {
  const id = scopeOf(clickyId);
  save([], id);
  log('memory', `forgot everything (${id})`);
}

export function onFactsChanged(cb: (facts: string[]) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The system prompt section ('' when off / empty). */
export function memoryPrompt(enabled: boolean, clickyId?: string): string {
  const base = `

MEMORY
You can remember lasting facts about the user across conversations (their name, role, projects, preferences, tools they use). When the user tells you something worth remembering, or asks you to remember something, add a tag at the very end of your reply: [REMEMBER:short fact in third person, e.g. "prefers metric units"]. Only stable, useful facts; never passwords, keys, card numbers or other secrets. The tag is never shown or spoken.`;
  if (!enabled) return '';
  const list = load(scopeOf(clickyId));
  if (!list.length) return base;
  return `${base}
Things you know about the user (use them naturally when relevant; don't recite them):
${list.map((f) => `- ${f}`).join('\n')}`;
}

/** The active clicky changed: settings › memory shows that clicky's facts. */
export function notifyActiveClickyChanged(): void {
  const list = listFacts();
  for (const cb of [...listeners]) {
    try {
      cb([...list]);
    } catch {
      /* ignore */
    }
  }
}
