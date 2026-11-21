// Settings window: privacy (never-capture list, blur, private mode), usage & cost (the meter,
// a monthly soft limit), agent mode's undo key. Talks to main through window.clicky.
import { DEFAULT_NEVER_CAPTURE, type DeepPartial, type Settings } from '../../shared/types';
import type { UsageSummary } from '../../shared/ipc';
import { formatCost, formatTokens } from '../../shared/usage-math';

type H = <K extends keyof HTMLElementTagNameMap>(tag: K, props?: Record<string, string | boolean | number>, ...kids: Array<Node | string | null | undefined | false>) => HTMLElementTagNameMap[K];

export interface SafetyCtx {
  get(): Settings;
  save(patch: DeepPartial<Settings>): Promise<void>;
  sync(f: () => void): void;
  flash(btn: HTMLElement, text: string): void;
  h: H;
  platform(): string;
}

const api = window.clicky;
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export function initSafety(ctx: SafetyCtx): void {
  initPrivacy(ctx);
  initUsage(ctx);
  initUndoKey(ctx);
}

/* ───────── privacy ───────── */

const BLUR_HINT: Record<string, string> = {
  off: 'screenshots are sent as they are (sharp enough to read).',
  cursor: 'everything is heavily blurred except a box around your cursor. it can still point there; it can’t read the rest.',
  all: 'every screen is heavily blurred: layout and colours only. pointing and clicking get much less precise.',
};

function parseList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function initPrivacy(ctx: SafetyCtx): void {
  const btn = $<HTMLButtonElement>('private-btn');
  const hint = $('private-hint');
  const baseHint = hint.textContent ?? '';
  let tick = 0;
  const syncPrivate = (): void => {
    window.clearTimeout(tick);
    const left = (ctx.get().privacy?.privateUntil ?? 0) - Date.now();
    const on = left > 0;
    btn.querySelector('span')!.textContent = on ? 'look again now' : 'private for 10 min';
    btn.setAttribute('aria-pressed', String(on));
    hint.textContent = on ? `private: no screenshots for ${Math.max(1, Math.ceil(left / 60_000))} more min.` : baseHint;
    if (on) tick = window.setTimeout(syncPrivate, Math.min(left, 30_000) + 50);
  };
  ctx.sync(syncPrivate);
  btn.addEventListener('click', async () => {
    const on = (ctx.get().privacy?.privateUntil ?? 0) > Date.now();
    await api.setPrivate(on ? 0 : 10);
  });

  const list = $<HTMLTextAreaElement>('never-list');
  const status = $('never-status');
  let saveT = 0;
  const commit = (): void => {
    window.clearTimeout(saveT);
    void ctx.save({ privacy: { neverCapture: parseList(list.value) } });
  };
  ctx.sync(() => {
    if (document.activeElement !== list) list.value = (ctx.get().privacy?.neverCapture ?? []).join('\n');
  });
  list.addEventListener('input', () => {
    window.clearTimeout(saveT);
    saveT = window.setTimeout(commit, 700);
  });
  list.addEventListener('blur', commit);
  $('never-reset').addEventListener('click', () => {
    list.value = DEFAULT_NEVER_CAPTURE.join('\n');
    commit();
    ctx.flash($('never-reset'), 'restored');
  });
  $('never-check').addEventListener('click', async () => {
    const b = $('never-check');
    ctx.flash(b, 'checking…');
    commit();
    try {
      const r = await api.privacyCheck();
      const front = r.front ? `in front: ${r.front.toLowerCase()}` : "can't tell which app is in front";
      const wins = r.windows >= 0 ? ` · ${r.windows} window${r.windows === 1 ? '' : 's'} checked` : '';
      status.textContent = `${r.blocked ? r.blocked : 'it would look now'} · ${front}${wins}. ${r.detail}`;
    } catch {
      status.textContent = "couldn't check right now.";
    }
  });

  const seg = $('blur-seg');
  const blurHint = $('blur-hint');
  ctx.sync(() => {
    const v = ctx.get().privacy?.blur ?? 'off';
    for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-checked', String(b.dataset.blur === v));
    blurHint.textContent = BLUR_HINT[v] ?? '';
  });
  for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) {
    b.addEventListener('click', () => void ctx.save({ privacy: { blur: b.dataset.blur as 'off' | 'cursor' | 'all' } }));
  }
}

/* ───────── usage & cost ───────── */

const PROVIDER_NAMES: Record<string, string> = {
  'anthropic-api': 'anthropic api',
  'openai-api': 'openai api',
  'gemini-api': 'gemini api',
  openrouter: 'openrouter',
  local: 'local',
  'claude-subscription': 'claude',
  'chatgpt-subscription': 'chatgpt',
  'gemini-subscription': 'gemini',
  speech: 'voice',
};

function costText(cost: number, unpriced: number): string {
  if (unpriced && !cost) return 'price unknown';
  return `~${formatCost(cost)}${unpriced ? ' + unpriced' : ''}`;
}

function renderUsage(ctx: SafetyCtx, u: UsageSummary): void {
  const { h } = ctx;
  $('u-today').textContent = `~${formatCost(u.today.cost)}`;
  $('u-today-d').textContent = u.today.calls ? `${u.today.calls} repl${u.today.calls === 1 ? 'y' : 'ies'} · ${formatTokens(u.today.input)} in · ${formatTokens(u.today.output)} out` : 'nothing yet today';
  $('u-month').textContent = `~${formatCost(u.month.cost)}`;
  const limit = u.monthlyLimit > 0 ? ` · ${Math.round((u.month.cost / u.monthlyLimit) * 100)}% of your ${formatCost(u.monthlyLimit)} limit` : '';
  $('u-month-d').textContent = `${u.month.calls} call${u.month.calls === 1 ? '' : 's'} · ${formatTokens(u.month.input)} in · ${formatTokens(u.month.output)} out${limit}${u.overLimit ? ' — past it' : ''}`;
  // 30 thin bars: one series, ink only; the day and cost on hover
  const max = Math.max(...u.days.map((d) => d.cost), 0);
  const spark = $('u-spark');
  spark.replaceChildren(
    ...u.days.map((d) => {
      const bar = h('i', { title: `${d.day} · ~${formatCost(d.cost)}` });
      bar.style.height = max > 0 && d.cost > 0 ? `${Math.max(8, (d.cost / max) * 100)}%` : '0';
      return bar;
    }),
  );
  spark.hidden = max <= 0;
  const rows = u.byModel.map((r) => {
    const who = `${PROVIDER_NAMES[r.provider] ?? r.provider} · ${r.model.toLowerCase()}`;
    const what =
      r.billing === 'subscription'
        ? 'included in your subscription'
        : r.billing === 'local'
          ? 'free (local)'
          : costText(r.cost, r.unpriced);
    const amount = r.provider === 'speech' ? (r.chars ? `${formatTokens(r.chars)} characters` : r.seconds ? `${Math.round(r.seconds / 60)} min ${Math.round(r.seconds % 60)} s` : '') : `${formatTokens(r.input)} in · ${formatTokens(r.output)} out`;
    return h('div', { class: 'u-model' }, h('span', { class: 'u-who', text: who }), h('span', { class: 'u-what tnum', text: [what, `${r.calls}×`, amount].filter(Boolean).join(' · ') }));
  });
  $('u-models').replaceChildren(...(rows.length ? rows : [h('p', { class: 'hint', text: 'nothing used this month yet.' })]));
  $('u-note').textContent = `${u.priceNote}. subscriptions (claude, chatgpt, gemini cli) are included in your plan; local models are free.`;
}

function initUsage(ctx: SafetyCtx): void {
  const refresh = async (): Promise<void> => {
    try {
      renderUsage(ctx, await api.usage());
    } catch {
      /* main not ready */
    }
  };
  const section = $('usage');
  // refresh whenever the page is shown or the window comes back
  new MutationObserver(() => {
    if (!section.hidden) void refresh();
  }).observe(section, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('focus', () => {
    if (!section.hidden) void refresh();
  });
  void refresh();

  const limit = $<HTMLInputElement>('u-limit');
  ctx.sync(() => {
    if (document.activeElement !== limit) {
      const v = ctx.get().usage?.monthlyLimit ?? 0;
      limit.value = v > 0 ? String(v) : '';
    }
  });
  const commit = (): void => {
    const v = Number(limit.value);
    void ctx.save({ usage: { monthlyLimit: Number.isFinite(v) && v > 0 ? v : 0 } }).then(refresh);
  };
  limit.addEventListener('change', commit);
  limit.addEventListener('blur', commit);
  const reset = $('u-reset');
  reset.addEventListener('click', async () => {
    if (reset.dataset.armed !== '1') {
      reset.dataset.armed = '1';
      ctx.flash(reset, 'press again to reset');
      window.setTimeout(() => (reset.dataset.armed = ''), 1600);
      return;
    }
    reset.dataset.armed = '';
    renderUsage(ctx, await api.usageReset());
    ctx.flash(reset, 'reset');
  });
}

/* ───────── agent mode: undo key ───────── */

function initUndoKey(ctx: SafetyCtx): void {
  const seg = $('undo-seg');
  const mac = (): boolean => ctx.platform() === 'darwin';
  const chord = (): string[] => (mac() ? ['Meta', 'Alt', 'KeyZ'] : ['Control', 'Alt', 'KeyZ']);
  ctx.sync(() => {
    $('undo-chord').textContent = mac() ? 'cmd + option + z' : 'ctrl + alt + z';
    const k = ctx.get().hotkeys.undo ?? ['KeyU'];
    const v = !k.length ? 'off' : k.length === 1 && k[0] === 'KeyU' ? 'u' : 'chord';
    for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-checked', String(b.dataset.undo === v));
  });
  for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) {
    b.addEventListener('click', () => {
      const v = b.dataset.undo;
      void ctx.save({ hotkeys: { undo: v === 'off' ? [] : v === 'u' ? ['KeyU'] : chord() } });
    });
  }
}
