// Settings › voice › wake word and settings › companion › tips. Kept out of settings.ts like
// clickys.ts / extras.ts: settings.ts hands in its settings / save / sync hooks.
import type { DeepPartial, KeyName, Settings, WakeSensitivity, WakeStatus } from '../../shared/types';
import type { SettingsApi } from '../../shared/ipc';
import { canonicalCode, chordLabel, isFunctionKey, isModifier, orderChord } from './keys';

export interface WakeTipsCtx {
  api: SettingsApi;
  get(): Settings;
  save(patch: DeepPartial<Settings>): Promise<void>;
  onSync(f: () => void): void;
  platform(): string;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

function switchRow(ctx: WakeTipsCtx, id: string, get: (s: Settings) => boolean, patch: (v: boolean) => DeepPartial<Settings>): void {
  const btn = $(id);
  if (!btn) return;
  ctx.onSync(() => btn.setAttribute('aria-checked', String(get(ctx.get()))));
  btn.addEventListener('click', () => {
    const v = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', String(v));
    void ctx.save(patch(v));
  });
}

const SENS_HINT: Record<WakeSensitivity, string> = {
  low: 'wakes only on a clear “hey clickity”. fewest false starts, and the fewest checks.',
  medium: 'a good balance for most rooms.',
  high: 'hears quieter or sloppier speech (“hey clicky”), and may wake by mistake now and then. checks more often.',
};

function wakeLine(st: WakeStatus, s: Settings): string {
  switch (st.state) {
    case 'off':
      return 'off';
    case 'hands-free':
      return 'hands-free is on, so everything you say is heard already — no wake word needed';
    case 'starting':
      return 'starting the microphone…';
    case 'loading':
      return st.detail || 'loading the on-device voice model…';
    case 'no-mic':
      return st.detail || 'microphone blocked — allow it in your system settings';
    case 'error':
      return st.detail ? `not listening: ${st.detail}` : 'not listening — something went wrong (see about › open logs)';
    case 'paused':
    case 'armed': {
      const base = st.state === 'paused' ? 'paused while clickity is busy' : `listening for “hey clickity”${s.clickys.length > 1 ? ' or a clicky’s name' : ''}`;
      if (!st.checks && !st.skipped) return base;
      const avg = st.avgMs ? ` · about ${st.avgMs} ms each` : '';
      return `${base} · ${st.checks ?? 0} check${st.checks === 1 ? '' : 's'} in the last 10 min${avg}${st.skipped ? ` · ${st.skipped} skipped by the rate cap` : ''}`;
    }
  }
}

function initWake(ctx: WakeTipsCtx): void {
  switchRow(ctx, 'sw-wake', (s) => !!s.wakeWord?.enabled, (v) => ({ wakeWord: { enabled: v } }));
  const seg = [...document.querySelectorAll<HTMLButtonElement>('#wake-seg button')];
  for (const b of seg) b.addEventListener('click', () => void ctx.save({ wakeWord: { sensitivity: b.dataset.sens as WakeSensitivity } }));
  const stateEl = $('wake-state');
  let status: WakeStatus = { state: 'off' };
  const render = () => {
    const s = ctx.get();
    const sens = s.wakeWord?.sensitivity ?? 'medium';
    for (const b of seg) b.setAttribute('aria-checked', String(b.dataset.sens === sens));
    $('wake-sens-hint').textContent = SENS_HINT[sens];
    $('wake-sens-row').hidden = !s.wakeWord?.enabled;
    stateEl.textContent = s.wakeWord?.enabled ? wakeLine(status, s) : '';
    stateEl.hidden = !s.wakeWord?.enabled;
    stateEl.classList.toggle('err', status.state === 'no-mic' || status.state === 'error');
  };
  const refresh = async () => {
    try {
      status = await ctx.api.wakeStatus();
    } catch {
      /* older main */
    }
    render();
  };
  ctx.api.onWakeStatus((st) => {
    status = st;
    render();
  });
  ctx.onSync(() => {
    render();
    void refresh();
  });
  void refresh();
}

/* ───────── tips ───────── */

function initTipsSettings(ctx: WakeTipsCtx): void {
  switchRow(ctx, 'sw-tips', (s) => !!s.tips?.enabled, (v) => ({ tips: { enabled: v } }));
  switchRow(ctx, 'sw-tips-shot', (s) => !!s.tips?.screenshot, (v) => ({ tips: { screenshot: v } }));
  const rate = [...document.querySelectorAll<HTMLButtonElement>('#tips-rate-seg button')];
  for (const b of rate) b.addEventListener('click', () => void ctx.save({ tips: { perHour: Number(b.dataset.rate) } }));
  const well = $('chord-tip');
  const rec = $<HTMLButtonElement>('rec-tip');
  const hint = $('tip-key-hint');
  const stateEl = $('tips-state');
  let recording = false;
  const defaultHint = () =>
    `only taken while a tip is waiting.${ctx.platform() === 'darwin' ? ' on a mac, window titles aren’t readable without an extra permission, so with “look at the screen” off it only knows the app’s name.' : ''}`;

  const render = () => {
    const s = ctx.get();
    const on = !!s.tips?.enabled;
    for (const row of document.querySelectorAll<HTMLElement>('[data-tips]')) row.hidden = !on;
    for (const b of rate) b.setAttribute('aria-checked', String(Number(b.dataset.rate) === (s.tips?.perHour ?? 3)));
    if (!recording) well.textContent = chordLabel(s.tips?.key ?? [], ctx.platform());
    if (!recording) hint.textContent = defaultHint();
    stateEl.hidden = !on;
  };
  const refresh = async () => {
    if (!ctx.get().tips?.enabled) return;
    try {
      stateEl.textContent = await ctx.api.tipsStatus();
    } catch {
      stateEl.textContent = '';
    }
  };
  ctx.onSync(() => {
    render();
    void refresh();
  });
  window.setInterval(() => void refresh(), 30_000);

  // a tiny recorder: modifiers + one key, from DOM key events (global keys are paused meanwhile)
  let held = new Set<KeyName>();
  let best: KeyName[] = [];
  const stopRec = (save: boolean) => {
    recording = false;
    window.removeEventListener('keydown', down, true);
    window.removeEventListener('keyup', up, true);
    void ctx.api.suspendHotkeys(false);
    rec.querySelector('span')!.textContent = 'record';
    const keys = orderChord(best);
    const main = keys.filter((k) => !isModifier(k));
    const strong = keys.some((k) => k === 'Control' || k === 'Alt' || k === 'Meta');
    if (save && main.length === 1 && (strong || isFunctionKey(main[0]!)) && !keys.includes('Fn')) {
      void ctx.save({ tips: { key: keys } });
      hint.textContent = 'saved';
      window.setTimeout(render, 1600);
    } else if (save) {
      hint.textContent = ctx.platform() === 'darwin' ? 'pick one key with control, option or cmd (or an f-key)' : 'pick one key with ctrl, alt or win (or an f-key)';
      window.setTimeout(render, 2400);
    }
    render();
  };
  const down = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const k = canonicalCode(e.code);
    if (k === 'Escape' && held.size === 0) return stopRec(false);
    held.add(k);
    if (held.size >= best.length) best = [...held];
    well.textContent = chordLabel(orderChord(held), ctx.platform());
  };
  const up = (e: KeyboardEvent) => {
    e.preventDefault();
    held.delete(canonicalCode(e.code));
    if (held.size === 0 && best.some((k) => !isModifier(k))) stopRec(true);
  };
  rec.addEventListener('click', () => {
    if (recording) return stopRec(false);
    recording = true;
    held = new Set();
    best = [];
    well.textContent = 'press the keys…';
    rec.querySelector('span')!.textContent = 'cancel';
    void ctx.api.suspendHotkeys(true);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
  });
}

export function initWakeTips(ctx: WakeTipsCtx): void {
  initWake(ctx);
  initTipsSettings(ctx);
}
