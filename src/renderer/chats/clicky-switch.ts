// Chats window: the active clicky in the sidebar header, with a dropdown to switch clickys,
// show every clicky's chats ("all clickys") or manage them in settings.
import type { ChatSummary, Settings } from '../../shared/types';
import type { ChatsApi } from '../../shared/ipc';
import { h, icon, markSvg } from './dom';

const DEFAULT_ID = 'clickity';

export interface ClickySwitch {
  /** settings arrived / changed */
  sync(s: Settings | null): void;
  /** this chat shows in the list (its clicky is active, or "all clickys") */
  matches(c: ChatSummary): boolean;
  /** a small mark before the title when the list shows every clicky's chats */
  rowMark(c: ChatSummary): HTMLElement | null;
  showingAll(): boolean;
  close(): boolean;
  contains(n: Node): boolean;
}

/** an ink (unset) or very dark clicky is drawn light on the black window */
function markColor(c: string | undefined): string {
  if (!c) return '#f2f2f4';
  const n = parseInt(c.slice(1), 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum < 40 ? '#f2f2f4' : c;
}

export function initClickySwitch(opts: {
  host: HTMLElement;
  api: ChatsApi;
  onFilter(): void;
  place(pop: HTMLElement, anchor: HTMLElement, align: 'left' | 'right'): void;
  onError(msg: string): void;
}): ClickySwitch {
  let settings: Settings | null = null;
  let all = false;

  const mark = markSvg(18);
  const name = h('span', { class: 'wordmark', text: 'clickity' });
  const btn = h('button', { class: 'logo clicky-switch', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'switch clicky' }, mark, name, icon('chevronDown', 'ic chev'));
  const scope = h('span', { class: 'clicky-scope', text: 'all clickys', hidden: true });
  opts.host.append(btn, scope);
  const pop = h('div', { class: 'popover clicky-pop', role: 'menu', 'aria-label': 'clickys', hidden: true });
  document.body.append(pop);

  const close = (): boolean => {
    if (pop.hidden) return false;
    pop.classList.remove('open');
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    return true;
  };

  const item = (label: Node[], selected: boolean, onPick: () => void, cls = ''): HTMLButtonElement => {
    const b = h('button', { class: `pop-item ${cls}${selected ? ' sel' : ''}`, type: 'button', role: 'menuitemradio', 'aria-checked': String(selected) }, ...label, selected ? icon('check', 'ic check') : null);
    b.addEventListener('click', onPick);
    return b;
  };

  function render(): void {
    const s = settings;
    if (!s) return;
    const active = s.clickys.find((c) => c.id === s.activeClicky) ?? s.clickys[0];
    const nodes: Node[] = [h('div', { class: 'pop-head', text: 'talk to' })];
    for (const c of s.clickys) {
      const m = markSvg(16);
      m.style.color = markColor(c.color);
      nodes.push(
        item([m, h('span', { class: 'pop-text' }, h('span', { text: c.name }), c.persona.trim() ? h('span', { class: 'pop-sub', text: c.persona.trim().replace(/\s+/g, ' ').slice(0, 60) }) : null)], c.id === active?.id, () => {
          close();
          if (c.id === s.activeClicky) return;
          all = false;
          void opts.api.setSettings({ activeClicky: c.id }).catch((err) => opts.onError(String(err?.message ?? err).toLowerCase()));
        }),
      );
    }
    nodes.push(h('div', { class: 'pop-sep' }));
    nodes.push(
      item([icon('list'), h('span', { class: 'pop-text' }, h('span', { text: 'show all clickys’ chats' }))], all, () => {
        close();
        all = !all;
        syncHeader();
        opts.onFilter();
      }),
      item([icon('settings'), h('span', { class: 'pop-text' }, h('span', { text: 'manage clickys…' }))], false, () => {
        close();
        void opts.api.openSettings('clickys');
      }),
    );
    pop.replaceChildren(...nodes);
  }

  function syncHeader(): void {
    const s = settings;
    const active = s ? (s.clickys.find((c) => c.id === s.activeClicky) ?? s.clickys[0]) : null;
    name.textContent = active?.name ?? 'clickity';
    mark.style.color = markColor(active?.color);
    btn.setAttribute('aria-label', `talking to ${active?.name ?? 'clickity'} — switch clicky`);
    scope.hidden = !all;
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (close()) return;
    render();
    opts.place(pop, btn, 'left');
    btn.setAttribute('aria-expanded', 'true');
    (pop.querySelector('.pop-item.sel') as HTMLElement | null)?.focus();
  });

  return {
    sync(s) {
      settings = s;
      syncHeader();
      if (!pop.hidden) render();
    },
    matches(c) {
      if (all || !settings) return true;
      return (c.clickyId || DEFAULT_ID) === settings.activeClicky;
    },
    rowMark(c) {
      if (!all || !settings || settings.clickys.length < 2) return null;
      const cl = settings.clickys.find((x) => x.id === (c.clickyId || DEFAULT_ID));
      const m = markSvg(12);
      m.classList.add('row-mark');
      m.style.color = markColor(cl?.color);
      m.setAttribute('aria-label', cl?.name ?? 'deleted clicky');
      const wrap = h('span', { class: 'row-mark-wrap', title: cl?.name ?? 'deleted clicky' });
      wrap.append(m);
      return wrap;
    },
    showingAll: () => all,
    close,
    contains: (n) => pop.contains(n) || btn.contains(n),
  };
}
