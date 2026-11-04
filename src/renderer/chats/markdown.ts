// Minimal, safe markdown → DOM. Builds nodes directly (no innerHTML with untrusted text).

function inline(parent: HTMLElement, text: string): void {
  // tokens: `code`, **bold**, *italic*
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\*[^*\s][^*\n]*?\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const tok = m[0];
    if (m[1]) {
      const c = document.createElement('code');
      c.textContent = tok.slice(1, -1);
      parent.append(c);
    } else if (m[2]) {
      const b = document.createElement('strong');
      inline(b, tok.slice(2, -2));
      parent.append(b);
    } else {
      const i = document.createElement('em');
      inline(i, tok.slice(1, -1));
      parent.append(i);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function appendLines(parent: HTMLElement, lines: string[]): void {
  lines.forEach((l, i) => {
    if (i) parent.append(document.createElement('br'));
    inline(parent, l);
  });
}

/** Render markdown-ish text into a fragment. Unclosed code fences (while streaming) render as code. */
export function renderMarkdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or past end)
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (fence[1]) pre.dataset.lang = fence[1];
      code.textContent = body.join('\n');
      pre.append(code);
      frag.append(pre);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const el = document.createElement('p');
      el.className = 'md-h';
      inline(el, heading[2]);
      frag.append(el);
      i++;
      continue;
    }
    const isUl = (l: string) => /^\s*[-*•]\s+/.test(l);
    const isOl = (l: string) => /^\s*\d+[.)]\s+/.test(l);
    if (isUl(line) || isOl(line)) {
      const ordered = isOl(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      const start = ordered ? parseInt(/^\s*(\d+)/.exec(line)![1], 10) : 1;
      if (start !== 1) (list as HTMLOListElement).start = start;
      while (i < lines.length && (ordered ? isOl(lines[i]) : isUl(lines[i]))) {
        const li = document.createElement('li');
        inline(li, lines[i].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/, ''));
        list.append(li);
        i++;
      }
      frag.append(list);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !isUl(lines[i]) && !isOl(lines[i])) {
      para.push(lines[i++]);
    }
    const p = document.createElement('p');
    appendLines(p, para);
    frag.append(p);
  }
  return frag;
}
