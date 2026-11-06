// Tiny bridge for "is clickity busy?" (stop / pause): feature modules poke it when their state
// changes (dictation, drafts), conversation.ts recomputes and publishes; the tray and the notch
// panel listen. No imports, so any module can use it without import cycles.
import type { BusyMode } from './stop-logic';

export interface BusyInfo {
  mode: BusyMode;
  /** the global stop key applies (it is grabbed) */
  global: boolean;
  /** the chat the busy turn is recorded in (null = none yet / a dictation) */
  chatId: string | null;
}

let poke: (() => void) | null = null;
let resend: (() => void) | null = null;
let last: BusyInfo | null = null;
const listeners = new Set<(b: BusyInfo | null) => void>();

/** Something that changes busy-ness happened (dictation started, draft preview closed…). */
export function pokeBusy(): void {
  poke?.();
}

/** conversation.ts: who recomputes on a poke. */
export function setBusyPoke(fn: () => void): void {
  poke = fn;
}

/** conversation.ts: send the chats window the busy state again (it just loaded). */
export function setBusyResend(fn: () => void): void {
  resend = fn;
}

/** The chats window (re)loaded: tell it what is busy right now. */
export function resendBusy(): void {
  resend?.();
}

/** conversation.ts publishes the new state (only call on change). */
export function publishBusy(b: BusyInfo | null): void {
  last = b;
  for (const cb of [...listeners]) {
    try {
      cb(b);
    } catch (e) {
      console.warn('[busy] listener threw:', e);
    }
  }
}

export function currentBusy(): BusyInfo | null {
  return last;
}

export function onBusyChanged(cb: (b: BusyInfo | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
