// Settings window: dictation dictionary, memory, routines, voice extras (language picker, mic,
// voice previews, captions), hands-free, show in dock, replay tour. Talks to main through
// window.clicky like settings.ts, which hands in its helpers.
import type { DeepPartial, Routine, Settings, SpeakCommand } from '../../shared/types';

type H = <K extends keyof HTMLElementTagNameMap>(tag: K, props?: Record<string, string | boolean | number>, ...kids: Array<Node | string | null | undefined | false>) => HTMLElementTagNameMap[K];

export interface ExtrasCtx {
  get(): Settings;
  set(s: Settings): void;
  save(patch: DeepPartial<Settings>): Promise<void>;
  sync(f: () => void): void;
  syncAll(): void;
  flash(btn: HTMLElement, text: string): void;
  h: H;
  platform(): string;
  openTour(): void;
}

const api = window.clicky;
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const focused = (el: Element): boolean => document.activeElement === el;

export function initExtras(ctx: ExtrasCtx): void {
  initLanguage(ctx);
  initMic(ctx);
  initVoicePreviews(ctx);
  initSwitches(ctx);
  initDictation(ctx);
  initMemory(ctx);
  initRoutines(ctx);
  initAbout(ctx);
}

function switchRow(ctx: ExtrasCtx, id: string, get: (s: Settings) => boolean, patch: (v: boolean) => DeepPartial<Settings>): void {
  const btn = $(id);
  ctx.sync(() => btn.setAttribute('aria-checked', String(get(ctx.get()))));
  btn.addEventListener('click', () => {
    const v = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', String(v));
    void ctx.save(patch(v));
  });
}

/* ───────── voice: language, microphone, previews, captions ───────── */

const LANGUAGES: Array<[string, string]> = [
  ['', 'auto-detect'], ['en', 'english'], ['es', 'spanish'], ['fr', 'french'], ['de', 'german'], ['it', 'italian'],
  ['pt', 'portuguese'], ['nl', 'dutch'], ['pl', 'polish'], ['sv', 'swedish'], ['da', 'danish'], ['no', 'norwegian'],
  ['fi', 'finnish'], ['tr', 'turkish'], ['ru', 'russian'], ['uk', 'ukrainian'], ['ja', 'japanese'], ['ko', 'korean'],
  ['zh', 'chinese'], ['hi', 'hindi'], ['ar', 'arabic'], ['he', 'hebrew'], ['id', 'indonesian'], ['vi', 'vietnamese'],
];
const MULTILINGUAL_MODEL = 'Xenova/whisper-base';

function initLanguage(ctx: ExtrasCtx): void {
  const sel = $<HTMLSelectElement>('stt-lang-select');
  const other = $<HTMLInputElement>('stt-lang');
  const note = $('stt-lang-note');
  for (const [code, name] of LANGUAGES) sel.append(ctx.h('option', { value: code, text: name }));
  sel.append(ctx.h('option', { value: '*', text: 'other…' }));
  ctx.sync(() => {
    const lang = ctx.get().speech.stt.language ?? '';
    const known = LANGUAGES.some(([c]) => c === lang);
    if (!focused(sel)) sel.value = known ? lang : '*';
    other.hidden = known;
  });
  sel.addEventListener('change', () => {
    if (sel.value === '*') {
      other.hidden = false;
      other.focus();
      return;
    }
    const stt = ctx.get().speech.stt;
    const patch: DeepPartial<Settings> = { speech: { stt: { language: sel.value } } };
    // english-only on-device models can't transcribe other languages: switch to the multilingual one
    if (sel.value && sel.value !== 'en' && stt.provider === 'on-device' && /\.en$/i.test(stt.model)) {
      patch.speech!.stt!.model = MULTILINGUAL_MODEL;
      note.hidden = false;
      note.textContent = `switched the on-device model to ${MULTILINGUAL_MODEL.toLowerCase()} (multilingual, downloads once).`;
    } else note.hidden = true;
    void ctx.save(patch);
  });
}

function initMic(ctx: ExtrasCtx): void {
  const sel = $<HTMLSelectElement>('mic-select');
  const fill = async (): Promise<void> => {
    let devices: MediaDeviceInfo[] = [];
    try {
      devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    } catch {
      /* no media devices */
    }
    const cur = ctx.get().speech.stt.micId ?? '';
    sel.replaceChildren(ctx.h('option', { value: '', text: 'system default' }));
    devices.forEach((d, i) => sel.append(ctx.h('option', { value: d.deviceId, text: (d.label || `microphone ${i + 1}`).toLowerCase() })));
    if (cur && !devices.some((d) => d.deviceId === cur)) sel.append(ctx.h('option', { value: cur, text: 'previous microphone (not connected)' }));
    if (!focused(sel)) sel.value = cur;
  };
  sel.addEventListener('change', () => void ctx.save({ speech: { stt: { micId: sel.value } } }));
  sel.addEventListener('focus', () => void fill());
  navigator.mediaDevices?.addEventListener?.('devicechange', () => void fill());
  ctx.sync(() => {
    if (!focused(sel)) sel.value = ctx.get().speech.stt.micId ?? '';
  });
  void fill();
}

const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
let previewAudio: HTMLAudioElement | null = null;

async function play(cmd: SpeakCommand | null): Promise<void> {
  previewAudio?.pause();
  speechSynthesis.cancel();
  if (!cmd) return;
  if (cmd.mode === 'system') {
    const u = new SpeechSynthesisUtterance(cmd.text);
    const v = speechSynthesis.getVoices().find((x) => x.name === cmd.voice);
    if (v) u.voice = v;
    u.rate = cmd.rate || 1;
    speechSynthesis.speak(u);
    return;
  }
  const url = URL.createObjectURL(new Blob([cmd.data], { type: cmd.mime }));
  previewAudio = new Audio(url);
  previewAudio.onended = () => URL.revokeObjectURL(url);
  await previewAudio.play();
}

function initVoicePreviews(ctx: ExtrasCtx): void {
  const box = $('voice-previews');
  const row = $('voice-previews-row');
  const render = (): void => {
    const s = ctx.get();
    const p = s.speech.tts.provider;
    row.hidden = p !== 'system' && p !== 'openai';
    if (row.hidden) return;
    const names = p === 'openai' ? OPENAI_VOICES : ['', ...('speechSynthesis' in window ? speechSynthesis.getVoices().map((v) => v.name) : [])].slice(0, 40);
    const key = `${p}|${names.join(',')}|${s.speech.tts.voice}`;
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.replaceChildren(
      ...names.map((name) => {
        const b = ctx.h('button', { type: 'button', title: `listen to ${name || 'the default voice'}`, 'aria-current': String(name === s.speech.tts.voice) }, `▶ ${(name || 'default').toLowerCase()}`);
        b.addEventListener('click', async () => {
          try {
            await play(await api.voicePreview(p, name));
          } catch (e) {
            ctx.flash(b, String((e as Error)?.message || 'could not play').toLowerCase().slice(0, 40));
          }
        });
        b.addEventListener('dblclick', () => void ctx.save({ speech: { tts: { voice: name } } }));
        return b;
      }),
    );
  };
  ctx.sync(render);
  if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', render);
}

function initSwitches(ctx: ExtrasCtx): void {
  switchRow(ctx, 'sw-captions', (s) => !!s.companion.captions, (v) => ({ companion: { captions: v } }));
  switchRow(ctx, 'sw-autocopy', (s) => s.companion.autoCopy !== false, (v) => ({ companion: { autoCopy: v } }));
  switchRow(ctx, 'sw-handsfree', (s) => !!s.handsFree?.enabled, (v) => ({ handsFree: { enabled: v } }));
  const st = $('handsfree-state');
  ctx.sync(() => {
    st.textContent = ctx.get().handsFree?.enabled ? 'always listening — just talk' : 'always listening is off';
    const mac = ctx.platform() === 'darwin';
    $('draft-mod').textContent = mac ? 'option' : 'alt';
  });
}

/* ───────── dictation ───────── */

function initDictation(ctx: ExtrasCtx): void {
  const words = $<HTMLTextAreaElement>('dict-words');
  let t: number | undefined;
  const commitWords = (): void => {
    window.clearTimeout(t);
    const list = words.value.split(/[,\n]+/).map((w) => w.trim()).filter(Boolean);
    if (list.join('\n') !== ctx.get().dictation.words.join('\n')) void ctx.save({ dictation: { words: list } });
  };
  words.addEventListener('input', () => {
    window.clearTimeout(t);
    t = window.setTimeout(commitWords, 600);
  });
  words.addEventListener('blur', commitWords);
  ctx.sync(() => {
    if (!focused(words)) words.value = ctx.get().dictation.words.join(', ');
  });

  const pairs = $('dict-pairs');
  const from = $<HTMLInputElement>('dict-from');
  const to = $<HTMLInputElement>('dict-to');
  const add = (f: string, tt: string): void => {
    f = f.trim();
    if (!f) return;
    const d = ctx.get().dictation;
    const rest = d.replacements.filter((r) => r.from.toLowerCase() !== f.toLowerCase());
    void ctx.save({ dictation: { replacements: [...rest, { from: f, to: tt.trim() }], suggestions: d.suggestions.filter((s) => s.from.toLowerCase() !== f.toLowerCase()) } });
  };
  $('dict-add').addEventListener('click', () => {
    add(from.value, to.value);
    from.value = to.value = '';
    from.focus();
  });
  to.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('dict-add').click();
  });
  ctx.sync(() => {
    const d = ctx.get().dictation;
    pairs.replaceChildren(
      ...d.replacements.map((r) => {
        const x = ctx.h('button', { class: 'text-btn', type: 'button', 'aria-label': `remove ${r.from}` }, ctx.h('span', { text: 'remove' }));
        x.addEventListener('click', () => void ctx.save({ dictation: { replacements: ctx.get().dictation.replacements.filter((q) => q.from !== r.from) } }));
        return ctx.h('div', { class: 'pair' }, ctx.h('span', { class: 'grow', text: `${r.from} → ${r.to || '(nothing)'}` }), x);
      }),
    );
    const sug = $('dict-suggest');
    $('dict-suggest-row').hidden = d.suggestions.length === 0;
    sug.replaceChildren(
      ...d.suggestions.map((r) => {
        const yes = ctx.h('button', { class: 'text-btn', type: 'button' }, ctx.h('span', { text: 'add' }));
        const no = ctx.h('button', { class: 'text-btn', type: 'button' }, ctx.h('span', { text: 'dismiss' }));
        yes.addEventListener('click', () => add(r.from, r.to));
        no.addEventListener('click', () => void ctx.save({ dictation: { suggestions: ctx.get().dictation.suggestions.filter((q) => q.from !== r.from) } }));
        return ctx.h('div', { class: 'pair' }, ctx.h('span', { class: 'grow', text: `you corrected "${r.from}" to "${r.to}"` }), yes, no);
      }),
    );
  });
  switchRow(ctx, 'sw-learn', (s) => s.dictation.autoLearn, (v) => ({ dictation: { autoLearn: v } }));
  const seg = [...$('dash-seg').querySelectorAll<HTMLButtonElement>('button')];
  ctx.sync(() => seg.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.dash === ctx.get().dictation.dashes))));
  seg.forEach((b) => b.addEventListener('click', () => void ctx.save({ dictation: { dashes: b.dataset.dash as Settings['dictation']['dashes'] } })));
}

/* ───────── memory ───────── */

function initMemory(ctx: ExtrasCtx): void {
  switchRow(ctx, 'sw-memory', (s) => s.memory?.enabled !== false, (v) => ({ memory: { enabled: v } }));
  const list = $('memory-list');
  let facts: string[] = [];
  const render = (): void => {
    list.replaceChildren(
      ...facts.map((f, i) => {
        const input = ctx.h('input', { type: 'text', value: f, 'aria-label': `fact ${i + 1}`, spellcheck: 'false' }) as HTMLInputElement;
        input.addEventListener('change', () => {
          const next = [...facts];
          if (input.value.trim()) next[i] = input.value.trim();
          else next.splice(i, 1);
          void api.memorySet(next).then((r) => ((facts = r), render()));
        });
        const del = ctx.h('button', { class: 'text-btn', type: 'button', 'aria-label': `forget ${f}` }, ctx.h('span', { text: 'forget' }));
        del.addEventListener('click', () => void api.memorySet(facts.filter((_, j) => j !== i)).then((r) => ((facts = r), render())));
        return ctx.h('div', { class: 'pair' }, input, del);
      }),
    );
    if (!facts.length) list.replaceChildren();
    $('memory-clear').hidden = !facts.length;
  };
  const input = $<HTMLInputElement>('memory-new');
  $('memory-add').addEventListener('click', () => {
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    void api.memorySet([...facts, v]).then((r) => ((facts = r), render()));
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('memory-add').click();
  });
  const clear = $('memory-clear');
  let armed = 0;
  clear.addEventListener('click', () => {
    if (Date.now() - armed > 3000) {
      armed = Date.now();
      ctx.flash(clear, 'click again to forget everything');
      return;
    }
    armed = 0;
    void api.memoryClear().then(() => ((facts = []), render()));
  });
  api.onMemoryChanged((f) => {
    facts = f;
    render();
  });
  void api.memoryList().then((f) => {
    facts = f;
    render();
  });
}

/* ───────── routines ───────── */

const DAY_LETTERS = ['s', 'm', 't', 'w', 't', 'f', 's'];
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function initRoutines(ctx: ExtrasCtx): void {
  const box = $('routine-list');
  const patch = (id: string, p: Partial<Routine>): void => {
    void ctx.save({ routines: ctx.get().routines.map((r) => (r.id === id ? { ...r, ...p } : r)) });
  };
  let lastKey = '';
  const render = (): void => {
    const list = ctx.get().routines;
    // don't rebuild while the user types in one (the prompt field would lose focus)
    const key = JSON.stringify(list);
    if (key === lastKey || box.contains(document.activeElement) && document.activeElement?.tagName === 'TEXTAREA') return;
    lastKey = key;
    box.replaceChildren(
      ...list.map((r) => {
        const days = ctx.h('div', { class: 'days', role: 'group', 'aria-label': 'days' });
        DAY_LETTERS.forEach((l, d) => {
          const b = ctx.h('button', { type: 'button', 'aria-pressed': String(r.days.includes(d)), 'aria-label': DAY_NAMES[d], title: DAY_NAMES[d] }, l);
          b.addEventListener('click', () => patch(r.id, { days: r.days.includes(d) ? r.days.filter((x) => x !== d) : [...r.days, d].sort() }));
          days.append(b);
        });
        const time = ctx.h('input', { type: 'time', value: r.time, 'aria-label': 'time' }) as HTMLInputElement;
        time.addEventListener('change', () => time.value && patch(r.id, { time: time.value, createdAt: Date.now(), lastRun: undefined }));
        const prompt = ctx.h('textarea', { rows: '2', placeholder: 'what should clickity do? e.g. summarise what changed in my calendar today' }) as HTMLTextAreaElement;
        prompt.value = r.prompt;
        prompt.addEventListener('change', () => patch(r.id, { prompt: prompt.value.trim() }));
        const sw = (label: string, on: boolean, fn: (v: boolean) => void) => {
          const b = ctx.h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': label });
          b.addEventListener('click', () => fn(b.getAttribute('aria-checked') !== 'true'));
          return ctx.h('span', { class: 'routine-line' }, b, ctx.h('span', { class: 'muted', text: label }));
        };
        const run = ctx.h('button', { class: 'text-btn', type: 'button' }, ctx.h('span', { text: 'run now' }));
        run.addEventListener('click', async () => {
          ctx.flash(run, 'running…');
          try {
            await api.runRoutine(r.id);
          } catch (e) {
            ctx.flash(run, String((e as Error)?.message || 'failed').toLowerCase().slice(0, 40));
          }
        });
        const del = ctx.h('button', { class: 'text-btn', type: 'button' }, ctx.h('span', { text: 'delete' }));
        del.addEventListener('click', () => void ctx.save({ routines: ctx.get().routines.filter((x) => x.id !== r.id) }));
        const status = r.paused
          ? `paused after 3 failed runs${r.lastError ? `: ${r.lastError}` : ''} — switch it back on to retry`
          : r.lastError
            ? `last run failed: ${r.lastError}`
            : r.lastRun
              ? `last ran ${new Date(r.lastRun).toLocaleString().toLowerCase()}`
              : 'not run yet';
        return ctx.h(
          'div',
          { class: 'routine' },
          ctx.h('div', { class: 'routine-line' }, ctx.h('span', { class: 'muted', text: 'every' }), days, ctx.h('span', { class: 'muted', text: 'at' }), time),
          prompt,
          ctx.h(
            'div',
            { class: 'routine-line' },
            sw('on', r.enabled, (v) => patch(r.id, { enabled: v, paused: false, failures: 0 })),
            sw('look at screen', r.screen, (v) => patch(r.id, { screen: v })),
            sw('speak', r.speak, (v) => patch(r.id, { speak: v })),
            run,
            del,
          ),
          ctx.h('p', { class: `status${r.paused || r.lastError ? ' warn' : ''}`, text: status }),
        );
      }),
    );
  };
  ctx.sync(render);
  $('routine-add').addEventListener('click', () => {
    const r: Routine = {
      id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      days: [1, 2, 3, 4, 5],
      time: '09:00',
      prompt: '',
      screen: false,
      speak: false,
      enabled: true,
      createdAt: Date.now(),
    };
    void ctx.save({ routines: [...ctx.get().routines, r] }).then(() => {
      const areas = box.querySelectorAll('textarea');
      areas[areas.length - 1]?.focus();
    });
  });
}

/* ───────── about ───────── */

function initAbout(ctx: ExtrasCtx): void {
  $('replay-tour').addEventListener('click', () => ctx.openTour());
  ctx.sync(() => {
    $('dock-row').hidden = ctx.platform() !== 'darwin';
  });
  switchRow(ctx, 'sw-dock', (s) => s.showInDock !== false, (v) => ({ showInDock: v }));
}
