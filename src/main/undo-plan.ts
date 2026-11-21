// Undo for agent-mode actions, the pure parts (unit tested: test/undo.test.ts).
//
// What can be undone, honestly:
//   - text clickity TYPED (one line, the last thing it did, in the same app, recently): deleted
//     again with backspace, one per character it typed. Exact, no model call.
//   - SCROLLs at the end: scrolled back.
//   - CLICKs and KEYs (and anything before them): not reversible by replaying input. Clickity
//     asks the model to look at a fresh screenshot and reverse its last steps (close what it
//     opened, uncheck what it checked, the app's own undo) — never sending / deleting / paying
//     while undoing. A sent message or a deleted file may not come back; it says so.
import type { InputAction } from '../shared/types';
import type { ParsedAction } from './action-tags';

export interface DoneAction {
  parsed: ParsedAction;
  input: InputAction;
}

export interface UndoPlan {
  /** what clickity reverses by itself, in order (backspaces, reverse scrolls) */
  local: InputAction[];
  /** what that does, in words ("delete “hello” (5 characters)") */
  localNotes: string[];
  /** earlier steps it can't reverse by replaying input, oldest first (the model is asked) */
  rest: ParsedAction[];
}

/** typed text longer than this is not backspaced away (too slow, too much to get wrong) */
export const MAX_LOCAL_CHARS = 500;
/** after this long, backspacing is a guess (the caret may have moved): the model looks instead */
export const LOCAL_MAX_AGE_MS = 10 * 60_000;

/** User-perceived characters (an emoji or "é" is one backspace). */
export function graphemes(text: string): number {
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    let n = 0;
    for (const _ of seg.segment(text)) n++;
    return n;
  } catch {
    return [...text].length;
  }
}

function short(text: string, max = 28): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Walk the run backwards: trailing TYPEs become backspaces and trailing SCROLLs reverse scrolls,
 * until the first step that can't be replayed backwards (a click, a key, multi-line text…);
 * that step and everything before it go to the model. `local` = backspacing is still safe
 * (same app, recent); false sends everything to the model.
 */
export function planUndo(done: DoneAction[], local = true): UndoPlan {
  const plan: UndoPlan = { local: [], localNotes: [], rest: [] };
  let i = done.length - 1;
  for (; local && i >= 0; i--) {
    const { parsed, input } = done[i]!;
    if (input.type === 'wait' || input.type === 'move') continue;
    if (input.type === 'type' && parsed.type === 'type') {
      const n = graphemes(input.text);
      if (!n) continue;
      if (/[\r\n\t]/.test(input.text) || n > MAX_LOCAL_CHARS) break;
      for (let k = 0; k < n; k++) plan.local.push({ type: 'key', keys: ['Backspace'] });
      plan.localNotes.push(`delete “${short(input.text)}” (${n} character${n === 1 ? '' : 's'})`);
      continue;
    }
    if (input.type === 'scroll') {
      plan.local.push({ type: 'scroll', x: input.x, y: input.y, dy: -input.dy, dx: input.dx ? -input.dx : undefined });
      plan.localNotes.push('scroll back');
      continue;
    }
    break;
  }
  plan.rest = done
    .slice(0, i + 1)
    .map((d) => d.parsed)
    .filter((a) => a.type !== 'wait');
  return plan;
}

/** "clicked “save” · pressed cmd+s" for the bubble / the model (describe = action-tags.describeAction). */
export function restSummary(rest: ParsedAction[], describe: (a: ParsedAction) => string): string {
  return rest.map(describe).join(' · ');
}

/** The confirm line in the bubble: what it will do, and what it can only try. */
export function undoSummary(plan: UndoPlan, describe: (a: ParsedAction) => string): string {
  const parts: string[] = [];
  if (plan.localNotes.length) parts.push(plan.localNotes.join(' · '));
  if (plan.rest.length) parts.push(`then look and try to reverse: ${restSummary(plan.rest, describe)} (clicks and keys can't always be undone)`);
  return parts.length ? `undo: ${parts.join(' — ')}` : 'nothing to undo';
}

/** What the model is asked when steps are left for it (fresh screenshot attached by the turn). */
export function undoPrompt(plan: UndoPlan, describe: (a: ParsedAction) => string, platform: string): string {
  const undoKey = platform === 'darwin' ? 'cmd+z' : 'ctrl+z';
  const steps = plan.rest.map((a, i) => `${i + 1}. ${describe(a)}`).join('\n');
  const already = plan.localNotes.length ? `\nclickity already reversed the last part itself (${plan.localNotes.join(', ')}).` : '';
  return (
    `undo what you just did. these are the steps you (clickity) did on my screen, oldest first:\n${steps}${already}\n\n` +
    'look at the screen now and reverse those steps if it is safe: close what you opened, uncheck what you checked, ' +
    `go back where you navigated, or use the app's own undo (${undoKey}). ` +
    'while undoing never send, submit, delete, pay, buy, post or close anything without saving, and do not touch anything else. ' +
    'if a step cannot be undone (a message was sent, something was deleted or bought), say so plainly in one short sentence and reply [DONE]. ' +
    'when it is undone (or nothing needs undoing), reply [DONE] with one short sentence.'
  );
}

const UNSAFE_LABEL = /\b(send|sent|delete|remove|trash|erase|wipe|pay|purchase|buy|order|checkout|post|publish|submit|confirm|empty|discard|unsubscribe|transfer|sign ?out|log ?out|don'?t save|uninstall|format|reset)\b/i;

/**
 * While undoing, clickity never chains a destructive step: anything that could send, submit,
 * delete or pay stops the undo run instead (the user decides by hand). Returns why, or null.
 */
export function undoUnsafe(actions: ParsedAction[]): string | null {
  for (const a of actions) {
    if (a.type === 'click' && UNSAFE_LABEL.test(a.label)) return a.label.toLowerCase();
    if (a.type === 'type' && /[\r\n]/.test(a.text)) return 'typing a new line';
    if (a.type === 'key') {
      const k = a.keys.filter((x) => x !== 'Shift');
      const main = k[k.length - 1] ?? '';
      if (main === 'Enter' || main === 'NumpadEnter') return a.label || 'enter';
      if (main === 'Delete' || (main === 'Backspace' && k.length > 1)) return a.label || 'delete';
      if (k.length > 1 && ['KeyQ', 'KeyW'].includes(main) && (k.includes('Meta') || k.includes('Control'))) return a.label || 'closing';
      if (k.includes('Alt') && main === 'F4') return a.label || 'closing';
    }
  }
  return null;
}

/** "u to undo" / "ctrl + alt + z to undo" */
export function undoHint(keyLabel: string): string {
  return keyLabel ? `${keyLabel} to undo` : 'undo';
}
