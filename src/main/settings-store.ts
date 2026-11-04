// Persistent settings: load/merge/validate, encrypt API keys at rest, debounced atomic writes.
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, PROVIDER_KINDS, type DeepPartial, type Settings } from '../shared/types';

type Obj = Record<string, unknown>;
type Listener = (s: Settings, prev: Settings) => void;

const WRITE_DEBOUNCE_MS = 150;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

let current: Settings | null = null;
let dirty = false;
let writeTimer: NodeJS.Timeout | null = null;
let quitHooked = false;
let warnedPlaintext = false;
const listeners = new Set<Listener>();

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = (s: Settings): Settings => structuredClone(s);
const settingsPath = (): string => path.join(app.getPath('userData'), 'settings.json');
const asObj = (s: Settings): Obj => s as unknown as Obj;

/* ───────────────────────── secrets ───────────────────────── */

/** Calls fn for every object that holds an apiKey: each provider, speech.stt, speech.tts. */
function forEachSecret(root: Obj, fn: (holder: Obj) => void): void {
  const providers = isObj(root.providers) ? root.providers : {};
  for (const kind of PROVIDER_KINDS) if (isObj(providers[kind])) fn(providers[kind] as Obj);
  const speech = isObj(root.speech) ? root.speech : {};
  for (const section of ['stt', 'tts'] as const) if (isObj(speech[section])) fn(speech[section] as Obj);
}

function encryptionReady(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function protect(value: string): string {
  if (!encryptionReady()) {
    if (!warnedPlaintext) {
      console.warn('settings: safeStorage unavailable, API keys are stored in plain text');
      warnedPlaintext = true;
    }
    return value;
  }
  return 'enc:' + safeStorage.encryptString(value).toString('base64');
}

/** Returns the plain key, or undefined when it cannot be decrypted. */
function unprotect(value: string): string | undefined {
  if (!value.startsWith('enc:')) return value; // plaintext fallback
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
  } catch {
    return undefined;
  }
}

/* ───────────────────────── merge & validate ───────────────────────── */

/** Drops keys whose value has the wrong shape for the default at the same path. Unknown keys pass. */
function prune(src: Obj, def: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(src)) {
    if (UNSAFE_KEYS.has(k) || v === undefined) continue;
    if (!Object.hasOwn(def, k)) {
      out[k] = v;
      continue;
    }
    const d = def[k];
    if (isObj(d)) {
      if (isObj(v)) out[k] = prune(v, d);
    } else if (Array.isArray(d)) {
      if (Array.isArray(v)) out[k] = v;
    } else if (typeof v === typeof d) {
      out[k] = v;
    }
  }
  return out;
}

/** Deep merge: objects recurse, arrays and primitives replace, an apiKey of '' removes the key. */
function merge(base: Obj, patch: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(k) || v === undefined) continue;
    if (k === 'apiKey' && v === '') {
      delete out[k];
    } else if (isObj(v)) {
      out[k] = merge(isObj(base[k]) ? (base[k] as Obj) : {}, v);
    } else {
      out[k] = Array.isArray(v) ? structuredClone(v) : v;
    }
  }
  return out;
}

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

const isKeyList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((k) => typeof k === 'string' && k.length > 0);

/** Fixes values that would break the app; mutates and returns s. */
function validate(s: Settings): Settings {
  const d = DEFAULT_SETTINGS;
  if (!PROVIDER_KINDS.includes(s.provider)) s.provider = d.provider;
  if (!isKeyList(s.hotkeys.talk)) s.hotkeys.talk = [...d.hotkeys.talk];
  if (!isKeyList(s.hotkeys.type)) s.hotkeys.type = [...d.hotkeys.type];
  s.companion.scale = clamp(s.companion.scale, 0.75, 1.5, d.companion.scale);
  s.speech.tts.rate = clamp(s.speech.tts.rate, 0.5, 2, d.speech.tts.rate);
  s.historyTurns = Math.round(clamp(s.historyTurns, 0, 20, d.historyTurns));
  return s;
}

/* ───────────────────────── disk ───────────────────────── */

function serialize(s: Settings): string {
  const copy = asObj(clone(s));
  forEachSecret(copy, (h) => {
    if (typeof h.apiKey === 'string' && h.apiKey) h.apiKey = protect(h.apiKey);
  });
  return JSON.stringify(copy, null, 2);
}

/** Writes the current settings to disk now (temp file, then rename). */
function flush(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (!current || !dirty) return;
  try {
    const file = settingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, serialize(current), { mode: 0o600 });
    fs.renameSync(tmp, file);
    dirty = false;
  } catch (err) {
    console.error('settings: could not save settings.json', err);
  }
}

function scheduleWrite(): void {
  dirty = true;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, WRITE_DEBOUNCE_MS);
}

function hookQuit(): void {
  if (quitHooked) return;
  quitHooked = true;
  app.on('before-quit', flush);
}

function ensureLoaded(): Settings {
  if (!current) loadSettings();
  return current as Settings;
}

function notify(next: Settings, prev: Settings): void {
  for (const cb of [...listeners]) {
    try {
      cb(clone(next), clone(prev));
    } catch (err) {
      console.error('settings: listener failed', err);
    }
  }
}

/* ───────────────────────── public API ───────────────────────── */

/** Reads settings.json, merges it over the defaults, decrypts secrets. Call once after app ready. */
export function loadSettings(): Settings {
  flush(); // never lose a pending in-memory change when re-reading
  hookQuit();

  let stored: Obj = {};
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (isObj(raw)) stored = prune(raw, asObj(DEFAULT_SETTINGS));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('settings: settings.json is unreadable, using defaults', err);
    }
  }

  const merged = merge(asObj(clone(DEFAULT_SETTINGS)), stored);
  let upgradePlaintext = false;
  forEachSecret(merged, (h) => {
    if (typeof h.apiKey !== 'string') {
      delete h.apiKey;
      return;
    }
    const plain = unprotect(h.apiKey);
    if (!plain) {
      delete h.apiKey; // undecryptable or empty: drop it
      return;
    }
    if (!h.apiKey.startsWith('enc:') && encryptionReady()) upgradePlaintext = true;
    h.apiKey = plain;
  });

  current = validate(merged as unknown as Settings);
  dirty = false;
  if (upgradePlaintext) scheduleWrite(); // re-save plaintext keys encrypted now that safeStorage works
  return clone(current);
}

/** In-memory settings with secrets decrypted. */
export function getSettings(): Settings {
  return clone(ensureLoaded());
}

/** Deep-merges patch into the settings, validates, persists (debounced) and notifies listeners. */
export function updateSettings(patch: DeepPartial<Settings>): Settings {
  const prev = ensureLoaded();
  const cleanPatch = prune(asObj(patch as Settings), asObj(DEFAULT_SETTINGS));
  const next = validate(merge(asObj(clone(prev)), cleanPatch) as unknown as Settings);
  current = next;
  scheduleWrite();
  notify(next, prev);
  return clone(next);
}

/** Restores defaults for everything (secrets included), persists and notifies. */
export function resetSettings(): Settings {
  const prev = ensureLoaded();
  const next = validate(clone(DEFAULT_SETTINGS));
  current = next;
  scheduleWrite();
  notify(next, prev);
  return clone(next);
}

/** Subscribes to changes. Returns the unsubscribe function. */
export function onSettingsChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
