// Charts and function plots ([CHART:…]) as crisp inline SVG in the Opal style: monochrome ink with
// the first series as the one accent, hairline axes and grid, small lowercase tabular labels.
// Colors come from the host window's tokens through CSS (visuals.css), so light and dark both work.
// Hovering shows a quiet readout under the chart ("x 1.5 · y -0.75").
import type { ChartVisual } from '../../shared/visuals';
import { autoRange, formatNum, niceTicks, samplePlot } from '../../shared/charts';
import { parseExpr } from '../../shared/expr';

const NS = 'http://www.w3.org/2000/svg';
const W = 288;
const H = 172;

type Attrs = Record<string, string | number>;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

function tip(e: SVGElement, text: string): void {
  e.append(svg('title', {}, text));
}

const r1 = (n: number): string => n.toFixed(1);

const SUP: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻' };
/** "y = x^2 - 3*x" → "y = x² − 3·x" for labels (the stored expression stays as written). */
export function prettyMath(s: string): string {
  return s
    .replace(/\^\(?(-?\d{1,2})\)?/g, (_, d: string) => [...d].map((c) => SUP[c] ?? c).join(''))
    .replace(/\s\*\s|\*/g, (m) => (m.length > 1 ? ' · ' : '·'))
    .replace(/(\s)-(\s)/g, '$1−$2')
    .replace(/\bpi\b/g, 'π')
    .replace(/sqrt/g, '√');
}

interface Frame {
  x0: number;
  x1: number;
  y0: number; // bottom (svg y)
  y1: number; // top
}

/** room for the y tick labels on the left */
function frameFor(yTicks: number[], hasXLabel: boolean, hasYLabel: boolean, categories: boolean): Frame {
  const widest = Math.max(1, ...yTicks.map((t) => formatNum(t).length));
  return { x0: 8 + widest * 5.8, x1: W - 6, y0: H - (categories ? 18 : 16) - (hasXLabel ? 12 : 0), y1: hasYLabel ? 18 : 8 };
}

function yAxis(g: SVGGElement, f: Frame, ticks: number[], sy: (v: number) => number, label?: string): void {
  for (const t of ticks) {
    const y = sy(t);
    g.append(svg('line', { class: 'ch-grid', x1: f.x0, x2: f.x1, y1: r1(y), y2: r1(y) }));
    g.append(svg('text', { class: 'ch-tick', x: f.x0 - 6, y: r1(y + 3.2), 'text-anchor': 'end' }, formatNum(t)));
  }
  if (label) g.append(svg('text', { class: 'ch-axis-label', x: 2, y: 9 }, label.toLowerCase()));
}

function xLabel(g: SVGGElement, f: Frame, label?: string): void {
  if (label) g.append(svg('text', { class: 'ch-axis-label', x: f.x1, y: H - 2, 'text-anchor': 'end' }, label.toLowerCase()));
}

interface Readout {
  set(text: string): void;
}

/* ───────── line / bar (categories) ───────── */

function categoryChart(c: ChartVisual, g: SVGGElement, out: Readout, overlay: SVGRectElement): void {
  const labels = c.labels ?? [];
  const n = Math.max(labels.length, ...c.series.map((s) => s.values?.length ?? 0));
  const all = c.series.flatMap((s) => s.values ?? []);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (c.kind === 'bar' || lo > 0) lo = Math.min(0, lo); // bars (and positive lines) start at zero
  if (c.kind === 'bar') hi = Math.max(0, hi);
  if (hi === lo) hi = lo + 1;
  const ticks = niceTicks(lo, hi, 4);
  lo = Math.min(lo, ticks[0] ?? lo);
  hi = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  const f = frameFor(ticks, !!c.x, !!c.y, true);
  const sy = (v: number): number => f.y0 - ((v - lo) / (hi - lo)) * (f.y0 - f.y1);
  yAxis(g, f, ticks, sy, c.y);
  xLabel(g, f, c.x);
  const band = (f.x1 - f.x0) / n;
  const cx = (i: number): number => (c.kind === 'bar' ? f.x0 + band * (i + 0.5) : n === 1 ? (f.x0 + f.x1) / 2 : f.x0 + 6 + ((f.x1 - f.x0 - 12) * i) / (n - 1));
  // the baseline (zero for bars)
  const base = sy(Math.max(lo, Math.min(hi, 0)));
  g.append(svg('line', { class: 'ch-axis', x1: f.x0, x2: f.x1, y1: r1(base), y2: r1(base) }));
  // category labels: as many as fit
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((f.x1 - f.x0) / 34))));
  for (let i = 0; i < n; i += every) {
    const raw = labels[i] ?? String(i + 1);
    const t = raw.length > 7 && every === 1 && n > 4 ? `${raw.slice(0, 6)}…` : raw;
    g.append(svg('text', { class: 'ch-tick', x: r1(cx(i)), y: f.y0 + 12, 'text-anchor': 'middle' }, t.toLowerCase()));
  }
  const name = (s: number): string => c.series[s]?.name || (c.series.length > 1 ? `series ${s + 1}` : '');
  if (c.kind === 'bar') {
    const k = c.series.length;
    const inner = Math.min(band * 0.56, 20 * k);
    const bw = inner / k;
    c.series.forEach((s, si) => {
      (s.values ?? []).forEach((v, i) => {
        const x = cx(i) - inner / 2 + bw * si + 0.75;
        const y = Math.min(sy(v), base);
        const h = Math.max(0.8, Math.abs(sy(v) - base));
        const r = svg('rect', { class: `ch-bar ch-s${si}`, x: r1(x), y: r1(y), width: r1(Math.max(1, bw - 1.5)), height: r1(h), rx: 1.5 });
        tip(r, `${name(si) ? `${name(si)} · ` : ''}${labels[i] ?? i + 1}: ${formatNum(v)}`);
        g.append(r);
      });
    });
  } else {
    c.series.forEach((s, si) => {
      const vals = s.values ?? [];
      const d = vals.map((v, i) => `${i ? 'L' : 'M'}${r1(cx(i))} ${r1(sy(v))}`).join('');
      g.append(svg('path', { class: `ch-line ch-s${si}`, d }));
      if (vals.length <= 14)
        vals.forEach((v, i) => {
          const dot = svg('circle', { class: `ch-dot ch-s${si}`, cx: r1(cx(i)), cy: r1(sy(v)), r: si === 0 ? 2.4 : 2 });
          tip(dot, `${name(si) ? `${name(si)} · ` : ''}${labels[i] ?? i + 1}: ${formatNum(v)}`);
          g.append(dot);
        });
    });
  }
  // hover: the nearest category's values
  const marker = svg('line', { class: 'ch-cursor', x1: 0, x2: 0, y1: f.y1, y2: f.y0, visibility: 'hidden' });
  g.append(marker);
  overlay.addEventListener('pointermove', (e) => {
    const x = localX(overlay, e);
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(cx(i) - x) < Math.abs(cx(best) - x)) best = i;
    marker.setAttribute('x1', r1(cx(best)));
    marker.setAttribute('x2', r1(cx(best)));
    marker.setAttribute('visibility', 'visible');
    const vals = c.series.map((s, si) => `${name(si) ? `${name(si)} ` : ''}${formatNum(s.values?.[best] ?? NaN)}`).filter((t) => t.trim());
    out.set(`${(labels[best] ?? String(best + 1)).toLowerCase()} · ${vals.join(' · ')}`);
  });
  overlay.addEventListener('pointerleave', () => {
    marker.setAttribute('visibility', 'hidden');
    out.set('');
  });
}

function localX(el: SVGGraphicsElement, e: PointerEvent): number {
  const box = el.ownerSVGElement!.getBoundingClientRect();
  return ((e.clientX - box.left) / Math.max(1, box.width)) * W;
}
function localY(el: SVGGraphicsElement, e: PointerEvent): number {
  const box = el.ownerSVGElement!.getBoundingClientRect();
  return ((e.clientY - box.top) / Math.max(1, box.height)) * H;
}

/* ───────── scatter / plot (numeric x) ───────── */

function numericFrame(c: ChartVisual, xlo: number, xhi: number, ylo: number, yhi: number, g: SVGGElement) {
  const yTicks = niceTicks(ylo, yhi, 4);
  const f = frameFor(yTicks, !!c.x, !!c.y, false);
  const sx = (v: number): number => f.x0 + ((v - xlo) / (xhi - xlo)) * (f.x1 - f.x0);
  const sy = (v: number): number => f.y0 - ((v - ylo) / (yhi - ylo)) * (f.y0 - f.y1);
  yAxis(g, f, yTicks.filter((t) => t >= ylo - 1e-9 && t <= yhi + 1e-9), sy, c.y);
  xLabel(g, f, c.x);
  const xTicks = niceTicks(xlo, xhi, 5).filter((t) => t >= xlo - 1e-9 && t <= xhi + 1e-9);
  for (const t of xTicks) g.append(svg('text', { class: 'ch-tick', x: r1(sx(t)), y: f.y0 + 12, 'text-anchor': 'middle' }, formatNum(t)));
  // the axes through zero when they're in view, else the frame's bottom edge
  const zeroY = ylo <= 0 && yhi >= 0 ? sy(0) : f.y0;
  g.append(svg('line', { class: 'ch-axis', x1: f.x0, x2: f.x1, y1: r1(zeroY), y2: r1(zeroY) }));
  if (xlo < 0 && xhi > 0) g.append(svg('line', { class: 'ch-axis', x1: r1(sx(0)), x2: r1(sx(0)), y1: f.y1, y2: f.y0 }));
  return { f, sx, sy };
}

function pad([lo, hi]: [number, number], k = 0.06): [number, number] {
  const d = (hi - lo || 1) * k;
  return [lo - d, hi + d];
}

function scatterChart(c: ChartVisual, g: SVGGElement, out: Readout, overlay: SVGRectElement): void {
  const pts = c.series.flatMap((s) => s.points ?? []);
  const [xlo, xhi] = pad(autoRange(pts.map((p) => p[0])));
  const [ylo, yhi] = pad(autoRange(pts.map((p) => p[1])));
  const { sx, sy } = numericFrame(c, xlo, xhi, ylo, yhi, g);
  const dots: { x: number; y: number; p: [number, number]; s: string }[] = [];
  c.series.forEach((s, si) => {
    for (const p of s.points ?? []) {
      const dot = svg('circle', { class: `ch-dot ch-scatter ch-s${si}`, cx: r1(sx(p[0])), cy: r1(sy(p[1])), r: 2.8 });
      tip(dot, `${s.name ? `${s.name} · ` : ''}(${formatNum(p[0])}, ${formatNum(p[1])})`);
      g.append(dot);
      dots.push({ x: sx(p[0]), y: sy(p[1]), p, s: s.name });
    }
  });
  overlay.addEventListener('pointermove', (e) => {
    const x = localX(overlay, e);
    const y = localY(overlay, e);
    let best: (typeof dots)[number] | null = null;
    let bd = 18 ** 2;
    for (const d of dots) {
      const dd = (d.x - x) ** 2 + (d.y - y) ** 2;
      if (dd < bd) [best, bd] = [d, dd];
    }
    out.set(best ? `${best.s ? `${best.s} · ` : ''}x ${formatNum(best.p[0])} · y ${formatNum(best.p[1])}` : '');
  });
  overlay.addEventListener('pointerleave', () => out.set(''));
}

function plotChart(c: ChartVisual, g: SVGGElement, out: Readout, overlay: SVGRectElement): void {
  const [xlo, xhi] = c.domain ?? [-10, 10];
  const samples = c.series.map((s) => samplePlot(s.expr ?? '', xlo, xhi));
  const [ylo, yhi] = c.range ?? pad(autoRange(samples.flat().map((p) => p.y)), 0.08);
  const { f, sx, sy } = numericFrame(c, xlo, xhi, ylo, yhi, g);
  const clipId = `chclip${Math.random().toString(36).slice(2, 8)}`;
  const defs = svg('defs');
  const cp = svg('clipPath', { id: clipId });
  cp.append(svg('rect', { x: f.x0, y: f.y1 - 2, width: f.x1 - f.x0, height: f.y0 - f.y1 + 4 }));
  defs.append(cp);
  g.append(defs);
  const span = yhi - ylo;
  samples.forEach((pts, si) => {
    let d = '';
    let pen = false;
    let prev: { x: number; y: number } | null = null;
    for (const p of pts) {
      // a break: not a number, or a jump through an asymptote (tan x, 1/x)
      const jump = prev && Number.isFinite(prev.y) && Number.isFinite(p.y) && Math.abs(p.y - prev.y) > span * 0.5 && Math.sign(p.y) !== Math.sign(prev.y);
      if (!Number.isFinite(p.y) || jump) {
        pen = false;
        prev = p;
        if (!Number.isFinite(p.y)) continue;
      }
      const y = Math.max(ylo - span * 4, Math.min(yhi + span * 4, p.y)); // keep paths short off-screen
      d += `${pen ? 'L' : 'M'}${r1(sx(p.x))} ${r1(sy(y))}`;
      pen = true;
      prev = p;
    }
    const path = svg('path', { class: `ch-line ch-fn ch-s${si}`, d, 'clip-path': `url(#${clipId})` });
    tip(path, prettyMath(c.series[si]!.name));
    g.append(path);
  });
  // hover: a dot riding the first curve, and its value
  const fns = c.series.map((s) => parseExpr(s.expr ?? ''));
  const dot = svg('circle', { class: 'ch-dot ch-s0 ch-ride', r: 3, cx: 0, cy: 0, visibility: 'hidden' });
  g.append(dot);
  overlay.addEventListener('pointermove', (e) => {
    const px = Math.max(f.x0, Math.min(f.x1, localX(overlay, e)));
    const x = xlo + ((px - f.x0) / (f.x1 - f.x0)) * (xhi - xlo);
    const ys = fns.map((fn) => (fn ? fn(x) : NaN));
    const y0 = ys[0]!;
    if (Number.isFinite(y0) && y0 >= ylo && y0 <= yhi) {
      dot.setAttribute('cx', r1(px));
      dot.setAttribute('cy', r1(sy(y0)));
      dot.setAttribute('visibility', 'visible');
    } else dot.setAttribute('visibility', 'hidden');
    const ytxt = ys.map((y) => (Number.isFinite(y) ? formatNum(y) : '—')).join(' · ');
    out.set(`x ${formatNum(x)} · y ${ytxt}`);
  });
  overlay.addEventListener('pointerleave', () => {
    dot.setAttribute('visibility', 'hidden');
    out.set('');
  });
}

/* ───────── pie (a donut) ───────── */

function pieChart(c: ChartVisual, root: SVGSVGElement, legend: HTMLElement): void {
  const vals = c.series[0]?.values ?? [];
  const labels = c.labels ?? [];
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  const cx = 74;
  const cy = H / 2;
  const R = 64;
  const r = 44;
  let a = -Math.PI / 2;
  const order = vals.map((v, i) => ({ v, i })).sort((p, q) => q.v - p.v);
  const shade = new Map(order.map((o, k) => [o.i, k]));
  vals.forEach((v, i) => {
    const sweep = (v / total) * Math.PI * 2;
    const a2 = a + sweep;
    const big = sweep > Math.PI ? 1 : 0;
    const p = (ang: number, rad: number): string => `${r1(cx + Math.cos(ang) * rad)} ${r1(cy + Math.sin(ang) * rad)}`;
    const d =
      vals.length === 1
        ? `M${cx - R} ${cy}a${R} ${R} 0 1 0 ${R * 2} 0a${R} ${R} 0 1 0 ${-R * 2} 0ZM${cx - r} ${cy}a${r} ${r} 0 1 1 ${r * 2} 0a${r} ${r} 0 1 1 ${-r * 2} 0Z`
        : `M${p(a, R)}A${R} ${R} 0 ${big} 1 ${p(a2, R)}L${p(a2, r)}A${r} ${r} 0 ${big} 0 ${p(a, r)}Z`;
    const slice = svg('path', { class: `ch-slice ch-k${Math.min(7, shade.get(i)!)}`, d, 'fill-rule': 'evenodd' });
    tip(slice, `${labels[i] ?? i + 1}: ${formatNum(v)} (${Math.round((v / total) * 100)}%)`);
    root.append(slice);
    a = a2;
  });
  const top = order[0]!;
  root.append(svg('text', { class: 'ch-center', x: cx, y: cy + 4, 'text-anchor': 'middle' }, `${Math.round((top.v / total) * 100)}%`));
  root.append(svg('text', { class: 'ch-tick', x: cx, y: cy + 18, 'text-anchor': 'middle' }, (labels[top.i] ?? '').toLowerCase().slice(0, 14)));
  // the legend sits to the right of the ring, inside the svg box
  legend.classList.add('vchart-legend-pie');
  for (const o of order) {
    const row = document.createElement('li');
    const sw = document.createElement('span');
    sw.className = `vchart-swatch ch-k${Math.min(7, shade.get(o.i)!)}`;
    const name = document.createElement('span');
    name.className = 'vchart-name';
    name.textContent = (labels[o.i] ?? String(o.i + 1)).toLowerCase();
    const val = document.createElement('span');
    val.className = 'vchart-val';
    val.textContent = `${Math.round((o.v / total) * 100)}%`;
    row.append(sw, name, val);
    legend.append(row);
  }
}

/** The chart card's body: svg, legend, hover readout. */
export function renderChartBody(c: ChartVisual): HTMLElement {
  const box = document.createElement('div');
  box.className = `vchart vchart-${c.kind}`;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'vchart-svg', role: 'img' });
  root.setAttribute('aria-label', `${c.kind === 'plot' ? 'graph' : `${c.kind} chart`}: ${c.title}`);
  const legend = document.createElement('ul');
  legend.className = 'vchart-legend';
  const readout = document.createElement('p');
  readout.className = 'vchart-readout';
  readout.setAttribute('aria-live', 'off');
  const out: Readout = {
    set(text) {
      readout.textContent = text;
      readout.classList.toggle('is-on', !!text);
    },
  };
  box.append(root);
  if (c.kind === 'pie') {
    pieChart(c, root, legend);
    box.append(legend);
    return box;
  }
  const g = svg('g');
  root.append(g);
  const hit = svg('rect', { class: 'ch-hit', x: 0, y: 0, width: W, height: H });
  if (c.kind === 'scatter') scatterChart(c, g, out, hit);
  else if (c.kind === 'plot') plotChart(c, g, out, hit);
  else categoryChart(c, g, out, hit);
  root.append(hit);
  // a legend only when there's more than one named thing to tell apart
  const named = c.series.filter((s) => s.name);
  if (c.series.length > 1 || (c.kind === 'plot' && named.length && named[0]!.name !== c.title)) {
    c.series.forEach((s, si) => {
      const row = document.createElement('li');
      const sw = document.createElement('span');
      sw.className = c.kind === 'bar' ? `vchart-swatch vchart-swatch-bar ch-s${si}` : `vchart-swatch vchart-swatch-line ch-s${si}`;
      const name = document.createElement('span');
      name.className = 'vchart-name';
      name.textContent = prettyMath((s.name || `series ${si + 1}`).toLowerCase());
      row.append(sw, name);
      legend.append(row);
    });
    box.append(legend);
  }
  box.append(readout);
  return box;
}
