import test from 'node:test';
import assert from 'node:assert/strict';
import { autoRange, formatNum, niceTicks, parseChartFields, parseList, parseNum, parsePairs, parseRange, samplePlot, sanitizeChart } from '../src/shared/charts.ts';
import { parseVisualTags, stripVisualTags, visualContextNote, visualPromptSection } from '../src/main/visual-tags.ts';

const one = (text: string) => {
  const v = parseVisualTags(text);
  assert.equal(v.length, 1, `one visual from ${text}`);
  assert.equal(v[0]!.type, 'chart');
  return v[0] as Extract<(typeof v)[number], { type: 'chart' }>;
};

test('function plot with a range', () => {
  const c = one('a parabola, lowest at (0, -3). [CHART:plot|a parabola|y = x^2 - 3|x: -4..4]');
  assert.deepEqual(c, { type: 'chart', kind: 'plot', title: 'a parabola', series: [{ name: 'y = x^2 - 3', expr: 'x^2 - 3' }], domain: [-4, 4] });
});

test('plot shorthands small models write', () => {
  assert.deepEqual(one('[CHART:y = 2x + 3]').series, [{ name: 'y = 2x + 3', expr: '2x + 3' }]);
  assert.equal(one('[CHART:y = 2x + 3]').title, 'y = 2x + 3');
  assert.deepEqual(one('[CHART:y = 2x + 3]').domain, [-10, 10]);
  const g = one('[CHART:graph|y = sin(x)|y = cos(x)|from -2pi to 2pi]');
  assert.equal(g.kind, 'plot');
  assert.equal(g.series.length, 2);
  assert.ok(Math.abs(g.domain![0] + 2 * Math.PI) < 1e-9);
  assert.equal(one('[CHART:function|lines|f(x) = 2x|x^2|-3..3]').series.length, 2);
  assert.deepEqual(one('[CHART:plot|t|y=x|y: -1 to 1]').range, [-1, 1]);
  // a plot with nothing valid is dropped
  assert.deepEqual(parseVisualTags('[CHART:plot|bad|y = foo(x)]'), []);
  assert.deepEqual(parseVisualTags('[CHART:hello]'), []);
});

test('line and bar charts with labels and series', () => {
  const c = one('[CHART:line|steps this week|x: day|y: steps|labels: mon, tue, wed|you: 4, 7, 6|goal: 6, 6, 6]');
  assert.deepEqual(c, {
    type: 'chart',
    kind: 'line',
    title: 'steps this week',
    x: 'day',
    y: 'steps',
    labels: ['mon', 'tue', 'wed'],
    series: [
      { name: 'you', values: [4, 7, 6] },
      { name: 'goal', values: [6, 6, 6] },
    ],
  });
  const b = one('[CHART:bar|coffee|labels: mon, tue|cups: 2, 3]');
  assert.equal(b.kind, 'bar');
  assert.deepEqual(b.series, [{ name: 'cups', values: [2, 3] }]);
  // no labels: numbered; unnamed series
  const n = one('[CHART:columns|sales|1200, 3400, 2100]');
  assert.deepEqual(n.labels, ['1', '2', '3']);
  assert.deepEqual(n.series, [{ name: '', values: [1200, 3400, 2100] }]);
  // a line needs two points; garbage series are dropped
  assert.deepEqual(parseVisualTags('[CHART:line|x|a: 1]'), []);
  assert.deepEqual(parseVisualTags('[CHART:bar|x|a: lots, more]'), []);
});

test('scatter and pie', () => {
  const s = one('[CHART:scatter|height vs weight|x: cm|y: kg|points: (150, 50) (160, 58) (170, 66)]');
  assert.deepEqual(s.series, [{ name: '', points: [[150, 50], [160, 58], [170, 66]] }]);
  assert.deepEqual(one('[CHART:scatter|t|a: 1 2, 3 4]').series[0]!.points, [[1, 2], [3, 4]]);
  const p = one('[CHART:donut|monthly budget|rent: 1200|food: 400|fun: $200]');
  assert.equal(p.kind, 'pie');
  assert.deepEqual(p.labels, ['rent', 'food', 'fun']);
  assert.deepEqual(p.series, [{ name: '', values: [1200, 400, 200] }]);
  const q = one('[CHART:pie|split|labels: a, b|values: 3, 1]');
  assert.deepEqual(q.labels, ['a', 'b']);
  assert.deepEqual(q.series[0]!.values, [3, 1]);
  // data in the title slot
  assert.deepEqual(one('[CHART:pie|a: 1|b: 2]').labels, ['a', 'b']);
});

test('number helpers', () => {
  assert.equal(parseNum('1,200'.replace(',', '')), 1200);
  assert.equal(parseNum('$4.5k'), 4500);
  assert.equal(parseNum('12%'), 12);
  assert.equal(parseNum('−3'), -3);
  assert.ok(Number.isNaN(parseNum('lots')));
  assert.deepEqual(parseList('4, 7, 6'), [4, 7, 6]);
  assert.deepEqual(parseList('4 7 6'), [4, 7, 6]);
  assert.deepEqual(parseList('1,200, 3,400'), [1200, 3400]);
  assert.deepEqual(parseList('100,200,300'), [100, 200, 300]);
  assert.equal(parseNum('1,200'), 1200);
  assert.equal(parseList('a, 2'), null);
  assert.deepEqual(parsePairs('(1,2) (3,4)'), [[1, 2], [3, 4]]);
  assert.equal(parsePairs('1 2 3'), null);
  assert.deepEqual(parseRange('-4..4'), [-4, 4]);
  assert.deepEqual(parseRange('4 to -4'), [-4, 4]);
  assert.deepEqual(parseRange('[0, 10]'), [0, 10]);
  assert.equal(parseRange('3..3'), null);
  assert.equal(parseRange('a..b'), null);
});

test('streaming hides a partial chart tag; the finished reply drops it', () => {
  assert.equal(stripVisualTags('here it is. [CHA', true), 'here it is. ');
  assert.equal(stripVisualTags('here it is. [CHART:plot|y = x^2|x: -', true), 'here it is. ');
  assert.equal(stripVisualTags('here it is. [CHART:plot|t|y = x^2]', false), 'here it is.');
});

test('chart context note and prompt', () => {
  assert.equal(visualContextNote(parseVisualTags('[CHART:plot|t|y = x^2]')), ' (showed graph of y = x^2)');
  assert.equal(visualContextNote(parseVisualTags('[CHART:bar|cups|a: 1, 2]')), ' (showed bar chart "cups")');
  assert.match(visualPromptSection(), /\[CHART:plot\|/);
});

test('sanitizeChart checks stored charts', () => {
  const good = one('[CHART:plot|t|y = x^2|x: -2..2]');
  assert.deepEqual(sanitizeChart(JSON.parse(JSON.stringify(good))), good);
  assert.equal(sanitizeChart({ type: 'chart', kind: 'plot', title: 't', series: [{ name: 'evil', expr: 'alert(1)' }] }), null);
  assert.equal(sanitizeChart({ type: 'chart', kind: 'bar', title: 't', series: [{ name: 'a', values: [1, 'x'] }] }), null);
  assert.equal(sanitizeChart({ type: 'chart', kind: 'nope', title: 't', series: [] }), null);
  assert.equal(sanitizeChart(null), null);
  assert.deepEqual(sanitizeChart({ type: 'chart', kind: 'plot', title: 't', series: [{ name: 'y', expr: 'x' }] })!.domain, [-10, 10]);
});

test('sampling, ranges, ticks, labels', () => {
  const pts = samplePlot('x^2', -2, 2, 4);
  assert.deepEqual(pts.map((p) => p.y), [4, 1, 0, 1, 4]);
  assert.ok(samplePlot('1/x', -1, 1, 2).some((p) => Number.isNaN(p.y)));
  assert.deepEqual(samplePlot('nope', 0, 1), []);
  // tan's spikes don't flatten the curve
  const [lo, hi] = autoRange(samplePlot('tan(x)', -5, 5).map((p) => p.y));
  assert.ok(hi < 200 && lo > -200, `${lo}..${hi}`);
  assert.deepEqual(autoRange([2, 2]), [1, 3]);
  assert.deepEqual(niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(niceTicks(-3, 13, 4), [0, 5, 10]);
  assert.deepEqual(niceTicks(0, 1, 4), [0, 0.25, 0.5, 0.75, 1]);
  assert.equal(formatNum(1200), '1200');
  assert.equal(formatNum(12000), '12k');
  assert.equal(formatNum(2500000), '2.5m');
  assert.equal(formatNum(0.25), '0.25');
  assert.equal(formatNum(3), '3');
  assert.equal(formatNum(-1.5), '-1.5');
});
