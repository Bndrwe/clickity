// Charts and function plots in replies: [CHART:kind|title|field|field…] (see visualPromptSection).
// Pure and unit tested (test/charts.test.ts): parsing the tag's fields, checking stored charts
// (they come back from disk), sampling function plots, nice axis ticks and number labels.
// Rendered as SVG by src/renderer/shared/charts.ts.
//
//   [CHART:line|steps this week|labels: mon, tue, wed|you: 4, 7, 6|goal: 6, 6, 6]
//   [CHART:bar|coffee per day|x: day|y: cups|labels: mon, tue, wed|cups: 2, 3, 1]
//   [CHART:scatter|height vs weight|x: cm|y: kg|points: (150, 50) (160, 58) (170, 66)]
//   [CHART:pie|monthly budget|rent: 1200|food: 400|fun: 200]
//   [CHART:plot|a parabola|y = x^2 - 3|x: -4..4]
import { CHART_KINDS, type ChartKind, type ChartSeries, type ChartVisual } from './visuals.ts';
import { evalConst, exprOf, parseExpr } from './expr.ts';

export const MAX_SERIES = 4;
export const MAX_FUNCS = 3;
export const MAX_VALUES = 40;
export const MAX_SLICES = 8;
export const MAX_POINTS = 60;
const MAX_TITLE = 60;
const MAX_LABEL = 28;
const MAX_NAME = 24;

const KIND_ALIASES: Record<string, ChartKind> = {
  line: 'line',
  lines: 'line',
  'line-chart': 'line',
  linechart: 'line',
  trend: 'line',
  area: 'line',
  bar: 'bar',
  bars: 'bar',
  'bar-chart': 'bar',
  barchart: 'bar',
  column: 'bar',
  columns: 'bar',
  histogram: 'bar',
  scatter: 'scatter',
  'scatter-plot': 'scatter',
  scatterplot: 'scatter',
  points: 'scatter',
  dots: 'scatter',
  pie: 'pie',
  'pie-chart': 'pie',
  piechart: 'pie',
  donut: 'pie',
  doughnut: 'pie',
  plot: 'plot',
  function: 'plot',
  func: 'plot',
  fn: 'plot',
  graph: 'plot',
  curve: 'plot',
  equation: 'plot',
  'function-plot': 'plot',
};

export function normalizeChartKind(raw: string): ChartKind | null {
  const k = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return (CHART_KINDS as readonly string[]).includes(k) ? (k as ChartKind) : (KIND_ALIASES[k] ?? null);
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** "1,200" / "$4.5k" / "12%" / "-3" → number (NaN when it isn't one). */
export function parseNum(raw: string): number {
  let s = raw.trim().replace(/[$€£¥%\s]/g, '').replace(/^\+/, '').replace(/[−–]/g, '-');
  if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?[kmb]?$/i.test(s)) s = s.replace(/,/g, ''); // 1,200
  const m = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([kmb])?$/i.exec(s);
  if (!m) return NaN;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? '').toLowerCase() as 'k' | 'm' | 'b'] ?? 1;
  return Number(m[1]) * mult;
}

/** "4, 7, 6" / "4 7 6" / "4; 7; 6" → numbers (null if any isn't one). Thousands commas: "1,200" alone is 1200. */
export function parseList(raw: string): number[] | null {
  const s = raw.trim();
  if (!s) return null;
  // "1,200, 3,400": when items are separated by ", " / ";" / spaces, a comma glued to three digits
  // is a thousands mark; "100,200,300" (bare commas) is a list
  const spaced = /[,;]\s|\s[,;]?|;/.test(s);
  const parts = (spaced ? s.replace(/(\d),(\d{3})(?!\d)(?=\s|$|;|,)/g, '$1$2') : s).split(/\s*[,;]\s*|\s+/).filter(Boolean);
  if (!parts.length) return null;
  const nums = parts.map(parseNum);
  return nums.every(Number.isFinite) ? nums : null;
}

/** "(1, 2) (3, 4)" / "1 2, 3 4" / "1,2; 3,4" → pairs. */
export function parsePairs(raw: string): [number, number][] | null {
  const nums = [...raw.matchAll(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi)].map((m) => Number(m[0]));
  if (nums.length < 2 || nums.length % 2) return null;
  const out: [number, number][] = [];
  for (let i = 0; i < nums.length; i += 2) out.push([nums[i]!, nums[i + 1]!]);
  return out;
}

/** "-4..4" / "-4 to 4" / "from -2pi to 2pi" / "[-4, 4]" → [lo, hi], or null. */
export function parseRange(raw: string): [number, number] | null {
  const s = raw.trim().replace(/^from\s+/i, '').replace(/^[[(]|[\])]$/g, '');
  const m = /^(.+?)\s*(?:\.\.\.?|…|\bto\b|,)\s*(.+)$/i.exec(s);
  if (!m) return null;
  const a = evalConst(m[1]!);
  const b = evalConst(m[2]!);
  if (a === null || b === null || a === b) return null;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (hi - lo > 1e7 || Math.abs(lo) > 1e7 || Math.abs(hi) > 1e7) return null;
  return [lo, hi];
}

const LABEL_KEYS = /^(labels?|categories|category|names?|keys?|x[ -]?values|columns?)$/i;
const X_KEYS = /^(x|x[ -]?axis|x[ -]?label|xlabel|horizontal)$/i;
const Y_KEYS = /^(y|y[ -]?axis|y[ -]?label|ylabel|vertical)$/i;
const DOMAIN_KEYS = /^(range|domain|x[ -]?range|from)$/i;
const RANGE_KEYS = /^(y[ -]?range)$/i;
const POINT_KEYS = /^(points?|data|pairs?|values?)$/i;

/** an expression that uses x and parses ("2x + 3", "sin(x)") */
function fnExpr(field: string, bare: boolean): string | null {
  const e = exprOf(field);
  if (!e) return null;
  const explicit = /=/.test(field);
  if (!explicit && !bare) return null;
  if (!explicit && !/x/i.test(e.replace(/exp|max/gi, ''))) return null;
  return parseExpr(e) ? e : null;
}

/**
 * The fields of a [CHART:…] tag (split on '|', escapes already applied) → a chart, or null when
 * there is nothing drawable. Lenient: unknown kinds that look like an equation become a plot.
 */
export function parseChartFields(fields: string[]): ChartVisual | null {
  const f = fields.map((x) => x.replace(/\s+/g, ' ').trim());
  let kind = normalizeChartKind(f[0] ?? '');
  let rest: string[];
  let title: string;
  if (!kind) {
    // [CHART:y = x^2 - 3] or [CHART:y = x^2|x: -3..3]
    if (!fnExpr(f[0] ?? '', true)) return null;
    kind = 'plot';
    title = f[0]!;
    rest = f;
  } else {
    title = f[1] ?? '';
    rest = f.slice(2);
    // the title slot holds an equation / data instead of a title
    if (kind === 'plot' && fnExpr(title, true)) rest = [title, ...rest];
    else if (/^[^:]+:\s*[-\d.$]/.test(title) && kind !== 'plot') {
      rest = [title, ...rest];
      title = '';
    }
  }

  const out: ChartVisual = { type: 'chart', kind, title: '', series: [] };
  let labels: string[] | undefined;
  const pie: { name: string; value: number }[] = [];

  for (const field of rest) {
    if (!field) continue;
    // functions: "y = 2x + 3", "f(x) = sin(x)", or a bare "x^2" in a plot
    if (kind === 'plot') {
      const e = fnExpr(field, !/^[^:=]+:/.test(field));
      if (e) {
        if (out.series.length < MAX_FUNCS && !out.series.some((s) => s.expr === e)) out.series.push({ name: clip(field.includes('=') ? field : `y = ${e}`, MAX_NAME + 16), expr: e });
        continue;
      }
    }
    const kv = /^([^:=]{1,32}?)\s*[:=]\s*(.*)$/.exec(field);
    if (!kv && kind === 'plot') {
      const r = parseRange(field); // a bare "-4..4"
      if (r) out.domain = r;
      continue;
    }
    const key = kv?.[1]?.trim() ?? '';
    const val = kv?.[2]?.trim() ?? field;
    if (kv && DOMAIN_KEYS.test(key)) {
      const r = parseRange(val);
      if (r) out.domain = r;
      continue;
    }
    if (kv && RANGE_KEYS.test(key)) {
      const r = parseRange(val);
      if (r) out.range = r;
      continue;
    }
    if (kv && X_KEYS.test(key)) {
      const r = kind === 'plot' ? parseRange(val) : null;
      // "x: -4..4 (seconds)" is a range; anything else an axis label
      if (r) out.domain = r;
      else if (kind !== 'plot' || !out.x) out.x = clip(val, MAX_LABEL) || undefined;
      continue;
    }
    if (kv && Y_KEYS.test(key)) {
      const r = kind === 'plot' ? parseRange(val) : null;
      if (r) out.range = r;
      else out.y = clip(val, MAX_LABEL) || undefined;
      continue;
    }
    if (kv && LABEL_KEYS.test(key)) {
      labels = val.split(/\s*[,;]\s*/).map((l) => clip(l, MAX_LABEL)).filter(Boolean).slice(0, MAX_VALUES);
      continue;
    }
    if (kind === 'scatter') {
      const pairs = parsePairs(val);
      if (pairs && out.series.length < MAX_SERIES) out.series.push({ name: kv && !POINT_KEYS.test(key) ? clip(key, MAX_NAME) : '', points: pairs.slice(0, MAX_POINTS) });
      continue;
    }
    if (kind === 'pie') {
      const v = kv ? parseNum(val) : NaN;
      if (kv && Number.isFinite(v) && v > 0) pie.push({ name: clip(key, MAX_NAME), value: v });
      else {
        const list = parseList(val);
        if (list && labels === undefined && !kv) pie.push(...list.filter((n) => n > 0).map((value, i) => ({ name: `${i + 1}`, value })));
        else if (list && kv && POINT_KEYS.test(key)) pie.push(...list.filter((n) => n > 0).map((value, i) => ({ name: `${i + 1}`, value })));
      }
      continue;
    }
    if (kind === 'line' || kind === 'bar') {
      const list = parseList(val);
      if (list && out.series.length < MAX_SERIES) out.series.push({ name: kv && !POINT_KEYS.test(key) ? clip(key, MAX_NAME) : '', values: list.slice(0, MAX_VALUES) });
    }
  }

  if (kind === 'pie') {
    // "labels: a, b|values: 1, 2" also works
    if (labels?.length && pie.every((p) => /^\d+$/.test(p.name))) pie.forEach((p, i) => (p.name = labels![i] ?? p.name));
    const slices = pie.slice(0, MAX_SLICES);
    if (slices.length < 1) return null;
    out.labels = slices.map((s) => s.name);
    out.series = [{ name: '', values: slices.map((s) => s.value) }];
  } else if (kind === 'line' || kind === 'bar') {
    if (!out.series.length) return null;
    const n = Math.max(...out.series.map((s) => s.values!.length));
    if (kind === 'line' && n < 2) return null;
    out.labels = Array.from({ length: n }, (_, i) => labels?.[i] ?? `${i + 1}`);
  } else if (kind === 'scatter') {
    if (!out.series.length) return null;
  } else {
    if (!out.series.length) return null;
    out.domain ??= [-10, 10];
  }
  out.title = clip(title, MAX_TITLE) || (kind === 'plot' ? out.series[0]!.name : '') || kind;
  return out;
}

const finiteList = (v: unknown, max: number): v is number[] => Array.isArray(v) && v.length <= max && v.every((n) => typeof n === 'number' && Number.isFinite(n));
const pair = (v: unknown): v is [number, number] => finiteList(v, 2) && (v as number[]).length === 2;

/** A stored chart (from disk / IPC) checked field by field; null when it is not drawable. */
export function sanitizeChart(v: unknown): ChartVisual | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Partial<ChartVisual>;
  if (c.type !== 'chart' || !(CHART_KINDS as readonly string[]).includes(c.kind as string) || typeof c.title !== 'string' || !Array.isArray(c.series)) return null;
  const series: ChartSeries[] = [];
  for (const s of c.series.slice(0, MAX_SERIES)) {
    if (!s || typeof s !== 'object' || typeof s.name !== 'string') continue;
    if (c.kind === 'plot') {
      if (typeof s.expr === 'string' && parseExpr(s.expr)) series.push({ name: clip(s.name, 48), expr: s.expr });
    } else if (c.kind === 'scatter') {
      if (Array.isArray(s.points) && s.points.length <= MAX_POINTS && s.points.every(pair)) series.push({ name: clip(s.name, MAX_NAME), points: s.points });
    } else if (finiteList(s.values, MAX_VALUES) && s.values.length) series.push({ name: clip(s.name, MAX_NAME), values: s.values });
  }
  if (!series.length) return null;
  const labels = Array.isArray(c.labels) ? c.labels.filter((l): l is string => typeof l === 'string').map((l) => clip(l, MAX_LABEL)).slice(0, MAX_VALUES) : undefined;
  const out: ChartVisual = { type: 'chart', kind: c.kind as ChartKind, title: clip(c.title, MAX_TITLE), series };
  if (typeof c.x === 'string' && c.x) out.x = clip(c.x, MAX_LABEL);
  if (typeof c.y === 'string' && c.y) out.y = clip(c.y, MAX_LABEL);
  if (labels) out.labels = labels;
  if (pair(c.domain) && c.domain[0] < c.domain[1]) out.domain = c.domain;
  if (pair(c.range) && c.range[0] < c.range[1]) out.range = c.range;
  if (out.kind === 'plot' && !out.domain) out.domain = [-10, 10];
  if (out.kind === 'pie' && (out.series[0]!.values!.some((n) => n < 0) || out.series[0]!.values!.every((n) => n === 0))) return null;
  return out;
}

/* ───────── drawing helpers (renderer) ───────── */

/**
 * Sample y = f(x) on [lo, hi]. A NaN marks a break: not finite, or a jump across an asymptote
 * (tan x, 1/x) — the renderer starts a new path there.
 */
export function samplePlot(expr: string, lo: number, hi: number, n = 240): { x: number; y: number }[] {
  const f = parseExpr(expr);
  if (!f || !(hi > lo)) return [];
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const x = lo + ((hi - lo) * i) / n;
    let y: number;
    try {
      y = f(x);
    } catch {
      y = NaN;
    }
    out.push({ x, y: Number.isFinite(y) ? y : NaN });
  }
  return out;
}

/** A y range for sampled values that ignores asymptote spikes (2nd–98th percentile when extremes run away). */
export function autoRange(ys: number[]): [number, number] {
  const v = ys.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return [-1, 1];
  const q = (p: number): number => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))]!;
  let lo = v[0]!;
  let hi = v[v.length - 1]!;
  const qlo = q(0.03);
  const qhi = q(0.97);
  const spread = Math.max(qhi - qlo, 1e-9);
  if (qlo - lo > spread * 2) lo = qlo - spread * 0.25;
  if (hi - qhi > spread * 2) hi = qhi + spread * 0.25;
  if (hi - lo < 1e-9) return [lo - 1, hi + 1];
  return [lo, hi];
}

/** ~`count` round tick values covering [lo, hi] (steps of 1, 2, 2.5 or 5 × 10^k). */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) return [lo];
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  const start = Math.ceil(lo / step - 1e-9) * step;
  for (let t = start; t <= hi + step * 1e-9 && out.length < 50; t += step) out.push(Math.abs(t) < step * 1e-9 ? 0 : Number(t.toPrecision(12)));
  return out;
}

/** Short tick / value label: 1200 → "1.2k", 0.25 → "0.25", 3 → "3". */
export function formatNum(n: number): string {
  if (!Number.isFinite(n)) return '';
  const a = Math.abs(n);
  const trim = (s: string): string => s.replace(/\.0+$|(\.\d*?)0+$/, '$1');
  if (a >= 1e9) return `${trim((n / 1e9).toFixed(1))}b`;
  if (a >= 1e6) return `${trim((n / 1e6).toFixed(1))}m`;
  if (a >= 1e4) return `${trim((n / 1e3).toFixed(a >= 1e5 ? 0 : 1))}k`;
  if (a >= 100) return String(Math.round(n));
  if (a >= 1 || a === 0) return trim(n.toFixed(2));
  return trim(n.toPrecision(2));
}

/** One line for the model's context ("(showed chart "budget")") and logs. */
export function chartSummary(c: ChartVisual): string {
  if (c.kind === 'plot') return `graph of ${c.series.map((s) => s.name).join(', ')}`;
  return `${c.kind} chart "${c.title}"`;
}
