// Settings › clickys (named companions) and settings › companion › notch panel.
// Kept out of settings.ts: settings.ts hands in its settings / save / sync hooks.
import { PROVIDER_KINDS, PROVIDER_META, type Clicky, type ClickyQuizAnswers, type ClickySuggestion, type DeepPartial, type ProviderKind, type Settings, type TtsProvider } from '../../shared/types';
import type { SettingsApi } from '../../shared/ipc';
import { CLICKY_COLORS, CLICKY_NAME_MAX, CLICKY_PERSONA_MAX, MAX_CLICKYS, clickyIdFor } from '../../shared/clickys';

export interface ClickysCtx {
  api: SettingsApi;
  get(): Settings;
  save(patch: DeepPartial<Settings>): Promise<void>;
  onSync(f: () => void): void;
}

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string | boolean | number> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
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
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/** the clickity mark in a clicky's color ('' = ink) */
export function clickyMark(color: string, size = 18): HTMLElement {
  const span = h('span', { class: 'clicky-mark', 'aria-hidden': 'true' });
  span.style.width = span.style.height = `${size}px`;
  if (color) span.style.color = color;
  span.innerHTML =
    '<svg viewBox="0 0 100 100"><polygon points="40.60,38.01 82.41,68.89 50.02,89.13" fill="currentColor" stroke="currentColor" stroke-width="7.75" stroke-linejoin="round"/><g stroke="currentColor" stroke-width="4.26" stroke-linecap="round"><line x1="25.43" y1="25.98" x2="15.85" y2="22.88"/><line x1="29.68" y1="20.53" x2="23.52" y2="10.68"/><line x1="36.43" y1="19.10" x2="37.86" y2="9.13"/></g></svg>';
  return span;
}

const TTS_LABEL: Record<TtsProvider, string> = { system: 'system voice', openai: 'openai', elevenlabs: 'elevenlabs', off: 'no voice' };
const isFocused = (el: Element): boolean => document.activeElement === el;

function firstSentence(t: string): string {
  const one = t.replace(/\s+/g, ' ').trim();
  const m = /^(.{1,80}?[.!?])(\s|$)/.exec(one);
  return m ? m[1] : one.length > 80 ? `${one.slice(0, 79).trimEnd()}…` : one;
}

/* ───────────── the list ───────────── */

/** clicky edits replace the whole list: queue them, each computed from the settings the previous one saved */
let chain: Promise<void> = Promise.resolve();
function mutateClickys(ctx: ClickysCtx, fn: (s: Settings) => DeepPartial<Settings> | null): Promise<void> {
  chain = chain
    .then(() => {
      const patch = fn(ctx.get());
      return patch ? ctx.save(patch) : undefined;
    })
    .catch(() => undefined);
  return chain;
}

export function initClickys(ctx: ClickysCtx): void {
  const list = $('clicky-list');
  const rows = new Map<string, { el: HTMLElement; sync(c: Clicky): void; open(focusName?: boolean): void }>();
  let order = '';
  let openId: string | null = null;

  const clickys = () => ctx.get().clickys;
  const mutate = (fn: (s: Settings) => DeepPartial<Settings> | null) => mutateClickys(ctx, fn);
  /** change one clicky (computed when its turn in the save queue comes, so edits never race) */
  const editClicky = (id: string, fn: (c: Clicky) => Clicky): Promise<void> =>
    mutate((s) => (s.clickys.some((c) => c.id === id) ? { clickys: s.clickys.map((c) => (c.id === id ? fn({ ...c }) : c)) } : null));
  const patchClicky = (id: string, patch: Partial<Clicky>): Promise<void> => editClicky(id, (c) => ({ ...c, ...patch }));

  function buildRow(c0: Clicky): { el: HTMLElement; sync(c: Clicky): void; open(focusName?: boolean): void } {
    const id = c0.id;
    const bodyId = `cbody-${id}`;
    const label = h('span', { class: 'row-label clicky-label' });
    const title = h('span', { class: 'prow-title' });
    const detail = h('span', { class: 'prow-detail' });
    const toggle = h('button', { class: 'toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': bodyId }, label, h('span', { class: 'prow-val' }, title, detail), h('span', { class: 'plus', 'aria-hidden': 'true' }));
    const use = h('button', { class: 'use', type: 'button', role: 'radio', 'aria-checked': 'false' }, h('i'), h('span', { text: 'use' }));
    use.addEventListener('click', () => void ctx.save({ activeClicky: id }));

    const pad = h('div', { class: 'pbody-pad' });
    const body = h('div', { class: 'pbody', id: bodyId }, h('div', { class: 'pbody-in' }, pad));
    const set = (open: boolean) => {
      toggle.setAttribute('aria-expanded', String(open));
      body.classList.toggle('open', open);
      (body.firstElementChild as HTMLElement).inert = !open;
      if (open) {
        openId = id;
        void refreshMemory();
      } else if (openId === id) openId = null;
    };
    toggle.addEventListener('click', () => set(toggle.getAttribute('aria-expanded') !== 'true'));
    set(false);

    // name
    const name = h('input', { type: 'text', id: `cname-${id}`, maxlength: CLICKY_NAME_MAX, spellcheck: 'false', autocomplete: 'off' });
    pad.append(h('div', { class: 'field' }, h('label', { class: 'eyebrow', for: name.id, text: 'name' }), name));
    debounced(name, () => {
      const v = name.value.replace(/\s+/g, ' ').trim();
      if (v) void patchClicky(id, { name: v });
    });

    // persona
    const persona = h('textarea', { id: `cpersona-${id}`, rows: 4, maxlength: CLICKY_PERSONA_MAX, placeholder: 'e.g. you help me with spreadsheets. explain formulas step by step, and keep it short.' });
    const personaHint = h('p', { class: 'hint' });
    pad.append(h('div', { class: 'field' }, h('label', { class: 'eyebrow', for: persona.id, text: 'persona' }), persona, personaHint));
    debounced(persona, () => void patchClicky(id, { persona: persona.value }));

    // color
    const sw = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'color' });
    const swButtons = CLICKY_COLORS.map((col) => {
      const b = h('button', { type: 'button', role: 'radio', class: 'swatch' + (col ? '' : ' swatch-ink'), 'aria-label': col || 'ink', title: col || 'ink' });
      if (col) b.style.setProperty('--sw', col);
      b.addEventListener('click', () => void patchClicky(id, { color: col }));
      sw.append(b);
      return { b, col };
    });
    pad.append(h('div', { class: 'field' }, h('span', { class: 'eyebrow', text: 'color' }), sw));

    // brain
    const prov = h('select', { id: `cprov-${id}` });
    prov.append(h('option', { value: '', text: 'same as everywhere' }));
    for (const k of PROVIDER_KINDS) prov.append(h('option', { value: k, text: PROVIDER_META[k].label }));
    const model = h('input', { type: 'text', id: `cmodel-${id}`, spellcheck: 'false', autocomplete: 'off', placeholder: 'default model' });
    const brainHint = h('p', { class: 'hint' });
    pad.append(h('div', { class: 'field' }, h('label', { class: 'eyebrow', for: prov.id, text: 'brain' }), h('div', { class: 'field-inline' }, prov, model), brainHint));
    prov.addEventListener('change', () => {
      const k = prov.value as ProviderKind | '';
      model.value = '';
      void editClicky(id, (next) => {
        if (k) next.provider = k;
        else delete next.provider;
        delete next.model;
        return next;
      });
    });
    debounced(model, () => {
      const v = model.value.trim();
      void editClicky(id, (next) => {
        if (!next.provider) return next;
        if (v) next.model = v;
        else delete next.model;
        return next;
      });
    });

    // voice
    const vprov = h('select', { id: `cvprov-${id}` });
    vprov.append(h('option', { value: '', text: 'same as everywhere' }));
    for (const k of Object.keys(TTS_LABEL) as TtsProvider[]) vprov.append(h('option', { value: k, text: TTS_LABEL[k] }));
    const voice = h('input', { type: 'text', id: `cvoice-${id}`, spellcheck: 'false', autocomplete: 'off', placeholder: 'voice name or id' });
    pad.append(h('div', { class: 'field' }, h('label', { class: 'eyebrow', for: vprov.id, text: 'voice' }), h('div', { class: 'field-inline' }, vprov, voice)));
    const saveVoice = () => {
      const p = vprov.value as TtsProvider | '';
      const v = voice.value.trim();
      void editClicky(id, (next) => {
        if (p) next.voice = { provider: p, voice: v };
        else delete next.voice;
        return next;
      });
    };
    vprov.addEventListener('change', saveVoice);
    debounced(voice, saveVoice);

    // memory
    const memLine = h('span', { class: 'muted', text: '·' });
    const forget = h('button', { class: 'text-btn', type: 'button' }, h('span', { text: 'forget' }));
    forget.addEventListener('click', async () => {
      await ctx.api.clickyForget(id).catch(() => undefined);
      void refreshMemory();
    });
    pad.append(h('div', { class: 'field' }, h('span', { class: 'eyebrow', text: 'memory' }), h('div', { class: 'actions' }, memLine, forget)));
    async function refreshMemory(): Promise<void> {
      let n = 0;
      try {
        n = await ctx.api.clickyMemoryCount(id);
      } catch {
        /* ignore */
      }
      memLine.textContent = n ? `remembers ${n} thing${n === 1 ? '' : 's'} about you` : 'nothing remembered yet';
      forget.hidden = !n;
    }

    // delete
    const del = h('button', { class: 'text-btn', type: 'button' }, h('span', { text: 'delete clicky' }));
    const confirmBox = h('div', { class: 'actions clicky-confirm', hidden: true });
    const yes = h('button', { class: 'btn', type: 'button' }, h('span', { text: 'delete' }));
    const no = h('button', { class: 'text-btn', type: 'button' }, h('span', { text: 'cancel' }));
    const confirmText = h('span', { class: 'result' });
    confirmBox.append(confirmText, yes, no);
    del.addEventListener('click', () => {
      const cur = clickys().find((c) => c.id === id);
      confirmText.textContent = `delete ${cur?.name ?? 'this clicky'}? its chats stay, under all clickys.`;
      confirmBox.hidden = false;
      del.hidden = true;
      yes.focus();
    });
    no.addEventListener('click', () => {
      confirmBox.hidden = true;
      del.hidden = false;
    });
    yes.addEventListener('click', () => {
      void mutate((s) => {
        const rest = s.clickys.filter((c) => c.id !== id);
        return rest.length ? { clickys: rest, activeClicky: s.activeClicky === id ? rest[0].id : s.activeClicky } : null;
      });
    });
    const delRow = h('div', { class: 'actions' }, del, confirmBox);
    pad.append(delRow);

    const el = h('div', { class: 'prow clicky-row', 'data-id': id }, h('div', { class: 'prow-head' }, toggle, use), body);

    const sync = (c: Clicky) => {
      const s = ctx.get();
      label.replaceChildren(clickyMark(c.color, 18), h('span', { class: 'clicky-name', text: c.name }));
      const active = s.activeClicky === c.id;
      use.setAttribute('aria-checked', String(active));
      use.setAttribute('aria-label', `talk to ${c.name}`);
      title.textContent = c.persona.trim() ? firstSentence(c.persona) : c.id === 'clickity' ? 'the original. friendly, short answers.' : 'no persona yet';
      const brain = c.provider ? `${PROVIDER_META[c.provider].label} · ${c.model || PROVIDER_META[c.provider].defaultModel}` : 'same brain';
      const v = c.voice ? (c.voice.voice ? `${TTS_LABEL[c.voice.provider]} · ${c.voice.voice}` : TTS_LABEL[c.voice.provider]) : 'same voice';
      detail.textContent = `${active ? 'talking now · ' : ''}${brain} · ${v}`;
      if (!isFocused(name)) name.value = c.name;
      if (!isFocused(persona)) persona.value = c.persona;
      personaHint.textContent = `it's told “you are ${c.name}”, then this. leave empty for the usual clickity.`;
      for (const { b, col } of swButtons) b.setAttribute('aria-checked', String(col === c.color));
      if (!isFocused(prov)) prov.value = c.provider ?? '';
      model.disabled = !c.provider;
      model.placeholder = c.provider ? PROVIDER_META[c.provider].defaultModel : 'pick a provider first';
      if (!isFocused(model)) model.value = c.model ?? '';
      const g = s.models[s.provider] || PROVIDER_META[s.provider].defaultModel;
      brainHint.textContent = c.provider ? 'sign-in and keys come from settings › model.' : `uses ${PROVIDER_META[s.provider].label} · ${g}, like everything else.`;
      if (!isFocused(vprov)) vprov.value = c.voice?.provider ?? '';
      voice.disabled = !c.voice || c.voice.provider === 'off';
      voice.placeholder = !c.voice ? 'pick a voice first' : c.voice.provider === 'system' ? 'system voice name (empty = default)' : c.voice.provider === 'openai' ? 'alloy, nova, sage…' : c.voice.provider === 'elevenlabs' ? 'voice id' : '';
      voice.hidden = c.voice?.provider === 'off';
      if (!isFocused(voice)) voice.value = c.voice?.voice ?? '';
      delRow.hidden = s.clickys.length < 2;
    };
    sync(c0);
    return {
      el,
      sync,
      open: (focusName) => {
        set(true);
        if (focusName) setTimeout(() => (name.focus(), name.select()), 60);
      },
    };
  }

  function render(): void {
    const list0 = clickys();
    const key = list0.map((c) => c.id).join('|');
    if (key !== order) {
      order = key;
      for (const [id, r] of rows) if (!list0.some((c) => c.id === id)) {
        r.el.remove();
        rows.delete(id);
      }
      for (const c of list0) if (!rows.has(c.id)) rows.set(c.id, buildRow(c));
      list.replaceChildren(...list0.map((c) => rows.get(c.id)!.el));
    }
    for (const c of list0) rows.get(c.id)?.sync(c);
    $<HTMLButtonElement>('clicky-new').disabled = list0.length >= MAX_CLICKYS;
  }
  ctx.onSync(render);
  render();

  $('clicky-new').addEventListener('click', async () => {
    let made: Clicky | null = null;
    await mutate((s) => {
      const list0 = s.clickys;
      if (list0.length >= MAX_CLICKYS) return null;
      let n = 1;
      while (list0.some((c) => c.name === (n === 1 ? 'new clicky' : `new clicky ${n}`))) n++;
      const name = n === 1 ? 'new clicky' : `new clicky ${n}`;
      const used = new Set(list0.map((c) => c.color));
      const color = CLICKY_COLORS.find((c) => c && !used.has(c)) ?? '';
      made = { id: clickyIdFor(name, list0.map((x) => x.id)), name, color, persona: '', createdAt: Date.now() };
      return { clickys: [...list0, made] };
    });
    render();
    if (made) rows.get((made as Clicky).id)?.open(true);
  });

  initSuggest(ctx, (c) => {
    render();
    rows.get(c.id)?.el.classList.add('flash');
  });
}

/** text input → save 500ms after the last keystroke (and on blur) */
function debounced(el: HTMLInputElement | HTMLTextAreaElement, commit: () => void): void {
  let t: number | undefined;
  let dirty = false;
  const run = () => {
    window.clearTimeout(t);
    if (!dirty) return;
    dirty = false;
    commit();
  };
  el.addEventListener('input', () => {
    dirty = true;
    window.clearTimeout(t);
    t = window.setTimeout(run, 500);
  });
  el.addEventListener('blur', run);
}

/* ───────────── suggest clickys for me ───────────── */

const QUIZ: Array<{ key: keyof ClickyQuizAnswers; q: string; options: string[] }> = [
  { key: 'use', q: 'what do you use your computer for?', options: ['work & documents', 'coding', 'studying', 'creative work', 'email & browsing'] },
  { key: 'stuck', q: 'where do you get stuck most?', options: ['spreadsheets & data', 'writing', 'learning new apps', 'errors & bugs', 'staying organised'] },
  { key: 'tone', q: 'how should it talk to you?', options: ['short & direct', 'patient, step by step', 'playful', 'like a teacher'] },
];

function initSuggest(ctx: ClickysCtx, added: (c: Clicky) => void): void {
  const dlg = $<HTMLDialogElement>('suggest-dlg');
  const body = $('sg-body');
  const go = $<HTMLButtonElement>('sg-go');
  const step = $('sg-step');
  const titleEl = $('sg-title');
  let answers: Partial<ClickyQuizAnswers> = {};
  let busy = false;

  const ready = () => QUIZ.every((q) => answers[q.key]);
  function renderQuiz(): void {
    step.textContent = 'three quick questions';
    titleEl.textContent = 'Suggest clickys for me.';
    go.hidden = false;
    go.querySelector('span')!.textContent = 'suggest';
    body.replaceChildren(
      ...QUIZ.map((q) => {
        const picks = h('div', { class: 'sg-picks', role: 'radiogroup', 'aria-label': q.q });
        for (const o of q.options) {
          const b = h('button', { class: 'sg-pick', type: 'button', role: 'radio', 'aria-checked': String(answers[q.key] === o), text: o });
          b.addEventListener('click', () => {
            answers[q.key] = o;
            picks.querySelectorAll('.sg-pick').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
            go.disabled = !ready();
          });
          picks.append(b);
        }
        return h('div', { class: 'sg-q' }, h('p', { class: 'sg-qtext', text: q.q }), picks);
      }),
    );
    go.disabled = !ready();
  }

  function renderResults(list: ClickySuggestion[]): void {
    step.textContent = `${list.length} idea${list.length === 1 ? '' : 's'}`;
    titleEl.textContent = 'Some clickys for you.';
    go.hidden = false;
    go.querySelector('span')!.textContent = 'ask again';
    go.disabled = false;
    body.replaceChildren(
      ...list.map((s) => {
        const add = h('button', { class: 'btn', type: 'button' }, h('span', { text: 'add' }));
        add.addEventListener('click', async () => {
          if (ctx.get().clickys.length >= MAX_CLICKYS) return void (add.querySelector('span')!.textContent = 'too many clickys');
          let c: Clicky | null = null;
          await mutateClickys(ctx, (st) => {
            if (st.clickys.length >= MAX_CLICKYS) return null;
            c = { id: clickyIdFor(s.name, st.clickys.map((x) => x.id)), name: s.name, color: s.color, persona: s.persona, createdAt: Date.now() };
            return { clickys: [...st.clickys, c] };
          });
          if (!c) return;
          add.disabled = true;
          add.querySelector('span')!.textContent = 'added';
          added(c);
        });
        return h(
          'div',
          { class: 'sg-card' },
          h('div', { class: 'sg-card-head' }, clickyMark(s.color, 22), h('span', { class: 'sg-name', text: s.name }), add),
          s.why ? h('p', { class: 'sg-why', text: s.why }) : null,
          h('p', { class: 'sg-persona', text: s.persona }),
        );
      }),
    );
  }

  async function run(): Promise<void> {
    if (busy || !ready()) return;
    busy = true;
    go.disabled = true;
    step.textContent = 'thinking';
    body.replaceChildren(h('p', { class: 'loading sg-loading', text: 'asking your model for a few ideas…', 'aria-live': 'polite' }));
    try {
      renderResults(await ctx.api.suggestClickys(answers as ClickyQuizAnswers));
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).replace(/^error invoking remote method '[^']+': (error: )?/i, '').toLowerCase();
      body.replaceChildren(h('p', { class: 'result err', text: msg || 'something went wrong' }));
      go.querySelector('span')!.textContent = 'try again';
      go.disabled = false;
    } finally {
      busy = false;
    }
  }

  go.addEventListener('click', () => {
    if (go.querySelector('span')!.textContent === 'ask again') {
      renderQuiz();
      return;
    }
    void run();
  });
  $('sg-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  $('clicky-suggest').addEventListener('click', () => {
    if (!busy) renderQuiz();
    dlg.showModal();
  });
}

/* ───────────── settings › companion › notch panel ───────────── */

export function initNotchSetting(ctx: ClickysCtx): void {
  type Mode = NonNullable<Settings['companion']['notch']>;
  const seg = [...document.querySelectorAll<HTMLButtonElement>('#notch-seg button')];
  const hint = $('notch-hint');
  const HINTS: Record<Mode, string> = {
    off: 'a small black pill at the top of your screen, with the active clicky and a quick ask box.',
    hover: 'touch the top-middle edge of the screen with your cursor and it slides in.',
    always: 'always sitting under the menu bar on the screen with your cursor. hover to see the chat.',
  };
  const sync = () => {
    const m = ctx.get().companion.notch ?? 'off';
    for (const b of seg) b.setAttribute('aria-checked', String(b.dataset.notch === m));
    hint.textContent = HINTS[m] ?? '';
  };
  for (const b of seg) b.addEventListener('click', () => void ctx.save({ companion: { notch: b.dataset.notch as Mode } }).then(sync));
  ctx.onSync(sync);
  sync();
}
