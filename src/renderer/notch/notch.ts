// Notch panel renderer: the black pill at the top of the screen. Talks to main only via window.notch.
import type { NotchState } from '../../shared/ipc';
import type { ChatAttachment } from '../../shared/types';

const api = window.notch;
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  pill: $('pill'),
  who: $<HTMLButtonElement>('who'),
  whoMark: $('who-mark'),
  whoName: $('who-name'),
  ask: $<HTMLInputElement>('ask'),
  line: $('line'),
  msgs: $('msgs'),
  switchList: $('switch-list'),
  atts: $('atts'),
  screen: $<HTMLButtonElement>('screen'),
  ctl: $('ctl'),
};

/** clickity mark (same geometry as assets/logo-mark.svg), in the clicky's color */
function markSvg(): string {
  return '<svg viewBox="0 0 100 100" aria-hidden="true"><polygon points="40.60,38.01 82.41,68.89 50.02,89.13" fill="currentColor" stroke="currentColor" stroke-width="7.75" stroke-linejoin="round"/><g stroke="currentColor" stroke-width="4.26" stroke-linecap="round"><line x1="25.43" y1="25.98" x2="15.85" y2="22.88"/><line x1="29.68" y1="20.53" x2="23.52" y2="10.68"/><line x1="36.43" y1="19.10" x2="37.86" y2="9.13"/></g></svg>';
}
/** pure black panel: an ink (unset) or near-black clicky shows as light */
function markColor(c: string): string {
  if (!c) return '#f2f2f4';
  const n = parseInt(c.slice(1), 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum < 40 ? '#f2f2f4' : c;
}

let state: NotchState | null = null;
let open = false;
/** opened by a click / typing: keyboard focus, stays until esc or a click outside */
let pinned = false;
let switching = false;
let includeScreen = true;
let attachments: ChatAttachment[] = [];
let note = ''; // a short local status line ("switched to …")
let noteTimer = 0;
let leaveTimer = 0;
let enterTimer = 0;
let collapseSeq = 0;
let dragDepth = 0;

/* ───────── open / close ───────── */

function expand(focus: boolean): void {
  collapseSeq++;
  window.clearTimeout(leaveTimer);
  if (focus) pinned = true;
  if (!open || focus) api.setExpanded(true, focus);
  open = true;
  // the window grows first, then the pill animates down into it
  requestAnimationFrame(() => el.pill.classList.add('open'));
  render();
  if (focus) setTimeout(() => el.ask.focus(), 30);
}

function collapse(): void {
  if (!open) return;
  open = false;
  pinned = false;
  switching = false;
  el.pill.classList.remove('open', 'typing');
  el.who.setAttribute('aria-expanded', 'false');
  el.ask.blur();
  const seq = ++collapseSeq;
  // shrink the window once the pill has folded up
  setTimeout(() => {
    if (seq === collapseSeq && !open) api.setExpanded(false, false);
  }, 380);
  render();
}

el.pill.addEventListener('mouseenter', () => {
  window.clearTimeout(leaveTimer);
  if (open) return;
  enterTimer = window.setTimeout(() => expand(false), 140);
});
el.pill.addEventListener('mouseleave', () => {
  window.clearTimeout(enterTimer);
  if (!open || pinned || attachments.length || dragDepth) return;
  leaveTimer = window.setTimeout(collapse, 260);
});
el.pill.addEventListener('mousedown', (e) => {
  if ((e.target as HTMLElement).closest('.ctl')) return; // stop / pause / continue: just a click
  if ((e.target as HTMLElement).closest('button')) {
    if (!pinned) expand(true);
    return;
  }
  if (!pinned) {
    e.preventDefault();
    expand(true);
  }
});
el.ask.addEventListener('focus', () => {
  el.pill.classList.add('typing');
  if (!pinned) expand(true);
});
el.ask.addEventListener('blur', () => {
  if (!el.ask.value) el.pill.classList.remove('typing');
});
el.ask.addEventListener('input', () => el.pill.classList.toggle('typing', !!el.ask.value || document.activeElement === el.ask));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (switching) {
      switching = false;
      render();
      return;
    }
    collapse();
  }
});
api.onCollapse(() => collapse());

/* ───────── send ───────── */

el.ask.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  void send();
});

async function send(): Promise<void> {
  const text = el.ask.value.trim();
  if (!text && !attachments.length) return;
  const sent = attachments;
  el.ask.value = '';
  attachments = [];
  renderAtts();
  try {
    const res = await api.send({ text, attachments: sent.length ? sent : undefined, includeScreen });
    if (res.switched) flashNote(`switched to ${res.switched}`);
  } catch (err) {
    el.ask.value = text;
    attachments = sent;
    renderAtts();
    flashNote((err instanceof Error ? err.message : String(err)).replace(/^error invoking remote method '[^']+': (error: )?/i, '').toLowerCase());
  }
}

function flashNote(text: string): void {
  note = text;
  window.clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => {
    note = '';
    render();
  }, 2600);
  render();
}

/* ───────── quick actions, screen chip, switcher ───────── */

document.querySelectorAll<HTMLButtonElement>('.act').forEach((b) =>
  b.addEventListener('click', () => {
    const a = b.dataset.a as 'new-chat' | 'open-chats' | 'open-settings';
    api.action(a);
    if (a === 'new-chat') el.ask.focus();
  }),
);
el.screen.addEventListener('click', () => {
  includeScreen = !includeScreen;
  el.screen.setAttribute('aria-pressed', String(includeScreen));
});
el.who.addEventListener('click', () => {
  if (!state || state.clickys.length < 2) return;
  switching = !switching;
  render();
});

function renderSwitcher(): void {
  if (!state) return;
  const s = state;
  const head = document.createElement('div');
  head.className = 'switch-head';
  head.textContent = 'talk to';
  const items = s.clickys.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'switch-item' + (c.id === s.clicky.id ? ' sel' : '');
    const m = document.createElement('span');
    m.className = 'who-mark';
    m.style.color = markColor(c.color);
    m.innerHTML = markSvg();
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = c.name;
    b.append(m, nm);
    if (c.id === s.clicky.id) {
      const ck = document.createElement('span');
      ck.className = 'ck';
      ck.textContent = 'active';
      b.append(ck);
    }
    b.addEventListener('click', () => {
      switching = false;
      if (c.id !== s.clicky.id) void api.switchClicky(c.id).then(() => flashNote(`switched to ${c.name}`));
      render();
      el.ask.focus();
    });
    return b;
  });
  el.switchList.replaceChildren(head, ...items);
}

/* ───────── drag and drop: attach to the next message ───────── */

const MAX_FILE = 12 * 1024 * 1024;
function readBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}
function mimeOf(f: File): string {
  if (f.type) return f.type;
  const ext = f.name.split('.').pop()?.toLowerCase();
  return ext === 'json' ? 'application/json' : ext === 'csv' ? 'text/csv' : ext === 'md' ? 'text/markdown' : ext === 'pdf' ? 'application/pdf' : 'text/plain';
}
async function addFiles(files: File[]): Promise<void> {
  for (const f of files) {
    if (f.size > MAX_FILE) {
      flashNote(`${f.name.toLowerCase()} is too large`);
      continue;
    }
    try {
      attachments.push({ name: f.name, mime: mimeOf(f), base64: await readBase64(f) });
    } catch {
      flashNote(`couldn't read ${f.name.toLowerCase()}`);
    }
  }
  renderAtts();
}
function renderAtts(): void {
  el.atts.replaceChildren(
    ...attachments.map((a, i) => {
      const chip = document.createElement('span');
      chip.className = 'att';
      const name = document.createElement('span');
      name.textContent = a.name;
      name.title = a.name;
      const x = document.createElement('button');
      x.type = 'button';
      x.setAttribute('aria-label', `remove ${a.name}`);
      x.textContent = '×';
      x.addEventListener('click', () => {
        attachments.splice(i, 1);
        renderAtts();
      });
      chip.append(name, x);
      return chip;
    }),
  );
  el.atts.hidden = !attachments.length;
}
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  el.pill.classList.add('dragging');
  if (!open) expand(false);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) el.pill.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.pill.classList.remove('dragging');
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) {
    void addFiles(files).then(() => expand(true));
  }
});

/* ───────── render ───────── */

const PHASE_LINE: Partial<Record<NotchState['phase'], string>> = {
  listening: 'listening…',
  transcribing: 'listening…',
  thinking: 'thinking…',
  acting: 'working on it…',
};

function render(): void {
  const s = state;
  if (!s) return;
  const name = s.clicky.name;
  el.pill.style.setProperty('--mark', markColor(s.clicky.color));
  el.whoMark.innerHTML = markSvg();
  el.whoName.textContent = name;
  el.who.setAttribute('aria-label', s.clickys.length > 1 ? `${name} — switch clicky` : name);
  el.who.setAttribute('aria-expanded', String(switching));
  el.ask.placeholder = `ask ${name}…`;
  el.pill.dataset.phase = s.phase;
  const busy = s.phase !== 'idle' || !!note;
  el.pill.classList.toggle('busy', busy);
  const line = note || (s.phase === 'error' ? s.line || 'something went wrong' : s.line || PHASE_LINE[s.phase] || '');
  el.line.textContent = line;
  el.line.classList.toggle('err', s.phase === 'error' && !note);

  renderControls(s);

  el.switchList.hidden = !switching;
  el.msgs.hidden = switching;
  if (switching) return renderSwitcher();

  if (!s.turns.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    const b = document.createElement('b');
    b.textContent = `hi, it's ${name}.`;
    empty.append(b, `type below, or hold ${s.hotkeyLabel} and talk.`);
    el.msgs.replaceChildren(empty);
    return;
  }
  const atBottom = el.msgs.scrollHeight - el.msgs.scrollTop - el.msgs.clientHeight < 24;
  const known = new Set([...el.msgs.querySelectorAll<HTMLElement>('.msg')].map((n) => n.dataset.id));
  el.msgs.replaceChildren(
    ...s.turns.map((t) => {
      const m = document.createElement('div');
      m.className = `msg ${t.role}${t.error && t.error !== 'stopped' ? ' err' : ''}`;
      m.dataset.id = t.id;
      if (known.has(t.id) || t.id === 'live') m.style.animation = 'none';
      m.textContent = t.text || (t.error ? t.error : '');
      return m;
    }),
  );
  // waiting for the first words of a reply
  if ((s.phase === 'thinking' || s.phase === 'transcribing') && s.turns[s.turns.length - 1]?.role === 'user') {
    const p = document.createElement('div');
    p.className = 'msg assistant pending';
    p.setAttribute('aria-label', 'thinking');
    p.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    el.msgs.append(p);
  }
  if (atBottom || !known.size) el.msgs.scrollTop = el.msgs.scrollHeight;
}

/** busy: a stop button (agent runs: pause + stop; paused: continue + stop) */
let ctlKey = '';
function renderControls(s: NotchState): void {
  const mode = s.busy ?? null;
  const key = `${mode}|${s.stopLabel}`;
  el.ctl.hidden = !mode;
  if (key === ctlKey) return;
  ctlKey = key;
  if (!mode) return el.ctl.replaceChildren();
  const btn = (label: string, a: 'stop' | 'pause' | 'continue', title: string, primary = false): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.ctl = a;
    b.title = title;
    if (primary) b.className = 'primary';
    if (a === 'stop') {
      const sq = document.createElement('span');
      sq.className = 'sq';
      sq.setAttribute('aria-hidden', 'true');
      b.append(sq);
    }
    b.append(label);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      api.action(a);
    });
    return b;
  };
  const k = s.stopLabel || 'esc';
  const stop = btn('stop', 'stop', mode === 'pause' ? 'stop the agent run' : `stop (${k})`);
  if (mode === 'paused') el.ctl.replaceChildren(btn('continue', 'continue', 'continue (enter)', true), stop);
  else if (mode === 'pause') el.ctl.replaceChildren(btn('pause', 'pause', `pause after this action (${k})`), stop);
  else el.ctl.replaceChildren(stop);
}

api.onState((s) => {
  state = s;
  render();
});
api.ready();
