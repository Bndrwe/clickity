// Stored chat history: one JSON file per chat in <userData>/chats/<id>.json.
// The full list of summaries is loaded once and kept in memory; chats are cached on read.
// Screenshots are never stored (only a count), attachments by name only.
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { Chat, ChatSummary, ChatTurn } from '../shared/types';

const TITLE_MAX = 60;
const PREVIEW_MAX = 120;

let dir: string | null = null;
let index: Map<string, ChatSummary> | null = null;
const cache = new Map<string, Chat>();
const listeners = new Set<(list: ChatSummary[]) => void>();

/* ───────────────────────── helpers ───────────────────────── */

let lastIdTime = 0;
/** Time-sortable id: base36 ms timestamp (fixed width) + random suffix. */
export function newId(): string {
  const now = Math.max(Date.now(), lastIdTime + 1);
  lastIdTime = now;
  return now.toString(36).padStart(9, '0') + Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

function chatsDir(): string {
  if (!dir) {
    dir = path.join(app.getPath('userData'), 'chats');
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function isValidId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9]{4,40}$/.test(id);
}

function fileFor(id: string): string {
  return path.join(chatsDir(), `${id}.json`);
}

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function autoTitle(chat: Chat): string {
  const first = chat.turns.find((t) => t.role === 'user' && t.text.trim());
  if (first) return oneLine(first.text, TITLE_MAX);
  const named = chat.turns.find((t) => t.role === 'user' && t.attachments?.length);
  return named ? oneLine(named.attachments!.join(', '), TITLE_MAX) : '';
}

function summarize(chat: Chat): ChatSummary {
  let preview = '';
  for (let i = chat.turns.length - 1; i >= 0; i--) {
    const t = chat.turns[i];
    if (t.role === 'assistant' && t.text.trim()) {
      preview = oneLine(t.text, PREVIEW_MAX);
      break;
    }
  }
  return {
    id: chat.id,
    title: chat.title || 'new chat',
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    turnCount: chat.turns.length,
    preview,
  };
}

function parseChat(raw: unknown, id: string): Chat | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Partial<Chat>;
  if (!Array.isArray(c.turns)) return null;
  const createdAt = typeof c.createdAt === 'number' ? c.createdAt : Date.now();
  return {
    id,
    title: typeof c.title === 'string' ? c.title : '',
    createdAt,
    updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : createdAt,
    turns: c.turns.filter((t): t is ChatTurn => !!t && typeof t === 'object' && typeof t.id === 'string' && typeof t.text === 'string'),
  };
}

function readChatFile(id: string): Chat | null {
  try {
    return parseChat(JSON.parse(fs.readFileSync(fileFor(id), 'utf8')), id);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[chat-store] could not read chat ${id}:`, err);
    return null;
  }
}

/** Atomic write: tmp file + rename. */
function writeChat(chat: Chat): void {
  const file = fileFor(chat.id);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(chat, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error(`[chat-store] could not save chat ${chat.id}:`, err);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function loadIndex(): Map<string, ChatSummary> {
  if (index) return index;
  index = new Map();
  let names: string[] = [];
  try {
    names = fs.readdirSync(chatsDir());
  } catch (err) {
    console.warn('[chat-store] could not list chats:', err);
  }
  for (const name of names) {
    if (name.endsWith('.tmp')) {
      // leftover from a crash mid-write
      try {
        fs.unlinkSync(path.join(chatsDir(), name));
      } catch {
        /* ignore */
      }
      continue;
    }
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue;
    const chat = readChatFile(id);
    if (chat) index.set(id, summarize(chat));
  }
  return index;
}

function emitChanged(): void {
  const list = listChats();
  for (const cb of listeners) {
    try {
      cb(list);
    } catch (err) {
      console.warn('[chat-store] listener failed:', err);
    }
  }
}

/** Load (cached) a chat for mutation. */
function load(id: string): Chat | null {
  if (!isValidId(id)) return null;
  const cached = cache.get(id);
  if (cached) return cached;
  if (!loadIndex().has(id)) return null;
  const chat = readChatFile(id);
  if (chat) cache.set(id, chat);
  return chat;
}

function save(chat: Chat): void {
  writeChat(chat);
  cache.set(chat.id, chat);
  loadIndex().set(chat.id, summarize(chat));
  emitChanged();
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

/* ───────────────────────── API ───────────────────────── */

/** All chats, newest `updatedAt` first. */
export function listChats(): ChatSummary[] {
  return [...loadIndex().values()].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
}

export function getChat(id: string): Chat | null {
  const chat = load(id);
  return chat ? clone(chat) : null;
}

export function getSummary(id: string): ChatSummary | null {
  return (isValidId(id) && loadIndex().get(id)) || null;
}

export function hasChat(id: string): boolean {
  return isValidId(id) && loadIndex().has(id);
}

export function createChat(): Chat {
  const now = Date.now();
  const chat: Chat = { id: newId(), title: '', createdAt: now, updatedAt: now, turns: [] };
  save(chat);
  return clone(chat);
}

/** Append a turn (id/at filled in when missing). Returns the stored turn, or null if the chat is gone. */
export function appendTurn(chatId: string, turn: Omit<ChatTurn, 'id' | 'at'> & Partial<Pick<ChatTurn, 'id' | 'at'>>): ChatTurn | null {
  const chat = load(chatId);
  if (!chat) return null;
  const stored: ChatTurn = { ...turn, id: turn.id ?? newId(), at: turn.at ?? Date.now() };
  chat.turns.push(stored);
  chat.updatedAt = Math.max(chat.updatedAt, stored.at);
  if (!chat.title) chat.title = autoTitle(chat);
  save(chat);
  return clone(stored);
}

/** Patch a stored turn. Returns the updated turn, or null if chat/turn are gone. */
export function updateTurn(chatId: string, turnId: string, patch: Partial<Omit<ChatTurn, 'id'>>): ChatTurn | null {
  const chat = load(chatId);
  if (!chat) return null;
  const i = chat.turns.findIndex((t) => t.id === turnId);
  if (i < 0) return null;
  chat.turns[i] = { ...chat.turns[i], ...patch, id: turnId };
  chat.updatedAt = Date.now();
  if (!chat.title) chat.title = autoTitle(chat);
  save(chat);
  return clone(chat.turns[i]);
}

/** Rename; an empty title goes back to the automatic one (first user message). */
export function renameChat(id: string, title: string): void {
  const chat = load(id);
  if (!chat) return;
  const t = oneLine(String(title ?? ''), 200);
  chat.title = t || autoTitle(chat);
  save(chat);
}

export function deleteChat(id: string): void {
  if (!hasChat(id)) return;
  cache.delete(id);
  loadIndex().delete(id);
  try {
    fs.unlinkSync(fileFor(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[chat-store] could not delete chat ${id}:`, err);
  }
  emitChanged();
}

/** Called with the full (sorted) list whenever any chat is created, changed or deleted. */
export function onChatsChanged(cb: (list: ChatSummary[]) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
