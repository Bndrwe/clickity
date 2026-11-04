// Settings + onboarding window. Talks to main only through window.clicky.
import {
  DEFAULT_SETTINGS,
  PROVIDER_KINDS,
  PROVIDER_META,
  type DeepPartial,
  type KeyName,
  type ModelInfo,
  type PermissionKind,
  type PermissionsStatus,
  type ProviderKind,
  type Settings,
  type SttProvider,
  type Theme,
  type TtsProvider,
} from '../../shared/types';
import { canonicalCode, chordLabel, orderChord, validateChord } from './keys';

const api = window.clicky;
let settings: Settings = structuredClone(DEFAULT_SETTINGS);
let platform: string = 'darwin';
let packaged = true;
const syncers: Array<() => void> = [];
const pending = new Set<() => void>();
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ───────────── helpers ───────────── */

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | boolean | number> = {},
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false) continue;
    if (k === 'class') n.className = String(v);
    else if (k === 'text') n.textContent = String(v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c) n.append(c);
  return n;
}

const ICON = {
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  monitor: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5"/></svg>',
};

/** swap a button's label for 1.6s */
function flash(btn: HTMLElement, text: string): void {
  const span = btn.querySelector('span') ?? btn;
  const prev = (btn as any)._label ?? span.textContent ?? '';
  (btn as any)._label = prev;
  span.textContent = text;
  clearTimeout((btn as any)._t);
  (btn as any)._t = setTimeout(() => {
    span.textContent = prev;
    (btn as any)._label = undefined;
  }, 1600);
}

let saveChain: Promise<unknown> = Promise.resolve();
function save(patch: DeepPartial<Settings>): Promise<void> {
  saveChain = saveChain
    .then(() => api.setSettings(patch))
    .then((s) => {
      settings = s as Settings;
      syncAll();
    })
    .catch(() => {});
  return saveChain as Promise<void>;
}
function flushPending(): Promise<void> {
  for (const f of [...pending]) f();
  return saveChain as Promise<void>;
}
function syncAll(): void {
  for (const f of syncers) f();
}
const isFocused = (el: Element): boolean => document.activeElement === el;

/** text/number/textarea input -> debounced save */
function bindText(
  el: HTMLInputElement | HTMLTextAreaElement,
  get: () => string,
  toPatch: (v: string) => DeepPartial<Settings> | null,
  opts: { secret?: boolean; secretPresent?: () => boolean; removeBtn?: HTMLElement; removePatch?: () => DeepPartial<Settings> } = {},
): void {
  let last = '';
  let t: number | undefined;
  const sync = () => {
    if (opts.secret) {
      const has = opts.secretPresent?.() ?? false;
      el.placeholder = has ? '••••••••' : el.dataset.ph ?? '';
      if (opts.removeBtn) opts.removeBtn.hidden = !has;
      return;
    }
    if (!isFocused(el)) {
      el.value = get();
      last = el.value;
    }
  };
  if (opts.secret) el.dataset.ph = el.placeholder;
  const commit = () => {
    window.clearTimeout(t);
    t = undefined;
    pending.delete(commit);
    if (opts.secret) {
      if (!el.value) return;
      const v = el.value;
      el.value = '';
      const p = toPatch(v);
      if (p) void save(p);
      return;
    }
    if (el.value === last) return;
    last = el.value;
    const p = toPatch(el.value);
    if (p) void save(p);
  };
  el.addEventListener('input', () => {
    pending.add(commit);
    window.clearTimeout(t);
    t = window.setTimeout(commit, 500);
  });
  el.addEventListener('change', commit);
  el.addEventListener('blur', commit);
  if (opts.removeBtn && opts.removePatch) {
    const rp = opts.removePatch;
    opts.removeBtn.addEventListener('click', () => {
      el.value = '';
      void save(rp());
    });
  }
  syncers.push(sync);
  sync();
}

function bindSwitch(btn: HTMLElement, get: () => boolean, toPatch: (v: boolean) => DeepPartial<Settings>): void {
  syncers.push(() => btn.setAttribute('aria-checked', String(get())));
  btn.addEventListener('click', () => {
    const v = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', String(v));
    void save(toPatch(v));
  });
}

function bindSelect(el: HTMLSelectElement, get: () => string, toPatch: (v: string) => DeepPartial<Settings>): void {
  syncers.push(() => {
    if (!isFocused(el)) el.value = get();
  });
  el.addEventListener('change', () => void save(toPatch(el.value)));
}

function bindRange(
  el: HTMLInputElement,
  out: HTMLElement,
  get: () => number,
  fmt: (n: number) => string,
  toPatch: (n: number) => DeepPartial<Settings>,
): void {
  let t: number | undefined;
  const show = () => (out.textContent = fmt(Number(el.value)));
  syncers.push(() => {
    if (!isFocused(el)) el.value = String(get());
    show();
  });
  el.addEventListener('input', () => {
    show();
    window.clearTimeout(t);
    t = window.setTimeout(() => void save(toPatch(Number(el.value))), 300);
  });
}

function revealButtons(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>('[data-reveal]').forEach((b) => {
    b.addEventListener('click', () => {
      const input = $<HTMLInputElement>(b.dataset.reveal!);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.textContent = show ? 'hide' : 'show';
    });
  });
}

/* ───────────── theme ───────────── */

const mq = matchMedia('(prefers-color-scheme: dark)');
function applyTheme(theme: Theme): void {
  try {
    localStorage.setItem('theme', theme);
  } catch {}
  const dark = theme === 'dark' || (theme === 'system' && mq.matches);
  document.documentElement.classList.toggle('dark', dark);
  const btn = $('theme-toggle');
  btn.innerHTML = theme === 'system' ? ICON.monitor : dark ? ICON.moon : ICON.sun;
  btn.setAttribute('aria-label', `theme: ${theme}`);
  btn.title = `theme: ${theme}`;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#theme-seg button')) {
    b.setAttribute('aria-checked', String(b.dataset.theme === theme));
  }
}
mq.addEventListener('change', () => {
  if (settings.theme === 'system') applyTheme('system');
});
function initTheme(): void {
  syncers.push(() => applyTheme(settings.theme));
  $('theme-toggle').addEventListener('click', () => {
    const order: Theme[] = ['system', 'light', 'dark'];
    setTheme(order[(order.indexOf(settings.theme) + 1) % 3]);
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>('#theme-seg button')) {
    b.addEventListener('click', () => setTheme(b.dataset.theme as Theme));
  }
}
function setTheme(next: Theme): void {
  settings = { ...settings, theme: next };
  applyTheme(next);
  void save({ theme: next });
}

/* ───────────── top bar, scroll, hero ───────────── */

function initChrome(): void {
  const bar = $('topbar');
  const onScroll = () => bar.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  document.querySelectorAll<HTMLAnchorElement>('[data-scroll]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      scrollToId(a.dataset.scroll!);
    }),
  );
  document.querySelectorAll<HTMLAnchorElement>('[data-ext]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      void api.openExternal(a.href);
    }),
  );
  const reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduceMotion) {
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('is-in');
            io.unobserve(e.target);
          }
        }),
      { rootMargin: '0px 0px -8% 0px', threshold: 0.05 },
    );
    reveals.forEach((r) => io.observe(r));
  } else reveals.forEach((r) => r.classList.add('is-in'));
}

function scrollToId(id: string): void {
  if (id === 'top') window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  else document.getElementById(id)?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
}

function initFloat(): void {
  if (reduceMotion) return;
  const obj = $('float-obj');
  let px = 0, py = 0;
  let tilt = 0, tx = 0;
  window.addEventListener('pointermove', (e) => {
    const r = obj.getBoundingClientRect();
    px = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / 360));
    py = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / 360));
  });
  const tick = (now: number) => {
    tilt += (px * 3.5 - tilt) * 0.08;
    tx += (px * 6 - tx) * 0.08;
    const bob = Math.sin(now / 1100) * 4 + py * 3;
    obj.style.setProperty('--tilt', tilt.toFixed(2));
    obj.style.setProperty('--tx', tx.toFixed(2));
    obj.style.setProperty('--bob', bob.toFixed(2));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ───────────── model section ───────────── */

const GROUPS: Array<{ title: string; group: 'subscription' | 'api' | 'local' }> = [
  { title: 'subscriptions', group: 'subscription' },
  { title: 'api keys', group: 'api' },
  { title: 'local', group: 'local' },
];
const rowApi = new Map<ProviderKind, { open(): void; el: HTMLElement; expanded(): boolean }>();

function buildProviderRow(kind: ProviderKind, index: number): HTMLElement {
  const meta = PROVIDER_META[kind];
  const cfg = () => settings.providers[kind] ?? {};
  const bodyId = `pbody-${kind}`;

  const title = h('span', { class: 'prow-title', text: 'checking…' });
  const detail = h('span', { class: 'prow-detail', text: meta.description });
  const toggle = h(
    'button',
    { class: 'toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': bodyId },
    h('span', { class: 'row-label', text: meta.label }),
    h('span', { class: 'prow-val' }, title, detail),
    h('span', { class: 'plus', 'aria-hidden': 'true' }),
  );
  const use = h(
    'button',
    { class: 'use', type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': `use ${meta.label}` },
    h('i'),
    h('span', { text: 'use' }),
  );
  use.addEventListener('click', () => {
    settings = { ...settings, provider: kind };
    syncAll();
    void save({ provider: kind });
  });
  syncers.push(() => use.setAttribute('aria-checked', String(settings.provider === kind)));

  /* body */
  const pad = h('div', { class: 'pbody-pad' });
  pad.append(h('p', { class: 'hint', text: meta.description }));

  if (meta.setupCommand) {
    const copy = h('button', { class: 'btn', type: 'button', 'aria-live': 'polite' }, h('span', { text: 'copy' }));
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(meta.setupCommand!);
        flash(copy, 'copied');
      } catch {
        flash(copy, 'copy failed');
      }
    });
    pad.append(
      h('div', { class: 'field' }, h('span', { class: 'eyebrow', text: 'set up once' }), h('div', { class: 'code' }, h('code', { text: meta.setupCommand }), copy)),
    );
  }

  const idp = (s: string) => `${s}-${kind}`;
  if (meta.fields.includes('apiKey')) {
    const input = h('input', { id: idp('key'), type: 'password', spellcheck: 'false', autocomplete: 'off', placeholder: kind === 'local' ? 'optional' : 'paste your key' });
    const reveal = h('button', { class: 'text-btn', type: 'button', text: 'show' });
    reveal.addEventListener('click', () => {
      const s = input.type === 'password';
      input.type = s ? 'text' : 'password';
      reveal.textContent = s ? 'hide' : 'show';
    });
    const remove = h('button', { class: 'text-btn', type: 'button', text: 'remove', hidden: true });
    pad.append(
      h('div', { class: 'field' }, h('label', { class: 'eyebrow', for: input.id, text: 'api key' }), h('div', { class: 'input-wrap' }, input, reveal), remove),
    );
    bindText(input, () => '', (v) => ({ providers: { [kind]: { apiKey: v } } } as DeepPartial<Settings>), {
      secret: true,
      secretPresent: () => !!cfg().apiKey,
      removeBtn: remove,
      removePatch: () => ({ providers: { [kind]: { apiKey: '' } } } as DeepPartial<Settings>),
    });
    input.addEventListener('change', () => setTimeout(() => void refreshStatus(), 400));
  }
  if (meta.fields.includes('baseUrl')) {
    const input = h('input', { id: idp('url'), type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'http://localhost:11434/v1' });
    pad.append(h('div', { class: 'field' }, h('label', { class: 'eyebrow', for: input.id, text: 'base url' }), input));
    bindText(input, () => cfg().baseUrl ?? '', (v) => ({ providers: { [kind]: { baseUrl: v } } } as DeepPartial<Settings>));
    input.addEventListener('change', () => setTimeout(() => void refreshStatus(), 400));
  }
  if (meta.fields.includes('cliPath')) {
    const input = h('input', { id: idp('cli'), type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'auto-detect' });
    pad.append(h('div', { class: 'field' }, h('label', { class: 'eyebrow', for: input.id, text: 'cli path' }), input));
    bindText(input, () => cfg().cliPath ?? '', (v) => ({ providers: { [kind]: { cliPath: v } } } as DeepPartial<Settings>));
    input.addEventListener('change', () => setTimeout(() => void refreshStatus(), 400));
  }

  /* model picker */
  const select = h('select', { id: idp('model') });
  const refresh = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'refresh models', title: 'refresh models' });
  refresh.innerHTML = ICON.refresh;
  const custom = h('input', { id: idp('custom'), type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: meta.defaultModel });
  const loadingNote = h('span', { class: 'loading', text: 'loading models…', hidden: true, 'aria-live': 'polite' });
  pad.append(
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'eyebrow', for: select.id, text: 'model' }),
      h('div', { class: 'field-inline' }, select, refresh),
      loadingNote,
    ),
    h('div', { class: 'field' }, h('label', { class: 'eyebrow', for: custom.id, text: 'custom model id' }), custom),
  );

  let models: ModelInfo[] | null = null;
  let loading = false;
  const current = () => settings.models[kind] || meta.defaultModel;
  const fillSelect = () => {
    const cur = current();
    select.replaceChildren();
    const list = models ?? [];
    const inList = list.some((m) => m.id === cur);
    if (!inList) select.append(h('option', { value: '', text: models ? 'custom' : cur }));
    for (const m of list) select.append(h('option', { value: m.id, text: m.label && m.label !== m.id ? `${m.label}` : m.id }));
    select.value = inList ? cur : '';
    if (!isFocused(custom)) custom.value = inList || !models ? '' : cur;
  };
  const loadModels = async () => {
    if (loading) return;
    loading = true;
    loadingNote.hidden = false;
    refresh.classList.add('spin');
    try {
      models = await api.providerModels(kind);
    } catch {
      models = [];
    }
    loading = false;
    loadingNote.hidden = true;
    refresh.classList.remove('spin');
    fillSelect();
  };
  refresh.addEventListener('click', () => void loadModels());
  select.addEventListener('change', () => {
    if (!select.value) return;
    custom.value = '';
    settings = { ...settings, models: { ...settings.models, [kind]: select.value } };
    void save({ models: { [kind]: select.value } } as DeepPartial<Settings>);
  });
  custom.addEventListener('change', () => {
    const v = custom.value.trim();
    if (!v) {
      fillSelect();
      return;
    }
    settings = { ...settings, models: { ...settings.models, [kind]: v } };
    void save({ models: { [kind]: v } } as DeepPartial<Settings>);
  });
  syncers.push(fillSelect);
  fillSelect();

  /* actions */
  const result = h('span', { class: 'result', 'aria-live': 'polite' });
  const test = h('button', { class: 'btn', type: 'button' }, h('span', { text: 'test' }));
  test.addEventListener('click', async () => {
    result.className = 'result';
    result.textContent = 'testing…';
    await flushPending();
    try {
      const r = await api.providerTest(kind);
      result.className = r.ok ? 'result' : 'result err';
      result.textContent = r.ok ? `ok · ${r.latencyMs ?? '—'} ms` : r.message;
    } catch (e) {
      result.className = 'result err';
      result.textContent = e instanceof Error ? e.message : 'test failed';
    }
  });
  const actions = h('div', { class: 'actions' });
  if (meta.group === 'subscription') {
    const login = h('button', { class: 'btn', type: 'button' }, h('span', { text: 'sign in' }));
    login.addEventListener('click', async () => {
      try {
        await api.providerLogin(kind);
        flash(login, 'opened terminal');
      } catch {
        flash(login, 'could not open');
      }
    });
    actions.append(login);
  }
  actions.append(test);
  if (meta.docsUrl) {
    const docs = h('a', { class: 'text-link', href: meta.docsUrl, text: 'docs ↗' });
    docs.addEventListener('click', (e) => {
      e.preventDefault();
      void api.openExternal(meta.docsUrl!);
    });
    actions.append(docs);
  }
  actions.append(result);
  pad.append(actions);

  const body = h('div', { class: 'pbody', id: bodyId, role: 'region', 'aria-label': `${meta.label} settings` }, h('div', { class: 'pbody-in' }, pad));
  body.inert = true;

  let isOpen = false;
  const setOpen = (v: boolean) => {
    isOpen = v;
    toggle.setAttribute('aria-expanded', String(v));
    body.classList.toggle('open', v);
    body.inert = !v;
    if (v && !models) void loadModels();
  };
  toggle.addEventListener('click', () => setOpen(!isOpen));

  const refreshStatus = async () => {
    try {
      const s = await api.providerStatus(kind);
      title.textContent = s.ok ? 'ready' : 'not ready';
      detail.textContent = s.detail;
    } catch {
      title.textContent = 'unknown';
      detail.textContent = 'could not check';
    }
  };
  setTimeout(() => void refreshStatus(), 120 * index + 60);

  const row = h('div', { class: 'prow' }, h('div', { class: 'prow-head' }, toggle, use), body);
  rowApi.set(kind, { open: () => setOpen(true), el: row, expanded: () => isOpen });
  return row;
}

function initModel(): void {
  const list = $('model-list');
  let i = 0;
  for (const g of GROUPS) {
    const wrap = h('div', { class: 'group' }, h('p', { class: 'eyebrow', text: g.title }));
    const radios = h('div', { role: 'radiogroup', 'aria-label': `${g.title}: use` });
    for (const kind of PROVIDER_KINDS.filter((k) => PROVIDER_META[k].group === g.group)) radios.append(buildProviderRow(kind, i++));
    wrap.append(radios);
    list.append(wrap);
  }
}

/* ───────────── voice ───────────── */

const STT_DEFAULT_MODEL: Record<SttProvider, string> = {
  'on-device': 'Xenova/whisper-base.en',
  openai: 'gpt-transcribe',
  groq: 'whisper-large-v3-turbo',
  gemini: 'gemini-3.8-flash',
  local: 'whisper-1',
};
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

function initVoice(): void {
  const stt = () => settings.speech.stt;
  const tts = () => settings.speech.tts;
  const sttProvider = $<HTMLSelectElement>('stt-provider');
  const ttsProvider = $<HTMLSelectElement>('tts-provider');

  bindSelect(sttProvider, () => stt().provider, (v) => ({
    speech: { stt: { provider: v as SttProvider, model: STT_DEFAULT_MODEL[v as SttProvider] } },
  }));
  bindText($<HTMLInputElement>('stt-model'), () => stt().model, (v) => ({ speech: { stt: { model: v } } }));
  bindText($<HTMLInputElement>('stt-url'), () => stt().baseUrl ?? '', (v) => ({ speech: { stt: { baseUrl: v } } }));
  bindText($<HTMLInputElement>('stt-lang'), () => stt().language ?? '', (v) => ({ speech: { stt: { language: v.trim() } } }));
  bindText($<HTMLInputElement>('stt-key'), () => '', (v) => ({ speech: { stt: { apiKey: v } } }), {
    secret: true,
    secretPresent: () => !!stt().apiKey,
    removeBtn: $('stt-key-remove'),
    removePatch: () => ({ speech: { stt: { apiKey: '' } } }),
  });
  bindText($<HTMLInputElement>('tts-key'), () => '', (v) => ({ speech: { tts: { apiKey: v } } }), {
    secret: true,
    secretPresent: () => !!tts().apiKey,
    removeBtn: $('tts-key-remove'),
    removePatch: () => ({ speech: { tts: { apiKey: '' } } }),
  });
  revealButtons(document);

  bindSelect(ttsProvider, () => tts().provider, (v) => ({
    speech: { tts: { provider: v as TtsProvider, voice: v === 'openai' ? 'alloy' : '' } },
  }));

  const voiceSelect = $<HTMLSelectElement>('tts-voice-select');
  const voiceInput = $<HTMLInputElement>('tts-voice-input');
  const fillVoices = () => {
    const p = tts().provider;
    if (p !== 'system' && p !== 'openai') return;
    const cur = tts().voice;
    voiceSelect.replaceChildren();
    if (p === 'system') {
      voiceSelect.append(h('option', { value: '', text: 'default voice' }));
      const vs = ('speechSynthesis' in window ? speechSynthesis.getVoices() : []).slice().sort((a, b) => a.name.localeCompare(b.name));
      for (const v of vs) voiceSelect.append(h('option', { value: v.name, text: `${v.name.toLowerCase()} · ${v.lang}` }));
      if (cur && !vs.some((v) => v.name === cur)) voiceSelect.append(h('option', { value: cur, text: cur.toLowerCase() }));
    } else {
      for (const v of OPENAI_VOICES) voiceSelect.append(h('option', { value: v, text: v }));
      if (cur && !OPENAI_VOICES.includes(cur)) voiceSelect.append(h('option', { value: cur, text: cur }));
    }
    if (!isFocused(voiceSelect)) voiceSelect.value = cur || (p === 'openai' ? 'alloy' : '');
  };
  voiceSelect.addEventListener('change', () => void save({ speech: { tts: { voice: voiceSelect.value } } }));
  if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', fillVoices);
  bindText(voiceInput, () => tts().voice, (v) => ({ speech: { tts: { voice: v.trim() } } }));

  bindRange($<HTMLInputElement>('tts-rate'), $('tts-rate-out'), () => tts().rate, (n) => `${n.toFixed(2)}×`, (n) => ({ speech: { tts: { rate: n } } }));

  $('test-voice').addEventListener('click', async () => {
    await flushPending();
    try {
      await api.testSpeak();
    } catch {}
    flash($('test-voice'), 'speaking…');
  });

  const visibility = () => {
    const sp = stt().provider;
    const tp = tts().provider;
    const hints: Record<SttProvider, string> = {
      'on-device': 'free, private, downloads ~150mb once',
      openai: 'audio is sent to openai',
      groq: 'audio is sent to groq',
      gemini: 'audio is sent to google',
      local: 'audio goes to your own server',
    };
    $('stt-hint').textContent = hints[sp];
    document.querySelector<HTMLElement>('[data-stt=key]')!.hidden = sp === 'on-device';
    document.querySelector<HTMLElement>('[data-stt=url]')!.hidden = sp !== 'local';
    const voiceRow = document.querySelector<HTMLElement>('[data-tts=voice]')!;
    voiceRow.hidden = tp === 'off';
    voiceSelect.hidden = tp === 'elevenlabs' || tp === 'off';
    voiceInput.hidden = tp !== 'elevenlabs';
    $('tts-voice-label').setAttribute('for', tp === 'elevenlabs' ? 'tts-voice-input' : 'tts-voice-select');
    document.querySelector<HTMLElement>('[data-tts=speed]')!.hidden = tp === 'off';
    document.querySelector<HTMLElement>('[data-tts=key]')!.hidden = tp === 'system' || tp === 'off';
    document.querySelector<HTMLElement>('[data-tts=test]')!.hidden = tp === 'off';
    fillVoices();
  };
  syncers.push(visibility);
  visibility();
}

/* ───────────── keys ───────────── */

let recording: { cancel(): void } | null = null;

function initKeys(): void {
  const defs = [
    { which: 'talk' as const, well: $('chord-talk'), btn: $('rec-talk') },
    { which: 'type' as const, well: $('chord-type'), btn: $('rec-type') },
  ];
  const label = (k: KeyName[]) => chordLabel(k, platform);

  for (const d of defs) {
    syncers.push(() => {
      if (recording && (d as any)._active) return;
      d.well.textContent = label(settings.hotkeys[d.which]);
    });
    d.btn.addEventListener('click', () => {
      if (recording) {
        recording.cancel();
        if ((d as any)._active) return;
      }
      start(d);
    });
  }

  function start(d: (typeof defs)[number]): void {
    (d as any)._active = true;
    void api.suspendHotkeys(true);
    const held = new Set<KeyName>();
    let peak: KeyName[] = [];
    d.well.classList.remove('bad');
    d.well.classList.add('recording');
    d.well.textContent = 'press your keys…';
    d.btn.querySelector('span')!.textContent = 'cancel';

    const finish = (commit: KeyName[] | null) => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', onBlur);
      recording = null;
      (d as any)._active = false;
      d.well.classList.remove('recording', 'bad');
      d.btn.querySelector('span')!.textContent = 'record';
      void api.suspendHotkeys(false);
      if (commit) {
        settings = { ...settings, hotkeys: { ...settings.hotkeys, [d.which]: commit } };
        void save({ hotkeys: { [d.which]: commit } });
      }
      syncAll();
    };
    const down = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      const k = canonicalCode(e.code);
      if (k === 'Escape' && held.size === 0 && peak.length === 0) return finish(null);
      held.add(k);
      if (held.size >= peak.length) peak = orderChord(held);
      d.well.classList.remove('bad');
      d.well.classList.add('recording');
      d.well.textContent = label(peak);
    };
    const up = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const k = canonicalCode(e.code);
      held.delete(k);
      if (k === 'Meta') held.clear(); // mac swallows other keyups while cmd is down
      if (held.size > 0) return;
      const err = validateChord(peak);
      if (err) {
        peak = [];
        d.well.classList.remove('recording');
        d.well.classList.add('bad');
        d.well.textContent = err;
        return;
      }
      finish(peak);
    };
    const onBlur = () => finish(null);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', onBlur);
    recording = { cancel: () => finish(null) };
  }

  const seg = $('mode-seg');
  const modeBtns = [...seg.querySelectorAll<HTMLButtonElement>('button')];
  syncers.push(() => modeBtns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === settings.hotkeys.mode))));
  modeBtns.forEach((b) =>
    b.addEventListener('click', () => {
      const mode = b.dataset.mode as 'hold' | 'toggle';
      settings = { ...settings, hotkeys: { ...settings.hotkeys, mode } };
      syncAll();
      void save({ hotkeys: { mode } });
    }),
  );
  $('reset-keys').addEventListener('click', () => {
    recording?.cancel();
    const d = DEFAULT_SETTINGS.hotkeys;
    void save({ hotkeys: { talk: [...d.talk], type: [...d.type], mode: d.mode } });
    flash($('reset-keys'), 'defaults restored');
  });
}

/* ───────────── companion ───────────── */

// The companion's color is the user's content, so it's the one place real colors appear.
const BUDDY_COLORS: Array<{ name: string; value: string }> = [
  { name: 'ink', value: '' },
  { name: 'white', value: '#ffffff' },
  { name: 'blue', value: '#2f6bff' },
  { name: 'violet', value: '#7c4dff' },
  { name: 'pink', value: '#ff4f9a' },
  { name: 'red', value: '#ff3b30' },
  { name: 'orange', value: '#ff8a00' },
  { name: 'yellow', value: '#ffcc00' },
  { name: 'green', value: '#1fbf5b' },
  { name: 'teal', value: '#14b8b0' },
];
function initColor(): void {
  const box = $('color-swatches');
  const custom = h('input', { type: 'color', class: 'swatch-custom', 'aria-label': 'custom color', title: 'custom color' }) as HTMLInputElement;
  const buttons = BUDDY_COLORS.map((c) => {
    const b = h('button', { type: 'button', role: 'radio', class: 'swatch', 'aria-label': c.name, title: c.name });
    if (c.value) b.style.setProperty('--sw', c.value);
    else b.classList.add('swatch-ink');
    b.dataset.value = c.value;
    b.addEventListener('click', () => pick(c.value));
    return b;
  });
  const pick = (value: string) => {
    settings = { ...settings, companion: { ...settings.companion, color: value } };
    sync();
    void save({ companion: { color: value } });
  };
  custom.addEventListener('input', () => pick(custom.value.toLowerCase()));
  const customWrap = h('label', { class: 'swatch swatch-custom-wrap', title: 'custom color' }, custom);
  box.append(...buttons, customWrap);
  const sync = () => {
    const cur = (settings.companion.color || '').toLowerCase();
    const preset = BUDDY_COLORS.some((c) => c.value === cur);
    for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.value === cur));
    customWrap.classList.toggle('on', !preset);
    if (!preset && cur) {
      customWrap.style.setProperty('--sw', cur);
      custom.value = cur;
    }
  };
  syncers.push(sync);
  sync();
}


function initCompanion(): void {
  bindSwitch($('sw-follow'), () => settings.companion.followCursor, (v) => ({ companion: { followCursor: v } }));
  bindSwitch($('sw-bubble'), () => settings.companion.showBubble, (v) => ({ companion: { showBubble: v } }));
  bindSwitch($('sw-point'), () => settings.companion.pointing, (v) => ({ companion: { pointing: v } }));
  bindSwitch($('sw-login'), () => settings.launchAtLogin, (v) => ({ launchAtLogin: v }));
  bindRange($<HTMLInputElement>('scale'), $('scale-out'), () => settings.companion.scale, (n) => `${n.toFixed(2)}×`, (n) => ({ companion: { scale: n } }));
  initColor();
  bindText($<HTMLTextAreaElement>('instructions'), () => settings.customInstructions, (v) => ({ customInstructions: v }));
  bindText($<HTMLInputElement>('turns'), () => String(settings.historyTurns), (v) => {
    const n = Math.max(0, Math.min(50, Math.round(Number(v))));
    return Number.isFinite(n) && v !== '' ? { historyTurns: n } : null;
  });
  $('clear-chat').addEventListener('click', async () => {
    try {
      await api.clearHistory();
    } catch {}
    flash($('clear-chat'), 'cleared');
  });
}

/* ───────────── permissions ───────────── */

const PERMS: Array<{ kind: PermissionKind; label: string; note: string }> = [
  { kind: 'microphone', label: 'microphone', note: 'to hear you while the chord is held' },
  { kind: 'screen', label: 'screen recording', note: 'so it can see what you see' },
  { kind: 'accessibility', label: 'accessibility', note: 'needed for hold-to-talk' },
];
const PERM_TEXT: Record<string, string> = {
  granted: 'granted',
  denied: 'not allowed',
  'not-determined': 'not asked yet',
  restricted: 'restricted',
  unknown: 'unknown',
};
let perms: PermissionsStatus | null = null;
const permListeners: Array<() => void> = [];

function permRows(container: HTMLElement): () => void {
  const render = () => {
    container.replaceChildren();
    if (platform !== 'darwin') {
      container.append(h('div', { class: 'row' }, h('span', { class: 'row-label' }), h('div', { class: 'row-value muted', text: `nothing to grant on ${platformName()}` })));
      return;
    }
    if (!packaged) {
      container.append(
        h('div', { class: 'row' }, h('span', { class: 'row-label', text: 'heads up' }), h('div', { class: 'row-value' }, h('p', {
          class: 'perm-note',
          text: "you're running clickity from a terminal (npm run dev), so macos asks on behalf of that terminal — turn the switches on for terminal, iterm or vs code, not clickity. the installed app shows up as itself.",
        }))),
      );
    }
    for (const p of PERMS) {
      const state = perms?.[p.kind] ?? 'unknown';
      const granted = state === 'granted';
      const grant = h('button', { class: 'text-btn', type: 'button' }, h('span', { text: granted ? 'open settings' : 'grant' }));
      grant.addEventListener('click', async () => {
        try {
          perms = await api.requestPermission(p.kind);
        } catch {}
        permListeners.forEach((f) => f());
      });
      container.append(
        h(
          'div',
          { class: 'row perm-row' },
          h('span', { class: 'row-label', text: p.label }),
          h('div', { class: 'row-value' }, h('div', {}, h('span', { class: 'perm-state', text: PERM_TEXT[state] ?? state }), h('span', { class: 'muted', text: ` · ${p.note}` })), granted ? null : grant),
        ),
      );
    }
  };
  permListeners.push(render);
  render();
  return render;
}
/** Screen recording and accessibility only take effect after a relaunch on macOS. */
function restartRow(): HTMLElement {
  const btn = h('button', { class: 'text-btn', type: 'button' }, h('span', { text: 'restart clickity' }));
  btn.addEventListener('click', () => void api.relaunch());
  return h('div', { class: 'row' }, h('span', { class: 'row-label', text: 'granted something?' }), h('div', { class: 'row-value' }, h('span', { class: 'muted', text: 'macos applies screen recording and accessibility after a restart. ' }), btn));
}
const platformName = () => ({ darwin: 'macos', win32: 'windows', linux: 'linux' } as Record<string, string>)[platform] ?? platform;
async function pollPerms(): Promise<void> {
  try {
    perms = await api.getPermissions();
  } catch {}
  permListeners.forEach((f) => f());
}

/* ───────────── about ───────────── */

async function initAbout(): Promise<void> {
  $('quit').addEventListener('click', () => void api.quit());
  try {
    const info = await api.appInfo();
    platform = info.platform;
    packaged = info.packaged;
    if (platform === 'darwin') $('perm-sheet').after(h('div', { class: 'sheet' }, restartRow()));
    permListeners.forEach((f) => f());
    $('app-version').textContent = `v${info.version}`;
    $('app-platform').textContent = `· ${platformName()}`;
  } catch {}
}

/* ───────────── onboarding ───────────── */

function initOnboarding(): void {
  const dlg = $<HTMLDialogElement>('onboard');
  let step = 0;
  const body = $('ob-body');
  const next = $('ob-next');
  const back = $('ob-back');
  const skip = $('ob-skip');
  const label = (id: string) => (document.getElementById(id)?.querySelector('span') ?? $(id));
  let removePerm: (() => void) | null = null;

  const choose = (kind: ProviderKind) => {
    const r = rowApi.get(kind);
    r?.open();
    if (settings.provider !== kind) {
      settings = { ...settings, provider: kind };
      syncAll();
      void save({ provider: kind });
    }
    go(1);
    setTimeout(() => r?.el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' }), 60);
  };

  const render = () => {
    $('ob-step').textContent = `step ${step + 1} of 3`;
    body.replaceChildren();
    if (removePerm) {
      permListeners.splice(permListeners.indexOf(removePerm), 1);
      removePerm = null;
    }
    back.hidden = step === 0;
    skip.hidden = step === 2;
    label('ob-next').textContent = step === 2 ? 'start' : 'next';
    if (step === 0) {
      $('ob-title').textContent = 'Pick your brain.';
      $('ob-sub').textContent = 'you can change this any time.';
      const opt = (name: string, note: string, kind: ProviderKind) => {
        const b = h('button', { class: 'ob-choice', type: 'button' }, h('b', { text: name }), h('span', { text: note }));
        b.addEventListener('click', () => choose(kind));
        return b;
      };
      body.append(
        opt('a subscription', 'claude, chatgpt or gemini', 'claude-subscription'),
        opt('an api key', 'anthropic, openai, gemini, openrouter', 'anthropic-api'),
        opt('a local model', 'ollama, lm studio', 'local'),
      );
    } else if (step === 1) {
      $('ob-title').textContent = 'A few permissions.';
      $('ob-sub').textContent = platform === 'darwin' ? 'clickity needs these to hear and see.' : '';
      const box = h('div', { class: 'sheet' });
      body.append(box);
      removePerm = permRows(box);
      void pollPerms();
    } else {
      $('ob-title').textContent = 'Say hi.';
      $('ob-sub').textContent = 'hold the chord, talk, let go.';
      body.append(h('div', { class: 'ob-chord tnum', text: chordLabel(settings.hotkeys.talk, platform) }));
    }
  };
  const go = (n: number) => {
    step = Math.max(0, Math.min(2, n));
    render();
  };
  next.addEventListener('click', async () => {
    if (step < 2) return go(step + 1);
    settings = { ...settings, onboarded: true };
    await save({ onboarded: true });
    dlg.close();
  });
  back.addEventListener('click', () => go(step - 1));
  skip.addEventListener('click', () => go(step + 1));
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  syncers.push(() => {
    if (dlg.open && step === 2) render();
  });
  (window as any).__openOnboarding = () => {
    go(0);
    if (!dlg.open) dlg.showModal();
  };
}

/* ───────────── boot ───────────── */

async function boot(): Promise<void> {
  initTheme();
  initChrome();
  initFloat();
  initModel();
  initVoice();
  initKeys();
  initCompanion();
  permRows($('perm-sheet'));
  initOnboarding();

  try {
    settings = (await api.getSettings()) as Settings;
  } catch {}
  await initAbout();
  syncers.push(() => {
    $('hero-hotkey').textContent = chordLabel(settings.hotkeys.talk, platform);
  });
  syncAll();
  permListeners.forEach((f) => f());
  void pollPerms();

  api.onSettingsChanged((s) => {
    settings = s;
    syncAll();
  });
  window.addEventListener('focus', () => void pollPerms());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void pollPerms();
  });

  if (!settings.onboarded) (window as any).__openOnboarding();
}

void boot();
