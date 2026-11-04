// Generates the app icon and tray icons as PNGs in assets/.
// Dependency-free: only node:zlib, node:fs, node:path and node:url.
//
//   node scripts/make-icons.mjs
//
// The mark: the companion's rounded, cursor-tilted triangle with short "click"
// ticks radiating from its tip, in ink (#111111). The same geometry also writes
// assets/logo-mark.svg, assets/logo.svg and assets/logo-dark.svg.
//  - assets/icon.png            1024x1024, triangle on an off-white (#fafafa) rounded square, soft shadow
//  - assets/tray.png            32x32, ink triangle on transparent
//  - assets/tray-template.png   16x16, pure black + alpha (macOS template image)
//  - assets/tray-template@2x.png 32x32, pure black + alpha

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'assets');

/* ───────────────────────── PNG encoding ───────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

/** rgba: Buffer of width*height*4 bytes, 8-bit non-premultiplied RGBA. */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with filter type 0 (None).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ───────────────────────── geometry ───────────────────────── */
// Canvas space runs from -1 to 1 on both axes (y points down).

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Distance from point to segment ab. */
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/** Signed distance to a convex triangle (negative inside). */
function sdTriangle(px, py, v) {
  let d = Infinity;
  let sign = 0;
  let inside = true;
  for (let i = 0; i < 3; i++) {
    const a = v[i];
    const b = v[(i + 1) % 3];
    d = Math.min(d, sdSegment(px, py, a[0], a[1], b[0], b[1]));
    const cross = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
    const s = Math.sign(cross);
    if (s !== 0) {
      if (sign === 0) sign = s;
      else if (s !== sign) inside = false;
    }
  }
  return inside ? -d : d;
}

/** Signed distance to a rounded square with half-size 1 and corner radius r. */
function sdRoundedSquare(px, py, r) {
  const qx = Math.abs(px) - (1 - r);
  const qy = Math.abs(py) - (1 - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * The companion triangle: an isoceles triangle with its apex pointing up,
 * tilted by theta (negative = apex leans left, like a cursor), scaled by s,
 * and centred on its bounding box.
 */
function companionVertices(s, theta) {
  // narrow isosceles: a sharp tip reads as a pointer rather than a play button
  const base = [
    [0, -1],
    [0.64, 0.62],
    [-0.64, 0.62],
  ];
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  const v = base.map(([x, y]) => [(x * c - y * sn) * s, (x * sn + y * c) * s]);
  const xs = v.map((p) => p[0]);
  const ys = v.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return v.map(([x, y]) => [x - cx, y - cy]);
}

/**
 * Inset the triangle by rr so that (inset triangle) dilated by rr gives the
 * visible shape: a triangle with rounded corners of radius rr and the same
 * outer extent as `outer`.
 */
function insetTriangle(outer, rr) {
  const [A, B, C] = outer;
  const a = dist(B, C);
  const b = dist(C, A);
  const c = dist(A, B);
  const perimeter = a + b + c;
  const incentre = [
    (a * A[0] + b * B[0] + c * C[0]) / perimeter,
    (a * A[1] + b * B[1] + c * C[1]) / perimeter,
  ];
  const twiceArea = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1]));
  const inradius = twiceArea / perimeter;
  const f = (inradius - rr) / inradius;
  return outer.map(([x, y]) => [
    incentre[0] + (x - incentre[0]) * f,
    incentre[1] + (y - incentre[1]) * f,
  ]);
}

const smoothstep = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/* ───────────────────────── the mark ───────────────────────── */

const THETA = (-32 * Math.PI) / 180; // tip leans up-left, like a cursor
const CORNER = 0.1; // rounding of the triangle corners (canvas units, before fit)

/**
 * Build the mark in canvas units, centred and fitted so its bounding box
 * (including stroke) spans `extent` (0..2).
 *  ticks: 3 = full mark, 2 = simplified for tiny sizes.
 *  tickW: tick stroke width (canvas units, before fit).
 */
function buildMark({ extent, ticks = 3, tickW = 0.1, gap = 0.14, lenK = 1 }) {
  const tri = companionVertices(1, THETA);
  const tip = tri[0];
  const phi = Math.atan2(-Math.cos(THETA), Math.sin(THETA)); // direction of the tip
  const spread = ticks === 3 ? [-0.62, 0, 0.62] : [-0.5, 0.5];
  const segs = spread.map((off, i) => {
    const a = phi + off;
    const mid = ticks === 3 && off === 0;
    const len = (mid ? 0.4 : 0.3) * lenK;
    const sx = tip[0] + Math.cos(a) * gap, sy = tip[1] + Math.sin(a) * gap;
    return [sx, sy, sx + Math.cos(a) * len, sy + Math.sin(a) * len];
  });
  const inner = insetTriangle(tri, CORNER);
  // bounding box of the whole thing
  const pts = [];
  for (const [x, y] of inner) pts.push([x - CORNER, y - CORNER], [x + CORNER, y + CORNER]);
  for (const [a, b, c, d] of segs) pts.push([a - tickW / 2, b - tickW / 2], [c + tickW / 2, d + tickW / 2], [a + tickW / 2, b + tickW / 2], [c - tickW / 2, d - tickW / 2]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const f = extent / Math.max(w, h);
  const T = ([x, y]) => [(x - cx) * f, (y - cy) * f];
  return {
    tri: inner.map(T),
    r: CORNER * f,
    segs: segs.map(([a, b, c, d]) => [...T([a, b]), ...T([c, d])]),
    w: tickW * f,
  };
}

/** Signed distance to the whole mark (negative inside). */
function sdMark(m, x, y) {
  let d = sdTriangle(x, y, m.tri) - m.r;
  for (const [a, b, c, e] of m.segs) d = Math.min(d, sdSegment(x, y, a, b, c, e) - m.w / 2);
  return d;
}

/** SVG for the mark inside a 0..100 box, fitted to `extent` (0..100). */
function markSvgBody(fill) {
  const m = buildMark({ extent: 2 * 0.86, ticks: 3, tickW: 0.11 });
  const P = (v) => (v * 50 + 50).toFixed(2);
  const S = (v) => (v * 50).toFixed(2);
  const poly = m.tri.map(([x, y]) => `${P(x)},${P(y)}`).join(' ');
  const lines = m.segs
    .map(([a, b, c, d]) => `<line x1="${P(a)}" y1="${P(b)}" x2="${P(c)}" y2="${P(d)}"/>`)
    .join('');
  return (
    `<polygon points="${poly}" fill="${fill}" stroke="${fill}" stroke-width="${S(m.r * 2)}" stroke-linejoin="round"/>` +
    `<g stroke="${fill}" stroke-width="${S(m.w)}" stroke-linecap="round">${lines}</g>`
  );
}

function writeLogos() {
  const mk = (fill) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="clickity">${markSvgBody(fill)}</svg>\n`;
  writeFileSync(join(ASSETS, 'logo-mark.svg'), mk('#111111'));
  const full = (fill) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 100" width="420" height="100" role="img" aria-label="clickity">` +
    markSvgBody(fill) +
    `<text x="116" y="70" fill="${fill}" font-family="'Instrument Serif', 'Iowan Old Style', 'Palatino Linotype', Georgia, serif" font-style="italic" font-size="78" letter-spacing="-1.5">clickity</text></svg>\n`;
  writeFileSync(join(ASSETS, 'logo.svg'), full('#111111'));
  writeFileSync(join(ASSETS, 'logo-dark.svg'), full('#f2f2f0'));
  console.log('logo-mark.svg, logo.svg, logo-dark.svg');
}

/* ───────────────────────── rasterizer ───────────────────────── */

const SUB = 4; // 4x4 supersampling (8 for the tiny sizes)

/**
 * opts: size, color [r,g,b], extent (mark size in canvas units, 0..2),
 *       ticks, tickW, roundBg [r,g,b]|null, shadow bool, sub
 */
function render({ size, color, extent, ticks = 3, tickW = 0.11, gap, lenK, roundBg = null, shadow = false, sub = SUB }) {
  const mark = buildMark({ extent, ticks, tickW, gap, lenK });
  const bgRadius = 0.44; // 22% of the 2-unit canvas
  const shadowOffset = [0, 0.045];
  const shadowBlur = 0.1;
  const shadowAlpha = 0.22;

  const out = Buffer.alloc(size * size * 4);
  const samples = sub * sub;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let pr = 0, pg = 0, pb = 0, pa = 0;
      for (let sy = 0; sy < sub; sy++) {
        for (let sx = 0; sx < sub; sx++) {
          const x = ((px + (sx + 0.5) / sub) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / sub) / size) * 2 - 1;
          let cr = 0, cg = 0, cb = 0, ca = 0;
          let inBackground = true;
          if (roundBg) {
            inBackground = sdRoundedSquare(x, y, bgRadius) <= 0;
            if (inBackground) { cr = roundBg[0]; cg = roundBg[1]; cb = roundBg[2]; ca = 1; }
          }
          if (inBackground) {
            if (shadow) {
              const d = sdMark(mark, x - shadowOffset[0], y - shadowOffset[1]);
              const sa = shadowAlpha * (1 - smoothstep(-shadowBlur * 0.5, shadowBlur, d));
              if (sa > 0) { cr *= 1 - sa; cg *= 1 - sa; cb *= 1 - sa; }
            }
            if (sdMark(mark, x, y) <= 0) { cr = color[0]; cg = color[1]; cb = color[2]; ca = 1; }
          }
          pr += cr * ca; pg += cg * ca; pb += cb * ca; pa += ca;
        }
      }
      const i = (py * size + px) * 4;
      const alpha = pa / samples;
      if (alpha > 0) {
        out[i] = Math.round(pr / pa);
        out[i + 1] = Math.round(pg / pa);
        out[i + 2] = Math.round(pb / pa);
        out[i + 3] = Math.round(alpha * 255);
      }
    }
  }
  return out;
}

/* ───────────────────────── outputs ───────────────────────── */

const INK = [0x11, 0x11, 0x11];
const OFF_WHITE = [0xfa, 0xfa, 0xfa];
const BLACK = [0, 0, 0];

const outputs = [
  { file: 'icon.png', size: 1024, color: INK, extent: 1.2, roundBg: OFF_WHITE, shadow: true },
  { file: 'tray.png', size: 32, color: INK, extent: 1.84, tickW: 0.17, gap: 0.12, sub: 8 },
  { file: 'tray-template.png', size: 16, color: BLACK, extent: 1.92, ticks: 2, tickW: 0.24, gap: 0.2, lenK: 1.1, sub: 8 },
  { file: 'tray-template@2x.png', size: 32, color: BLACK, extent: 1.84, tickW: 0.17, gap: 0.12, sub: 8 },
];

writeLogos();
for (const o of outputs) {
  const started = Date.now();
  const rgba = render(o);
  const png = encodePng(o.size, o.size, rgba);
  writeFileSync(join(ASSETS, o.file), png);
  console.log(`${o.file}: ${o.size}x${o.size}, ${png.length} bytes (${Date.now() - started} ms)`);
}
