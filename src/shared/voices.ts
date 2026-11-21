// Voice lists and clicky speaking styles shared by main (the "make a clicky" prompt, the system
// prompt) and the settings window (voice pickers). Pure, no imports.

/** Kokoro-82M's best english voices (on-device, the default natural voice) */
export const KOKORO_VOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'af_heart', label: 'heart (warm, female)' },
  { id: 'af_bella', label: 'bella (bright, female)' },
  { id: 'af_nicole', label: 'nicole (soft, female)' },
  { id: 'am_michael', label: 'michael (calm, male)' },
  { id: 'am_fenrir', label: 'fenrir (deep, male)' },
  { id: 'bf_emma', label: 'emma (british, female)' },
  { id: 'bm_george', label: 'george (british, male)' },
];

export const OPENAI_VOICES: readonly string[] = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

export function isKokoroVoice(id: unknown): id is string {
  return typeof id === 'string' && KOKORO_VOICES.some((v) => v.id === id);
}

/** How a clicky talks; folded into its persona in the system prompt. */
export type ClickyStyle = 'short' | 'chatty' | 'formal' | 'playful';
export const CLICKY_STYLES: readonly ClickyStyle[] = ['short', 'chatty', 'formal', 'playful'];

export const CLICKY_STYLE_LABEL: Record<ClickyStyle, string> = {
  short: 'short',
  chatty: 'chatty',
  formal: 'formal',
  playful: 'playful',
};

/** one line for the prompt's WHO YOU ARE block */
export const CLICKY_STYLE_PROMPT: Record<ClickyStyle, string> = {
  short: 'Speaking style: short and to the point. One sentence when you can, no small talk.',
  chatty: 'Speaking style: chatty and warm. A little friendly back-and-forth is welcome, but still no more than three sentences unless asked.',
  formal: 'Speaking style: formal and precise. Polite, complete sentences, no slang or jokes.',
  playful: 'Speaking style: playful. Light humour and a bit of personality, while staying genuinely helpful.',
};

export function isClickyStyle(v: unknown): v is ClickyStyle {
  return typeof v === 'string' && (CLICKY_STYLES as readonly string[]).includes(v);
}

/** cursor size range for a clicky's companion (same as settings.companion.scale) */
export const CLICKY_SCALE_MIN = 0.5;
export const CLICKY_SCALE_MAX = 2.5;
