// Small motion helpers for the overlay: cubic-bezier easing in JS and a critically damped spring.

/** Returns an easing function equivalent to CSS cubic-bezier(x1, y1, x2, y2). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  const solveT = (x: number): number => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-5) return t;
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    // bisection fallback
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-5) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };

  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return sampleY(solveT(x));
  };
}

/** DESIGN.md --ease: long ease-out used for almost everything. */
export const ease = cubicBezier(0.22, 1, 0.36, 1);
/** DESIGN.md --spring: reserved for the companion's flight to a point. */
export const spring = cubicBezier(0.34, 1.36, 0.5, 1);

/** 2D critically damped spring (exact integration, stable for any dt). */
export class Spring2D {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  constructor(public omega: number) {}

  snap(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
  }

  step(tx: number, ty: number, dt: number): void {
    const w = this.omega;
    const e = Math.exp(-w * dt);
    const dx = this.x - tx;
    const dy = this.y - ty;
    const kx = this.vx + w * dx;
    const ky = this.vy + w * dy;
    this.x = tx + (dx + kx * dt) * e;
    this.y = ty + (dy + ky * dt) * e;
    this.vx = (this.vx - w * kx * dt) * e;
    this.vy = (this.vy - w * ky * dt) * e;
  }

  settled(tx: number, ty: number): boolean {
    return Math.abs(this.x - tx) < 0.1 && Math.abs(this.y - ty) < 0.1 && Math.abs(this.vx) < 1 && Math.abs(this.vy) < 1;
  }
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
