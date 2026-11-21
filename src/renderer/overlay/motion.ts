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

/**
 * 2D damped spring, integrated exactly (stable for any dt).
 * zeta = 1 is critically damped; slightly under 1 (e.g. 0.85) gives a tiny, lively overshoot (~1%).
 */
export class Spring2D {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  omega: number;
  zeta: number;
  constructor(omega: number, zeta = 1) {
    this.omega = omega;
    this.zeta = zeta;
  }

  snap(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
  }

  step(tx: number, ty: number, dt: number): void {
    const [x, vx] = this.axis(this.x - tx, this.vx, dt);
    const [y, vy] = this.axis(this.y - ty, this.vy, dt);
    this.x = tx + x;
    this.y = ty + y;
    this.vx = vx;
    this.vy = vy;
  }

  /** one axis: displacement d and velocity v after dt (closed form) */
  private axis(d: number, v: number, dt: number): [number, number] {
    const w = this.omega;
    const z = this.zeta;
    if (z >= 1) {
      const e = Math.exp(-w * dt);
      const k = v + w * d;
      return [(d + k * dt) * e, (v - w * k * dt) * e];
    }
    const wd = w * Math.sqrt(1 - z * z);
    const e = Math.exp(-z * w * dt);
    const c = Math.cos(wd * dt);
    const s = Math.sin(wd * dt);
    const b = (v + z * w * d) / wd;
    const nd = e * (d * c + b * s);
    const nv = e * ((b * wd - z * w * d) * c - (d * wd + z * w * b) * s);
    return [nd, nv];
  }

  settled(tx: number, ty: number): boolean {
    return Math.abs(this.x - tx) < 0.1 && Math.abs(this.y - ty) < 0.1 && Math.abs(this.vx) < 1 && Math.abs(this.vy) < 1;
  }
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
