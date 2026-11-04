// Generates the app icon and tray icons as PNGs in assets/.
// Dependency-free: only node:zlib, node:fs, node:path and node:url.
//
//   node scripts/make-icons.mjs
//
// The companion is a rounded, cursor-tilted triangle in ink (#111111).
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

/* ───────────────────────── rasterizer ───────────────────────── */

const SUB = 4; // 4x4 supersampling

/**
 * Render a companion icon.
 * opts:
 *   size        output width and height in px
 *   color       [r,g,b] of the triangle
 *   scale       triangle scale in canvas units
 *   roundBg     [r,g,b] of an opaque rounded-square background, or null
 *   shadow      draw a soft gray shadow under the triangle (needs roundBg)
 */
function render({ size, color, scale, roundBg = null, shadow = false }) {
  const theta = (-32 * Math.PI) / 180; // tip leans up-left, like a cursor
  const cornerRadius = 0.1; // rounding of the triangle corners, canvas units
  const outer = companionVertices(scale, theta);
  const inner = insetTriangle(outer, cornerRadius);

  const bgRadius = 0.44; // 22% of the 2-unit canvas
  const shadowOffset = [0, 0.04];
  const shadowBlur = 0.09;
  const shadowAlpha = 0.24;

  const out = Buffer.alloc(size * size * 4);
  const samples = SUB * SUB;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let pr = 0, pg = 0, pb = 0, pa = 0; // premultiplied accumulators

      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const x = ((px + (sx + 0.5) / SUB) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / SUB) / size) * 2 - 1;

          // layer 0: opaque background (only inside the rounded square)
          let cr = 0, cg = 0, cb = 0, ca = 0;
          let inBackground = true;
          if (roundBg) {
            inBackground = sdRoundedSquare(x, y, bgRadius) <= 0;
            if (inBackground) {
              cr = roundBg[0];
              cg = roundBg[1];
              cb = roundBg[2];
              ca = 1;
            }
          }

          if (inBackground) {
            // layer 1: soft shadow, composited over the background
            if (shadow) {
              const d = sdTriangle(x - shadowOffset[0], y - shadowOffset[1], inner) - cornerRadius;
              const sa = shadowAlpha * (1 - smoothstep(-shadowBlur * 0.5, shadowBlur, d));
              if (sa > 0) {
                cr = cr * (1 - sa);
                cg = cg * (1 - sa);
                cb = cb * (1 - sa); // background stays opaque
              }
            }

            // layer 2: the triangle (binary per sub-sample, averaged below)
            if (sdTriangle(x, y, inner) - cornerRadius <= 0) {
              cr = color[0];
              cg = color[1];
              cb = color[2];
              ca = 1;
            }
          }

          // accumulate premultiplied
          pr += cr * ca;
          pg += cg * ca;
          pb += cb * ca;
          pa += ca;
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
  {
    file: 'icon.png',
    size: 1024,
    color: INK,
    scale: 0.56,
    roundBg: OFF_WHITE,
    shadow: true,
  },
  { file: 'tray.png', size: 32, color: INK, scale: 0.86 },
  { file: 'tray-template.png', size: 16, color: BLACK, scale: 0.86 },
  { file: 'tray-template@2x.png', size: 32, color: BLACK, scale: 0.86 },
];

for (const o of outputs) {
  const started = Date.now();
  const rgba = render(o);
  const png = encodePng(o.size, o.size, rgba);
  writeFileSync(join(ASSETS, o.file), png);
  console.log(`${o.file}: ${o.size}x${o.size}, ${png.length} bytes (${Date.now() - started} ms)`);
}
