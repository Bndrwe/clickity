// A tiny, safe math expression parser for function plots ([CHART:plot|…|y = x^2 - 3]).
// No eval / new Function: text → tokens → AST (precedence climbing) → a closure over x.
// Pure, unit tested (test/expr.test.ts). Shared by main (validates tags) and the renderers (plots).
//
// Supports: numbers (1, 2.5, .5, 1e3), x, pi / π, e, tau, + - * / ^ (and **, ×, ·, ÷, −),
// unary minus, implicit multiplication (2x, 3(x+1), (x+1)(x-1), 2sin(x), x pi), superscripts
// (x², x³), and the functions below. sin x (no parentheses) works for a single factor.

export type Fn1 = (x: number) => number;

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  arcsin: Math.asin,
  arccos: Math.acos,
  arctan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sec: (v) => 1 / Math.cos(v),
  csc: (v) => 1 / Math.sin(v),
  cot: (v) => 1 / Math.tan(v),
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  ln: Math.log,
  log: Math.log10,
  log10: Math.log10,
  log2: Math.log2,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  pow: (a, b) => Math.pow(a, b),
};
const CONSTS: Record<string, number> = { pi: Math.PI, 'π': Math.PI, e: Math.E, tau: 2 * Math.PI };
/** every name the tokenizer knows, longest first (so "sinh" wins over "sin", "pi" over "p…") */
const NAMES = [...Object.keys(FUNCS), ...Object.keys(CONSTS), 'x'].sort((a, b) => b.length - a.length);

export const MAX_EXPR_CHARS = 160;
const MAX_DEPTH = 40;

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

type Node =
  | { k: 'num'; v: number }
  | { k: 'x' }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; f: string; args: Node[] };

const SUPERSCRIPT: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-' };

function normalize(src: string): string {
  let s = src
    .replace(/[−–—]/g, '-')
    .replace(/[×·∙⋅]/g, '*')
    .replace(/÷/g, '/')
    .replace(/\*\*/g, '^')
    .replace(/√/g, 'sqrt');
  // x² → x^(2), x⁻¹ → x^(-1)
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g, (m) => `^(${[...m].map((c) => SUPERSCRIPT[c]).join('')})`);
  return s.toLowerCase();
}

function tokenize(src: string): Tok[] | null {
  const s = normalize(src);
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/.exec(s.slice(i));
    // "2e" alone is 2·e, not an exponent: the regex needs digits after e
    if (num) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    if ('+-*/^(),'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (/[a-zπ]/.test(c)) {
      // a run of letters: split greedily into known names ("2sinx" → sin, x; "xpi" → x, pi)
      const run = /^[a-zπ][a-z0-9π]*/.exec(s.slice(i))![0];
      let j = 0;
      while (j < run.length) {
        const name = NAMES.find((n) => run.startsWith(n, j));
        if (!name) return null;
        out.push({ t: 'id', v: name });
        j += name.length;
        // digits glued after a name (log2 is a name; "x2" = x·2)
        const d = /^\d+(?:\.\d+)?/.exec(run.slice(j));
        if (d && !NAMES.some((n) => run.startsWith(n, j))) {
          out.push({ t: 'num', v: Number(d[0]) });
          j += d[0].length;
        }
      }
      i += run.length;
      continue;
    }
    return null; // anything else ("=", "|", "$", ";") is not part of an expression
  }
  return out;
}

class Parser {
  private i = 0;
  private depth = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === 'op' && t.v === v;
  }
  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw new Error('too deep');
  }

  parse(): Node {
    const n = this.sum();
    if (this.i < this.toks.length) throw new Error('trailing tokens');
    return n;
  }

  private sum(): Node {
    this.enter();
    let a = this.product();
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.toks[this.i++] as { v: string }).v;
      a = { k: 'bin', op, a, b: this.product() };
    }
    this.depth--;
    return a;
  }

  /** a factor may follow another without '*' (implicit multiplication) */
  private startsFactor(): boolean {
    const t = this.peek();
    if (!t) return false;
    return t.t === 'num' || t.t === 'id' || (t.t === 'op' && t.v === '(');
  }

  private product(): Node {
    this.enter();
    let a = this.unary();
    for (;;) {
      if (this.isOp('*') || this.isOp('/')) {
        const op = (this.toks[this.i++] as { v: string }).v;
        a = { k: 'bin', op, a, b: this.unary() };
      } else if (this.startsFactor()) {
        a = { k: 'bin', op: '*', a, b: this.power() };
      } else break;
    }
    this.depth--;
    return a;
  }

  private unary(): Node {
    this.enter();
    let n: Node;
    if (this.isOp('-')) {
      this.i++;
      n = { k: 'neg', a: this.unary() };
    } else if (this.isOp('+')) {
      this.i++;
      n = this.unary();
    } else n = this.power();
    this.depth--;
    return n;
  }

  /** right-associative; -x^2 = -(x^2), 2^-1 works */
  private power(): Node {
    this.enter();
    const base = this.atom();
    let n = base;
    if (this.isOp('^')) {
      this.i++;
      n = { k: 'bin', op: '^', a: base, b: this.unary() };
    }
    this.depth--;
    return n;
  }

  private atom(): Node {
    const t = this.toks[this.i++];
    if (!t) throw new Error('unexpected end');
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'op' && t.v === '(') {
      const n = this.sum();
      if (!this.isOp(')')) throw new Error('missing )');
      this.i++;
      return n;
    }
    if (t.t === 'id') {
      if (t.v === 'x') return { k: 'x' };
      if (t.v in CONSTS) return { k: 'num', v: CONSTS[t.v]! };
      if (t.v in FUNCS) {
        if (this.isOp('(')) {
          this.i++;
          const args: Node[] = [this.sum()];
          while (this.isOp(',')) {
            this.i++;
            args.push(this.sum());
          }
          if (!this.isOp(')')) throw new Error('missing )');
          this.i++;
          // sin(x)^2 binds the call first
          return { k: 'call', f: t.v, args };
        }
        // "sin x", "sqrt 2": one factor (a power is allowed: sin x^2 = sin(x^2))
        return { k: 'call', f: t.v, args: [this.power()] };
      }
    }
    throw new Error('unexpected token');
  }
}

function compile(n: Node): Fn1 {
  switch (n.k) {
    case 'num': {
      const v = n.v;
      return () => v;
    }
    case 'x':
      return (x) => x;
    case 'neg': {
      const a = compile(n.a);
      return (x) => -a(x);
    }
    case 'call': {
      const f = FUNCS[n.f]!;
      const args = n.args.map(compile);
      if (args.length === 1) {
        const a = args[0]!;
        return (x) => f(a(x));
      }
      return (x) => f(...args.map((g) => g(x)));
    }
    case 'bin': {
      const a = compile(n.a);
      const b = compile(n.b);
      switch (n.op) {
        case '+':
          return (x) => a(x) + b(x);
        case '-':
          return (x) => a(x) - b(x);
        case '*':
          return (x) => a(x) * b(x);
        case '/':
          return (x) => a(x) / b(x);
        default:
          return (x) => Math.pow(a(x), b(x));
      }
    }
  }
}

/**
 * The right-hand side of "y = 2x + 3", "f(x) = sin(x)", or a bare expression. Returns the
 * expression text, or null when the text isn't one equation / expression in x.
 */
export function exprOf(text: string): string | null {
  let s = text.trim().replace(/^\$+|\$+$/g, '').trim();
  const eq = /^(?:y|[a-z]\s*\(\s*x\s*\))\s*=\s*(.+)$/i.exec(s);
  if (eq) s = eq[1]!.trim();
  else if (s.includes('=')) return null;
  if (!s || s.length > MAX_EXPR_CHARS) return null;
  return s;
}

/** Parse an expression in x into a function, or null when it isn't valid. Never throws. */
export function parseExpr(src: string): Fn1 | null {
  if (typeof src !== 'string' || !src.trim() || src.length > MAX_EXPR_CHARS) return null;
  const toks = tokenize(src);
  if (!toks || !toks.length) return null;
  try {
    return compile(new Parser(toks).parse());
  } catch {
    return null;
  }
}

/** Evaluate once (NaN when invalid). */
export function evalExpr(src: string, x = 0): number {
  const f = parseExpr(src);
  return f ? f(x) : NaN;
}

/** A constant expression ("-2pi", "3/2", "10") → number, or null. */
export function evalConst(src: string): number | null {
  const toks = typeof src === 'string' ? tokenize(src) : null;
  if (!toks || toks.some((t) => t.t === 'id' && t.v === 'x')) return null;
  const v = evalExpr(src, 0);
  return Number.isFinite(v) ? v : null;
}
