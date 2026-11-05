import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_POINTS,
  addPoint,
  classify,
  drawStroke,
  extentOf,
  finishPath,
  globalToScreenshot,
  hexToRgb,
  newPath,
  summarizeGesture,
  type GesturePath,
  type GestureScreen,
} from '../src/main/gesture.ts';

/** Record points like the 60 Hz cursor poll would: one sample every 16 ms. */
function record(pts: Array<[number, number]>, opts: { t0?: number; dt?: number; restMs?: number } = {}): GesturePath {
  const dt = opts.dt ?? 16;
  let t = opts.t0 ?? 1000;
  const path = newPath({ x: pts[0][0], y: pts[0][1] }, t);
  for (const [x, y] of pts.slice(1)) {
    t += dt;
    addPoint(path, x, y, t);
  }
  const [lx, ly] = pts[pts.length - 1];
  return finishPath(path, lx, ly, t + (opts.restMs ?? 0));
}

function circle(cx: number, cy: number, rx: number, ry: number, turns = 1.05, steps = 80): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * turns * 2 * Math.PI;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

function line(x0: number, y0: number, x1: number, y1: number, steps = 40): Array<[number, number]> {
  return Array.from({ length: steps + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps] as [number, number]);
}

// 2560x1440 DIP display captured at 1568x882
const screen1: GestureScreen = { index: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, image: { width: 1568, height: 882 } };
// a second display to the right, 1920x1080 captured at 1568x882
const screen2: GestureScreen = { index: 2, bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, image: { width: 1568, height: 882 } };

test('jitter is still, not a gesture', () => {
  const p = record([[100, 100], [103, 101], [101, 104], [99, 100]]);
  assert.ok(extentOf(p.points) < 6);
  assert.equal(classify(p).kind, 'still');
});

test('a loop around something is a circle with its bbox', () => {
  const p = record(circle(600, 400, 150, 90));
  const g = classify(p);
  assert.equal(g.kind, 'circle');
  assert.ok(Math.abs(g.bbox.minX - 450) < 3 && Math.abs(g.bbox.maxX - 750) < 3);
  assert.ok(Math.abs(g.bbox.minY - 310) < 3 && Math.abs(g.bbox.maxY - 490) < 3);
});

test('a wide ellipse around a heading, then resting at the end, is still a circle', () => {
  const p = record(circle(800, 400, 320, 55, 1.08, 46), { dt: 38, restMs: 2100 });
  assert.equal(classify(p).kind, 'circle');
});

test('underlining back and forth is not a circle', () => {
  const p = record([...line(200, 500, 700, 505), ...line(700, 505, 210, 512)]);
  assert.notEqual(classify(p).kind, 'circle');
});

test('a slightly open circle (300°) still counts', () => {
  assert.equal(classify(record(circle(600, 400, 120, 120, 0.85))).kind, 'circle');
});

test('a straight horizontal stroke is a line', () => {
  const g = classify(record(line(200, 500, 700, 510)));
  assert.equal(g.kind, 'line');
  assert.deepEqual([Math.round(g.start.x), Math.round(g.end.x)], [200, 700]);
});

test('moving to a spot and resting there is pointing', () => {
  const p = record(line(200, 200, 800, 600, 30), { restMs: 1500 });
  const g = classify(p);
  assert.equal(g.kind, 'point');
  assert.ok(g.dwell && Math.abs(g.dwell.x - 800) < 3 && g.dwell.ms >= 1400);
});

test('a scribble without rest is an area', () => {
  const zig: Array<[number, number]> = [];
  for (let i = 0; i < 12; i++) zig.push([300 + i * 25, i % 2 ? 300 : 360]);
  assert.equal(classify(record(zig)).kind, 'area');
});

test('paths are capped at MAX_POINTS and keep their ends', () => {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 2000; i++) pts.push([i * 3, (i * 7) % 400]);
  const p = record(pts);
  assert.ok(p.points.length <= MAX_POINTS);
  assert.equal(p.points[0].x, 0);
  assert.equal(p.points[p.points.length - 1].x, 1999 * 3);
});

test('globalToScreenshot inverts the capture mapping', () => {
  const px = globalToScreenshot(screen2, 2560 + 960, 540);
  assert.deepEqual([Math.round(px.x), Math.round(px.y)], [784, 441]);
});

test('summary: circled bbox in screenshot pixels + final cursor', () => {
  const p = record(circle(1000, 700, 200, 100));
  const s = summarizeGesture(p, { x: 1000, y: 800 }, [screen1, screen2]);
  const k = 1568 / 2560;
  assert.match(s.text, /circled the area x (\d+)–(\d+), y (\d+)–(\d+) on screen 1/);
  const m = /x (\d+)–(\d+), y (\d+)–(\d+)/.exec(s.text)!;
  assert.ok(Math.abs(Number(m[1]) - 800 * k) <= 2 && Math.abs(Number(m[2]) - 1200 * k) <= 2);
  assert.ok(Math.abs(Number(m[3]) - 600 * (882 / 1440)) <= 2 && Math.abs(Number(m[4]) - 800 * (882 / 1440)) <= 2);
  assert.match(s.text, /cursor ended at 613,490 on screen 1/);
  assert.equal(s.note, 'circled an area on screen 1');
  assert.equal(s.parts[0].kind, 'circle');
});

test('summary without movement only gives the cursor position', () => {
  const p = record([[500, 500], [501, 500]]);
  const s = summarizeGesture(p, { x: 500, y: 500 }, [screen1]);
  assert.equal(s.parts.length, 0);
  assert.equal(s.note, '');
  assert.match(s.text, /cursor is at 306,306 on screen 1/);
  // typed turns pass no path
  assert.match(summarizeGesture(null, { x: 2560 + 100, y: 100 }, [screen1, screen2]).text, /on screen 2/);
});

test('summary across two displays describes the screen the gesture was on', () => {
  const p = record(circle(2560 + 900, 500, 150, 150));
  const s = summarizeGesture(p, { x: 2560 + 900, y: 650 }, [screen1, screen2]);
  assert.match(s.text, /circled the area .* on screen 2/);
  assert.equal(s.parts.length, 1);
});

test('drawStroke paints an antialiased ink stroke with a halo', () => {
  const w = 60;
  const h = 40;
  const buf = new Uint8Array(w * h * 4).fill(128); // gray BGRA
  const ok = drawStroke(buf, w, h, [{ x: 5, y: 20 }, { x: 30, y: 20 }, { x: 55, y: 20 }], { width: 4, color: [17, 17, 17], halo: [255, 255, 255], alpha: 0.9 });
  assert.ok(ok);
  const px = (x: number, y: number) => buf[(y * w + x) * 4];
  assert.ok(px(30, 20) < 60, `center is ink (${px(30, 20)})`);
  assert.equal(px(30, 5), 128, 'far away untouched');
  assert.ok(px(30, 23) > 128, 'the halo lightens just outside the ink');
  assert.equal(drawStroke(buf, w, h, [{ x: 500, y: 500 }, { x: 600, y: 600 }], { width: 4, color: [0, 0, 0], halo: [255, 255, 255], alpha: 1 }), false, 'off-image stroke draws nothing');
});

test('hexToRgb', () => {
  assert.deepEqual(hexToRgb('#ff8000', [0, 0, 0]), [255, 128, 0]);
  assert.deepEqual(hexToRgb('nope', [1, 2, 3]), [1, 2, 3]);
});
