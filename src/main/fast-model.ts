// "Fast replies": plain voice questions go to the provider's fastest model with low effort;
// requests to do something on screen (agent mode) and harder asks keep the chosen model.
// Pure (type imports only): unit tested in test/fast-model.test.ts.
import type { ProviderKind } from '../shared/types';
import { wantsAction } from './action-tags.ts';

/** fastest model per provider ('' = keep the chosen one: we can't know what's fast there) */
export const FAST_MODEL: Record<ProviderKind, string> = {
  'claude-subscription': 'haiku',
  'anthropic-api': 'claude-haiku-5-5',
  'chatgpt-subscription': 'gpt-6-luna',
  'openai-api': 'gpt-6-luna',
  'gemini-subscription': 'gemini-3.5-flash-lite',
  'gemini-api': 'gemini-3.5-flash-lite',
  openrouter: 'anthropic/claude-haiku-5.5',
  local: '',
};

/** Requests that deserve the full model even when spoken. */
export function looksHard(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length > 220) return true;
  return /\b(step[- ]by[- ]step|one step at a time|teach me|tutor me|walk me through|next step|in detail|detailed|thorough(ly)?|explain (why|how) .{25,}|write (me )?(a |an |the )?([a-z]+ )?(script|function|program|code|essay|email|letter|report|story|poem)|debug|refactor|analy[sz]e|compare|summari[sz]e (this|the) (document|page|article|pdf)|proof|prove|calculate|solve|translate (this|the) (whole|entire)|plan (my|a|the)|think (hard|carefully))\b/.test(t);
}

export interface FastChoice {
  model: string;
  /** true when the fast model was picked instead of the chosen one */
  fast: boolean;
  reason: string;
}

/**
 * The model for a voice turn. `chosen` is the user's model for `kind`; `pinned` = the turn asked
 * for a specific provider / model (routines, a clicky's own brain set per message).
 */
export function pickVoiceModel(kind: ProviderKind, chosen: string, text: string, opts: { enabled: boolean; agent: boolean; pinned?: boolean }): FastChoice {
  const fastModel = FAST_MODEL[kind];
  if (!opts.enabled) return { model: chosen, fast: false, reason: 'fast replies off' };
  if (opts.pinned) return { model: chosen, fast: false, reason: 'model pinned' };
  if (!fastModel || fastModel === chosen) return { model: chosen, fast: false, reason: fastModel ? 'already the fast model' : 'no fast model for this provider' };
  if (opts.agent && wantsAction(text)) return { model: chosen, fast: false, reason: 'asked to do something (agent mode)' };
  if (looksHard(text)) return { model: chosen, fast: false, reason: 'harder request' };
  return { model: fastModel, fast: true, reason: 'plain voice question' };
}
