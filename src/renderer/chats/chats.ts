// Chats window: history sidebar, transcript and the glass composer. Talks to main only via window.chats.
import {
  PROVIDER_KINDS,
  PROVIDER_META,
  type Chat,
  type ChatAttachment,
  type ChatEvent,
  type ChatSummary,
  type ChatTurn,
  type ModelInfo,
  type ProviderGroup,
  type ProviderKind,
  type Settings,
} from '../../shared/types';
import { $, h, icon, logo, markSvg, type IconName } from './dom';
import { renderMarkdown } from './markdown';
import { GROUPS, clock, groupOf, relTime } from './time';
import { clickTicks, enterEmptyState, enterList, enterMessage, openPopover, pressSend } from './motion';

const api = window.chats;
const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
const narrowMq = matchMedia('(max-width: 819px)');
const MOD = isMac ? '⌘' : 'ctrl';

/* ───────────── state ───────────── */

let settings: Settings | null = null;
let list: ChatSummary[] = [];
let chat: Chat | null = null; // the chat shown in the main area
let query = '';
let includeScreen = true;
let attachments: ChatAttachment[] = [];
/** turnIds currently streaming, by chatId */
const streaming = new Map<string, string>();
/** waiting for send() to tell us which chat a new conversation landed in */
let awaitingNewChat = false;
let modelCache = new Map<ProviderKind, ModelInfo[]>();

/* ───────────── elements ───────────── */

const el = {
  main: $('main'),
  turns: $('turns'),
  thread: $('thread'),
  input: $<HTMLTextAreaElement>('input'),
  composer: $<HTMLFormElement>('composer'),
  send: $<HTMLButtonElement>('send'),
  chips: $('chips'),
  modelBtn: $<HTMLButtonElement>('model-btn'),
  modelPop: $('model-pop'),
  rowMenu: $('row-menu'),
  attachBtn: $<HTMLButtonElement>('attach-btn'),
  file: $<HTMLInputElement>('file'),
  attachments: $('attachments'),
  list: $('chat-list'),
  search: $<HTMLInputElement>('search'),
  newPill: $<HTMLButtonElement>('new-pill'),
  live: $('live'),
  title: $('chat-title'),
  scrim: $('scrim'),
};

/* ───────────── static chrome ───────────── */

document.documentElement.classList.toggle('mac', isMac);
$('side-brand').append(logo());
$('toggle-side').append(icon('sidebar'));
$('new-chat-mini').append(icon('edit'));
$('new-chat').querySelector('.new-chat-label')!.append(icon('edit'), h('span', { text: 'new chat' }));
$('new-chat-kbd').append(h('kbd', { text: MOD }), h('kbd', { text: 'N' }));
$('search-ic').append(icon('search'));
$('open-settings').append(icon('settings'), h('span', { text: 'settings' }));
el.attachBtn.append(icon('paperclip'));
el.newPill.append(icon('arrowDown', 'ic sm'), h('span', { text: 'new message' }));

/* ───────────── composer: chips ───────────── */

interface Mode {
  id: string;
  label: string;
  icon: IconName;
  prefix?: string;
}
const MODES: Mode[] = [
  { id: 'screen', label: 'screen', icon: 'monitor' },
  { id: 'explain', label: 'explain', icon: 'sparkles', prefix: 'explain ' },
  { id: 'how', label: 'how do i…', icon: 'help', prefix: 'how do i ' },
  { id: 'summarize', label: 'summarize', icon: 'list', prefix: 'summarize ' },
];
const chipEls = new Map<string, HTMLButtonElement>();
for (const m of MODES) {
  const b = h('button', { class: 'chip', type: 'button', 'data-mode': m.id, 'aria-pressed': 'false' }, icon(m.icon), h('span', { text: m.label }));
  b.addEventListener('click', () => onChip(m));
  chipEls.set(m.id, b);
  el.chips.append(b);
}

function activePrefixMode(): Mode | undefined {
  const t = el.input.value.toLowerCase();
  return MODES.find((m) => m.prefix && t.startsWith(m.prefix.trimEnd()));
}

function onChip(m: Mode): void {
  if (m.id === 'screen') {
    includeScreen = !includeScreen;
  } else {
    const cur = activePrefixMode();
    let text = el.input.value;
    if (cur) text = text.slice(cur.prefix!.trimEnd().length).replace(/^\s+/, '');
    if (cur?.id !== m.id) text = m.prefix! + text;
    el.input.value = text;
    el.input.focus();
    el.input.setSelectionRange(text.length, text.length);
  }
  syncComposer();
}

/* ───────────── composer: placeholder, autosize, send state ───────────── */

const EXAMPLES = [
  "explain what's on my screen…",
  'how do i export this as a pdf?',
  "where's the dark mode setting?",
  'what does this error mean?',
  'summarize this page for me',
];
let exIdx = 0;
setInterval(() => {
  if (el.input.value || document.hidden) return;
  exIdx = (exIdx + 1) % EXAMPLES.length;
  el.input.placeholder = EXAMPLES[exIdx];
}, 4200);

function autosize(): void {
  el.input.style.height = 'auto';
  const max = el.main.dataset.mode === 'empty' ? 260 : 200;
  el.input.style.height = Math.min(el.input.scrollHeight, max) + 'px';
  el.input.style.overflowY = el.input.scrollHeight > max ? 'auto' : 'hidden';
}

function isStreamingHere(): boolean {
  return !!chat && streaming.has(chat.id);
}

function syncComposer(): void {
  const screenChip = chipEls.get('screen')!;
  screenChip.classList.toggle('on', includeScreen);
  screenChip.setAttribute('aria-pressed', String(includeScreen));
  const pm = activePrefixMode();
  for (const m of MODES) {
    if (m.id === 'screen') continue;
    const on = pm?.id === m.id;
    chipEls.get(m.id)!.classList.toggle('on', on);
    chipEls.get(m.id)!.setAttribute('aria-pressed', String(on));
  }
  const busy = isStreamingHere();
  el.send.replaceChildren(icon(busy ? 'stop' : 'arrowUp'));
  el.send.classList.toggle('stop', busy);
  el.send.setAttribute('aria-label', busy ? 'stop' : 'send');
  el.send.disabled = !busy && !el.input.value.trim() && attachments.length === 0;
  autosize();
}

el.input.addEventListener('input', syncComposer);
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.altKey) {
    e.preventDefault();
    if (!isStreamingHere()) void submit();
  }
});
el.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  if (isStreamingHere()) stopReply();
  else void submit();
});

function stopReply(): void {
  if (chat) void api.stop(chat.id).catch(() => {});
}

async function submit(): Promise<void> {
  const text = el.input.value.trim();
  if (!text && attachments.length === 0) return;
  const sentAttachments = attachments;
  const prevText = el.input.value;
  el.input.value = '';
  attachments = [];
  renderAttachments();
  syncComposer();
  pressSend(el.send);
  const chatId = chat && chat.id ? chat.id : null;
  if (!chatId) awaitingNewChat = true;
  stick = true; // our own message: follow the reply down
  el.newPill.hidden = true;
  try {
    const res = await api.send({ chatId, text, includeScreen, attachments: sentAttachments.length ? sentAttachments : undefined });
    awaitingNewChat = false;
    // a new chat that nothing is showing yet: open it. If the user has moved on meanwhile, leave their view alone.
    if (!chatId && !chat) {
      const fresh = await api.get(res.chatId);
      if (fresh) showChat(mergeChat(fresh));
    }
  } catch (err) {
    awaitingNewChat = false;
    el.input.value = prevText;
    attachments = sentAttachments;
    renderAttachments();
    syncComposer();
    toast(errMsg(err));
  }
}

function errMsg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).toLowerCase();
}

/* ───────────── composer: attachments ───────────── */

const MAX_FILE = 12 * 1024 * 1024;
el.attachBtn.addEventListener('click', () => el.file.click());
el.file.addEventListener('change', () => {
  if (el.file.files) void addFiles([...el.file.files]);
  el.file.value = '';
});
el.input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) {
    e.preventDefault();
    void addFiles(files);
  }
});
el.composer.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) {
    e.preventDefault();
    el.composer.classList.add('drop');
  }
});
el.composer.addEventListener('dragleave', () => el.composer.classList.remove('drop'));
el.composer.addEventListener('drop', (e) => {
  el.composer.classList.remove('drop');
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) {
    e.preventDefault();
    void addFiles(files);
  }
});
// elsewhere a dropped file must not navigate the window away
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

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
  return ext === 'json' ? 'application/json' : ext === 'csv' ? 'text/csv' : ext === 'md' ? 'text/markdown' : 'text/plain';
}

async function addFiles(files: File[]): Promise<void> {
  for (const f of files) {
    const mime = mimeOf(f);
    const ok = mime.startsWith('image/') || mime.startsWith('text/') || mime === 'application/json' || /\.(txt|md|json|csv|log)$/i.test(f.name);
    if (!ok) {
      toast(`can't attach ${f.name.toLowerCase()}`);
      continue;
    }
    if (f.size > MAX_FILE) {
      toast(`${f.name.toLowerCase()} is too large`);
      continue;
    }
    try {
      attachments.push({ name: f.name, mime, base64: await readBase64(f) });
    } catch {
      toast(`couldn't read ${f.name.toLowerCase()}`);
    }
  }
  renderAttachments();
  syncComposer();
  el.input.focus();
}

function renderAttachments(): void {
  el.attachments.replaceChildren(
    ...attachments.map((a, i) => {
      const isImg = a.mime.startsWith('image/');
      const thumb = isImg
        ? h('img', { class: 'att-thumb', src: `data:${a.mime};base64,${a.base64}`, alt: '' })
        : h('span', { class: 'att-thumb file' }, icon('file'));
      const rm = h('button', { class: 'att-x', type: 'button', 'aria-label': `remove ${a.name}` }, icon('x', 'ic xs'));
      rm.addEventListener('click', () => {
        attachments.splice(i, 1);
        renderAttachments();
        syncComposer();
      });
      return h('div', { class: 'att' + (isImg ? ' img' : '') }, thumb, h('span', { class: 'att-name', text: a.name, title: a.name }), rm);
    }),
  );
  el.attachments.hidden = attachments.length === 0;
}

/* ───────────── model picker ───────────── */

const GROUP_LABEL: Record<ProviderGroup, string> = { subscription: 'subscriptions', api: 'api keys', local: 'local' };

async function modelsFor(kind: ProviderKind): Promise<ModelInfo[]> {
  const hit = modelCache.get(kind);
  if (hit) return hit;
  try {
    const ms = await api.providerModels(kind);
    modelCache.set(kind, ms);
    return ms;
  } catch {
    return [];
  }
}

function currentModelId(s: Settings): string {
  return s.models[s.provider] || PROVIDER_META[s.provider].defaultModel;
}

async function syncModelButton(): Promise<void> {
  if (!settings) return;
  const s = settings;
  const id = currentModelId(s);
  const ms = await modelsFor(s.provider);
  const label = ms.find((m) => m.id === id)?.label || id;
  el.modelBtn.replaceChildren(icon('zap'), h('span', { class: 'model-label', text: label.toLowerCase() }), icon('chevronDown', 'ic chev'));
  el.modelBtn.title = `${PROVIDER_META[s.provider].label} · ${id}`;
}

function menuItem(text: string, sub: string | null, selected: boolean, onPick: () => void, ic?: IconName): HTMLButtonElement {
  const b = h(
    'button',
    { class: 'pop-item' + (selected ? ' sel' : ''), type: 'button', role: 'menuitemradio', 'aria-checked': String(selected) },
    ic ? icon(ic) : null,
    h('span', { class: 'pop-text' }, h('span', { text }), sub ? h('span', { class: 'pop-sub', text: sub }) : null),
    selected ? icon('check', 'ic check') : null,
  );
  b.addEventListener('click', onPick);
  return b;
}

async function renderModelPop(): Promise<void> {
  if (!settings) return;
  const s = settings;
  const kind = s.provider;
  const ms = await modelsFor(kind);
  const cur = currentModelId(s);
  const models = ms.length ? ms : [{ id: cur } as ModelInfo];
  if (!models.some((m) => m.id === cur)) models.unshift({ id: cur });
  const frag: Node[] = [h('div', { class: 'pop-head', text: `model · ${PROVIDER_META[kind].label}` })];
  const box = h('div', { class: 'pop-scroll' });
  for (const m of models) {
    box.append(
      menuItem((m.label || m.id).toLowerCase(), m.label && m.label.toLowerCase() !== m.id.toLowerCase() ? m.id : null, m.id === cur, () => {
        closePopovers();
        void save({ models: { [kind]: m.id } as Settings['models'] });
      }),
    );
  }
  frag.push(box, h('div', { class: 'pop-sep' }));
  for (const g of ['subscription', 'api', 'local'] as ProviderGroup[]) {
    const kinds = PROVIDER_KINDS.filter((k) => PROVIDER_META[k].group === g);
    frag.push(h('div', { class: 'pop-head', text: GROUP_LABEL[g] }));
    for (const k of kinds) {
      frag.push(
        menuItem(PROVIDER_META[k].label, null, k === kind, () => {
          if (k === kind) return;
          void save({ provider: k }).then(() => renderModelPop());
        }, g === 'subscription' ? 'cloud' : g === 'api' ? 'key' : 'cpu'),
      );
    }
  }
  el.modelPop.replaceChildren(...frag);
}

async function save(patch: Parameters<typeof api.setSettings>[0]): Promise<void> {
  try {
    settings = await api.setSettings(patch);
    await syncModelButton();
  } catch (err) {
    toast(errMsg(err));
  }
}

function placePopover(pop: HTMLElement, anchor: HTMLElement, align: 'left' | 'right' = 'right'): void {
  pop.hidden = false;
  openPopover(pop);
  pop.style.maxHeight = '';
  const r = anchor.getBoundingClientRect();
  const ph = pop.offsetHeight;
  const pw = pop.offsetWidth;
  const below = window.innerHeight - r.bottom - 12;
  const above = r.top - 52;
  const down = below >= Math.min(ph, 320) || below > above;
  const avail = down ? below : above;
  if (ph > avail) pop.style.maxHeight = avail + 'px';
  const top = down ? r.bottom + 8 : r.top - 8 - Math.min(ph, avail);
  let left = align === 'right' ? r.right - pw : r.left;
  left = Math.max(12, Math.min(left, window.innerWidth - pw - 12));
  pop.style.top = top + 'px';
  pop.style.left = left + 'px';
  pop.dataset.dir = down ? 'down' : 'up';
  requestAnimationFrame(() => pop.classList.add('open'));
}

function closePopovers(): boolean {
  let closed = false;
  for (const p of [el.modelPop, el.rowMenu]) {
    if (!p.hidden) {
      closed = true;
      p.classList.remove('open');
      p.hidden = true;
    }
  }
  el.modelBtn.setAttribute('aria-expanded', 'false');
  document.querySelectorAll('.row.menu-open').forEach((r) => r.classList.remove('menu-open'));
  return closed;
}

el.modelBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!el.modelPop.hidden) return void closePopovers();
  closePopovers();
  await renderModelPop();
  placePopover(el.modelPop, el.modelBtn);
  el.modelBtn.setAttribute('aria-expanded', 'true');
  (el.modelPop.querySelector('.pop-item.sel') as HTMLElement | null)?.focus();
});
document.addEventListener('mousedown', (e) => {
  const t = e.target as Node;
  const onMore = t instanceof Element && !!t.closest('.row-more');
  if (!el.modelPop.contains(t) && !el.rowMenu.contains(t) && !el.modelBtn.contains(t) && !onMore) closePopovers();
});
window.addEventListener('resize', () => closePopovers());

/* ───────────── sidebar ───────────── */

let renaming: string | null = null;
let renameDraft: string | null = null;
let renameFresh = false;
let confirmingDelete: string | null = null;
let confirmFocus = false;

function renderList(): void {
  const q = query.trim().toLowerCase();
  const items = list.filter((c) => !q || c.title.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q));
  const nodes: Node[] = [];
  const now = Date.now();
  for (const g of GROUPS) {
    const rows = items.filter((c) => groupOf(c.updatedAt, now) === g);
    if (!rows.length) continue;
    nodes.push(h('div', { class: 'group-label', text: g }));
    for (const c of rows) nodes.push(renderRow(c, now));
  }
  if (!nodes.length) {
    nodes.push(h('p', { class: 'list-empty', text: q ? 'no chats match' : 'no chats yet. ask something to start one.' }));
  }
  el.list.replaceChildren(...nodes);
}

function renderRow(c: ChatSummary, now: number): HTMLElement {
  const active = chat?.id === c.id;
  const row = h('div', { class: 'row' + (active ? ' active' : ''), 'data-id': c.id });
  if (renaming === c.id) {
    const inp = h('input', { class: 'rename', value: renameDraft ?? c.title, 'aria-label': 'chat title', maxlength: 120 });
    let done = false;
    const fresh = renameFresh;
    renameFresh = false;
    inp.addEventListener('input', () => (renameDraft = inp.value));
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      renaming = null;
      renameDraft = null;
      const t = inp.value.trim();
      if (commit && t && t !== c.title) {
        c.title = t;
        if (chat?.id === c.id) {
          chat.title = t;
          syncTitle();
        }
        void api.rename(c.id, t).catch((err) => toast(errMsg(err)));
      }
      renderList();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    });
    // a re-render removes the focused input; that is not the user leaving it
    inp.addEventListener('blur', () => {
      if (inp.isConnected) finish(true);
    });
    row.append(inp);
    requestAnimationFrame(() => {
      inp.focus();
      if (fresh) inp.select();
      else inp.setSelectionRange(inp.value.length, inp.value.length);
    });
    return row;
  }
  if (confirmingDelete === c.id) {
    const yes = h('button', { class: 'confirm-yes', type: 'button', text: 'yes' });
    const no = h('button', { class: 'confirm-no', type: 'button', text: 'cancel' });
    yes.addEventListener('click', () => void deleteChat(c.id));
    no.addEventListener('click', () => {
      confirmingDelete = null;
      renderList();
    });
    row.classList.add('confirming');
    row.append(h('span', { class: 'confirm-q', text: 'delete?' }), h('span', { class: 'confirm-actions' }, no, yes));
    if (confirmFocus) {
      confirmFocus = false;
      requestAnimationFrame(() => yes.focus());
    }
    return row;
  }
  const open = h(
    'button',
    { class: 'row-main', type: 'button', 'aria-current': active ? 'true' : undefined, title: c.title || 'new chat' },
    h('span', { class: 'row-title', text: c.title || 'new chat' }),
    streaming.has(c.id)
      ? h('span', { class: 'row-live', 'aria-label': 'replying', title: 'replying' })
      : h('span', { class: 'row-time', text: relTime(c.updatedAt, now) }),
  );
  open.addEventListener('click', () => void openChat(c.id));
  const more = h('button', { class: 'row-more', type: 'button', 'aria-label': `options for ${c.title || 'chat'}`, 'aria-haspopup': 'menu' }, icon('more'));
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = row.classList.contains('menu-open');
    closePopovers();
    if (wasOpen) return;
    row.classList.add('menu-open');
    const rn = h('button', { class: 'pop-item', type: 'button', role: 'menuitem' }, icon('edit'), h('span', { text: 'rename' }));
    const del = h('button', { class: 'pop-item danger', type: 'button', role: 'menuitem' }, icon('x'), h('span', { text: 'delete' }));
    rn.addEventListener('click', () => {
      closePopovers();
      renaming = c.id;
      renameDraft = null;
      renameFresh = true;
      renderList();
    });
    del.addEventListener('click', () => {
      closePopovers();
      confirmingDelete = c.id;
      confirmFocus = true;
      renderList();
    });
    el.rowMenu.replaceChildren(rn, del);
    placePopover(el.rowMenu, more, 'left');
    rn.focus();
  });
  row.append(open, more);
  return row;
}

async function deleteChat(id: string): Promise<void> {
  confirmingDelete = null;
  try {
    await api.remove(id);
  } catch (err) {
    toast(errMsg(err));
  }
  streaming.delete(id);
  liveTurns.delete(id);
  list = list.filter((c) => c.id !== id);
  if (chat?.id === id) showChat(null);
  renderList();
}

el.search.addEventListener('input', () => {
  query = el.search.value;
  renderList();
});
el.search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && el.search.value) {
    e.stopPropagation();
    el.search.value = '';
    query = '';
    renderList();
  }
});

function toggleSidebar(force?: boolean): void {
  const b = document.body;
  if (narrowMq.matches) {
    const open = force ?? !b.classList.contains('side-open');
    b.classList.toggle('side-open', open);
  } else {
    const collapsed = force === undefined ? !b.classList.contains('side-collapsed') : !force;
    b.classList.toggle('side-collapsed', collapsed);
    try {
      localStorage.setItem('chats.sideCollapsed', collapsed ? '1' : '0');
    } catch {}
  }
}
try {
  if (localStorage.getItem('chats.sideCollapsed') === '1') document.body.classList.add('side-collapsed');
} catch {}
narrowMq.addEventListener('change', () => document.body.classList.remove('side-open'));
$('toggle-side').addEventListener('click', () => toggleSidebar());
el.scrim.addEventListener('click', () => toggleSidebar(false));
$('new-chat').addEventListener('click', () => void newChat());
$('new-chat-mini').addEventListener('click', () => void newChat());
$('open-settings').addEventListener('click', () => void api.openSettings());
// always-visible way back to settings, even with the sidebar hidden
$('top-settings').append(icon('settings', 'ic sm'), h('span', { text: 'settings' }));
$('top-settings').addEventListener('click', () => void api.openSettings());

/* ───────────── chats ───────────── */

async function refreshList(): Promise<void> {
  try {
    list = await api.list();
  } catch {
    list = [];
  }
  renderList();
}

async function openChat(id: string): Promise<void> {
  if (narrowMq.matches) toggleSidebar(false);
  if (chat?.id === id) return void el.input.focus();
  try {
    await api.open(id);
    const c = await api.get(id);
    showChat(c ? mergeChat(c) : null);
  } catch (err) {
    toast(errMsg(err));
  }
  el.input.focus();
}

async function newChat(): Promise<void> {
  if (narrowMq.matches) toggleSidebar(false);
  if (chat && chat.turns.length === 0) return void el.input.focus();
  try {
    const c = await api.create();
    showChat(c);
    await refreshList();
  } catch (err) {
    toast(errMsg(err));
  }
  el.input.focus();
}

/** the reply currently streaming in each chat, kept whether or not that chat is on screen */
const liveTurns = new Map<string, ChatTurn>();

/** keep a reply that is streaming but not yet stored when its chat is reopened */
function mergeChat(c: Chat): Chat {
  const live = liveTurns.get(c.id);
  if (live && !c.turns.some((t) => t.id === live.id)) c.turns.push({ ...live });
  return c;
}

function syncTitle(): void {
  const t = chat && chat.turns.length ? chat.title : '';
  el.title.textContent = t;
  document.title = t ? `${t} · clickity` : 'clickity';
}

function showChat(c: Chat | null): void {
  chat = c;
  const empty = !c || c.turns.length === 0;
  const wasEmpty = el.main.dataset.mode === 'empty';
  el.main.dataset.mode = empty ? 'empty' : 'thread';
  if (empty && !wasEmpty) enterEmptyState([$('greeting'), $('composer'), $('hint')]);
  const liveId = c ? streaming.get(c.id) : undefined;
  el.turns.replaceChildren(...(c ? c.turns.map((t) => renderTurn(t, false, t.id === liveId)) : []));
  turnEls.clear();
  el.turns.querySelectorAll<HTMLElement>('.msg').forEach((n) => turnEls.set(n.dataset.id!, n));
  syncTitle();
  syncComposer();
  renderList();
  stick = true;
  el.newPill.hidden = true;
  requestAnimationFrame(() => (el.thread.scrollTop = el.thread.scrollHeight));
}

/* ───────────── transcript ───────────── */

const turnEls = new Map<string, HTMLElement>();

function metaFor(t: ChatTurn): string[] {
  const bits: string[] = [];
  if (t.role === 'user') {
    if (t.source === 'voice') bits.push('voice');
    else if (t.source === 'type') bits.push('typed');
    if (t.screenshots) bits.push(`${t.screenshots} screen${t.screenshots === 1 ? '' : 's'}`);
    if (t.attachments?.length) bits.push(`${t.attachments.length} file${t.attachments.length === 1 ? '' : 's'}`);
  } else {
    if (t.provider) bits.push(PROVIDER_META[t.provider]?.label ?? t.provider);
    if (t.model) bits.push(t.model.toLowerCase());
    if (t.points?.length) bits.push(`pointed at: ${t.points.join(', ').toLowerCase()}`);
  }
  if (t.at) bits.push(clock(t.at));
  return bits;
}

function renderTurn(t: ChatTurn, animate: boolean, streamingNow = false): HTMLElement {
  const node = h('article', { class: `msg ${t.role}` + (animate ? ' rise' : ''), 'data-id': t.id });
  if (t.role === 'user') {
    const bubble = h('div', { class: 'bubble' });
    bubble.textContent = t.text;
    if (t.attachments?.length) {
      bubble.append(
        h('div', { class: 'msg-atts' }, ...t.attachments.map((n) => h('span', { class: 'msg-att' }, icon('paperclip', 'ic xs'), h('span', { text: n })))),
      );
    }
    node.append(bubble);
  } else {
    node.append(h('div', { class: 'avatar' }, markSvg(12)));
    const col = h('div', { class: 'col' });
    const body = h('div', { class: 'body' });
    col.append(body);
    node.append(col);
    fillAssistant(node, t, streamingNow);
  }
  const bits = metaFor(t);
  if (bits.length && !streamingNow) appendMeta(node, bits);
  return node;
}

function appendMeta(node: HTMLElement, bits: string[]): void {
  const target = node.querySelector('.col') ?? node;
  target.querySelector('.meta')?.remove();
  target.append(h('div', { class: 'meta', text: bits.join(' · ') }));
}

function fillAssistant(node: HTMLElement, t: ChatTurn, streamingNow: boolean): void {
  const body = node.querySelector('.body') as HTMLElement;
  const frag = renderMarkdown(t.text);
  body.replaceChildren(frag);
  body.classList.toggle('streaming', streamingNow);
  if (streamingNow) {
    const caret = h('span', { class: 'caret', 'aria-hidden': 'true' });
    const lastBlock = body.lastElementChild;
    if (lastBlock && lastBlock.tagName !== 'PRE') (lastBlock.tagName === 'UL' || lastBlock.tagName === 'OL' ? lastBlock.lastElementChild ?? lastBlock : lastBlock).append(caret);
    else body.append(h('p', {}, caret));
  }
  node.querySelector('.err')?.remove();
  if (t.error) body.after(h('div', { class: 'err', text: t.error.toLowerCase() }));
}

let stick = true;
el.thread.addEventListener('scroll', () => {
  const gap = el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight;
  stick = gap < 80;
  if (stick) el.newPill.hidden = true;
});
el.newPill.addEventListener('click', () => {
  el.thread.scrollTo({ top: el.thread.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.newPill.hidden = true;
});
function afterGrow(newMessage: boolean): void {
  if (stick) el.thread.scrollTop = el.thread.scrollHeight;
  else if (newMessage) el.newPill.hidden = false;
}

function ensureThreadMode(): void {
  if (el.main.dataset.mode !== 'thread') {
    el.main.dataset.mode = 'thread';
    syncTitle();
    autosize();
  }
}

function upsertTurn(t: ChatTurn, streamingNow: boolean): void {
  if (!chat) return;
  const i = chat.turns.findIndex((x) => x.id === t.id);
  const isNew = i < 0;
  if (isNew) chat.turns.push(t);
  else chat.turns[i] = t;
  ensureThreadMode();
  const existing = turnEls.get(t.id);
  if (existing && !isNew) {
    if (t.role === 'assistant') {
      fillAssistant(existing, t, streamingNow);
      if (!streamingNow) appendMeta(existing, metaFor(t));
      else existing.querySelector('.meta')?.remove();
    } else {
      const n = renderTurn(t, false);
      existing.replaceWith(n);
      turnEls.set(t.id, n);
    }
  } else {
    const n = renderTurn(t, true, streamingNow);
    el.turns.append(n);
    turnEls.set(t.id, n);
    enterMessage(n);
    // signature: the mark "clicks" as clickity starts to answer
    if (t.role === 'assistant' && streamingNow) {
      clickTicks(n.querySelector('.avatar svg'));
      clickTicks(document.querySelector('#side-brand svg'));
    }
  }
  afterGrow(isNew);
}

function onEvent(e: ChatEvent): void {
  // a new chat started from this window, or a voice turn while nothing (or an empty chat) is shown → follow it
  if (e.type === 'user' && chat?.id !== e.chatId) {
    const adopt = !chat || (chat.turns.length === 0 && (awaitingNewChat || e.turn.source === 'voice'));
    if (adopt) {
      chat = { id: e.chatId, title: e.turn.text.slice(0, 80), createdAt: e.turn.at, updatedAt: e.turn.at, turns: [] };
      el.turns.replaceChildren();
      turnEls.clear();
    }
  }

  if (e.type === 'start') streaming.set(e.chatId, e.turnId);
  if (e.type === 'done' || e.type === 'error') streaming.delete(e.chatId);
  if (e.type === 'start') liveTurns.set(e.chatId, { id: e.turnId, role: 'assistant', text: '', at: Date.now() });
  if (e.type === 'delta') liveTurns.set(e.chatId, { id: e.turnId, role: 'assistant', text: e.text, at: liveTurns.get(e.chatId)?.at ?? Date.now() });
  if (e.type === 'done' || e.type === 'error') liveTurns.delete(e.chatId);

  if (!chat || chat.id !== e.chatId) {
    renderList();
    return;
  }
  switch (e.type) {
    case 'user':
      upsertTurn(e.turn, false);
      break;
    case 'start':
      upsertTurn({ id: e.turnId, role: 'assistant', text: '', at: Date.now() }, true);
      break;
    case 'delta': {
      streaming.set(e.chatId, e.turnId);
      const prev = chat.turns.find((t) => t.id === e.turnId);
      upsertTurn({ ...(prev ?? { id: e.turnId, role: 'assistant', at: Date.now() }), text: e.text } as ChatTurn, true);
      break;
    }
    case 'done':
      upsertTurn(e.turn, false);
      announce('reply finished');
      break;
    case 'error': {
      const prev = chat.turns.find((t) => t.id === e.turnId);
      upsertTurn({ ...(prev ?? { id: e.turnId, role: 'assistant', text: '', at: Date.now() }), error: e.error } as ChatTurn, false);
      announce('reply failed');
      break;
    }
  }
  syncComposer();
  renderList();
}

function announce(msg: string): void {
  el.live.textContent = '';
  setTimeout(() => (el.live.textContent = msg), 30);
}

let toastTimer = 0;
function toast(msg: string): void {
  let t = document.getElementById('toast');
  if (!t) {
    t = h('div', { id: 'toast', class: 'toast', role: 'status' });
    document.body.append(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove('show'), 3200);
}

/* ───────────── keyboard ───────────── */

document.addEventListener('keydown', (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (e.key === 'Escape') {
    if (closePopovers()) return;
    if (confirmingDelete || renaming) {
      confirmingDelete = renaming = null;
      renderList();
      return;
    }
    if (document.body.classList.contains('side-open')) return toggleSidebar(false);
    if (isStreamingHere()) return stopReply();
    return;
  }
  if (!mod || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'n') {
    e.preventDefault();
    void newChat();
  } else if (k === 'k') {
    e.preventDefault();
    if (narrowMq.matches) toggleSidebar(true);
    else if (document.body.classList.contains('side-collapsed')) toggleSidebar(true);
    el.search.focus();
    el.search.select();
  } else if (k === 'b') {
    e.preventDefault();
    toggleSidebar();
  } else if (k === ',') {
    e.preventDefault();
    void api.openSettings();
  }
});

/* ───────────── boot ───────────── */

api.onEvent(onEvent);
api.onChanged((l) => {
  list = l;
  if (chat) {
    const s = l.find((c) => c.id === chat!.id);
    if (s && s.title !== chat.title) {
      chat.title = s.title;
      syncTitle();
    }
  }
  renderList();
});
api.onSettingsChanged((s) => {
  const providerChanged = settings?.provider !== s.provider;
  settings = s;
  if (providerChanged) modelCache.delete(s.provider);
  void syncModelButton();
});

async function boot(): Promise<void> {
  syncComposer();
  const [s, l, activeId] = await Promise.all([
    api.getSettings().catch(() => null),
    api.list().catch(() => [] as ChatSummary[]),
    api.active().catch(() => null),
  ]);
  settings = s;
  list = l;
  void syncModelButton();
  let c: Chat | null = null;
  if (activeId) c = await api.get(activeId).catch(() => null);
  showChat(c);
  el.input.focus();
  document.body.classList.add('ready');
  // first paint: list rows settle in; an empty window brings its composer in, then the mark clicks once
  enterList(document.querySelectorAll('#sidebar .row'));
  if (el.main.dataset.mode === 'empty') enterEmptyState([$('greeting'), $('composer'), $('hint')]);
  setTimeout(() => clickTicks(document.querySelector('#side-brand svg')), 500);
}
void boot();
