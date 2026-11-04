// Helpers shared by every provider.
import type { ChatMessage, ChatRequest, ModelInfo, ProviderKind } from '../../shared/types';
import { PROVIDER_META } from '../../shared/types';

/** The newest user message (the one carrying screenshots). */
export function lastUserMessage(req: ChatRequest): ChatMessage | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) if (req.messages[i]!.role === 'user') return req.messages[i];
  return undefined;
}

/**
 * Fold the conversation into one prompt for CLIs that take a single user turn.
 * Prior turns become a short transcript; the newest user message is the question.
 */
export function foldTranscript(req: ChatRequest, opts: { includeSystem?: boolean; imageNote?: string } = {}): string {
  const msgs = req.messages;
  let lastIdx = msgs.length - 1;
  while (lastIdx >= 0 && msgs[lastIdx]!.role !== 'user') lastIdx--;
  const history = lastIdx > 0 ? msgs.slice(0, lastIdx) : [];
  const current = lastIdx >= 0 ? msgs[lastIdx]! : { role: 'user' as const, text: '' };
  const parts: string[] = [];
  if (opts.includeSystem && req.system.trim()) {
    parts.push(`<instructions>\n${req.system.trim()}\n</instructions>`);
  }
  if (history.length) {
    const lines = history.map((m) => `${m.role === 'user' ? 'user' : 'you'}: ${m.text.trim()}`);
    parts.push(`<earlier_conversation>\n${lines.join('\n\n')}\n</earlier_conversation>`);
  }
  if (opts.imageNote) parts.push(opts.imageNote);
  parts.push(history.length || opts.includeSystem ? `user: ${current.text.trim()}` : current.text.trim());
  return parts.join('\n\n');
}

/** Lines describing attached screenshots, e.g. "image 1: screen 1 (cursor is here), 1568x980 px". */
export function describeImages(req: ChatRequest): string | undefined {
  const imgs = lastUserMessage(req)?.images ?? [];
  if (!imgs.length) return undefined;
  return (
    'attached screenshots, in order:\n' +
    imgs.map((im, i) => `image ${i + 1}: ${im.label} (${im.width}x${im.height} px)`).join('\n')
  );
}

/** Ensure the static default model is present and de-duplicate by id. */
export function withDefault(kind: ProviderKind, models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  const def = PROVIDER_META[kind].defaultModel;
  for (const m of models) {
    if (!m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  if (!seen.has(def)) out.unshift({ id: def });
  return out;
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
